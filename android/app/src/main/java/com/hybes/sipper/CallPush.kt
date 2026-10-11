package com.hybes.sipper

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.*
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.*
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal object CallPush {
    val configured get() = BuildConfig.FIREBASE_APP_ID.isNotEmpty()
    fun initialise(context: Context) {
        if (!configured || FirebaseApp.getApps(context).any { it.name == FirebaseApp.DEFAULT_APP_NAME }) return
        FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
            .setApplicationId(BuildConfig.FIREBASE_APP_ID).setApiKey(BuildConfig.FIREBASE_API_KEY)
            .setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
    }
    fun allowed(context: Context) =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED &&
        (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
        context.getSystemService(NotificationManager::class.java).let {
            it.areNotificationsEnabled() && it.getNotificationChannel("calls")?.importance != NotificationManager.IMPORTANCE_NONE
        }
    // Match the server's HTTP v1 token contract; FID addressing requires a server migration.
    @Suppress("DEPRECATION")
    suspend fun token(): String = suspendCancellableCoroutine { continuation ->
        FirebaseMessaging.getInstance().token.addOnSuccessListener { if (continuation.isActive) continuation.resume(it) }
            .addOnFailureListener { if (continuation.isActive) continuation.resumeWithException(it) }
    }
    fun scheduleToken(context: Context): Boolean {
        if (!configured) return false
        return try {
            WorkManager.getInstance(context).enqueueUniqueWork("sipper-push-token", ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<PushTokenWorker>()
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
            true
        } catch (_: RuntimeException) { false } // Call setup remains usable if Android cannot schedule notifications.
    }
    fun scheduleCall(context: Context, data: Map<String, String>, highPriority: Boolean) {
        val push = incomingCallPush(data) ?: return
        if (!allowed(context)) return
        val request = OneTimeWorkRequestBuilder<IncomingCallWorker>()
            .setInputData(Data.Builder().apply { data.forEach { (key, value) -> putString(key, value) } }.build())
            .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.SECONDS)
        if (highPriority) request.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        WorkManager.getInstance(context).enqueueUniqueWork("sipper-call-${push.deviceId}-${push.callId}", ExistingWorkPolicy.KEEP, request.build())
    }
}

class CallMessagingService : FirebaseMessagingService() {
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onNewToken(token: String) { CallPush.scheduleToken(this) }
    override fun onMessageReceived(message: RemoteMessage) {
        if (!CallPush.configured) return
        if (message.data["type"] == "message") MessageNotifications.receive(this, message.data)
        else CallPush.scheduleCall(this, message.data, message.priority == RemoteMessage.PRIORITY_HIGH)
    }
}

class PushTokenWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        if (!CallPush.configured) return Result.success()
        return try {
            withTimeout(30_000) { withContext(Dispatchers.Main) {
                val model = (applicationContext as SipperApplication).model
                model.awaitReady()
                model.syncCallPush()
            } }
            Result.success()
        } catch (_: TimeoutCancellationException) { if (runAttemptCount < 3) Result.retry() else Result.failure() }
        catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            if (runAttemptCount < 3 && (failure !is ManagedFailure || failure.kind in setOf("unavailable", "pending"))) Result.retry() else Result.failure()
        }
    }
}

class IncomingCallWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val values = inputData.keyValueMap
        if (values.values.any { it !is String }) return Result.success()
        val push = incomingCallPush(values.mapValues { it.value as String }) ?: return Result.success()
        if (!CallPush.allowed(applicationContext)) return Result.success()
        return try {
            withTimeoutOrNull((push.expiresAt - System.currentTimeMillis()).coerceAtLeast(1)) {
                withContext(Dispatchers.Main) {
                    val model = (applicationContext as SipperApplication).model
                    model.awaitReady()
                    model.wakeCall(push)
                }
            }
            Result.success()
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            // Work delayed beyond the ringing deadline must never restart an old call.
            val transient = failure !is ManagedFailure || failure.kind in setOf("unavailable", "pending")
            if (transient && runAttemptCount < 2 && push.expiresAt > System.currentTimeMillis() + 10_000) Result.retry() else Result.success()
        }
    }
    // WorkManager uses a foreground service for expedited work before Android 12.
    override suspend fun getForegroundInfo(): ForegroundInfo {
        applicationContext.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("call-connection", "Incoming call connection", NotificationManager.IMPORTANCE_LOW))
        val notification = NotificationCompat.Builder(applicationContext, "call-connection")
            .setSmallIcon(R.drawable.ic_phone).setContentTitle("Sipper").setContentText("Connecting incoming call…")
            .setOngoing(true).setSilent(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
        return ForegroundInfo(1 + (id.hashCode() and 0x3fffffff), notification)
    }
}
