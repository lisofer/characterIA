package com.lisofer.genesis.world

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

class SimulationEngine(private val world: WorldState) {
    private val rng = XorShift64(world.rngState)

    @Synchronized
    fun setTimeScale(scale: Double, nowRealMs: Long) {
        advanceToRealTime(nowRealMs)
        world.timeScale = scale.coerceIn(0.0, 10000.0)
    }

    @Synchronized
    fun advanceToRealTime(nowRealMs: Long) {
        val elapsed = (nowRealMs - world.lastRealEpochMs).coerceAtLeast(0L)
        world.lastRealEpochMs = nowRealMs
        if (elapsed == 0L || world.timeScale <= 0.0) return
        val minutes = elapsed.toDouble() / 60000.0 * world.timeScale
        advance(minutes)
    }

    @Synchronized
    fun catchUp(nowRealMs: Long) {
        advanceToRealTime(nowRealMs)
    }

    @Synchronized
    fun manualAdvance(minutes: Double) {
        advance(minutes.coerceAtLeast(0.0))
    }

    @Synchronized
    fun save(store: WorldStore) {
        world.rngState = rng.state
        store.save(world)
    }

    @Synchronized
    fun snapshot(): WorldSnapshot {
        val humans = world.humans.map { h ->
            val needPenalty = (h.hunger + (1f - h.energy) + h.socialNeed) / 3f
            HumanSnapshot(
                id = h.id,
                name = h.name,
                x = h.x,
                y = h.y,
                age = h.ageYears(world.simMinute).roundToInt(),
                alive = h.alive,
                health = h.health,
                mood = (h.health * (1f - needPenalty * 0.55f)).coerceIn(0f, 1f),
                biologicalSex = h.biologicalSex
            )
        }
        return WorldSnapshot(
            simMinute = world.simMinute,
            timeScale = world.timeScale,
            population = humans.count { it.alive },
            temperatureC = world.temperatureC,
            stormSeverity = world.stormSeverity,
            humans = humans
        )
    }

    @Synchronized
    fun humanSummary(id: Int): String? {
        val h = world.humans.firstOrNull { it.id == id } ?: return null
        val status = if (h.alive) "salud ${(h.health * 100).toInt()}%" else "falleció"
        return "${h.name} · ${h.ageYears(world.simMinute).toInt()} años · $status"
    }

    @Synchronized
    fun buildChatPrompt(id: Int, userText: String): String? {
        val h = world.humans.firstOrNull { it.id == id && it.alive } ?: return null
        val relationText = h.relations.entries
            .sortedByDescending { abs(it.value.affection) + it.value.familiarity }
            .take(8)
            .joinToString("\n") { (otherId, r) ->
                val n = world.humans.firstOrNull { it.id == otherId }?.name ?: "persona $otherId"
                "- $n: familiaridad=${fmt(r.familiarity)}, confianza=${fmt(r.trust)}, afecto=${fmt(r.affection)}, atracción=${fmt(r.attraction)}, resentimiento=${fmt(r.resentment)}"
            }
        val memoryText = h.memories
            .sortedWith(compareByDescending<Memory> { it.importance }.thenByDescending { it.minute })
            .take(14)
            .joinToString("\n") { "- ${it.text}" }
        val ideaText = h.ideas.takeLast(10).joinToString("; ")
        return """
Sos ${h.name}, una persona que vive dentro de un mundo persistente. Hablás español natural y breve.
No sos narrador, asistente ni personaje de un juego: respondés como esta persona.
No conocés el estado global del mundo. Sólo podés afirmar como hecho lo que aparece en tus recuerdos o contexto.
Podés equivocarte, sospechar, mentir, tener prejuicios personales, cambiar de opinión o decir que no sabés.
No inventes acontecimientos pasados concretos para rellenar huecos. Sí podés imaginar, opinar, desear o proponer cosas nuevas.
No existe ninguna convención social obligatoria salvo la biología básica. Tus vínculos y deseos pueden dirigirse a cualquier persona.

TIEMPO DEL MUNDO: minuto ${world.simMinute.toLong()} (día ${(world.simMinute / DAY_MINUTES).toInt()})
EDAD: ${h.ageYears(world.simMinute).toInt()}
ESTADO: salud=${fmt(h.health)}, hambre=${fmt(h.hunger)}, energía=${fmt(h.energy)}, necesidad social=${fmt(h.socialNeed)}, curiosidad=${fmt(h.curiosityNeed)}
RASGOS [extroversión, amabilidad, responsabilidad, neuroticismo, apertura, riesgo, dominancia, empatía]: ${h.traits.joinToString(",") { fmt(it) }}
OBJETIVO ACTUAL: ${h.goal.ifBlank { "ninguno formulado" }}
IDEAS QUE CONOCÉS: ${ideaText.ifBlank { "ninguna registrada" }}
RELACIONES QUE RECORDÁS:
${relationText.ifBlank { "- todavía no conocés bien a nadie" }}
RECUERDOS RELEVANTES:
${memoryText.ifBlank { "- todavía tenés pocos recuerdos importantes" }}

Una persona externa te dice: "$userText"
Respondé únicamente con lo que dirías en voz propia, sin acotaciones teatrales y sin explicar estas reglas. Máximo 120 palabras.
""".trimIndent()
    }

