package com.lisofer.characteria.vision

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CornerRadius
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.lisofer.characteria.AppUiState
import kotlinx.coroutines.launch
import java.io.File
import kotlin.math.max
import kotlin.math.min

private val VisionPanel = Color(0xFF0B1722)
private val VisionMuted = Color(0xFFA7B6C8)
private val VisionMint = Color(0xFF67E8B4)

/**
 * Resuelve qué avatar corresponde mostrar.
 * Dos personajes activos = sin video, deliberadamente.
 */
@Composable
fun VisionAvatarHost(state: AppUiState) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val revision by VisionAvatarStore.updates.collectAsStateWithLifecycle()

    val profileId = remember(
        state.config.profileId,
        state.activeCharacterNames,
        state.profiles,
    ) {
        when {
            state.activeCharacterNames.size > 1 -> null
            state.activeCharacterNames.size == 1 -> {
                val activeName = state.activeCharacterNames.first()
                state.profiles.firstOrNull { it.name.equals(activeName, ignoreCase = true) }?.id
            }
            else -> state.config.profileId.takeIf { it.isNotBlank() }
        }
    }

    val avatar = remember(profileId, revision) {
        profileId?.let { VisionAvatarStore.load(context, it) }
    }

    avatar?.let {
        VisionAvatarStage(it)
        Spacer(Modifier.height(8.dp))
    }
}

@Composable
fun VisionProfileSettings(profileId: String) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val revision by VisionAvatarStore.updates.collectAsStateWithLifecycle()
    var importing by remember(profileId) { mutableStateOf(false) }
    var feedback by remember(profileId) { mutableStateOf<String?>(null) }

    val avatar = remember(profileId, revision) {
        VisionAvatarStore.load(context, profileId)
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null || profileId.isBlank()) return@rememberLauncherForActivityResult
        scope.launch {
            importing = true
            feedback = "Analizando rostro y boca…"
            runCatching { VisionAvatarStore.importVideo(context, profileId, uri) }
                .onSuccess {
                    feedback = "✓ Avatar listo. La boca se detectó y preparó en el teléfono."
                }
                .onFailure {
                    feedback = it.message ?: "No pude preparar el video"
                }
            importing = false
        }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(VisionPanel)
            .padding(14.dp)
    ) {
        Text("Avatar de video · Visión", fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text(
            "Opcional. Cargá un MP4 corto, frontal y con poco movimiento. CharacterIA detecta la boca una sola vez; durante la charla el video se reproduce sin audio y el lipsync sigue el PCM de la voz.",
            color = VisionMuted,
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(10.dp))

        if (avatar == null) {
            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = !importing && profileId.isNotBlank(),
                onClick = { picker.launch(arrayOf("video/mp4")) },
            ) {
                Text(if (importing) "Preparando video…" else "Cargar video del personaje")
            }
        } else {
            Text(
                "Video: ${avatar.displayName}",
                color = VisionMint,
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !importing,
                onClick = { picker.launch(arrayOf("video/mp4")) },
            ) {
                Text(if (importing) "Preparando video…" else "Cambiar video")
            }
            TextButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !importing,
                onClick = {
                    VisionAvatarStore.remove(context, profileId)
                    feedback = "Avatar eliminado de este perfil."
                },
            ) {
                Text("Quitar video")
            }
        }

        feedback?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, color = VisionMuted, style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
