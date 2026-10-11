package com.hybes.sipper

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import net.openid.appauth.*
import org.json.JSONArray
import org.json.JSONObject

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal fun directCallReport(accounts: List<SipAccount>, remoteIds: List<String>, calls: List<PhoneCall>): JSONArray =
    JSONArray(accounts.mapIndexedNotNull { index, account ->
        if (account.managedDeviceId == null || account.managedMode != "direct") return@mapIndexedNotNull null
        val report = JSONObject().put("accountId", remoteIds[index]).put("ringing", 0).put("dialling", 0).put("connected", 0).put("held", 0)
        for (call in calls.filter { it.accountId == account.id && it.state != "Ended" }) {
            val key = if (call.connected) { if (call.held) "held" else "connected" } else if (call.incoming) "ringing" else "dialling"
            report.put(key, report.getInt(key) + 1)
        }
        report
    })

/** Owned by the main dispatcher. Only immutable, credential-free status reaches the UI. */
class ManagedClient(context: Context, rawOrigin: String = BuildConfig.MANAGED_URL,
    private val vault: SecureVault = SecureVault(context, "managed-session", maximumBytes = 16_000_000),
    private val applyAccounts: suspend (List<SipAccount>) -> Unit,
) {
    val origin = managedOrigin(rawOrigin, BuildConfig.DEBUG)
    private val resource = "$origin/api/client"
    private val callback = Uri.parse(BuildConfig.MANAGED_CALLBACK)
    private val configuration = AuthorizationServiceConfiguration(Uri.parse("$origin/api/auth/oauth2/authorize"), Uri.parse("$origin/api/auth/oauth2/token"))
    private val service = AuthorizationService(context, AppAuthConfiguration.Builder().setConnectionBuilder { uri ->
        // The token endpoint is fixed; never follow a redirect carrying a code or refresh token.
        require(uri.toString() == "$origin/api/auth/oauth2/token")
        connection(uri.toString())
    }.build())
    private val mutableStatus = MutableStateFlow(ManagedStatus())
    val status = mutableStatus.asStateFlow()
    private val mutableDirectories = MutableStateFlow<Map<String, ManagedDirectory>>(emptyMap())
    val directories = mutableDirectories.asStateFlow()
    private val work = Mutex()
    private val tokenWork = Mutex()
    private val directoryAttempts = mutableMapOf<String, Any>()
    private var epoch = 0
    private val mutableConversationAccessVersion = MutableStateFlow(0)
    internal val conversationAccessVersion = mutableConversationAccessVersion.asStateFlow()
    private var messageAuthority: Int
        get() = mutableConversationAccessVersion.value
        set(value) { mutableConversationAccessVersion.value = value }
    private var auth: AuthState? = null
    private var identity: ManagedIdentity? = null
    private var organisations = emptyList<ManagedOrganisation>()
    private var installation = UUID.randomUUID().toString()
    private data class Enrollment(val organisationId: String, val deviceId: String, val name: String,
        val configuration: ManagedConfiguration?, val directory: ManagedDirectory? = null)
    private var enrollments = emptyList<Enrollment>()
    private var pending: AuthorizationRequest? = null
    private var pendingAt = 0L
    private var unavailableStorage = false
    private var busy = false
    private var lastError: String? = null
    private var appliedAccounts = emptyList<SipAccount>()
    private val lastReports = mutableMapOf<String, String>()
    private val reportAttempts = mutableMapOf<String, Long>()
    private val pushRegistrations = mutableMapOf<String, String?>()
    private val messagePushRegistrations = mutableMapOf<String, String?>()

    private fun current(attempt: Int) {
        // Superseded work is an ordinary outcome, not cancellation of the app's refresh loop.
        if (epoch != attempt) throw ManagedFailure("cancelled", "This managed-account update was cancelled.")
    }
    private fun publish() {
        mutableStatus.value = ManagedStatus(auth?.isAuthorized == true && identity != null, pending != null, busy,
            identity, organisations, enrollments.map { ManagedConnection(it.organisationId, it.deviceId, it.name,
                it.configuration?.expiresAt?.let { expiry -> expiry > System.currentTimeMillis() } == true, it.configuration?.expiresAt) }, lastError)
        mutableDirectories.value = if (auth?.isAuthorized == true && identity != null) enrollments.mapNotNull { entry ->
            entry.directory?.takeIf { it.expiresAt > System.currentTimeMillis() }?.let { entry.deviceId to it }
        }.toMap() else emptyMap()
    }
    suspend fun reconcile() {
        val now = System.currentTimeMillis()
        val retained = enrollments.map { it.copy(configuration = it.configuration?.takeIf { config -> config.expiresAt > now },
            directory = it.directory?.takeIf { directory -> directory.expiresAt > now }) }
        if (retained != enrollments) {
            enrollments = retained
            try { save() } catch (_: Exception) { lastError = "Expired managed settings have stopped, but their saved copy could not be removed. Sign out locally to reset it." }
        }
        val accounts = if (auth?.isAuthorized == true) enrollments.flatMap { it.configuration?.accounts ?: emptyList() }.filter { it.usable() } else emptyList()
        try {
            if (accounts != appliedAccounts) { applyAccounts(accounts); appliedAccounts = accounts }
            if (pending != null && System.currentTimeMillis() - pendingAt > 600_000) cancelSignIn()
        } finally { publish() }
    }
    fun load() {
        try {
            val bytes = vault.read() ?: return
            val value = try { JSONObject(bytes.toString(Charsets.UTF_8)) } finally { bytes.fill(0) }
            value.integer("version", 1..1)
            if (value.text("origin") != origin) invalidManaged()
            installation = value.uuid("installationId")
            val savedAuth = value.optJSONObject("auth")?.let(AuthState::jsonDeserialize)
            val parsedIdentity = value.optJSONObject("identity")?.let { parseIdentity(JSONObject().put("user", it).put("organisations", value.getJSONArray("organisations"))) }
            if ((savedAuth == null) != (parsedIdentity == null)) invalidManaged()
            if (savedAuth != null && (savedAuth.authorizationServiceConfiguration?.tokenEndpoint != configuration.tokenEndpoint ||
                savedAuth.lastTokenResponse?.request?.clientId != "sipper-android")) invalidManaged()
            var expiredDirectory = false
            val saved = value.objects("enrollments", 100).map { entry ->
                val organisationId = entry.uuid("organisationId"); val deviceId = entry.uuid("deviceId")
                val config = entry.optJSONObject("configuration")?.let { parseConfiguration(it, origin, organisationId, deviceId, acceptExpired = true) }
                val directory = entry.optJSONObject("directory")?.let {
                    if (it.text("userId", max = 128) != parsedIdentity?.first?.id) invalidManaged()
                    parseDirectory(it.optJSONObject("snapshot") ?: invalidManaged(), organisationId, deviceId, maximum = 10000, acceptExpired = true)
                }?.takeIf { (it.expiresAt > System.currentTimeMillis()).also { valid -> if (!valid) expiredDirectory = true } }
                Enrollment(organisationId, deviceId, entry.text("name", max = 160), config?.takeIf { it.expiresAt > System.currentTimeMillis() }, directory)
            }
            if ((saved.isNotEmpty() && savedAuth == null) || saved.map { it.organisationId }.toSet().size != saved.size || saved.map { it.deviceId }.toSet().size != saved.size) invalidManaged()
            val savedPending = value.optJSONObject("pending")?.let(AuthorizationRequest::jsonDeserialize)
            if (savedPending != null && (savedPending.configuration.tokenEndpoint != configuration.tokenEndpoint || savedPending.clientId != "sipper-android" || savedPending.redirectUri != callback)) invalidManaged()
            auth = savedAuth; identity = parsedIdentity?.first; organisations = parsedIdentity?.second ?: emptyList(); enrollments = saved
            pendingAt = value.optLong("pendingAt"); pending = savedPending?.takeIf { System.currentTimeMillis() - pendingAt in 0..600_000 }
            if (expiredDirectory) save()
        } catch (_: Exception) {
            unavailableStorage = true
            lastError = "The saved managed session could not be unlocked. Sign out locally to reset managed access."
        } finally { publish() }
    }
    private fun save() {
        check(!unavailableStorage) { "Sign out locally before replacing the saved managed session." }
        val value = JSONObject().put("version", 1).put("origin", origin).put("installationId", installation)
            .put("auth", auth?.jsonSerialize() ?: JSONObject.NULL)
            .put("identity", identity?.let { JSONObject().put("id", it.id).put("email", it.email) } ?: JSONObject.NULL)
            .put("organisations", JSONArray(organisations.map { JSONObject().put("id", it.id).put("name", it.name).put("status", it.status).put("licensed", it.licensed) }))
            .put("enrollments", JSONArray(enrollments.map { JSONObject().put("organisationId", it.organisationId).put("deviceId", it.deviceId).put("name", it.name).put("configuration", it.configuration?.raw ?: JSONObject.NULL)
                .put("directory", it.directory?.let { directory -> JSONObject().put("userId", identity?.id ?: invalidManaged()).put("snapshot", directory.json()) } ?: JSONObject.NULL) }))
            .put("pending", pending?.jsonSerialize() ?: JSONObject.NULL).put("pendingAt", pendingAt)
        val bytes = value.toString().toByteArray()
        try {
            // ponytail: one encrypted session, capped at 16 MB across all customers; split/index caches if needed.
            if (bytes.size > 16_000_000) throw ManagedFailure("directory_too_large", "Managed data exceeds this app’s local storage limit. Contact your administrator.")
            try { vault.write(bytes) } catch (error: Exception) { unavailableStorage = true; throw error }
        } finally { bytes.fill(0) }
    }
    internal fun prepareSignIn(): AuthorizationRequest {
        check(!busy && !unavailableStorage) { "Finish the current update, or sign out locally to reset managed access." }
        epoch++
        val request = AuthorizationRequest.Builder(configuration, "sipper-android", ResponseTypeValues.CODE, callback)
            .setScopes("email", "offline_access", "sipper:client").setAdditionalParameters(mapOf("resource" to resource)).build()
        pending = request; pendingAt = System.currentTimeMillis(); lastError = null
        try { save() } catch (error: Exception) { pending = null; publish(); throw error }
        publish(); return request
    }
    fun signInIntent(): Intent = try { service.getAuthorizationRequestIntent(prepareSignIn()) }
    catch (error: Exception) { cancelSignIn(); throw error }
    fun cancelSignIn() {
        epoch++; pending = null
        try { if (!unavailableStorage) save() } catch (_: Exception) { lastError = "The cancelled sign-in could not be removed from storage. Sign out locally to reset it." }
        publish()
    }
    suspend fun finishSignIn(intent: Intent?) = operation(allowPending = true) { attempt ->
        val request = pending ?: throw ManagedFailure("cancelled", "Sign-in was cancelled or expired. Try again.")
        val response = intent?.let(AuthorizationResponse::fromIntent)
        if (response == null) {
            pending = null; save()
            val error = intent?.let(AuthorizationException::fromIntent)
            if (intent == null || error == AuthorizationException.GeneralErrors.USER_CANCELED_AUTH_FLOW ||
                error == AuthorizationException.GeneralErrors.PROGRAM_CANCELED_AUTH_FLOW) {
                throw ManagedFailure("cancelled", "Sign-in was cancelled. You can try again when ready.")
            }
            throw ManagedFailure("sign_in_failed", "Sign-in could not be completed. Please try again.")
        }
        if (response.state != request.state || response.request.jsonSerializeString() != request.jsonSerializeString() ||
            System.currentTimeMillis() - pendingAt !in 0..600_000) invalidManaged()
        // Consume before exchanging so a late or duplicated result cannot be replayed after restart.
        pending = null; save(); publish()
        val token = suspendCancellableCoroutine<TokenResponse> { continuation ->
            service.performTokenRequest(response.createTokenExchangeRequest(mapOf("resource" to resource))) { result, _ ->
                if (continuation.isActive) {
                    if (result != null) continuation.resume(result)
                    else continuation.resumeWithException(ManagedFailure("sign_in_failed", "Sign-in could not be completed. Please try again."))
                }
            }
        }
        current(attempt)
        validateToken(token)
        val state = AuthState(response, token, null)
        val (user, orgs) = parseIdentity(request("organisations", attempt, explicitToken = token.accessToken))
        if (identity != null && identity?.id != user.id) throw ManagedFailure("identity_changed", "Sign out before connecting a different Sipper account.")
        val oldAuth = auth; val oldIdentity = identity; val oldOrgs = organisations
        auth = state; identity = user; organisations = orgs
        try { save() } catch (error: Exception) { auth = oldAuth; identity = oldIdentity; organisations = oldOrgs; throw error }
    }
    private fun validateToken(token: TokenResponse, refreshToken: String? = token.refreshToken) {
        if (!token.tokenType.equals("Bearer", ignoreCase = true) || token.accessToken.isNullOrBlank() ||
            refreshToken.isNullOrBlank() || (token.accessTokenExpirationTime ?: 0) <= System.currentTimeMillis()) invalidManaged()
    }
    private suspend fun accessToken(attempt: Int): String = tokenWork.withLock {
        current(attempt)
        val state = auth ?: throw ManagedFailure("sign_in_required", "Sign in to Sipper management.")
        val token = suspendCancellableCoroutine<String> { continuation ->
            state.performActionWithFreshTokens(service, mapOf("resource" to resource)) { access, _, error ->
                if (continuation.isActive) {
                    if (access != null) continuation.resume(access)
                    else continuation.resumeWithException(ManagedFailure(if (error?.error == "invalid_grant") "sign_in_required" else "unavailable",
                        if (error?.error == "invalid_grant") "Sign in again to restore managed access." else "Could not refresh managed sign-in. Check your connection and try again."))
                }
            }
        }
        current(attempt)
        try { validateToken(state.lastTokenResponse ?: invalidManaged(), state.refreshToken) }
        catch (_: ManagedFailure) { throw ManagedFailure("sign_in_required", "Sign in again to restore managed access.") }
        save()
        token
    }
    private fun connection(url: String) = (URL(url).openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false; connectTimeout = 15_000; readTimeout = 15_000; useCaches = false
    }
    private suspend fun request(path: String, attempt: Int, method: String = "GET", body: JSONObject? = null, explicitToken: String? = null, messaging: Boolean = false, conferencing: Boolean = false): JSONObject {
        val token = explicitToken ?: accessToken(attempt)
        current(attempt)
        val value = withContext(Dispatchers.IO) {
            val connection = connection("$resource/$path")
            try {
                connection.requestMethod = method
                connection.setRequestProperty("Authorization", "Bearer $token"); connection.setRequestProperty("Accept", "application/json")
                if (body != null) {
                    connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json")
                    connection.outputStream.use { it.write(body.toString().toByteArray()) }
                }
                when (connection.responseCode) {
                    in 200..299 -> Unit
                    401 -> throw ManagedFailure("sign_in_required", "Sign in again to restore managed access.")
                    403, 404 -> throw ManagedFailure("access_denied", "Managed access is unavailable. Contact your administrator.")
                    400 -> throw ManagedFailure(if (conferencing) "invalid_meeting_input" else if (messaging) "invalid_message_input" else "unavailable", if (conferencing) "This meeting or person is unavailable. Refresh and try again." else if (messaging) "Check the message and choose active licensed people from this customer." else "The management service is temporarily unavailable.")
                    409 -> throw ManagedFailure(if (conferencing) "meeting_changed" else if (messaging) "messages_changed" else "configuration_changed", if (conferencing) "The meeting changed. Refresh and try again." else if (messaging) "This conversation changed. Refresh and try again." else "Your settings changed. Refresh and try again.")
                    429 -> throw ManagedFailure(if (conferencing) "meeting_rate_limit" else if (messaging) "message_rate_limit" else "unavailable", if (conferencing) "Meeting requests are temporarily limited. Wait a moment and try again." else if (messaging) "Messaging is temporarily limited. Wait a moment and try again." else "The management service is temporarily unavailable.")
                    else -> throw ManagedFailure("unavailable", "The management service is temporarily unavailable.")
                }
                val maximum = if (messaging) 2_000_000 else 1_000_000
                if (connection.contentLengthLong > maximum) invalidManaged()
                val bytes = connection.inputStream.use { stream ->
                    val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                    while (true) { ensureActive(); val count = stream.read(buffer); if (count == -1) break
                        if (output.size() + count > maximum) invalidManaged()
                        output.write(buffer, 0, count)
                    }; output.toByteArray()
                }
                try { JSONObject(bytes.toString(Charsets.UTF_8)) } catch (_: Exception) { invalidManaged() } finally { bytes.fill(0) }
            } finally { connection.disconnect() }
        }
        current(attempt); return value
    }
    private suspend fun operation(allowPending: Boolean = false, quiet: Boolean = false, action: suspend (Int) -> Unit) {
        val attempt = epoch
        work.withLock {
            current(attempt)
            if (!allowPending && pending != null) throw ManagedFailure("pending", "Finish or cancel browser sign-in first.")
            if (!quiet) { busy = true; lastError = null; publish() }
            try { action(attempt); current(attempt) }
            catch (error: Exception) {
                if (error is CancellationException) throw error
                current(attempt)
                if (!quiet && (error as? ManagedFailure)?.kind != "cancelled") lastError =
                    (error as? ManagedFailure)?.message ?: "Could not update managed accounts. Check the connection and try again."
                if ((error as? ManagedFailure)?.kind == "sign_in_required") {
                    invalidateSession()
                }
                throw error
            } finally { busy = false; reconcile() }
        }
    }
    private fun invalidateSession() {
        auth = null; identity = null; organisations = emptyList(); enrollments = emptyList(); epoch++
        lastReports.clear(); reportAttempts.clear()
        directoryAttempts.clear(); pushRegistrations.clear(); messagePushRegistrations.clear()
        try { save() } catch (_: Exception) { lastError = "Managed access has stopped, but its saved session could not be cleared. Sign out locally to reset it." }
    }
    private fun withdraw(entry: Enrollment): Enrollment {
        messageAuthority++
        lastReports.remove(entry.deviceId); reportAttempts.remove(entry.deviceId)
        directoryAttempts.remove(entry.deviceId)
        return entry.copy(configuration = null, directory = null)
    }

    // Directory paging never holds the provisioning/call mutex.
    suspend fun refreshDirectory(deviceId: String): ManagedDirectory {
        if (canonicalCallId(deviceId) != deviceId) invalidManaged()
        val attempt = epoch
        val entry = enrollments.find { it.deviceId == deviceId }
            ?: throw ManagedFailure("access_denied", "This managed device is unavailable.")
        val user = identity ?: throw ManagedFailure("sign_in_required", "Sign in to Sipper management.")
        val requestId = Any(); directoryAttempts[deviceId] = requestId
        fun stillCurrent() {
            current(attempt)
            if (identity != user || directoryAttempts[deviceId] !== requestId || enrollments.none { it.deviceId == deviceId })
                throw ManagedFailure("cancelled", "This directory update was cancelled.")
        }
        try {
            repeat(2) { restart ->
                try {
                    var first: ManagedDirectory? = null
                    var cursor: String? = null
                    var expiry = Long.MAX_VALUE
                    var bytes = 0
                    val contacts = mutableListOf<DirectoryContact>()
                    val ids = mutableSetOf<String>()
                    do {
                        stillCurrent()
                        val query = cursor?.let { "?after=$it&revision=${first!!.revision}" } ?: ""
                        val raw = request("devices/$deviceId/directory$query", attempt)
                        stillCurrent()
                        val page = parseDirectory(raw, entry.organisationId, deviceId)
                        val previous = first
                        if (previous != null && (page.revision != previous.revision || page.organisationName != previous.organisationName))
                            throw ManagedFailure("configuration_changed", "The company directory changed. Refresh and try again.")
                        first = previous ?: page
                        if (!raw.has("nextCursor")) invalidManaged()
                        cursor = if (raw.isNull("nextCursor")) null else raw.uuid("nextCursor")
                        if (cursor != null && (page.contacts.size != 100 || cursor != page.contacts.last().id)) invalidManaged()
                        if (page.contacts.any { !ids.add(it.id) }) invalidManaged()
                        contacts.addAll(page.contacts); bytes += directoryTextSize(page.contacts)
                        expiry = minOf(expiry, page.expiresAt)
                        // ponytail: full encrypted snapshots; use indexed encrypted storage above 10,000 contacts / 8 MB.
                        if (contacts.size > 10000 || bytes > 8_000_000 || (cursor != null && contacts.size >= 10000))
                            throw ManagedFailure("directory_too_large", "This company directory exceeds this app’s local limit. Contact your administrator.")
                    } while (cursor != null)
                    stillCurrent()
                    if (expiry <= System.currentTimeMillis()) invalidManaged()
                    val snapshot = first.copy(expiresAt = expiry, contacts = contacts.toList())
                    val previous = enrollments
                    enrollments = enrollments.map { if (it.deviceId == deviceId) it.copy(directory = snapshot) else it }
                    try { save() } catch (error: Exception) { enrollments = previous; throw error }
                    publish()
                    return snapshot
                } catch (failure: ManagedFailure) {
                    if (failure.kind != "configuration_changed") throw failure
                    if (restart == 1) throw ManagedFailure("directory_changed", "The company directory changed. Refresh and try again.")
                }
            }
            invalidManaged()
        } catch (failure: Exception) {
            if (failure is CancellationException) throw failure
            current(attempt)
            if ((failure as? ManagedFailure)?.kind == "sign_in_required") {
                invalidateSession(); reconcile()
            } else if ((failure as? ManagedFailure)?.kind == "access_denied") {
                forgetDirectory(deviceId)
            }
            if (failure is java.io.IOException) throw ManagedFailure("unavailable", "Could not reach Sipper management. Saved contacts remain available until they expire.")
            if (failure is ManagedFailure && failure.kind != "invalid_response") throw failure
            throw ManagedFailure("invalid_directory", "The company directory could not be verified or saved securely.")
        } finally {
            if (directoryAttempts[deviceId] === requestId) directoryAttempts.remove(deviceId)
        }
    }
    private fun forgetDirectory(deviceId: String) {
        messageAuthority++
        directoryAttempts.remove(deviceId)
        enrollments = enrollments.map { if (it.deviceId == deviceId) it.copy(directory = null) else it }
        try { save() }
        catch (_: Exception) { throw ManagedFailure("storage_unavailable", "Directory access was removed, but the saved copy could not be cleared. Sign out and check your device storage.") }
        finally { publish() }
    }
    suspend fun directoryStatus(deviceId: String, contactIds: List<String>): DirectoryStatus {
        val attempt = epoch
        val user = identity ?: throw ManagedFailure("sign_in_required", "Sign in to Sipper management.")
        val directory = enrollments.find { it.deviceId == deviceId }?.directory ?: invalidManaged()
        if (canonicalCallId(deviceId) != deviceId || directory.expiresAt <= System.currentTimeMillis()
            || contactIds.size !in 1..100 || contactIds.toSet().size != contactIds.size
            || contactIds.any { canonicalCallId(it) != it || directory.contacts.none { contact -> contact.id == it } }) invalidManaged()
        try {
            val raw = request("devices/$deviceId/directory/status", attempt, "POST",
                JSONObject().put("revision", directory.revision).put("contactIds", JSONArray(contactIds)))
            current(attempt)
            val current = enrollments.find { it.deviceId == deviceId }?.directory
            if (identity != user || current == null || current.revision != directory.revision || current.expiresAt <= System.currentTimeMillis())
                throw ManagedFailure("directory_changed", "The company directory changed. Refresh and try again.")
            return parseDirectoryStatus(raw, current, contactIds)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            current(attempt)
            if ((error as? ManagedFailure)?.kind == "sign_in_required") { invalidateSession(); reconcile() }
            else if ((error as? ManagedFailure)?.kind == "access_denied") forgetDirectory(deviceId)
            throw error
        }
    }
    private suspend fun <T> conversationReply(deviceId: String, path: String, method: String = "GET", body: JSONObject? = null,
        service: String = "messages", parse: (JSONObject, String, String) -> T): T {
        val meeting = service == "conferencing"
        val id = canonicalCallId(deviceId) ?: if (meeting) invalidMeetingInput() else invalidMessageInput()
        val attempt = epoch; val authority = messageAuthority
        val user = identity ?: throw ManagedFailure("sign_in_required", "Sign in to Sipper management.")
        fun bound(): Enrollment {
            current(attempt)
            val entry = enrollments.find { it.deviceId == id }
            if (identity != user || auth?.isAuthorized != true || authority != messageAuthority || entry == null
                || organisations.none { it.id == entry.organisationId && it.status == "active" && it.licensed })
                throw ManagedFailure("access_denied", if (meeting) "Refresh managed accounts to check meeting access." else "Refresh managed accounts to check access to messages.")
            return entry
        }
        val entry = bound()
        try {
            val value = request("devices/$id/$service/$path", attempt, method, body, messaging = !meeting, conferencing = meeting)
            bound()
            return parse(value, entry.organisationId, user.id)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            current(attempt)
            if ((error as? ManagedFailure)?.kind == "sign_in_required") { invalidateSession(); reconcile() }
            if ((error as? ManagedFailure)?.kind == "access_denied") messageAuthority++
            if (error is java.io.IOException || (error as? ManagedFailure)?.kind == "unavailable")
                throw ManagedFailure("unavailable", if (meeting) "Could not reach Sipper meetings. Refresh when the service is available." else "Could not reach Sipper messages. Refresh when the service is available.")
            if (error is ManagedFailure && error.kind !in setOf("invalid_response", "invalid_messages")) throw error
            if (meeting) invalidMeeting() else invalidMessages()
        }
    }
    private suspend fun <T> messageRequest(deviceId: String, path: String, method: String = "GET", body: JSONObject? = null,
        parse: (JSONObject, MessageScope) -> T): T = conversationReply(deviceId, path, method, body) { value, organisation, user ->
        parse(value, parseMessageScope(value, organisation, meetingId(deviceId), user))
    }
    private suspend fun <T> meetingRequest(deviceId: String, path: String, method: String = "GET", body: JSONObject? = null,
        parse: (JSONObject, MessageScope) -> T): T = conversationReply(deviceId, path, method, body, "conferencing") { value, organisation, user ->
        parse(value, parseMessageScope(value, organisation, meetingId(deviceId), user))
    }
    suspend fun currentMeeting(deviceId: String, conversationId: String): CurrentMeeting {
        val id = meetingId(conversationId)
        return meetingRequest(deviceId, "conversations/$id/meeting") { value, scope -> parseCurrentMeeting(value, scope, id) }
    }
    suspend fun startMeeting(deviceId: String, conversationId: String, requestId: String): CurrentMeeting {
        val id = meetingId(conversationId); val nonce = meetingId(requestId)
        return meetingRequest(deviceId, "conversations/$id/meeting", "POST", JSONObject().put("id", nonce)) { value, scope ->
            parseCurrentMeeting(value, scope, id).also { if (it.meeting == null) invalidMeeting() }
        }
    }
    suspend fun meetingDetails(deviceId: String, id: String): MeetingDetails {
        val meeting = meetingId(id)
        return meetingRequest(deviceId, "meetings/$meeting") { value, scope -> parseMeetingDetails(value, scope, meeting) }
    }
    suspend fun joinMeeting(deviceId: String, id: String, sessionId: String): MeetingGrant {
        val meeting = meetingId(id); val session = meetingId(sessionId)
        return conversationReply(deviceId, "meetings/$meeting/join", "POST", JSONObject().put("id", session), "conferencing") { value, organisation, _ ->
            parseMeetingGrant(value, organisation, meeting, session, BuildConfig.DEBUG && origin.startsWith("http://"))
        }
    }
    suspend fun leaveMeeting(deviceId: String, id: String, sessionId: String) {
        val meeting = meetingId(id); val session = meetingId(sessionId)
        meetingRequest(deviceId, "meetings/$meeting/sessions/$session/leave", "POST", JSONObject()) { value, _ ->
            if (value.uuid("meetingId") != meeting || value.uuid("sessionId") != session || !value.flag("leaveRequested")) invalidMeeting()
        }
    }
    suspend fun endMeeting(deviceId: String, id: String): ManagedMeeting {
        val meeting = meetingId(id)
        return meetingRequest(deviceId, "meetings/$meeting/end", "POST", JSONObject()) { value, _ ->
            parseMeeting(value.optJSONObject("meeting") ?: invalidMeeting()).also { if (it.id != meeting || it.endedAt == null) invalidMeeting() }
        }
    }
    suspend fun removeMeetingPerson(deviceId: String, id: String, userId: String) {
        val meeting = meetingId(id)
        if (userId.length !in 1..128 || userId.any(Char::isISOControl) || userId == identity?.id) invalidMeetingInput()
        meetingRequest(deviceId, "meetings/$meeting/people/${Uri.encode(userId)}", "DELETE") { value, _ ->
            if (value.uuid("meetingId") != meeting || value.text("targetUserId", max = 128) != userId || !value.flag("removalRequested")) invalidMeeting()
        }
    }
    suspend fun messagePeople(deviceId: String, search: String = "", after: String? = null): MessagePeople {
        if (search.length > 160 || search.any(Char::isISOControl) || (after != null && (after.length !in 1..128 || after.any(Char::isISOControl)))) invalidMessageInput()
        val query = "?q=${Uri.encode(search.trim())}" + (after?.let { "&after=${Uri.encode(it)}" } ?: "")
        return messageRequest(deviceId, "people$query", parse = ::parseMessagePeople)
    }
    suspend fun conversations(deviceId: String, after: String? = null): ConversationPage {
        if (after != null && !messageCursor(after)) invalidMessageInput()
        return messageRequest(deviceId, "conversations" + (after?.let { "?after=${Uri.encode(it)}" } ?: ""), parse = ::parseConversationPage)
    }
    suspend fun createConversation(deviceId: String, id: String, userIds: List<String>, title: String = ""): ManagedConversation {
        val nonce = canonicalCallId(id) ?: invalidMessageInput(); val name = title.trim()
        if (userIds.size !in 1..19 || userIds.toSet().size != userIds.size || userIds.contains(identity?.id)
            || userIds.any { it.length !in 1..128 || it.any(Char::isISOControl) } || name.length > 160 || name.any(Char::isISOControl)
            || (userIds.size > 1 && name.isBlank())) invalidMessageInput()
        return messageRequest(deviceId, "conversations", "POST", JSONObject().put("id", nonce).put("userIds", JSONArray(userIds)).put("title", name)) { value, scope ->
            val conversation = parseConversation(value.optJSONObject("conversation") ?: invalidMessages(), scope.userId)
            if (conversation.participants.map { it.id }.toSet() != (userIds + scope.userId).toSet() || conversation.kind != (if (userIds.size == 1) "direct" else "group")
                || (userIds.size > 1 && (conversation.id != nonce || conversation.title != name))) invalidMessages()
            conversation
        }
    }
    suspend fun conversationMessages(deviceId: String, conversationId: String, before: String? = null, after: String? = null): MessagePage {
        val id = canonicalCallId(conversationId) ?: invalidMessageInput()
        if ((before != null && after != null) || listOfNotNull(before, after).any { messageSequence(it, true) == null }) invalidMessageInput()
        val query = before?.let { "?before=$it" } ?: after?.let { "?after=$it" } ?: ""
        return messageRequest(deviceId, "conversations/$id$query") { value, scope -> parseMessagePage(value, scope, id, before, after) }
    }
    suspend fun updateMessageGroup(deviceId: String, conversationId: String, revision: String, title: String, userIds: List<String>, ownerId: String): ManagedConversation {
        val id = canonicalCallId(conversationId) ?: invalidMessageInput()
        val name = title.trim()
        if (messageSequence(revision, true) == null || name.length !in 1..160 || name.any(Char::isISOControl)
            || userIds.size !in 1..20 || userIds.toSet().size != userIds.size || userIds.any { it.length !in 1..128 || it.any(Char::isISOControl) }
            || !userIds.contains(ownerId) || !userIds.contains(identity?.id)) invalidMessageInput()
        return messageRequest(deviceId, "conversations/$id/group", "PUT", JSONObject().put("revision", revision).put("title", name)
            .put("userIds", JSONArray(userIds)).put("ownerId", ownerId)) { value, scope ->
            parseConversation(value.optJSONObject("conversation") ?: invalidMessages(), scope.userId).also { c ->
                if (c.id != id || c.kind != "group" || c.title != name || c.ownerId != ownerId || c.revision == null
                    || c.revision.toLong() < revision.toLong() || c.participants.map { it.id }.toSet() != userIds.toSet()) invalidMessages()
            }
        }
    }
    suspend fun leaveMessageGroup(deviceId: String, conversationId: String) {
        val id = canonicalCallId(conversationId) ?: invalidMessageInput()
        messageRequest(deviceId, "conversations/$id/leave", "POST", JSONObject()) { value, _ ->
            if (value.uuid("conversationId") != id || !value.flag("left")) invalidMessages()
        }
    }
    suspend fun sendMessage(deviceId: String, conversationId: String, id: String, text: String): ManagedTextMessage {
        val conversation = canonicalCallId(conversationId) ?: invalidMessageInput(); val nonce = canonicalCallId(id) ?: invalidMessageInput()
        if (!validMessageText(text)) invalidMessageInput()
        return messageRequest(deviceId, "conversations/$conversation", "POST", JSONObject().put("id", nonce).put("text", text)) { value, scope ->
            val message = parseTextMessage(value.optJSONObject("message") ?: invalidMessages())
            if (message.id != nonce || message.text != text || message.senderId != scope.userId) invalidMessages()
            message
        }
    }
    suspend fun markConversationRead(deviceId: String, conversationId: String, sequence: String): String {
        val id = canonicalCallId(conversationId) ?: invalidMessageInput(); val requested = messageSequence(sequence) ?: invalidMessageInput()
        return messageRequest(deviceId, "conversations/$id/read", "POST", JSONObject().put("sequence", sequence)) { value, _ ->
            val returned = value.text("sequence", max = 19)
            if ((messageSequence(returned) ?: invalidMessages()) < requested) invalidMessages()
            returned
        }
    }
    internal fun directoryNumber(deviceId: String, contactId: String, number: String): String {
        val directory = enrollments.find { it.deviceId == deviceId }?.directory
        if (identity == null || auth?.isAuthorized != true || directory == null || directory.expiresAt <= System.currentTimeMillis()
            || directory.contacts.none { it.id == contactId && it.numbers.any { item -> item.number == number } })
            throw ManagedFailure("invalid_directory", "This shared contact is unavailable. Refresh the directory.")
        return number
    }
    internal fun gatewayBinding(accountId: String): Pair<String, String>? {
        if (auth?.isAuthorized != true) return null
        for (entry in enrollments) {
            val configuration = entry.configuration ?: continue
            val index = configuration.accounts.indexOfFirst { it.id == accountId && it.managedMode == "gateway" && it.usable() }
            if (index >= 0) return entry.deviceId to configuration.remoteIds[index]
        }
        return null
    }
    internal suspend fun call(deviceId: String, callId: String, action: String = "status"): ManagedCallState {
        if (canonicalCallId(deviceId) != deviceId || canonicalCallId(callId) != callId ||
            action !in setOf("status", "wake", "answer", "decline")) invalidManaged()
        var result: ManagedCallState? = null
        operation(quiet = true) { attempt ->
            if (enrollments.none { it.deviceId == deviceId }) throw ManagedFailure("access_denied", "This managed device is unavailable.")
            result = callSnapshot(deviceId, callId, action, attempt)
        }
        return result ?: invalidManaged()
    }
    private suspend fun callSnapshot(deviceId: String, callId: String, action: String, attempt: Int): ManagedCallState {
        val path = "devices/$deviceId/calls/$callId" + if (action == "status") "" else "/$action"
        try {
            return parseManagedCall(request(path, attempt, if (action == "status") "GET" else "POST",
                if (action == "status") null else JSONObject()), callId)
        } catch (failure: ManagedFailure) {
            if (failure.kind == "configuration_changed") throw ManagedFailure("call_unavailable", "This incoming call is no longer available.")
            throw failure
        }
    }
    internal fun hasGatewayAccounts() = appliedAccounts.any { it.managedMode == "gateway" && it.usable() }
    internal fun messageEnrollment(deviceId: String) = status.value.takeIf { it.signedIn }?.connections?.find { entry ->
        entry.deviceId == deviceId && status.value.organisations.any { it.id == entry.organisationId && it.status == "active" && it.licensed }
    }
    internal fun hasMessageAccess() = status.value.connections.any { messageEnrollment(it.deviceId) != null }
    internal suspend fun syncMessagePushToken(token: String?) = syncPushToken(token, message = true)
    internal suspend fun syncPushToken(token: String?, message: Boolean = false) {
        if (token != null && !token.matches(Regex("[a-zA-Z0-9_:-]{20,4096}"))) invalidManaged()
        val registrations = if (message) messagePushRegistrations else pushRegistrations
        if (auth?.isAuthorized != true) { registrations.clear(); return }
        operation(quiet = true) { attempt ->
            var failed: Exception? = null
            for (entry in enrollments.toList()) {
                val desired = token?.takeIf { if (message) organisations.any { it.id == entry.organisationId && it.status == "active" && it.licensed }
                    else entry.configuration?.accounts?.any { it.managedMode == "gateway" && it.usable() } == true }
                if (registrations.containsKey(entry.deviceId) && registrations[entry.deviceId] == desired) continue
                try {
                    val result = request("devices/${entry.deviceId}/${if (message) "messages/push" else "push"}", attempt, if (desired == null) "DELETE" else "PUT",
                        desired?.let { JSONObject().put("token", it) })
                    current(attempt)
                    if (enrollments.none { it.deviceId == entry.deviceId } || (message && result.text("deviceId") != entry.deviceId)) invalidManaged()
                    if (desired == null) { if (!result.flag("removed")) invalidManaged() }
                    else if (!result.flag("registered") || result.text("provider") != "fcm") invalidManaged()
                    registrations[entry.deviceId] = desired
                } catch (failure: Exception) {
                    if (failure is CancellationException) throw failure
                    current(attempt)
                    if ((failure as? ManagedFailure)?.kind == "sign_in_required") throw failure
                    if ((failure as? ManagedFailure)?.kind == "access_denied") {
                        messageAuthority++
                        enrollments = enrollments.map { if (it.deviceId == entry.deviceId) withdraw(it) else it }
                        pushRegistrations.remove(entry.deviceId); messagePushRegistrations.remove(entry.deviceId)
                        save(); reconcile()
                    } else failed = failure
                }
            }
            registrations.keys.retainAll(enrollments.map { it.deviceId }.toSet())
            failed?.let { throw it }
        }
    }
    internal suspend fun wake(push: IncomingCallPush): SipAccount? {
        if (canonicalCallId(push.deviceId) != push.deviceId || canonicalCallId(push.callId) != push.callId) invalidManaged()
        if (push.expiresAt <= System.currentTimeMillis()) return null
        var account: SipAccount? = null
        operation(quiet = true) { attempt ->
            val entry = enrollments.find { it.deviceId == push.deviceId } ?: return@operation
            val state = callSnapshot(push.deviceId, push.callId, "wake", attempt)
            if (state.unavailable() || state.state == "answered") return@operation
            // Refresh this enrolled customer's lease; never enrol an identity from a push.
            fetchConfiguration(entry, attempt)
            val config = enrollments.find { it.deviceId == entry.deviceId }?.configuration ?: invalidManaged()
            val index = config.remoteIds.indexOf(state.configurationId)
            account = config.accounts.getOrNull(index)?.takeIf { it.managedMode == "gateway" && it.usable() } ?: invalidManaged()
        }
        return account
    }
    suspend fun refresh() = operation { attempt ->
        val (user, orgs) = try { parseIdentity(request("organisations", attempt)) }
        catch (error: Exception) {
            if (attempt == epoch) organisations = organisations.map { it.copy(doNotDisturb = null, availability = null) }
            throw error
        }
        if (identity?.id != user.id) throw ManagedFailure("sign_in_required", "Sign in again to restore managed access.")
        organisations = orgs
        // Suspension or seat removal is authoritative even if another request subsequently fails.
        enrollments = enrollments.map { entry ->
            if (orgs.any { it.id == entry.organisationId && it.status == "active" && it.licensed }) entry else withdraw(entry)
        }
        save(); reconcile()
        var failure: Exception? = null
        for (entry in enrollments.toList()) {
            if (orgs.none { it.id == entry.organisationId && it.status == "active" && it.licensed }) continue
            try { fetchConfiguration(entry, attempt) } catch (error: Exception) {
                if (error is CancellationException || (error as? ManagedFailure)?.kind == "sign_in_required") throw error
                failure = error
            }
        }
        failure?.let { throw it }
    }
    suspend fun setDoNotDisturb(organisationId: String, enabled: Boolean) = setCallingPreference(organisationId, enabled = enabled)
    suspend fun setAvailability(organisationId: String, availability: ManagedAvailability) = setCallingPreference(organisationId, availability = availability)
    private suspend fun setCallingPreference(organisationId: String, enabled: Boolean? = null, availability: ManagedAvailability? = null) = operation { attempt ->
        if (canonicalCallId(organisationId) != organisationId) invalidManaged()
        if (identity == null || organisations.none { it.id == organisationId && it.status == "active" && (enabled == null || it.doNotDisturb != null) && (availability == null || it.availability != null) })
            throw ManagedFailure("access_denied", "Refresh your organisations to check calling preferences.")
        try {
            val body = JSONObject().apply { enabled?.let { put("doNotDisturb", it) }; availability?.let { put("availability", it.value) } }
            val result = request("organisations/$organisationId/calling-preference", attempt, "PATCH", body)
            if ((enabled != null && result.flag("doNotDisturb") != enabled) || (availability != null && result.text("availability") != availability.value)) invalidManaged()
            organisations = organisations.map { if (it.id == organisationId) it.copy(doNotDisturb = enabled ?: it.doNotDisturb, availability = availability ?: it.availability) else it }
        } catch (error: Exception) {
            if (attempt == epoch) organisations = organisations.map { if (it.id == organisationId) it.copy(doNotDisturb = if (enabled != null) null else it.doNotDisturb, availability = if (availability != null) null else it.availability) else it }
            throw error
        }
        if (enabled != null) for (entry in enrollments.filter { it.organisationId == organisationId }) fetchConfiguration(entry, attempt)
    }
    private suspend fun fetchConfiguration(entry: Enrollment, attempt: Int) {
        try {
            val raw = request("devices/${entry.deviceId}/configuration", attempt)
            val config = parseConfiguration(raw, origin, entry.organisationId, entry.deviceId)
            val previous = enrollments
            enrollments = enrollments.map { if (it.deviceId == entry.deviceId) it.copy(configuration = config) else it }
            try { save() } catch (error: Exception) { enrollments = previous; throw error }
        } catch (error: Exception) {
            current(attempt)
            if ((error as? ManagedFailure)?.kind in setOf("access_denied", "invalid_response")) {
                enrollments = enrollments.map { if (it.deviceId == entry.deviceId) withdraw(it) else it }
                try { save() } finally { reconcile() }
            }
            throw error
        }
    }
    suspend fun connect(organisationId: String) = operation { attempt -> connectCustomer(organisationId, attempt) }
    suspend fun connectSetupLink(value: String) = operation { attempt ->
        val user = identity ?: throw ManagedFailure("sign_in_required", "Sign in with the email address invited by your administrator.")
        val reference = setupReference(value, origin)
        val result = try { request("setup-links/redeem", attempt, "POST", JSONObject().put("reference", reference)) }
        catch (failure: ManagedFailure) {
            if (failure.kind == "access_denied") throw ManagedFailure("setup_unavailable", "This setup link is unavailable for your signed-in account. Check your email and ask your administrator for a new link.")
            throw failure
        }
        val org = parseOrganisation(result.optJSONObject("organisation") ?: invalidManaged())
        if (result.text("userId", max = 128) != user.id || identity?.id != user.id || org.status != "active" || !org.licensed) invalidManaged()
        organisations = organisations.filter { it.id != org.id } + org
        save() // The verified customer is retained; the setup reference is never saved.
        connectCustomer(org.id, attempt)
    }
    private suspend fun connectCustomer(organisationId: String, attempt: Int) {
        val org = organisations.find { it.id == organisationId && it.status == "active" && it.licensed }
            ?: throw ManagedFailure("licence_required", "Ask your administrator to enable your access and assign a licence.")
        var entry = enrollments.find { it.organisationId == organisationId }
        if (entry == null) {
            check(enrollments.size < 100)
            val device = request("organisations/$organisationId/devices", attempt, "POST", JSONObject()
                .put("installationId", installation).put("platform", "android").put("name", "Sipper on Android")
                .put("appVersion", BuildConfig.VERSION_NAME).put("osVersion", "Android ${Build.VERSION.RELEASE}"))
            if (device.text("platform") != "android") invalidManaged()
            device.text("name", max = 160)
            entry = Enrollment(org.id, device.uuid("id"), org.name, null)
            enrollments = enrollments + entry; save()
        }
        fetchConfiguration(entry, attempt)
    }
    suspend fun report(engine: SipEngine, onlyIfChanged: Boolean = false) = operation(quiet = onlyIfChanged) { attempt ->
        val ids = enrollments.map { it.deviceId }.toSet()
        lastReports.keys.retainAll(ids); reportAttempts.keys.retainAll(ids)
        for (entry in enrollments.toList()) {
            val config = entry.configuration?.takeIf { it.expiresAt > System.currentTimeMillis() } ?: continue
            val applied = engine.hasApplied(config.accounts)
            current(attempt)
            val registrations = JSONArray(config.accounts.mapIndexed { index, account ->
                val registration = engine.registration(account.id)
                JSONObject().put("accountId", config.remoteIds[index]).put("state", registration.state).also {
                    registration.code?.takeIf { code -> code in 100..699 }?.let { code -> it.put("sipCode", code) }
                }
            })
            val body = JSONObject().put("registrations", registrations)
            if (applied) body.put("appliedRevision", config.revision).put("directCalls", directCallReport(config.accounts, config.remoteIds, engine.calls.value))
            val snapshot = body.toString()
            val now = android.os.SystemClock.elapsedRealtime()
            if (onlyIfChanged && (lastReports[entry.deviceId] == snapshot || now - (reportAttempts[entry.deviceId] ?: -5000) < 5000)) continue
            reportAttempts[entry.deviceId] = now
            try {
                if (request("devices/${entry.deviceId}/report", attempt, "POST", body).opt("accepted") != true) invalidManaged()
                lastReports[entry.deviceId] = snapshot
            }
            catch (error: ManagedFailure) {
                if (error.kind == "access_denied") {
                    enrollments = enrollments.map { if (it.deviceId == entry.deviceId) withdraw(it) else it }
                    try { save() } finally { reconcile() }
                }
                throw error
            }
        }
    }
    suspend fun disconnect(deviceId: String) = operation { attempt ->
        if (enrollments.none { it.deviceId == deviceId }) return@operation
        messageAuthority++
        enrollments = enrollments.filter { it.deviceId != deviceId }; installation = UUID.randomUUID().toString()
        pushRegistrations.remove(deviceId); messagePushRegistrations.remove(deviceId); directoryAttempts.remove(deviceId); lastReports.remove(deviceId); reportAttempts.remove(deviceId)
        try { save() } finally { reconcile() }
        request("devices/$deviceId", attempt, "DELETE")
    }
    suspend fun signOut() {
        val oldAuth = auth; val oldEnrollments = enrollments
        epoch++; pending = null; auth = null; identity = null; organisations = emptyList(); enrollments = emptyList()
        pushRegistrations.clear(); messagePushRegistrations.clear(); directoryAttempts.clear(); lastReports.clear(); reportAttempts.clear()
        installation = UUID.randomUUID().toString(); lastError = null
        try { vault.clear(); unavailableStorage = false }
        catch (error: Exception) { unavailableStorage = true; lastError = "Local calling has stopped, but the saved managed session could not be removed. Try signing out again."; publish(); throw error }
        finally { reconcile() }
        // Local removal comes first. Remote revocation is best effort when the service is reachable.
        val token = oldAuth?.accessToken
        val attempt = epoch
        withTimeoutOrNull(10_000) {
          if (token != null) for (entry in oldEnrollments) {
            ensureActive()
            try { request("devices/${entry.deviceId}", attempt, "DELETE", explicitToken = token) }
            catch (error: Exception) { if (error is CancellationException) throw error }
          }
          oldAuth?.refreshToken?.let { refresh -> withContext(Dispatchers.IO) {
            val connection = connection("$origin/api/auth/oauth2/revoke")
            try {
                connection.requestMethod = "POST"; connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
                val body = "client_id=sipper-android&token_type_hint=refresh_token&token=${URLEncoder.encode(refresh, "UTF-8")}".toByteArray()
                try { connection.outputStream.use { it.write(body) }; connection.responseCode } finally { body.fill(0) }
            } catch (error: Exception) { if (error is CancellationException) throw error } finally { connection.disconnect() }
          } }
        }
    }
    fun close() { epoch++; directoryAttempts.clear(); service.dispose() }
}
