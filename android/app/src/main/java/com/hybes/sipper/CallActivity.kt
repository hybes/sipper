package com.hybes.sipper

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** Only the selected live call is available over the lock screen. */
class CallActivity : ComponentActivity() {
    private val model get() = (application as SipperApplication).model
    private var callId by mutableStateOf<String?>(null)
    private var afterPermission: (() -> Unit)? = null
    private var permissionCallId: String? = null
    private val microphone = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        val action = afterPermission
        afterPermission = null
        if (permissionCallId == callId && model.calls.value.any { it.id == callId && it.state != "Ended" }) {
            if (allowed) action?.invoke() else model.error.value = "Allow microphone access to answer this call."
        }
        permissionCallId = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Never start calling or reload accounts because an old notification opened.
        if (!selectCall(intent, answer = savedInstanceState == null)) return
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        setContent { SipperTheme {
            val calls by model.calls.collectAsState()
            val call = calls.find { it.id == callId && it.state != "Ended" }
            val error by model.error.collectAsState()
            LaunchedEffect(call?.id) { if (call == null) finishAndRemoveTask() }
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                Column(Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(24.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Image(painterResource(R.drawable.sipper_icon), contentDescription = null, modifier = Modifier.size(32.dp))
                            Text("Sipper", style = MaterialTheme.typography.titleLarge)
                        }
                        TextButton(onClick = { finishAndRemoveTask() }) { Text("Close") }
                    }
                    Column(Modifier.widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        if (error != null) {
                            Text(error!!, color = MaterialTheme.colorScheme.error)
                            TextButton(onClick = { model.error.value = null }) { Text("Dismiss") }
                        }
                        call?.let { current -> key(current.presentationId) { CallCard(current, model, ::withMicrophone, allowOtherCalls = false) {
                            model.scope.launch {
                                if (model.prepareNewCall(current.id)) {
                                    // The normal activity stays behind the keyguard until the phone is unlocked.
                                    startActivity(Intent(this@CallActivity, MainActivity::class.java)
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
                                    finishAndRemoveTask()
                                }
                            }
                        } } }
                    }
                }
            }
        } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        afterPermission = null; permissionCallId = null
        selectCall(intent, answer = true)
    }

    private fun selectCall(intent: Intent, answer: Boolean): Boolean {
        val call = model.calls.value.find { it.id == intent.getStringExtra("callId") && it.state != "Ended" }
        if (call == null) { finishAndRemoveTask(); return false }
        callId = call.id
        if (answer && intent.action == "answer" && call.incoming && !call.connected) {
            withMicrophone { model.scope.launch { model.callAction(call.id, "answer") } }
        }
        return true
    }

    private fun withMicrophone(action: () -> Unit) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) action()
        else {
            if (afterPermission != null) return
            afterPermission = action; permissionCallId = callId
            microphone.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    companion object {
        fun pendingIntent(context: Context, id: String, answer: Boolean = false): PendingIntent {
            val action = if (answer) "answer" else "show"
            val intent = Intent(context, CallActivity::class.java).setAction(action)
                .setData(Uri.parse("sipper-call:/$id/$action")).putExtra("callId", id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
    }
}
