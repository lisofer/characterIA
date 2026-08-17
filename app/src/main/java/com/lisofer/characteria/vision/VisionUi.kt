package com.lisofer.characteria.vision

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import kotlin.math.max
import kotlin.math.min

private val VisionPanel = Color(0xFF0B1722)
private val VisionMuted = Color(0xFFA7B6C8)
private val VisionMint = Color(0xFF67E8B4)

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
            feedback = "Preparando rostro, boca neutral y seguimiento…"
            runCatching { VisionAvatarStore.importVideo(context, profileId, uri) }
                .onSuccess { result ->
                    feedback = when {
                        result.quality >= .72f -> "✓ Avatar preparado · seguimiento excelente"
                        result.quality >= .42f -> "✓ Avatar preparado · seguimiento bueno"
                        else -> "✓ Listo. Para mejorar: rostro frontal, buena luz y poco giro de cabeza."
                    }
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
        Text("Avatar de video · Visión Smooth", fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
        Spacer(Modifier.height(4.dp))
        Text(
            "Podés usar un video donde la persona esté hablando. La app conserva ojos, cabeza, hombros y gestos del video, pero neutraliza la boca original y anima una sola boca con la voz de Fish. Todo el trabajo pesado se hace una vez al importar.",
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
                Text(if (importing) "Preparando avatar…" else "Cargar video del personaje")
            }
        } else {
            Text(
                "Video: ${avatar.displayName}",
                color = VisionMint,
                style = MaterialTheme.typography.bodySmall,
            )
            Text(
                "Seguimiento: ${avatar.analyzedFrames} muestras · calidad ${qualityText(avatar.quality)}",
                color = VisionMuted,
                style = MaterialTheme.typography.labelSmall,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = !importing,
                onClick = { picker.launch(arrayOf("video/mp4")) },
            ) {
                Text(if (importing) "Preparando avatar…" else "Cambiar video")
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

private fun qualityText(value: Float): String = when {
    value >= .72f -> "excelente"
    value >= .42f -> "buena"
    else -> "limitada"
}

@Composable
private fun VisionAvatarStage(avatar: VisionAvatar) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val lip by LipSyncBus.state.collectAsStateWithLifecycle()

    val neutral = remember(avatar.neutralPath) { loadBitmap(avatar.neutralPath) }
    val textures = remember(
        avatar.restPath,
        avatar.closedPath,
        avatar.widePath,
        avatar.openPath,
        avatar.roundPath,
    ) {
        mapOf(
            MouthViseme.REST to loadBitmap(avatar.restPath),
            MouthViseme.CLOSED to loadBitmap(avatar.closedPath),
            MouthViseme.WIDE to loadBitmap(avatar.widePath),
            MouthViseme.OPEN to loadBitmap(avatar.openPath),
            MouthViseme.ROUND to loadBitmap(avatar.roundPath),
        )
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

    var playerPositionMs by remember(player) { mutableLongStateOf(0L) }
    LaunchedEffect(player) {
        while (isActive) {
            playerPositionMs = player.currentPosition.coerceAtLeast(0L)
            delay(16L)
        }
    }

    DisposableEffect(player) {
        onDispose { player.release() }
    }

    val track = remember(avatar.motionTrack, playerPositionMs) {
        interpolateTrack(avatar, playerPositionMs)
    }

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .height(280.dp)
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

        if (avatar.sourceWidth > 0 && avatar.sourceHeight > 0) {
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

            val centerX = videoLeft + track.centerX * renderedW
            val centerY = videoTop + track.centerY * renderedH
            val patchW = max(12f, track.patchWidth * renderedW)
            val patchH = max(10f, track.patchHeight * renderedH)
            val patchLeft = centerX - patchW * .5f
            val patchTop = centerY - patchH * .5f

            // Tapa siempre la boca/mandíbula original del video. El MP4 puede estar hablando,
            // pero en pantalla queda una base neutral antes de dibujar el lipsync nuevo.
            val neutralW = patchW * avatar.neutralScaleW
            val neutralH = patchH * avatar.neutralScaleH
            val neutralLeft = centerX - neutralW * .5f
            val neutralTop = centerY + patchH * avatar.neutralYOffset - neutralH * .5f
            neutral?.let { bitmap ->
                Image(
                    bitmap = bitmap,
                    contentDescription = null,
                    modifier = Modifier
                        .offset(neutralLeft.dp, neutralTop.dp)
                        .width(neutralW.dp)
                        .height(neutralH.dp)
                        .graphicsLayer(
                            rotationZ = track.rotationZ,
                            transformOrigin = TransformOrigin.Center,
                        ),
                    contentScale = ContentScale.FillBounds,
                )
            }

            // Una sola boca. El PCM genera apertura continua a ~60 Hz; el visema sólo elige la
            // forma fotográfica que se mezcla suavemente encima del rostro neutralizado.
            val targetViseme = if (lip.speaking) lip.viseme else MouthViseme.REST
            val mouthAlpha = when {
                !lip.speaking -> 0f
                targetViseme == MouthViseme.CLOSED -> 0.28f + lip.level * .48f
                targetViseme == MouthViseme.REST -> lip.openness * .55f
                else -> 0.18f + lip.openness * .82f
            }.coerceIn(0f, 1f)
            val continuousScaleX = (1f + lip.widthBias * .08f).coerceIn(.94f, 1.08f)
            val continuousScaleY = (.975f + lip.openness * .055f).coerceIn(.975f, 1.035f)

            Crossfade(
                targetState = targetViseme,
                animationSpec = tween(durationMillis = 64),
                label = "smooth-mouth-viseme",
                modifier = Modifier
                    .offset(patchLeft.dp, patchTop.dp)
                    .width(patchW.dp)
                    .height(patchH.dp)
                    .graphicsLayer(
                        rotationZ = track.rotationZ,
                        scaleX = continuousScaleX,
                        scaleY = continuousScaleY,
                        transformOrigin = TransformOrigin.Center,
                    )
                    .alpha(mouthAlpha),
            ) { viseme ->
                textures[viseme]?.let { bitmap ->
                    Image(
                        bitmap = bitmap,
                        contentDescription = null,
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.FillBounds,
                    )
                }
            }
        }
    }
}

private fun interpolateTrack(avatar: VisionAvatar, positionMs: Long): MouthTrackPoint {
    val points = avatar.motionTrack
    if (points.isEmpty()) {
        return MouthTrackPoint(
            timeMs = positionMs,
            centerX = avatar.patchX + avatar.patchWidth * .5f,
            centerY = avatar.patchY + avatar.patchHeight * .5f,
            patchWidth = avatar.patchWidth,
            patchHeight = avatar.patchHeight,
            rotationZ = 0f,
        )
    }
    if (points.size == 1 || positionMs <= points.first().timeMs) return points.first()
    if (positionMs >= points.last().timeMs) return points.last()

    var rightIndex = 1
    while (rightIndex < points.size && points[rightIndex].timeMs < positionMs) rightIndex++
    val right = points[rightIndex.coerceAtMost(points.lastIndex)]
    val left = points[(rightIndex - 1).coerceAtLeast(0)]
    val span = (right.timeMs - left.timeMs).coerceAtLeast(1L)
    val t = ((positionMs - left.timeMs).toFloat() / span.toFloat()).coerceIn(0f, 1f)
    fun lerp(a: Float, b: Float): Float = a + (b - a) * t

    return MouthTrackPoint(
        timeMs = positionMs,
        centerX = lerp(left.centerX, right.centerX),
        centerY = lerp(left.centerY, right.centerY),
        patchWidth = lerp(left.patchWidth, right.patchWidth),
        patchHeight = lerp(left.patchHeight, right.patchHeight),
        rotationZ = lerp(left.rotationZ, right.rotationZ),
    )
}

private fun loadBitmap(path: String): ImageBitmap? =
    BitmapFactory.decodeFile(path)?.asImageBitmap()
