package com.hybes.sipper

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.*
import livekit.org.webrtc.RendererCommon
import java.util.UUID
import kotlin.coroutines.resume

internal class AndroidMeetingSession(private val context: Context, val client: ManagedClient,
    val deviceId: String, val conversationId: String, private val scope: CoroutineScope,
    private val claimAudio: () -> Boolean, private val releaseAudio: () -> Unit) {
    private val userId = client.status.value.identity?.id
    private val accessVersion = client.conversationAccessVersion.value
    private val enrollment = client.messageEnrollment(deviceId)
    var current by mutableStateOf<CurrentMeeting?>(null); private set
    var details by mutableStateOf<MeetingDetails?>(null); private set
    var room by mutableStateOf<Room?>(null); private set
    var loading by mutableStateOf(false); private set
    var joining by mutableStateOf(false); private set
    var stopping by mutableStateOf(false); private set
    var captureBusy by mutableStateOf(false); private set
    var controlling by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var mediaRevision by mutableStateOf(0); private set
    private var claimedAudio = false
    private var generation = 0
    private var startId = UUID.randomUUID().toString()
    private var meetingId: String? = null
    private var sessionId: String? = null
    private var joinJob: Job? = null
    private var captureJob: Job? = null
    private var eventJob: Job? = null
    private var stopJob: Job? = null
    val authorised get() = userId != null && client.conversationAccessVersion.value == accessVersion && client.status.value.identity?.id == userId && enrollment != null
        && client.messageEnrollment(deviceId)?.organisationId == enrollment.organisationId
    val metadataReady get() = details?.let { it.scope.expiresAt > System.currentTimeMillis()
        && it.meeting.expiresAt > System.currentTimeMillis() && it.meeting.conversationId == conversationId && it.canJoin } == true
    val canJoin get() = authorised && !loading && !joining && !stopping && !controlling && room == null
        && current?.let { it.available && it.scope.expiresAt > System.currentTimeMillis() && (it.meeting == null || metadataReady) } == true
    val host get() = details?.meeting?.createdBy == userId
    val canControl get() = authorised && metadataReady && !controlling && !stopping
    private fun matches(attempt: Int) = attempt == generation && authorised
    fun clearExpiredMetadata(now: Long = System.currentTimeMillis()) {
        if (current?.scope?.expiresAt?.let { it <= now } == true) current = null
        if (details?.scope?.expiresAt?.let { it <= now } == true) details = null
    }
    suspend fun refresh() {
        if (!authorised) { current = null; details = null; stop("Meeting access is no longer available."); return }
        if (loading || joining || stopping) return
        val attempt = generation
        loading = true
        try {
            val value = client.currentMeeting(deviceId, conversationId)
            if (!matches(attempt)) return
            val id = meetingId ?: value.meeting?.id
            val metadata = id?.let { client.meetingDetails(deviceId, it) }
            if (!matches(attempt)) return
            if (metadata != null && metadata.meeting.conversationId != conversationId) invalidMeeting()
            current = value; details = metadata
            if (meetingId != null && metadata != null && (!metadata.canJoin || metadata.sessions.any { it.id == sessionId && it.revokedAt != null }))
                stop(if (metadata.meeting.endedAt != null) "The meeting has ended." else "Your meeting access was withdrawn.")
        } catch (problem: Exception) {
            if (problem is CancellationException) throw problem
            if (attempt != generation) return
            error = meetingError(problem)
            if (!authorised || (problem as? ManagedFailure)?.kind in setOf("sign_in_required", "access_denied", "cancelled")) {
                current = null; details = null; stop(error)
            }
        } finally { if (attempt == generation) loading = false }
    }
    fun join() {
        if (!canJoin) return
        if (!claimAudio()) { error = "Finish your phone call before joining a meeting."; return }
        claimedAudio = true; joining = true; error = null
        val attempt = generation; val nonce = UUID.randomUUID().toString()
        sessionId = nonce
        joinJob = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val value = if (current?.meeting == null) client.startMeeting(deviceId, conversationId, startId)
                    else client.currentMeeting(deviceId, conversationId)
                ensureActive()
                if (!matches(attempt)) return@launch
                val meeting = value.meeting ?: invalidMeeting()
                current = value; meetingId = meeting.id
                val metadata = client.meetingDetails(deviceId, meeting.id)
                if (!matches(attempt) || !metadata.canJoin || metadata.meeting.conversationId != conversationId) invalidMeeting()
                details = metadata
                val grant = client.joinMeeting(deviceId, meeting.id, nonce)
                ensureActive()
                if (!matches(attempt) || !metadataReady || current?.available != true
                    || current?.scope?.expiresAt?.let { it > System.currentTimeMillis() } != true
                    || grant.expiresAt <= System.currentTimeMillis()) invalidMeeting()
                val media = LiveKit.create(context, RoomOptions(adaptiveStream = true, dynacast = true),
                    LiveKitOverrides(audioOptions = AudioOptions(disableAudioPrewarming = true)))
                room = media
                eventJob = scope.launch {
                    media.events.collect { event ->
                        if (room === media && generation == attempt) {
                            mediaRevision++
                            if (event is RoomEvent.Disconnected && !stopping) stop("The media connection ended. Join again to reconnect.")
                        }
                    }
                }
                media.connect(grant.url, grant.token, ConnectOptions(audio = false, video = false))
                ensureActive()
                if (!matches(attempt)) media.disconnect()
            } catch (problem: Exception) {
                if (attempt == generation) { error = meetingError(problem); stop() }
            } finally { if (attempt == generation) { joining = false; joinJob = null } }
        }.also { it.start() }
    }
    private fun stopTracks(media: Room, source: Track.Source? = null) {
        for (publication in media.localParticipant.trackPublications.values.toList()) {
            if (source != null && publication.source != source) continue
            publication.track?.let { track -> runCatching { track.stop() }; runCatching { media.localParticipant.unpublishTrack(track) } }
        }
    }
    fun stop(reason: String? = null) {
        if (reason != null) error = reason
        if (stopping) return
        generation++; loading = false; joining = false; stopping = true
        val pendingJoin = joinJob; val pendingCapture = captureJob; val media = room
        pendingJoin?.cancel(); pendingCapture?.cancel(); eventJob?.cancel()
        if (media != null) {
            runCatching { media.setMicrophoneMute(true); media.setSpeakerMute(true) }
            stopTracks(media); runCatching { media.disconnect() }
        }
        stopJob = scope.launch(start = CoroutineStart.LAZY) {
            // Cleanup outlives the Compose screen, including an already submitted join.
            withContext(NonCancellable) {
                pendingJoin?.join(); pendingCapture?.join()
                if (media != null) { stopTracks(media); runCatching { media.release() } }
                val id = meetingId; val session = sessionId
                if (id != null && session != null) {
                    try { client.leaveMeeting(deviceId, id, session) }
                    catch (problem: Exception) { if (authorised) error = "Local media stopped. Leaving was not confirmed. ${meetingError(problem)}" }
                    startId = UUID.randomUUID().toString()
                }
                room = null; meetingId = null; sessionId = null; joinJob = null; captureJob = null; eventJob = null
                captureBusy = false; stopping = false
                if (claimedAudio) { claimedAudio = false; releaseAudio() }
            }
        }.also { it.start() }
    }
    suspend fun waitForStop() { stopJob?.join() }
    fun capture(source: Track.Source, enabled: Boolean, permission: suspend () -> Boolean) {
        val media = room ?: return
        if (captureBusy || stopping || source !in setOf(Track.Source.MICROPHONE, Track.Source.CAMERA)) return
        if (enabled && (!authorised || !metadataReady || media.state != Room.State.CONNECTED)) return
        val attempt = generation
        captureBusy = true; error = null
        captureJob = scope.launch(start = CoroutineStart.LAZY) {
            try {
                if (!enabled) { stopTracks(media, source); mediaRevision++; return@launch }
                val allowed = permission()
                ensureActive()
                if (!matches(attempt) || room !== media || !metadataReady || media.state != Room.State.CONNECTED) throw CancellationException()
                check(allowed) { "Allow ${if (source == Track.Source.MICROPHONE) "microphone" else "camera"} access in Android settings to enable it." }
                val success = if (source == Track.Source.MICROPHONE) media.localParticipant.setMicrophoneEnabled(true)
                    else media.localParticipant.setCameraEnabled(true)
                ensureActive()
                if (!success || !matches(attempt) || room !== media || !metadataReady || media.state != Room.State.CONNECTED) throw CancellationException()
                mediaRevision++
            } catch (problem: Exception) {
                stopTracks(media, source)
                if (attempt == generation) error = if (problem is IllegalStateException) problem.message else "Capture could not start. Check access and join again."
            } finally { if (attempt == generation) { captureBusy = false; captureJob = null } }
        }.also { it.start() }
    }
    suspend fun end() {
        val metadata = details ?: return
        if (!canControl || !host) return
        val attempt = generation
        controlling = true
        try { client.endMeeting(deviceId, metadata.meeting.id); if (matches(attempt)) stop("Meeting end requested. Server confirmation may take a moment.") }
        catch (problem: Exception) { if (problem is CancellationException) throw problem; if (attempt == generation) error = meetingError(problem) }
        finally { controlling = false }
    }
    suspend fun remove(user: String) {
        val metadata = details ?: return
        if (!canControl || !host || user == userId) return
        val attempt = generation
        controlling = true
        try { client.removeMeetingPerson(deviceId, metadata.meeting.id, user); if (matches(attempt)) refresh() }
        catch (problem: Exception) { if (problem is CancellationException) throw problem; if (attempt == generation) error = meetingError(problem) }
        finally { controlling = false }
    }
}
private fun meetingError(problem: Exception) = (problem as? ManagedFailure)?.message ?: "Could not connect meeting media. Check your connection, then join again."