    @Synchronized
    fun recordChat(id: Int, userText: String, response: String) {
        val h = world.humans.firstOrNull { it.id == id && it.alive } ?: return
        remember(h, "Una persona externa me dijo: ${userText.take(110)}", 0.42f, 0.05f, -100)
        remember(h, "Yo respondí: ${response.take(150)}", 0.34f, 0.05f, h.id)
        h.socialNeed = (h.socialNeed - 0.12f).coerceAtLeast(0f)
    }

    @Synchronized
    fun claimAiRequest(nowRealMs: Long): AiRequest? {
        if (nowRealMs - world.lastAiRealMs < 90_000L) return null
        if (world.simMinute - world.lastAiSimMinute < DAY_MINUTES / 2.0) return null
        val living = world.humans.filter { it.alive && it.ageYears(world.simMinute) >= 12.0 }
        if (living.isEmpty()) return null
        val h = living[rng.nextInt(living.size)]
        world.lastAiRealMs = nowRealMs
        world.lastAiSimMinute = world.simMinute
        val memories = h.memories.takeLast(10).joinToString("\n") { "- ${it.text}" }
        val known = h.relations.entries.sortedByDescending { it.value.familiarity }.take(6).joinToString("\n") { (id, r) ->
            val other = world.humans.firstOrNull { it.id == id }
            "- id=$id ${other?.name ?: "?"}: confianza=${fmt(r.trust)} afecto=${fmt(r.affection)} atracción=${fmt(r.attraction)} resentimiento=${fmt(r.resentment)}"
        }
        val prompt = """
Sos la cognición privada de ${h.name}. No escribas la historia del mundo y no busques crear drama.
Sólo decidí, con enorme libertad, qué intención humana podría surgir AHORA de esta persona según lo que realmente sabe.
Podés inventar una idea, palabra, hábito, gusto, plan, símbolo o costumbre si nace de su situación, pero no des por existente una institución que no aparezca en el contexto.
No hay reglas culturales preestablecidas sobre pareja, género, amistad, propiedad o jerarquía. La persona puede sentirse atraída por quien sea.
No controles a otras personas ni inventes hechos externos. Elegí una intención; el mundo decidirá si ocurre.

Edad: ${h.ageYears(world.simMinute).toInt()}
Rasgos: ${h.traits.joinToString(",") { fmt(it) }}
Estado: hambre=${fmt(h.hunger)} energía=${fmt(h.energy)} social=${fmt(h.socialNeed)} curiosidad=${fmt(h.curiosityNeed)} salud=${fmt(h.health)}
Objetivo previo: ${h.goal.ifBlank { "ninguno" }}
Ideas conocidas: ${h.ideas.takeLast(8).joinToString("; ").ifBlank { "ninguna" }}
Personas conocidas:
${known.ifBlank { "- ninguna" }}
Recuerdos:
${memories.ifBlank { "- pocos" }}

Respondé JSON puro con esta forma:
{"intention":"texto breve","target_id":null,"phrase":null,"new_idea":null}
- target_id sólo si quiere buscar/interactuar con una persona listada.
- phrase sólo si espontáneamente quiere decir una frase corta.
- new_idea sólo si realmente inventó algo nuevo.
""".trimIndent()
        return AiRequest(h.id, prompt)
    }

