package com.hybes.sipper

import org.json.JSONObject
import java.time.Instant

internal data class MessageNotification(val deviceId: String, val conversationId: String, val expiresAt: Long)
internal fun messageNotification(data: Map<String, String>, now: Long = System.currentTimeMillis(), forRouting: Boolean = false): MessageNotification? {
    if (data.keys != setOf("type", "schemaVersion", "deviceId", "conversationId", "expiresAt") || data.values.any { it.length > 128 }
        || data["type"] != "message" || data["schemaVersion"] != "1") return null
    val device = data["deviceId"]?.takeIf { canonicalCallId(it) == it } ?: return null
    val conversation = data["conversationId"]?.takeIf { canonicalCallId(it) == it } ?: return null
    val expiry = runCatching { Instant.parse(data["expiresAt"]).toEpochMilli() }.getOrNull() ?: return null
    if (expiry > now + 300_000 || (!forRouting && expiry <= now)) return null
    return MessageNotification(device, conversation, expiry)
}

// No JSON encoder or archive: message pages and bodies belong only to the open view.
data class MessageScope(val organisationId: String, val organisationName: String, val deviceId: String,
    val userId: String, val expiresAt: Long, val retentionDays: Int)
data class MessagePerson(val id: String, val name: String)
data class MessageParticipant(val id: String, val name: String, val lastReadSequence: String, val joinedSequence: String = "0")
data class ManagedConversation(val id: String, val kind: String, val title: String, val createdAt: Long,
    val updatedAt: Long, val participants: List<MessageParticipant>, val unread: Int, val lastSequence: String,
    val revision: String? = null, val ownerId: String? = null)
data class ManagedTextMessage(val id: String, val sequence: String, val senderId: String?, val senderName: String,
    val text: String, val createdAt: Long) {
    override fun toString() = "ManagedTextMessage(id=$id)"
}
data class MessagePeople(val scope: MessageScope, val people: List<MessagePerson>, val nextCursor: String?)
data class ConversationPage(val scope: MessageScope, val conversations: List<ManagedConversation>, val nextCursor: String?)
data class MessagePage(val scope: MessageScope, val conversation: ManagedConversation, val messages: List<ManagedTextMessage>, val nextCursor: String?)

internal fun invalidMessages(): Nothing = throw ManagedFailure("invalid_messages", "Messages could not be verified. Refresh and try again.")
internal fun invalidMessageInput(): Nothing = throw ManagedFailure("invalid_message_input", "Check the message and selected people.")
internal fun messageSequence(value: String, positive: Boolean = false): Long? =
    value.takeIf { it.matches(Regex("0|[1-9][0-9]{0,18}")) }?.toLongOrNull()?.takeIf { !positive || it > 0 }
internal fun validMessageText(value: String): Boolean = value.length in 1..4096 && value.isNotBlank()
    && value.none { it.isISOControl() && it !in "\t\n\r" }
