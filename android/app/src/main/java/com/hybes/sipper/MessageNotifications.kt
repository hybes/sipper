package com.hybes.sipper

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat

internal object MessageNotifications {
    private const val tag = "sipper-messages"
    private val keys = setOf("type", "schemaVersion", "deviceId", "conversationId", "expiresAt")
    private fun preferences(context: Context) = context.getSharedPreferences("message-notifications", Context.MODE_PRIVATE)
    fun enabled(context: Context) = preferences(context).getBoolean("enabled", false)
    fun setEnabled(context: Context, enabled: Boolean) {
        preferences(context).edit().putBoolean("enabled", enabled).apply()
        if (!enabled) clear(context)
        CallPush.scheduleToken(context)
    }
    fun initialise(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("messages", "Messages", NotificationManager.IMPORTANCE_DEFAULT))
    }
    fun allowed(context: Context) = enabled(context)
        && (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
        && context.getSystemService(NotificationManager::class.java).let {
            it.areNotificationsEnabled() && it.getNotificationChannel("messages")?.importance != NotificationManager.IMPORTANCE_NONE
        }
    fun clear(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.tag == tag }.forEach { manager.cancel(it.tag, it.id) }
    }
    fun fromIntent(intent: Intent?): MessageNotification? {
        if (intent?.getStringExtra("type") != "message") return null
        val data = keys.mapNotNull { key -> intent.getStringExtra(key)?.let { key to it } }.toMap()
        keys.forEach { intent.removeExtra(it) } // No hint in saved Activity state.
        return messageNotification(data, forRouting = true)
    }
    fun receive(context: Context, data: Map<String, String>) {
        val hint = messageNotification(data) ?: return
        if (!allowed(context)) return
        val model = (context.applicationContext as SipperApplication).model
        if (model.managed.messageEnrollment(hint.deviceId) == null) return
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        data.forEach { (key, value) -> intent.putExtra(key, value) }
        val open = PendingIntent.getActivity(context, 602, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, "messages").setSmallIcon(R.drawable.ic_phone)
            .setContentTitle("Sipper").setContentText("New message").setAutoCancel(true).setContentIntent(open)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setLocalOnly(true).build()
        context.getSystemService(NotificationManager::class.java).notify(tag, 0, notification)
    }
}