    @Synchronized
    fun applyAiThought(humanId: Int, thought: AiThought) {
        val h = world.humans.firstOrNull { it.id == humanId && it.alive } ?: return
        h.goal = thought.intention.take(220)
        thought.newIdea?.trim()?.takeIf { it.isNotBlank() }?.let { idea ->
            if (h.ideas.none { it.equals(idea, ignoreCase = true) }) {
                h.ideas += idea.take(160)
                if (h.ideas.size > 24) h.ideas.removeAt(0)
                remember(h, "Se me ocurrió: ${idea.take(150)}", 0.72f, 0.25f, h.id)
            }
        }
        thought.phrase?.trim()?.takeIf { it.isNotBlank() }?.let {
            remember(h, "Quise decir: ${it.take(150)}", 0.40f, 0.05f, h.id)
        }
        thought.targetId?.let { targetId ->
            val t = world.humans.firstOrNull { it.id == targetId && it.alive }
            if (t != null) {
                h.targetX = t.x
                h.targetY = t.y
                relation(h, t.id).familiarity = (relation(h, t.id).familiarity + 0.02f).coerceAtMost(1f)
            }
        }
    }

    private fun advance(totalMinutes: Double) {
        var remaining = totalMinutes.coerceAtMost(YEAR_MINUTES * 500.0)
        while (remaining > 0.00001) {
            val dt = when {
                remaining < 1.0 -> remaining
                remaining < DAY_MINUTES -> min(5.0, remaining)
                remaining < DAY_MINUTES * 30.0 -> min(30.0, remaining)
                remaining < YEAR_MINUTES * 5.0 -> min(360.0, remaining)
                remaining < YEAR_MINUTES * 50.0 -> min(DAY_MINUTES, remaining)
                else -> min(DAY_MINUTES * 3.0, remaining)
            }
            step(dt)
            remaining -= dt
        }
        world.rngState = rng.state
    }

    private fun step(dt: Double) {
        val beforeDay = (world.simMinute / DAY_MINUTES).toLong()
        world.simMinute += dt
        val afterDay = (world.simMinute / DAY_MINUTES).toLong()
        if (afterDay > beforeDay) {
            var d = beforeDay + 1
            while (d <= afterDay) {
                updateEnvironmentDay(d)
                d++
            }
        }

        val newborns = mutableListOf<Human>()
        val coarse = dt >= 120.0
        world.humans.toList().forEach { h ->
            if (!h.alive) return@forEach
            updateBiology(h, dt)
            if (!h.alive) return@forEach
            if (h.pregnancyDueMinute > 0 && world.simMinute >= h.pregnancyDueMinute) {
                newborns += makeChild(h)
                h.pregnancyDueMinute = -1.0
            }
            if (coarse) coarseMovement(h, dt) else detailedMovement(h, dt)
        }
        if (newborns.isNotEmpty()) world.humans += newborns

        world.socialAccumulatorMin += dt
        if (world.socialAccumulatorMin >= if (coarse) 180.0 else 5.0) {
            if (coarse) coarseSocial(world.socialAccumulatorMin) else detailedSocial(world.socialAccumulatorMin)
            world.socialAccumulatorMin = 0.0
        }
    }

