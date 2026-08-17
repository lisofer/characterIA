package com.lisofer.characteria

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DeleteSweep
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CharacterTheme {
                val vm: CharacterViewModel = viewModel()
                CharacterApp(vm)
            }
        }
    }
}

private val Bg = Color(0xFF071019)
private val Surface = Color(0xFF0F1B27)
private val Surface2 = Color(0xFF122433)
private val Mint = Color(0xFF67E8B4)
private val Sky = Color(0xFF4DC7F5)
private val Muted = Color(0xFFA7B6C8)
private val Danger = Color(0xFFFF718B)

@Composable
private fun CharacterTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = androidx.compose.material3.darkColorScheme(
            primary = Mint,
            secondary = Sky,
            background = Bg,
            surface = Surface,
            surfaceVariant = Surface2,
            onBackground = Color(0xFFF3F7FC),
            onSurface = Color(0xFFF3F7FC),
        ),
        content = content,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CharacterApp(vm: CharacterViewModel) {
    val state by vm.ui.collectAsStateWithLifecycle()
    val context = androidx.compose.ui.platform.LocalContext.current
    var showDiagnostics by remember { mutableStateOf(false) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) vm.connect()
        else vm.setSettingsOpen(true)
    }

    val invocationPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) vm.toggleBackgroundMode()
        else vm.setSettingsOpen(true)
    }

    val voicePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        uri?.let(vm::importVoiceSample)
    }

    Scaffold(
        containerColor = Bg,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("CharacterIA Visión", fontWeight = FontWeight.Black)
                        Text(
                            (state.activeCharacterNames.takeIf { it.size > 1 }?.joinToString(" + ") ?: state.config.profileName.ifBlank { "Sin perfil" }),
                            style = MaterialTheme.typography.labelSmall,
                            color = Muted,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Bg),
                actions = {
                    IconButton(
                        onClick = {
                            if (state.backgroundModeEnabled) {
                                vm.toggleBackgroundMode()
                            } else {
                                val permission = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                                if (permission == PackageManager.PERMISSION_GRANTED) vm.toggleBackgroundMode()
                                else invocationPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        }
                    ) {
                        Icon(
                            Icons.Default.RecordVoiceOver,
                            contentDescription = if (state.backgroundModeEnabled) "Apagar modo invocación" else "Activar modo invocación",
                            tint = if (state.backgroundModeEnabled) Mint else Muted,
                        )
                    }
                    IconButton(onClick = { showDiagnostics = true }) {
                        Icon(Icons.Default.DeleteSweep, contentDescription = "Diagnóstico")
                    }
                    IconButton(onClick = { vm.setSettingsOpen(true) }) {
                        Icon(Icons.Default.Settings, contentDescription = "Configuración")
                    }
                }
            )
        },
        bottomBar = {
            BottomControls(
                state = state,
                onConnect = {
                    val permission = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                    if (permission == PackageManager.PERMISSION_GRANTED) vm.connect()
                    else permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                },
                onDisconnect = vm::disconnect,
                onClear = vm::clearChat,
            )
        }
    ) { padding ->
        Conversation(
            modifier = Modifier.padding(padding),
            state = state,
        )
    }

    if (state.settingsOpen) {
        SettingsSheet(
            state = state,
            onDismiss = { vm.setSettingsOpen(false) },
            onConfig = vm::updateConfig,
            onModelSelected = vm::selectGeminiModel,
            onPickVoice = { voicePicker.launch(arrayOf("audio/*")) },
            onSelectProfile = vm::selectProfile,
            onNewProfile = vm::newProfile,
            onSave = vm::saveConfig,
        )
    }

    if (showDiagnostics) {
        AlertDialog(
            onDismissRequest = { showDiagnostics = false },
            title = { Text("Diagnóstico") },
            text = {
                SelectionContainer {
                    LazyColumn(modifier = Modifier.height(420.dp)) {
                        items(state.diagnostics) { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showDiagnostics = false }) { Text("Cerrar") }
            }
        )
    }
}

@Composable
private fun Conversation(modifier: Modifier, state: AppUiState) {
    val listState = rememberLazyListState()
    LaunchedEffect(state.messages.size, state.messages.lastOrNull()?.text) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
    }

    Column(modifier = modifier.fillMaxSize()) {
        StatusHero(state)
        com.lisofer.characteria.vision.VisionAvatarHost(state)
        if (state.messages.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(32.dp)) {
                    Text("Hablá normalmente.", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "El chat de ${state.config.profileName.ifBlank { "este perfil" }} se guarda en este teléfono hasta que lo borres.",
                        color = Muted,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(horizontal = 14.dp),
                state = listState,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.messages, key = { it.id }) { message ->
                    MessageBubble(message, state.config.profileName)
                }
                item { Spacer(Modifier.height(20.dp)) }
            }
        }
    }
}

