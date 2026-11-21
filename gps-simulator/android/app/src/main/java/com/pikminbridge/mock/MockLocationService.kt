package com.pikminbridge.mock

import android.annotation.SuppressLint
import android.app.AppOpsManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.location.provider.ProviderProperties
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import org.json.JSONArray
import org.json.JSONObject

/**
 * Foreground service that owns the test location providers and feeds them coordinates from
 * the PC bridge — primarily over the USB WebSocket link ([BridgeClient]), with `am broadcast`
 * ([CommandReceiver]) as a fallback. The last fix is re-published every second while the PC is
 * quiet so the phone never snaps back to the real position mid-session.
 */
class MockLocationService : Service(), BridgeClient.Listener {

    companion object {
        private const val TAG = "MockLocationService"
        private const val CHANNEL_ID = "mock_location"
        private const val NOTIF_ID = 1
        private const val FUSED_NAME = "fused" // == LocationManager.FUSED_PROVIDER (API 31+)
        const val PREFS = "bridge"
        const val PREF_PORT = "port"
        const val DEFAULT_PORT = 8787

        @Volatile
        var instance: MockLocationService? = null
            private set

        @Volatile
        var lastStatus: String = "未啟動"
            private set

        fun start(context: Context, extras: Intent? = null) {
            val i = Intent(context, MockLocationService::class.java)
            extras?.extras?.let { i.putExtras(it) }
            context.startForegroundService(i)
        }

        fun canStartForeground(context: Context): Boolean =
            context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED ||
                context.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED

        @Suppress("DEPRECATION")
        fun isMockApp(context: Context): Boolean = try {
            isMockAppUnsafe(context)
        } catch (e: Exception) {
            Log.w(TAG, "mock-location app-op check failed", e)
            false
        }

        @Suppress("DEPRECATION")
        private fun isMockAppUnsafe(context: Context): Boolean {
            val ops = context.getSystemService(AppOpsManager::class.java)
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, Process.myUid(), context.packageName)
            } else {
                ops.checkOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, Process.myUid(), context.packageName)
            }
            return mode == AppOpsManager.MODE_ALLOWED
        }
    }

    data class Fix(
        val lat: Double,
        val lng: Double,
        val alt: Double,
        val speed: Float,
        val bearing: Float,
        val accuracy: Float,
    )

    private lateinit var lm: LocationManager
    private var fused: FusedLocationProviderClient? = null
    private val handler = Handler(Looper.getMainLooper())
    private val providers = mutableListOf<String>()
    private var bridge: BridgeClient? = null
    private var last: Fix? = null
    private var lastUpdateMs = 0L
    private var lastSetupAttemptMs = 0L
    private var lastError = ""
    var fixCount = 0L
        private set
    val linkConnected: Boolean get() = bridge?.connected == true

    private val refresh = object : Runnable {
        private var ticks = 0
        override fun run() {
            if (SystemClock.elapsedRealtime() - lastUpdateMs > 1500) last?.let { publish(it.copy(speed = 0f)) }
            if (++ticks % 2 == 0) bridge?.sendStatus()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        createChannel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notif = buildNotification("等待電腦連線…")
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            } else {
                startForeground(NOTIF_ID, notif)
            }
        } catch (e: Exception) {
            // Missing location permission (Android 14+) or a background-start restriction.
            // Bail out cleanly instead of crashing the whole app.
            Log.e(TAG, "startForeground refused", e)
            lastStatus = "無法啟動服務：${e.javaClass.simpleName}（請先授予定位權限並由 App 內啟動）"
            stopSelf()
            return START_NOT_STICKY
        }
        if (providers.isEmpty()) setupProviders()
        intent?.let { CommandReceiver.parseFix(it) }?.let { update(it) }

        if (bridge == null) {
            val port = getSharedPreferences(PREFS, MODE_PRIVATE).getInt(PREF_PORT, DEFAULT_PORT)
            bridge = BridgeClient(port, this).also { it.start() }
        }
        handler.removeCallbacks(refresh)
        handler.post(refresh)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(refresh)
        bridge?.stop()
        bridge = null
        teardownProviders()
        instance = null
        lastStatus = "已停止"
        super.onDestroy()
    }

    // ---------- BridgeClient.Listener ----------

    override fun onFix(fix: Fix) = update(fix)

    override fun onStopRequested() = stopMocking()

    override fun onLinkChanged(connected: Boolean) {
        updateNotification(if (connected) "USB 直連已連線" else "等待電腦連線…（adb reverse）")
    }

    override fun helloJson(): JSONObject = JSONObject()
        .put("t", "hello")
        .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
        .put("sdk", Build.VERSION.SDK_INT)
        .put("app", BuildConfig.VERSION_NAME)

    override fun statusJson(): JSONObject = JSONObject()
        .put("t", "status")
        .put("providers", JSONArray(providers.toList()))
        .put("mockApp", isMockApp(this))
        .put("fixes", fixCount)
        .put("error", lastError)

    // ---------- providers ----------

    private fun providerNames(): List<String> {
        val names = mutableListOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) names += FUSED_NAME
        return names
    }

    @Suppress("DEPRECATION")
    private fun setupProviders() {
        lastSetupAttemptMs = SystemClock.elapsedRealtime()
        providers.clear()
        lastError = ""
        for (name in providerNames()) {
            try {
                try {
                    lm.removeTestProvider(name)
                } catch (_: Exception) {
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val props = ProviderProperties.Builder()
                        .setHasAltitudeSupport(true)
                        .setHasSpeedSupport(true)
                        .setHasBearingSupport(true)
                        .setAccuracy(ProviderProperties.ACCURACY_FINE)
                        .setPowerUsage(ProviderProperties.POWER_USAGE_LOW)
                        .build()
                    lm.addTestProvider(name, props)
                } else {
                    lm.addTestProvider(
                        name, false, false, false, false, true, true, true,
                        Criteria.POWER_LOW, Criteria.ACCURACY_FINE,
                    )
                }
                lm.setTestProviderEnabled(name, true)
                providers += name
            } catch (e: SecurityException) {
                lastError = "未選取為模擬位置應用程式（開發者選項）"
                Log.e(TAG, "addTestProvider($name) denied", e)
            } catch (e: Exception) {
                lastError = "addTestProvider($name): ${e.message}"
                Log.w(TAG, "addTestProvider($name) failed", e)
            }
        }
        setupFused()
        lastStatus = if (providers.isNotEmpty()) "模擬中：${providers.joinToString()}" else "錯誤：$lastError"
        updateNotification(lastStatus)
    }

    @SuppressLint("MissingPermission")
    private fun setupFused() {
        try {
            val client = LocationServices.getFusedLocationProviderClient(this)
            client.setMockMode(true)
                .addOnSuccessListener { fused = client }
                .addOnFailureListener { Log.w(TAG, "fused setMockMode failed", it) }
        } catch (e: Exception) {
            Log.w(TAG, "Play Services fused mock unavailable", e)
        }
    }

    @SuppressLint("MissingPermission")
    private fun teardownProviders() {
        for (name in providers) {
            try {
                lm.setTestProviderEnabled(name, false)
                lm.removeTestProvider(name)
            } catch (_: Exception) {
            }
        }
        providers.clear()
        try {
            fused?.setMockMode(false)
        } catch (_: Exception) {
        }
        fused = null
    }

    fun update(fix: Fix) {
        last = fix
        lastUpdateMs = SystemClock.elapsedRealtime()
        // Retry provider setup (e.g. user just picked this app as the mock app), at most every 5 s.
        if (providers.isEmpty() && lastUpdateMs - lastSetupAttemptMs > 5000) setupProviders()
        publish(fix)
        fixCount++
        if (fixCount % 10 == 1L) {
            val via = if (linkConnected) "USB 直連" else "ADB 廣播"
            updateNotification(String.format("%s · %.6f, %.6f · %.1f km/h", via, fix.lat, fix.lng, fix.speed * 3.6))
        }
    }

    @SuppressLint("MissingPermission")
    private fun publish(fix: Fix) {
        for (name in providers) {
            try {
                lm.setTestProviderLocation(name, buildLocation(name, fix))
            } catch (e: Exception) {
                lastError = "setTestProviderLocation($name): ${e.message}"
                Log.w(TAG, "setTestProviderLocation($name) failed", e)
            }
        }
        try {
            fused?.setMockLocation(buildLocation(FUSED_NAME, fix))
        } catch (_: Exception) {
        }
    }

    private fun buildLocation(provider: String, fix: Fix) = Location(provider).apply {
        latitude = fix.lat
        longitude = fix.lng
        altitude = fix.alt
        speed = fix.speed
        bearing = fix.bearing
        accuracy = fix.accuracy
        time = System.currentTimeMillis()
        elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
        verticalAccuracyMeters = fix.accuracy * 1.5f
        speedAccuracyMetersPerSecond = 0.5f
        bearingAccuracyDegrees = 10f
    }

    fun stopMocking() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ---------- notification ----------

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "模擬定位", NotificationManager.IMPORTANCE_LOW)
        )
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Mock Location Bridge")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification(text))
    }
}
