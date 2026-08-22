package com.lisofer.genesis.ai

import com.lisofer.genesis.world.AiThought
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

class GeminiClient {
    // Gemini 2.5 Flash-Lite is no longer available to new API users.
    private val model = "gemini-3.5-flash-lite"

    fun chat(apiKey: String, prompt: String): Result<String> = runCatching {
        val text = generate(apiKey, prompt, jsonMode = false, temperature = 0.95, maxTokens = 320)
        text.trim().ifBlank { "No sé qué decirte ahora." }
    }

    fun think(apiKey: String, prompt: String): Result<AiThought> = runCatching {
        val raw = generate(apiKey, prompt, jsonMode = true, temperature = 1.20, maxTokens = 260)
        val clean = raw.trim().removePrefix("```json").removePrefix("```").removeSuffix("```").trim()
        val json = JSONObject(clean)
        AiThought(
            intention = json.optString("intention", "").take(220),
            targetId = if (json.isNull("target_id")) null else json.optInt("target_id").takeIf { it > 0 },
            phrase = json.optString("phrase", "").takeIf { it.isNotBlank() }?.take(160),
            newIdea = json.optString("new_idea", "").takeIf { it.isNotBlank() }?.take(160)
        )
    }

    private fun generate(
        apiKey: String,
        prompt: String,
        jsonMode: Boolean,
        temperature: Double,
        maxTokens: Int
    ): String {
        require(apiKey.isNotBlank()) { "Falta la API key de Gemini." }
        val url = URL("https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent")
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 45_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("x-goog-api-key", apiKey.trim())
        }

        val generationConfig = JSONObject()
            .put("temperature", temperature)
            .put("maxOutputTokens", maxTokens)
        if (jsonMode) generationConfig.put("responseMimeType", "application/json")

        val body = JSONObject()
            .put("contents", JSONArray().put(
                JSONObject().put("parts", JSONArray().put(JSONObject().put("text", prompt)))
            ))
            .put("generationConfig", generationConfig)

        connection.outputStream.bufferedWriter(Charsets.UTF_8).use { it.write(body.toString()) }
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val payload = BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { it.readText() }
        connection.disconnect()
        if (code !in 200..299) {
            val message = runCatching { JSONObject(payload).optJSONObject("error")?.optString("message") }.getOrNull()
            error(message ?: "Gemini devolvió HTTP $code")
        }
        val root = JSONObject(payload)
        val candidates = root.optJSONArray("candidates") ?: error("Gemini no devolvió candidatos.")
        if (candidates.length() == 0) error("Gemini no devolvió respuesta.")
        val parts = candidates.getJSONObject(0).getJSONObject("content").getJSONArray("parts")
        val sb = StringBuilder()
        for (i in 0 until parts.length()) {
            val t = parts.getJSONObject(i).optString("text", "")
            if (t.isNotBlank()) sb.append(t)
        }
        return sb.toString()
    }
}