@Composable
private fun StatusHero(state: AppUiState) {
    val active = state.status in setOf(
        SessionStatus.LISTENING,
        SessionStatus.THINKING,
        SessionStatus.SPEAKING,
        SessionStatus.INVOCATION_ARMED,
        SessionStatus.INVOCATION_ACTIVE,
    )
    val color = when (state.status) {
        SessionStatus.ERROR -> Danger
        SessionStatus.SPEAKING -> Sky
        SessionStatus.LISTENING, SessionStatus.INVOCATION_ACTIVE -> Mint
        SessionStatus.INVOCATION_ARMED -> Color(0xFFFFC857)
        SessionStatus.CONNECTING, SessionStatus.RECONNECTING, SessionStatus.THINKING -> Color(0xFFFFC857)
        else -> Color(0xFF657589)
    }

    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier.size(14.dp).background(color.copy(alpha = if (active) 1f else .7f), CircleShape)
        )
        Column(Modifier.weight(1f)) {
            Text(state.statusDetail, fontWeight = FontWeight.SemiBold)
            val subtitle = when (state.status) {
                SessionStatus.LISTENING -> "Micrófono activo · podés interrumpir"
                SessionStatus.SPEAKING -> "Fish Audio · ${state.config.profileName.ifBlank { "voz clonada" }}"
                SessionStatus.INVOCATION_ARMED -> "Segundo plano · «[personaje], are you here?»"
                SessionStatus.INVOCATION_ACTIVE -> "Cambiar: «[personaje], are you here?» · salir: «get out»"
                SessionStatus.RECONNECTING -> "Recuperando el contexto del perfil"
                else -> state.activeGeminiModel
            }
            Text(subtitle, style = MaterialTheme.typography.labelSmall, color = Muted)
        }
    }
}

@Composable
private fun MessageBubble(message: ChatMessage, aiName: String) {
    val isUser = message.speaker == Speaker.USER
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(.82f).alpha(if (message.isPartial) .76f else 1f),
            colors = CardDefaults.cardColors(
                containerColor = if (isUser) Color(0xFF173C55) else Color(0xFF153426)
            ),
            shape = RoundedCornerShape(18.dp),
        ) {
            Column(Modifier.padding(14.dp)) {
                Text(
                    if (isUser) "VOS" else message.characterName.ifBlank { aiName.ifBlank { "CHARACTER" } }.uppercase(),
                    style = MaterialTheme.typography.labelSmall,
                    color = Muted,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.height(4.dp))
                Text(message.text)
            }
        }
    }
}

