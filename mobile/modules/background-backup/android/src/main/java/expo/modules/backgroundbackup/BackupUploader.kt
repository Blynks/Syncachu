package expo.modules.backgroundbackup

import android.content.Context
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

private class RestartTicket : Exception()
private data class UploadTicket(val id: String, val original: String, val thumbnail: String?, val expires: Long)

internal class BackupUploader(context: Context, private val engine: BackupEngine, private val work: BackupWork) {
  private val http = BackupHttp(engine, work)
  private val media = BackupMedia(context, engine, work)
  private var ticket: UploadTicket? = null

  fun upload(job: BackupJob): JSONObject {
    val original = media.prepare(job)
    val preview = media.thumbnail(job, original)
    media.verify(original, job)
    // A renewal can expire while the upload is in progress; restart at most twice per attempt.
    for (attempt in 0..2) {
      engine.check(work)
      try {
        if (job.uploadId != null) renew(job)
        if (job.uploadId == null) {
          val result = http.api("uploads", JSONObject()
            .put("sha256", job.json.getString("sha256")).put("size", job.json.getLong("size"))
            .put("contentType", job.contentType).put("name", job.name).put("hasThumbnail", preview != null))
          if (result.optBoolean("duplicate")) return completedMedia(result.getJSONObject("media"), job)
          val id = result.getString("uploadId")
          require(Regex("^[a-zA-Z0-9-]{1,128}$").matches(id)) { "Invalid upload identity." }
          job.uploadId = id
          job.json.put("hasThumbnail", preview != null)
          job.saveBlocks(emptyList())
          engine.checkpoint(work, job)
          ticket = parseTicket(result, job)
        }
        uploadBlocks(original, preview, job)
        engine.progress(work, job, 0.98)
        try {
          return completedMedia(http.api("uploads/${job.uploadId}/complete"), job)
        } catch (error: BackupFailure) {
          if (error.status == 400) {
            job.saveBlocks(emptyList())
            engine.checkpoint(work, job)
          }
          throw error
        }
      } catch (_: RestartTicket) {
        if (attempt == 2) throw BackupFailure("Upload reservation expired repeatedly. Retry to start a fresh backup.")
      }
    }
    throw BackupFailure("Could not obtain an upload reservation.")
  }

  private fun uploadBlocks(original: File, preview: File?, job: BackupJob) {
    val size = job.json.getLong("size")
    val count = ((size + BLOCK_SIZE - 1) / BLOCK_SIZE).toInt()
    val completed = job.blocks.filter { it in 0 until count }.toMutableSet()
    RandomAccessFile(original, "r").use { input ->
      for (index in 0 until count) {
        engine.check(work)
        if (index !in completed) {
          val offset = index.toLong() * BLOCK_SIZE
          val bytes = ByteArray(minOf(BLOCK_SIZE.toLong(), size - offset).toInt())
          input.seek(offset)
          input.readFully(bytes)
          put(job, false, mapOf("comp" to "block", "blockid" to blockId(index)), bytes,
            mapOf("Content-Type" to "application/octet-stream"))
          completed.add(index)
          job.saveBlocks(completed)
          engine.checkpoint(work, job)
        }
        engine.progress(work, job, 0.15 + 0.8 * (index + 1) / count)
      }
    }
    val xml = "<?xml version=\"1.0\" encoding=\"utf-8\"?><BlockList>" +
      (0 until count).joinToString("") { "<Latest>${blockId(it)}</Latest>" } + "</BlockList>"
    put(job, false, mapOf("comp" to "blocklist"), xml.toByteArray(Charsets.UTF_8),
      mapOf("Content-Type" to "application/xml", "x-ms-blob-content-type" to job.contentType))
    if (job.json.optBoolean("hasThumbnail")) {
      if (preview == null) throw BackupFailure("Preview is missing. Cancel and select the original again.")
      put(job, true, emptyMap(), preview.readBytes(),
        mapOf("x-ms-blob-type" to "BlockBlob", "Content-Type" to "image/jpeg"))
    }
  }

  private fun put(job: BackupJob, thumbnail: Boolean, query: Map<String, String>, bytes: ByteArray,
                  headers: Map<String, String>) {
    for (attempt in 0..1) {
      engine.check(work)
      if (requireNotNull(ticket).expires <= System.currentTimeMillis() + 30_000) renew(job)
      val current = requireNotNull(ticket)
      val url = if (thumbnail) current.thumbnail ?: throw BackupFailure("Missing preview upload ticket.") else current.original
      val status = http.put(url, query, bytes, headers)
      if (status in 200..299) return
      if (status == 403 && attempt == 0) { renew(job); continue }
      if (status == 400 && query["comp"] == "blocklist") {
        job.saveBlocks(emptyList())
        engine.checkpoint(work, job)
      }
      throw BackupFailure(if (status in 300..399) "Storage redirected a request; backup was blocked."
        else "Storage upload failed ($status). Retry to resume.", status)
    }
  }

  private fun renew(job: BackupJob) {
    val result = try {
      http.api("uploads/${job.uploadId}/renew")
    } catch (error: BackupFailure) {
      if (error.status == 404 || error.status == 409) {
        job.resetTicket()
        ticket = null
        engine.checkpoint(work, job)
        throw RestartTicket()
      }
      throw error
    }
    ticket = parseTicket(result, job)
  }

  private fun parseTicket(json: JSONObject, job: BackupJob): UploadTicket {
    val expiresAt = json.getString("expiresAt")
    val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
      isLenient = false
    }
    val position = ParsePosition(0)
    val expires = parser.parse(expiresAt, position)?.time ?: throw BackupFailure("Invalid upload expiry.")
    // Expiry is server time; renewal and Azure's response handle a skewed device clock.
    if (position.index != expiresAt.length || json.getInt("blockSize") != BLOCK_SIZE ||
      json.getString("uploadId") != job.uploadId) throw BackupFailure("Invalid upload ticket.")
    val original = json.getString("uploadUrl")
    val preview = json.optionalString("thumbnailUploadUrl")
    http.validateBlob(original)
    if (preview != null) http.validateBlob(preview)
    if (job.json.optBoolean("hasThumbnail") && preview == null) throw BackupFailure("Missing preview upload ticket.")
    return UploadTicket(json.getString("uploadId"), original, preview, expires)
  }

  private fun completedMedia(result: JSONObject, job: BackupJob): JSONObject {
    for (field in listOf("id", "name", "contentType", "createdAt", "url")) {
      if (result.opt(field) !is String) throw BackupFailure("The API returned invalid completed media.")
    }
    val size = result.opt("size")
    if (size !is Number || !size.toDouble().isFinite() || size.toDouble() != job.json.getLong("size").toDouble()) {
      throw BackupFailure("The API returned invalid completed media.")
    }
    if (result.getString("id") != job.json.getString("sha256") ||
      result.getLong("size") != job.json.getLong("size")) throw BackupFailure("The API returned mismatched media.")
    if (result.isNull("thumbnailUrl")) result.remove("thumbnailUrl")
    else if (result.opt("thumbnailUrl") !is String) throw BackupFailure("The API returned an invalid preview URL.")
    return result
  }

  private fun blockId(index: Int): String =
    Base64.encodeToString(String.format(Locale.US, "%08d", index).toByteArray(Charsets.US_ASCII), Base64.NO_WRAP)
}
