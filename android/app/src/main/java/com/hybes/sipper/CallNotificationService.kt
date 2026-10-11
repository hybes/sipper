package com.hybes.sipper

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build

/** One foreground notification follows the ringing call, then an ongoing call. */
class CallNotificationService : Service() {
    private val calls = linkedMapOf<Int, Pair<Notification, Boolean>>()
    private var displayedId: Int? = null
    inner class LocalBinder : Binder() { val service get() = this@CallNotificationService }
    override fun onBind(intent: Intent) = LocalBinder()

    fun show(id: Int, notification: Notification, ringing: Boolean) {
        calls[id] = notification to ringing
        publish()
    }
    fun remove(id: Int) { calls.remove(id); publish() }
    private fun publish() {
        val selected = calls.entries.lastOrNull { it.value.second } ?: calls.entries.firstOrNull()
        val notification = selected?.value?.first
        // A new ringing call must alert even when it replaces an ongoing call's
        // foreground notification; ordinary updates remain silent.
        if (notification != null) notification.flags = if (selected?.key != displayedId && selected?.value?.second == true)
            notification.flags and Notification.FLAG_ONLY_ALERT_ONCE.inv()
        else notification.flags or Notification.FLAG_ONLY_ALERT_ONCE
        displayedId = selected?.key
        if (notification == null) stopForeground(STOP_FOREGROUND_REMOVE)
        else if (Build.VERSION.SDK_INT >= 29) startForeground(100, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        else startForeground(100, notification)
    }
    override fun onDestroy() { calls.clear(); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy() }
}
