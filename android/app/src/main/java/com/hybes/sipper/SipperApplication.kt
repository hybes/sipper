package com.hybes.sipper

import android.app.Application
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONArray
import org.json.JSONObject

class SipperApplication : Application() {
    val model by lazy { PhoneModel(this) }
    override fun onCreate() { super.onCreate(); MessageNotifications.initialise(this); CallPush.initialise(this) }
}

data class RecentCall(val id: String, val accountId: String, val remote: String, val incoming: Boolean, val answered: Boolean, val at: Long,
    val destination: String? = null, val managedDeviceId: String? = null, val accountTitle: String = "") {
    fun callingAccount(accounts: List<SipAccount>): SipAccount {
        val account = accounts.find { it.id == accountId && it.managedDeviceId == managedDeviceId && it.usable() }
            ?: error("This call’s account is no longer available.")
        dialDestination(destination ?: error("No number was saved for this call."), account)
        return account
    }
    internal fun json() = JSONObject().put("id", id).put("accountId", accountId).put("remote", remote)
        .put("incoming", incoming).put("answered", answered).put("at", at).put("destination", destination)
        .put("managedDeviceId", managedDeviceId).put("accountTitle", accountTitle)
    companion object {
        internal fun read(value: JSONObject) = value.run {
            // Older records contain only a display label, which cannot safely be dialled.
            RecentCall(getString("id"), getString("accountId"), getString("remote"), getBoolean("incoming"), getBoolean("answered"), getLong("at"),
                optString("destination").takeIf { it.isNotEmpty() }, optString("managedDeviceId").takeIf { it.isNotEmpty() }, optString("accountTitle"))
        }
    }
}

