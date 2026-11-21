package com.lqv.pro

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import org.json.JSONArray

class OverheadHudView(context: Context) : View(context) {

    private var badges: JSONArray = JSONArray()

    private val allyBoxPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(190, 12, 36, 24)
        style = Paint.Style.FILL
    }

    private val enemyBoxPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(195, 58, 14, 18)
        style = Paint.Style.FILL
    }

    private val hpPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#4ADE80")
        textSize = 22f
        isFakeBoldText = true
    }

    private val resPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#38BDF8")
        textSize = 20f
    }

    private val statPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#FACC15")
        textSize = 20f
    }

    fun updateBadges(arr: JSONArray) {
        badges = arr
        postInvalidateOnAnimation()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        for (i in 0 until badges.length()) {
            val item = badges.optJSONObject(i) ?: continue
            val pos = item.optJSONObject("headPos") ?: continue
            val cx = pos.optDouble("x", -1.0).toFloat()
            val cy = pos.optDouble("y", -1.0).toFloat()
            if (cx < 0f || cy < 0f) continue

            val team = item.optString("team", "ENEMY")
            val topText = item.optString("labelTop", "")
            val midText = item.optString("labelMid", "")
            val botText = item.optString("labelBot", "")

            val boxW = 240f
            val boxH = 74f
            val left = (cx - boxW / 2f).coerceIn(8f, (width - boxW - 8f).coerceAtLeast(8f))
            val top = (cy - boxH).coerceIn(8f, (height - boxH - 8f).coerceAtLeast(8f))

            canvas.drawRoundRect(
                RectF(left, top, left + boxW, top + boxH),
                10f,
                10f,
                if (team == "ALLY") allyBoxPaint else enemyBoxPaint
            )

            canvas.drawText(topText, left + 10f, top + 22f, hpPaint)
            canvas.drawText(midText, left + 10f, top + 44f, resPaint)
            canvas.drawText(botText, left + 10f, top + 66f, statPaint)
        }
    }
}
