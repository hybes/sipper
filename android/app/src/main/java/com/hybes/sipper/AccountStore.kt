package com.hybes.sipper

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Device-bound AES-GCM data. A failed write leaves the previous account list intact. */
class SecureVault(context: Context, private val name: String, private val maximumBytes: Int = 1_000_000) {
    init { require(maximumBytes in 1..16_000_000) }
    private val file = AtomicFile(File(context.noBackupFilesDir, "$name.enc"))
    // Android 8–10 can leave the last committed contents in this recovery file.
    private val backup = File(context.noBackupFilesDir, "$name.enc.bak")
    private val alias = "${context.packageName}.$name"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        check(!file.baseFile.exists() && !backup.exists()) { "The encryption key is unavailable. Stored settings have been preserved." }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun read(): ByteArray? {
        // Let AtomicFile recover a committed write before deciding the store is empty.
        val stream = try { file.openRead() } catch (error: FileNotFoundException) {
            if (file.baseFile.exists() || backup.exists()) throw error
            return null
        }
        val bytes = stream.use {
            require(it.channel.size() in 29..maximumBytes.toLong() + 29) { "Stored settings are damaged." }
            it.readBytes()
        }
        require(bytes[0] == 1.toByte()) { "Unsupported stored settings." }
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
            updateAAD(alias.toByteArray())
            doFinal(bytes, 13, bytes.size - 13)
        }
    }
    @Synchronized fun write(bytes: ByteArray) {
        require(bytes.size <= maximumBytes) { "Too much data to store." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key()); updateAAD(alias.toByteArray())
        }
        val output = byteArrayOf(1) + cipher.iv + cipher.doFinal(bytes)
        val stream = file.startWrite()
        try { stream.write(output); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }
    @Synchronized fun clear() {
        file.delete()
        check(!file.baseFile.exists() && !backup.exists()) { "Saved managed access could not be removed from this device." }
    }
}

class AccountStore(private val vault: SecureVault) {
    private var revision = 0
    var accounts: List<SipAccount> = read()
        private set
    private fun read(): List<SipAccount> {
        val bytes = vault.read() ?: return emptyList()
        return try {
            val array = JSONArray(bytes.toString(Charsets.UTF_8))
            require(array.length() <= 16)
            List(array.length()) { index -> array.getJSONObject(index).run {
                SipAccount(id = getString("id"), label = getString("label"), username = getString("username"),
                    password = getString("password"), domain = getString("domain"), server = getString("server"),
                    port = if (isNull("port")) null else getInt("port"), transport = getString("transport"),
                    authUsername = getString("authUsername"), displayName = getString("displayName"),
                    voicemailNumber = optString("voicemailNumber", "*97"), stunServer = optString("stunServer", ""),
                    srtp = getString("srtp"), ice = getBoolean("ice"), enabled = getBoolean("enabled"))
                    .also { it.validate(personal = true) }
            } }.also { require(it.map(SipAccount::id).toSet().size == it.size) }
        } finally { bytes.fill(0) }
    }
    @Synchronized fun save(account: SipAccount) {
        account.validate(personal = true)
        val next = accounts.filter { it.id != account.id } + account
        require(next.size <= 16) { "You can save up to 16 personal accounts." }
        commit(next)
    }
    @Synchronized fun remove(id: String) = commit(accounts.filter { it.id != id })
    @Synchronized fun reviewImport(link: String): AccountImport {
        val request = parseAccountImport(link)
        fun identity(account: SipAccount) = account.username to account.domain.lowercase()
        val counts = request.candidates.groupingBy { identity(it.account) }.eachCount()
        return request.copy(revision = revision, candidates = request.candidates.map { candidate ->
            val draft = candidate.account
            val matches = accounts.filter { identity(it) == identity(draft) }
            if (counts[identity(draft)]!! > 1 || matches.size > 1) candidate.copy(error = "This SIP account appears more than once. Import one copy at a time.")
            else matches.singleOrNull()?.let { existing ->
                candidate.copy(updating = true, account = existing.copy(
                    label = existing.label.ifBlank { draft.label }, displayName = draft.displayName.ifBlank { existing.displayName },
                    authUsername = draft.authUsername, password = draft.password, server = draft.server,
                    port = draft.port, transport = draft.transport, voicemailNumber = draft.voicemailNumber))
            } ?: candidate
        })
    }
    @Synchronized fun importAccounts(review: AccountImport, selected: Set<String>, activeAccounts: Set<String>) {
        check(review.revision == revision) { "Accounts changed while you were reviewing. Cancel and open the import again." }
        val chosen = review.candidates.filter { it.account.id in selected }
        require(chosen.isNotEmpty() && chosen.size == selected.size && chosen.all { it.error == null }) { "Select at least one valid account." }
        check(chosen.none { it.account.id in activeAccounts }) { "Finish this account’s call before replacing its settings." }
        chosen.forEach { it.account.validate(personal = true) }
        val next = accounts.filter { it.id !in selected } + chosen.map { it.account }
        require(next.size <= 16) { "You can save up to 16 personal accounts." }
        commit(next)
    }
    private fun commit(next: List<SipAccount>) {
        val array = JSONArray()
        next.forEach { a -> array.put(JSONObject().put("id", a.id).put("label", a.label)
            .put("username", a.username).put("password", a.password).put("domain", a.domain)
            .put("server", a.server).put("port", a.port ?: JSONObject.NULL).put("transport", a.transport)
            .put("authUsername", a.authUsername).put("displayName", a.displayName)
            .put("voicemailNumber", a.voicemailNumber).put("stunServer", a.stunServer)
            .put("srtp", a.srtp).put("ice", a.ice).put("enabled", a.enabled)) }
        val bytes = array.toString().toByteArray()
        try { vault.write(bytes); accounts = next; revision += 1 } finally { bytes.fill(0) }
    }
}