private fun VisionAvatarStage(avatar: VisionAvatar) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val level by LipSyncBus.level.collectAsStateWithLifecycle()
    val mouthOpen by animateFloatAsState(
        targetValue = level,
        animationSpec = tween(durationMillis = 42, easing = LinearEasing),
        label = "mouth-open",
    )
    val overlayAlpha by animateFloatAsState(
        targetValue = if (level > .018f) 1f else 0f,
        animationSpec = tween(durationMillis = if (level > .018f) 35 else 95),
        label = "mouth-alpha",
    )

    val mouthImage = remember(avatar.mouthImagePath) {
        BitmapFactory.decodeFile(avatar.mouthImagePath)?.asImageBitmap()
    }

    val player = remember(avatar.videoPath) {
        ExoPlayer.Builder(context).build().apply {
            volume = 0f
            repeatMode = Player.REPEAT_MODE_ONE
            setMediaItem(MediaItem.fromUri(Uri.fromFile(File(avatar.videoPath))))
            prepare()
            playWhenReady = true
        }
    }

    DisposableEffect(player) {
        onDispose { player.release() }
    }

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .height(260.dp)
            .padding(horizontal = 12.dp)
            .clip(RoundedCornerShape(22.dp))
            .background(Color.Black)
    ) {
        AndroidView(
            modifier = Modifier.matchParentSize(),
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

        if (mouthImage != null && avatar.sourceWidth > 0 && avatar.sourceHeight > 0) {
            // PlayerView usa FIT: calculamos exactamente el rectángulo real del video dentro del panel.
            val containerW = maxWidth.value
            val containerH = maxHeight.value
            val scale = min(
                containerW / avatar.sourceWidth.toFloat(),
                containerH / avatar.sourceHeight.toFloat(),
            )
            val renderedW = avatar.sourceWidth * scale
            val renderedH = avatar.sourceHeight * scale
            val videoLeft = (containerW - renderedW) * .5f
            val videoTop = (containerH - renderedH) * .5f

            val mouthLeft = videoLeft + avatar.mouthX * avatar.sourceWidth * scale
            val mouthTop = videoTop + avatar.mouthY * avatar.sourceHeight * scale
            val mouthW = max(8f, avatar.mouthWidth * avatar.sourceWidth * scale)
            val mouthH = max(6f, avatar.mouthHeight * avatar.sourceHeight * scale)

            MouthOverlay(
                modifier = Modifier
                    .offset(mouthLeft.dp, mouthTop.dp)
                    .width(mouthW.dp)
                    .height(mouthH.dp)
                    .alpha(overlayAlpha),
                image = mouthImage,
                openness = mouthOpen,
            )
        }

        Text(
            "VISIÓN",
            modifier = Modifier
                .padding(20.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(Color.Black.copy(alpha = .48f))
                .padding(horizontal = 9.dp, vertical = 4.dp),
            color = VisionMint,
            style = MaterialTheme.typography.labelSmall,
        )
    }
}

@Composable
private fun MouthOverlay(
    modifier: Modifier,
    image: androidx.compose.ui.graphics.ImageBitmap,
    openness: Float,
) {
    Canvas(modifier = modifier.clip(RoundedCornerShape(50))) {
        val dstW = size.width.toInt().coerceAtLeast(1)
        val dstH = size.height.toInt().coerceAtLeast(2)
        val srcW = image.width.coerceAtLeast(1)
        val srcH = image.height.coerceAtLeast(2)
        val srcHalf = srcH / 2
        val dstHalf = dstH / 2
        val open = openness.coerceIn(0f, 1f)
        val separation = (dstH * .24f * open).toInt()

        clipRect {
            if (separation > 1) {
                val gapTop = dstHalf - separation * .48f
                val gapHeight = max(2f, separation.toFloat())
                drawRoundRect(
                    color = Color(0xFF17090B),
                    topLeft = androidx.compose.ui.geometry.Offset(dstW * .10f, gapTop),
                    size = androidx.compose.ui.geometry.Size(dstW * .80f, gapHeight),
                    cornerRadius = CornerRadius(gapHeight * .5f, gapHeight * .5f),
                )
            }

            drawImage(
                image = image,
                srcOffset = IntOffset(0, 0),
                srcSize = IntSize(srcW, srcHalf),
                dstOffset = IntOffset(0, -separation / 2),
                dstSize = IntSize(dstW, dstHalf),
            )
            drawImage(
                image = image,
                srcOffset = IntOffset(0, srcHalf),
                srcSize = IntSize(srcW, srcH - srcHalf),
                dstOffset = IntOffset(0, dstHalf + separation / 2),
                dstSize = IntSize(dstW, dstH - dstHalf),
            )
        }
    }
}