@Composable internal fun ManagedMeetingView(session: AndroidMeetingSession, phoneBusy: Boolean, onClose: () -> Unit) {
    val context = LocalContext.current
    val status by session.client.status.collectAsState()
    val accessVersion by session.client.conversationAccessVersion.collectAsState()
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var confirmEnd by remember { mutableStateOf(false) }
    var removing by remember { mutableStateOf<String?>(null) }
    var permissionResult by remember { mutableStateOf<CancellableContinuation<Boolean>?>(null) }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        permissionResult?.takeIf { it.isActive }?.resume(allowed); permissionResult = null
    }
    fun close() { session.stop(); scope.launch { session.waitForStop(); onClose() } }
    BackHandler { if (!session.stopping) close() }
    LaunchedEffect(session, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { while (true) { session.refresh(); delay(5000) } }
    }
    LaunchedEffect(session) { while (true) { session.clearExpiredMetadata(); delay(1000) } }
    LaunchedEffect(status, accessVersion, phoneBusy) {
        if (!session.authorised) session.stop("Meeting access is no longer available.")
        else if (phoneBusy && (session.room != null || session.joining)) session.stop("Phone activity stopped meeting media. Join again after the call.")
    }
    DisposableEffect(session, lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            // ponytail: foreground meetings only; add a meeting Telecom/foreground-service
            // owner before allowing audio/capture to continue on lock or background.
            if (event == Lifecycle.Event.ON_STOP) session.stop("Meeting media stopped in the background. Join again to reconnect.")
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); permissionResult?.cancel(); session.stop() }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(session.details?.title ?: "Meeting", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f), maxLines = 2)
            TextButton(onClick = ::close, enabled = !session.stopping) { Text(if (session.room == null && !session.joining) "Close" else "Leave") }
        }
        session.current?.scope?.organisationName?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        session.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (phoneBusy) Text("Finish your phone call before joining a meeting.")
        if (session.joining || session.stopping) Text(if (session.stopping) "Stopping local media…" else "Joining meeting…")
        val media = session.room
        if (media == null) {
            Text(if (session.current?.available == false) "Meetings are not configured for this service yet."
                else if (session.details?.meeting?.endedAt != null) "The meeting has ended."
                else "Join with microphone and camera off. You can turn them on after joining.")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { session.join() }, enabled = session.canJoin && !phoneBusy) { Text(if (session.current?.meeting == null) "Start meeting" else "Join meeting") }
                OutlinedButton(onClick = { scope.launch { session.refresh() } }, enabled = !session.loading && !session.joining && !session.stopping) { Text("Refresh") }
            }
        } else {
            session.mediaRevision // Room events invalidate participant/publication reads.
            Text(media.state.name.lowercase().replaceFirstChar(Char::titlecase))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((source, label) in listOf(Track.Source.MICROPHONE to "Microphone", Track.Source.CAMERA to "Camera")) {
                    val enabled = media.localParticipant.trackPublications.values.any { it.source == source && !it.muted && it.track != null }
                    OutlinedButton(onClick = {
                        session.capture(source, !enabled) {
                            val permission = if (source == Track.Source.MICROPHONE) Manifest.permission.RECORD_AUDIO else Manifest.permission.CAMERA
                            if (context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) true
                            else suspendCancellableCoroutine { continuation -> permissionResult = continuation; permissions.launch(permission) }
                        }
                    }, enabled = !session.captureBusy && !session.stopping && (enabled || (session.metadataReady && media.state == Room.State.CONNECTED))) {
                        Text("$label ${if (enabled) "off" else "on"}")
                    }
                }
            }
            val participants = listOf(media.localParticipant) + media.remoteParticipants.values
            Column(Modifier.horizontalScroll(rememberScrollState()).widthIn(min = 650.dp)) {
                Row { for ((text, width) in listOf("Person" to 210, "Microphone" to 100, "Camera" to 90, "Screen" to 100, "Actions" to 150)) Text(text, Modifier.width(width.dp), style = MaterialTheme.typography.labelLarge) }
                HorizontalDivider()
                for (person in participants) {
                    val admission = session.details?.sessions?.find { "sipper:${it.id}" == person.identity?.value }
                    val own = person === media.localParticipant
                    val sameUser = admission?.userId == status.identity?.id
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 8.dp)) {
                        Text(if (own) "You" else if (sameUser) "You (another device)" else admission?.name ?: "Participant", Modifier.width(210.dp))
                        for ((source, width) in listOf(Track.Source.MICROPHONE to 100, Track.Source.CAMERA to 90, Track.Source.SCREEN_SHARE to 100)) {
                            val publication = person.trackPublications.values.find { it.source == source }
                            Text(if (publication == null || publication.muted) "Off" else if (own || publication.subscribed) "On" else "Receiving…", Modifier.width(width.dp))
                        }
                        if (!own && !sameUser && admission != null && session.host)
                            TextButton(onClick = { removing = admission.userId }, enabled = session.canControl, modifier = Modifier.width(150.dp)) { Text("Remove…") }
                    }
                    HorizontalDivider()
                }
            }
            for (person in participants) for (publication in person.trackPublications.values) {
                val video = publication.track as? VideoTrack ?: continue
                if (!publication.muted) key(media, video) {
                    Text(if (publication.source == Track.Source.SCREEN_SHARE) "Screen" else "Camera", style = MaterialTheme.typography.labelMedium)
                    AndroidView(factory = { ctx -> TextureViewRenderer(ctx).apply {
                        media.initVideoRenderer(this); setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT); video.addRenderer(this)
                    } }, onRelease = { renderer -> video.removeRenderer(renderer); renderer.release() }, modifier = Modifier.fillMaxWidth().height(210.dp))
                }
            }
        }
        if (session.host) TextButton(onClick = { confirmEnd = true }, enabled = session.canControl,
            colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("End for everyone…") }
        Text("Meeting media stops when Sipper goes into the background.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (confirmEnd) AlertDialog(onDismissRequest = { confirmEnd = false }, title = { Text("End this meeting?") },
        text = { Text("Everyone will be disconnected once the server confirms the request.") },
        confirmButton = { TextButton(onClick = { confirmEnd = false; scope.launch { session.end() } }, enabled = session.canControl) { Text("End for everyone") } },
        dismissButton = { TextButton(onClick = { confirmEnd = false }) { Text("Cancel") } })
    removing?.let { user -> AlertDialog(onDismissRequest = { removing = null }, title = { Text("Remove this person?") },
        text = { Text("Their devices will be disconnected and cannot rejoin this meeting. Server confirmation may take a moment.") },
        confirmButton = { TextButton(onClick = { removing = null; scope.launch { session.remove(user) } }, enabled = session.canControl) { Text("Remove person") } },
        dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } }) }
}
