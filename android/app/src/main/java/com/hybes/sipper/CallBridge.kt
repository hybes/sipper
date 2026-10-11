package com.hybes.sipper

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.ComponentName
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.IBinder
import android.telecom.DisconnectCause
import androidx.core.app.NotificationCompat
import androidx.core.telecom.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.sync.Mutex
import java.util.UUID

/** Main-dispatcher ownership shared by app and Telecom phone actions. */
internal class PhoneAudioGuard(private val busy: () -> Boolean) {
    private val mutableClaim = MutableStateFlow(false)
    val meetingClaimed = mutableClaim.asStateFlow()
    fun claimMeeting(): Boolean {
        if (mutableClaim.value || busy()) return false
        mutableClaim.value = true
        return true
    }
    fun releaseMeeting() { mutableClaim.value = false }
    fun requirePhone() { check(!mutableClaim.value) { "Leave the meeting before making, answering or resuming a phone call." } }
}

class CallBridge(private val context: Context, private val engine: SipEngine,
    private val scope: CoroutineScope, private val managed: ManagedCallControl, private val showError: (String) -> Unit) {
    private val manager = CallsManager(context)
    private val notifications = context.getSystemService(NotificationManager::class.java)
    private val started = mutableMapOf<String, String>()
    private val controls = mutableMapOf<String, CallControlScope>()
    private val owners = mutableMapOf<String, String>()
    private val bindings = mutableMapOf<String, Set<String>>()
    private val ready = mutableSetOf<String>()
    private val setup = Mutex()
    private val audioChanges = Mutex()
    private val _changing = MutableStateFlow(false)
    val changing = _changing.asStateFlow()
    private var presentationsPending = 0
    private val mutablePhoneAudioWork = MutableStateFlow(false)
    internal val phoneAudioWork = mutablePhoneAudioWork.asStateFlow()
    internal val audioGuard = PhoneAudioGuard { _changing.value || mutablePhoneAudioWork.value || engine.calls.value.any { it.state != "Ended" } }
    private val _routes = MutableStateFlow<Map<String, List<CallEndpointCompat>>>(emptyMap())
    val routes = _routes.asStateFlow()
    private var notificationId = 100
    private val notificationService = CompletableDeferred<CallNotificationService>()
    init {
        notifications.createNotificationChannels(listOf(
            NotificationChannel("incoming-calls", "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
                enableVibration(true)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
                setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            },
            NotificationChannel("ongoing-calls", "Ongoing calls", NotificationManager.IMPORTANCE_DEFAULT).apply {
                setSound(null, null); enableVibration(false)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            },
        ))
        manager.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                notificationService.complete((binder as CallNotificationService.LocalBinder).service)
            }
            override fun onServiceDisconnected(name: ComponentName) {
                notificationService.completeExceptionally(IllegalStateException("Android call notifications are unavailable."))
            }
        }
        check(context.bindService(Intent(context, CallNotificationService::class.java), connection, Context.BIND_AUTO_CREATE)) {
            "Android call notifications are unavailable."
        }
        // Release the binding after call-scope cleanup has finished, not as a
        // competing child coroutine while those calls are still being removed.
        scope.coroutineContext.job.invokeOnCompletion { context.unbindService(connection) }
        scope.launch {
            engine.calls.collect { calls ->
                val presentations = calls.distinctBy { it.presentationId }.filter { calls.presentationMembers(it.presentationId).isNotEmpty() }
                started.keys.retainAll(presentations.map { it.presentationId }.toSet())
                for (call in presentations) if (call.presentationId !in started) {
                    val identity = UUID.randomUUID().toString()
                    started[call.presentationId] = identity
                    presentationsPending++; mutablePhoneAudioWork.value = true
                    launch {
                        try { track(call, notificationId++, identity) }
                        finally { presentationsPending--; mutablePhoneAudioWork.value = presentationsPending > 0 }
                    }
                }
            }
        }
    }
    private fun requireMicrophone() {
        audioGuard.requirePhone()
        check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            "Allow microphone access in Sipper to make or answer a call."
        }
    }
    private suspend fun <T> changeAudio(block: suspend () -> T): T {
        audioGuard.requirePhone()
        check(audioChanges.tryLock()) { "The call is still updating. Try again." }
        _changing.value = true
        try { return block() } finally { _changing.value = false; audioChanges.unlock() }
    }
    private suspend fun holdOthers(except: String? = null) {
        val excluded = engine.calls.value.find { it.id == except }?.presentationId ?: except
        check(engine.calls.value.all { it.presentationId == excluded || it.state == "Ended" || (it.incoming && !it.connected) || (it.connected && !it.transferring) }) {
            "The call is still updating. Try again."
        }
        for (call in engine.calls.value.distinctBy { it.presentationId }) {
            val members = engine.calls.value.presentationMembers(call.presentationId)
            if (call.presentationId != excluded && members.any { it.connected && !it.held }) engine.hold(call.id, true)
        }
    }
    private fun control(id: String) = engine.calls.value.find { it.id == id }?.let { call ->
        controls[call.presentationId].takeIf { owners[call.presentationId] == started[call.presentationId] }
    }
    suspend fun dial(accountId: String, destination: String) = changeAudio {
        requireMicrophone()
        engine.validateDial(accountId, destination)
        holdOthers()
        engine.dial(accountId, destination)
    }
    suspend fun answer(id: String) = changeAudio {
        requireMicrophone()
        val control = control(id) ?: error("This call is not ready yet.")
        managed.answer(id) {
            audioGuard.requirePhone()
            holdOthers(id)
            check(control.answer(CallAttributesCompat.CALL_TYPE_AUDIO_CALL) is CallControlResult.Success) { "Android could not answer this call." }
            engine.answer(id)
            engine.enableAudio(true)
        }
    }
    suspend fun hangup(id: String) {
        val call = engine.calls.value.find { it.id == id } ?: return
        val control = control(id)
        if (call.conferenceId != null) engine.hangupConference(id, call.conferenceId) else {
            engine.hangup(id); managed.declined(call)
        }
        control?.disconnect(DisconnectCause(DisconnectCause.LOCAL))
    }
    suspend fun endParticipant(id: String, reference: String) {
        check(engine.calls.value.any { it.id == id && it.conferenceId == reference }) { "This conference is no longer available." }
        engine.hangup(id, reference)
    }
    suspend fun hold(id: String, held: Boolean) = changeAudio {
        requireMicrophone()
        val control = control(id) ?: error("This call has ended.")
        if (held) engine.hold(id, true) else holdOthers(id)
        val result = if (held) control.setInactive() else control.setActive()
        check(result is CallControlResult.Success) { "Android could not change the active call." }
        if (!held) engine.hold(id, false)
    }
    suspend fun merge(id: String, otherId: String) = changeAudio {
        requireMicrophone()
        val original = listOf(id, otherId).map { token -> engine.calls.value.find { it.id == token }
            ?.takeIf { it.connected && it.conferenceId == null && !it.transferring && it.state != "Ended" }
            ?: error("Choose two connected calls on the same account.") }
        check(id != otherId && original[0].accountId == original[1].accountId) { "Choose two connected calls on the same account." }
        val originalControls = original.associate { it.id to (control(it.id) ?: error("The call is still updating. Try again.")) }
        // Silence both legs during the handover; Telecom activates one new conference session.
        engine.enableAudio(false)
        var reference: String? = null
        try {
            holdOthers()
            for (call in original) {
                check(originalControls.getValue(call.id).setInactive() is CallControlResult.Success) { "Android could not hold this call." }
                engine.hold(call.id, false)
            }
            reference = engine.beginConference(id, otherId)
            check(awaitPresentation(id)) { "Android could not present the conference." }
        } catch (failure: Exception) {
            withContext(NonCancellable) {
                val group = reference
                if (group != null) runCatching { engine.conferenceHold(id, group, true) }
                else for (call in original) runCatching {
                    engine.hold(call.id, call.held)
                    if (!call.held) {
                        check(originalControls.getValue(call.id).setActive() is CallControlResult.Success)
                        engine.enableAudio(true)
                    }
                }.onFailure { showError("Some calls could not be restored. Check each participant’s hold status.") }
            }
            throw failure
        }
    }
    suspend fun separate(id: String, reference: String) = changeAudio {
        requireMicrophone()
        check(engine.calls.value.any { it.id == id && it.conferenceId == reference }) { "This conference is no longer available." }
        engine.conferenceHold(id, reference, true)
        val groupControl = control(id) ?: error("This conference has ended.")
        check(groupControl.setInactive() is CallControlResult.Success) { "Android could not hold the conference." }
        engine.splitConference(id, reference)
        check(awaitPresentation(id)) { "Android could not present this call. Both calls are on hold." }
        val individual = control(id) ?: error("This call has ended.")
        holdOthers(id)
        check(individual.setActive() is CallControlResult.Success) { "Android could not activate this call. Both calls are on hold." }
        engine.hold(id, false); engine.enableAudio(true)
    }
    suspend fun route(id: String, endpoint: CallEndpointCompat) {
        check(control(id)?.requestEndpointChange(endpoint) is CallControlResult.Success) { "This audio route is unavailable." }
    }
    internal suspend fun awaitPresentation(id: String): Boolean = withTimeoutOrNull(8000) {
        while (engine.calls.value.any { it.id == id && it.state != "Ended" }) {
            if (engine.calls.value.find { it.id == id }?.presentationId in ready && control(id) != null) return@withTimeoutOrNull true
            delay(50)
        }
        false
    } ?: false
    internal fun presentationIdsForTest(): Set<String> {
        check(BuildConfig.DEBUG)
        return controls.keys.toSet()
    }
    private suspend fun track(initial: PhoneCall, notification: Int, identity: String) {
        val key = initial.presentationId
        fun members() = if (started[key] == identity) engine.calls.value.presentationMembers(key) else emptyList()
        suspend fun endMembers() {
            val current = members().firstOrNull() ?: return
            if (current.conferenceId != null) engine.hangupConference(current.id, current.conferenceId)
            else { engine.hangup(current.id); managed.declined(current) }
        }
        var ownsSetup = false
        var publisher: CallNotificationService? = null
        try {
            val presented = managed.prepare(initial)
            publisher = withTimeout(4000) { notificationService.await() }
            setup.lock(); ownsSetup = true
            // Replacing a presentation releases its system session but keeps the exact SIP dialogs.
            withTimeout(4000) {
                while (members().isNotEmpty() && bindings.values.any { tokens -> members().any { it.id in tokens } }) delay(25)
            }
            val current = members()
            if (current.isEmpty()) return
            val title = if (initial.conferenceId != null) "Conference" else presented.remote
            val attributes = CallAttributesCompat(title, Uri.fromParts("sip", title, null),
                if (initial.incoming && initial.conferenceId == null) CallAttributesCompat.DIRECTION_INCOMING else CallAttributesCompat.DIRECTION_OUTGOING,
                CallAttributesCompat.CALL_TYPE_AUDIO_CALL, CallAttributesCompat.SUPPORTS_SET_INACTIVE)
            manager.addCall(attributes,
                onAnswer = { if (members().isNotEmpty()) changeAudio { requireMicrophone(); managed.answer(initial.id) { holdOthers(initial.id); engine.answer(initial.id); engine.enableAudio(true) } } },
                onDisconnect = { endMembers() },
                onSetActive = { if (members().isNotEmpty()) withTimeout(4500) { changeAudio {
                    requireMicrophone(); holdOthers(key); engine.hold(initial.id, false); engine.enableAudio(true)
                } } },
                onSetInactive = { members().firstOrNull()?.let { member ->
                    try { engine.hold(member.id, true, key) }
                    catch (failure: Exception) { if (failure is CancellationException || members().isNotEmpty()) throw failure }
                } },
            ) {
                ownsSetup = false; setup.unlock()
                controls[key] = this
                owners[key] = identity
                bindings[key] = current.map { it.id }.toSet()
                var active = false
                showNotification(publisher, presented, notification, current)
                val observers = launch {
                    current.forEach { call -> launch { managed.monitor(call.id) } }
                    launch { availableEndpoints.collect { endpoints ->
                        _routes.value += bindings[key].orEmpty().associateWith { endpoints }
                    } }
                    launch {
                        var initialMute = true
                        isMuted.collect { muted ->
                            // A new system session starts unmuted; retain the app's existing privacy choice.
                            if (!initialMute || muted) members().firstOrNull()?.let { engine.mute(it.id, muted, key) }
                            initialMute = false
                        }
                    }
                }
                launch {
                    try {
                        engine.calls.takeWhile {
                            if (members().isEmpty()) {
                                disconnect(DisconnectCause(DisconnectCause.REMOTE))
                                false
                            } else true
                        }.collect {
                            val values = members()
                            val call = values.first()
                            if (call.connected && !active) {
                                if (values.none { it.held }) {
                                    audioGuard.requirePhone()
                                    check(setActive() is CallControlResult.Success) { "Android could not activate call audio." }
                                    requireMicrophone(); engine.enableAudio(true)
                                }
                                active = true
                            }
                            ready.add(key)
                            showNotification(publisher, call, notification, values)
                        }
                    } finally {
                        // Core-Telecom's endpoint/mute flows remain open after
                        // disconnect; stop our collectors so addCall can return.
                        observers.cancel()
                    }
                }
            }
        } catch (error: Exception) {
            if (error !is CancellationException) showError(error.message ?: "Android could not start this call.")
            runCatching { endMembers() }
        } finally {
            if (ownsSetup) setup.unlock()
            runCatching { publisher?.remove(notification) }
            if (owners[key] == identity) {
                owners.remove(key); controls.remove(key); ready.remove(key)
                val tokens = bindings.remove(key).orEmpty()
                _routes.value -= tokens
            }
            withContext(NonCancellable) {
                runCatching { endMembers() }
                if (controls.isEmpty()) runCatching { engine.enableAudio(false) }
            }
            // Tokens are UUIDs, so a late notification can never target a recycled SIP call ID.
        }
    }
    private fun action(call: PhoneCall, action: String): PendingIntent = PendingIntent.getBroadcast(context, 0,
        Intent(context, CallActionReceiver::class.java).setAction(action)
            .setData(Uri.parse("sipper-call:/${call.presentationId}/$action")).putExtra("callId", call.id)
            .putExtra("presentationId", call.presentationId),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun showNotification(publisher: CallNotificationService, call: PhoneCall, id: Int, members: List<PhoneCall>) {
        val ringing = call.incoming && !call.connected
        val open = CallActivity.pendingIntent(context, call.id)
        val hangup = action(call, "hangup")
        val title = if (call.conferenceId != null) "Conference" else call.remote
        val state = if (call.conferenceId != null) when {
            members.all { it.held } -> "On hold"
            members.any { it.held } -> "Some participants are on hold"
            else -> "Connected"
        } else call.state
        val channel = if (ringing) "incoming-calls" else "ongoing-calls"
        val builder = NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_phone)
            .setContentTitle(title).setContentText(state).setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_CALL).setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_phone).setContentTitle("Sipper call").build())
        if (ringing) builder.setFullScreenIntent(open, true)
        val person = androidx.core.app.Person.Builder().setName(title).setImportant(true).build()
        builder.setStyle(if (ringing)
            NotificationCompat.CallStyle.forIncomingCall(person, hangup, CallActivity.pendingIntent(context, call.id, answer = true))
        else NotificationCompat.CallStyle.forOngoingCall(person, hangup))
        val notification = builder.build()
        if (ringing) notification.flags = notification.flags or android.app.Notification.FLAG_INSISTENT
        publisher.show(id, notification, ringing)
    }
}

class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra("callId") ?: return
        val model = (context.applicationContext as SipperApplication).model
        // An old notification must not initialise a new engine or start another call.
        val presentation = intent.getStringExtra("presentationId") ?: return
        if (model.calls.value.none { it.id == id && it.presentationId == presentation }) return
        val pending = goAsync()
        model.scope.launch {
            try { model.callAction(id, intent.action ?: "", presentation) } finally { pending.finish() }
        }
    }
}
