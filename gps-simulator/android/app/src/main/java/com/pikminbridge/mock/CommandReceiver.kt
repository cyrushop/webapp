package com.pikminbridge.mock

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Entry point for commands sent from the PC:
 *   adb shell am broadcast -n com.pikminbridge.mock/.CommandReceiver \
 *     -a com.pikminbridge.mock.SET_LOCATION --es lat 35.65 --es lng 139.74 [--es spd 1.2 --es brg 90 --es acc 5 --es alt 10]
 *   adb shell am broadcast -n com.pikminbridge.mock/.CommandReceiver -a com.pikminbridge.mock.STOP
 */
class CommandReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "CommandReceiver"
        const val ACTION_SET = "com.pikminbridge.mock.SET_LOCATION"
        const val ACTION_STOP = "com.pikminbridge.mock.STOP"

        private fun Intent.num(key: String): Double? =
            getStringExtra(key)?.toDoubleOrNull()
                ?: if (hasExtra(key)) getDoubleExtra(key, Double.NaN).takeIf { !it.isNaN() } else null

        /** Parses and validates a fix; returns null for anything malformed or out of range. */
        fun parseFix(i: Intent): MockLocationService.Fix? {
            val lat = i.num("lat") ?: return null
            val lng = i.num("lng") ?: return null
            if (lat !in -90.0..90.0 || lng !in -180.0..180.0) return null
            return MockLocationService.Fix(
                lat = lat,
                lng = lng,
                alt = i.num("alt") ?: 10.0,
                speed = (i.num("spd") ?: 0.0).coerceIn(0.0, 100.0).toFloat(),
                bearing = (((i.num("brg") ?: 0.0) % 360 + 360) % 360).toFloat(),
                accuracy = (i.num("acc") ?: 5.0).coerceIn(1.0, 200.0).toFloat(),
            )
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_SET -> {
                val fix = parseFix(intent) ?: run {
                    Log.w(TAG, "ignored malformed fix: ${intent.extras}")
                    return
                }
                val svc = MockLocationService.instance
                if (svc != null) {
                    svc.update(fix)
                } else if (!MockLocationService.canStartForeground(context)) {
                    // A location-type foreground service needs the location permission (Android 14+);
                    // starting it without one throws and kills the app. Wait for the user to grant it.
                    Log.w(TAG, "location permission not granted yet; ignoring fix")
                } else {
                    // Starting a foreground service from the background is restricted on
                    // Android 12+; if refused, open the app once (the PC bridge's
                    // "一鍵設定手機" does this) so the service starts from the foreground.
                    try {
                        MockLocationService.start(context, intent)
                    } catch (e: Exception) {
                        Log.e(TAG, "cannot start service from background; open the app first", e)
                    }
                }
            }
            ACTION_STOP -> MockLocationService.instance?.stopMocking()
        }
    }
}
