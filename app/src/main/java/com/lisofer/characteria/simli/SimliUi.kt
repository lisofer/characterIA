package com.lisofer.characteria.simli

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lisofer.characteria.AppConfig
import com.lisofer.characteria.AppUiState
import com.lisofer.characteria.SessionStatus
import io.livekit.android.renderer.TextureViewRenderer

@Composable
fun SimliRuntimeEffect(state: AppUiState) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val c = state.config
    val groupMode = state.activeCharacterNames.size > 1
    val shouldRun = state.status != SessionStatus.DISCONNECTED &&
        state.status != SessionStatus.ERROR &&
        !groupMode &&
        (!state.backgroundModeEnabled || state.invocationActive)

    LaunchedEffect(
        c.profileId,
        c.simliEnabled,
        c.simliApiKey,
        c.simliFaceId,
        shouldRun,
    ) {
        SimliRuntime.configure(
            context = context,
            apiKey = c.simliApiKey,
            faceId = c.simliFaceId,
            enabled = c.simliEnabled,
            shouldRun = shouldRun,
        )
    }
}

@Composable
fun SimliAvatarPanel(modifier: Modifier = Modifier) {
    val runtime by SimliRuntime.state.collectAsStateWithLifecycle()
    if (!runtime.enabled && !runtime.connecting) return

    Card(
        modifier = modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 4.dp),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFF08131D)),
    ) {
        Box(
            modifier = Modifier.fillMaxWidth().aspectRatio(16f / 10f).background(Color.Black),
            contentAlignment = Alignment.Center,
        ) {
            AndroidView(
                modifier = Modifier.fillMaxWidth().aspectRatio(16f / 10f),
                factory = { context ->
                    TextureViewRenderer(context).also { renderer ->
                        renderer.setMirror(false)
                        renderer.isOpaque = true
                        SimliRuntime.bindRenderer(renderer)
                    }
                },
                update = { renderer -> SimliRuntime.bindRenderer(renderer) },
                onRelease = { renderer ->
                    SimliRuntime.bindRenderer(null)
                    runCatching { renderer.release() }
                },
            )
            if (!runtime.videoReady) {
                Text(
                    runtime.status,
                    modifier = Modifier.padding(18.dp),
                    color = Color.White.copy(alpha = .82f),
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
        Text(
            runtime.status,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            color = if (runtime.videoReady) Color(0xFF67E8B4) else Color(0xFFA7B6C8),
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

@Composable
fun SimliSettingsFields(
    config: AppConfig,
    onConfig: ((AppConfig) -> AppConfig) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Avatar Simli", fontWeight = FontWeight.Black)
        Text(
            "Simli recibe el audio de Fish y devuelve cara + audio sincronizados por LiveKit. La API key es global; el Face ID pertenece a este personaje.",
            color = Color(0xFFA7B6C8),
            style = MaterialTheme.typography.bodySmall,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Usar avatar Simli", fontWeight = FontWeight.SemiBold)
                Text(
                    "Se desactiva automáticamente si invocás dos personajes.",
                    color = Color(0xFFA7B6C8),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            Switch(
                checked = config.simliEnabled,
                onCheckedChange = { value -> onConfig { it.copy(simliEnabled = value) } },
            )
        }
        OutlinedTextField(
            value = config.simliApiKey,
            onValueChange = { value -> onConfig { it.copy(simliApiKey = value) } },
            label = { Text("Simli API key") },
            visualTransformation = PasswordVisualTransformation(),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = config.simliFaceId,
            onValueChange = { value -> onConfig { it.copy(simliFaceId = value) } },
            label = { Text("Face ID de este personaje") },
            placeholder = { Text("Ej. 8f4c…") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
