package com.lisofer.characteria.vision

import android.net.Uri
import android.view.View
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
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
import com.lisofer.characteria.musetalk.MuseTalkAvatarPreprocessor
import com.lisofer.characteria.musetalk.MuseTalkAvatarStore
import com.lisofer.characteria.musetalk.MuseTalkLiveRenderer
import com.lisofer.characteria.musetalk.MuseTalkModelStore
import com.lisofer.characteria.musetalk.MuseTalkPreparedStore
import kotlinx.coroutines.launch
import java.io.File

private val Panel = Color(0xFF0B1722)
private val Muted = Color(0xFFA7B6C8)
private val Accent = Color(0xFF67E8B4)

@Composable
fun VisionAvatarHost(state: AppUiState) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val revision by MuseTalkAvatarStore.updates.collectAsStateWithLifecycle()

    val profileId = remember(state.config.profileId, state.activeCharacterNames, state.profiles) {
        when {
            state.activeCharacterNames.size > 1 -> null
            state.activeCharacterNames.size == 1 -> {
                val name = state.activeCharacterNames.first()
                state.profiles.firstOrNull { it.name.equals(name, ignoreCase = true) }?.id
            }
            else -> state.config.profileId.takeIf { it.isNotBlank() }
        }
    }
    val avatar = remember(profileId, revision) { profileId?.let { MuseTalkAvatarStore.load(context, it) } }
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
    val prepState by MuseTalkAvatarPreprocessor.state.collectAsStateWithLifecycle()

    var importing by remember(profileId) { mutableStateOf(false) }
    var avatarFeedback by remember(profileId) { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) { MuseTalkModelStore.refresh(context) }
    val avatar = remember(profileId, avatarRevision) { MuseTalkAvatarStore.load(context, profileId) }
    val prepared = remember(profileId, avatarRevision, prepState) {
        avatar?.takeIf { MuseTalkAvatarPreprocessor.isCurrent(context, it) }
            ?.let { MuseTalkPreparedStore.load(context, profileId) }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null || profileId.isBlank()) return@rememberLauncherForActivityResult
        scope.launch {
            importing = true
            avatarFeedback = "Guardando video fuente…"
            runCatching { MuseTalkAvatarStore.importVideo(context, profileId, uri) }
                .onSuccess { avatarFeedback = "✓ Video guardado. Ahora prepará el lipsync para este personaje." }
                .onFailure { avatarFeedback = it.message ?: "No pude guardar el video" }
            importing = false
        }
    }

    Column(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Panel).padding(14.dp)
    ) {
        Text("Lipsync neural · MuseTalk Local", fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text(
            "La configuración es simple: cargás el MP4, instalás MuseTalk una sola vez y preparás ese video. Después el lipsync se activa automáticamente cuando Fish habla.",
            color = Muted,
            style = MaterialTheme.typography.bodySmall,
        )

        Spacer(Modifier.height(12.dp))
        Text("1 · Video del personaje", color = Accent, style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))
        if (avatar == null) {
            Button(
                modifier = Modifier.fillMaxWidth(), enabled = !importing && profileId.isNotBlank(),
                onClick = { picker.launch(arrayOf("video/mp4")) },
            ) { Text(if (importing) "Guardando…" else "Cargar MP4 del personaje") }
        } else {
            Text("✓ ${avatar.displayName}", color = Accent, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(6.dp))
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(), enabled = !importing,
                onClick = { picker.launch(arrayOf("video/mp4")) },
            ) { Text(if (importing) "Guardando…" else "Cambiar video") }
            TextButton(
                modifier = Modifier.fillMaxWidth(), enabled = !importing,
                onClick = { MuseTalkAvatarStore.remove(context, profileId); avatarFeedback = "Video eliminado." },
            ) { Text("Quitar video") }
        }
        avatarFeedback?.let { Text(it, color = Muted, style = MaterialTheme.typography.labelSmall) }

        Spacer(Modifier.height(14.dp))
        Text("2 · Motor de lipsync", color = Accent, style = MaterialTheme.typography.labelLarge)
        Spacer(Modifier.height(6.dp))
        when (val s = modelState) {
            MuseTalkModelStore.State.Missing -> {
                Text(
                    "MuseTalk 1.5 se descarga una sola vez (~2,08 GB) y queda guardado en el teléfono.",
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
                Text("Descargando ${s.fileIndex}/${s.fileCount}: ${s.fileName}", color = Muted, style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(6.dp))
                LinearProgressIndicator(progress = { s.fraction }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(4.dp))
                Text("${s.downloadedBytes / 1_000_000} / ${s.totalBytes / 1_000_000} MB", color = Muted, style = MaterialTheme.typography.labelSmall)
            }
            MuseTalkModelStore.State.Ready -> {
                Text("✓ MuseTalk 1.5 instalado", color = Accent, style = MaterialTheme.typography.bodySmall)
                Text(
                    "No se ejecuta nada pesado mientras el personaje está en silencio.",
                    color = Muted,
                    style = MaterialTheme.typography.labelSmall,
                )
                TextButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { MuseTalkModelStore.remove(context) },
                ) { Text("Eliminar motor (~2,08 GB)") }
            }
            is MuseTalkModelStore.State.Error -> {
                Text("Error: ${s.message}", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { scope.launch { runCatching { MuseTalkModelStore.install(context) } } },
                ) { Text("Reintentar / continuar descarga") }
            }
        }

        if (avatar != null && modelState == MuseTalkModelStore.State.Ready) {
            Spacer(Modifier.height(14.dp))
            Text("3 · Aplicar MuseTalk al video", color = Accent, style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.height(6.dp))
            when (val p = prepState) {
                is MuseTalkAvatarPreprocessor.State.Preparing -> {
                    Text("${p.detail} · ${p.frame}/${p.total}", color = Muted, style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(6.dp))
                    LinearProgressIndicator(
                        progress = { p.frame.toFloat() / p.total.coerceAtLeast(1) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                is MuseTalkAvatarPreprocessor.State.Error -> Text("Error: ${p.message}", color = MaterialTheme.colorScheme.error)
                else -> Unit
            }
            if (prepared != null) {
                Text(
                    "✓ Lipsync listo para este video. Se activa automáticamente cuando el personaje habla.",
                    color = Accent,
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    "Al terminar este paso MuseTalk NO queda corriendo en segundo plano. El motor pesado se abre recién cuando llega voz de Fish.",
                    color = Muted,
                    style = MaterialTheme.typography.labelSmall,
                )
            } else if (prepState !is MuseTalkAvatarPreprocessor.State.Preparing) {
                Text(
                    "Esto detecta la cara y prepara los latentes del MP4. Se hace una sola vez por cada video que cargues.",
                    color = Muted,
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(7.dp))
                Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { scope.launch { runCatching { MuseTalkAvatarPreprocessor.prepare(context, avatar) } } },
                ) { Text("Preparar lipsync en este video") }
            }
        }
    }
}

