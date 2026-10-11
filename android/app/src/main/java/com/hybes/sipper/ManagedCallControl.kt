package com.hybes.sipper

import kotlinx.coroutines.*

/** The SIP offer and the authenticated device API must refer to the same account/call. */
class ManagedCallControl(private val engine: SipEngine, private val client: ManagedClient,
    private val scope: CoroutineScope) {
    internal suspend fun wake(push: IncomingCallPush): PhoneCall? {
        val account = client.wake(push) ?: return null
        engine.refreshRegistration(account.id)
        while (System.currentTimeMillis() < push.expiresAt) {
            currentCoroutineContext().ensureActive()
            val state = client.call(push.deviceId, push.callId)
            if (state.unavailable() || state.configurationId != client.gatewayBinding(account.id)?.second) return null
            engine.calls.value.find { it.accountId == account.id && it.gatewayCallId == push.callId && it.state != "Ended" }?.let { return it }
            delay(500)
        }
        return null
    }
    private fun unavailable(): Nothing = throw ManagedFailure("call_unavailable", "This incoming call is no longer available.")
    private suspend fun status(call: PhoneCall, action: String): ManagedCallState {
        val reference = call.gatewayCallId ?: unavailable()
        val binding = client.gatewayBinding(call.accountId) ?: unavailable()
        val state = client.call(binding.first, reference, action)
        if (state.configurationId != binding.second) unavailable()
        return state
    }
    suspend fun prepare(call: PhoneCall): PhoneCall {
        if (call.gatewayCallId == null) return call
        val state = status(call, "status")
        if (state.unavailable()) unavailable()
        val name = state.caller ?: "Incoming managed call"
        val destination = engine.verifiedCaller(call.id, name, state.callerNumber)
        return call.copy(remote = name, destination = destination)
    }
    suspend fun answer(id: String, action: suspend () -> Unit) {
        val call = engine.calls.value.find { it.id == id } ?: unavailable()
        if (call.gatewayCallId == null) { action(); return }
        val state = status(call, "answer")
        if (state.unavailable() || !state.claimedByThisDevice || state.state !in setOf("answering", "answered")) unavailable()
        try { action() } catch (failure: Exception) {
            withContext(NonCancellable) {
                runCatching { engine.hangup(id) }
                withTimeoutOrNull(3000) { runCatching { status(call, "decline") } }
            }
            throw failure
        }
    }
    fun declined(call: PhoneCall) {
        if (!call.incoming || call.connected || call.gatewayCallId == null) return
        scope.launch { runCatching { status(call, "decline") } }
    }
    suspend fun monitor(id: String) {
        while (currentCoroutineContext().isActive) {
            val call = engine.calls.value.find { it.id == id && it.state != "Ended" } ?: return
            if (call.gatewayCallId == null || call.connected) return
            try {
                if (status(call, "status").unavailable()) { engine.hangup(id); return }
            } catch (failure: Exception) {
                if (failure is CancellationException) throw failure
                if ((failure as? ManagedFailure)?.kind in setOf("access_denied", "call_unavailable", "invalid_response", "sign_in_required")) {
                    engine.hangup(id); return
                }
                // SIP cancellation still dismisses the native alert during an API outage.
                // Answer always makes a fresh server claim before accepting SIP.
            }
            delay(1000)
        }
    }
}
