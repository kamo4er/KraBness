package dev.kamharn.keepalive

import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KamharnKeepAliveModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "no application context" }

  override fun definition() = ModuleDefinition {
    Name("KamharnKeepAlive")

    // запустить или обновить текст уведомления (повторный вызов просто меняет текст)
    Function("start") { text: String, title: String, channel: String ->
      val i = Intent(context, KeepAliveService::class.java)
        .putExtra(KeepAliveService.EXTRA_TEXT, text)
        .putExtra(KeepAliveService.EXTRA_TITLE, title)
        .putExtra(KeepAliveService.EXTRA_CHANNEL, channel)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
    }

    // обновить текст у уже работающего сервиса: из фона запускать сервис Android 12+ не даёт, а менять уведомление — можно
    Function("update") { text: String, title: String, channel: String ->
      if (KeepAliveService.running) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        nm.notify(KeepAliveService.NOTIFICATION_ID, KeepAliveService.build(context, text, title, channel))
      }
    }

    Function("stop") {
      context.stopService(Intent(context, KeepAliveService::class.java))
    }

    Function("isRunning") {
      KeepAliveService.running
    }
  }
}
