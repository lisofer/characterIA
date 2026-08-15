package com.lisofer.characteria.gemini

import android.util.Base64
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class GeminiLiveClient(
    private val scope: CoroutineScope,
    private val listener: Listener,
) {
    interface Listener {
        fun onStatus(message: String)
        fun onReady(resumed: Boolean)
        fun onInputTranscript(fullText: String)
        fun onOutputTranscript(delta: String, fullText: String)
        fun onTurnComplete()
        fun onInterrupted()
        fun onError(message: String)
        fun onDiagnostic(message: String)
    }

    data class HistoryTurn(
        val role: String,
        val text: String,
    )

    data class Config(
        val apiKey: String,
        val model: String,
        val personality: String,
        val history: List<HistoryTurn> = emptyList(),
    )

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .build()

    @Volatile private var socket: WebSocket? = null
    @Volatile private var desiredConnected = false
    @Volatile private var setupComplete = false
    @Volatile private var hasEverBeenReady = false
    @Volatile private var config: Config? = null

    private val reconnectScheduled = AtomicBoolean(false)
    private var reconnectJob: Job? = null
    private var setupTimeoutJob: Job? = null

    private val inputTranscript = TranscriptAccumulator()
    private val outputTranscript = TranscriptAccumulator()

    fun connect(config: Config) {
        disconnectInternal(closeSocket = true)
        this.config = config
        desiredConnected = true
        hasEverBeenReady = false
        inputTranscript.reset()
        outputTranscript.reset()
        openSocket(isReconnect = false)
    }

    fun updateHistory(history: List<HistoryTurn>) {
        config = config?.copy(history = history)
    }

    fun disconnect() {
        desiredConnected = false
        disconnectInternal(closeSocket = true)
        inputTranscript.reset()
        outputTranscript.reset()
    }

    private fun disconnectInternal(closeSocket: Boolean) {
        reconnectJob?.cancel()
        reconnectJob = null
        setupTimeoutJob?.cancel()
        setupTimeoutJob = null
        reconnectScheduled.set(false)
        setupComplete = false
        if (closeSocket) {
            runCatching { socket?.close(1000, "user disconnect") }
            socket = null
        }
    }

    fun sendPcm16(pcm: ByteArray) {
        if (!setupComplete || pcm.isEmpty()) return
        val data = Base64.encodeToString(pcm, Base64.NO_WRAP)
        val message = JSONObject()
            .put(
                "realtimeInput",
                JSONObject().put(
                    "audio",
                    JSONObject()
                        .put("data", data)
                        .put("mimeType", "audio/pcm;rate=16000")
                )
            )
        socket?.send(message.toString())
    }

    fun sendTextTurn(text: String): Boolean {
        if (!setupComplete || text.isBlank()) return false
        val turn = JSONObject()
            .put("role", "user")
            .put("parts", JSONArray().put(JSONObject().put("text", text)))
        val message = JSONObject().put(
            "clientContent",
            JSONObject()
                .put("turns", JSONArray().put(turn))
                .put("turnComplete", true)
        )
        return socket?.send(message.toString()) == true
    }

    private fun openSocket(isReconnect: Boolean) {
        val cfg = config ?: return
        setupComplete = false
        setupTimeoutJob?.cancel()
        listener.onStatus(if (isReconnect) "Reconectando Gemini…" else "Conectando Gemini…")

        val request = Request.Builder()
            .url(
                "wss://generativelanguage.googleapis.com/ws/" +
                    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
                    "?key=${cfg.apiKey}"
            )
            .build()

        val callback = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket !== socket) return
                listener.onDiagnostic("Gemini WebSocket abierto · HTTP ${response.code}")

                val payload = buildSetup(cfg).toString()
                val sent = webSocket.send(payload)
                listener.onDiagnostic(if (sent) "Gemini setup enviado" else "Gemini setup NO pudo enviarse")

                setupTimeoutJob?.cancel()
                setupTimeoutJob = scope.launch(Dispatchers.IO) {
                    delay(12_000)
                    if (desiredConnected && webSocket === socket && !setupComplete) {
                        listener.onDiagnostic("Gemini: timeout esperando setupComplete")
                        listener.onError("Gemini no confirmó la sesión en 12 s. Revisá modelo/API key; mirá Diagnóstico para el detalle.")
                        desiredConnected = false
                        webSocket.cancel()
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== socket) return
                handleRawMessage(webSocket, text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (webSocket !== socket) return
                listener.onDiagnostic("Gemini recibió frame binario (${bytes.size} bytes)")
                handleRawMessage(webSocket, bytes.utf8())
            }

            private fun handleRawMessage(webSocket: WebSocket, text: String) {
                runCatching {
                    val root = JSONObject(text)
                    if (root.has("error")) {
                        val error = root.opt("error")?.toString() ?: "error desconocido"
                        listener.onDiagnostic("Gemini error de servidor: $error")
                        listener.onError("Gemini rechazó la sesión: $error")
                        desiredConnected = false
                        socket?.cancel()
                        return
                    }
                    handleMessage(webSocket, root)
                }.onFailure {
                    listener.onDiagnostic("Gemini parse: ${it::class.simpleName}: ${it.message}")
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== socket) return
                listener.onDiagnostic("Gemini closing $code: $reason")
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== socket) return
                setupTimeoutJob?.cancel()
                setupComplete = false
                listener.onDiagnostic("Gemini cerrado $code: ${reason.ifBlank { "sin motivo" }}")

                if (!desiredConnected) return

                if (hasEverBeenReady) {
                    scheduleReconnect()
                } else {
                    desiredConnected = false
                    listener.onError("Gemini cerró durante la conexión ($code): ${reason.ifBlank { "sin motivo" }}")
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (webSocket !== socket) return
                setupTimeoutJob?.cancel()
                setupComplete = false

                val http = response?.let { "HTTP ${it.code} ${it.message}" }
                val cause = "${t::class.simpleName}: ${t.message ?: "sin detalle"}"
                val detail = listOfNotNull(http, cause).joinToString(" · ")
                listener.onDiagnostic("Gemini fallo: $detail")

                if (!desiredConnected) return

                if (hasEverBeenReady) {
                    scheduleReconnect()
                } else {
                    desiredConnected = false
                    listener.onError("No se pudo conectar con Gemini: $detail")
                }
            }
        }

        socket = client.newWebSocket(request, callback)
    }

    private fun scheduleReconnect() {
        if (!desiredConnected || !reconnectScheduled.compareAndSet(false, true)) return
        listener.onStatus("Reconectando Gemini…")
        reconnectJob = scope.launch(Dispatchers.IO) {
            delay(900)
            reconnectScheduled.set(false)
            if (desiredConnected) openSocket(isReconnect = true)
        }
    }

    private fun buildSetup(cfg: Config): JSONObject {
        val setup = JSONObject()
            .put("model", "models/${cfg.model}")
            .put(
                "generationConfig",
                JSONObject().put("responseModalities", JSONArray().put("AUDIO"))
            )
            .put(
                "realtimeInputConfig",
                JSONObject().put(
                    "automaticActivityDetection",
                    JSONObject()
                        .put("disabled", false)
                        .put("prefixPaddingMs", 40)
                        .put("silenceDurationMs", 650)
                )
            )
            .put("inputAudioTranscription", JSONObject())
            .put("outputAudioTranscription", JSONObject())

        if (cfg.personality.isNotBlank()) {
            setup.put(
                "systemInstruction",
                JSONObject().put(
                    "parts",
                    JSONArray().put(JSONObject().put("text", cfg.personality))
                )
            )
        }

        if (cfg.history.isNotEmpty()) {
            setup.put(
                "historyConfig",
                JSONObject().put("initialHistoryInClientContent", true)
            )
        }

        return JSONObject().put("setup", setup)
    }

    private fun sendInitialHistory(webSocket: WebSocket, history: List<HistoryTurn>) {
        if (history.isEmpty()) return
        val turns = JSONArray()
        history.forEach { turn ->
            if (turn.text.isBlank()) return@forEach
            turns.put(
                JSONObject()
                    .put("role", turn.role)
                    .put("parts", JSONArray().put(JSONObject().put("text", turn.text)))
            )
        }
        val payload = JSONObject().put(
            "clientContent",
            JSONObject()
                .put("turns", turns)
                .put("turnComplete", true)
        )
        val sent = webSocket.send(payload.toString())
        listener.onDiagnostic(
            if (sent) "Gemini historial inicial enviado · ${turns.length()} mensajes"
            else "Gemini historial inicial NO pudo enviarse"
        )
    }

    private fun handleMessage(webSocket: WebSocket, root: JSONObject) {
        if (root.has("setupComplete")) {
            setupTimeoutJob?.cancel()
            setupTimeoutJob = null
            val cfg = config
            if (cfg != null && cfg.history.isNotEmpty()) {
                sendInitialHistory(webSocket, cfg.history)
            }
            setupComplete = true
            hasEverBeenReady = true
            inputTranscript.reset()
            outputTranscript.reset()
            listener.onDiagnostic("Gemini setupComplete")
            listener.onReady(false)
        }

        root.optJSONObject("goAway")?.let { goAway ->
            listener.onDiagnostic("Gemini GoAway: ${goAway.opt("timeLeft")}")
            listener.onStatus("Gemini va a renovar la conexión…")
        }

        val content = root.optJSONObject("serverContent") ?: return

        if (content.optBoolean("interrupted", false)) {
            outputTranscript.reset()
            listener.onInterrupted()
        }

        content.optJSONObject("inputTranscription")?.optString("text")
            ?.takeIf { it.isNotEmpty() }
            ?.let { incoming ->
                val update = inputTranscript.add(incoming)
                listener.onInputTranscript(update.full)
            }

        content.optJSONObject("outputTranscription")?.optString("text")
            ?.takeIf { it.isNotEmpty() }
            ?.let { incoming ->
                val update = outputTranscript.add(incoming)
                if (update.delta.isNotEmpty()) {
                    listener.onOutputTranscript(update.delta, update.full)
                }
            }

        if (content.optBoolean("turnComplete", false)) {
            listener.onTurnComplete()
            inputTranscript.reset()
            outputTranscript.reset()
        }
    }

    private class TranscriptAccumulator {
        data class Update(val delta: String, val full: String)
        private var value = ""

        fun reset() {
            value = ""
        }

        fun add(incoming: String): Update {
            if (value.isEmpty()) {
                value = incoming
                return Update(incoming, value)
            }
            if (incoming.startsWith(value)) {
                val delta = incoming.substring(value.length)
                value = incoming
                return Update(delta, value)
            }
            if (value.endsWith(incoming)) return Update("", value)

            val max = minOf(value.length, incoming.length)
            var overlap = 0
            for (n in max downTo 1) {
                if (value.regionMatches(value.length - n, incoming, 0, n)) {
                    overlap = n
                    break
                }
            }
            val delta = incoming.substring(overlap)
            value += delta
            return Update(delta, value)
        }
    }
}
