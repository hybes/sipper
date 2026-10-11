package com.hybes.sipper

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.*
import com.google.firebase.FirebaseApp
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PushWorkTest {
    @Test fun expiredOrMalformedBackgroundJobsFinishWithoutStartingCalling() = runBlocking<Unit> {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as SipperApplication
        val manager = WorkManager.getInstance(context)
        val expired = mapOf("type" to "incoming_call", "schemaVersion" to "1", "deviceId" to UUID.randomUUID().toString(),
            "callId" to UUID.randomUUID().toString(), "expiresAt" to Instant.now().minusSeconds(1).toString())
        for (payload in listOf(emptyMap(), expired, expired + ("caller" to "Untrusted caller"))) {
            val request = OneTimeWorkRequestBuilder<IncomingCallWorker>()
                .setInputData(Data.Builder().apply { payload.forEach { (key, value) -> putString(key, value) } }.build())
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).build()
            withContext(Dispatchers.IO) { manager.enqueue(request).result.get() }
            val result = withTimeout(15_000) {
                var state: WorkInfo.State
                do {
                    state = withContext(Dispatchers.IO) { manager.getWorkInfoById(request.id).get()!!.state }
                    if (!state.isFinished) delay(50)
                } while (!state.isFinished)
                state
            }
            assertEquals(WorkInfo.State.SUCCEEDED, result)
        }
        assertFalse(app.model.ready.value)
        assertTrue(app.model.calls.value.isEmpty())
        if (!CallPush.configured) assertTrue(FirebaseApp.getApps(context).isEmpty())
    }
}
