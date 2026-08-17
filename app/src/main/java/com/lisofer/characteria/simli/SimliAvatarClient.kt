package com.lisofer.characteria.simli

import android.content.Context
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Thin native client around Simli Compose + LiveKit.
 * Fish remains the TTS source; this class turns its PCM into a synchronized avatar stream.
 */
class SimliAvatarClient(
    context: Context,
    private val scope: CoroutineScope,
    private val listener: Listener,
) {
    interface Listener {
        fun onStatus(message: String)
        fun onReady()
        fun onVideoReady()
        fun onError(message: String)
    }

    private val appContext = context.applicationContext
    private val http = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val resampler = Pcm16Resampler()

    /** LiveKit is joined and Simli can already accept PCM. */
    private val inputReady = AtomicBoolean(false)

    /** A real decoded video frame reached Android, not merely a subscribed track. */
    private val firstFrameSeen = AtomicBoolean(false)

    @Volatile private var socket: WebSocket? = null
    @Volatile private var room: Room? = null
    @Volatile private var renderer: TextureViewRenderer? = null
    @Volatile private var videoTrack: VideoTrack? = null
    private var roomEventsJob: Job? = null
    private var firstFrameWatchdog: Job? = null
    private var generation = 0L

    fun start(apiKey: String, faceId: String) {
        stop()
        if (apiKey.isBlank() || faceId.isBlank()) {
            listener.onError("Simli: falta API key o Face ID")
            return
        }

        generation += 1L
        val myGeneration = generation
        listener.onStatus("Simli · creando sesión…")

        val body = JSONObject()
            .put("faceId", faceId.trim())
            .put("handleSilence", true)
            .put("maxSessionLength", 3600)
            .put("maxIdleTime", 300)
            .put("model", "fasttalk")
            .toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())

        val request = Request.Builder()
            .url("https://api.simli.ai/compose/token")
            .header("x-simli-api-key", apiKey.trim())
            .post(body)
            .build()

        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (myGeneration != generation) return
                listener.onError("Simli token: ${e.message ?: e::class.simpleName}")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (myGeneration != generation) return
                    val text = it.body.string()
                    if (!it.isSuccessful) {
                        listener.onError("Simli token HTTP ${it.code}: ${compact(text)}")
                        return
                    }
                    val token = runCatching { JSONObject(text).getString("session_token") }.getOrNull()
                    if (token.isNullOrBlank()) {
                        listener.onError("Simli: respuesta de token inválida")
                        return
                    }
                    openAvatarSocket(token, myGeneration)
                }
            }
        })
    }

    /** Returns true only when Simli accepted ownership of this Fish PCM chunk. */
    fun sendFishPcm(pcm44k: ByteArray): Boolean {
        if (!inputReady.get()) return false
        val ws = socket ?: return false
        val pcm16k = resampler.process(pcm44k)
        if (pcm16k.isEmpty()) return true
        return ws.send(pcm16k.toByteString())
    }

    fun clearBuffer() {
        resampler.reset()
        socket?.takeIf { inputReady.get() }?.send("SKIP")
    }

    /** Called from Compose on the main thread. TextureView is more reliable inside Compose than SurfaceView. */
    fun bindRenderer(newRenderer: TextureViewRenderer?) {
        val old = renderer
        if (old === newRenderer) return

        videoTrack?.let { track -> old?.let { runCatching { track.removeRenderer(it) } } }
        renderer = newRenderer

        val activeRoom = room
        if (newRenderer != null && activeRoom != null) {
            runCatching { activeRoom.initVideoRenderer(newRenderer) }
                .onFailure { listener.onStatus("Simli renderer: ${it.message}") }
            videoTrack?.let { track -> attachTrackToRenderer(track, newRenderer) }
        }
    }

    fun isReady(): Boolean = inputReady.get()

    fun stop() {
        generation += 1L
        inputReady.set(false)
        firstFrameSeen.set(false)
        resampler.reset()
        firstFrameWatchdog?.cancel()
        firstFrameWatchdog = null

        runCatching { socket?.send("DONE") }
        runCatching { socket?.close(1000, "CharacterIA stop") }
        socket = null

        roomEventsJob?.cancel()
        roomEventsJob = null
        val oldTrack = videoTrack
        val oldRenderer = renderer
        if (oldTrack != null && oldRenderer != null) {
            runCatching { oldTrack.removeRenderer(oldRenderer) }
        }
        videoTrack = null
        room?.let { runCatching { it.disconnect() } }
        room = null
    }

    private fun openAvatarSocket(sessionToken: String, myGeneration: Long) {
        if (myGeneration != generation) return
        val request = Request.Builder()
            .url("wss://api.simli.ai/compose/webrtc/livekit?session_token=$sessionToken")
            .build()

        lateinit var created: WebSocket
        val callback = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (myGeneration != generation || webSocket !== socket) return
                listener.onStatus("Simli · preparando avatar…")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (myGeneration != generation || webSocket !== socket) return
                handleServerMessage(text, myGeneration)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (myGeneration != generation || webSocket !== socket) return
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (myGeneration != generation || webSocket !== socket) return
                inputReady.set(false)
                listener.onStatus("Simli cerrado · $code ${reason.ifBlank { "" }}".trim())
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (myGeneration != generation || webSocket !== socket) return
                inputReady.set(false)
                val httpPart = response?.let { " · HTTP ${it.code}" }.orEmpty()
                listener.onError("Simli WebSocket$httpPart: ${t.message ?: t::class.simpleName}")
            }
        }
        created = http.newWebSocket(request, callback)
        socket = created
    }

    private fun handleServerMessage(message: String, myGeneration: Long) {
        val trimmed = message.trim()
        val upper = trimmed.uppercase()
        when {
            upper.startsWith("ERROR") || upper.startsWith("CLOSING") || upper.startsWith("RATE") -> {
                listener.onError("Simli: ${compact(trimmed)}")
            }
            upper.startsWith("STOP") -> {
                inputReady.set(false)
                listener.onStatus("Simli · sesión finalizada")
            }
            upper.startsWith("SPEAK") -> {
                listener.onStatus(if (firstFrameSeen.get()) "Simli · hablando" else "Simli · generando imagen…")
            }
            upper.startsWith("SILENT") -> {
                listener.onStatus(if (firstFrameSeen.get()) "Simli · avatar listo" else "Simli · esperando primer frame…")
            }
            upper.contains("LIVEKIT") -> {
                val jsonStart = trimmed.indexOf('{')
                val payload = if (jsonStart >= 0) trimmed.substring(jsonStart) else trimmed
                val info = runCatching { JSONObject(payload) }.getOrNull()
                val url = info?.optString("livekit_url").orEmpty()
                val token = info?.optString("livekit_token").orEmpty()
                if (url.isBlank() || token.isBlank()) {
                    listener.onError("Simli: datos LiveKit inválidos")
                } else {
                    connectLiveKit(url, token, myGeneration)
                }
            }
        }
    }

    /**
     * Simli's reference web client only considers startup complete after the first actual video frame.
     * Keep every LiveKit/UI operation on the main dispatcher because TextureViewRenderer requires it.
     */
    private fun connectLiveKit(url: String, token: String, myGeneration: Long) {
        scope.launch {
            if (myGeneration != generation || room != null) return@launch

            val newRoom = LiveKit.create(appContext)
            room = newRoom

            renderer?.let { view ->
                runCatching { newRoom.initVideoRenderer(view) }
                    .onFailure { listener.onStatus("Simli renderer: ${it.message}") }
            }

            roomEventsJob = launch {
                newRoom.events.collect { event ->
                    if (myGeneration != generation) return@collect
                    when (event) {
                        is RoomEvent.TrackSubscribed -> {
                            val track = event.track as? VideoTrack ?: return@collect
                            attachVideoTrack(track, myGeneration)
                        }
                        is RoomEvent.TrackSubscriptionFailed -> {
                            listener.onError("Simli LiveKit track: ${event.exception.message ?: "falló la suscripción"}")
                        }
                        is RoomEvent.Disconnected -> {
                            inputReady.set(false)
                            listener.onStatus("Simli · video desconectado")
                        }
                        else -> Unit
                    }
                }
            }

            runCatching { newRoom.connect(url, token) }
                .onSuccess {
                    if (myGeneration != generation) {
                        newRoom.disconnect()
                        return@onSuccess
                    }

                    inputReady.set(true)
                    listener.onReady()
                    listener.onStatus("Simli · LiveKit conectado · esperando imagen…")

                    // Warm-up recommended by Simli's SDK examples: one second of PCM16/16 kHz silence.
                    // It starts the remote rendering path before the first Fish response arrives.
                    socket?.send(ByteArray(32_000).toByteString())

                    // Defensive recovery for a track that was already subscribed before our observer ran.
                    newRoom.remoteParticipants.values
                        .asSequence()
                        .flatMap { it.trackPublications.values.asSequence() }
                        .mapNotNull { it.track as? VideoTrack }
                        .firstOrNull()
                        ?.let { attachVideoTrack(it, myGeneration) }
                }
                .onFailure {
                    if (myGeneration == generation) {
                        listener.onError("Simli LiveKit: ${it.message ?: it::class.simpleName}")
                    }
                }
        }
    }

    private fun attachVideoTrack(track: VideoTrack, myGeneration: Long) {
        if (myGeneration != generation) return
        val previous = videoTrack
        val view = renderer
        if (previous != null && previous !== track && view != null) {
            runCatching { previous.removeRenderer(view) }
        }
        videoTrack = track

        if (view != null) {
            attachTrackToRenderer(track, view)
        }
        listener.onStatus("Simli · stream de video recibido · esperando frame…")

        firstFrameWatchdog?.cancel()
        firstFrameWatchdog = scope.launch {
            delay(8_000)
            if (myGeneration == generation && !firstFrameSeen.get()) {
                listener.onStatus("Simli · conectado pero todavía sin frames de video")
            }
        }
    }

    private fun attachTrackToRenderer(track: VideoTrack, view: TextureViewRenderer) {
        runCatching {
            view.setMirror(false)
            view.addFrameListener({
                if (firstFrameSeen.compareAndSet(false, true)) {
                    firstFrameWatchdog?.cancel()
                    scope.launch {
                        listener.onVideoReady()
                        listener.onStatus("Simli · avatar listo")
                    }
                }
            }, 0f)
            track.addRenderer(view)
        }.onFailure {
            listener.onError("Simli render: ${it.message ?: it::class.simpleName}")
        }
    }

    private fun compact(text: String): String = text.replace(Regex("\\s+"), " ").take(220)
}
