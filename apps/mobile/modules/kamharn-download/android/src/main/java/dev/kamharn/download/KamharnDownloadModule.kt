package dev.kamharn.download

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

// Скачивание системным DownloadManager: качает, когда приложение свёрнуто, экран погас или приложение
// выгружено; сам докачивает после обрыва и показывает прогресс в шторке.
class KamharnDownloadModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "no application context" }

  private val manager: DownloadManager
    get() = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

  override fun definition() = ModuleDefinition {
    Name("KamharnDownload")

    Function("enqueue") { url: String, fileName: String, title: String, mime: String ->
      // папка приложения на внешнем хранилище: разрешения не нужны, файл удаляется вместе с приложением
      File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), fileName).delete()
      val request = DownloadManager.Request(Uri.parse(url))
        .setTitle(title)
        .setMimeType(mime)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, fileName)
        .setAllowedOverMetered(true)
        .setAllowedOverRoaming(true)
      manager.enqueue(request)
    }

    Function("query") { id: Long ->
      manager.query(DownloadManager.Query().setFilterById(id)).use { c ->
        if (!c.moveToFirst()) {
          null
        } else {
          val status = when (c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
            DownloadManager.STATUS_PENDING -> "pending"
            DownloadManager.STATUS_RUNNING -> "running"
            DownloadManager.STATUS_PAUSED -> "paused"
            DownloadManager.STATUS_SUCCESSFUL -> "successful"
            else -> "failed"
          }
          mapOf(
            "status" to status,
            "bytes" to c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)).toDouble(),
            "total" to c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)).toDouble(),
            "reason" to c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)),
          )
        }
      }
    }

    // открыть скачанный APK в установщике: content:// от DownloadManager, доступ на чтение выдаётся установщику
    Function("install") { id: Long ->
      val uri = manager.getUriForDownloadedFile(id) ?: throw IllegalStateException("download not found")
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    Function("remove") { id: Long ->
      manager.remove(id)
    }
  }
}
