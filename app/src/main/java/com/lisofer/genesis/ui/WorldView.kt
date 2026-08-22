package com.lisofer.genesis.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import com.lisofer.genesis.world.HumanSnapshot
import com.lisofer.genesis.world.MAP_H
import com.lisofer.genesis.world.MAP_W
import com.lisofer.genesis.world.WorldSnapshot
import kotlin.math.hypot
import kotlin.math.min

class WorldView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {
    private val paint = Paint().apply { isAntiAlias = false }
    private var snapshot: WorldSnapshot? = null
    private var selectedId: Int? = null
    var onHumanSelected: ((Int) -> Unit)? = null

    fun setWorld(snapshot: WorldSnapshot, selectedId: Int?) {
        this.snapshot = snapshot
        this.selectedId = selectedId
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawColor(Color.rgb(10, 12, 14))
        val cell = min(width / MAP_W, height / MAP_H)
        val ox = (width - MAP_W * cell) / 2f
        val oy = (height - MAP_H * cell) / 2f

        for (x in 0 until MAP_W.toInt()) for (y in 0 until MAP_H.toInt()) {
            val road = x % 6 == 0 || y % 6 == 0
            val plaza = x in 10..13 && y in 10..13
            paint.color = when {
                plaza -> Color.rgb(38, 58, 43)
                road -> Color.rgb(35, 38, 42)
                else -> Color.rgb(20, 24, 26)
            }
            val l = ox + x * cell
            val t = oy + y * cell
            canvas.drawRect(l, t, l + cell + 1, t + cell + 1, paint)
            if (!road && !plaza && ((x * 31 + y * 17) % 7 == 0)) {
                paint.color = Color.rgb(55, 49, 45)
                canvas.drawRect(l + cell * 0.18f, t + cell * 0.18f, l + cell * 0.82f, t + cell * 0.82f, paint)
            }
        }

        snapshot?.humans?.filter { it.alive }?.forEach { h ->
            drawHuman(canvas, h, ox, oy, cell, h.id == selectedId)
        }
    }

    private fun drawHuman(canvas: Canvas, h: HumanSnapshot, ox: Float, oy: Float, cell: Float, selected: Boolean) {
        val cx = ox + h.x * cell
        val cy = oy + h.y * cell
        val s = (cell * 0.44f).coerceIn(5f, 13f)
        val hue = ((h.id * 47) % 360).toFloat()
        paint.color = Color.HSVToColor(floatArrayOf(hue, 0.58f, if (h.health > 0.35f) 0.95f else 0.55f))
        canvas.drawRect(RectF(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2), paint)
        paint.color = Color.rgb(235, 219, 198)
        canvas.drawRect(cx - s * 0.30f, cy - s * 0.62f, cx + s * 0.30f, cy - s * 0.18f, paint)
        if (selected) {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 2f
            paint.color = Color.WHITE
            canvas.drawRect(cx - s * 0.78f, cy - s * 0.92f, cx + s * 0.78f, cy + s * 0.78f, paint)
            paint.style = Paint.Style.FILL
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.action != MotionEvent.ACTION_UP) return true
        val snap = snapshot ?: return true
        val cell = min(width / MAP_W, height / MAP_H)
        val ox = (width - MAP_W * cell) / 2f
        val oy = (height - MAP_H * cell) / 2f
        var best: HumanSnapshot? = null
        var bestDistance = Float.MAX_VALUE
        snap.humans.filter { it.alive }.forEach { h ->
            val px = ox + h.x * cell
            val py = oy + h.y * cell
            val d = hypot((event.x - px).toDouble(), (event.y - py).toDouble()).toFloat()
            if (d < bestDistance) {
                bestDistance = d
                best = h
            }
        }
        if (best != null && bestDistance <= maxOf(24f, cell * 0.9f)) {
            selectedId = best!!.id
            onHumanSelected?.invoke(best!!.id)
            invalidate()
        }
        return true
    }
}
