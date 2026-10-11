package com.hybes.sipper

import org.json.JSONObject
import java.time.Instant
import java.util.UUID

internal data class IncomingCallPush(val deviceId: String, val callId: String, val expiresAt: Long)

/** A push is a wake hint, never authority to display a caller or accept a call. */
internal fun incomingCallPush(data: Map<String, String>, now: Long = System.currentTimeMillis()): IncomingCallPush? {
    if (data.keys != setOf("type", "schemaVersion", "deviceId", "callId", "expiresAt") ||
        data["type"] != "incoming_call" || data["schemaVersion"] != "1" || data.values.any { it.length > 128 }) return null
    val device = canonicalCallId(data.getValue("deviceId")) ?: return null
    val call = canonicalCallId(data.getValue("callId")) ?: return null
    val expiry = runCatching { Instant.parse(data.getValue("expiresAt")).toEpochMilli() }.getOrNull() ?: return null
    if (expiry <= now || expiry > now + 120_000) return null
    return IncomingCallPush(device, call, expiry)
}

internal fun canonicalCallId(value: String): String? = value.lowercase().takeIf {
    it.length == 36 && runCatching { UUID.fromString(it).toString() == it }.getOrDefault(false)
}

/** Read only the dedicated header, never a body/header substring or a folded value. */
internal fun gatewayCallId(message: String): String? {
    if (message.length > 65536) return null
    val end = message.indexOf("\r\n\r\n").takeIf { it >= 0 } ?: return null
    val lines = message.substring(0, end).split("\r\n")
    if (!lines.first().startsWith("INVITE ")) return null
    val matches = lines.indices.filter { lines[it].substringBefore(':').equals("X-Sipper-Call-ID", true) }
    val index = matches.singleOrNull() ?: return null
    if (lines.getOrNull(index + 1)?.firstOrNull()?.let { it == ' ' || it == '\t' } == true) return null
    return canonicalCallId(lines[index].substringAfter(':').trim())
}

internal data class ManagedCallState(val id: String, val configurationId: String, val state: String,
    val claimedByThisDevice: Boolean, val version: Int, val expiresAt: Long, val caller: String?, val callerNumber: String? = null) {
    fun unavailable(now: Long = System.currentTimeMillis()) = state == "ended" ||
        (state in setOf("answering", "answered") && !claimedByThisDevice) ||
        (state in setOf("ringing", "answering") && expiresAt <= now)
}

internal fun parseManagedCall(value: JSONObject, expectedId: String): ManagedCallState {
    if (value.uuid("id") != expectedId) invalidManaged()
    val state = value.text("state").also { if (it !in setOf("ringing", "answering", "answered", "ended")) invalidManaged() }
    var callerNumber: String? = null
    val caller = value.optJSONObject("caller")?.let {
        val name = it.text("name", min = 0, max = 160)
        val number = it.text("number", min = 0, max = 160)
        callerNumber = number
        name.ifBlank { number }.ifBlank { "Unknown caller" }
    }
    if (caller == null && state in setOf("ringing", "answering")) invalidManaged()
    val expiry = runCatching { Instant.parse(value.text("expiresAt")).toEpochMilli() }.getOrElse { invalidManaged() }
    return ManagedCallState(expectedId, value.uuid("configurationId"), state, value.flag("claimedByThisDevice"),
        value.integer("version", 1..Int.MAX_VALUE), expiry, caller, callerNumber)
}
