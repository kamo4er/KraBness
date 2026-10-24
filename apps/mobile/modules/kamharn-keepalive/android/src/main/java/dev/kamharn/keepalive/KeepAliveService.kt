package dev.kamharn.keepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

// Фоновый сервис с постоянным уведомлением: пока он работает, Android не замораживает процесс приложения,
// и соединение с хабом (WebSocket в JS) не рвётся, когда приложение свёрнуто.
class KeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: "connected to the PC"
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "KraBness"
    val channel = intent?.getStringExtra(EXTRA_CHANNEL) ?: "PC connection in background"
    val n = build(this, text, title, channel)
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, n)
    }
    running = true
    // система убила процесс — перезапустит сервис сама
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    const val NOTIFICATION_ID = 7420
    const val CHANNEL = "kamharn_keepalive"
    const val EXTRA_TEXT = "text"
    // заголовок и имя канала — от JS, на языке интерфейса
    const val EXTRA_TITLE = "title"
    const val EXTRA_CHANNEL = "channel"

    @Volatile
    var running = false

    fun build(ctx: Context, text: String, title: String, channel: String): Notification {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= 26) {
        // тихий канал: уведомление висит, но не звенит и не всплывает; повторное создание с тем же id меняет только имя (язык)
        val ch = NotificationChannel(CHANNEL, channel, NotificationManager.IMPORTANCE_LOW)
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
      }
      val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      val pi = launch?.let { PendingIntent.getActivity(ctx, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
      // значок уведомлений приложения (тот же, что у пушей), иначе системный
      val icon = ctx.resources.getIdentifier("notification_icon", "drawable", ctx.packageName).takeIf { it != 0 } ?: android.R.drawable.stat_notify_sync
      val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(ctx)
      return b
        .setSmallIcon(icon)
        .setColor(0xff3b82f6.toInt())
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setShowWhen(false)
        .setCategory(Notification.CATEGORY_SERVICE)
        .apply { if (pi != null) setContentIntent(pi) }
        .build()
    }
  }
}
