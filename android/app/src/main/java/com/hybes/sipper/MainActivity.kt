package com.hybes.sipper

import android.Manifest
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Image
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

class MainActivity : ComponentActivity() {
    private val model get() = (application as SipperApplication).model
    private var fullScreenCalls by mutableStateOf(true)
    private var afterPermission: (() -> Unit)? = null
    private val signIn = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        model.scope.launch { model.attempt { model.managed.finishSignIn(result.data) }; if (model.managed.status.value.signedIn) model.refreshManaged() }
    }
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) afterPermission?.invoke()
        else model.error.value = "Allow microphone access to make or answer calls."
        afterPermission = null
        CallPush.scheduleToken(this)
    }
    private val messagePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) model.setMessageNotifications(true)
        else model.error.value = "Allow notifications for Sipper in Android settings."
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        model.start()
        if (savedInstanceState == null) handleSetupIntent(intent)
        setContent { SipperTheme { PhoneScreen(model, ::withMicrophone, ::withMessageNotifications, fullScreenCalls) {
            model.scope.launch { model.attempt { signIn.launch(model.managed.signInIntent()) } }
        } } }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleSetupIntent(intent)
    }
    private fun handleSetupIntent(intent: Intent?) {
        MessageNotifications.fromIntent(intent)?.let { model.openMessageNotification(it) }
        val url = intent?.takeIf { it.action == Intent.ACTION_VIEW }?.data ?: return
        if (url.scheme == "sipper" && url.host == "setup") model.openSetupLink(url.toString())
        else if (url.scheme == "sipper" && url.host == "add-accounts") {
            intent?.data = null // Do not retain the credential-bearing link in activity state.
            model.scope.launch { model.reviewImport(url.toString()) }
        }
    }
    private fun withMessageNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            messagePermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else model.setMessageNotifications(true)
    }
    private fun withMicrophone(action: () -> Unit) {
        if (model.bridge?.audioGuard?.meetingClaimed?.value == true) {
            model.error.value = "Leave the meeting before making or answering a phone call."
            return
        }
        val needed = buildList {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (needed.isEmpty()) { action(); CallPush.scheduleToken(this) }
        else {
            afterPermission = action
            permissions.launch(needed.toTypedArray())
        }
    }
    override fun onResume() {
        super.onResume()
        fullScreenCalls = Build.VERSION.SDK_INT < 34 || getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
        CallPush.scheduleToken(this)
    }
}

