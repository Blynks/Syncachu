package expo.modules.backgroundbackup

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URI
import java.security.MessageDigest

internal const val BLOCK_SIZE = 4 * 1024 * 1024
internal const val MAX_SIZE = 2L * 1024 * 1024 * 1024
internal const val SIGN_IN_ERROR = "Open Syncachu to refresh sign-in, then retry."
internal val SUPPORTED_TYPES = setOf(
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/avif",
  "video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "video/3gpp"
)

internal fun hashName(value: String): String =
  MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it.toInt() and 255) }

internal fun JSONObject.optionalString(key: String): String? =
  if (has(key) && !isNull(key)) getString(key).takeIf { it.isNotEmpty() } else null

internal class BackupFailure(message: String, val status: Int? = null) : Exception(message)
internal class WorkInterrupted : Exception()
internal class NetworkUnavailable : IOException()

internal class BackupConfig(
  val userId: String,
  val apiUrl: String,
  val blobHost: String,
  val token: String,
  val allowMobile: Boolean
) {
  companion object {
    fun parse(raw: String): BackupConfig {
      try {
        return parseValue(raw)
      } catch (_: org.json.JSONException) {
        // JSONObject's exception may echo input. Never expose configuration text containing a token.
        throw IllegalArgumentException("Invalid native backup configuration.")
      } catch (_: java.net.URISyntaxException) {
        throw IllegalArgumentException("Set an HTTPS API address ending in /api.")
      }
    }

    private fun parseValue(raw: String): BackupConfig {
      val json = JSONObject(raw)
      val user = json.getString("userId")
      val api = json.getString("apiUrl").trimEnd('/')
      val host = json.getString("blobHost")
      val token = json.getString("token")
      val uri = URI(api)
      require(user.isNotBlank() && user.length <= 1024) { "Invalid account." }
      require(uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null &&
        uri.rawQuery == null && uri.rawFragment == null && uri.path.endsWith("/api") &&
        !uri.path.contains("/../") && !uri.path.contains("/./")) {
        "Set an HTTPS API address ending in /api."
      }
      require(Regex("^[a-z0-9]{3,24}\\.blob\\.core\\.windows\\.net$").matches(host)) {
        "Invalid Azure storage host."
      }
      require(token.isNotBlank() && token.length <= 16384 && !token.contains('\r') && !token.contains('\n')) {
        SIGN_IN_ERROR
      }
      return BackupConfig(user, api, host, token, json.getBoolean("allowMobile"))
    }
  }
}

internal class BackupJob(val json: JSONObject) {
  val id: String get() = json.getString("id")
  val name: String get() = json.getString("name")
  val contentType: String get() = json.getString("contentType")
  var status: String
    get() = json.getString("status")
    set(value) { json.put("status", value) }
  var progress: Double
    get() = json.optDouble("progress", 0.0).let { if (it.isFinite()) it.coerceIn(0.0, 1.0) else 0.0 }
    set(value) {
      require(value.isFinite()) { "Invalid backup progress." }
      json.put("progress", value.coerceIn(0.0, 1.0))
    }
  val terminal: Boolean get() = status in setOf("done", "cancelled", "error")
  var uploadId: String?
    get() = json.optionalString("uploadId")
    set(value) { json.put("uploadId", value) }
  val blocks: MutableSet<Int>
    get() {
      val values = json.optJSONArray("blocks") ?: JSONArray()
      return (0 until values.length()).map { values.getInt(it) }.toMutableSet()
    }
  fun saveBlocks(values: Collection<Int>) { json.put("blocks", JSONArray(values.sorted())) }
  fun resetTicket() {
    uploadId = null
    saveBlocks(emptyList())
    json.remove("hasThumbnail")
  }
  fun clearError() { json.remove("error"); json.remove("httpStatus") }
  fun fail(message: String, code: Int? = null) {
    status = "error"
    json.put("error", message)
    json.put("httpStatus", code)
  }
  fun copy(): BackupJob = BackupJob(JSONObject(json.toString()))
  fun snapshot(): JSONObject = JSONObject().put("id", id).put("status", status).put("progress", progress).also {
    for (key in listOf("error", "httpStatus", "media")) if (json.has(key) && !json.isNull(key)) it.put(key, json.get(key))
    if (!it.has("error") && json.has("thumbnailWarning") && !json.isNull("thumbnailWarning")) {
      it.put("error", json.get("thumbnailWarning"))
    }
  }