class PhoneModel(private val application: Application, val engine: SipEngine = SipEngine(application)) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val calls = engine.calls
    val newCallFrom = MutableStateFlow<String?>(null)
    val registrations = engine.registrations
    val accounts = MutableStateFlow<List<SipAccount>>(emptyList())
    val history = MutableStateFlow<List<RecentCall>>(emptyList())
    val error = MutableStateFlow<String?>(null)
    val setupLink = MutableStateFlow("")
    val importing = MutableStateFlow(false)
    val importReview = MutableStateFlow<AccountImport?>(null)
    private var importAttempt = 0
    private val accountChanges = Mutex()
    val ready = MutableStateFlow(false)
    val pushStatus = MutableStateFlow("Incoming call notifications are not configured in this build.")
    internal val messageNotification = MutableStateFlow<MessageNotification?>(null)
    val messagePushStatus = MutableStateFlow("Message notifications are off.")
    private val initialised = CompletableDeferred<Unit>()
    private val pushSync = Mutex()
    private var store: AccountStore? = null
    private var managedAccounts = emptyList<SipAccount>()
    val managed by lazy { ManagedClient(application) { values ->
        managedAccounts = values
        syncAccounts()
    } }
    private val historyVault = SecureVault(application, "call-history")
    var bridge: CallBridge? = null
        private set
    private var started = false
    private var networkMonitor: NetworkMonitor? = null
    init { scope.coroutineContext.job.invokeOnCompletion { networkMonitor?.close() } }
    private val managedCalls by lazy { ManagedCallControl(engine, managed, scope) }
    fun start() {
        if (started) return
        started = true
        scope.launch {
            try {
                store = withContext(Dispatchers.IO) { AccountStore(SecureVault(application, "personal-accounts")) }
                accounts.value = store!!.accounts
                history.value = withContext(Dispatchers.IO) { readHistory() }
                engine.start()
                bridge = CallBridge(application, engine, scope, managedCalls) { error.value = it }
                engine.onEnded = { call -> scope.launch {
                    val next = (listOf(RecentCall(call.id, call.accountId, call.remote, call.incoming, call.connected, System.currentTimeMillis(),
                        call.destination, call.managedDeviceId, call.accountTitle)) + history.value).take(500)
                    try { withContext(Dispatchers.IO) { saveHistory(next) }; history.value = next }
                    catch (_: Exception) { error.value = "This call could not be saved to Recents." }
                } }
                engine.sync(accounts.value)
                managed.load()
                managed.reconcile()
                ready.value = true
                initialised.complete(Unit)
                launch { managed.status.collect { status ->
                    if (!status.signedIn || !managed.hasMessageAccess()) { messageNotification.value = null; MessageNotifications.clear(application) }
                    else if (messageNotification.value?.let { managed.messageEnrollment(it.deviceId) == null } == true) messageNotification.value = null
                } }
                networkMonitor = NetworkMonitor(application, scope) { available ->
                    attempt { engine.networkChanged(available) }
                    if (available && managed.status.value.signedIn && !managed.status.value.signingIn && !managed.status.value.busy) refreshManaged()
                }
                launch { while (isActive) { delay(1000); try { managed.reconcile() } catch (_: Exception) { error.value = "Managed settings could not be applied." } } }
                launch { while (isActive) {
                    if (managed.status.value.signedIn && !managed.status.value.signingIn && !managed.status.value.busy) refreshManaged()
                    delay(60_000)
                } }
                launch { while (isActive) {
                    delay(1000)
                    if (managed.status.value.signedIn && !managed.status.value.signingIn && !managed.status.value.busy) {
                        try { managed.report(engine, onlyIfChanged = true) }
                        catch (failure: Exception) {
                            if (failure is CancellationException) throw failure
                            if ((failure as? ManagedFailure)?.kind == "configuration_changed") refreshManaged()
                        }
                    }
                } }
                launch { engine.error.collect { if (it != null) error.value = it } }
                launch { calls.collect { values ->
                    val source = newCallFrom.value
                    if (source != null && (values.none { it.id == source && it.connected && it.state != "Ended" && !it.transferring }
                        || values.any { it.incoming && !it.connected })) returnToCalls()
                } }
            } catch (failure: Exception) {
                initialised.completeExceptionally(failure)
                error.value = "Sipper could not load your calling accounts. Your saved settings have been preserved."
            }
        }
    }
    internal suspend fun awaitReady() { start(); initialised.await() }
    internal suspend fun wakeCall(push: IncomingCallPush): Boolean {
        val call = managedCalls.wake(push) ?: return false
        return bridge?.awaitPresentation(call.id) == true
    }
    internal suspend fun syncCallPush() = pushSync.withLock {
        if (!CallPush.configured) return@withLock
        val eligible = managed.hasGatewayAccounts()
        val allowed = CallPush.allowed(application)
        val messagesAllowed = MessageNotifications.allowed(application) && managed.hasMessageAccess()
        FirebaseMessaging.getInstance().isAutoInitEnabled = eligible && allowed || messagesAllowed
        try {
            withTimeout(20_000) {
                val token = if (eligible && allowed || messagesAllowed) CallPush.token() else null
                managed.syncPushToken(token?.takeIf { eligible && allowed })
                managed.syncMessagePushToken(token?.takeIf { messagesAllowed })
            }
            if (!messagesAllowed) { messageNotification.value = null; MessageNotifications.clear(application) }
            messagePushStatus.value = when {
                !MessageNotifications.enabled(application) -> "Message notifications are off."
                !MessageNotifications.allowed(application) -> "Allow message notifications in Android settings."
                !managed.hasMessageAccess() -> "Connect a licensed customer to receive message notifications."
                else -> "Message notifications registered."
            }
            pushStatus.value = when {
                !managed.hasGatewayAccounts() -> "Background call alerts require a managed gateway account."
                !allowed -> "Allow microphone and call notifications to receive incoming calls."
                else -> "Call notifications registered."
            }
        } catch (failure: Exception) {
            if (failure is CancellationException && failure !is TimeoutCancellationException) throw failure
            pushStatus.value = "Call notifications could not be registered. Check your connection and try again."
            messagePushStatus.value = "Notifications could not be registered. Check your connection and try again."
            throw failure
        }
    }
    internal fun openMessageNotification(hint: MessageNotification) {
        scope.launch {
            awaitReady()
            if (MessageNotifications.enabled(application) && managed.messageEnrollment(hint.deviceId) != null) messageNotification.value = hint
            MessageNotifications.clear(application)
        }
    }
    internal fun setMessageNotifications(enabled: Boolean) {
        MessageNotifications.setEnabled(application, enabled)
        if (!enabled) messageNotification.value = null
        messagePushStatus.value = if (enabled) "Registering message notifications…" else "Message notifications are off."
    }
    suspend fun save(account: SipAccount): Boolean = attempt { accountChanges.withLock {
        check(calls.value.none { it.accountId == account.id }) { "Finish this account’s call before editing it." }
        val storage = store ?: error("Account storage is unavailable.")
        withContext(Dispatchers.IO) { storage.save(account) }
        syncAccounts()
    } }
    suspend fun remove(account: SipAccount): Boolean = attempt { accountChanges.withLock {
        check(calls.value.none { it.accountId == account.id }) { "Finish this account’s call before removing it." }
        check(account.managedDeviceId == null)
        val storage = store ?: error("Account storage is unavailable.")
        withContext(Dispatchers.IO) { storage.remove(account.id) }
        syncAccounts()
    } }
    fun cancelImport() { importAttempt += 1; importReview.value = null; importing.value = false }
    suspend fun reviewImport(link: String): Boolean = attempt {
        error.value = null
        check(importReview.value == null) { "Finish or cancel the current import first." }
        val attempt = ++importAttempt
        importing.value = true
        awaitReady()
        val review = withContext(Dispatchers.IO) { (store ?: error("Account storage is unavailable.")).reviewImport(link) }
        if (attempt == importAttempt) importReview.value = review
    }
    suspend fun importAccounts(selected: Set<String>): Boolean = attempt { accountChanges.withLock {
        error.value = null
        check(ready.value)
        val review = importReview.value ?: error("Open the import link again.")
        val storage = store ?: error("Account storage is unavailable.")
        withContext(Dispatchers.IO) { storage.importAccounts(review, selected, calls.value.map { it.accountId }.toSet()) }
        cancelImport()
        syncAccounts()
    } }
    private suspend fun syncAccounts() {
        accounts.value = (store?.accounts ?: emptyList()) + managedAccounts
        try { engine.sync(accounts.value) }
        catch (failure: Exception) {
            // Invalid/oversized managed settings must not leave an older managed account admitted.
            engine.sync(store?.accounts ?: emptyList())
            throw failure
        }
        if (CallPush.configured && !CallPush.scheduleToken(application)) {
            pushStatus.value = "Android could not schedule call notifications. Open Sipper to try again."
        }
    }
    suspend fun refreshManaged() = attempt {
        managed.refresh()
        managed.reconcile()
        managed.report(engine)
        CallPush.scheduleToken(application)
    }
    suspend fun connectManaged(organisationId: String) = attempt {
        managed.connect(organisationId)
        managed.reconcile()
        managed.report(engine)
        CallPush.scheduleToken(application)
    }
    fun openSetupLink(value: String) {
        try { setupReference(value, managed.origin); setupLink.value = value }
        catch (_: Exception) { error.value = "This setup link is invalid or belongs to another Sipper server." }
    }
    suspend fun connectSetupLink() = attempt {
        managed.connectSetupLink(setupLink.value)
        setupLink.value = ""
        managed.reconcile()
        managed.report(engine)
        CallPush.scheduleToken(application)
    }
    suspend fun prepareNewCall(callId: String): Boolean = attempt {
        val call = calls.value.find { it.id == callId && it.connected && it.state != "Ended" && !it.transferring }
            ?: error("This call is no longer available.")
        check(accounts.value.any { it.id == call.accountId && it.managedDeviceId == call.managedDeviceId && it.usable() }) {
            "This calling account is no longer available."
        }
        check(calls.value.none { it.incoming && !it.connected }) { "Answer or decline the incoming call first." }
        newCallFrom.value = call.id
    }
    fun returnToCalls() { newCallFrom.value = null }
    suspend fun dial(accountId: String, destination: String) = attempt {
        check(ready.value)
        (bridge ?: error("Calling is unavailable.")).dial(accountId, destination)
        returnToCalls()
    }
    suspend fun dialRecent(id: String) = attempt {
        check(ready.value)
        val call = history.value.find { it.id == id } ?: error("This call is no longer in Recents.")
        // Recheck after the microphone permission prompt, without falling back to another account.
        val account = call.callingAccount(accounts.value)
        (bridge ?: error("Calling is unavailable.")).dial(account.id, call.destination!!)
        returnToCalls()
    }
    suspend fun dialDirectory(deviceId: String, contactId: String, number: String, accountId: String) = attempt {
        check(ready.value)
        val destination = managed.directoryNumber(deviceId, contactId, number)
        val account = directoryAccount(accounts.value, accountId, deviceId)
        (bridge ?: error("Calling is unavailable.")).dial(account.id, destination)
        returnToCalls()
    }
    suspend fun callAction(id: String, action: String, presentation: String? = null) = attempt {
        val call = calls.value.find { it.id == id } ?: return@attempt
        check(presentation == null || call.presentationId == presentation) { "This call has changed. Check the current call controls." }
        when (action) {
            "answer" -> { bridge?.answer(id); returnToCalls() }
            "hangup" -> bridge?.hangup(id)
            "hold" -> bridge?.hold(id, !calls.value.presentationMembers(call.presentationId).any { it.held })
            "mute" -> engine.mute(id, !call.muted, call.presentationId)
        }
    }
    suspend fun attempt(block: suspend () -> Unit): Boolean = try { block(); true }
    catch (failure: Exception) {
        if (failure is CancellationException) throw failure
        // Native exceptions can contain SIP URIs; use a safe summary outside validation.
        if (!(failure is ManagedFailure && failure.kind == "cancelled")) {
            error.value = if (failure is ManagedFailure || failure is IllegalArgumentException || failure is IllegalStateException) failure.message else "The operation could not be completed. Check the account and connection."
        }
        false
    }
    private fun readHistory(): List<RecentCall> {
        val bytes = historyVault.read() ?: return emptyList()
        return try {
            val array = JSONArray(bytes.toString(Charsets.UTF_8))
            require(array.length() <= 500)
            List(array.length()) { i -> RecentCall.read(array.getJSONObject(i)) }
        } finally { bytes.fill(0) }
    }
    private fun saveHistory(calls: List<RecentCall>) {
        val array = JSONArray()
        calls.forEach { array.put(it.json()) }
        val bytes = array.toString().toByteArray()
        try { historyVault.write(bytes) } finally { bytes.fill(0) }
    }
}
