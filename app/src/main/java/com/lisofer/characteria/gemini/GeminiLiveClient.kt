package com.lisofer.characteria.gemini

import android.os.SystemClock
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
        fun onModelChanged(model: String, reason: String)
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
        val fallbackModels: List<String> = emptyList(),
        val enableGoogleSearch: Boolean = true,
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
    @Volatile private var sessionHandle: String? = null
    @Volatile private var lastReadyAtMs: Long = 0L

    private val reconnectScheduled = AtomicBoolean(false)
    private var reconnectJob: Job? = null
    private var setupTimeoutJob: Job? = null
    private var stabilityJob: Job? = null
    private var reconnectAttempts = 0

    private val inputTranscript = TranscriptAccumulator()
    private val outputTranscript = TranscriptAccumulator()

    fun connect(config: Config) {
        disconnectInternal(closeSocket = true)
        this.config = config
        desiredConnected = true
        hasEverBeenReady = false
        sessionHandle = null
        reconnectAttempts = 0
        lastReadyAtMs = 0L
        inputTranscript.reset()
        outputTranscript.reset()
        openSocket(isReconnect = false)
    }

    fun updateHistory(history: List<HistoryTurn>) {
        config = config?.copy(history = history)
    }

    fun disconnect() {
        desiredConnected = false
        sessionHandle = null
        reconnectAttempts = 0
        disconnectInternal(closeSocket = true)
        inputTranscript.reset()
        outputTranscript.reset()
    }

    private fun disconnectInternal(closeSocket: Boolean) {
        reconnectJob?.cancel()
        reconnectJob = null
        setupTimeoutJob?.cancel()
        setupTimeoutJob = null
        stabilityJob?.cancel()
        stabilityJob = null
        reconnectScheduled.set(false)
        setupComplete = false
        if (closeSocket) {
            val old = socket
            socket = null
            runCatching { old?.close(1000, "user disconnect") }
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

    private fun openSocket(isReconnect: Boolean) {
        val cfg = config ?: return
        val resumeHandle = if (isReconnect) sessionHandle else null
        val actuallyResuming = isReconnect && !resumeHandle.isNullOrBlank()
        setupComplete = false
        setupTimeoutJob?.cancel()
        stabilityJob?.cancel()
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
                listener.onDiagnostic(
                    "Gemini WebSocket abierto · ${cfg.model} · HTTP ${response.code}" +
                        if (actuallyResuming) " · reanudando" else ""
                )

                val payload = buildSetup(cfg, resumeHandle).toString()
                val sent = webSocket.send(payload)
                listener.onDiagnostic(if (sent) "Gemini setup enviado" else "Gemini setup NO pudo enviarse")

                setupTimeoutJob?.cancel()
                setupTimeoutJob = scope.launch(Dispatchers.IO) {
                    delay(12_000)
                    if (desiredConnected && webSocket === socket && !setupComplete) {
                        listener.onDiagnostic("Gemini: timeout esperando setupComplete")
                        if (!tryFallbackModel(webSocket, cfg.model, "timeout de conexión")) {
                            desiredConnected = false
                            listener.onError("Gemini no confirmó la sesión en 12 s. Revisá la API key o la cuota disponible.")
                            webSocket.cancel()
                        }
                    }
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== socket) return
                handleRawMessage(webSocket, text, actuallyResuming)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (webSocket !== socket) return
                listener.onDiagnostic("Gemini recibió frame binario (${bytes.size} bytes)")
                handleRawMessage(webSocket, bytes.utf8(), actuallyResuming)
            }

            private fun handleRawMessage(webSocket: WebSocket, text: String, resumedConnection: Boolean) {
                runCatching {
                    val root = JSONObject(text)
                    if (root.has("error")) {
                        val error = root.opt("error")?.toString() ?: "error desconocido"
                        listener.onDiagnostic("Gemini error de servidor: $error")
                        if (isQuotaError(error) && tryFallbackModel(webSocket, cfg.model, error)) return

                        desiredConnected = false
                        listener.onError(
                            if (isQuotaError(error)) "Se agotó la cuota disponible de los modelos Gemini Live."
                            else "Gemini rechazó la sesión: $error"
                        )
                        socket = null
                        webSocket.cancel()
                        return
                    }
                    handleMessage(webSocket, root, resumedConnection)
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

                val rapid1011 = code == 1011 && wasReadyOnlyBriefly()
                if ((isQuotaError(reason) || rapid1011) && tryFallbackModel(webSocket, cfg.model, "cierre $code ${reason.ifBlank { "sin motivo" }}")) {
                    return
                }

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

                val likelyQuota = isQuotaError(detail) || (detail.contains("1011") && wasReadyOnlyBriefly())
                if (likelyQuota && tryFallbackModel(webSocket, cfg.model, detail)) return

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

    private fun scheduleReconnect(
        delayMs: Long = 700,
        rolloverSocket: WebSocket? = null,
        countAttempt: Boolean = true,
    ) {
        if (!desiredConnected || !reconnectScheduled.compareAndSet(false, true)) return

        if (countAttempt) {
            reconnectAttempts += 1
            if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                reconnectScheduled.set(false)
                desiredConnected = false
                listener.onError("Gemini no pudo estabilizar la conexión después de $MAX_RECONNECT_ATTEMPTS intentos.")
                return
            }
        }

        listener.onStatus(if (rolloverSocket != null) "Renovando sesión Gemini…" else "Reconectando Gemini…")
        reconnectJob = scope.launch(Dispatchers.IO) {
            delay(delayMs)
            if (!desiredConnected) {
                reconnectScheduled.set(false)
                return@launch
            }

            if (rolloverSocket != null && rolloverSocket === socket) {
                socket = null
                runCatching { rolloverSocket.close(1000, "session rollover") }
            }

            reconnectScheduled.set(false)
            if (desiredConnected) openSocket(isReconnect = true)
        }
    }

    private fun tryFallbackModel(failedSocket: WebSocket, failedModel: String, reason: String): Boolean {
        val cfg = config ?: return false
        if (cfg.model != failedModel) return true

        val candidates = buildList {
            add(cfg.model)
            cfg.fallbackModels.forEach { model -> if (model !in this) add(model) }
        }
        val currentIndex = candidates.indexOf(failedModel).coerceAtLeast(0)
        val nextModel = candidates.drop(currentIndex + 1).firstOrNull() ?: return false

        listener.onDiagnostic("Gemini cuota/fallo rápido en $failedModel · cambio automático a $nextModel")
        config = cfg.copy(model = nextModel)
        sessionHandle = null
        setupComplete = false
        hasEverBeenReady = false
        reconnectAttempts = 0
        lastReadyAtMs = 0L
        reconnectJob?.cancel()
        stabilityJob?.cancel()
        reconnectScheduled.set(false)
        listener.onModelChanged(nextModel, reason)

        if (failedSocket === socket) socket = null
        runCatching { failedSocket.cancel() }
        scope.launch(Dispatchers.IO) {
            delay(180)
            if (desiredConnected && config?.model == nextModel) openSocket(isReconnect = false)
        }
        return true
    }

    private fun buildSetup(cfg: Config, resumeHandle: String?): JSONObject {
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
            .put(
                "contextWindowCompression",
                JSONObject()
                    .put("triggerTokens", "25000")
                    .put("slidingWindow", JSONObject().put("targetTokens", "8000"))
            )
            .put(
                "sessionResumption",
                JSONObject().apply {
                    resumeHandle?.takeIf { it.isNotBlank() }?.let { put("handle", it) }
                }
            )

        if (cfg.enableGoogleSearch) {
            setup.put(
                "tools",
                JSONArray().put(JSONObject().put("googleSearch", JSONObject()))
            )
        }

        if (cfg.personality.isNotBlank()) {
            setup.put(
                "systemInstruction",
                JSONObject().put(
                    "parts",
                    JSONArray().put(JSONObject().put("text", cfg.personality))
                )
            )
        }

        if (cfg.history.isNotEmpty() && resumeHandle.isNullOrBlank()) {
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

    private fun handleMessage(webSocket: WebSocket, root: JSONObject, resumedConnection: Boolean) {
        root.optJSONObject("sessionResumptionUpdate")?.let { update ->
            val resumable = update.optBoolean("resumable", false)
            val handle = update.optString("newHandle").ifBlank { update.optString("token") }
            if (resumable && handle.isNotBlank()) {
                val changed = handle != sessionHandle
                sessionHandle = handle
                if (changed) listener.onDiagnostic("Gemini sesión reanudable actualizada")
            }
        }

        if (root.has("setupComplete")) {
            setupTimeoutJob?.cancel()
            setupTimeoutJob = null
            val cfg = config
            if (!resumedConnection && cfg != null && cfg.history.isNotEmpty()) {
                sendInitialHistory(webSocket, cfg.history)
            }
            setupComplete = true
            hasEverBeenReady = true
            lastReadyAtMs = SystemClock.elapsedRealtime()
            inputTranscript.reset()
            outputTranscript.reset()
            listener.onDiagnostic(if (resumedConnection) "Gemini setupComplete · sesión reanudada" else "Gemini setupComplete")
            listener.onReady(resumedConnection)

            stabilityJob?.cancel()
            stabilityJob = scope.launch(Dispatchers.IO) {
                delay(STABLE_CONNECTION_MS)
                if (desiredConnected && webSocket === socket && setupComplete) {
                    reconnectAttempts = 0
                    listener.onDiagnostic("Gemini conexión estable · contador de reconexión reiniciado")
                }
            }
        }

        root.optJSONObject("goAway")?.let { goAway ->
            listener.onDiagnostic("Gemini GoAway: ${goAway.opt("timeLeft")}")
            if (desiredConnected && !sessionHandle.isNullOrBlank()) {
                scheduleReconnect(delayMs = 120, rolloverSocket = webSocket, countAttempt = false)
            } else {
                listener.onStatus("Gemini va a renovar la conexión…")
            }
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

    private fun wasReadyOnlyBriefly(): Boolean {
        val readyAt = lastReadyAtMs
        return readyAt > 0L && SystemClock.elapsedRealtime() - readyAt < RAPID_FAILURE_MS
    }

    private fun isQuotaError(text: String): Boolean {
        val value = text.lowercase()
        return value.contains("resource_exhausted") ||
            value.contains("resource exhausted") ||
            value.contains("quota") ||
            value.contains("rate limit") ||
            value.contains("rate_limit") ||
            value.contains("too many requests") ||
            value.contains("429") ||
            value.contains("exceeded your current")
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

    companion object {
        private const val MAX_RECONNECT_ATTEMPTS = 3
        private const val STABLE_CONNECTION_MS = 15_000L
        private const val RAPID_FAILURE_MS = 8_000L
    }
}
