package com.lisofer.characteria.vision

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.lisofer.characteria.AppUiState
import com.lisofer.characteria.musetalk.MuseTalkAvatar
import com.lisofer.characteria.musetalk.MuseTalkAvatarStore
import com.lisofer.characteria.musetalk.MuseTalkModelStore
import com.lisofer.characteria.musetalk.MuseTalkOrtEngine
import com.lisofer.characteria.musetalk.pretty
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

private val Panel = Color(0xFF0B1722)
private val Muted = Color(0xFFA7B6C8)
private val Accent = Color(0xFF67E8B4)

/**
 * MuseTalk branch: no overlays, no visemas y no boca recortada.
 * Hasta que el renderer neural emita frames, sólo se ve el loop fuente sin audio.
 */
@Composable
fun VisionAvatarHost(state: AppUiState) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val revision by MuseTalkAvatarStore.updates.collectAsStateWithLifecycle()

    val profileId = remember(state.config.profileId, state.activeCharacterNames, state.profiles) {
        when {
            state.activeCharacterNames.size > 1 -> null // regla original: 2 personajes = sin video.
            state.activeCharacterNames.size == 1 -> {
                val name = state.activeCharacterNames.first()
                state.profiles.firstOrNull { it.name.equals(name, ignoreCase = true) }?.id
            }
            else -> state.config.profileId.takeIf { it.isNotBlank() }
        }
    }

    val avatar = remember(profileId, revision) {
        profileId?.let { MuseTalkAvatarStore.load(context, it) }
    }

    avatar?.let {
        MuseTalkAvatarStage(it)
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
fun VisionProfileSettings(profileId: String) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val avatarRevision by MuseTalkAvatarStore.updates.collectAsStateWithLifecycle()
    val modelState by MuseTalkModelStore.state.collectAsStateWithLifecycle()

    var importing by remember(profileId) { mutableStateOf(false) }
    var avatarFeedback by remember(profileId) { mutableStateOf<String?>(null) }
    var benchmarkRunning by remember { mutableStateOf(false) }
    var benchmarkText by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { MuseTalkModelStore.refresh(context) }

    val avatar = remember(profileId, avatarRevision) {
        MuseTalkAvatarStore.load(context, profileId)
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null || profileId.isBlank()) return@rememberLauncherForActivityResult
        scope.launch {
            importing = true
            avatarFeedback = "Guardando video fuente…"
            runCatching { MuseTalkAvatarStore.importVideo(context, profileId, uri) }
                .onSuccess { avatarFeedback = "✓ Video listo para MuseTalk. No se modificó la boca." }
                .onFailure { avatarFeedback = it.message ?: "No pude guardar el video" }
            importing = false
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(Panel)
            .padding(14.dp)
    ) {
        Text("Avatar neural · MuseTalk Local", fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text(
            "Experimental. MuseTalk 1.5 corre dentro del teléfono mediante ONNX Runtime. No usa la boca por recortes de las versiones anteriores. El audio Fish conserva prioridad absoluta.",
            color = Muted,
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(12.dp))

        Text("1 · Video del personaje", color = Accent, style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))
        if (avatar == null) {
            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = !importing && profileId.isNotBlank(),
                onClick = { picker.launch(arrayOf("video/mp4")) },
            ) { Text(if (importing) "Guardando…" else "Cargar MP4 del personaje") }
        } else {
            Text("✓ ${avatar.displayName}", color = Accent, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(6.dp))
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !importing,
                onClick = { picker.launch(arrayOf("video/mp4")) },
            ) { Text(if (importing) "Guardando…" else "Cambiar video") }
            TextButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !importing,
                onClick = {
                    MuseTalkAvatarStore.remove(context, profileId)
                    avatarFeedback = "Video eliminado."
                },
            ) { Text("Quitar video") }
        }
        avatarFeedback?.let { Text(it, color = Muted, style = MaterialTheme.typography.labelSmall) }

        Spacer(Modifier.height(14.dp))
        Text("2 · Motor neuronal", color = Accent, style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))

        when (val s = modelState) {
            MuseTalkModelStore.State.Missing -> {
                Text(
                    "Los pesos se descargan una sola vez (~1,8 GB) y quedan en este celular.",
                    color = Muted,
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { scope.launch { runCatching { MuseTalkModelStore.install(context) } } },
                ) { Text("Descargar MuseTalk 1.5") }
            }

            is MuseTalkModelStore.State.Downloading -> {
                Text(
                    "Descargando ${s.fileIndex}/${s.fileCount}: ${s.fileName}",
                    color = Muted,
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(6.dp))
                LinearProgressIndicator(progress = { s.fraction }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(4.dp))
                Text(
                    "${(s.downloadedBytes / 1_000_000)} / ${(s.totalBytes / 1_000_000)} MB",
                    color = Muted,
                    style = MaterialTheme.typography.labelSmall,
                )
            }

            MuseTalkModelStore.State.Ready -> {
                Text("✓ MuseTalk 1.5 ONNX instalado", color = Accent, style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(8.dp))
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !benchmarkRunning,
                    onClick = {
                        scope.launch {
                            benchmarkRunning = true
                            benchmarkText = "Cargando UNet + VAE en memoria…"
                            val result = runCatching {
                                withContext(Dispatchers.Default) {
                                    MuseTalkOrtEngine(context).use { it.benchmark() }
                                }
                            }
                            benchmarkText = result.fold(
                                onSuccess = { it.pretty() },
                                onFailure = { "Error neural: ${it.message ?: it::class.simpleName}" },
                            )
                            benchmarkRunning = false
                        }
                    },
                ) { Text(if (benchmarkRunning) "Midiendo MuseTalk…" else "Medir FPS reales en este celular") }
                TextButton(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !benchmarkRunning,
                    onClick = {
                        MuseTalkModelStore.remove(context)
                        benchmarkText = null
                    },
                ) { Text("Eliminar motor (~1,8 GB)") }
            }

            is MuseTalkModelStore.State.Error -> {
                Text("Error: ${s.message}", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(6.dp))
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { scope.launch { runCatching { MuseTalkModelStore.install(context) } } },
                ) { Text("Reintentar / continuar descarga") }
            }
        }

        benchmarkText?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = Muted, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun MuseTalkAvatarStage(avatar: MuseTalkAvatar) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val player = remember(avatar.videoPath) {
        ExoPlayer.Builder(context).build().apply {
            volume = 0f
            repeatMode = Player.REPEAT_MODE_ONE
            setMediaItem(MediaItem.fromUri(Uri.fromFile(File(avatar.videoPath))))
            prepare()
            playWhenReady = true
        }
    }

    DisposableEffect(player) { onDispose { player.release() } }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(Color.Black)
    ) {
        AndroidView(
            modifier = Modifier
                .fillMaxWidth()
                .height(280.dp),
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    setShutterBackgroundColor(android.graphics.Color.BLACK)
                    this.player = player
                }
            },
            update = { it.player = player },
        )
        Text(
            "MUSETALK LOCAL · avatar fuente",
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
            color = Accent,
            style = MaterialTheme.typography.labelSmall,
        )
    }
}
