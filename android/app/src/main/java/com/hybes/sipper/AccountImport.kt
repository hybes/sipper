package com.hybes.sipper

import org.json.JSONObject
import java.net.URI
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Base64
import java.util.UUID
import android.util.JsonReader
import android.util.JsonToken
import java.io.StringReader

internal const val MAX_IMPORT_BYTES = 512 * 1024
data class ImportedAccount(val account: SipAccount, val error: String? = null, val updating: Boolean = false)
data class AccountImport(val candidates: List<ImportedAccount>, val revision: Int = 0, val id: String = UUID.randomUUID().toString())

/** The existing desktop wire format. Passwords stay verbatim; imported IDs/ownership are ignored. */
internal fun parseAccountImport(link: String): AccountImport {
    val invalid = "Enter a valid Sipper account import link (version 1, up to 512 KiB)."
    try {
        require(link.toByteArray().size <= MAX_IMPORT_BYTES * 2 + 1024)
        val url = URI(link.trim())
        require(url.scheme.equals("sipper", true) && (url.host ?: url.path.trim('/')).equals("add-accounts", true))
        val payload = url.rawQuery.orEmpty().split('&').map { it.split('=', limit = 2) }.firstOrNull {
            URLDecoder.decode(it[0], "UTF-8") == "payload"
        }?.getOrNull(1)?.let { URLDecoder.decode(it, "UTF-8") } ?: error("Missing payload")
        require(payload.length <= MAX_IMPORT_BYTES * 2 && payload.matches(Regex("[A-Za-z0-9_-]+={0,2}")))
        val bytes = Base64.getUrlDecoder().decode(payload)
        require(bytes.size <= MAX_IMPORT_BYTES)
        val json = try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString()
        } finally { bytes.fill(0) }
        // Bound nesting before JSONObject's recursive parser sees untrusted input.
        JsonReader(StringReader(json)).use { reader ->
            var depth = 0
            while (true) when (reader.peek()) {
                JsonToken.BEGIN_OBJECT -> { require(++depth <= 32); reader.beginObject() }
                JsonToken.BEGIN_ARRAY -> { require(++depth <= 32); reader.beginArray() }
                JsonToken.END_OBJECT -> { reader.endObject(); depth-- }
                JsonToken.END_ARRAY -> { reader.endArray(); depth-- }
                JsonToken.NAME -> reader.nextName()
                JsonToken.STRING, JsonToken.NUMBER -> reader.nextString()
                JsonToken.BOOLEAN -> reader.nextBoolean()
                JsonToken.NULL -> reader.nextNull()
                JsonToken.END_DOCUMENT -> break
                else -> error("Invalid JSON")
            }
        }
        val document = JSONObject(json)
        require(document.get("version") == 1)
        val values = document.getJSONArray("accounts")
        require(values.length() > 0)
        if (values.length() > 16) throw IllegalArgumentException("Import up to 16 accounts at a time.")
        val candidates = List(values.length()) { index ->
            val value = values.getJSONObject(index)
            fun text(name: String, fallback: String = ""): String {
                if (value.isNull(name)) return fallback
                val raw = value.get(name) as? String ?: error("Invalid field")
                return if (name == "password") raw else raw.trim()
            }
            val domain = text("domain")
            val account = SipAccount(label = text("label"), username = text("username"), password = text("password"), domain = domain,
                server = text("server").ifBlank { domain }, port = if (value.isNull("port")) null else value.get("port") as? Int ?: error("Invalid port"),
                transport = text("transport").ifBlank { "udp" }.lowercase(), authUsername = text("authUsername"),
                displayName = text("displayName"), voicemailNumber = text("voicemailNumber").ifBlank { "*97" }, srtp = "disabled", ice = false)
            val error = runCatching {
                require(account.password.isNotBlank()) { "Password is missing." }
                account.validate(personal = true)
            }.exceptionOrNull()?.message
            ImportedAccount(account, error)
        }
        return AccountImport(candidates)
    } catch (failure: Exception) {
        // JSON/URI exceptions may contain the credential-bearing input.
        throw IllegalArgumentException(if (failure.message == "Import up to 16 accounts at a time.") failure.message else invalid)
    }
}
