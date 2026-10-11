package com.hybes.sipper

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

data class DirectoryNumber(val label: String, val number: String)
data class DirectoryContact(val id: String, val name: String, val company: String,
    val numbers: List<DirectoryNumber>, val revision: Int, val updatedAt: String) {
    fun matches(query: String): Boolean {
        val search = query.trim()
        val number = search.filter { it in "+0123456789*#" }
        return name.contains(search, true) || company.contains(search, true) || numbers.any {
            it.number.contains(search) || (number.isNotEmpty() && search.all { c -> c in "+0123456789*#() .-" } && it.number.contains(number))
        }
    }
}
data class ManagedDirectory(val organisationId: String, val organisationName: String, val deviceId: String,
    val revision: String, val expiresAt: Long, val contacts: List<DirectoryContact>) {
    internal fun json() = JSONObject().put("organisation", JSONObject().put("id", organisationId).put("name", organisationName))
        .put("deviceId", deviceId).put("revision", revision).put("expiresAt", Instant.ofEpochMilli(expiresAt).toString())
        .put("contacts", JSONArray(contacts.map { contact -> JSONObject().put("id", contact.id).put("name", contact.name)
            .put("company", contact.company).put("revision", contact.revision).put("updatedAt", contact.updatedAt)
            .put("numbers", JSONArray(contact.numbers.map { JSONObject().put("label", it.label).put("number", it.number) })) }))
}

// Voluntary preferences stay in the open contact view, never in the encrypted directory archive.
data class DirectoryActivity(val state: String, val source: String, val observedAt: Long) {
    val label: String get() = "${when (state) { "in_call" -> "In a call"; "on_hold" -> "On hold"; "ringing" -> "Ringing"; else -> "Dialling" }} · ${if (source == "device") "App report" else "Gateway report"}"
}
data class DirectoryContactStatus(val contactId: String, val availability: ManagedAvailability?, val doNotDisturb: Boolean?, val activity: DirectoryActivity? = null)
data class DirectoryStatus(val expiresAt: Long, val contacts: List<DirectoryContactStatus>) {
    fun label(contactId: String, now: Long = System.currentTimeMillis()): String {
        val contact = contacts.find { it.contactId == contactId }
        if (expiresAt <= now || contact == null) return "Status unavailable"
        val labels = listOfNotNull(contact.availability?.let { if (it == ManagedAvailability.UNSET) "Availability not set" else it.label },
            if (contact.doNotDisturb == true) "Do Not Disturb" else null, contact.activity?.label)
        return labels.joinToString(" · ").ifEmpty { "Status unavailable" }
    }
}
internal fun parseDirectoryStatus(value: JSONObject, directory: ManagedDirectory, contactIds: List<String>,
    now: Long = System.currentTimeMillis()): DirectoryStatus {
    if (value.uuid("deviceId") != directory.deviceId || value.uuid("organisationId") != directory.organisationId
        || value.uuid("revision") != directory.revision) invalidManaged()
    val expiry = runCatching { Instant.parse(value.text("expiresAt")).toEpochMilli() }.getOrElse { invalidManaged() }
    if (expiry <= now || expiry > now + 60_000) invalidManaged()
    val contacts = value.objects("contacts", 100).map {
        if (!it.has("availability") || !it.has("doNotDisturb") || it.isNull("availability") != it.isNull("doNotDisturb")) invalidManaged()
        val activity = if (it.isNull("activity")) null else {
            val raw = it.optJSONObject("activity") ?: invalidManaged()
            val state = raw.text("state").also { if (it !in setOf("in_call", "on_hold", "ringing", "dialling")) invalidManaged() }
            val source = raw.text("source").also { if (it !in setOf("device", "gateway")) invalidManaged() }
            val observedAt = runCatching { Instant.parse(raw.text("observedAt")).toEpochMilli() }.getOrElse { invalidManaged() }
            if (observedAt > now + 60_000 || observedAt <= now - 180_000 || expiry > observedAt + 180_000) invalidManaged()
            DirectoryActivity(state, source, observedAt)
        }
        DirectoryContactStatus(it.uuid("contactId"), if (it.isNull("availability")) null else
            ManagedAvailability.entries.find { availability -> availability.value == it.text("availability") } ?: invalidManaged(),
            if (it.isNull("doNotDisturb")) null else it.flag("doNotDisturb"), activity)
    }
    if (contacts.size != contactIds.size || contacts.map { it.contactId }.toSet() != contactIds.toSet()) invalidManaged()
    return DirectoryStatus(minOf(expiry, now + 30_000), contacts)
}
internal fun parseDirectory(value: JSONObject, organisationId: String, deviceId: String,
    maximum: Int = 100, acceptExpired: Boolean = false, now: Long = System.currentTimeMillis()): ManagedDirectory {
    val organisation = value.optJSONObject("organisation") ?: invalidManaged()
    if (organisation.uuid("id") != organisationId || value.uuid("deviceId") != deviceId) invalidManaged()
    val expiresAt = runCatching { Instant.parse(value.text("expiresAt")).toEpochMilli() }.getOrElse { invalidManaged() }
    if ((!acceptExpired && expiresAt <= now) || expiresAt > now + 86_460_000) invalidManaged()
    fun JSONObject.label(key: String, min: Int = 1, max: Int = 160) = text(key, min, max).also { if (it != it.trim()) invalidManaged() }
    val contacts = value.objects("contacts", maximum).map { contact ->
        val numbers = contact.objects("numbers", 5).map {
            DirectoryNumber(it.label("label", max = 32), it.text("number", max = 65).also { number ->
                if (!number.matches(Regex("\\+?[0-9*#]{1,64}"))) invalidManaged()
            })
        }
        if (numbers.isEmpty() || numbers.map { it.number }.toSet().size != numbers.size) invalidManaged()
        val updatedAt = contact.text("updatedAt").also { if (runCatching { Instant.parse(it) }.isFailure) invalidManaged() }
        DirectoryContact(contact.uuid("id"), contact.label("name"), contact.label("company", min = 0), numbers,
            contact.integer("revision", 1..Int.MAX_VALUE), updatedAt)
    }
    if (contacts.map { it.id }.toSet().size != contacts.size) invalidManaged()
    val directory = ManagedDirectory(organisationId, organisation.text("name", max = 160), deviceId, value.uuid("revision"), expiresAt, contacts)
    if (directoryTextSize(contacts) > 8_000_000) invalidManaged()
    return directory
}
internal fun directoryTextSize(contacts: List<DirectoryContact>) = contacts.sumOf { contact ->
    (contact.name + contact.company).toByteArray().size + contact.numbers.sumOf { (it.label + it.number).toByteArray().size }
}

internal fun directoryAccount(accounts: List<SipAccount>, accountId: String, deviceId: String): SipAccount =
    accounts.find { it.id == accountId && it.managedDeviceId == deviceId && it.usable() }
        ?: throw ManagedFailure("directory_account_unavailable", "Choose a current calling account for this customer.")