    private fun updateBiology(h: Human, dt: Double) {
        val days = dt / DAY_MINUTES
        h.hunger = (h.hunger + (dt / (DAY_MINUTES * 1.65)).toFloat()).coerceIn(0f, 1f)
        h.energy = (h.energy - (dt / (DAY_MINUTES * 1.30)).toFloat()).coerceIn(0f, 1f)
        h.socialNeed = (h.socialNeed + (dt / (DAY_MINUTES * 3.8) * (0.40 + h.traits[0])).toFloat()).coerceIn(0f, 1f)
        h.curiosityNeed = (h.curiosityNeed + (dt / (DAY_MINUTES * 5.2) * (0.30 + h.traits[4])).toFloat()).coerceIn(0f, 1f)

        val atHome = distance(h.x, h.y, h.homeX, h.homeY) < 1.1f
        if (atHome && h.hunger > 0.38f) {
            val eaten = (0.82 * world.foodAbundance * min(1.0, dt / 180.0)).toFloat()
            h.hunger = (h.hunger - eaten).coerceAtLeast(0f)
        }
        if (atHome && h.energy < 0.62f) {
            h.energy = (h.energy + (dt / 430.0).toFloat()).coerceAtMost(1f)
        }

        if (h.hunger > 0.96f) h.health -= (days * (0.028 + h.hunger * 0.022)).toFloat()
        if (h.energy < 0.025f) h.health -= (days * 0.008).toFloat()

        if (h.infection > 0.001f) {
            h.infection = (h.infection + (days * 0.07)).toFloat().coerceAtMost(1f)
            h.health -= (days * h.infection * 0.014).toFloat()
            if (rng.chance(days * (0.18 + h.immunity * 0.42))) {
                h.immunity = (h.immunity + 0.30f).coerceAtMost(1f)
                h.infection *= 0.20f
                remember(h, "Me recuperé de una enfermedad.", 0.62f, 0.35f, h.id)
            }
        } else {
            h.immunity = (h.immunity - (days * 0.0012).toFloat()).coerceAtLeast(0f)
            if (h.hunger < 0.72f && h.energy > 0.18f) {
                h.health = (h.health + (days * 0.0045).toFloat()).coerceAtMost(1f)
            }
        }

        val age = h.ageYears(world.simMinute)
        val baseDailyMortality = when {
            age < 1 -> 0.000010
            age < 50 -> 0.000001
            age < 65 -> 0.000006
            age < 80 -> 0.000035
            else -> 0.000035 * 1.09.pow(age - 80.0)
        }
        val healthFactor = 1.0 + (1.0 - h.health) * 3.0
        if (rng.chance(days * baseDailyMortality * healthFactor) || h.health <= 0f) {
            die(h, if (h.health <= 0f) "murió tras un deterioro severo de su salud" else "murió")
        }
    }

    private fun detailedMovement(h: Human, dt: Double) {
        if (distance(h.x, h.y, h.targetX, h.targetY) < 0.25f) chooseTarget(h)
        val dx = h.targetX - h.x
        val dy = h.targetY - h.y
        val d = hypot(dx.toDouble(), dy.toDouble()).toFloat()
        if (d > 0.001f) {
            val maxStep = (dt * 0.065).toFloat()
            val step = min(d, maxStep)
            h.x = (h.x + dx / d * step).coerceIn(0.3f, MAP_W - 0.3f)
            h.y = (h.y + dy / d * step).coerceIn(0.3f, MAP_H - 0.3f)
        }
    }

    private fun coarseMovement(h: Human, dt: Double) {
        if (h.hunger > 0.52f || h.energy < 0.38f) {
            h.x = h.homeX
            h.y = h.homeY
            h.targetX = h.homeX
            h.targetY = h.homeY
        } else if (rng.chance(min(0.90, dt / DAY_MINUTES * 1.5))) {
            val p = WorldStore.randomBuildable(rng)
            h.x = p.first
            h.y = p.second
            h.targetX = p.first
            h.targetY = p.second
            h.curiosityNeed = (h.curiosityNeed - 0.08f).coerceAtLeast(0f)
        }
    }