@Composable internal fun SipperTheme(content: @Composable () -> Unit) {
    val colours = if (isSystemInDarkTheme()) darkColorScheme(
        primary = Color(0xFF62C9C6), onPrimary = Color(0xFF062120),
        primaryContainer = Color(0xFF173B44), onPrimaryContainer = Color(0xFF8FDCD9),
        secondary = Color(0xFF8FDCD9), onSecondary = Color(0xFF062120),
        secondaryContainer = Color(0xFF224044), onSecondaryContainer = Color(0xFFD8EFEC),
        tertiary = Color(0xFFBCD0CF), onTertiary = Color(0xFF0F2A30),
        tertiaryContainer = Color(0xFF22485A), onTertiaryContainer = Color(0xFFEEF5F4),
        background = Color(0xFF0E1516), onBackground = Color(0xFFE7EEED),
        surface = Color(0xFF182425), onSurface = Color(0xFFE7EEED),
        surfaceVariant = Color(0xFF2A3A3A), onSurfaceVariant = Color(0xFFA5B4B3),
        surfaceTint = Color(0xFF62C9C6), inverseSurface = Color(0xFFE7EEED),
        inverseOnSurface = Color(0xFF132322), inversePrimary = Color(0xFF1C7277),
        outline = Color(0xFF647674), outlineVariant = Color(0xFF2A3A3A),
        surfaceDim = Color(0xFF0E1516), surfaceBright = Color(0xFF2A3A3A),
        surfaceContainerLowest = Color(0xFF0E1516), surfaceContainerLow = Color(0xFF131E1F),
        surfaceContainer = Color(0xFF182425), surfaceContainerHigh = Color(0xFF223031),
        surfaceContainerHighest = Color(0xFF2A3A3A),
    ) else lightColorScheme(
        primary = Color(0xFF1C7277), onPrimary = Color.White,
        primaryContainer = Color(0xFFD8EFEC), onPrimaryContainer = Color(0xFF145A5E),
        secondary = Color(0xFF22485A), onSecondary = Color.White,
        secondaryContainer = Color(0xFFEEF3F2), onSecondaryContainer = Color(0xFF173B44),
        tertiary = Color(0xFF4A5958), onTertiary = Color.White,
        tertiaryContainer = Color(0xFFD8E0DF), onTertiaryContainer = Color(0xFF132322),
        background = Color(0xFFFBFBF9), onBackground = Color(0xFF132322),
        surface = Color.White, onSurface = Color(0xFF132322),
        surfaceVariant = Color(0xFFEEF3F2), onSurfaceVariant = Color(0xFF4A5958),
        surfaceTint = Color(0xFF1C7277), inverseSurface = Color(0xFF182425),
        inverseOnSurface = Color(0xFFE7EEED), inversePrimary = Color(0xFF62C9C6),
        outline = Color(0xFF647674), outlineVariant = Color(0xFFD8E0DF),
        surfaceDim = Color(0xFFD8E0DF), surfaceBright = Color.White,
        surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFFBFBF9),
        surfaceContainer = Color(0xFFEEF3F2), surfaceContainerHigh = Color(0xFFE6ECEB),
        surfaceContainerHighest = Color(0xFFD8E0DF),
    )
    MaterialTheme(colorScheme = colours, content = content)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun PhoneScreen(model: PhoneModel, withMicrophone: (() -> Unit) -> Unit, withMessageNotifications: () -> Unit, fullScreenCalls: Boolean, signIn: () -> Unit) {
    val context = LocalContext.current
    val accounts by model.accounts.collectAsState()
    val calls by model.calls.collectAsState()
    val newCallFrom by model.newCallFrom.collectAsState()
    val registrations by model.registrations.collectAsState()
    val history by model.history.collectAsState()
    val error by model.error.collectAsState()
    val ready by model.ready.collectAsState()
    val scope = rememberCoroutineScope()
    var page by rememberSaveable { mutableStateOf(0) }
    var messages by remember { mutableStateOf(false) }
    var messageNavigationLocked by remember { mutableStateOf(false) }
    val messageNotification by model.messageNotification.collectAsState()
    LaunchedEffect(messageNotification) { if (messageNotification != null) { page = 3; messages = true } }
    val setupLink by model.setupLink.collectAsState()
    val importing by model.importing.collectAsState()
    LaunchedEffect(importing, setupLink, messageNavigationLocked) {
        if (!messageNavigationLocked && (importing || setupLink.isNotEmpty())) page = 2
    }
    var number by rememberSaveable { mutableStateOf("") }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var draftFor by rememberSaveable { mutableStateOf<String?>(null) }
    var editor by remember { mutableStateOf<SipAccount?>(null) }
    var editing by remember { mutableStateOf(false) }
    LaunchedEffect(newCallFrom) {
        if (draftFor != newCallFrom) {
            draftFor = newCallFrom
            calls.find { it.id == newCallFrom }?.let { page = 0; selected = it.accountId; number = "" }
        }
    }
    BackHandler(enabled = newCallFrom != null) { model.returnToCalls() }
    LaunchedEffect(accounts) { if (accounts.none { it.id == selected && it.usable() }) selected = accounts.firstOrNull { it.usable() }?.id }
    Scaffold(
        modifier = Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)),
        topBar = { TopAppBar(title = { Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Image(painterResource(R.drawable.sipper_icon), contentDescription = null, modifier = Modifier.size(32.dp))
            Text("Sipper")
        } }) },
        bottomBar = { NavigationBar {
            listOf("Keypad", "Recents", "Accounts", "Directory").forEachIndexed { index, name ->
                NavigationBarItem(selected = page == index, onClick = { page = index }, enabled = !messageNavigationLocked || page == index, label = { Text(name) },
                    icon = { Icon(painterResource(listOf(R.drawable.ic_keypad, R.drawable.ic_history, R.drawable.ic_accounts, R.drawable.ic_directory)[index]),
                        contentDescription = null, modifier = Modifier.size(24.dp)) })
            }
        } },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).padding(horizontal = 20.dp)) {
            if (error != null && !importing) Card(Modifier.fillMaxWidth().padding(bottom = 12.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                Column(Modifier.padding(16.dp)) { Text(error!!); TextButton(onClick = { model.error.value = null }) { Text("Dismiss") } }
            }
            if (calls.isNotEmpty() && newCallFrom == null) {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.weight(1f)) {
                    items(calls.filter { it.state != "Ended" }.distinctBy { it.presentationId }, key = { it.presentationId }) { call -> CallCard(call, model, withMicrophone) {
                        scope.launch { model.prepareNewCall(call.id) }
                    } }
                }
            } else {
                calls.find { it.id == newCallFrom }?.let { call ->
                    TextButton(onClick = { model.returnToCalls() }, modifier = Modifier.fillMaxWidth()) { Text("Return to ${call.remote}") }
                    Text("Android holds your current call when the next call becomes active.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 12.dp))
                }
                when (page) {
                    0 -> Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("Call", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp))
                        var menu by remember { mutableStateOf(false) }
                        Box(Modifier.fillMaxWidth()) {
                            OutlinedButton(onClick = { if (selected == null) page = 2 else menu = true }, modifier = Modifier.fillMaxWidth()) {
                                Text(accounts.find { it.id == selected }?.title ?: "Set up a calling account")
                            }
                            DropdownMenu(menu, { menu = false }) { accounts.filter { it.usable() }.forEach { account ->
                                DropdownMenuItem(text = { Text(account.title) }, onClick = { selected = account.id; menu = false })
                            } }
                        }
                        if (selected != null) {
                            val status = registrations[selected]?.state ?: "unknown"
                            Text(status.replaceFirstChar(Char::titlecase), style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
                        }
                        OutlinedTextField(number, { if (it.length <= 512) number = it }, label = { Text(if (accounts.find { it.id == selected }?.managedMode == "gateway") "Phone number or extension" else "Number or SIP address") }, singleLine = true,
                            modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone))
                        DialPad { digit -> if (number.length < 512) number += digit }
                        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Button(onClick = { val id = selected; val target = number; withMicrophone { id?.let { scope.launch { model.dial(it, target) } } } },
                                enabled = ready && selected != null && number.isNotBlank(), modifier = Modifier.weight(1f).heightIn(min = 52.dp)) { Text("Call") }
                            OutlinedButton(onClick = { number = number.dropLast(1) }, enabled = number.isNotEmpty(), modifier = Modifier.heightIn(min = 52.dp)) { Text("Delete") }
                        }
                        accounts.find { it.id == selected }?.takeIf { it.voicemailNumber.isNotEmpty() }?.let { account ->
                            TextButton(onClick = { withMicrophone { scope.launch { model.dial(account.id, account.voicemailNumber) } } }, enabled = ready) { Text("Voicemail") }
                        }
                    }
                    1 -> {
                        Text("Recents", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(vertical = 12.dp))
                        if (history.isEmpty()) Text("Your calls will appear here.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        LazyColumn { items(history, key = { it.id }) { item ->
                            val account = runCatching { item.callingAccount(accounts) }.getOrNull()
                            ListItem(headlineContent = { Text(item.remote) }, supportingContent = {
                                Column {
                                    Text("${if (item.incoming) if (item.answered) "Incoming" else "Missed" else "Outgoing"} · ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(item.at))}")
                                    if (item.accountTitle.isNotBlank()) Text(account?.title ?: item.accountTitle)
                                    if (account == null) Text(if (item.destination == null) "Number unavailable" else "Account unavailable")
                                }
                            }, trailingContent = {
                                TextButton(onClick = { withMicrophone { scope.launch { model.dialRecent(item.id) } } }, enabled = ready && account != null,
                                    modifier = Modifier.semantics { contentDescription = "Call ${item.remote}" }) { Text("Call") }
                            })
                            HorizontalDivider()
                        } }
                    }
                    3 -> if (messages) ManagedMessagesView(model.managed, onDirectory = { messages = false }, onAccounts = { page = 2 }, notification = messageNotification,
                        onNotificationConsumed = { model.messageNotification.value = null }, onLock = { messageNavigationLocked = it }, model = model)
                    else CompanyDirectory(model.managed, accounts, ready, onAccounts = { page = 2 }, onMessages = { messages = true }) { deviceId, contactId, destination, accountId ->
                        withMicrophone { scope.launch { model.dialDirectory(deviceId, contactId, destination, accountId) } }
                    }
                    2 -> {
                        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Accounts", style = MaterialTheme.typography.headlineMedium)
                            TextButton(onClick = { editor = null; editing = true }, enabled = ready) { Text("Add account") }
                        }
                        LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(bottom = 16.dp)) {
                          item { TextButton(onClick = { model.importing.value = true }, enabled = ready) { Text("Import accounts") } }
                          item { ManagedAccountsCard(model, signIn, withMicrophone, withMessageNotifications) }
                          item { Text("Direct SIP accounts need Sipper to be running to receive calls.",
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                          if (!fullScreenCalls && Build.VERSION.SDK_INT >= 34) item {
                            Text("Full-screen calls are disabled. Allow them to see incoming calls while your phone is locked.",
                                style = MaterialTheme.typography.bodyMedium)
                            TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                                Uri.parse("package:${context.packageName}"))) }) { Text("Full-screen call settings") }
                          }
                          items(accounts, key = { it.id }) { account ->
                            OutlinedCard(onClick = { if (account.managedDeviceId == null) { editor = account; editing = true } }, modifier = Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(16.dp)) {
                                    Text(account.title, style = MaterialTheme.typography.titleMedium)
                                    Text(if (account.managedDeviceId == null) "${account.username}@${account.domain}" else "Managed by your organisation", style = MaterialTheme.typography.bodySmall)
                                    val registration = registrations[account.id]
                                    Text(if (!account.enabled) "Disabled" else (registration?.state ?: "Unknown").replaceFirstChar(Char::titlecase) + (registration?.code?.let { " · SIP $it" } ?: ""),
                                        color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 8.dp))
                                }
                            }
                        } }
                    }
                }
            }
        }
    }
    if (editing) AccountEditor(editor, model, onDismiss = { editing = false })
    if (importing && !messageNavigationLocked) AccountImportSheet(model)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun AccountImportSheet(model: PhoneModel) {
    val review by model.importReview.collectAsState()
    val error by model.error.collectAsState()
    val scope = rememberCoroutineScope()
    var link by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var selected by remember(review?.id) { mutableStateOf(review?.candidates?.filter { it.error == null && !it.updating }?.map { it.account.id }?.toSet() ?: emptySet()) }
    ModalBottomSheet(onDismissRequest = { if (!busy) model.cancelImport() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Import accounts", style = MaterialTheme.typography.headlineSmall)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (review == null) {
                OutlinedTextField(link, { if (it.length <= MAX_IMPORT_BYTES * 2 + 1024) link = it }, label = { Text("Sipper import link") },
                    singleLine = true, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
                Text("Paste a sipper://add-accounts link. The link contains passwords; Sipper does not upload it.")
                Button(onClick = { scope.launch { busy = true; try { if (model.reviewImport(link)) link = "" } finally { busy = false } } }, enabled = !busy && link.isNotBlank()) { Text("Review accounts") }
            } else {
                Text("Review the accounts before saving. Saving connects enabled accounts to the servers shown below.")
                review!!.candidates.forEach { candidate ->
                    Row(verticalAlignment = Alignment.Top) {
                        Checkbox(candidate.account.id in selected, { checked -> selected = if (checked) selected + candidate.account.id else selected - candidate.account.id },
                            enabled = !busy && candidate.error == null, modifier = Modifier.semantics { contentDescription = "Select ${candidate.account.title.take(160)}" })
                        Column(Modifier.weight(1f)) {
                            Text(candidate.account.title.take(160), style = MaterialTheme.typography.titleMedium)
                            Text(if (candidate.updating) "Update existing" else "New account")
                            if (candidate.error != null) Text(candidate.error, color = MaterialTheme.colorScheme.error)
                            else {
                                Text("${candidate.account.username}@${candidate.account.domain}")
                                Text("${candidate.account.host}:${candidate.account.port ?: if (candidate.account.transport == "tls") 5061 else 5060} · ${candidate.account.transport.uppercase()}")
                                Text("Media encryption: ${if (candidate.account.srtp == "disabled") "Off" else candidate.account.srtp.replaceFirstChar(Char::titlecase)}")
                            }
                        }
                    }
                    HorizontalDivider()
                }
                Text("Existing accounts are not selected. Selecting one replaces its password and connection settings, keeping its identity, history, enabled state and security preferences. Managed accounts are separate.", style = MaterialTheme.typography.bodySmall)
                Button(onClick = { scope.launch { busy = true; try { model.importAccounts(selected) } finally { busy = false } } }, enabled = !busy && selected.isNotEmpty()) { Text("Import selected accounts") }
            }
            TextButton(onClick = { link = ""; model.cancelImport() }, enabled = !busy) { Text("Cancel") }
        }
    }
}

