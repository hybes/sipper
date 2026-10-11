package com.hybes.sipper

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.time.Instant
import java.util.UUID

class ManagedFailure(val kind: String, message: String) : Exception(message)
internal fun invalidManaged(): Nothing = throw ManagedFailure("invalid_response", "The managed settings could not be verified. Contact your administrator.")
internal fun JSONObject.text(key: String, min: Int = 1, max: Int = 512): String {
    val value = opt(key) as? String ?: invalidManaged()
    if (value.length !in min..max || value.any(Char::isISOControl)) invalidManaged()
    return value
}
internal fun JSONObject.uuid(key: String): String {
    val value = text(key, 36, 36).lowercase()
    if (runCatching { UUID.fromString(value).toString() == value }.getOrDefault(false).not()) invalidManaged()
    return value
}
internal fun JSONObject.flag(key: String): Boolean = opt(key) as? Boolean ?: invalidManaged()
internal fun JSONObject.integer(key: String, range: IntRange): Int {
    val value = opt(key) as? Number ?: invalidManaged()
    if (value.toDouble() != value.toInt().toDouble() || value.toInt() !in range) invalidManaged()
    return value.toInt()
}
internal fun JSONObject.objects(key: String, maximum: Int): List<JSONObject> {
    val value = opt(key) as? JSONArray ?: invalidManaged()
    if (value.length() > maximum) invalidManaged()
    return List(value.length()) { value.opt(it) as? JSONObject ?: invalidManaged() }
}

internal fun managedOrigin(raw: String, development: Boolean): String {
    val uri = runCatching { URI(raw) }.getOrElse { invalidManaged() }
    val local = development && uri.scheme == "http" && uri.host in setOf("localhost", "127.0.0.1", "10.0.2.2", "[::1]")
    if ((uri.scheme != "https" && !local) || uri.host == null || uri.rawUserInfo != null ||
        uri.rawQuery != null || uri.rawFragment != null || uri.rawPath !in setOf("", "/") ||
        uri.port < -1 || uri.port == 0 || uri.port > 65535) invalidManaged()
    return URI(uri.scheme, null, uri.host.lowercase(), uri.port, null, null, null).toString()
}

enum class ManagedAvailability(val value: String, val label: String) {
    UNSET("unset", "Not set"), AVAILABLE("available", "Available"), AWAY("away", "Away"), BUSY("busy", "Busy")
}
data class ManagedOrganisation(val id: String, val name: String, val status: String, val licensed: Boolean, val doNotDisturb: Boolean? = null, val availability: ManagedAvailability? = null)
data class ManagedIdentity(val id: String, val email: String)
data class ManagedConnection(val organisationId: String, val deviceId: String, val name: String, val configured: Boolean, val expiresAt: Long?)
data class ManagedStatus(val signedIn: Boolean = false, val signingIn: Boolean = false, val busy: Boolean = false,
    val identity: ManagedIdentity? = null, val organisations: List<ManagedOrganisation> = emptyList(),
    val connections: List<ManagedConnection> = emptyList(), val error: String? = null)

internal fun parseOrganisation(value: JSONObject): ManagedOrganisation = ManagedOrganisation(
    value.uuid("id"), value.text("name", max = 160), value.text("status").also {
        if (it !in setOf("active", "suspended")) invalidManaged()
    }, value.flag("licensed"), if (value.has("doNotDisturb")) value.flag("doNotDisturb") else null,
    if (value.has("availability")) ManagedAvailability.entries.find { it.value == value.text("availability") } ?: invalidManaged() else null)

internal fun parseIdentity(value: JSONObject): Pair<ManagedIdentity, List<ManagedOrganisation>> {
    val user = value.optJSONObject("user") ?: invalidManaged()
    val identity = ManagedIdentity(user.text("id", max = 128), user.text("email", max = 320))
    if (!identity.email.matches(Regex("[^\\s@]+@[^\\s@]+\\.[^\\s@]+"))) invalidManaged()
    val organisations = value.objects("organisations", 10000).map(::parseOrganisation)
    if (organisations.map { it.id }.toSet().size != organisations.size) invalidManaged()
    return identity to organisations
}

internal class ManagedConfiguration(val raw: JSONObject, val organisationId: String, val deviceId: String,
    val revision: String, val expiresAt: Long, val accounts: List<SipAccount>, val remoteIds: List<String>) {
    override fun toString() = "ManagedConfiguration(deviceId=$deviceId)"
}

internal fun parseConfiguration(value: JSONObject, origin: String, organisationId: String, deviceId: String,
    now: Long = System.currentTimeMillis(), acceptExpired: Boolean = false): ManagedConfiguration {
    value.integer("schemaVersion", 1..1)
    val organisation = value.optJSONObject("organisation") ?: invalidManaged()
    organisation.text("name", max = 160)
    if (organisation.uuid("id") != organisationId || value.uuid("deviceId") != deviceId) invalidManaged()
    val revision = value.text("revision", 64, 64)
    if (!revision.matches(Regex("[a-f0-9]{64}"))) invalidManaged()
    val expiresAt = runCatching { Instant.parse(value.text("expiresAt")).toEpochMilli() }.getOrElse { invalidManaged() }
    if ((!acceptExpired && expiresAt <= now) || expiresAt > now + 86_460_000) invalidManaged()
    val remoteIds = mutableListOf<String>()
    val accounts = value.objects("accounts", 100).map { raw ->
        val id = raw.uuid("id"); remoteIds.add(id)
        val mode = raw.text("mode")
        if (mode !in setOf("direct", "gateway")) invalidManaged()
        raw.integer("revision", 1..Int.MAX_VALUE)
        val settings = raw.optJSONObject("settings") ?: invalidManaged()
        val password = raw.opt("password") as? String ?: invalidManaged()
        if (password.length !in 1..1024) invalidManaged()
        SipAccount(id = UUID.nameUUIDFromBytes("sipper-managed:$origin:$deviceId:$id".toByteArray()).toString(),
            label = raw.text("label", max = 160), username = settings.text("username"), password = password,
            domain = settings.text("domain", max = 253), server = settings.text("server", max = 253),
            port = if (settings.isNull("port")) null else settings.integer("port", 1..65535),
            transport = settings.text("transport"), authUsername = settings.text("authUsername", min = 0),
            displayName = settings.text("displayName", min = 0, max = 160), srtp = settings.text("srtp"),
            voicemailNumber = settings.text("voicemailNumber", min = 0), stunServer = settings.text("stunServer", min = 0, max = 253),
            ice = settings.flag("useICE"), managedDeviceId = deviceId, managedMode = mode, expiresAt = expiresAt,
            managedDoNotDisturb = if (raw.has("doNotDisturb")) raw.flag("doNotDisturb") else false,
        ).also { try { it.validate() } catch (_: IllegalArgumentException) { invalidManaged() } }
    }
    if (remoteIds.toSet().size != remoteIds.size) invalidManaged()
    return ManagedConfiguration(value, organisationId, deviceId, revision, expiresAt, accounts, remoteIds)
}
