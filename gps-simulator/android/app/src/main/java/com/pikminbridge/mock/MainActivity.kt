package com.pikminbridge.mock

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Minimal setup screen: permissions, mock-location app check, start/stop the service. */
class MainActivity : Activity() {

    private lateinit var status: TextView
    private val handler = Handler(Looper.getMainLooper())
    private val ticker = object : Runnable {
        override fun run() {
            renderStatus()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        status = TextView(this).apply { textSize = 15f; gravity = Gravity.START }
        root.addView(TextView(this).apply { text = "Mock Location Bridge"; textSize = 22f })
        root.addView(status)
        root.addView(button("1. 授予定位 / 通知權限") { requestPerms() })
        root.addView(button("2. 開啟開發者選項（選取模擬位置應用程式）") {
            startActivity(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS))
        })
        val prefs = getSharedPreferences(MockLocationService.PREFS, MODE_PRIVATE)
        val portField = EditText(this).apply {
            hint = "電腦橋接埠（預設 ${MockLocationService.DEFAULT_PORT}）"
            inputType = InputType.TYPE_CLASS_NUMBER
            setText(prefs.getInt(MockLocationService.PREF_PORT, MockLocationService.DEFAULT_PORT).toString())
        }
        root.addView(portField)
        root.addView(button("3. 啟動模擬服務") {
            val port = portField.text.toString().toIntOrNull()?.takeIf { it in 1..65535 }
                ?: MockLocationService.DEFAULT_PORT
            if (port != prefs.getInt(MockLocationService.PREF_PORT, MockLocationService.DEFAULT_PORT)) {
                prefs.edit().putInt(MockLocationService.PREF_PORT, port).apply()
                // Port change takes effect on a fresh service.
                MockLocationService.instance?.stopMocking()
                handler.postDelayed({ startMockService() }, 500)
            } else {
                startMockService()
            }
        })
        root.addView(button("停止並還原真實 GPS") { MockLocationService.instance?.stopMocking() })
        root.addView(TextView(this).apply {
            text = "\n啟動後保持通知列常駐，回到電腦網頁操作即可。\n" +
                "USB 直連需要電腦端執行 adb reverse（橋接會自動做）。\n" +
                "若電腦端顯示已送出但位置不變，請確認步驟 2 已選擇本 App。"
            textSize = 13f
        })
        setContentView(ScrollView(this).apply { addView(root) })

        if (intent?.getBooleanExtra("autostart", false) == true) {
            if (hasLocationPerm()) startMockService() else requestPerms()
        }
    }

    override fun onResume() {
        super.onResume()
        handler.post(ticker)
    }

    override fun onPause() {
        handler.removeCallbacks(ticker)
        super.onPause()
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    private fun hasLocationPerm() =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun requestPerms() {
        val perms = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
        requestPermissions(perms.toTypedArray(), 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (hasLocationPerm() && intent?.getBooleanExtra("autostart", false) == true) startMockService()
        renderStatus()
    }

    private fun startMockService() {
        if (!hasLocationPerm()) {
            requestPerms()
            return
        }
        MockLocationService.start(this)
        renderStatus()
    }

    private fun renderStatus() {
        val ok = "✅"
        val no = "❌"
        status.text = buildString {
            appendLine()
            appendLine("定位權限：${if (hasLocationPerm()) ok else no}")
            appendLine("已設為模擬位置應用程式：${if (MockLocationService.isMockApp(this@MainActivity)) ok else no}")
            val svc = MockLocationService.instance
            appendLine("服務：${if (svc != null) "運行中 $ok" else "未運行"}")
            if (svc != null) {
                appendLine("USB 直連：${if (svc.linkConnected) ok else "$no（等待 adb reverse / 電腦橋接）"}")
                appendLine("已套用座標：${svc.fixCount}")
            }
            appendLine("狀態：${MockLocationService.lastStatus}")
        }
    }
}
