package com.hybes.sipper

import org.json.JSONObject
import java.net.URI
import java.time.Instant
import java.util.Base64

// Meeting metadata and grants stay in memory; no JSON encoder or saved-state model.
data class ManagedMeeting(val id: String, val conversationId: String, val createdBy: String?,
    val createdAt: Long, val expiresAt: Long, val endedAt: Long?, val controlConfirmedAt: Long?)
data class CurrentMeeting(val scope: MessageScope, val available: Boolean, val meeting: ManagedMeeting?)
data class MeetingSession(val id: String, val userId: String, val name: String?, val deviceId: String?,
    val revokedAt: Long?, val admittedAt: Long?, val controlConfirmedAt: Long?)
data class MeetingDetails(val scope: MessageScope, val available: Boolean, val canJoin: Boolean,
    val title: String, val hostName: String?, val meeting: ManagedMeeting, val sessions: List<MeetingSession>)
class MeetingGrant(val meetingId: String, val sessionId: String, val identity: String,
    val url: String, val token: String, val expiresAt: Long) {
    override fun toString() = "MeetingGrant(sessionId=$sessionId)"
}
internal fun invalidMeeting(): Nothing = throw ManagedFailure("invalid_meeting", "Meeting access could not be verified. Refresh and try again.")
internal fun invalidMeetingInput(): Nothing = throw ManagedFailure("invalid_meeting_input", "This meeting or person is unavailable. Refresh and try again.")
internal fun meetingId(value: String) = canonicalCallId(value) ?: invalidMeetingInput()
private fun JSONObject.meetingTime(key: String): Long = runCatching { Instant.parse(text(key)).toEpochMilli() }.getOrElse { invalidMeeting() }
private fun <T> JSONObject.nullable(key: String, read: () -> T): T? {
    if (!has(key)) invalidMeeting()
    return if (isNull(key)) null else read()
}
internal fun parseMeeting(value: JSONObject): ManagedMeeting {
    val created = value.meetingTime("createdAt"); val expires = value.meetingTime("expiresAt")
    val ended = value.nullable("endedAt") { value.meetingTime("endedAt") }
    val confirmed = value.nullable("controlConfirmedAt") { value.meetingTime("controlConfirmedAt") }
    if (expires <= created || expires - created > 86_401_000 || (confirmed != null && ended == null)) invalidMeeting()
    return ManagedMeeting(value.uuid("id"), value.uuid("conversationId"), value.nullable("createdBy") { value.text("createdBy", max = 128) },
        created, expires, ended, confirmed)
}
internal fun parseCurrentMeeting(value: JSONObject, scope: MessageScope, conversationId: String): CurrentMeeting {
    val meeting = value.nullable("meeting") { parseMeeting(value.optJSONObject("meeting") ?: invalidMeeting()) }
    if (meeting != null && meeting.conversationId != conversationId) invalidMeeting()
    return CurrentMeeting(scope, value.flag("available"), meeting)
}
internal fun parseMeetingDetails(value: JSONObject, scope: MessageScope, id: String, now: Long = System.currentTimeMillis()): MeetingDetails {
    val meeting = parseMeeting(value.optJSONObject("meeting") ?: invalidMeeting())
    val available = value.flag("available"); val canJoin = value.flag("canJoin")
    val sessions = value.objects("sessions", 100).map { s ->
        val revoked = s.nullable("revokedAt") { s.meetingTime("revokedAt") }
        val confirmed = s.nullable("controlConfirmedAt") { s.meetingTime("controlConfirmedAt") }
        if (confirmed != null && revoked == null) invalidMeeting()
        MeetingSession(s.uuid("id"), s.text("userId", max = 128), s.nullable("name") { s.text("name", max = 160) },
            s.nullable("deviceId") { s.uuid("deviceId") }, revoked, s.nullable("admittedAt") { s.meetingTime("admittedAt") }, confirmed)
    }
    if (meeting.id != id || (canJoin && (!available || meeting.endedAt != null || meeting.expiresAt <= now))
        || sessions.map { it.id }.toSet().size != sessions.size) invalidMeeting()
    return MeetingDetails(scope, available, canJoin, value.text("title", max = 160),
        value.nullable("hostName") { value.text("hostName", max = 160) }, meeting, sessions)
}
private fun JSONObject.keysSet() = keys().asSequence().toSet()
private fun JSONObject.seconds(key: String): Long {
    val number = opt(key) as? Number ?: invalidMeeting()
    val seconds = number.toLong()
    if (number.toDouble() != seconds.toDouble() || seconds !in 0..9_000_000_000_000L) invalidMeeting()
    return seconds
}
internal fun parseMeetingGrant(value: JSONObject, organisationId: String, meetingId: String, sessionId: String,
    allowLocal: Boolean, now: Long = System.currentTimeMillis()): MeetingGrant {
    value.integer("schemaVersion", 1..1)
    val identity = value.text("identity", max = 128); val expiry = value.meetingTime("expiresAt")
    val url = value.text("url", max = 2048); val uri = runCatching { URI(url) }.getOrElse { invalidMeeting() }
    val local = allowLocal && uri.scheme == "ws" && uri.host in setOf("localhost", "127.0.0.1", "[::1]")
    if ((uri.scheme != "wss" && !local) || uri.host.isNullOrEmpty() || uri.rawUserInfo != null
        || uri.rawPath !in setOf("", "/") || uri.rawQuery != null || uri.rawFragment != null
        || uri.port < -1 || uri.port == 0 || uri.port > 65535 || value.uuid("organisationId") != organisationId
        || value.uuid("meetingId") != meetingId || value.uuid("sessionId") != sessionId || identity != "sipper:$sessionId"
        || expiry <= now || expiry > now + 120_000) invalidMeeting()
    val token = value.text("token", max = 8192)
    val parts = token.split('.')
    if (parts.size != 3 || parts.any { it.isEmpty() || !it.matches(Regex("[A-Za-z0-9_-]+")) }) invalidMeeting()
    val decoded = parts.map { runCatching { Base64.getUrlDecoder().decode(it) }.getOrElse { invalidMeeting() } }
    val header = runCatching { JSONObject(decoded[0].toString(Charsets.UTF_8)) }.getOrElse { invalidMeeting() }
    val claims = runCatching { JSONObject(decoded[1].toString(Charsets.UTF_8)) }.getOrElse { invalidMeeting() }
    val video = claims.optJSONObject("video") ?: invalidMeeting()
    val sourceArray = video.optJSONArray("canPublishSources") ?: invalidMeeting()
    val sources = List(sourceArray.length()) { sourceArray.opt(it) as? String ?: invalidMeeting() }
    val exp = claims.seconds("exp") * 1000; val nbf = claims.seconds("nbf") * 1000
    if (decoded[2].size != 32 || header.text("alg") != "HS256" || (header.has("typ") && header.text("typ") != "JWT")
        || !setOf("alg", "typ").containsAll(header.keysSet())
        || !setOf("iss", "sub", "name", "metadata", "attributes", "exp", "nbf", "video").containsAll(claims.keysSet())
        || video.keysSet() != setOf("room", "roomJoin", "canSubscribe", "canPublish", "canPublishSources", "canPublishData", "canUpdateOwnMetadata")
        || claims.text("sub") != identity || claims.text("iss", max = 128).isBlank() || video.text("room") != "sipper-$meetingId"
        || !video.flag("roomJoin") || !video.flag("canSubscribe") || !video.flag("canPublish") || video.flag("canPublishData") || video.flag("canUpdateOwnMetadata")
        || sources.size != 4 || sources.toSet() != setOf("microphone", "camera", "screen_share", "screen_share_audio")
        || exp <= now || exp > now + 120_000 || nbf > now + 30_000 || kotlin.math.abs(exp - expiry) > 1500) invalidMeeting()
    // Binding and privilege checks only. The authenticated portal supplies the grant;
    // the Sipper proxy and SFU verify its signature. No token is persisted or logged.
    return MeetingGrant(meetingId, sessionId, identity, url, token, expiry)
}