@Composable
private fun MuseTalkAvatarStage(avatar: MuseTalkAvatar) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val modelState by MuseTalkModelStore.state.collectAsStateWithLifecycle()
    val prepState by MuseTalkAvatarPreprocessor.state.collectAsStateWithLifecycle()
    val rendered by MuseTalkLiveRenderer.frame.collectAsStateWithLifecycle()
    val rendererState by MuseTalkLiveRenderer.state.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) { MuseTalkModelStore.refresh(context) }
    val prepared = remember(avatar.profileId, avatar.videoPath, prepState, modelState) {
        if (modelState == MuseTalkModelStore.State.Ready && MuseTalkAvatarPreprocessor.isCurrent(context, avatar)) {
            MuseTalkPreparedStore.load(context, avatar.profileId)
        } else null
    }

    LaunchedEffect(avatar.profileId, prepared?.sourceUpdatedAt, modelState) {
        if (prepared != null && modelState == MuseTalkModelStore.State.Ready) {
            // This loop is lightweight while silent. It only opens ONNX sessions when Fish PCM arrives.
            MuseTalkLiveRenderer.run(context, prepared)
        }
    }

    val neural = rendered?.takeIf { it.profileId == avatar.profileId }
    val player = remember(avatar.videoPath) {
        ExoPlayer.Builder(context).build().apply {
            volume = 0f
            repeatMode = Player.REPEAT_MODE_ONE
            setMediaItem(MediaItem.fromUri(Uri.fromFile(File(avatar.videoPath))))
            prepare(); playWhenReady = true
        }
    }
    DisposableEffect(player) { onDispose { player.release() } }

    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp).clip(RoundedCornerShape(22.dp)).background(Color.Black)
    ) {
        Box(modifier = Modifier.fillMaxWidth().height(280.dp).background(Color.Black)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    PlayerView(ctx).apply {
                        useController = false
                        resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                        setShutterBackgroundColor(android.graphics.Color.BLACK)
                        this.player = player
                    }
                },
                update = {
                    it.player = player
                    it.visibility = if (neural != null) View.INVISIBLE else View.VISIBLE
                },
            )
            neural?.let {
                Image(
                    bitmap = it.bitmap.asImageBitmap(),
                    contentDescription = "MuseTalk neural frame",
                    modifier = Modifier.fillMaxSize(),
                    contentScale = ContentScale.Fit,
                )
            }
        }

        val status = when (val s = rendererState) {
            is MuseTalkLiveRenderer.State.Speaking -> "MUSETALK · lipsync activo"
            is MuseTalkLiveRenderer.State.Loading -> "MUSETALK · ${s.detail}"
            is MuseTalkLiveRenderer.State.Error -> "MUSETALK · ${s.message}"
            MuseTalkLiveRenderer.State.Idle -> if (prepared != null) "MUSETALK · listo · esperando voz" else "MUSETALK · prepará el video en Ajustes"
        }
        Text(status, modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp), color = Accent, style = MaterialTheme.typography.labelSmall)
    }
}
