package expo.modules.backgroundbackup

import android.net.Network
import android.net.Uri
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.CookieJar
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.net.Proxy
import java.net.URI
import java.util.concurrent.TimeUnit

internal data class HttpResult(val code: Int, val body: ByteArray)

internal class BackupHttp(private val engine: BackupEngine, private val work: BackupWork) {
  fun api(path: String, body: JSONObject = JSONObject()): JSONObject {
    val config = engine.configuration(work)
    require(path == "uploads" || Regex("^uploads/[a-zA-Z0-9-]+/(renew|complete)$").matches(path)) {
      "Invalid upload endpoint."
    }
    val result = request(
      config.apiUrl + "/" + path, "POST", body.toString().toByteArray(Charsets.UTF_8),
      mapOf("Authorization" to "Bearer ${config.token}", "Content-Type" to "application/json")
    )
    if (result.code !in 200..299) {
      val message = when (result.code) {
        401, 403 -> SIGN_IN_ERROR
        507 -> "Storage quota reached. Free space, then retry or cancel this backup."
        in 300..399 -> "The API redirected a request. Check the configured API address."
        else -> "Backup API request failed (${result.code}). Retry to resume."
      }
      throw BackupFailure(message, result.code)
    }
    try {
      return JSONObject(String(result.body, Charsets.UTF_8))
    } catch (_: org.json.JSONException) {
      throw BackupFailure("The API returned an invalid response.")
    }
  }

  fun validateBlob(raw: String): Uri {
    val host = engine.configuration(work).blobHost
    val parsed = URI(raw)
    val uri = Uri.parse(raw)
    if (parsed.scheme != "https" || parsed.host != host || parsed.port != -1 ||
      parsed.rawUserInfo != null || parsed.rawFragment != null || uri.getQueryParameter("sig").isNullOrEmpty()) {
      throw BackupFailure("The API returned an untrusted storage URL.")
    }
    return uri
  }

  fun put(raw: String, query: Map<String, String>, bytes: ByteArray, headers: Map<String, String>): Int {
    val original = validateBlob(raw)
    val builder = original.buildUpon().clearQuery()
    for (name in original.queryParameterNames) {
      if (name !in query) for (value in original.getQueryParameters(name)) builder.appendQueryParameter(name, value)
    }
    for ((name, value) in query) builder.appendQueryParameter(name, value)
    return request(
      builder.build().toString(), "PUT", bytes, mapOf("x-ms-version" to "2023-11-03") + headers
    ).code
  }

  private fun request(url: String, method: String, bytes: ByteArray, headers: Map<String, String>): HttpResult {
    engine.check(work)
    val network = engine.network(work)
    // Both DNS and sockets use the checked network. A lost Wi-Fi connection cannot fall back to cellular.
    val client = client(network)
    val builder = Request.Builder().url(url)
      .method(method, bytes.toRequestBody(headers.getValue("Content-Type").toMediaType()))
    for ((key, value) in headers) builder.header(key, value)
    val call = client.newCall(builder.build())
    engine.registerCall(work, network, call)
    try {
      call.execute().use { response ->
        engine.checkNetwork(work, network)
        val stream = response.body?.byteStream()
        val body = java.io.ByteArrayOutputStream()
        stream?.use {
          val buffer = ByteArray(8192)
          while (true) {
            engine.checkNetwork(work, network)
            val count = it.read(buffer)
            if (count < 0) break
            if (body.size() + count > 1024 * 1024) throw BackupFailure("The server response is too large.")
            body.write(buffer, 0, count)
          }
        }
        return HttpResult(response.code, body.toByteArray())
      }
    } finally {
      engine.unregisterCall(call)
      client.connectionPool.evictAll()
      client.dispatcher.executorService.shutdown()
    }
  }

  private fun client(network: Network): OkHttpClient = OkHttpClient.Builder()
    .socketFactory(network.socketFactory)
    .dns(object : Dns {
      override fun lookup(hostname: String): List<java.net.InetAddress> = network.getAllByName(hostname).toList()
    })
    .proxy(Proxy.NO_PROXY)
    .followRedirects(false)
    .followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .cookieJar(CookieJar.NO_COOKIES)
    .authenticator(Authenticator.NONE)
    .proxyAuthenticator(Authenticator.NONE)
    .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
    .connectTimeout(30, TimeUnit.SECONDS)
    .readTimeout(180, TimeUnit.SECONDS)
    .writeTimeout(90, TimeUnit.SECONDS)
    .callTimeout(5, TimeUnit.MINUTES)
    .build()
}