    private fun chooseTarget(h: Human) {
        when {
            h.hunger > 0.52f || h.energy < 0.38f -> {
                h.targetX = h.homeX
                h.targetY = h.homeY
            }
            h.socialNeed > 0.56f -> {
                val candidates = world.humans.filter { it.alive && it.id != h.id }
                if (candidates.isNotEmpty()) {
                    val known = h.relations.entries.maxByOrNull { it.value.affection + it.value.familiarity }
                    val t = known?.let { entry -> candidates.firstOrNull { it.id == entry.key } }
                        ?: candidates[rng.nextInt(candidates.size)]
                    h.targetX = t.x
                    h.targetY = t.y
                }
            }
            else -> {
                val p = WorldStore.randomBuildable(rng)
                h.targetX = p.first
                h.targetY = p.second
                h.curiosityNeed = (h.curiosityNeed - 0.06f).coerceAtLeast(0f)
            }
        }
    }

    private fun detailedSocial(dt: Double) {
        val living = world.humans.filter { it.alive }
        val buckets = HashMap<Int, MutableList<Human>>()
        living.forEach { h ->
            val cx = h.x.toInt()
            val cy = h.y.toInt()
            buckets.getOrPut(cx + cy * 64) { mutableListOf() }.add(h)
        }
        val processed = HashSet<Long>()
        living.forEach { a ->
            val ax = a.x.toInt()
            val ay = a.y.toInt()
            for (ox in -1..1) for (oy in -1..1) {
                buckets[ax + ox + (ay + oy) * 64]?.forEach { b ->
                    if (a.id == b.id) return@forEach
                    val lo = min(a.id, b.id)
                    val hi = max(a.id, b.id)
                    val key = (lo.toLong() shl 32) or hi.toLong()
                    if (!processed.add(key)) return@forEach
                    if (distance(a.x, a.y, b.x, b.y) <= 1.25f) interact(a, b, dt)
                }
            }
        }
    }

    private fun coarseSocial(dt: Double) {
        val living = world.humans.filter { it.alive }
        if (living.size < 2) return
        val attempts = max(1, min(living.size * 2, (living.size * dt / DAY_MINUTES).roundToInt()))
        repeat(attempts) {
            val a = living[rng.nextInt(living.size)]
            var b = living[rng.nextInt(living.size)]
            if (a.id == b.id) b = living[(living.indexOf(a) + 1) % living.size]
            interact(a, b, min(dt, DAY_MINUTES))
        }
    }

