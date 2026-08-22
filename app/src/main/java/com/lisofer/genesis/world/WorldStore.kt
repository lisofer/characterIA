package com.lisofer.genesis.world

import android.content.Context
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import kotlin.math.roundToInt

class WorldStore(private val context: Context) {
    private val worldFile = File(context.filesDir, "world.bin")
    private val tempFile = File(context.filesDir, "world.tmp")
    private val prefs = context.getSharedPreferences("genesis_settings", Context.MODE_PRIVATE)

    fun apiKey(): String = prefs.getString("gemini_api_key", "") ?: ""

    fun saveApiKey(value: String) {
        prefs.edit().putString("gemini_api_key", value.trim()).apply()
    }

    fun loadOrCreate(): WorldState {
        if (!worldFile.exists()) return createWorld().also(::save)
        return runCatching { read() }.getOrElse { createWorld().also(::save) }
    }

    fun save(world: WorldState) {
        DataOutputStream(BufferedOutputStream(tempFile.outputStream())).use { out ->
            out.writeInt(0x47454E31)
            out.writeInt(2)
            out.writeDouble(world.simMinute)
            out.writeDouble(world.timeScale)
            out.writeLong(world.lastRealEpochMs)
            out.writeLong(world.rngState)
            out.writeInt(world.nextHumanId)
            out.writeDouble(world.climateA)
            out.writeDouble(world.climateB)
            out.writeDouble(world.temperatureC)
            out.writeDouble(world.stormSeverity)
            out.writeDouble(world.foodAbundance)
            out.writeLong(world.lastClimateDay)
            out.writeDouble(world.socialAccumulatorMin)
            out.writeDouble(world.lastAiSimMinute)
            out.writeLong(world.lastAiRealMs)
            out.writeInt(world.humans.size)
            world.humans.forEach { h ->
                out.writeInt(h.id)
                out.writeUTF(h.name.take(60))
                out.writeInt(h.biologicalSex)
                out.writeDouble(h.birthMinute)
                out.writeFloat(h.x); out.writeFloat(h.y)
                out.writeFloat(h.targetX); out.writeFloat(h.targetY)
                out.writeFloat(h.homeX); out.writeFloat(h.homeY)
                out.writeFloat(h.health); out.writeFloat(h.hunger)
                out.writeFloat(h.energy); out.writeFloat(h.socialNeed)
                out.writeFloat(h.curiosityNeed); out.writeFloat(h.infection)
                out.writeFloat(h.immunity); out.writeDouble(h.pregnancyDueMinute)
                out.writeInt(h.parentA); out.writeInt(h.parentB)
                out.writeBoolean(h.alive)
                out.writeUTF(h.goal.take(220))
                out.writeInt(h.traits.size)
                h.traits.forEach(out::writeFloat)

                val rels = h.relations.entries.take(32)
                out.writeInt(rels.size)
                rels.forEach { (id, r) ->
                    out.writeInt(id)
                    out.writeFloat(r.familiarity); out.writeFloat(r.trust)
                    out.writeFloat(r.affection); out.writeFloat(r.attraction)
                    out.writeFloat(r.resentment)
                }

                val memories = h.memories.takeLast(64)
                out.writeInt(memories.size)
                memories.forEach { m ->
                    out.writeDouble(m.minute)
                    out.writeFloat(m.importance)
                    out.writeFloat(m.valence)
                    out.writeInt(m.sourcePersonId)
                    out.writeUTF(m.text.take(220))
                }

                val ideas = h.ideas.takeLast(24)
                out.writeInt(ideas.size)
                ideas.forEach { out.writeUTF(it.take(160)) }
            }
        }
        if (worldFile.exists()) worldFile.delete()
        tempFile.renameTo(worldFile)
    }

