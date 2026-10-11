package com.hybes.sipper

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable internal fun CompanyDirectory(client: ManagedClient, accounts: List<SipAccount>, ready: Boolean,
    onAccounts: () -> Unit, onMessages: () -> Unit, onCall: (String, String, String, String) -> Unit) {
    val status by client.status.collectAsState()
    val directories by client.directories.collectAsState()
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    val connection = status.connections.find { it.deviceId == selected } ?: status.connections.firstOrNull()
    val deviceId = connection?.deviceId
    var search by rememberSaveable(deviceId) { mutableStateOf("") }
    var expanded by remember(deviceId) { mutableStateOf<String?>(null) }
    var selectedAccount by rememberSaveable(deviceId) { mutableStateOf<String?>(null) }
    var loading by remember(deviceId) { mutableStateOf(false) }
    var failure by remember(deviceId) { mutableStateOf<String?>(null) }
    var customerMenu by remember { mutableStateOf(false) }
    var accountMenu by remember(deviceId) { mutableStateOf(false) }
    val directory = directories[deviceId]
    val choices = accounts.filter { deviceId != null && it.managedDeviceId == deviceId && it.usable() }
    val account = choices.find { it.id == selectedAccount } ?: choices.firstOrNull()
    val contacts = directory?.contacts?.filter { it.matches(search) }.orEmpty()
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    suspend fun refresh() {
        val id = deviceId ?: return
        if (loading) return
        loading = true; failure = null
        try { client.refreshDirectory(id) }
        catch (error: Exception) {
            if (error is CancellationException) throw error
            if (error !is ManagedFailure || error.kind != "cancelled") failure =
                (error as? ManagedFailure)?.message ?: "The directory could not be loaded. Try again."
        } finally { loading = false }
    }
    LaunchedEffect(deviceId) {
        if (deviceId != null) lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) { refresh(); delay(60_000) }
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize().imePadding()) {
    val compact = maxHeight < 560.dp
    Column(if (compact) Modifier.fillMaxWidth().verticalScroll(rememberScrollState()) else Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Company directory", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f).padding(vertical = 12.dp))
            TextButton(onClick = onMessages) { Text("Messages") }
        }
        if (!status.signedIn || connection == null) {
            Text("Connect a managed customer to see their shared contacts.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onAccounts) { Text("Manage accounts") }
        } else {
            Box(Modifier.fillMaxWidth()) {
                OutlinedButton(onClick = { customerMenu = true }, modifier = Modifier.fillMaxWidth()) { Text(connection.name) }
                DropdownMenu(customerMenu, { customerMenu = false }) {
                    status.connections.forEach { entry -> DropdownMenuItem(text = { Text(entry.name) },
                        onClick = { selected = entry.deviceId; customerMenu = false }) }
                }
            }
            OutlinedTextField(search, { if (it.length <= 160) search = it }, label = { Text("Search company directory") },
                placeholder = { Text("Name, company or number") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(if (directory == null) "" else "${contacts.size} ${if (contacts.size == 1) "contact" else "contacts"}",
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 14.dp))
                TextButton(onClick = { scope.launch { refresh() } }, enabled = !loading) { Text(if (loading) "Refreshing…" else "Refresh") }
            }
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            failure?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp)) }
            if (directory != null) {
                Box(Modifier.fillMaxWidth()) {
                    OutlinedButton(onClick = { accountMenu = true }, enabled = choices.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
                        Text(account?.let { "Call from ${it.title}" } ?: "No current calling account for this customer")
                    }
                    DropdownMenu(accountMenu, { accountMenu = false }) {
                        choices.forEach { option -> DropdownMenuItem(text = { Text(option.title) }, onClick = { selectedAccount = option.id; accountMenu = false }) }
                    }
                }
            }
            if (contacts.isEmpty() && !loading) Text(when {
                directory == null -> "Refresh to load this customer’s shared contacts."
                search.isNotBlank() -> "No contacts match your search."
                else -> "Your administrator has not added any shared contacts yet."
            }, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
            LazyColumn(if (compact) Modifier.height(200.dp) else Modifier.weight(1f), contentPadding = PaddingValues(bottom = 16.dp)) {
                items(contacts, key = { it.id }) { contact ->
                    ListItem(headlineContent = { Text(contact.name) }, supportingContent = contact.company.takeIf { it.isNotEmpty() }?.let { { Text(it) } },
                        trailingContent = { Text(if (expanded == contact.id) "Hide" else "View", color = MaterialTheme.colorScheme.primary) },
                        modifier = Modifier.clickable(onClickLabel = if (expanded == contact.id) "Hide numbers" else "Show numbers") { expanded = if (expanded == contact.id) null else contact.id })
                    if (expanded == contact.id && directory != null) {
                        DirectoryContactStatusView(client, directory.deviceId, directory.revision, contact.id)
                        contact.numbers.forEach { number ->
                            ListItem(headlineContent = { Text(number.number) }, supportingContent = { Text(number.label) }, trailingContent = {
                                TextButton(onClick = { account?.let { onCall(deviceId!!, contact.id, number.number, it.id) } }, enabled = ready && account != null,
                                    modifier = Modifier.semantics { contentDescription = "Call ${contact.name}, ${number.label}, ${number.number}" }) { Text("Call") }
                            })
                        }
                    }
                    HorizontalDivider()
                }
            }
        }
    }
    }
}

@Composable private fun DirectoryContactStatusView(client: ManagedClient, deviceId: String, revision: String, contactId: String) {
    var observation by remember(deviceId, revision, contactId) { mutableStateOf<DirectoryStatus?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(deviceId, revision, contactId, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            try {
                while (true) {
                    try { observation = client.directoryStatus(deviceId, listOf(contactId)) }
                    catch (error: Exception) { observation = null; if (error is CancellationException) throw error }
                    delay(20_000)
                }
            } finally { observation = null }
        }
    }
    LaunchedEffect(observation?.expiresAt) {
        observation?.let { delay((it.expiresAt - System.currentTimeMillis()).coerceIn(0, 30_000)); observation = null }
    }
    Text(observation?.label(contactId) ?: "Status unavailable", style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics { contentDescription = "${observation?.label(contactId) ?: "Status unavailable"}. Shared by this person. This does not confirm they can answer." })
}