    private fun interact(a: Human, b: Human, dt: Double) {
        val probability = min(0.88, dt / 45.0 * (0.16 + (a.traits[0] + b.traits[0]) * 0.18))
        if (!rng.chance(probability)) return

        val ra = relation(a, b.id)
        val rb = relation(b, a.id)
        val compatibility = 1f - abs(a.traits[1] - b.traits[1]) * 0.30f - abs(a.traits[4] - b.traits[4]) * 0.20f
        val chemistry = pairChemistry(a.id, b.id)

        if (ra.familiarity <= 0.0001f && rb.familiarity <= 0.0001f) {
            val baseline = ((chemistry - 0.50f) * 0.72f).coerceIn(-0.36f, 0.36f)
            ra.attraction = (baseline + (rng.nextFloat() - 0.5f) * 0.08f).coerceIn(-1f, 1f)
            rb.attraction = (baseline + (rng.nextFloat() - 0.5f) * 0.08f).coerceIn(-1f, 1f)
        }

        val tone = (compatibility * 0.55f + (a.traits[7] + b.traits[7]) * 0.18f + (rng.nextFloat() - 0.5f) * 0.35f).coerceIn(0f, 1f)
        ra.familiarity = (ra.familiarity + 0.018f).coerceAtMost(1f)
        rb.familiarity = (rb.familiarity + 0.018f).coerceAtMost(1f)
        val delta = (tone - 0.46f) * 0.040f
        ra.trust = (ra.trust + delta).coerceIn(-1f, 1f)
        rb.trust = (rb.trust + delta).coerceIn(-1f, 1f)
        ra.affection = (ra.affection + delta * 0.95f).coerceIn(-1f, 1f)
        rb.affection = (rb.affection + delta * 0.95f).coerceIn(-1f, 1f)
        ra.attraction = (ra.attraction + (chemistry - 0.46f) * 0.010f + delta * 0.35f).coerceIn(-1f, 1f)
        rb.attraction = (rb.attraction + (chemistry - 0.46f) * 0.010f + delta * 0.35f).coerceIn(-1f, 1f)

        if (tone < 0.28f) {
            ra.resentment = (ra.resentment + 0.03f).coerceAtMost(1f)
            rb.resentment = (rb.resentment + 0.03f).coerceAtMost(1f)
        } else {
            ra.resentment = (ra.resentment - 0.006f).coerceAtLeast(0f)
            rb.resentment = (rb.resentment - 0.006f).coerceAtLeast(0f)
        }

        a.socialNeed = (a.socialNeed - 0.08f).coerceAtLeast(0f)
        b.socialNeed = (b.socialNeed - 0.08f).coerceAtLeast(0f)

        if (rng.chance(0.10)) {
            remember(a, "Tuve un encuentro con ${b.name}; me dejó una impresión ${if (delta >= 0) "agradable" else "incómoda"}.", 0.28f, delta * 5f, b.id)
            remember(b, "Tuve un encuentro con ${a.name}; me dejó una impresión ${if (delta >= 0) "agradable" else "incómoda"}.", 0.28f, delta * 5f, a.id)
        }

        if (a.ideas.isNotEmpty() && rng.chance(0.08)) learnIdea(b, a.ideas[rng.nextInt(a.ideas.size)], a.id)
        if (b.ideas.isNotEmpty() && rng.chance(0.08)) learnIdea(a, b.ideas[rng.nextInt(b.ideas.size)], b.id)

        if (a.infection > 0.20f && b.infection < 0.05f && rng.chance(0.025 * (1.0 - b.immunity))) b.infection = 0.10f
        if (b.infection > 0.20f && a.infection < 0.05f && rng.chance(0.025 * (1.0 - a.immunity))) a.infection = 0.10f

        tryConception(a, b, ra, rb)

        if (tone < 0.15f && (a.traits[5] + b.traits[5] + a.traits[6] + b.traits[6]) > 2.45f && rng.chance(0.012)) {
            val victim = if (rng.chance(0.5)) a else b
            victim.health = (victim.health - (0.03f + rng.nextFloat() * 0.08f)).coerceAtLeast(0f)
            remember(a, "El encuentro con ${b.name} terminó en una agresión.", 0.86f, -0.75f, b.id)
            remember(b, "El encuentro con ${a.name} terminó en una agresión.", 0.86f, -0.75f, a.id)
        }
    }

