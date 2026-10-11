package com.hybes.sipper

import java.util.UUID

data class SipAccount(
    val id: String = UUID.randomUUID().toString(),
    val label: String,
    val username: String,
    val password: String,
    val domain: String,
    val server: String = domain,
    val port: Int? = null,
    val transport: String = "tls",
    val authUsername: String = "",
    val displayName: String = "",
    val voicemailNumber: String = "*97",
    val stunServer: String = "",
    val srtp: String = "required",
    val ice: Boolean = true,
    val enabled: Boolean = true,
    val managedDeviceId: String? = null,
    val managedMode: String = "direct",
    val managedDoNotDisturb: Boolean = false,
    val expiresAt: Long? = null,
) {
    override fun toString() = "SipAccount(id=$id, managed=${managedDeviceId != null})"
    val title: String get() = label.ifBlank { username }
    val host: String get() = server.ifBlank { domain }
    fun usable(now: Long = System.currentTimeMillis()) = enabled && (expiresAt == null || expiresAt > now)
    fun validate(personal: Boolean = false) {
        require(runCatching { UUID.fromString(id).toString() == id }.getOrDefault(false)) { "Invalid account identifier." }
        require(!personal || (managedDeviceId == null && expiresAt == null)) { "Managed accounts cannot be saved as personal accounts." }
        require(managedMode in setOf("direct", "gateway") && (managedMode != "gateway" || (managedDeviceId != null && transport == "tls" && srtp == "required"))) { "Managed gateway accounts require TLS and encrypted audio." }
        require(!managedDoNotDisturb || managedDeviceId != null) { "A managed calling preference needs a managed account." }
        require((managedDeviceId == null) == (expiresAt == null)) { "Managed settings need an expiry time." }
        require(label.length <= 160 && displayName.length <= 160 && listOf(label, displayName, authUsername).none { value -> value.any(Char::isISOControl) }) { "Remove control characters from account details." }
        require(username.matches(Regex("[a-zA-Z0-9+_.!~*'%\\-]{1,256}")) && authUsername.length <= 256) { "Enter a valid SIP username." }
        require(listOf(domain, host).all { it.length in 1..253 && it.matches(Regex("[a-zA-Z0-9.:\\[\\]\\-]+")) }) { "Enter a server hostname or IP address, without a URL or spaces." }
        require(port == null || port in 1..65535) { "The port must be between 1 and 65535." }
        require(stunServer.isEmpty() || (stunServer.length <= 253 && stunServer.matches(Regex("[a-zA-Z0-9.:\\[\\]\\-]+")))) { "Enter a STUN hostname or IP address, with an optional port." }
        if (voicemailNumber.isNotEmpty()) dialDestination(voicemailNumber, this)
        require(transport in setOf("udp", "tcp", "tls") && srtp in setOf("required", "optional", "disabled")) { "Unsupported security settings." }
        require(password.toByteArray().size <= 4096 && !password.contains('\u0000')) { "The password is too long or contains an invalid character." }
    }
    fun uriHost(value: String) = if (value.contains(':') && !value.startsWith('[')) "[$value]" else value
    val destinationHost: String get() = uriHost(domain)
    val identityUri: String get() {
        val address = "sip:$username@$destinationHost"
        return if (displayName.isEmpty()) address else "\"${displayName.replace("\\", "\\\\").replace("\"", "\\\"")}\" <$address>"
    }
}

fun dialDestination(raw: String, account: SipAccount): String {
    val input = raw.trim()
    require(input.length in 1..512 && input.none(Char::isISOControl)) { "Enter a phone number or SIP address." }
    require(account.managedMode != "gateway" || (!input.startsWith("sip:") && !input.startsWith("sips:"))) { "Use a phone number or extension with this managed account." }
    if (input.startsWith("sip:") || input.startsWith("sips:")) {
        require(input.matches(Regex("sips?:[a-zA-Z0-9+_.!~*'%\\-]+@[a-zA-Z0-9.:\\[\\]\\-]+(?:;transport=(?:udp|tcp|tls))?"))) { "Enter a valid SIP address." }
        return input
    }
    require(input.matches(Regex("[+0-9*#() .\\-]+"))) { "Enter a phone number or full SIP address." }
    val number = input.filter { it in "+0123456789*#" }
    require(number.any { it in "0123456789*#" } && '+' !in number.drop(1)) { "Enter a valid phone number." }
    require(account.managedMode != "gateway" || number.length <= 128) { "The phone number or extension is too long." }
    return "sip:$number@${account.destinationHost}"
}

data class Registration(val state: String = "unknown", val code: Int? = null)
data class PhoneCall(val id: String, val accountId: String, val remote: String, val incoming: Boolean,
    val state: String, val connected: Boolean = false, val held: Boolean = false, val muted: Boolean = false,
    val gatewayCallId: String? = null, val destination: String? = null,
    val managedDeviceId: String? = null, val accountTitle: String = "",
    val transferring: Boolean = false, val transferStatus: String? = null, val conferenceId: String? = null)

internal val PhoneCall.presentationId: String get() = conferenceId?.let { "conference:$it" } ?: id
internal fun List<PhoneCall>.presentationMembers(id: String): List<PhoneCall> {
    val members = filter { it.state != "Ended" && it.presentationId == id }
    return if (id.startsWith("conference:") && (members.size != 2 || members.any { !it.connected })) emptyList() else members
}

/** Direct SIP can include a display name. Keep only a validated URI for callback. */
internal fun incomingDestination(remote: String, account: SipAccount): String? {
    if (account.managedMode == "gateway" || remote.length > 1024 || remote.any(Char::isISOControl)) return null
    val uri = if ('<' in remote || '>' in remote) {
        if (remote.count { it == '<' } != 1 || remote.count { it == '>' } != 1 ||
            remote.indexOf('<') > remote.indexOf('>') || remote.substringAfter('>').isNotBlank()) return null
        remote.substringAfter('<').substringBefore('>').trim()
    } else remote.trim()
    if (!uri.startsWith("sip:") && !uri.startsWith("sips:")) return null
    return runCatching { dialDestination(uri, account) }.getOrNull()
}
