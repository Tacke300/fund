package com.lqv.pro

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import org.json.JSONArray
import org.json.JSONObject

class OverlayControlView(
    context: Context,
    private val onSelectMode: (String) -> Unit
) : View(context) {

    private var currentMode = "BALANCED"
    private var predictedPaths = JSONArray()
    private var minimapRect = RectF(40f, 30f, 300f, 290f)

    private val btnDefRect = RectF(420f, 24f, 540f, 76f)
    private val btnBalRect = RectF(552f, 24f, 682f, 76f)
    private val btnAggRect = RectF(694f, 24f, 810f, 76f)

    private val panelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(185, 18, 22, 32)
    }
    private val activePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#2563EB")
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textSize = 22f
        isFakeBoldText = true
    }
    private val pathPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#FB7185")
        strokeWidth = 5f
        style = Paint.Style.STROKE
    }
    private val nodePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(95, 251, 113, 133)
        style = Paint.Style.FILL
    }

    fun applyOverlayPayload(payload: JSONObject) {
        currentMode = payload.optString("mode", currentMode)
        predictedPaths = payload.optJSONArray("predictedMissing") ?: JSONArray()
        postInvalidateOnAnimation()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_DOWN) {
            val x = event.x
            val y = event.y
            when {
                btnDefRect.contains(x, y) -> {
                    currentMode = "DEFENSE"
                    onSelectMode("DEFENSE")
                    invalidate()
                    return true
                }
                btnBalRect.contains(x, y) -> {
                    currentMode = "BALANCED"
                    onSelectMode("BALANCED")
                    invalidate()
                    return true
                }
                btnAggRect.contains(x, y) -> {
                    currentMode = "AGGRESSIVE"
                    onSelectMode("AGGRESSIVE")
                    invalidate()
                    return true
                }
            }
        }
        return false
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        drawModeButton(canvas, btnDefRect, "THỦ", currentMode == "DEFENSE")
        drawModeButton(canvas, btnBalRect, "CÂN", currentMode == "BALANCED")
        drawModeButton(canvas, btnAggRect, "CÔNG", currentMode == "AGGRESSIVE")

        for (i in 0 until predictedPaths.length()) {
            val p = predictedPaths.optJSONObject(i) ?: continue
            val line = p.optJSONArray("predictedLine") ?: continue
            var prevX: Float? = null
            var prevY: Float? = null

            for (j in 0 until line.length()) {
                val pt = line.optJSONObject(j) ?: continue
                val nx = pt.optDouble("x", 0.5).toFloat()
                val ny = pt.optDouble("y", 0.5).toFloat()
                val radNorm = pt.optDouble("radius", 0.05).toFloat()

                val sx = minimapRect.left + nx * minimapRect.width()
                val sy = minimapRect.top + ny * minimapRect.height()
                val sr = (radNorm * minimapRect.width()).coerceAtLeast(8f)

                canvas.drawCircle(sx, sy, sr, nodePaint)
                if (prevX != null && prevY != null) {
                    canvas.drawLine(prevX, prevY, sx, sy, pathPaint)
                }
                prevX = sx
                prevY = sy
            }
        }
    }

    private fun drawModeButton(canvas: Canvas, rect: RectF, label: String, selected: Boolean) {
        canvas.drawRoundRect(rect, 12f, 12f, if (selected) activePaint else panelPaint)
        canvas.drawText(label, rect.left + 22f, rect.centerY() + 8f, textPaint)
    }
}
