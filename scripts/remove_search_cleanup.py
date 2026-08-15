from pathlib import Path

# Remove Google Search from Gemini Live completely and keep fallback quota-only.
g_path = Path('app/src/main/java/com/lisofer/characteria/gemini/GeminiLiveClient.kt')
g = g_path.read_text()

g = g.replace('import android.os.SystemClock\n', '')
g = g.replace('        val fallbackModels: List<String> = emptyList(),\n        val enableGoogleSearch: Boolean = true,\n', '        val fallbackModels: List<String> = emptyList(),\n')
g = g.replace('    @Volatile private var lastReadyAtMs: Long = 0L\n', '')
g = g.replace('        lastReadyAtMs = 0L\n', '')

old_closed = '''                val explicitQuota = isQuotaError(reason)\n                val rapid1011 = code == 1011 && wasReadyOnlyBriefly()\n                if (explicitQuota || rapid1011) {\n                    if (tryFallbackModel(webSocket, cfg.model, "cierre $code ${reason.ifBlank { "sin motivo" }}")) return\n                    if (explicitQuota) {\n                        desiredConnected = false\n                        listener.onError("Se agotó la cuota disponible de los modelos Gemini Live.")\n                        return\n                    }\n                }\n'''
new_closed = '''                val explicitQuota = isQuotaError(reason)\n                if (explicitQuota) {\n                    if (tryFallbackModel(webSocket, cfg.model, "cierre $code ${reason.ifBlank { "sin motivo" }}")) return\n                    desiredConnected = false\n                    listener.onError("Se agotó la cuota disponible de los modelos Gemini Live.")\n                    return\n                }\n'''
if old_closed not in g:
    raise SystemExit('onClosed quota block not found')
g = g.replace(old_closed, new_closed, 1)

old_failure = '''                val explicitQuota = isQuotaError(detail)\n                val rapid1011 = detail.contains("1011") && wasReadyOnlyBriefly()\n                if (explicitQuota || rapid1011) {\n                    if (tryFallbackModel(webSocket, cfg.model, detail)) return\n                    if (explicitQuota) {\n                        desiredConnected = false\n                        listener.onError("Se agotó la cuota disponible de los modelos Gemini Live.")\n                        return\n                    }\n                }\n'''
new_failure = '''                val explicitQuota = isQuotaError(detail)\n                if (explicitQuota) {\n                    if (tryFallbackModel(webSocket, cfg.model, detail)) return\n                    desiredConnected = false\n                    listener.onError("Se agotó la cuota disponible de los modelos Gemini Live.")\n                    return\n                }\n'''
if old_failure not in g:
    raise SystemExit('onFailure quota block not found')
g = g.replace(old_failure, new_failure, 1)

g = g.replace('        listener.onDiagnostic("Gemini cuota/fallo rápido en $failedModel · cambio automático a $nextModel")\n', '        listener.onDiagnostic("Gemini cuota agotada en $failedModel · cambio automático a $nextModel")\n')

google_block = '''\n        if (cfg.enableGoogleSearch) {\n            setup.put(\n                "tools",\n                JSONArray().put(JSONObject().put("googleSearch", JSONObject()))\n            )\n        }\n'''
if google_block not in g:
    raise SystemExit('Google Search setup block not found')
g = g.replace(google_block, '\n', 1)

ready_line = '            lastReadyAtMs = SystemClock.elapsedRealtime()\n'
g = g.replace(ready_line, '')

start = g.find('    private fun wasReadyOnlyBriefly(): Boolean {')
if start != -1:
    end = g.find('    private fun isQuotaError(text: String): Boolean {', start)
    if end == -1:
        raise SystemExit('isQuotaError anchor not found')
    g = g[:start] + g[end:]

g = g.replace('        private const val RAPID_FAILURE_MS = 8_000L\n', '')
g_path.write_text(g)

# Remove Search flags from every Gemini session call.
vm_path = Path('app/src/main/java/com/lisofer/characteria/CharacterViewModel.kt')
s = vm_path.read_text()
s = s.replace('                enableGoogleSearch = true,\n', '')
s = s.replace('                enableGoogleSearch = false,\n', '')
vm_path.write_text(s)
