package expo.modules.backgroundbackup

import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import android.provider.MediaStore
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest

internal class BackupMedia(private val context: Context, private val engine: BackupEngine, private val work: BackupWork) {
  fun prepare(job: BackupJob): File {
    if (job.contentType !in SUPPORTED_TYPES) throw BackupFailure(
      "Unsupported media type. Choose JPEG, PNG, GIF, WebP, HEIC/HEIF, AVIF, MP4, MOV, WebM, M4V or 3GP."
    )
    val dir = work.store.directory(job)
    val original = File(dir, "original")
    if (job.json.optBoolean("staged") && original.isFile && original.length() == job.json.optLong("size")) {
      return original
    }
    // Once fingerprinted, never replace a missing snapshot with a possibly edited device original.
    if (job.json.optBoolean("staged")) throw BackupFailure("Private backup copy is missing. Cancel and select the original again.")
    val part = File(dir, "original.part")
    val uri = sourceUri(job)
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    val signal = CancellationSignal()
    engine.registerSource(work, signal)
    try {
      val before = if (uri.scheme == "file") File(requireNotNull(uri.path)) else null
      val beforeSize = before?.length()
      val beforeModified = before?.lastModified()
      val beforeMedia = mediaMetadata(uri)
      val descriptor = context.contentResolver.openAssetFileDescriptor(uri, "r", signal)
        ?: throw BackupFailure("Original is unavailable. Restore access or select it again.")
      descriptor.use { asset ->
        if (asset.declaredLength > MAX_SIZE) throw BackupFailure("Choose a non-empty file up to 2 GiB.")
        asset.createInputStream().use { input ->
          FileOutputStream(part).use { output ->
            val buffer = ByteArray(256 * 1024)
            while (true) {
              engine.check(work)
              val count = input.read(buffer)
              if (count < 0) break
              total += count
              if (total > MAX_SIZE) throw BackupFailure("Choose a non-empty file up to 2 GiB.")
              digest.update(buffer, 0, count)
              output.write(buffer, 0, count)
              if (asset.declaredLength > 0) engine.progress(work, job, 0.15 * total / asset.declaredLength)
            }
            output.fd.sync()
          }
        }
        if (asset.declaredLength >= 0 && asset.declaredLength != total) {
          throw BackupFailure("Original changed while copying. Retry.")
        }
      }
      if (total == 0L) throw BackupFailure("Choose a non-empty file up to 2 GiB.")
      if (before != null && (beforeSize != before.length() || beforeModified != before.lastModified())) {
        throw BackupFailure("Original changed while copying. Retry.")
      }
      if (beforeMedia != mediaMetadata(uri)) throw BackupFailure("Original changed while copying. Retry.")
      engine.check(work)
      if (original.exists() && !original.delete()) throw IOException("Cannot replace private staging copy.")
      if (!part.renameTo(original)) throw IOException("Cannot save private staging copy.")
      if (!original.setReadOnly()) throw IOException("Cannot protect private staging copy.")
      job.resetTicket()
      job.json.put("size", total)
      job.json.put("sha256", digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) })
      job.json.put("staged", true)
      engine.checkpoint(work, job)
      return original
    } catch (_: SecurityException) {
      throw BackupFailure("Original permission expired. Restore photo access or select it again.")
    } catch (_: java.io.FileNotFoundException) {
      throw BackupFailure("Original is missing or cloud-only. Download it on this device, then retry.")
    } finally {
      engine.unregisterSource(signal)
      if (part.exists() && !part.delete()) {
        engine.warning(work, "Could not clean an interrupted private staging copy.")
      }
    }
  }

  private fun mediaMetadata(uri: Uri): Pair<Long?, Long?>? {
    if (uri.scheme != "content" || uri.authority != MediaStore.AUTHORITY) return null
    return context.contentResolver.query(uri,
      arrayOf(OpenableColumns.SIZE, MediaStore.MediaColumns.DATE_MODIFIED), null, null, null)?.use {
      if (!it.moveToFirst()) throw BackupFailure("Original is no longer in the device media library.")
      val size = it.getColumnIndex(OpenableColumns.SIZE)
      val modified = it.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED)
      Pair(if (size >= 0 && !it.isNull(size)) it.getLong(size) else null,
        if (modified >= 0 && !it.isNull(modified)) it.getLong(modified) else null)
    }
  }

  private fun sourceUri(job: BackupJob): Uri {
    val asset = job.json.optionalString("assetId")
    val uri = if (asset != null) {
      // Expo SDK 57's Asset.id is a MediaStore content URI; legacy APIs returned a numeric row ID.
      if (asset.all { it.isDigit() } && asset.isNotEmpty()) {
        val base = if (job.contentType.startsWith("video/")) MediaStore.Video.Media.EXTERNAL_CONTENT_URI
          else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        ContentUris.withAppendedId(base, asset.toLong())
      } else {
        Uri.parse(asset).also {
          if (it.scheme != "content" || it.authority != MediaStore.AUTHORITY) {
            throw BackupFailure("This media asset is not a local MediaStore original. Select it again.")
          }
        }
      }
    } else Uri.parse(job.json.getString("uri"))
    if (uri.scheme != "file" && uri.scheme != "content") throw BackupFailure("Original is not available locally.")
    // Do not ask a cloud documents provider to download data outside the network policy.
    if (uri.scheme == "content" && uri.authority != MediaStore.AUTHORITY &&
      uri.authority != "${context.packageName}.FileSystemFileProvider" &&
      uri.authority != "${context.packageName}.fileprovider") {
      throw BackupFailure("Select a downloaded local original; this content provider may require cloud access.")
    }
    if (uri.scheme == "content" && uri.authority == MediaStore.AUTHORITY &&
      !Regex("^/[^/]+/(images/media|video/media|file)/[0-9]+$").matches(uri.path ?: "")) {
      throw BackupFailure("Select a downloaded MediaStore original instead of a cloud photo-picker item.")
    }
    return uri
  }

  fun thumbnail(job: BackupJob, original: File): File? {
    val target = File(work.store.directory(job), "thumbnail.jpg")
    if (target.isFile && target.length() in 1..1024 * 1024L) return target
    if (job.json.optBoolean("thumbnailAttempted") && !job.json.optBoolean("hasThumbnail")) return null
    engine.check(work)
    var bitmap: Bitmap? = null
    try {
      if (job.contentType.startsWith("video/")) {
        val retriever = MediaMetadataRetriever()
        try {
          retriever.setDataSource(original.absolutePath)
          bitmap = if (Build.VERSION.SDK_INT >= 27) {
            retriever.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 480, 480)
          } else retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        } finally { retriever.release() }
      } else {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(original.absolutePath, bounds)
        val options = BitmapFactory.Options()
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 960) sample *= 2
        options.inSampleSize = sample
        bitmap = BitmapFactory.decodeFile(original.absolutePath, options)
      }
      val image = bitmap
      if (image != null) {
        val ratio = 480.0 / maxOf(image.width, image.height)
        if (ratio < 1) {
          bitmap = Bitmap.createScaledBitmap(image, maxOf(1, (image.width * ratio).toInt()),
            maxOf(1, (image.height * ratio).toInt()), true)
          if (bitmap !== image) image.recycle()
        }
        val bytes = ByteArrayOutputStream()
        if (bitmap!!.compress(Bitmap.CompressFormat.JPEG, 65, bytes) && bytes.size() in 1..1024 * 1024) {
          engine.check(work)
          val part = File(work.store.directory(job), "thumbnail.part")
          FileOutputStream(part).use { it.write(bytes.toByteArray()); it.fd.sync() }
          if (!part.renameTo(target)) throw IOException("Cannot save backup preview.")
        }
      }
    } catch (error: RuntimeException) {
      // Unsupported platform codecs are nonfatal: the original remains uploadable.
      job.json.put("thumbnailWarning", "Preview unavailable (${error.javaClass.simpleName}); backing up original only.")
    } catch (_: OutOfMemoryError) {
      job.json.put("thumbnailWarning", "Not enough memory to generate a preview; backing up original only.")
    } finally { bitmap?.recycle() }
    engine.check(work)
    job.json.put("thumbnailAttempted", true)
    engine.checkpoint(work, job)
    if (target.isFile && target.length() in 1..1024 * 1024L) return target
    if (job.json.optBoolean("hasThumbnail")) {
      throw BackupFailure("Cannot recreate the reserved preview. Cancel and select the original again.")
    }
    return null
  }

  fun verify(original: File, job: BackupJob) {
    if (original.length() != job.json.getLong("size")) throw BackupFailure("Private backup copy changed. Cancel and select it again.")
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(original).use { input ->
      val bytes = ByteArray(256 * 1024)
      while (true) {
        engine.check(work)
        val size = input.read(bytes)
        if (size < 0) break
        digest.update(bytes, 0, size)
      }
    }
    val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    if (hash != job.json.getString("sha256")) throw BackupFailure("Private backup copy changed. Cancel and select it again.")
  }
}
