package com.hybes.sipper

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import java.util.UUID

private fun messageAccessLost(error: Exception) = (error as? ManagedFailure)?.kind in setOf("access_denied", "sign_in_required", "cancelled")
private fun definiteMessageFailure(error: Exception) = messageAccessLost(error) || (error as? ManagedFailure)?.kind in
    setOf("invalid_message_input", "messages_changed", "message_rate_limit")
private fun messageError(error: Exception) = (error as? ManagedFailure)?.message ?: "Could not reach Sipper messages. Refresh when the service is available."
private fun messageDate(value: Long) = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(value))

// Shared by conversation metadata, history and colleague search; none enter saved activity state.
internal class MessageViewPage<T>(val load: suspend () -> Pair<T, Long>, val active: () -> Boolean) {
    var value by mutableStateOf<T?>(null)
    var expiresAt = 0L
    var busy by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var denied by mutableStateOf(false)
    suspend fun refresh() {
        if (busy || !active()) return
        busy = true
        try { val (page, expiry) = load(); if (active()) { value = page; expiresAt = expiry; error = null; denied = false } }
        catch (problem: Exception) {
            if (problem is CancellationException) throw problem
            error = messageError(problem)
            if (messageAccessLost(problem)) { value = null; denied = true }
        } finally { busy = false }
    }
}
@Composable private fun <T> messageViewPage(vararg keys: Any?, load: suspend () -> Pair<T, Long>): MessageViewPage<T> {
    val latest by rememberUpdatedState(load)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val page = remember(*keys, lifecycle) { MessageViewPage({ latest() }, { lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }) }
    LaunchedEffect(page, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { while (true) { page.refresh(); delay(5000) } }
    }
    DisposableEffect(page, lifecycle) {
        val observer = LifecycleEventObserver { _, _ ->
            if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) { page.value = null; page.expiresAt = 0L }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(page) { while (true) { if (page.expiresAt <= System.currentTimeMillis()) page.value = null; delay(1000) } }
    return page
}

@Composable internal fun ManagedMessagesView(client: ManagedClient, onDirectory: () -> Unit, onAccounts: () -> Unit,
    notification: MessageNotification? = null, onNotificationConsumed: () -> Unit = {}, onLock: (Boolean) -> Unit = {}, model: PhoneModel) {
    val status by client.status.collectAsState()
    var selected by remember { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var locked by remember { mutableStateOf(false) }
    val setLock: (Boolean) -> Unit = { locked = it; onLock(it) }
    DisposableEffect(Unit) { onDispose { onLock(false) } }
    val connections = if (status.signedIn) status.connections.filter { entry -> status.organisations.any {
        it.id == entry.organisationId && it.status == "active" && it.licensed
    } } else emptyList()
    val entry = connections.find { it.deviceId == selected } ?: connections.firstOrNull()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var visible by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    var active by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    LaunchedEffect(notification, locked, active) {
        notification?.let { hint -> if (active && !locked && connections.any { it.deviceId == hint.deviceId }) selected = hint.deviceId }
    }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ ->
            visible = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
            active = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    BoxWithConstraints(Modifier.fillMaxSize().imePadding()) {
    val compact = maxHeight < 560.dp
    Column(if (compact) Modifier.fillMaxWidth().verticalScroll(rememberScrollState()) else Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Messages", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(vertical = 12.dp))
            TextButton(onClick = onDirectory, enabled = !locked) { Text("Directory") }
        }
        if (entry == null) {
            Text("Sign in and connect a licensed customer to message their people.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onAccounts) { Text("Manage accounts") }
        } else {
            Box(Modifier.fillMaxWidth()) {
                OutlinedButton(onClick = { menu = true }, enabled = !locked, modifier = Modifier.fillMaxWidth()) { Text(entry.name, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                DropdownMenu(menu, { menu = false }) { connections.forEach { item -> DropdownMenuItem(text = { Text(item.name) },
                    onClick = { selected = item.deviceId; menu = false }) } }
            }
            if (notification != null && locked && connections.any { it.deviceId == notification.deviceId })
                Text("New message ready. Send or clear your draft, or close the open dialogue, to view it.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            // Keep an in-memory draft through a transient pause; stopping still destroys the view.
            if (visible) key(status.identity?.id, entry.deviceId) {
                CustomerMessages(client, model, entry.deviceId, compact, active, notification?.takeIf { it.deviceId == entry.deviceId }, onNotificationConsumed, setLock)
            }
        }
    }
    }
}

@Composable private fun ColumnScope.CustomerMessages(client: ManagedClient, model: PhoneModel, deviceId: String, compact: Boolean, active: Boolean,
    notification: MessageNotification?, onNotificationConsumed: () -> Unit, onLock: (Boolean) -> Unit) {
    var cursor by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<String?>(null) }
    var creating by remember { mutableStateOf(false) }
    var locked by remember { mutableStateOf(false) }
    val setLock: (Boolean) -> Unit = { locked = it; onLock(it || creating) }
    SideEffect { onLock(locked || creating) }
    LaunchedEffect(notification, locked, creating, active) {
        if (active && !locked && !creating) notification?.let { cursor = null; selected = it.conversationId; onNotificationConsumed() }
    }
    val list = messageViewPage(deviceId, cursor) { client.conversations(deviceId, cursor).let { it to it.scope.expiresAt } }
    val scope = rememberCoroutineScope()
    DisposableEffect(Unit) { onDispose { onLock(false) } }
    LaunchedEffect(list.denied) { if (list.denied) { selected = null; creating = false; setLock(false) } }
    when {
        creating && !list.denied -> NewManagedConversation(client, deviceId, compact, {}, onClose = { creating = false }) {
            creating = false; selected = it; cursor = null; scope.launch { list.refresh() }
        }
        selected != null && !list.denied -> key(selected) {
            ManagedConversationView(client, model, deviceId, selected!!, compact, setLock, onBack = { selected = null }) { scope.launch { list.refresh() } }
        }
        else -> {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(onClick = { creating = true; onLock(true) }, enabled = !list.denied) { Text("New conversation") }
                TextButton(onClick = { scope.launch { list.refresh() } }, enabled = !list.busy) { Text(if (list.busy) "Refreshing…" else "Refresh") }
            }
            list.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (cursor != null) TextButton(onClick = { cursor = null }) { Text("Latest conversations") }
            LazyColumn(if (compact) Modifier.height(200.dp) else Modifier.weight(1f)) {
                items(list.value?.conversations.orEmpty(), key = { it.id }) { conversation ->
                    ListItem(headlineContent = { Text(conversation.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                        supportingContent = { Text(messageDate(conversation.updatedAt)) },
                        trailingContent = if (conversation.unread > 0) { { Text("${conversation.unread} unread", style = MaterialTheme.typography.labelMedium) } } else null,
                        modifier = Modifier.clickable(onClickLabel = "Open conversation") { selected = conversation.id })
                    HorizontalDivider()
                }
                if (list.value?.conversations.isNullOrEmpty()) item { Text(when {
                    list.busy -> "Loading conversations…"
                    list.value == null -> "Refresh to load conversations."
                    else -> "No conversations yet."
                }, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp)) }
                list.value?.nextCursor?.let { next -> item { TextButton(onClick = { cursor = next }) { Text("More conversations") } } }
            }
        }
    }
}

@Composable private fun ColumnScope.ManagedConversationView(client: ManagedClient, model: PhoneModel, deviceId: String, id: String, compact: Boolean,
    onLock: (Boolean) -> Unit, onBack: () -> Unit, onRead: () -> Unit) {
    var before by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }
    var pending by remember { mutableStateOf<Pair<String, String>?>(null) }
    var sending by remember { mutableStateOf(false) }
    var sendError by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<ManagedConversation?>(null) }
    var meeting by remember { mutableStateOf<AndroidMeetingSession?>(null) }
    val context = LocalContext.current
    val phoneCalls by model.calls.collectAsState()
    val changing by (model.bridge?.changing ?: remember { kotlinx.coroutines.flow.MutableStateFlow(false) }).collectAsState()
    val phoneAudioWork by (model.bridge?.phoneAudioWork ?: remember { kotlinx.coroutines.flow.MutableStateFlow(false) }).collectAsState()
    val history = messageViewPage(deviceId, id, before) { client.conversationMessages(deviceId, id, before = before).let { it to it.scope.expiresAt } }
    val scope = rememberCoroutineScope()
    val scroll = rememberLazyListState()
    var read by remember { mutableStateOf(0L) }
    val page = history.value
    val sequence = page?.messages?.lastOrNull()?.sequence
    val locked = sending || pending != null || editing != null || meeting != null
    val navigationLocked = locked || draft.isNotEmpty()
    SideEffect { onLock(navigationLocked) }
    DisposableEffect(Unit) { onDispose { onLock(false) } }
    LaunchedEffect(history.denied) { if (history.denied) { draft = ""; pending = null; sendError = null; editing = null } }
    BackHandler { if (!navigationLocked) onBack() }
    LaunchedEffect(sequence, page?.scope?.expiresAt, before) {
        if (page != null && page.messages.isNotEmpty()) scroll.scrollToItem(if (before == null) page.messages.lastIndex else 0)
        if (sequence != null && sequence.toLong() > read) {
            try { client.markConversationRead(deviceId, id, sequence); read = sequence.toLong(); onRead() }
            catch (error: Exception) { if (error is CancellationException) throw error }
        }
    }
    fun send() {
        if (sending || page == null || page.scope.expiresAt <= System.currentTimeMillis()) return
        val input = pending ?: (UUID.randomUUID().toString() to draft)
        pending = input; sending = true; sendError = null; onLock(true)
        scope.launch {
            try { client.sendMessage(deviceId, id, input.first, input.second); pending = null; draft = ""; before = null; history.refresh(); onRead() }
            catch (error: Exception) {
                if (error is CancellationException) throw error
                sendError = messageError(error)
                if (definiteMessageFailure(error)) pending = null
                if (messageAccessLost(error)) { draft = ""; history.value = null; history.denied = true }
            } finally { sending = false }
        }
    }
    editing?.let { group ->
        NewManagedConversation(client, deviceId, compact, {}, onClose = { editing = null; history.value = null; scope.launch { history.refresh() } },
            group = group, userId = client.status.value.identity?.id.orEmpty(), onLeft = onBack) {
            editing = null; scope.launch { history.refresh(); onRead() }
        }
        return
    }
    meeting?.let { session ->
        Dialog(onDismissRequest = {}, properties = DialogProperties(usePlatformDefaultWidth = false, dismissOnBackPress = false, dismissOnClickOutside = false)) {
            Surface(Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp)) {
                    ManagedMeetingView(session, changing || phoneAudioWork || phoneCalls.any { it.state != "Ended" }) { meeting = null }
                }
            }
        }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        TextButton(onClick = onBack, enabled = !navigationLocked) { Text("Conversations") }
        TextButton(onClick = { scope.launch { history.refresh() } }, enabled = !history.busy) { Text("Refresh history") }
    }
    page?.let {
        TextButton(onClick = {
            onLock(true)
            meeting = AndroidMeetingSession(context.applicationContext, client, deviceId, id, model.scope,
                claimAudio = { model.bridge?.audioGuard?.claimMeeting() == true },
                releaseAudio = { model.bridge?.audioGuard?.releaseMeeting() })
        }, enabled = !locked) { Text("Meeting") }
        if (it.conversation.kind == "group" && it.conversation.revision != null)
            TextButton(onClick = { onLock(true); editing = it.conversation }, enabled = !locked) { Text("Group settings") }
        Text(it.conversation.title, style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(it.conversation.participants.joinToString(", ") { person -> person.name }, style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
    history.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    Row {
        if (before != null) TextButton(onClick = { before = null }, enabled = !sending) { Text("Latest messages") }
        TextButton(onClick = { before = page?.nextCursor }, enabled = page?.nextCursor != null && !sending) { Text("Older messages") }
    }
    LazyColumn(if (compact) Modifier.height(200.dp) else Modifier.weight(1f), state = scroll, verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 8.dp)) {
        items(page?.messages.orEmpty(), key = { it.id }) { message ->
            Column {
                Text("${if (message.senderId == page?.scope?.userId) "You" else message.senderName} · ${messageDate(message.createdAt)}",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(message.text)
            }
        }
        if (page?.messages.isNullOrEmpty()) item { Text(if (history.busy) "Loading messages…" else if (page == null) "Refresh history to load current messages." else "No messages yet.",
            color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
    OutlinedTextField(draft, { if (it.length <= 4096) { draft = it; onLock(locked || it.isNotEmpty()) } }, label = { Text("Message") }, enabled = !locked && !history.denied,
        minLines = 1, maxLines = 3, modifier = Modifier.fillMaxWidth())
    Text("${draft.length}/4096${page?.let { " · Kept for ${it.scope.retentionDays} days" } ?: ""}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    sendError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    if (pending != null && !sending) Text("This message may have been sent. Retry keeps the same message ID.", style = MaterialTheme.typography.bodySmall)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = ::send, enabled = !sending && page != null && !history.denied && (pending != null || validMessageText(draft))) {
            Text(if (sending) "Sending…" else if (pending != null) "Retry message" else "Send message")
        }
        if (!sending && (pending != null || draft.isNotEmpty())) TextButton(onClick = { pending = null; draft = ""; sendError = null }) {
            Text(if (pending == null) "Clear draft" else "Discard message")
        }
    }
}

@Composable private fun ColumnScope.NewManagedConversation(client: ManagedClient, deviceId: String, compact: Boolean, onLock: (Boolean) -> Unit,
    onClose: () -> Unit, group: ManagedConversation? = null, userId: String = "", onLeft: (() -> Unit)? = null, onCreated: (String) -> Unit) {
    var search by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }
    var cursor by remember { mutableStateOf<String?>(null) }
    var chosen by remember { mutableStateOf(group?.participants?.filter { it.id != userId }?.map { MessagePerson(it.id, it.name) }.orEmpty()) }
    var title by remember { mutableStateOf(group?.title.orEmpty()) }
    var working by remember { mutableStateOf(false) }
    data class Input(val id: String, val users: List<String>, val title: String, val ownerId: String? = null, val leave: Boolean = false)
    var pending by remember { mutableStateOf<Input?>(null) }
    var owner by remember { mutableStateOf(group?.ownerId.orEmpty()) }
    var ownerMenu by remember { mutableStateOf(false) }
    var confirmLeave by remember { mutableStateOf(false) }
    val canEdit = group == null || group.ownerId == userId
    var error by remember { mutableStateOf<String?>(null) }
    val people = messageViewPage(deviceId, query, cursor) { client.messagePeople(deviceId, query, cursor).let { it to it.scope.expiresAt } }
    val scope = rememberCoroutineScope()
    val locked = working || pending != null
    LaunchedEffect(locked) { onLock(locked) }
    DisposableEffect(Unit) { onDispose { onLock(false) } }
    LaunchedEffect(people.denied) { if (people.denied) onClose() }
    BackHandler { if (!locked) onClose() }
    fun create(leave: Boolean = false) {
        if (working || (!leave && (!canEdit || people.value == null || people.expiresAt <= System.currentTimeMillis()))) return
        val input = pending ?: Input(UUID.randomUUID().toString(), chosen.map { it.id }, if (group != null || chosen.size > 1) title.trim() else "", owner, leave)
        pending = input; working = true; error = null; onLock(true)
        scope.launch {
            try {
                if (input.leave) { client.leaveMessageGroup(deviceId, group!!.id); onLeft?.invoke() }
                else onCreated(if (group != null) client.updateMessageGroup(deviceId, group.id, group.revision!!, input.title, listOf(userId) + input.users, input.ownerId!!).id
                    else client.createConversation(deviceId, input.id, input.users, input.title).id)
            }
            catch (problem: Exception) {
                if (problem is CancellationException) throw problem
                error = messageError(problem)
                if (definiteMessageFailure(problem)) pending = null
                if (messageAccessLost(problem)) onClose()
            } finally { working = false }
        }
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text(if (group == null) "New conversation" else "Group settings", style = MaterialTheme.typography.titleLarge)
        TextButton(onClick = onClose, enabled = !locked) { Text("Cancel") }
    }
    if (canEdit) Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(search, { if (it.length <= 160) search = it }, label = { Text("Search people") }, singleLine = true,
            enabled = !locked, modifier = Modifier.weight(1f))
        TextButton(onClick = { query = search.trim(); cursor = null; scope.launch { people.refresh() } }, enabled = !locked) { Text("Search") }
    }
    if (chosen.isNotEmpty()) Text("Selected: ${chosen.joinToString(", ") { it.name }}", style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
    if (canEdit && (group != null || chosen.size > 1)) OutlinedTextField(title, { if (it.length <= 160) title = it }, label = { Text("Group name") }, singleLine = true,
        enabled = !locked, modifier = Modifier.fillMaxWidth())
    if (group != null) {
        Text("New members see messages sent after they join.", style = MaterialTheme.typography.bodySmall)
        if (canEdit) {
            Box {
                OutlinedButton(onClick = { ownerMenu = true }, enabled = !locked) { Text("Owner: ${if (owner == userId) "You" else chosen.find { it.id == owner }?.name.orEmpty()}") }
                DropdownMenu(ownerMenu, { ownerMenu = false }) {
                    (listOf(MessagePerson(userId, "You")) + chosen).forEach { person -> DropdownMenuItem(text = { Text(person.name) },
                        onClick = { owner = person.id; ownerMenu = false }) }
                }
            }
            LazyColumn(Modifier.heightIn(max = 120.dp)) { items(chosen, key = { it.id }) { person -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(person.name, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                TextButton(onClick = { chosen = chosen.filter { it.id != person.id }; if (owner == person.id) owner = userId }, enabled = !locked) { Text("Remove") }
            } } }
        } else Text("Only the group owner can change its name or people.", style = MaterialTheme.typography.bodySmall)
    }
    people.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    if (cursor != null) TextButton(onClick = { cursor = null }, enabled = !locked) { Text("First people") }
    if (canEdit) LazyColumn(if (compact) Modifier.height(200.dp) else Modifier.weight(1f)) {
        items(people.value?.people.orEmpty(), key = { it.id }) { person ->
            val checked = chosen.any { it.id == person.id }
            val enabled = !locked && (checked || chosen.size < 19)
            fun select() { chosen = if (checked) chosen.filter { it.id != person.id } else chosen + person; if (checked && owner == person.id) owner = userId }
            ListItem(headlineContent = { Text(person.name) }, leadingContent = {
                Checkbox(checked, { select() }, enabled = enabled)
            }, modifier = if (enabled) Modifier.clickable(onClickLabel = if (checked) "Remove person" else "Select person") { select() } else Modifier)
            HorizontalDivider()
        }
        if (people.value?.people.isNullOrEmpty()) item { Text(if (people.busy) "Loading people…" else if (people.value == null) "Refresh to load people." else "No people match your search.",
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp)) }
        people.value?.nextCursor?.let { next -> item { TextButton(onClick = { cursor = next }, enabled = !locked) { Text("More people") } } }
    }
    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    if (pending != null && !working) Text(if (group == null) "This conversation may have been created. Retry keeps the same conversation ID." else "This request may have completed. Retry keeps the same group change.", style = MaterialTheme.typography.bodySmall)
    Row {
        if (canEdit) Button(onClick = { create() }, enabled = !working && !people.denied && people.value != null && (group != null || chosen.isNotEmpty()) && (group == null && chosen.size == 1 || title.isNotBlank())) {
            Text(if (working) "Saving…" else if (pending != null) "Retry request" else if (group != null) "Save group" else "Start conversation")
        }
        if (pending != null && !working) TextButton(onClick = { pending = null; error = null }) { Text("Discard attempt") }
    }
    if (group != null && error != null && pending == null) TextButton(onClick = onClose, enabled = !working) { Text("Reload group") }
    if (group != null) TextButton(onClick = { confirmLeave = true; error = null }, enabled = !locked) { Text("Leave group") }
    if (confirmLeave) AlertDialog(onDismissRequest = { if (!working) { confirmLeave = false; pending = null } },
        title = { Text("Leave group?") }, text = { Column {
            Text("You will lose access to this group's messages. If you own it, ownership passes to a remaining member.")
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        } }, confirmButton = { TextButton(onClick = { create(true) }, enabled = !working) { Text(if (working) "Leaving…" else "Leave group") } },
        dismissButton = { TextButton(onClick = { confirmLeave = false; pending = null }, enabled = !working) { Text("Cancel") } })

}