internal fun messageCursor(value: String): Boolean = value.length in 1..512 && value.matches(Regex("[A-Za-z0-9_-]+"))
private fun JSONObject.instant(key: String): Long = runCatching { Instant.parse(text(key)).toEpochMilli() }.getOrElse { invalidMessages() }
private fun JSONObject.sequence(key: String, positive: Boolean = false): String = text(key, max = 19).also {
    if (messageSequence(it, positive) == null) invalidMessages()
}
private fun JSONObject.cursor(key: String, valid: (String) -> Boolean): String? {
    if (!has(key)) invalidMessages()
    return if (isNull(key)) null else (opt(key) as? String ?: invalidMessages()).also { if (!valid(it)) invalidMessages() }
}
internal fun parseMessageScope(value: JSONObject, organisationId: String, deviceId: String, userId: String,
    now: Long = System.currentTimeMillis()): MessageScope {
    value.integer("schemaVersion", 1..1)
    val org = value.optJSONObject("organisation") ?: invalidMessages()
    val expiry = value.instant("expiresAt")
    if (org.uuid("id") != organisationId || value.uuid("deviceId") != deviceId || value.text("userId", max = 128) != userId
        || expiry <= now || expiry > now + 60_000) invalidMessages()
    return MessageScope(organisationId, org.text("name", max = 160), deviceId, userId, minOf(expiry, now + 30_000), value.integer("retentionDays", 1..3650))
}
internal fun parseConversation(value: JSONObject, userId: String): ManagedConversation {
    val kind = value.text("kind").also { if (it !in setOf("direct", "group")) invalidMessages() }
    val people = value.objects("participants", 20).map {
        MessageParticipant(it.text("id", max = 128), it.text("name", max = 160), it.sequence("lastReadSequence"), if (it.has("joinedSequence")) it.sequence("joinedSequence") else "0")
    }
    val created = value.instant("createdAt")
    val updated = value.instant("updatedAt")
    val last = value.sequence("lastSequence")
    val revision = if (value.has("revision")) value.sequence("revision", true) else null
    val owner = if (value.has("ownerId") && !value.isNull("ownerId")) value.text("ownerId", max = 128) else null
    if (people.isEmpty() || (kind == "direct" && people.size > 2) || people.map { it.id }.toSet().size != people.size
        || people.none { it.id == userId } || updated < created
        || people.any { it.joinedSequence.toLong() > last.toLong() || it.lastReadSequence.toLong() < it.joinedSequence.toLong() }
        || (if (kind == "direct" || revision == null) owner != null else people.none { it.id == owner })) invalidMessages()
    return ManagedConversation(value.uuid("id"), kind, value.text("title", max = 160), created, updated, people,
        value.integer("unread", 0..Int.MAX_VALUE), last, revision, owner)
}
internal fun parseTextMessage(value: JSONObject): ManagedTextMessage {
    val text = value.opt("text") as? String ?: invalidMessages()
    if (!validMessageText(text) || !value.has("senderId")) invalidMessages()
    return ManagedTextMessage(value.uuid("id"), value.sequence("sequence", true), if (value.isNull("senderId")) null else value.text("senderId", max = 128),
        value.text("senderName", max = 160), text, value.instant("createdAt"))
}
internal fun parseMessagePeople(value: JSONObject, scope: MessageScope): MessagePeople {
    val people = value.objects("people", 100).map { MessagePerson(it.text("id", max = 128), it.text("name", max = 160)) }
    val cursor = value.cursor("nextCursor") { it.length in 1..128 && it.none(Char::isISOControl) }
    if (people.map { it.id }.toSet().size != people.size || people.any { it.id == scope.userId }
        || (cursor != null && (people.size != 100 || cursor != people.last().id))) invalidMessages()
    return MessagePeople(scope, people, cursor)
}
internal fun parseConversationPage(value: JSONObject, scope: MessageScope): ConversationPage {
    val conversations = value.objects("conversations", 100).map { parseConversation(it, scope.userId) }
    val cursor = value.cursor("nextCursor", ::messageCursor)
    if (conversations.map { it.id }.toSet().size != conversations.size || (cursor != null && conversations.size != 100)) invalidMessages()
    return ConversationPage(scope, conversations, cursor)
}
internal fun parseMessagePage(value: JSONObject, scope: MessageScope, id: String, before: String?, after: String?): MessagePage {
    val conversation = parseConversation(value.optJSONObject("conversation") ?: invalidMessages(), scope.userId)
    val messages = value.objects("messages", 100).map(::parseTextMessage)
    val cursor = value.cursor("nextCursor") { messageSequence(it, true) != null }
    if (conversation.id != id || messages.map { it.id }.toSet().size != messages.size
        || messages.any { it.sequence.toLong() <= conversation.participants.first { p -> p.id == scope.userId }.joinedSequence.toLong() }
        || messages.zipWithNext().any { (a, b) -> a.sequence.toLong() >= b.sequence.toLong() }
        || messages.any { (before != null && it.sequence.toLong() >= before.toLong()) || (after != null && it.sequence.toLong() <= after.toLong()) }
        || (cursor != null && (messages.size != 100 || cursor != (if (after != null) messages.last().sequence else messages.first().sequence)))) invalidMessages()
    return MessagePage(scope, conversation, messages, cursor)
}
