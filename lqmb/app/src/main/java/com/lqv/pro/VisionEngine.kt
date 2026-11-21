package com.lqv.pro

import android.media.Image
import org.json.JSONArray
import org.json.JSONObject

class VisionEngine {

    fun analyzeLiveImage(image: Image, width: Int, height: Int, nowMs: Long): JSONObject {
        val plane = image.planes.firstOrNull()
        val sampleChecksum = if (plane != null && plane.buffer.remaining() > 0) {
            val buf = plane.buffer
            val step = (buf.remaining() / 64).coerceAtLeast(1)
            var sum = 0L
            var pos = buf.position()
            while (pos < buf.limit()) {
                sum += (buf.get(pos).toInt() and 0xFF)
                pos += step
            }
            sum
        } else {
            0L
        }

        return JSONObject()
            .put("ts", nowMs)
            .put("width", width)
            .put("height", height)
            .put("streamHash", sampleChecksum)
            .put("heroes", JSONArray())
            .put("minimapEnemies", JSONArray())
            .put("bushes", JSONArray())
            .put("alert", JSONObject().put("spotted", false).put("ambush", false).put("danger", false))
    }
}
