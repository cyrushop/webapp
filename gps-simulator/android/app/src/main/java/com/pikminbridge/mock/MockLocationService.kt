package com.pikminbridge.mock

import android.annotation.SuppressLint
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
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices

/**
 * Foreground service that owns the test location providers and feeds them the
 * coordinates received from the PC bridge. It re-publishes the last fix every second
 * so the location stays "fresh" even if the PC pauses briefly.
 */
class MockLocationService : Service() {

    companion object {
        private const val TAG = "MockLocationService"
        private const val CHANNEL_ID = "mock_location"
        private const val NOTIF_ID = 1
        const val EXTRA_LAT = "lat"
        const val EXTRA_LNG = "lng"
        private const val FUSED_NAME = "fused" // == LocationManager.FUSED_PROVIDER (API 31+)

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
    }

    private lateinit var lm: LocationManager
    private var fused: FusedLocationProviderClient? = null
    private val handler = Handler(Looper.getMainLooper())
    private val providers = mutableListOf<String>()
    private var last: Fix? = null
    private var lastUpdateMs = 0L
    private var count = 0L

    data class Fix(
        val lat: Double,
        val lng: Double,
        val alt: Double,
        val speed: Float,
        val bearing: Float,
        val accuracy: Float,
    )

    private val refresh = object : Runnable {
        override fun run() {
            // Only re-publish if the PC has gone quiet; otherwise it is already sending ~1 Hz.
            if (SystemClock.elapsedRealtime() - lastUpdateMs > 1500) last?.let { publish(it.copy(speed = 0f)) }
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
        val notif = buildNotification("等待 PC 座標…")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIF_ID, notif)
        }
        if (providers.isEmpty()) setupProviders()
        intent?.let { CommandReceiver.parseFix(it) }?.let { update(it) }
        handler.removeCallbacks(refresh)
        handler.post(refresh)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(refresh)
        teardownProviders()
        instance = null
        lastStatus = "已停止"
        super.onDestroy()
    }

    private fun providerNames(): List<String> {
        val names = mutableListOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) names += LocationManager.FUSED_PROVIDER
        return names
    }

    @Suppress("DEPRECATION")
    private fun setupProviders() {
        providers.clear()
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
                lastStatus = "權限不足：請在開發者選項把本 App 設為「模擬位置應用程式」"
                Log.e(TAG, "addTestProvider($name) denied", e)
            } catch (e: Exception) {
                Log.w(TAG, "addTestProvider($name) failed", e)
            }
        }
        setupFused()
        if (providers.isNotEmpty()) lastStatus = "模擬中：${providers.joinToString()}"
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
        if (providers.isEmpty()) setupProviders()
        publish(fix)
        count++
        if (count % 10 == 1L) {
            updateNotification(String.format("%.6f, %.6f · %.1f km/h", fix.lat, fix.lng, fix.speed * 3.6))
        }
    }

    @SuppressLint("MissingPermission")
    private fun publish(fix: Fix) {
        for (name in providers) {
            try {
                lm.setTestProviderLocation(name, buildLocation(name, fix))
            } catch (e: Exception) {
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            verticalAccuracyMeters = fix.accuracy * 1.5f
            speedAccuracyMetersPerSecond = 0.5f
            bearingAccuracyDegrees = 10f
        }
    }

    fun stopMocking() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ---------- notification ----------

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
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
