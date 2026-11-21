package com.pikminbridge.mock

import android.app.Application
import android.content.Context
import java.io.PrintWriter
import java.io.StringWriter

/**
 * Records the last uncaught exception so MainActivity can show it on the next launch —
 * no Logcat needed to report a crash.
 */
class BridgeApp : Application() {

    companion object {
        private const val PREFS = "crash"
        private const val KEY = "last"

        fun lastCrash(context: Context): String? =
            context.getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY, null)

        fun clearCrash(context: Context) {
            context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY).apply()
        }
    }

    override fun onCreate() {
        super.onCreate()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                val sw = StringWriter()
                error.printStackTrace(PrintWriter(sw))
                val text = "${java.util.Date()}\n${sw.toString().take(4000)}"
                // commit() (synchronous): the process is about to die.
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY, text).commit()
            } catch (_: Throwable) {
            }
            previous?.uncaughtException(thread, error)
        }
    }
}
