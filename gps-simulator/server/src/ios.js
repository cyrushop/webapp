import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ios/ios_bridge.py');

/**
 * Drives an iPhone through ios/ios_bridge.py (pymobiledevice3, no-root userspace tunnel).
 * The helper keeps one DVT LocationSimulation session open; we stream fixes to it as JSON lines.
 * If it exits (cable pulled, phone locked, error) it is restarted after a short back-off.
 */
export class IosBridge extends EventEmitter {
  constructor({ python = 'python3', udid = '', helper = HELPER, retryMs = 3000 } = {}) {
    super();
    this.python = python;
    this.udid = udid;
    this.helper = helper;
    this.retryMs = retryMs;
    this.proc = null;
    this.enabled = false;
    this.state = 'off'; // off | starting | connecting | mounting | ready | cleared | error
    this.message = '';
    this.error = '';
    this.device = {};
    this.sent = 0;
    this.acked = 0;
    this.retryTimer = null;
    this.buf = '';
  }

  get ready() {
    return this.enabled && !!this.proc && (this.state === 'ready' || this.state === 'cleared');
  }

  get status() {
    return {
      enabled: this.enabled,
      ready: this.ready,
      state: this.state,
      message: this.message,
      error: this.error,
      udid: this.device.udid || '',
      model: this.device.model || '',
      ios: this.device.ios || '',
      sent: this.sent,
      acked: this.acked,
    };
  }

  start() {
    this.enabled = true;
    this.spawn();
  }

  stop() {
    this.enabled = false;
    clearTimeout(this.retryTimer);
    if (this.proc) {
      try {
        this.proc.stdin.end(); // helper clears the simulation on EOF
      } catch {}
      const p = this.proc;
      setTimeout(() => p.kill(), 3000).unref();
    }
    this.state = 'off';
    this.emit('status', this.status);
  }

  spawn() {
    if (!this.enabled || this.proc) return;
    const prev = this.state === 'error' ? this.message : '';
    this.state = 'starting';
    // Keep the last error visible while retrying so the user can act on it.
    this.message = prev ? `重試中…（上次：${prev}）` : '啟動 iPhone 橋接…';
    this.emit('status', this.status);
    const env = { ...process.env, IOS_UDID: this.udid, PYTHONUNBUFFERED: '1' };
    const proc = spawn(this.python, ['-u', this.helper], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.proc = proc;
    this.buf = '';
    proc.stdout.on('data', (d) => this.onOutput(d));
    let errTail = '';
    proc.stderr.on('data', (d) => {
      errTail = (errTail + String(d)).slice(-2000);
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => {
      this.error = e.code === 'ENOENT' ? `找不到 ${this.python}` : e.message;
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.state !== 'error') {
        this.state = 'error';
        const last = errTail.trim().split('\n').slice(-1)[0] || '';
        this.message = this.error || `iPhone 橋接已結束（code ${code}）${last ? `：${last.slice(0, 200)}` : ''}`;
      }
      this.emit('status', this.status);
      if (this.enabled) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.spawn(), this.retryMs);
      }
    });
  }

  onOutput(chunk) {
    this.buf += String(chunk);
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.t === 'status') {
        this.state = m.state;
        this.message = String(m.message || '').slice(0, 300);
        this.error = m.state === 'error' ? String(m.error || '') : '';
      } else if (m.t === 'hello') {
        this.device = { udid: String(m.udid || ''), model: String(m.model || ''), ios: String(m.ios || '') };
      } else if (m.t === 'ack') {
        this.acked = Number(m.fixes) || this.acked;
      }
      this.emit('status', this.status);
    }
  }

  write(obj) {
    if (!this.ready) return false;
    // Don't pile up if the helper is busy; it keeps only the latest fix anyway.
    if (this.proc.stdin.writableLength > 16 * 1024) return false;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  sendFix({ lat, lng }) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    const ok = this.write({ t: 'fix', lat: +lat.toFixed(7), lng: +lng.toFixed(7) });
    if (ok) this.sent++;
    return ok;
  }

  sendStop() {
    return this.write({ t: 'clear' });
  }
}