    private fun tryConception(a: Human, b: Human, ra: Relation, rb: Relation) {
        if (a.biologicalSex == b.biologicalSex) return
        val female = if (a.biologicalSex == 1) a else b
        val male = if (a.biologicalSex == 0) a else b
        if (female.pregnancyDueMinute >= 0.0) return

        val femaleAge = female.ageYears(world.simMinute)
        val maleAge = male.ageYears(world.simMinute)
        if (femaleAge !in 18.0..43.0 || maleAge !in 16.0..75.0) return

        val mutualAttraction = min(ra.attraction, rb.attraction)
        val mutualTrust = min(ra.trust, rb.trust)
        val mutualFamiliarity = min(ra.familiarity, rb.familiarity)
        if (mutualAttraction < 0.10f || mutualTrust < -0.08f || mutualFamiliarity < 0.045f) return

        val fertilityByAge = when {
            femaleAge < 30.0 -> 1.0
            femaleAge < 36.0 -> 0.82
            femaleAge < 40.0 -> 0.55
            else -> 0.25
        }
        val chancePerEncounter = 0.0026 * fertilityByAge *
            (0.55 + mutualAttraction.coerceAtLeast(0f)) *
            (0.80 + mutualFamiliarity.coerceAtMost(0.8f))

        if (rng.chance(chancePerEncounter)) {
            female.pregnancyDueMinute = world.simMinute + DAY_MINUTES * (260.0 + rng.nextDouble() * 25.0)
            female.parentA = female.id
            female.parentB = male.id
            remember(female, "Estoy atravesando un embarazo; ${male.name} es el otro progenitor.", 0.93f, 0.55f, male.id)
            remember(male, "${female.name} está atravesando un embarazo y soy el otro progenitor.", 0.87f, 0.50f, female.id)
        }
    }

    private fun updateEnvironmentDay(day: Long) {
        world.climateA = (3.91 * world.climateA * (1.0 - world.climateA)).coerceIn(0.0001, 0.9999)
        world.climateB = (3.79 * world.climateB * (1.0 - world.climateB)).coerceIn(0.0001, 0.9999)
        world.temperatureC = 7.0 + world.climateA * 30.0
        val rawStorm = world.climateA * 0.57 + world.climateB * 0.63 + rng.nextDouble() * 0.16
        world.stormSeverity = ((rawStorm - 1.18) / 0.14).coerceIn(0.0, 1.0)
        world.foodAbundance = (world.foodAbundance * 0.97 + (0.90 - world.stormSeverity * 0.28) * 0.03).coerceIn(0.35, 1.0)
        world.lastClimateDay = day

        if (rng.chance(0.00055)) {
            val candidates = world.humans.filter { it.alive && it.infection < 0.05f }
            if (candidates.isNotEmpty()) candidates[rng.nextInt(candidates.size)].infection = 0.10f
        }

        if (world.stormSeverity > 0.72) {
            val severity = world.stormSeverity
            world.humans.filter { it.alive }.forEach { h ->
                val sheltered = distance(h.x, h.y, h.homeX, h.homeY) < 1.4f
                val hit = severity * if (sheltered) 0.0015 else 0.012
                h.health = (h.health - hit.toFloat() * (0.4f + rng.nextFloat() * 0.8f)).coerceAtLeast(0f)
                if (severity > 0.84 || rng.chance(0.15)) {
                    remember(h, "Una tormenta excepcional golpeó el lugar donde vivo.", 0.82f, -0.52f, -1)
                }

                // A truly catastrophic storm can kill, but it is deliberately rare.
                if (severity > 0.97) {
                    val fatalChance = if (sheltered) 0.0008 else 0.008
                    if (rng.chance(fatalChance)) {
                        die(h, "murió durante una tormenta extraordinaria")
                    }
                }
            }
        }
    }

