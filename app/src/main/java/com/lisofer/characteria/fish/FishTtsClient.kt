package com.lisofer.characteria.fish

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.msgpack.core.MessagePack
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class FishTtsClient(
    private val listener: Listener,
) {
    interface Listener {
        fun onAudio(bytes: ByteArray)
        fun onReady()
        fun onFinished()
        fun onError(message: String)
        fun onDiagnostic(message: String)
    }

    private enum class VoiceMode { SPEECH, SINGING }

    private data class StartConfig(
        val apiKey: String,
        val referenceAudio: ByteArray,
        val referenceTranscript: String,
        val speed: Float,
    )

    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var socket: WebSocket? = null
    private val opened = AtomicBoolean(false)
    private val pending = ArrayDeque<String>()
    @Volatile private var finishRequested = false
    private var bufferedChars = 0
    private var firstFlushDone = false
    private var startConfig: StartConfig? = null
    private var voiceMode: VoiceMode? = null
    private val modeProbe = StringBuilder()

    fun start(
        apiKey: String,
        referenceAudio: ByteArray,
        referenceTranscript: String,
        speed: Float,
    ) {
        cancel()
        finishRequested = false
        bufferedChars = 0
        firstFlushDone = false
        pending.clear()
        modeProbe.clear()
        voiceMode = null
        startConfig = StartConfig(apiKey, referenceAudio, referenceTranscript, speed)
        listener.onDiagnostic("Fish preparado · detección automática habla/canto")
    }

    fun sendText(text: String) {
        if (text.isEmpty() || finishRequested) return
        val clean = stripSingingMarkers(text)
        if (clean.isNotEmpty()) {
            synchronized(pending) { pending.addLast(clean) }
        }
        modeProbe.append(text)

        val ws = socket
        if (ws != null && opened.get()) {
            flushPending(ws)
            return
        }

        maybeOpenSocket(force = false)
    }

    fun finish() {
        finishRequested = true
        val ws = socket
        if (ws != null && opened.get()) {
            finishNow(ws)
        } else if (pending.isNotEmpty()) {
            maybeOpenSocket(force = true)
        } else {
            listener.onFinished()
        }
    }

    private fun maybeOpenSocket(force: Boolean) {
        if (socket != null) return
        val config = startConfig ?: return
        val detected = detectVoiceMode(modeProbe.toString(), force) ?: return
        voiceMode = detected
        openSocket(config, detected)
    }

    private fun detectVoiceMode(text: String, force: Boolean): VoiceMode? {
        val lower = text.lowercase()
        val explicitSinging = SING_MARKERS.any { lower.contains(it) } ||
            text.contains('♪') || text.contains('♫') || text.contains("🎵") || text.contains("🎶")
        if (explicitSinging) return VoiceMode.SINGING

        val singingCue = SINGING_CUES.any { lower.contains(it) }
        if (singingCue) return VoiceMode.SINGING

        val lines = text
            .lines()
            .map { stripSingingMarkers(it).trim() }
            .filter { it.isNotBlank() }
        val verseLike = lines.size >= 3 &&
            lines.takeLast(4).all { it.length <= 90 } &&
            lines.takeLast(4).map { it.length }.average() <= 65.0
        if (verseLike) return VoiceMode.SINGING

        if (force) return VoiceMode.SPEECH
        if (text.length >= MODE_PROBE_LIMIT) return VoiceMode.SPEECH
        return null
    }

    private fun openSocket(config: StartConfig, mode: VoiceMode) {
        val request = Request.Builder()
            .url("wss://api.fish.audio/v1/tts/live")
            .header("Authorization", "Bearer ${config.apiKey}")
            .header("model", "s2.1-pro-free")
            .build()

        val callback = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket !== socket) return
                val start = packStart(
                    audio = config.referenceAudio,
                    transcript = config.referenceTranscript,
                    speed = config.speed,
                    mode = mode,
                )
                webSocket.send(start.toByteString())
                opened.set(true)
                listener.onDiagnostic(
                    if (mode == VoiceMode.SINGING) {
                        "Fish WebSocket abierto · CharacterIA Sing · perfil estable"
                    } else {
                        "Fish WebSocket abierto · habla normal · baja latencia"
                    }
                )
                listener.onReady()
                flushPending(webSocket)
                if (finishRequested) finishNow(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (webSocket !== socket) return
                runCatching { unpackResponse(bytes.toByteArray()) }
                    .onSuccess { event ->
                        when (event.event) {
                            "audio" -> event.audio?.takeIf { it.isNotEmpty() }?.let(listener::onAudio)
                            "finish" -> {
                                opened.set(false)
                                listener.onDiagnostic("Fish finish: ${event.reason}")
                                if (event.reason == "error") listener.onError("Fish terminó con error")
                                else listener.onFinished()
                            }
                        }
                    }
                    .onFailure { listener.onDiagnostic("Fish parse: ${it.message}") }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== socket) return
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== socket) return
                opened.set(false)
                listener.onDiagnostic("Fish cerrado $code: $reason")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (webSocket !== socket) return
                opened.set(false)
                listener.onError("Fish: ${t.message ?: t::class.simpleName}")
            }
        }

        socket = client.newWebSocket(request, callback)
    }

    private fun flushPending(ws: WebSocket) {
        synchronized(pending) {
            while (pending.isNotEmpty()) {
                sendTextNow(ws, pending.removeFirst())
            }
        }
    }

    private fun sendTextNow(ws: WebSocket, text: String) {
        if (text.isBlank()) return
        ws.send(packText(text).toByteString())
        bufferedChars += text.length

        val singing = voiceMode == VoiceMode.SINGING
        val sentenceBoundary = text.any {
            it == '.' || it == '?' || it == '!' || it == '…' || it == '\n' || it == ',' || it == ';' || it == ':'
        }
        val firstThreshold = if (singing) 18 else 24
        val boundaryThreshold = if (singing) 32 else 45
        val hardThreshold = if (singing) 64 else 90
        val shouldFlush =
            (!firstFlushDone && bufferedChars >= firstThreshold) ||
                (firstFlushDone && bufferedChars >= boundaryThreshold && sentenceBoundary) ||
                bufferedChars >= hardThreshold

        if (shouldFlush) {
            ws.send(packEvent("flush").toByteString())
            firstFlushDone = true
            bufferedChars = 0
            listener.onDiagnostic(
                if (singing) "Fish Sing flush · frase corta para sostener coherencia"
                else "Fish flush anticipado para reducir latencia"
            )
        }
    }

    private fun finishNow(ws: WebSocket) {
        ws.send(packEvent("flush").toByteString())
        ws.send(packEvent("stop").toByteString())
    }

    fun cancel() {
        finishRequested = true
        opened.set(false)
        synchronized(pending) { pending.clear() }
        modeProbe.clear()
        voiceMode = null
        startConfig = null
        socket?.cancel()
        socket = null
    }

    private data class FishEvent(
        val event: String,
        val audio: ByteArray? = null,
        val reason: String? = null,
    )

    private fun packStart(
        audio: ByteArray,
        transcript: String,
        speed: Float,
        mode: VoiceMode,
    ): ByteArray {
        val singing = mode == VoiceMode.SINGING
        val out = ByteArrayOutputStream()
        MessagePack.newDefaultPacker(out).use { p ->
            p.packMapHeader(2)
            p.packString("event"); p.packString("start")
            p.packString("request")
            p.packMapHeader(12)
            p.packString("text"); p.packString("")
            p.packString("format"); p.packString("pcm")
            p.packString("sample_rate"); p.packInt(44_100)
            p.packString("chunk_length"); p.packInt(if (singing) 120 else 100)
            p.packString("latency"); p.packString(if (singing) "normal" else "low")
            p.packString("normalize"); p.packBoolean(true)
            p.packString("temperature"); p.packDouble(if (singing) 0.25 else 0.7)
            p.packString("top_p"); p.packDouble(if (singing) 0.45 else 0.7)
            p.packString("repetition_penalty"); p.packDouble(if (singing) 1.08 else 1.2)
            p.packString("condition_on_previous_chunks"); p.packBoolean(true)
            p.packString("prosody")
            p.packMapHeader(3)
            p.packString("speed"); p.packFloat(speed)
            p.packString("volume"); p.packInt(0)
            p.packString("normalize_loudness"); p.packBoolean(true)
            p.packString("references")
            p.packArrayHeader(1)
            p.packMapHeader(2)
            p.packString("audio")
            p.packBinaryHeader(audio.size); p.writePayload(audio)
            p.packString("text"); p.packString(transcript)
        }
        return out.toByteArray()
    }

    private fun stripSingingMarkers(text: String): String {
        var result = text
        SING_MARKERS_RAW.forEach { marker ->
            result = result.replace(marker, "", ignoreCase = true)
        }
        return result
    }

    private fun packText(text: String): ByteArray {
        val out = ByteArrayOutputStream()
        MessagePack.newDefaultPacker(out).use { p ->
            p.packMapHeader(2)
            p.packString("event"); p.packString("text")
            p.packString("text"); p.packString(text)
        }
        return out.toByteArray()
    }

    private fun packEvent(event: String): ByteArray {
        val out = ByteArrayOutputStream()
        MessagePack.newDefaultPacker(out).use { p ->
            p.packMapHeader(1)
            p.packString("event"); p.packString(event)
        }
        return out.toByteArray()
    }

    private fun unpackResponse(bytes: ByteArray): FishEvent {
        MessagePack.newDefaultUnpacker(bytes).use { u ->
            val count = u.unpackMapHeader()
            var event = ""
            var audio: ByteArray? = null
            var reason: String? = null
            repeat(count) {
                when (u.unpackString()) {
                    "event" -> event = u.unpackString()
                    "audio" -> {
                        val len = u.unpackBinaryHeader()
                        audio = u.readPayload(len)
                    }
                    "reason" -> reason = u.unpackString()
                    else -> u.skipValue()
                }
            }
            return FishEvent(event, audio, reason)
        }
    }

    companion object {
        private const val MODE_PROBE_LIMIT = 90

        private val SING_MARKERS = listOf(
            "[[sing]]",
            "[[/sing]]",
            "<sing>",
            "</sing>",
            "[sing]",
            "[/sing]",
            "[sings]",
            "[singing]",
        )

        private val SING_MARKERS_RAW = listOf(
            "[[SING]]",
            "[[/SING]]",
            "<SING>",
            "</SING>",
            "[SING]",
            "[/SING]",
            "[SINGS]",
            "[SINGING]",
        )

        private val SINGING_CUES = listOf(
            "te canto",
            "voy a cantar",
            "voy a entonar",
            "una copla",
            "esta copla",
            "una payada",
            "esta payada",
            "una canción",
            "una cancion",
            "ahí va la canción",
            "ahi va la cancion",
            "ahí va una canción",
            "ahi va una cancion",
            "let me sing",
            "i'll sing",
            "i will sing",
        )
    }
}