@Composable private fun ManagedAccountsCard(model: PhoneModel, signIn: () -> Unit, withMicrophone: (() -> Unit) -> Unit, withMessageNotifications: () -> Unit) {
    val status by model.managed.status.collectAsState()
    val pushStatus by model.pushStatus.collectAsState()
    val messagePushStatus by model.messagePushStatus.collectAsState()
    val setupLink by model.setupLink.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var signOut by remember { mutableStateOf(false) }
    var disconnect by remember { mutableStateOf<ManagedConnection?>(null) }
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Sipper management", style = MaterialTheme.typography.titleMedium)
            status.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            if (status.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (status.signingIn) {
                Text("Complete sign-in in your browser.", style = MaterialTheme.typography.bodyMedium)
                TextButton(onClick = { model.managed.cancelSignIn() }) { Text("Cancel sign-in") }
            }
            if (!status.signedIn) {
                Text("Sign in with your work email to connect your organisation’s calling accounts.", style = MaterialTheme.typography.bodyMedium)
                Button(onClick = signIn, enabled = !status.busy && !status.signingIn) { Text("Sign in") }
                if (status.error != null) TextButton(onClick = { signOut = true }) { Text("Reset managed access") }
            } else {
                Text(status.identity?.email.orEmpty(), style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { scope.launch { model.refreshManaged() } }, enabled = !status.busy && !status.signingIn) { Text("Refresh") }
                    TextButton(onClick = { signOut = true }) { Text("Sign out") }
                }
                if (status.connections.isNotEmpty()) {
                    Text(pushStatus, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(if (CallPush.configured) messagePushStatus else "Message notifications are unavailable in this build.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (CallPush.configured) {
                        TextButton(onClick = { if (MessageNotifications.enabled(context)) model.setMessageNotifications(false) else withMessageNotifications() }) {
                            Text(if (MessageNotifications.enabled(context)) "Turn off message notifications" else "Enable message notifications")
                        }
                        TextButton(onClick = { withMicrophone { CallPush.scheduleToken(context) } }) { Text("Enable incoming calls") }
                        TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))) }) { Text("Call permissions") }
                    }
                }
                if (status.organisations.isEmpty()) Text("No organisations yet. Accept your invitation in the Sipper portal, then refresh.", style = MaterialTheme.typography.bodyMedium)
                status.organisations.forEach { org ->
                    val connection = status.connections.find { it.organisationId == org.id }
                    HorizontalDivider()
                    Text(org.name, style = MaterialTheme.typography.titleSmall)
                    Text(when {
                        org.status != "active" -> "Access suspended"
                        !org.licensed -> "Waiting for a licence"
                        connection?.configured == true -> "Settings received"
                        connection != null -> "Waiting for settings"
                        else -> "Ready to connect"
                    }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (connection == null) TextButton(onClick = { scope.launch { model.connectManaged(org.id) } }, enabled = !status.busy && !status.signingIn && org.status == "active" && org.licensed) { Text("Connect") }
                    else TextButton(onClick = { disconnect = connection }, enabled = !status.busy) { Text("Disconnect") }
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("Availability", modifier = Modifier.weight(1f))
                        Box {
                            var choosingAvailability by remember(org.id) { mutableStateOf(false) }
                            TextButton(onClick = { choosingAvailability = true },
                                enabled = !status.busy && !status.signingIn && org.status == "active" && org.availability != null,
                                modifier = Modifier.semantics { contentDescription = "Availability for ${org.name}" }) {
                                Text(org.availability?.label ?: "Unavailable")
                            }
                            DropdownMenu(choosingAvailability, { choosingAvailability = false }) {
                                ManagedAvailability.entries.forEach { value ->
                                    DropdownMenuItem(text = { Text(value.label) }, onClick = {
                                        choosingAvailability = false
                                        scope.launch { model.attempt { model.managed.setAvailability(org.id, value) } }
                                    })
                                }
                            }
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Do Not Disturb", style = MaterialTheme.typography.bodyMedium)
                            Text(when (org.doNotDisturb) { true -> "On"; false -> "Off"; null -> "Unavailable" },
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = { scope.launch { model.attempt { model.managed.setDoNotDisturb(org.id, org.doNotDisturb != true) } } },
                            enabled = !status.busy && !status.signingIn && org.status == "active" && org.doNotDisturb != null,
                            modifier = Modifier.semantics { contentDescription = "${if (org.doNotDisturb == true) "Turn off" else "Turn on"} Do Not Disturb for ${org.name}" }) {
                            Text(if (org.doNotDisturb == true) "Turn off" else "Turn on")
                        }
                    }
                }
                Text("Availability is your stated status for this customer and stays until changed or cleared; it does not change calling. Do Not Disturb applies across your devices. Gateway calls stop immediately; direct PBX calls stop after the app refreshes its settings. Calls already ringing or connected continue. Refresh to check an unavailable preference.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${model.managed.origin}/portal"))) }) {
                Text("Open management portal")
            }
            HorizontalDivider()
            OutlinedTextField(setupLink, { if (it.length <= 4096) model.setupLink.value = it },
                label = { Text("Setup link") }, singleLine = true, enabled = !status.busy && !status.signingIn,
                modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
            Text("Paste the link from your administrator and sign in with the invited email before connecting.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick = { scope.launch { model.connectSetupLink() } }, enabled = status.signedIn && !status.signingIn && !status.busy && setupLink.isNotBlank()) { Text("Connect with setup link") }
        }
    }
    if (signOut) AlertDialog(onDismissRequest = { signOut = false }, title = { Text("Sign out of Sipper management?") },
        text = { Text("Managed accounts will be removed from this device. Personal accounts and calls already connected are kept.") },
        confirmButton = { TextButton(onClick = { signOut = false; model.setupLink.value = ""; scope.launch { model.attempt { model.managed.signOut() } } }) { Text("Sign out") } },
        dismissButton = { TextButton(onClick = { signOut = false }) { Text("Cancel") } })
    disconnect?.let { connection -> AlertDialog(onDismissRequest = { disconnect = null }, title = { Text("Disconnect ${connection.name}?") },
        text = { Text("This organisation’s managed accounts will be removed from this device. Calls already connected are kept.") },
        confirmButton = { TextButton(onClick = { disconnect = null; scope.launch { model.attempt { model.managed.disconnect(connection.deviceId) } } }) { Text("Disconnect") } },
        dismissButton = { TextButton(onClick = { disconnect = null }) { Text("Cancel") } }) }
}