  companion object {
    fun incoming(json: JSONObject): BackupJob {
      for (key in listOf("id", "key", "name", "contentType")) {
        require(json.getString(key).isNotBlank() && json.getString(key).length <= 4096) { "Invalid backup job." }
      }
      val uri = json.optionalString("uri")
      val asset = json.optionalString("assetId")
      require(uri != null || asset != null) { "Original is unavailable. Select it again." }
      require(uri == null || uri.startsWith("file://") || uri.startsWith("content://")) {
        "Original is not available locally. Download it or select it again."
      }
      return BackupJob(JSONObject().apply {
        for (key in listOf("id", "key", "name", "contentType", "uri", "assetId")) {
          if (json.has(key)) put(key, json.get(key))
        }
        put("status", "queued")
        put("progress", 0.0)
        put("blocks", JSONArray())
      })
    }
  }
}

/** Tokens and upload SAS URLs never enter this store. AtomicFile provides crash-safe checkpoints. */
internal class BackupStore(context: Context, userId: String) {
  private val root = File(File(context.noBackupFilesDir, "syncachu-background"), hashName(userId))

  init { ensureDirectory(root) }

  fun directory(job: BackupJob): File = File(root, hashName(job.id)).also { ensureDirectory(it) }

  fun load(): LinkedHashMap<String, BackupJob> {
    val result = linkedMapOf<String, BackupJob>()
    val directories = root.listFiles() ?: throw IOException("Cannot read saved backups.")
    for (directory in directories.sortedBy { it.name }) {
      if (!directory.isDirectory || !Regex("^[a-f0-9]{64}$").matches(directory.name)) continue
      val state = File(directory, "job.json")
      if (!state.exists() && !File(directory, "job.json.bak").exists()) continue
      val json = AtomicFile(state).openRead().use { JSONObject(it.bufferedReader().readText()) }
      val job = BackupJob(json)
      require(hashName(job.id) == directory.name) { "Invalid saved backup identity." }
      require(job.status in setOf("queued", "working", "error", "done", "cancelled")) { "Invalid saved backup status." }
      if (job.status == "working") {
        job.status = "queued"
        job.json.put("error", "Backup interrupted. Resuming saved progress.")
        save(job)
      }
      if (job.status == "done" || job.status == "cancelled") {
        try { cleanStaging(job) }
        catch (_: IOException) {
          job.json.put("error", "Private staging cleanup failed. Reopen Syncachu to retry cleanup.")
          save(job)
        }
      }
      result[job.id] = job
    }
    return result
  }

  fun save(job: BackupJob) {
    val target = AtomicFile(File(directory(job), "job.json"))
    val stream = target.startWrite()
    try {
      stream.write(job.json.toString().toByteArray(Charsets.UTF_8))
      target.finishWrite(stream)
    } catch (error: Exception) {
      target.failWrite(stream)
      throw error
    }
  }

  fun cleanStaging(job: BackupJob) {
    val dir = directory(job)
    for (name in listOf("original", "original.part", "thumbnail.jpg", "thumbnail.part")) {
      val file = File(dir, name)
      if (file.exists() && !file.delete()) throw IOException("Could not remove private backup staging.")
    }
  }

  fun hasStaging(job: BackupJob): Boolean {
    val dir = File(root, hashName(job.id))
    return listOf("original", "original.part").any { File(dir, it).isFile }
  }

  fun remove(job: BackupJob) {
    cleanStaging(job)
    AtomicFile(File(directory(job), "job.json")).delete()
    if (!directory(job).delete()) throw IOException("Could not remove saved backup.")
  }

  private fun ensureDirectory(directory: File) {
    if (!directory.isDirectory && !directory.mkdirs()) throw IOException("Cannot create private backup storage.")
  }
}
