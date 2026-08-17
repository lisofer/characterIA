package com.lisofer.characteria.musetalk

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sin

/**
 * Whisper-compatible frontend used by the ONNX MuseTalk port.
 * Input: mono 16 kHz float PCM. Output: [1,80,3000], flattened CHW.
 *
 * Unlike the Unity reference, this uses an iterative radix-2 FFT instead of a
 * 512x512 direct DFT, which matters enormously on a phone.
 */
object MuseTalkMel {
    const val SAMPLE_RATE = 16_000
    const val N_MELS = 80
    const val N_FFT = 512
    const val HOP_LENGTH = 160
    const val TARGET_FRAMES = 3000

    private val hann = FloatArray(N_FFT) { i ->
        (0.5 * (1.0 - cos(2.0 * PI * i / (N_FFT - 1)))).toFloat()
    }
    private val melBank: Array<FloatArray> by lazy { buildMelBank() }

    /**
     * The recent window can be short (e.g. 200–800 ms); the rest is zero padded
     * to Whisper's fixed 30-second input. This keeps streaming latency bounded.
     */
    fun extract(samples: FloatArray): FloatArray {
        val clean = if (samples.isEmpty()) FloatArray(1) else samples
        val half = N_FFT / 2
        val padded = FloatArray(clean.size + N_FFT - 1)

        // Reflect padding compatible with the on-device reference/librosa-style center.
        for (i in 0 until half) {
            val src = (half - 1 - i).coerceIn(0, clean.lastIndex)
            padded[i] = clean[src]
        }
        clean.copyInto(padded, destinationOffset = half)
        for (i in 0 until half) {
            val src = (clean.lastIndex - i).coerceIn(0, clean.lastIndex)
            val dst = half + clean.size + i
            if (dst < padded.size) padded[dst] = clean[src]
        }

        val frameCount = (((padded.size - N_FFT) / HOP_LENGTH) + 1)
            .coerceIn(1, TARGET_FRAMES)
        val mel = FloatArray(N_MELS * TARGET_FRAMES)
        val real = DoubleArray(N_FFT)
        val imag = DoubleArray(N_FFT)
        val power = FloatArray(N_FFT / 2 + 1)

        var globalMax = 0f
        for (frame in 0 until frameCount) {
            val start = frame * HOP_LENGTH
            for (i in 0 until N_FFT) {
                real[i] = padded.getOrElse(start + i) { 0f }.toDouble() * hann[i]
                imag[i] = 0.0
            }
            fftInPlace(real, imag)
            for (bin in power.indices) {
                val r = real[bin]
                val im = imag[bin]
                power[bin] = (r * r + im * im).toFloat()
            }
            for (m in 0 until N_MELS) {
                var v = 0f
                val filter = melBank[m]
                for (bin in power.indices) v += filter[bin] * power[bin]
                mel[m * TARGET_FRAMES + frame] = v
                if (v > globalMax) globalMax = v
            }
        }

        val ref = globalMax.coerceAtLeast(1e-10f)
        val refDb = 10.0 * log10(ref.toDouble())
        for (m in 0 until N_MELS) {
            val row = m * TARGET_FRAMES
            for (frame in 0 until frameCount) {
                val v = mel[row + frame].coerceAtLeast(ref * 1e-10f)
                val db = (10.0 * log10(v.toDouble()) - refDb).coerceAtLeast(-80.0)
                mel[row + frame] = ((db + 80.0) / 80.0).toFloat().coerceIn(-1f, 1f)
            }
        }
        // Remaining TARGET_FRAMES are zero by construction.
        return mel
    }

    private fun buildMelBank(): Array<FloatArray> {
        val bins = N_FFT / 2 + 1
        val melMin = hzToMel(0.0)
        val melMax = hzToMel(SAMPLE_RATE / 2.0)
        val hzPoints = DoubleArray(N_MELS + 2) { i ->
            val mel = melMin + (melMax - melMin) * i / (N_MELS + 1).toDouble()
            melToHz(mel)
        }
        val binPoints = DoubleArray(hzPoints.size) { i -> hzPoints[i] * N_FFT / SAMPLE_RATE }

        return Array(N_MELS) { m ->
            val out = FloatArray(bins)
            val left = binPoints[m]
            val center = binPoints[m + 1]
            val right = binPoints[m + 2]
            val leftWidth = center - left
            val rightWidth = right - center
            val normDenom = (right - left).coerceAtLeast(1e-12)
            for (bin in 0 until bins) {
                out[bin] = when {
                    bin >= left && bin <= center && leftWidth > 0.0 ->
                        (2.0 * (bin - left) / (normDenom * leftWidth)).toFloat()
                    bin > center && bin <= right && rightWidth > 0.0 ->
                        (2.0 * (right - bin) / (normDenom * rightWidth)).toFloat()
                    else -> 0f
                }
            }
            out
        }
    }

    /** Iterative radix-2 Cooley–Tukey, forward transform. */
    private fun fftInPlace(real: DoubleArray, imag: DoubleArray) {
        val n = real.size
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) {
                j = j xor bit
                bit = bit shr 1
            }
            j = j xor bit
            if (i < j) {
                val tr = real[i]; real[i] = real[j]; real[j] = tr
                val ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
            }
        }

        var len = 2
        while (len <= n) {
            val angle = -2.0 * PI / len
            val wLenR = cos(angle)
            val wLenI = sin(angle)
            var base = 0
            while (base < n) {
                var wr = 1.0
                var wi = 0.0
                val half = len / 2
                for (k in 0 until half) {
                    val uR = real[base + k]
                    val uI = imag[base + k]
                    val vIndex = base + k + half
                    val vR = real[vIndex] * wr - imag[vIndex] * wi
                    val vI = real[vIndex] * wi + imag[vIndex] * wr
                    real[base + k] = uR + vR
                    imag[base + k] = uI + vI
                    real[vIndex] = uR - vR
                    imag[vIndex] = uI - vI
                    val nextWr = wr * wLenR - wi * wLenI
                    wi = wr * wLenI + wi * wLenR
                    wr = nextWr
                }
                base += len
            }
            len = len shl 1
        }
    }

    private fun hzToMel(hz: Double): Double = 2595.0 * log10(1.0 + hz / 700.0)
    private fun melToHz(mel: Double): Double = 700.0 * (10.0.pow(mel / 2595.0) - 1.0)
    private fun log10(v: Double): Double = ln(max(v, 1e-30)) / ln(10.0)
}
