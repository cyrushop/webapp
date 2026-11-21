import { EventEmitter } from 'node:events';

/**
 * Direct link to the Android app over WebSocket (path /device).
 *
 * The phone reaches the PC through `adb reverse tcp:PORT tcp:PORT`, so it connects to its own
 * 127.0.0.1:PORT and adb tunnels that over USB. Compared with one `am broadcast` per fix
 * (spawns a process on the phone, ~100–300 ms), a fix is a single small WebSocket frame.
 *
 * Protocol (JSON text frames)
 *   PC → phone : {"t":"fix","lat":..,"lng":..,"spd":..,"brg":..,"acc":..,"alt":..}
 *                {"t":"stop"}
 *   phone → PC : {"t":"hello","model":"..","sdk":37,"app":"0.2.0"}
 *                {"t":"status","providers":["gps",..],"mockApp":true,"fixes":123,"error":""}
 */
export class DeviceLink extends EventEmitter {
  constructor({ pingMs = 2000 } = {}) {
    super();
    this.ws = null;
    this.info = {};
    this.phone = {};
    this.rttMs = null;
    this.sent = 0;
    this.connectedAt = 0;
    this.pingMs = pingMs;
    this.pingTimer = null;
    this.pingSentAt = 0;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === this.ws.OPEN;
  }

  get status() {
    return {
      connected: this.connected,
      model: this.info.model || '',
      sdk: this.info.sdk || null,
      app: this.info.app || '',
      rttMs: this.rttMs,
      sent: this.sent,
      providers: this.phone.providers || [],
      mockApp: this.phone.mockApp ?? null,
      fixes: this.phone.fixes ?? null,
      error: this.phone.error || '',
      connectedAt: this.connectedAt,
    };
  }

  attach(ws) {
    if (this.ws && this.ws !== ws) {
      try {
        this.ws.close(4000, 'replaced by a newer connection');
      } catch {}
    }
    this.ws = ws;
    this.info = {};
    this.phone = {};
    this.rttMs = null;
    this.sent = 0;
    this.connectedAt = Date.now();

    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.t === 'hello') {
        this.info = {
          model: String(m.model || '').slice(0, 80),
          sdk: Number(m.sdk) || null,
          app: String(m.app || '').slice(0, 20),
        };
      } else if (m.t === 'status') {
        this.phone = {
          providers: Array.isArray(m.providers) ? m.providers.map(String).slice(0, 8) : [],
          mockApp: typeof m.mockApp === 'boolean' ? m.mockApp : null,
          fixes: Number(m.fixes) || 0,
          error: String(m.error || '').slice(0, 300),
        };
      }
      this.emit('status', this.status);
    });
    ws.on('pong', () => {
      if (this.pingSentAt) this.rttMs = Date.now() - this.pingSentAt;
    });
    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        clearInterval(this.pingTimer);
        this.emit('status', this.status);
      }
    });
    ws.on('error', () => {});

    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      this.pingSentAt = Date.now();
      try {
        this.ws.ping();
      } catch {}
      this.emit('status', this.status);
    }, this.pingMs);
    this.emit('status', this.status);
  }

  sendFix({ lat, lng, speed = 0, bearing = 0, accuracy = 5, altitude = 10 }) {
    if (!this.connected) return false;
    if (![lat, lng, speed, bearing, accuracy, altitude].every(Number.isFinite)) return false;
    // Drop instead of queueing if the socket is backed up (stale fixes are useless).
    if (this.ws.bufferedAmount > 64 * 1024) return false;
    this.ws.send(
      JSON.stringify({
        t: 'fix',
        lat: +lat.toFixed(7),
        lng: +lng.toFixed(7),
        spd: +speed.toFixed(2),
        brg: +bearing.toFixed(1),
        acc: +accuracy.toFixed(1),
        alt: +altitude.toFixed(1),
      }),
    );
    this.sent++;
    return true;
  }

  sendStop() {
    if (!this.connected) return false;
    this.ws.send(JSON.stringify({ t: 'stop' }));
    return true;
  }

  close() {
    clearInterval(this.pingTimer);
    try {
      this.ws?.close();
    } catch {}
  }
}
