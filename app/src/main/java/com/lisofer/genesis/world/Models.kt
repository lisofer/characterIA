package com.lisofer.genesis.world

const val MAP_W = 24f
const val MAP_H = 24f
const val DAY_MINUTES = 1440.0
const val YEAR_MINUTES = DAY_MINUTES * 365.2425

class XorShift64(var state: Long) {
    init {
        if (state == 0L) state = 0x5EEDC0DEL
    }

    fun nextLong(): Long {
        var x = state
        x = x xor (x shl 13)
        x = x xor (x ushr 7)
        x = x xor (x shl 17)
        state = x
        return x
    }

    fun nextDouble(): Double {
        val bits = nextLong().ushr(11)
        return bits.toDouble() / (1L shl 53).toDouble()
    }

    fun nextFloat(): Float = nextDouble().toFloat()

    fun nextInt(bound: Int): Int {
        if (bound <= 1) return 0
        val n = (nextLong() and Long.MAX_VALUE) % bound.toLong()
        return n.toInt()
    }

    fun chance(probability: Double): Boolean = nextDouble() < probability.coerceIn(0.0, 1.0)
}

data class Memory(
    val minute: Double,
    val importance: Float,
    val valence: Float,
    val sourcePersonId: Int,
    val text: String
)

data class Relation(
    var familiarity: Float = 0f,
    var trust: Float = 0f,
    var affection: Float = 0f,
    var attraction: Float = 0f,
    var resentment: Float = 0f
)

data class Human(
    val id: Int,
    var name: String,
    var biologicalSex: Int,
    var birthMinute: Double,
    var x: Float,
    var y: Float,
    var targetX: Float,
    var targetY: Float,
    var homeX: Float,
    var homeY: Float,
    var health: Float,
    var hunger: Float,
    var energy: Float,
    var socialNeed: Float,
    var curiosityNeed: Float,
    var infection: Float,
    var immunity: Float,
    var pregnancyDueMinute: Double,
    var parentA: Int,
    var parentB: Int,
    var alive: Boolean,
    var goal: String,
    val traits: FloatArray,
    val relations: MutableMap<Int, Relation>,
    val memories: MutableList<Memory>,
    val ideas: MutableList<String>
) {
    fun ageYears(simMinute: Double): Double = ((simMinute - birthMinute) / YEAR_MINUTES).coerceAtLeast(0.0)
}

data class WorldState(
    var simMinute: Double,
    var timeScale: Double,
    var lastRealEpochMs: Long,
    var rngState: Long,
    var nextHumanId: Int,
    var climateA: Double,
    var climateB: Double,
    var temperatureC: Double,
    var stormSeverity: Double,
    var foodAbundance: Double,
    var lastClimateDay: Long,
    var socialAccumulatorMin: Double,
    var lastAiSimMinute: Double,
    var lastAiRealMs: Long,
    val humans: MutableList<Human>
)

data class HumanSnapshot(
    val id: Int,
    val name: String,
    val x: Float,
    val y: Float,
    val age: Int,
    val alive: Boolean,
    val health: Float,
    val mood: Float,
    val biologicalSex: Int
)

data class WorldSnapshot(
    val simMinute: Double,
    val timeScale: Double,
    val population: Int,
    val temperatureC: Double,
    val stormSeverity: Double,
    val humans: List<HumanSnapshot>
)

data class AiRequest(val humanId: Int, val prompt: String)

data class AiThought(
    val intention: String,
    val targetId: Int?,
    val phrase: String?,
    val newIdea: String?
)