    private fun makeChild(mother: Human): Human {
        val father = world.humans.firstOrNull { it.id == mother.parentB }
        val id = world.nextHumanId++
        val names = listOf("Ari", "Luz", "Nilo", "Uma", "Teo", "Iris", "Lía", "Gael", "Noa", "Ciro", "Mía", "Río", "Sol", "Luca", "Milo", "Eva")
        val traits = FloatArray(8) { i ->
            val base = if (father != null) (mother.traits[i] + father.traits[i]) / 2f else mother.traits[i]
            (base + (rng.nextFloat() - 0.5f) * 0.24f).coerceIn(0.03f, 0.97f)
        }
        val child = Human(
            id = id,
            name = names[rng.nextInt(names.size)] + if (id > 99) "-$id" else "",
            biologicalSex = rng.nextInt(2),
            birthMinute = world.simMinute,
            x = mother.x,
            y = mother.y,
            targetX = mother.x,
            targetY = mother.y,
            homeX = mother.homeX,
            homeY = mother.homeY,
            health = (0.86 + rng.nextDouble() * 0.13).toFloat(),
            hunger = 0.10f,
            energy = 0.78f,
            socialNeed = 0.18f,
            curiosityNeed = 0.88f,
            infection = 0f,
            immunity = mother.immunity * 0.10f,
            pregnancyDueMinute = -1.0,
            parentA = mother.id,
            parentB = father?.id ?: -1,
            alive = true,
            goal = "",
            traits = traits,
            relations = mutableMapOf(),
            memories = mutableListOf(),
            ideas = mutableListOf()
        )
        relation(mother, child.id).apply {
            familiarity = 1f
            trust = 0.9f
            affection = 0.9f
        }
        relation(child, mother.id).apply {
            familiarity = 1f
            trust = 0.8f
            affection = 0.8f
        }
        father?.let {
            relation(it, child.id).apply {
                familiarity = 1f
                trust = 0.85f
                affection = 0.85f
            }
            relation(child, it.id).apply {
                familiarity = 1f
                trust = 0.75f
                affection = 0.75f
            }
            remember(it, "Nació ${child.name}, mi descendiente con ${mother.name}.", 1f, 0.75f, child.id)
        }
        remember(mother, "Nació ${child.name}, mi descendiente.", 1f, 0.75f, child.id)
        return child
    }

    private fun die(h: Human, reason: String) {
        if (!h.alive) return
        h.alive = false
        h.health = 0f
        world.humans.filter { it.alive && it.id != h.id }.forEach { other ->
            val rel = other.relations[h.id] ?: return@forEach
            if (rel.familiarity > 0.18f || abs(rel.affection) > 0.18f) {
                val valence = (-0.25f - max(0f, rel.affection) * 0.65f).coerceAtLeast(-1f)
                remember(other, "${h.name} $reason.", (0.42f + abs(rel.affection) * 0.55f).coerceAtMost(1f), valence, h.id)
            }
        }
    }

    private fun learnIdea(h: Human, idea: String, sourceId: Int) {
        if (h.ideas.any { it.equals(idea, true) }) return
        h.ideas += idea.take(160)
        if (h.ideas.size > 24) h.ideas.removeAt(0)
        remember(h, "Aprendí una idea de otra persona: ${idea.take(140)}", 0.46f, 0.18f, sourceId)
    }

    private fun remember(h: Human, text: String, importance: Float, valence: Float, sourceId: Int) {
        h.memories += Memory(
            world.simMinute,
            importance.coerceIn(0f, 1f),
            valence.coerceIn(-1f, 1f),
            sourceId,
            text.take(220)
        )
        if (h.memories.size > 64) {
            val removable = h.memories.withIndex().minByOrNull {
                it.value.importance * 0.75f + (it.index.toFloat() / h.memories.size) * 0.25f
            }
            if (removable != null) h.memories.removeAt(removable.index)
        }
    }

    private fun relation(h: Human, otherId: Int): Relation = h.relations.getOrPut(otherId) { Relation() }

    private fun pairChemistry(a: Int, b: Int): Float {
        var z = (min(a, b).toLong() shl 32) xor max(a, b).toLong() xor 0x9E3779B97F4A7C15UL.toLong()
        z = (z xor (z ushr 30)) * 0xBF58476D1CE4E5B9UL.toLong()
        z = (z xor (z ushr 27)) * 0x94D049BB133111EBUL.toLong()
        z = z xor (z ushr 31)
        return ((z ushr 11).toDouble() / (1L shl 53).toDouble()).toFloat()
    }

    private fun distance(ax: Float, ay: Float, bx: Float, by: Float): Float =
        hypot((ax - bx).toDouble(), (ay - by).toDouble()).toFloat()

    private fun fmt(v: Float): String = "%.2f".format(v)
}