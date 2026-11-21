package com.lqv.pro

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.view.accessibility.AccessibilityEvent
import org.json.JSONArray
import org.json.JSONObject

class TouchAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    override fun onDestroy() {
        super.onDestroy()
        if (instance == this) instance = null
    }

    fun executeCommand(cmd: JSONObject) {
        when (cmd.optString("type")) {
            "TAP" -> {
                val x = cmd.optDouble("x", 0.0).toFloat()
                val y = cmd.optDouble("y", 0.0).toFloat()
                val hold = cmd.optLong("holdMs", 60L).coerceIn(20L, 300L)
                val p = Path().apply { moveTo(x, y) }
                val stroke = GestureDescription.StrokeDescription(p, 0L, hold)
                dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
            }
            "SWIPE" -> {
                val pts: JSONArray = cmd.optJSONArray("pts") ?: return
                if (pts.length() < 2) return
                val p = Path()
                var totalMs = 0L
                for (i in 0 until pts.length()) {
                    val pt = pts.getJSONObject(i)
                    val px = pt.optDouble("x", 0.0).toFloat()
                    val py = pt.optDouble("y", 0.0).toFloat()
                    totalMs += pt.optLong("stepMs", 18L).coerceIn(8L, 80L)
                    if (i == 0) p.moveTo(px, py) else p.lineTo(px, py)
                }
                val stroke = GestureDescription.StrokeDescription(p, 0L, totalMs.coerceAtLeast(30L))
                dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
            }
        }
    }

    companion object {
        @Volatile
        var instance: TouchAccessibilityService? = null
    }
}
