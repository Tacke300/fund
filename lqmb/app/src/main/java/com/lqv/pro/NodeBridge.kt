package com.lqv.pro

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

class NodeBridge(
    private val context: Context,
    private val onMessageJson: (String) -> Unit
) {
    private val client = OkHttpClient()
    private var ws: WebSocket? = null
    private var nodeStarted = false

    fun copyAssetsProjectIfNeeded(): File {
        val targetDir = File(context.filesDir, "nodejs-project")
        if (!targetDir.exists()) targetDir.mkdirs()
        copyAssetFolder("nodejs-project", targetDir)
        return targetDir
    }

    private fun copyAssetFolder(assetPath: String, destDir: File) {
        val list = context.assets.list(assetPath) ?: return
        if (list.isEmpty()) {
            val outFile = File(destDir.parentFile, destDir.name)
            outFile.parentFile?.mkdirs()
            context.assets.open(assetPath).use { input ->
                FileOutputStream(outFile).use { output ->
                    input.copyTo(output)
                }
            }
            return
        }
        if (!destDir.exists()) destDir.mkdirs()
        for (item in list) {
            copyAssetFolder("$assetPath/$item", File(destDir, item))
        }
    }

    fun startNodeRuntime() {
        val projDir = copyAssetsProjectIfNeeded()
        val entryScript = File(projDir, "index.js").absolutePath
        if (!nodeStarted) {
            nodeStarted = true
            Thread {
                try {
                    val cls = Class.forName("com.janeasoft.nodejs.Node")
                    val startMethod = cls.getMethod("startNodeWithArguments", Array<String>::class.java, String::class.java)
                    startMethod.invoke(null, arrayOf("node", entryScript), projDir.absolutePath)
                } catch (_: Exception) {
                }
            }.start()
        }
        connectWebSocket()
    }

    fun connectWebSocket(url: String = "ws://127.0.0.1:8765") {
        val req = Request.Builder().url(url).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                onMessageJson(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                webSocket.close(1000, null)
            }
        })
    }

    fun sendJson(obj: JSONObject) {
        ws?.send(obj.toString())
    }

    fun setMode(modeName: String) {
        sendJson(JSONObject().put("type", "SET_MODE").put("mode", modeName))
    }

    fun close() {
        ws?.close(1000, "closed")
    }
}
