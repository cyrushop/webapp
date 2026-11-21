package com.pikminbridge.mock

import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * WebSocket link to the PC bridge at ws://127.0.0.1:<port>/device.
 * `adb reverse tcp:<port> tcp:<port>` (done by the bridge) tunnels that loopback address over USB.
 * Reconnects every 2 s while running, so unplug/replug and bridge restarts recover on their own.
 * All callbacks are delivered on the main thread.
 */
class BridgeClient(
    private val port: Int,
    private val listener: Listener,
) {
    interface Listener {
        fun onFix(fix: MockLocationService.Fix)
        fun onStopRequested()
        fun onLinkChanged(connected: Boolean)
        fun helloJson(): JSONObject
        fun statusJson(): JSONObject
    }

    companion object {
        private const val TAG = "BridgeClient"
        private const val RETRY_MS = 2000L
    }

    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // long-lived socket
        .pingInterval(10, TimeUnit.SECONDS) // detect a dead USB tunnel
        .build()

    @Volatile private var socket: WebSocket? = null
    @Volatile private var running = false
    @Volatile var connected = false
        private set
    private var retryScheduled = false

    fun start() {
        if (running) return
        running = true
        connect()
    }

    fun stop() {
        running = false
        main.removeCallbacksAndMessages(null)
        socket?.close(1000, "service stopped")
        socket = null
        setConnected(false)
    }

    fun sendStatus() {
        if (connected) socket?.send(listener.statusJson().toString())
    }

    private fun connect() {
        if (!running) return
        retryScheduled = false
        val req = Request.Builder().url("ws://127.0.0.1:$port/device").build()
        socket = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    if (webSocket !== socket) return@post
                    setConnected(true)
                    webSocket.send(listener.helloJson().toString())
                    webSocket.send(listener.statusJson().toString())
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try {
                    JSONObject(text)
                } catch (e: Exception) {
                    return
                }
                main.post {
                    when (msg.optString("t")) {
                        "fix" -> parseFix(msg)?.let { listener.onFix(it) }
                        "stop" -> listener.onStopRequested()
                    }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost(webSocket)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.d(TAG, "link failed: ${t.message}")
                lost(webSocket)
            }
        })
    }

    private fun lost(ws: WebSocket) {
        main.post {
            if (ws !== socket) return@post
            socket = null
            setConnected(false)
            if (running && !retryScheduled) {
                retryScheduled = true
                main.postDelayed({ connect() }, RETRY_MS)
            }
        }
    }

    private fun setConnected(value: Boolean) {
        if (connected == value) return
        connected = value
        listener.onLinkChanged(value)
    }

    private fun parseFix(m: JSONObject): MockLocationService.Fix? {
        val lat = m.optDouble("lat", Double.NaN)
        val lng = m.optDouble("lng", Double.NaN)
        if (lat.isNaN() || lng.isNaN() || lat !in -90.0..90.0 || lng !in -180.0..180.0) return null
        return MockLocationService.Fix(
            lat = lat,
            lng = lng,
            alt = m.optDouble("alt", 10.0),
            speed = m.optDouble("spd", 0.0).coerceIn(0.0, 100.0).toFloat(),
            bearing = ((m.optDouble("brg", 0.0) % 360 + 360) % 360).toFloat(),
            accuracy = m.optDouble("acc", 5.0).coerceIn(1.0, 200.0).toFloat(),
        )
    }
}
