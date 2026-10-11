package com.hybes.sipper

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.*

/** Wait for link properties; onAvailable alone does not mean the new route is ready. */
class NetworkMonitor(context: Context, private val scope: CoroutineScope,
    private val changed: suspend (Boolean) -> Unit,
) : AutoCloseable {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private var current: Network? = manager.activeNetwork
    private var fingerprint: String? = current?.let { network -> manager.getLinkProperties(network)?.let { fingerprint(network, it) } }
    private var pending: Job? = null
    private fun fingerprint(network: Network, properties: LinkProperties) = listOf(network.toString(), properties.interfaceName.orEmpty(),
        properties.linkAddresses.map { it.toString() }.sorted().joinToString(),
        properties.dnsServers.mapNotNull { it.hostAddress }.sorted().joinToString(),
        properties.routes.map { it.toString() }.sorted().joinToString()).joinToString("|")
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // Registration reports the existing route too. It must not restart SIP
            // transports and cancel a call placed immediately after startup.
            if (network == current) return
            current = network; fingerprint = null; pending?.cancel()
        }
        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) {
            if (network != current) return
            val next = fingerprint(network, properties)
            if (next == fingerprint) return
            fingerprint = next; pending?.cancel()
            pending = scope.launch { delay(500); changed(true) }
        }
        override fun onLost(network: Network) {
            if (network != current) return // An old Wi-Fi callback must not undo a new mobile route.
            current = null; fingerprint = null; pending?.cancel()
            pending = scope.launch { changed(false) }
        }
    }
    init {
        manager.registerDefaultNetworkCallback(callback, Handler(Looper.getMainLooper()))
        if (current == null) pending = scope.launch { changed(false) }
    }
    override fun close() { pending?.cancel(); manager.unregisterNetworkCallback(callback) }
}