    private fun read(): WorldState {
        DataInputStream(BufferedInputStream(worldFile.inputStream())).use { input ->
            require(input.readInt() == 0x47454E31)
            require(input.readInt() == 2)
            val world = WorldState(
                simMinute = input.readDouble(),
                timeScale = input.readDouble(),
                lastRealEpochMs = input.readLong(),
                rngState = input.readLong(),
                nextHumanId = input.readInt(),
                climateA = input.readDouble(),
                climateB = input.readDouble(),
                temperatureC = input.readDouble(),
                stormSeverity = input.readDouble(),
                foodAbundance = input.readDouble(),
                lastClimateDay = input.readLong(),
                socialAccumulatorMin = input.readDouble(),
                lastAiSimMinute = input.readDouble(),
                lastAiRealMs = input.readLong(),
                humans = mutableListOf()
            )
            repeat(input.readInt()) {
                val id = input.readInt()
                val name = input.readUTF()
                val sex = input.readInt()
                val birth = input.readDouble()
                val x = input.readFloat(); val y = input.readFloat()
                val tx = input.readFloat(); val ty = input.readFloat()
                val hx = input.readFloat(); val hy = input.readFloat()
                val health = input.readFloat(); val hunger = input.readFloat()
                val energy = input.readFloat(); val social = input.readFloat()
                val curiosity = input.readFloat(); val infection = input.readFloat()
                val immunity = input.readFloat(); val pregnancy = input.readDouble()
                val parentA = input.readInt(); val parentB = input.readInt()
                val alive = input.readBoolean()
                val goal = input.readUTF()
                val traits = FloatArray(input.readInt()) { input.readFloat() }
                val relations = mutableMapOf<Int, Relation>()
                repeat(input.readInt()) {
                    val other = input.readInt()
                    relations[other] = Relation(
                        input.readFloat(), input.readFloat(), input.readFloat(),
                        input.readFloat(), input.readFloat()
                    )
                }
                val memories = mutableListOf<Memory>()
                repeat(input.readInt()) {
                    memories += Memory(
                        input.readDouble(), input.readFloat(), input.readFloat(),
                        input.readInt(), input.readUTF()
                    )
                }
                val ideas = mutableListOf<String>()
                repeat(input.readInt()) { ideas += input.readUTF() }
                world.humans += Human(
                    id, name, sex, birth, x, y, tx, ty, hx, hy,
                    health, hunger, energy, social, curiosity, infection, immunity,
                    pregnancy, parentA, parentB, alive, goal, traits,
                    relations, memories, ideas
                )
            }
            return world
        }
    }

    private fun createWorld(): WorldState {
        val seed = System.nanoTime() xor System.currentTimeMillis()
        val rng = XorShift64(seed)
        val now = System.currentTimeMillis()
        val names = listOf(
            "Alma", "Bruno", "Clara", "Dante", "Elena", "Félix", "Gaia", "Hugo",
            "Inés", "Julián", "Kiara", "León", "Mara", "Nicolás", "Olivia", "Pablo",
            "Renata", "Simón", "Tania", "Ulises", "Vera", "Walter", "Ximena", "Yago",
            "Zoe", "Abril", "Benicio", "Celia", "Damián", "Emma", "Franco", "Gala",
            "Ian", "Julieta", "Lara", "Matías", "Noelia", "Ramiro", "Sofía", "Tomás"
        )
        val humans = mutableListOf<Human>()
        repeat(40) { index ->
            val home = randomBuildable(rng)
            val age = 18.0 + rng.nextDouble() * 27.0
            val traits = FloatArray(8) { (0.08 + rng.nextDouble() * 0.84).toFloat() }
            humans += Human(
                id = index + 1,
                name = names[index % names.size],
                biologicalSex = rng.nextInt(2),
                birthMinute = -age * YEAR_MINUTES,
                x = home.first,
                y = home.second,
                targetX = home.first,
                targetY = home.second,
                homeX = home.first,
                homeY = home.second,
                health = (0.90 + rng.nextDouble() * 0.10).toFloat(),
                hunger = rng.nextFloat() * 0.25f,
                energy = (0.65 + rng.nextDouble() * 0.32).toFloat(),
                socialNeed = rng.nextFloat(),
                curiosityNeed = rng.nextFloat(),
                infection = 0f,
                immunity = 0f,
                pregnancyDueMinute = -1.0,
                parentA = -1,
                parentB = -1,
                alive = true,
                goal = "",
                traits = traits,
                relations = mutableMapOf(),
                memories = mutableListOf(),
                ideas = mutableListOf()
            )
        }
        return WorldState(
            simMinute = 0.0,
            timeScale = 1.0,
            lastRealEpochMs = now,
            rngState = rng.state,
            nextHumanId = 41,
            climateA = 0.417,
            climateB = 0.731,
            temperatureC = 21.0,
            stormSeverity = 0.0,
            foodAbundance = 0.90,
            lastClimateDay = 0,
            socialAccumulatorMin = 0.0,
            lastAiSimMinute = -DAY_MINUTES,
            lastAiRealMs = 0L,
            humans = humans
        )
    }

    companion object {
        fun randomBuildable(rng: XorShift64): Pair<Float, Float> {
            repeat(40) {
                val x = 1 + rng.nextInt((MAP_W - 2).roundToInt())
                val y = 1 + rng.nextInt((MAP_H - 2).roundToInt())
                if (x % 6 != 0 && y % 6 != 0) {
                    return Pair(x + 0.5f, y + 0.5f)
                }
            }
            return Pair(2.5f, 2.5f)
        }
    }
}