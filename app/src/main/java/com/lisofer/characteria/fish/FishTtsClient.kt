package com.lisofer.characteria.fish

import com.lisofer.characteria.vision.LipSyncBus
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

    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var socket: WebSocket? = null
    private val opened = AtomicBoolean(false)
    private val pending = ArrayDeque<String>()
    @Volatile private var finishRequested = false
    private var bufferedChars = 0

    fun start(
        apiKey: String,
        referenceAudio: ByteArray,
        referenceTranscript: String,
        speed: Float,
    ) {
        cancel()
        LipSyncBus.startTurn()
        finishRequested = false
        bufferedChars = 0
        pending.clear()

        val request = Request.Builder()
            .url("wss://api.fish.audio/v1/tts/live")
            .header("Authorization", "Bearer $apiKey")
            .header("model", "s2.1-pro-free")
            .build()

        lateinit var thisSocket: WebSocket
        val callback = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket !== socket) return
                val start = packStart(referenceAudio, referenceTranscript, speed)
                webSocket.send(start.toByteString())
                opened.set(true)
                listener.onDiagnostic("Fish WebSocket abierto")
                listener.onReady()

                synchronized(pending) {
                    while (pending.isNotEmpty()) {
                        sendTextNow(webSocket, pending.removeFirst())
                    }
                }
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

        thisSocket = client.newWebSocket(request, callback)
        socket = thisSocket
    }

    fun sendText(text: String) {
        if (text.isEmpty() || finishRequested) return
        // No modifica el camino de audio: sólo prepara en paralelo la forma de boca.
        LipSyncBus.queueText(text)
        val ws = socket
        if (ws != null && opened.get()) {
            sendTextNow(ws, text)
        } else {
            synchronized(pending) { pending.addLast(text) }
        }
    }

    private fun sendTextNow(ws: WebSocket, text: String) {
        ws.send(packText(text).toByteString())
        bufferedChars += text.length
        if (bufferedChars >= 30 && text.any { it == '.' || it == '?' || it == '!' || it == '…' || it == '\n' }) {
            ws.send(packEvent("flush").toByteString())
            bufferedChars = 0
        }
    }

    fun finish() {
        finishRequested = true
        socket?.takeIf { opened.get() }?.let { finishNow(it) }
    }

    private fun finishNow(ws: WebSocket) {
        ws.send(packEvent("flush").toByteString())
        ws.send(packEvent("stop").toByteString())
    }

    fun cancel() {
        finishRequested = true
        opened.set(false)
        synchronized(pending) { pending.clear() }
        socket?.cancel()
        socket = null
        LipSyncBus.reset()
    }

    private data class FishEvent(
        val event: String,
        val audio: ByteArray? = null,
        val reason: String? = null,
    )

    private fun packStart(audio: ByteArray, transcript: String, speed: Float): ByteArray {
        val out = ByteArrayOutputStream()
        MessagePack.newDefaultPacker(out).use { p ->
            p.packMapHeader(2)
            p.packString("event"); p.packString("start")
            p.packString("request")
            p.packMapHeader(11)
            p.packString("text"); p.packString("")
            p.packString("format"); p.packString("pcm")
            p.packString("sample_rate"); p.packInt(44_100)
            p.packString("chunk_length"); p.packInt(150)
            p.packString("latency"); p.packString("balanced")
            p.packString("normalize"); p.packBoolean(true)
            p.packString("temperature"); p.packDouble(0.7)
            p.packString("top_p"); p.packDouble(0.7)
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
}