@Composable
private fun BottomControls(
    state: AppUiState,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onClear: () -> Unit,
) {
    val connected = !state.backgroundModeEnabled &&
        state.status != SessionStatus.DISCONNECTED &&
        state.status != SessionStatus.ERROR
    Row(
        modifier = Modifier.fillMaxWidth().background(Surface).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        OutlinedButton(onClick = onClear) {
            Icon(Icons.Default.DeleteSweep, contentDescription = "Borrar chat de este perfil")
        }
        Button(
            modifier = Modifier.weight(1f).height(54.dp),
            onClick = if (connected) onDisconnect else onConnect,
            enabled = !state.backgroundModeEnabled,
            colors = ButtonDefaults.buttonColors(
                containerColor = if (connected) Color(0xFF612536) else Mint,
                contentColor = if (connected) Color.White else Color(0xFF042117),
            )
        ) {
            Icon(if (connected) Icons.Default.Stop else Icons.Default.Mic, contentDescription = null)
            Spacer(Modifier.size(8.dp))
            Text(
                when {
                    state.backgroundModeEnabled -> "Modo invocación activo"
                    connected -> "Desconectar"
                    else -> "Conectar"
                },
                fontWeight = FontWeight.Black,
            )
        }
        FilledIconButton(onClick = { }, enabled = false) {
            Icon(Icons.Default.Mic, contentDescription = null)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsSheet(
    state: AppUiState,
    onDismiss: () -> Unit,
    onConfig: ((AppConfig) -> AppConfig) -> Unit,
    onModelSelected: (String) -> Unit,
    onPickVoice: () -> Unit,
    onSelectProfile: (String) -> Unit,
    onNewProfile: () -> Unit,
    onSave: () -> Unit,
) {
    val c = state.config
    var modelMenu by remember { mutableStateOf(false) }
    var profileMenu by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Surface) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item {
                Text("Perfiles", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Black)
                Text(
                    "Cada perfil guarda su propia voz, personalidad, video y conversación.",
                    color = Muted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            item {
                Box {
                    OutlinedButton(onClick = { profileMenu = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("Perfil: ${c.profileName.ifBlank { "Sin nombre" }}")
                    }
                    DropdownMenu(expanded = profileMenu, onDismissRequest = { profileMenu = false }) {
                        state.profiles.forEach { profile ->
                            DropdownMenuItem(
                                text = { Text(profile.name) },
                                onClick = {
                                    onSelectProfile(profile.id)
                                    profileMenu = false
                                }
                            )
                        }
                    }
                }
            }
            item {
                OutlinedButton(onClick = onNewProfile, modifier = Modifier.fillMaxWidth()) {
                    Text("+ Nuevo perfil")
                }
            }
            item {
                OutlinedTextField(
                    value = c.profileName,
                    onValueChange = { value -> onConfig { it.copy(profileName = value) } },
                    label = { Text("Nombre del perfil") },
                    placeholder = { Text("Ej. Lisandro") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                Text("Conexión", fontWeight = FontWeight.Black)
                Text(
                    "Las API keys y el modelo de Gemini son globales: todos los personajes usan siempre la misma conexión. Las claves quedan cifradas con Android Keystore.",
                    color = Muted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            item {
                OutlinedTextField(
                    value = c.geminiApiKey,
                    onValueChange = { value -> onConfig { it.copy(geminiApiKey = value) } },
                    label = { Text("Gemini API key") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                OutlinedTextField(
                    value = c.fishApiKey,
                    onValueChange = { value -> onConfig { it.copy(fishApiKey = value) } },
                    label = { Text("Fish Audio API key") },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                Box {
                    OutlinedButton(onClick = { modelMenu = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("Modelo preferido: ${c.geminiModel}")
                    }
                    DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }) {
                        GEMINI_LIVE_MODELS.forEach { model ->
                            DropdownMenuItem(
                                text = { Text(model.label) },
                                onClick = {
                                    onModelSelected(model.id)
                                    modelMenu = false
                                }
                            )
                        }
                    }
                }
                Text(
                    if (state.activeGeminiModel != c.geminiModel) {
                        "Activo ahora: ${state.activeGeminiModel} por fallback. Si cambiás la API de Gemini, vuelve automáticamente al modelo preferido."
                    } else {
                        "Activo ahora: ${state.activeGeminiModel}. Si agota cuota, CharacterIA baja temporalmente al siguiente modelo Live disponible."
                    },
                    color = Muted,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            item {
                Column {
                    Text("Muestra de voz", fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(6.dp))
                    OutlinedButton(onClick = onPickVoice, modifier = Modifier.fillMaxWidth()) {
                        Text(if (state.hasVoiceSample) "Cambiar · ${c.voiceName}" else "Cargar audio de referencia")
                    }
                    Text("El audio queda guardado solamente en este perfil.", color = Muted, style = MaterialTheme.typography.labelSmall)
                }
            }
            item {
                OutlinedTextField(
                    value = c.voiceTranscript,
                    onValueChange = { value -> onConfig { it.copy(voiceTranscript = value) } },
                    label = { Text("Transcripción exacta del audio") },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                Column {
                    Text("Velocidad de voz: ${"%.2f".format(c.voiceSpeed)}×", fontWeight = FontWeight.Bold)
                    Slider(
                        value = c.voiceSpeed,
                        onValueChange = { value -> onConfig { it.copy(voiceSpeed = value) } },
                        valueRange = .85f..1.15f,
                    )
                }
            }
            item {
                OutlinedTextField(
                    value = c.personality,
                    onValueChange = { value -> onConfig { it.copy(personality = value) } },
                    label = { Text("Personalidad (opcional)") },
                    placeholder = { Text("Escribí acá cómo querés que hable este personaje") },
                    minLines = 8,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                com.lisofer.characteria.vision.VisionProfileSettings(c.profileId)
            }
            item {
                Text(
                    "El chat de este perfil se conserva automáticamente. Al reconectar, Gemini recibe el historial reciente para continuar la conversación.",
                    color = Muted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            item {
                Button(onClick = onSave, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Text("Guardar perfil", fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.height(32.dp))
            }
        }
    }
}
