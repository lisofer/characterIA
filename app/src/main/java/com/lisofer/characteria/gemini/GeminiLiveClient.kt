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

    data class Config(
        val apiKey: String,
        val model: String,
        val personality: String,
    )

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    @Volatile private var socket: WebSocket? = null
    @Volatile private var desiredConnected = false
    @Volatile private var setupComplete = false
    @Volatile private var config: Config? = null
    @Volatile private var resumeHandle: String? = null
    private val reconnectScheduled = AtomicBoolean(false)
    private var reconnectJob: Job? = null

    private val inputTranscript = TranscriptAccumulator()
    private val outputTranscript = TranscriptAccumulator()

    fun connect(config: Config) {
        this.config = config
        desiredConnected = true
        resumeHandle = null
        inputTranscript.reset()
        outputTranscript.reset()
        openSocket(isReconnect = false)
    }

    fun disconnect() {
        desiredConnected = false
        reconnectJob?.cancel()
        reconnectScheduled.set(false)
        setupComplete = false
        socket?.close(1000, "user disconnect")
        socket = null
        inputTranscript.reset()
        outputTranscript.reset()
    }

    fun sendPcm16(pcm: ByteArray) {
        if (!setupComplete || pcm.isEmpty()) return
        val data = Base64.encodeToString(pcm, Base64.NO_WRAP)
        val message = JSONObject()
            .put("realtimeInput", JSONObject().put(
                "audio",
                JSONObject()
                    .put("data", data)
                    .put("mimeType", "audio/pcm;rate=16000")
            ))
        socket?.send(message.toString())
    }

    private fun openSocket(isReconnect: Boolean) {
        val cfg = config ?: return
        setupComplete = false
        listener.onStatus(if (isReconnect) "Reconectando Gemini…" else "Conectando Gemini…")

        val request = Request.Builder()
            .url(
                "wss://generativelanguage.googleapis.com/ws/" +
                    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
                    "?key=${cfg.apiKey}"
            )
            .build()

        lateinit var thisSocket: WebSocket
        val callback = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket !== socket) return
                listener.onDiagnostic("Gemini WebSocket abierto")
                webSocket.send(buildSetup(cfg).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== socket) return
                runCatching { handleMessage(JSONObject(text)) }
                    .onFailure { listener.onDiagnostic("Gemini parse: ${it.message}") }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== socket) return
                listener.onDiagnostic("Gemini closing $code: $reason")
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== socket) return
                setupComplete = false
                listener.onDiagnostic("Gemini cerrado $code: $reason")
                if (desiredConnected) scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (webSocket !== socket) return
                setupComplete = false
                listener.onDiagnostic("Gemini fallo: ${t::class.simpleName}: ${t.message}")
                if (desiredConnected) scheduleReconnect()
                else listener.onError("Gemini: ${t.message ?: "error de conexión"}")
            }
        }

        thisSocket = client.newWebSocket(request, callback)
        socket = thisSocket
    }

    private fun scheduleReconnect() {
        if (!desiredConnected || !reconnectScheduled.compareAndSet(false, true)) return
        listener.onStatus("Reconectando…")
        reconnectJob = scope.launch(Dispatchers.IO) {
            delay(700)
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
                "systemInstruction",
                JSONObject().put("parts", JSONArray().put(JSONObject().put("text", cfg.personality)))
            )
            .put(
                "realtimeInputConfig",
                JSONObject()
                    .put(
                        "automaticActivityDetection",
                        JSONObject()
                            .put("disabled", false)
                            .put("startOfSpeechSensitivity", "START_SENSITIVITY_LOW")
                            .put("endOfSpeechSensitivity", "END_SENSITIVITY_LOW")
                            .put("prefixPaddingMs", 40)
                            .put("silenceDurationMs", 650)
                    )
                    .put("turnCoverage", "TURN_INCLUDES_ONLY_ACTIVITY")
            )
            .put(
                "contextWindowCompression",
                JSONObject()
                    .put("triggerTokens", 25_000)
                    .put("slidingWindow", JSONObject().put("targetTokens", 8_000))
            )
            .put("inputAudioTranscription", JSONObject())
            .put("outputAudioTranscription", JSONObject())

        val sessionResumption = JSONObject()
        resumeHandle?.takeIf { it.isNotBlank() }?.let { sessionResumption.put("handle", it) }
        setup.put("sessionResumption", sessionResumption)

        return JSONObject().put("setup", setup)
    }

    private fun handleMessage(root: JSONObject) {
        if (root.has("setupComplete")) {
            setupComplete = true
            inputTranscript.reset()
            outputTranscript.reset()
            listener.onDiagnostic("Gemini setupComplete")
            listener.onReady(resumeHandle != null)
        }

        root.optJSONObject("sessionResumptionUpdate")?.let { update ->
            if (update.optBoolean("resumable", false)) {
                update.optString("newHandle").takeIf { it.isNotBlank() }?.let {
                    resumeHandle = it
                    listener.onDiagnostic("Gemini: handle de reanudación actualizado")
                }
            }
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

        fun reset() { value = "" }

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
