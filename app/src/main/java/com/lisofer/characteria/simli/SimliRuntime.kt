package com.lisofer.characteria.simli

import android.content.Context
import io.livekit.android.renderer.SurfaceViewRenderer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Process-local bridge so the clean CharacterIA audio path can hand Fish PCM to Simli. */
object SimliRuntime {
    data class State(
        val enabled: Boolean = false,
        val connecting: Boolean = false,
        val ready: Boolean = false,
        val videoReady: Boolean = false,
        val status: String = "Simli apagado",
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var client: SimliAvatarClient? = null
    private var renderer: SurfaceViewRenderer? = null
    private var fingerprint: String = ""

    @Synchronized
    fun configure(
        context: Context,
        apiKey: String,
        faceId: String,
        enabled: Boolean,
        shouldRun: Boolean,
    ) {
        val usable = enabled && apiKey.isNotBlank() && faceId.isNotBlank()
        if (!usable || !shouldRun) {
            if (client != null) stop(if (usable) "Simli en espera" else "Simli apagado")
            else _state.value = State(enabled = usable, status = if (usable) "Simli en espera" else "Simli apagado")
            return
        }

        val newFingerprint = "${apiKey.trim().hashCode()}:${faceId.trim()}"
        if (client != null && fingerprint == newFingerprint) return

        stop("Simli · reiniciando")
        fingerprint = newFingerprint
        _state.value = State(enabled = true, connecting = true, status = "Simli · conectando…")

        val created = SimliAvatarClient(context, scope, object : SimliAvatarClient.Listener {
            override fun onStatus(message: String) {
                _state.update { it.copy(status = message) }
            }

            override fun onReady() {
                _state.update { it.copy(enabled = true, connecting = false, ready = true, status = "Simli · listo") }
            }

            override fun onVideoReady() {
                _state.update { it.copy(videoReady = true, status = "Simli · avatar listo") }
            }

            override fun onError(message: String) {
                _state.update { it.copy(connecting = false, ready = false, videoReady = false, status = message) }
            }
        })
        client = created
        renderer?.let(created::bindRenderer)
        created.start(apiKey.trim(), faceId.trim())
    }

    @Synchronized
    fun bindRenderer(view: SurfaceViewRenderer?) {
        if (renderer === view) return
        client?.bindRenderer(view)
        renderer = view
        if (view != null) client?.bindRenderer(view)
    }

    /** True means Simli accepted the chunk and its LiveKit audio owns playback. */
    fun routePcm(pcm44k: ByteArray): Boolean = client?.sendFishPcm(pcm44k) == true

    fun clearBuffer() {
        client?.clearBuffer()
    }

    @Synchronized
    fun stop(status: String = "Simli apagado") {
        client?.stop()
        client = null
        fingerprint = ""
        _state.value = State(enabled = false, status = status)
    }
}
