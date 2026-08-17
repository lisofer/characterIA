package com.lisofer.characteria.simli

import java.io.ByteArrayOutputStream
import kotlin.math.floor
import kotlin.math.roundToInt

/** Streaming little-endian PCM16 mono resampler used to feed Simli (44.1 kHz -> 16 kHz). */
class Pcm16Resampler(
    private val inputRate: Int = 44_100,
    private val outputRate: Int = 16_000,
) {
    private val sourceStep = inputRate.toDouble() / outputRate.toDouble()
    private var totalInputSamples = 0L
    private var nextOutputSourcePosition = 0.0
    private var previousSample: Short? = null
    private var danglingByte: Byte? = null

    @Synchronized
    fun process(bytes: ByteArray): ByteArray {
        if (bytes.isEmpty()) return ByteArray(0)

        val input = mergeDanglingByte(bytes)
        if (input.size < 2) return ByteArray(0)

        val sampleCount = input.size / 2
        val samples = ShortArray(sampleCount)
        var byteIndex = 0
        for (i in 0 until sampleCount) {
            val lo = input[byteIndex].toInt() and 0xff
            val hi = input[byteIndex + 1].toInt()
            samples[i] = ((hi shl 8) or lo).toShort()
            byteIndex += 2
        }

        val base = totalInputSamples
        val lastAbsoluteIndex = base + sampleCount - 1L
        val out = ByteArrayOutputStream((sampleCount * outputRate / inputRate + 2) * 2)

        while (nextOutputSourcePosition <= lastAbsoluteIndex.toDouble()) {
            val leftIndex = floor(nextOutputSourcePosition).toLong()
            val fraction = nextOutputSourcePosition - leftIndex.toDouble()
            val rightIndex = leftIndex + 1L

            val left = sampleAt(leftIndex, base, samples) ?: break
            val right = if (fraction == 0.0) {
                left
            } else {
                sampleAt(rightIndex, base, samples) ?: break
            }

            val interpolated = (left + (right - left) * fraction)
                .roundToInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
                .toShort()

            out.write(interpolated.toInt() and 0xff)
            out.write((interpolated.toInt() shr 8) and 0xff)
            nextOutputSourcePosition += sourceStep
        }

        previousSample = samples.last()
        totalInputSamples += sampleCount
        return out.toByteArray()
    }

    @Synchronized
    fun reset() {
        totalInputSamples = 0L
        nextOutputSourcePosition = 0.0
        previousSample = null
        danglingByte = null
    }

    private fun sampleAt(index: Long, base: Long, samples: ShortArray): Double? {
        if (index == base - 1L) return previousSample?.toDouble()
        val local = index - base
        if (local < 0L || local >= samples.size.toLong()) return null
        return samples[local.toInt()].toDouble()
    }

    private fun mergeDanglingByte(bytes: ByteArray): ByteArray {
        val prefix = danglingByte
        val total = bytes.size + if (prefix != null) 1 else 0
        if (total < 2) {
            danglingByte = bytes.firstOrNull() ?: prefix
            return ByteArray(0)
        }

        val evenSize = total and 1.inv()
        val merged = ByteArray(evenSize)
        var dst = 0
        var src = 0
        if (prefix != null) {
            merged[dst++] = prefix
            danglingByte = null
        }
        val copyCount = evenSize - dst
        if (copyCount > 0) {
            bytes.copyInto(merged, destinationOffset = dst, startIndex = src, endIndex = src + copyCount)
            src += copyCount
        }
        if (src < bytes.size) danglingByte = bytes[src]
        return merged
    }
}
