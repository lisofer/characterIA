package com.lisofer.genesis

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.lisofer.genesis.ai.GeminiClient
import com.lisofer.genesis.ui.WorldView
import com.lisofer.genesis.world.DAY_MINUTES
import com.lisofer.genesis.world.SimulationEngine
import com.lisofer.genesis.world.WorldSnapshot
import com.lisofer.genesis.world.WorldStore
import com.lisofer.genesis.world.YEAR_MINUTES
import java.text.DecimalFormat
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : Activity() {
    private lateinit var store: WorldStore
    private lateinit var engine: SimulationEngine
    private val gemini = GeminiClient()
    private val simExecutor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private val aiExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val active = AtomicBoolean(false)
    private val aiInFlight = AtomicBoolean(false)

    private lateinit var worldView: WorldView
    private lateinit var clockText: TextView
    private lateinit var statsText: TextView
    private lateinit var selectedText: TextView
    private lateinit var talkButton: Button
    private var selectedId: Int? = null
    private var lastSavedAt = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = WorldStore(this)
        engine = SimulationEngine(store.loadOrCreate())
        buildUi()
        startLoops()
        if (store.apiKey().isBlank()) {
            mainHandler.postDelayed({ showApiDialog(firstTime = true) }, 350)
        }
    }

    override fun onStart() {
        super.onStart()
        active.set(true)
        simExecutor.execute {
            engine.catchUp(System.currentTimeMillis())
            engine.save(store)
            postRefresh()
        }
    }

    override fun onStop() {
        active.set(false)
        simExecutor.execute {
            engine.advanceToRealTime(System.currentTimeMillis())
            engine.save(store)
        }
        super.onStop()
    }

    override fun onDestroy() {
        simExecutor.shutdownNow()
        aiExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(10, 12, 14))
            setPadding(dp(10), dp(10), dp(10), dp(10))
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val headerTexts = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        clockText = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 17f
            setTypeface(Typeface.MONOSPACE, Typeface.BOLD)
            text = "GENESIS"
        }
        statsText = TextView(this).apply {
            setTextColor(Color.rgb(170, 180, 178))
            textSize = 12f
            setTypeface(Typeface.MONOSPACE, Typeface.NORMAL)
            text = "Sincronizando mundo…"
        }
        headerTexts.addView(clockText)
        headerTexts.addView(statsText)
        header.addView(headerTexts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(Button(this).apply {
            text = "API"
            setOnClickListener { showApiDialog(firstTime = false) }
        }, LinearLayout.LayoutParams(dp(68), dp(46)))
        root.addView(header)

        val timeRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        listOf(
            "⏸" to 0.0,
            "1×" to 1.0,
            "10×" to 10.0,
            "100×" to 100.0,
            "1000×" to 1000.0
        ).forEach { (label, scale) ->
            timeRow.addView(Button(this).apply {
                text = label
                minWidth = dp(60)
                setOnClickListener {
                    simExecutor.execute {
                        engine.setTimeScale(scale, System.currentTimeMillis())
                        engine.save(store)
                        postRefresh()
                    }
                }
            }, LinearLayout.LayoutParams(dp(72), dp(48)))
        }
        listOf(
            "+1 día" to DAY_MINUTES,
            "+30 días" to DAY_MINUTES * 30.0,
            "+1 año" to YEAR_MINUTES
        ).forEach { (label, minutes) ->
            timeRow.addView(Button(this).apply {
                text = label
                setOnClickListener { manualAdvance(label, minutes) }
            }, LinearLayout.LayoutParams(dp(102), dp(48)))
        }
        root.addView(HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            addView(timeRow)
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(54)))

        worldView = WorldView(this).apply {
            onHumanSelected = { id ->
                selectedId = id
                selectedText.text = engine.humanSummary(id) ?: "Persona"
                talkButton.isEnabled = true
            }
        }
        root.addView(worldView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))

        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, 0)
        }
        selectedText = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 14f
            text = "Tocá a una persona para conocerla."
        }
        talkButton = Button(this).apply {
            text = "HABLAR"
            isEnabled = false
            setOnClickListener { selectedId?.let(::openChat) }
        }
        bottom.addView(selectedText, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        bottom.addView(talkButton, LinearLayout.LayoutParams(dp(100), dp(50)))
        root.addView(bottom)

        setContentView(root)
    }

    private fun startLoops() {
        simExecutor.scheduleAtFixedRate({
            if (!active.get()) return@scheduleAtFixedRate
            val now = System.currentTimeMillis()
            engine.advanceToRealTime(now)
            if (now - lastSavedAt > 15_000L) {
                engine.save(store)
                lastSavedAt = now
            }
            postRefresh()
        }, 0, 250, TimeUnit.MILLISECONDS)

        simExecutor.scheduleAtFixedRate({
            if (!active.get() || aiInFlight.get()) return@scheduleAtFixedRate
            val key = store.apiKey()
            if (key.isBlank()) return@scheduleAtFixedRate
            val request = engine.claimAiRequest(System.currentTimeMillis()) ?: return@scheduleAtFixedRate
            if (!aiInFlight.compareAndSet(false, true)) return@scheduleAtFixedRate
            aiExecutor.execute {
                try {
                    gemini.think(key, request.prompt).getOrNull()?.let { thought ->
                        engine.applyAiThought(request.humanId, thought)
                        engine.save(store)
                    }
                } finally {
                    aiInFlight.set(false)
                    postRefresh()
                }
            }
        }, 20, 20, TimeUnit.SECONDS)
    }

    private fun manualAdvance(label: String, minutes: Double) {
        Toast.makeText(this, "Adelantando $label…", Toast.LENGTH_SHORT).show()
        simExecutor.execute {
            engine.advanceToRealTime(System.currentTimeMillis())
            engine.manualAdvance(minutes)
            engine.save(store)
            postRefresh()
        }
    }

    private fun postRefresh() {
        val snap = engine.snapshot()
        mainHandler.post { refreshUi(snap) }
    }

    private fun refreshUi(snapshot: WorldSnapshot) {
        val days = snapshot.simMinute / DAY_MINUTES
        val years = days / 365.2425
        val timeText = when {
            years >= 1.0 -> "Año ${years.toInt() + 1} · día ${(days % 365.2425).toInt() + 1}"
            else -> "Día ${days.toInt() + 1} · ${formatHour(snapshot.simMinute)}"
        }
        clockText.text = "$timeText   ${formatScale(snapshot.timeScale)}"
        val storm = if (snapshot.stormSeverity > 0.7) " · tormenta ${(snapshot.stormSeverity * 100).toInt()}%" else ""
        statsText.text = "Población ${snapshot.population} · ${snapshot.temperatureC.toInt()} °C$storm"
        worldView.setWorld(snapshot, selectedId)
        selectedId?.let { id ->
            val human = snapshot.humans.firstOrNull { it.id == id && it.alive }
            if (human == null) {
                selectedText.text = "Esta persona ya no está viva."
                talkButton.isEnabled = false
            } else {
                selectedText.text = engine.humanSummary(id) ?: human.name
                talkButton.isEnabled = true
            }
        }
    }

    private fun showApiDialog(firstTime: Boolean) {
        val input = EditText(this).apply {
            hint = "AIza…"
            setText(store.apiKey())
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            textSize = 16f
        }
        val message = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), 0, dp(20), 0)
            addView(TextView(this@MainActivity).apply {
                text = "Genesis usa Gemini 2.5 Flash-Lite sólo para conversaciones y pensamientos ocasionales. La simulación vive localmente."
                textSize = 14f
            })
            addView(input, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(58)))
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle(if (firstTime) "Conectar Gemini" else "API de Gemini")
            .setView(message)
            .setPositiveButton("GUARDAR") { _, _ ->
                store.saveApiKey(input.text.toString())
                Toast.makeText(this, if (input.text.isBlank()) "La simulación seguirá sin IA." else "API guardada en este teléfono.", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton(if (firstTime) "AHORA NO" else "CANCELAR", null)
            .create()
        dialog.show()
    }

    private fun openChat(humanId: Int) {
        if (store.apiKey().isBlank()) {
            showApiDialog(firstTime = true)
            return
        }
        val title = engine.humanSummary(humanId) ?: return
        val dialog = Dialog(this)
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(14), dp(14), dp(14))
            setBackgroundColor(Color.rgb(18, 21, 23))
        }
        root.addView(TextView(this).apply {
            text = title
            setTextColor(Color.WHITE)
            textSize = 19f
            setTypeface(Typeface.DEFAULT, Typeface.BOLD)
        })
        val transcript = TextView(this).apply {
            setTextColor(Color.rgb(225, 230, 228))
            textSize = 16f
            setPadding(0, dp(10), 0, dp(10))
            text = "Te acercaste."
        }
        val scroll = ScrollView(this).apply { addView(transcript) }
        root.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        val input = EditText(this).apply {
            hint = "Escribí…"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            maxLines = 4
            textSize = 16f
        }
        root.addView(input, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val close = Button(this).apply { text = "SALIR"; setOnClickListener { dialog.dismiss() } }
        val send = Button(this).apply { text = "ENVIAR" }
        buttons.addView(close, LinearLayout.LayoutParams(0, dp(50), 1f))
        buttons.addView(send, LinearLayout.LayoutParams(0, dp(50), 1f))
        root.addView(buttons)

        send.setOnClickListener {
            val message = input.text.toString().trim()
            if (message.isBlank()) return@setOnClickListener
            val prompt = engine.buildChatPrompt(humanId, message)
            if (prompt == null) {
                Toast.makeText(this, "Ya no podés hablar con esta persona.", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            transcript.append("\n\nVos: $message\n\n…")
            input.setText("")
            send.isEnabled = false
            scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
            aiExecutor.execute {
                val result = gemini.chat(store.apiKey(), prompt)
                mainHandler.post {
                    send.isEnabled = true
                    if (result.isSuccess) {
                        val response = result.getOrThrow()
                        transcript.text = transcript.text.toString().removeSuffix("…") + "$response"
                        engine.recordChat(humanId, message, response)
                        simExecutor.execute { engine.save(store) }
                    } else {
                        transcript.text = transcript.text.toString().removeSuffix("…") + "[Error: ${result.exceptionOrNull()?.message ?: "sin respuesta"}]"
                    }
                    scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
                }
            }
        }

        dialog.setContentView(root)
        dialog.window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
        dialog.show()
        dialog.window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
    }

    private fun formatHour(simMinute: Double): String {
        val minuteOfDay = ((simMinute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES
        val h = (minuteOfDay / 60.0).toInt()
        val m = (minuteOfDay % 60.0).toInt()
        return "%02d:%02d".format(h, m)
    }

    private fun formatScale(scale: Double): String {
        if (scale == 0.0) return "PAUSA"
        return if (scale >= 1000) "×${DecimalFormat("0").format(scale)}" else "×${DecimalFormat("0.#").format(scale)}"
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
