package com.lqv.pro

import android.app.Activity
import android.content.Intent
import android.graphics.PixelFormat
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var nodeBridge: NodeBridge
    private var overheadView: OverheadHudView? = null
    private var controlView: OverlayControlView? = null
    private var windowManager: WindowManager? = null

    private val captureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { res ->
        if (res.resultCode == Activity.RESULT_OK && res.data != null) {
            val svcIntent = Intent(this, CaptureService::class.java).apply {
                putExtra(CaptureService.EXTRA_RESULT_CODE, res.resultCode)
                putExtra(CaptureService.EXTRA_RESULT_DATA, res.data)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(svcIntent)
            } else {
                startService(svcIntent)
            }
            attachOverlays()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 80, 48, 48)
        }

        val btnStart = Button(this).apply {
            text = "Bật LQV Pro Overlay & Luồng Trực Tiếp"
            setOnClickListener { ensurePermissionsAndStart() }
        }

        val btnAccessibility = Button(this).apply {
            text = "Mở Cài Đặt Hỗ Trợ Tiếp Cận (Chạm/Vuốt)"
            setOnClickListener {
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
        }

        root.addView(btnStart)
        root.addView(btnAccessibility)
        setContentView(root)

        nodeBridge = NodeBridge(this) { rawJson ->
            runOnUiThread { handleBridgeMessage(rawJson) }
        }
        nodeBridge.startNodeRuntime()
    }

    private fun ensurePermissionsAndStart() {
        if (!Settings.canDrawOverlays(this)) {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName")
            )
            startActivity(intent)
            return
        }
        val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        captureLauncher.launch(mgr.createScreenCaptureIntent())
    }

    private fun attachOverlays() {
        val wm = windowManager ?: return
        val overlayType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        if (overheadView == null) {
            overheadView = OverheadHudView(this)
            val hudParams = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
            ).apply { gravity = Gravity.TOP or Gravity.START }
            wm.addView(overheadView, hudParams)
        }

        if (controlView == null) {
            controlView = OverlayControlView(this) { mode ->
                nodeBridge.setMode(mode)
            }
            val ctrlParams = WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                overlayType,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_PASS_THROUGH or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
            ).apply { gravity = Gravity.TOP or Gravity.START }
            wm.addView(controlView, ctrlParams)
        }
    }

    private fun handleBridgeMessage(rawJson: String) {
        val obj = try {
            JSONObject(rawJson)
        } catch (_: Exception) {
            return
        }
        when (obj.optString("type")) {
            "OVERHEAD_HUD" -> {
                val arr = obj.optJSONArray("payload") ?: return
                overheadView?.updateBadges(arr)
            }
            "OVERLAY_DATA" -> {
                val payload = obj.optJSONObject("payload") ?: return
                controlView?.applyOverlayPayload(payload)
            }
            "INPUT_CMD" -> {
                val cmd = obj.optJSONObject("payload") ?: return
                TouchAccessibilityService.instance?.executeCommand(cmd)
            }
        }
    }

    override fun onDestroy() {
        windowManager?.let { wm ->
            overheadView?.let { wm.removeView(it) }
            controlView?.let { wm.removeView(it) }
        }
        nodeBridge.close()
        super.onDestroy()
    }
}