@Composable private fun DialPad(onDigit: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.widthIn(max = 420.dp)) {
        listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("*", "0", "#")).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { digit -> FilledTonalButton(onClick = { onDigit(digit) }, modifier = Modifier.weight(1f).heightIn(min = 56.dp)) { Text(digit, fontSize = 24.sp) } }
            }
        }
    }
}

@Composable internal fun CallCard(call: PhoneCall, model: PhoneModel, withMicrophone: (() -> Unit) -> Unit,
    allowOtherCalls: Boolean = true, onAddCall: () -> Unit) {
    val scope = rememberCoroutineScope()
    var keypad by remember { mutableStateOf(false) }
    var routeMenu by remember { mutableStateOf(false) }
    var transfer by remember { mutableStateOf(false) }
    var merge by remember { mutableStateOf(false) }
    var participantKeypad by remember { mutableStateOf<String?>(null) }
    val calls by model.calls.collectAsState()
    val members = calls.presentationMembers(call.presentationId)
    val conference = call.conferenceId
    val accounts by model.accounts.collectAsState()
    val account = accounts.firstOrNull { it.id == call.accountId }
    val canTransfer = conference == null && call.connected && call.state != "Ended" && !call.transferring && account?.usable() == true
    val routes by model.bridge!!.routes.collectAsState()
    val changing by model.bridge!!.changing.collectAsState()
    val peers = if (allowOtherCalls && canTransfer) calls.filter { it.id != call.id && it.accountId == call.accountId &&
        it.connected && it.state != "Ended" && !it.transferring && it.conferenceId == null } else emptyList()
    LaunchedEffect(members, changing) {
        if (changing || members.none { it.id == participantKeypad && !it.held }) participantKeypad = null
    }
    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(if (conference != null) "Conference" else call.remote, style = MaterialTheme.typography.titleLarge)
        Text(if (conference != null) when {
            members.all { it.held } -> "On hold"
            members.any { it.held } -> "Some participants are on hold"
            else -> "Connected"
        } else call.state)
        call.transferStatus?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        if (call.incoming && !call.connected) Button(onClick = { withMicrophone { scope.launch { model.callAction(call.id, "answer") } } }) { Text("Answer") }
        if (call.connected) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { scope.launch { model.callAction(call.id, "mute", call.presentationId) } }, enabled = !changing) { Text(if (call.muted) "Unmute" else "Mute") }
                OutlinedButton(onClick = { withMicrophone { scope.launch { model.callAction(call.id, "hold", call.presentationId) } } }, enabled = !changing) { Text(if (members.any { it.held }) "Resume" else "Hold") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (conference == null) OutlinedButton(onClick = { keypad = !keypad }, enabled = !changing && !call.held) { Text("Keypad") }
                Box {
                    OutlinedButton(onClick = { routeMenu = true }, enabled = !changing) { Text("Audio") }
                    DropdownMenu(routeMenu, { routeMenu = false }) { routes[call.id]?.forEach { endpoint ->
                        DropdownMenuItem(text = { Text(endpoint.name.toString()) }, onClick = {
                            routeMenu = false; scope.launch { model.attempt { model.bridge?.route(call.id, endpoint) } }
                        })
                    } }
                }
            }
            if (keypad && conference == null && !call.held && !changing) DialPad { digit -> scope.launch { model.attempt { model.engine.dtmf(call.id, digit) } } }
            if (canTransfer) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onAddCall, enabled = !changing) { Text("Add call") }
                if (allowOtherCalls) OutlinedButton(onClick = { transfer = true }, enabled = !changing) { Text("Transfer") }
            }
            if (peers.isNotEmpty()) OutlinedButton(onClick = { merge = true }, enabled = !changing) { Text("Merge calls") }
            if (conference != null) members.forEach { participant ->
                HorizontalDivider()
                Text(participant.remote, style = MaterialTheme.typography.titleMedium)
                Text(participant.state, style = MaterialTheme.typography.bodyMedium)
                OutlinedButton(onClick = { participantKeypad = participant.id.takeUnless { it == participantKeypad } },
                    enabled = !changing && !participant.held) { Text(if (participantKeypad == participant.id) "Close keypad" else "Keypad") }
                if (participantKeypad == participant.id && !participant.held && !changing) DialPad { digit -> scope.launch {
                    model.attempt { model.engine.dtmf(participant.id, digit, conference) }
                } }
                OutlinedButton(onClick = { withMicrophone { scope.launch { model.attempt { model.bridge?.separate(participant.id, conference) } } } },
                    enabled = !changing) { Text("Separate") }
                TextButton(onClick = { scope.launch { model.attempt { model.bridge?.endParticipant(participant.id, conference) } } }) { Text("Remove participant") }
            }
        }
        Button(onClick = { scope.launch { model.callAction(call.id, "hangup", call.presentationId) } }, colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)) {
            Text(if (conference != null) "End conference" else if (call.incoming && !call.connected) "Decline" else "End call")
        }
    } }
    if (transfer && allowOtherCalls) TransferSheet(call, model, canTransfer && !changing, account?.managedMode == "gateway") { transfer = false }
    if (merge && allowOtherCalls) AlertDialog(onDismissRequest = { merge = false }, title = { Text("Merge calls") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Choose the other call on this account.")
            peers.forEach { peer -> OutlinedButton(onClick = {
                merge = false
                withMicrophone { scope.launch { model.attempt { model.bridge?.merge(call.id, peer.id) } } }
            }, enabled = !changing) { Text(peer.remote) } }
            if (peers.isEmpty()) Text("There are no other connected calls on this account.")
        } }, confirmButton = {}, dismissButton = { TextButton(onClick = { merge = false }) { Text("Cancel") } })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun TransferSheet(call: PhoneCall, model: PhoneModel, available: Boolean, gateway: Boolean, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val calls by model.calls.collectAsState()
    var target by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val submit: (suspend () -> Unit) -> Unit = { action -> scope.launch {
        submitting = true; failure = null
        if (model.attempt(action)) onDismiss() else { failure = model.error.value; model.error.value = null }
        submitting = false
    } }
    ModalBottomSheet(onDismissRequest = { if (!submitting) onDismiss() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Transfer call", style = MaterialTheme.typography.headlineSmall)
            if (!available) Text("This call is no longer available to transfer.")
            failure?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            OutlinedTextField(target, { target = it }, label = { Text(if (gateway) "Phone number or extension" else "Phone number or SIP address") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Button(onClick = { submit { model.engine.transfer(call.id, target) } }, enabled = available && !submitting && target.isNotBlank()) { Text("Transfer now") }
            HorizontalDivider()
            Text("Transfer to another call", style = MaterialTheme.typography.titleMedium)
            val peers = calls.filter { it.id != call.id && it.accountId == call.accountId && it.connected && it.state != "Ended" && !it.transferring && it.conferenceId == null }
            if (peers.isEmpty()) Text("Choose Add call to speak to someone on the same account, then return here to complete the transfer.")
            peers.forEach { peer ->
                OutlinedButton(onClick = { submit { model.engine.attendedTransfer(call.id, peer.id) } }, enabled = available && !submitting) { Text(peer.remote) }
            }
            TextButton(onClick = onDismiss, enabled = !submitting) { Text("Cancel") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun AccountEditor(existing: SipAccount?, model: PhoneModel, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var account by remember { mutableStateOf(existing ?: SipAccount(label = "", username = "", password = "", domain = "")) }
    var port by remember { mutableStateOf(existing?.port?.toString() ?: "") }
    var validation by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var advanced by remember { mutableStateOf(false) }
    var delete by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = { if (!saving) onDismiss() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (existing == null) "Add account" else "Edit account", style = MaterialTheme.typography.headlineSmall)
            validation?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            OutlinedTextField(account.label, { account = account.copy(label = it) }, label = { Text("Account name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(account.username, { account = account.copy(username = it.trim()) }, label = { Text("SIP username") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(account.password, { account = account.copy(password = it) }, label = { Text("Password") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(account.domain, { account = account.copy(domain = it.trim()) }, label = { Text("SIP domain") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(account.server, { account = account.copy(server = it.trim()) }, label = { Text("Server (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            TextButton(onClick = { advanced = !advanced }) { Text(if (advanced) "Hide connection settings" else "Connection settings") }
            if (advanced) {
                Text("Transport", style = MaterialTheme.typography.labelLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("tls", "tcp", "udp").forEach { value ->
                    FilterChip(account.transport == value, { account = account.copy(transport = value) }, { Text(value.uppercase()) })
                } }
                OutlinedTextField(port, { port = it }, label = { Text("Port (optional)") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(account.authUsername, { account = account.copy(authUsername = it) }, label = { Text("Authentication username (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(account.displayName, { account = account.copy(displayName = it) }, label = { Text("Caller display name (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(account.voicemailNumber, { account = account.copy(voicemailNumber = it) }, label = { Text("Voicemail number (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(account.stunServer, { account = account.copy(stunServer = it.trim()) }, label = { Text("STUN server (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("Media encryption", style = MaterialTheme.typography.labelLarge)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("required", "optional", "disabled").forEach { value ->
                    FilterChip(account.srtp == value, { account = account.copy(srtp = value) }, { Text(value.replaceFirstChar(Char::titlecase)) })
                } }
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(account.ice, { account = account.copy(ice = it) }); Text("Use ICE for connectivity") }
            }
            Button(onClick = { scope.launch {
                saving = true
                try {
                    require(port.isBlank() || port.toIntOrNull() != null) { "Enter a valid port." }
                    val next = account.copy(port = port.toIntOrNull()); next.validate(personal = true)
                    if (model.save(next)) onDismiss() else validation = model.error.value
                } catch (e: IllegalArgumentException) { validation = e.message }
                finally { saving = false }
            } }, enabled = !saving, modifier = Modifier.fillMaxWidth()) { Text(if (saving) "Saving…" else "Save account") }
            if (existing != null) TextButton(onClick = { delete = true }, enabled = !saving) { Text("Remove account", color = MaterialTheme.colorScheme.error) }
        }
    }
    if (delete) AlertDialog(onDismissRequest = { delete = false }, title = { Text("Remove this account?") }, text = { Text("Its saved SIP details will be removed from this device.") },
        confirmButton = { TextButton(onClick = { scope.launch { if (model.remove(account)) { delete = false; onDismiss() } else { delete = false; validation = model.error.value } } }) { Text("Remove") } },
        dismissButton = { TextButton(onClick = { delete = false }) { Text("Cancel") } })
}
