import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Sends coordinates to the companion Android app through a persistent `adb shell`.
 *
 * Each fix becomes one explicit broadcast:
 *   am broadcast -n <pkg>/.CommandReceiver -a <pkg>.SET_LOCATION --es lat .. --es lng ..
 *
 * Only numbers formatted by this module are ever written to the shell (no user strings),
 * so there is no command-injection surface from the web UI.
 */
export class AdbBridge extends EventEmitter {
  constructor({ adbPath = 'adb', serial = '', pkg = 'com.pikminbridge.mock', dryRun = false, reversePort = 0 } = {}) {
    super();
    this.reversePort = reversePort; // 0 = don't set up `adb reverse`
    this.reverseOk = false;
    this.adbPath = adbPath;
    this.serial = serial;
    this.pkg = pkg;
    this.dryRun = dryRun;
    this.shell = null;
    this.pending = 0; // broadcasts written but not yet acknowledged
    this.maxPending = 2; // drop stale fixes instead of queueing a backlog
    this.sent = 0;
    this.dropped = 0;
    this.lastError = '';
    this.lastSentAt = 0;
    this.buf = '';
  }

  get status() {
    return {
      dryRun: this.dryRun,
      connected: this.dryRun || !!this.shell,
      serial: this.serial,
      pkg: this.pkg,
      sent: this.sent,
      dropped: this.dropped,
      pending: this.pending,
      lastError: this.lastError,
      lastSentAt: this.lastSentAt,
      reversePort: this.reversePort,
      reverseOk: this.reverseOk,
    };
  }

  serialArgs() {
    return this.serial ? ['-s', this.serial] : [];
  }

  exec(args, timeoutMs = 8000) {
    return new Promise((resolve) => {
      execFile(this.adbPath, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
      });
    });
  }

  async devices() {
    if (this.dryRun) return { ok: true, devices: [{ serial: 'dry-run', state: 'device', model: 'simulated' }] };
    const r = await this.exec(['devices', '-l']);
    if (!r.ok) return { ok: false, error: r.stderr.trim() || 'adb not found', devices: [] };
    const devices = r.stdout
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial, state, ...rest] = l.split(/\s+/);
        const model = (rest.find((x) => x.startsWith('model:')) || '').slice(6);
        return { serial, state, model };
      });
    return { ok: true, devices };
  }

  async selectDevice(serial) {
    this.serial = /^[\w.:\-]*$/.test(serial || '') ? serial || '' : '';
    this.disconnect();
    return this.connect();
  }

  async connect() {
    if (this.dryRun) {
      this.emit('status', this.status);
      return { ok: true };
    }
    if (this.shell) return { ok: true };
    const list = await this.devices();
    if (!list.ok) {
      this.lastError = list.error;
      this.emit('status', this.status);
      return { ok: false, error: list.error };
    }
    const ready = list.devices.filter((d) => d.state === 'device');
    if (!ready.length) {
      this.lastError = '找不到已授權的裝置（請開啟 USB 偵錯並在手機上允許此電腦）';
      this.emit('status', this.status);
      return { ok: false, error: this.lastError };
    }
    if (!this.serial || !ready.some((d) => d.serial === this.serial)) this.serial = ready[0].serial;

    const sh = spawn(this.adbPath, [...this.serialArgs(), 'shell'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.shell = sh;
    this.pending = 0;
    this.lastError = '';
    sh.stdout.on('data', (d) => this.onOutput(d));
    sh.stderr.on('data', (d) => {
      this.lastError = String(d).trim().slice(0, 300);
    });
    sh.on('exit', (code) => {
      if (this.shell === sh) {
        this.shell = null;
        this.lastError = this.lastError || `adb shell exited (${code})`;
        this.emit('status', this.status);
      }
    });
    sh.stdin.on('error', () => {});
    const rev = await this.reverse();
    this.emit('status', this.status);
    return { ok: true, serial: this.serial, reverse: rev.ok };
  }

  /**
   * `adb reverse tcp:P tcp:P`: the phone's 127.0.0.1:P is tunnelled over USB to this PC's
   * 127.0.0.1:P, so the app can open ws://127.0.0.1:P/device without Wi-Fi or a LAN IP.
   * The mapping is lost when the cable is unplugged or adbd restarts; call again after that.
   */
  async reverse() {
    if (this.dryRun || !this.reversePort) return { ok: false, skipped: true };
    const port = Number(this.reversePort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'bad port' };
    const r = await this.exec([...this.serialArgs(), 'reverse', `tcp:${port}`, `tcp:${port}`]);
    this.reverseOk = r.ok;
    if (!r.ok) this.lastError = `adb reverse 失敗：${r.stderr.trim().slice(0, 200)}`;
    this.emit('status', this.status);
    return { ok: r.ok, error: r.ok ? undefined : r.stderr.trim() };
  }

  disconnect() {
    if (this.shell) {
      try {
        this.shell.stdin.end('exit\n');
        this.shell.kill();
      } catch {}
      this.shell = null;
    }
    this.emit('status', this.status);
  }

  onOutput(chunk) {
    this.buf += String(chunk);
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line === '__ACK__') this.pending = Math.max(0, this.pending - 1);
      else if (/Error|Exception|denied/i.test(line)) this.lastError = line.slice(0, 300);
    }
  }

  broadcastCommand(action, extras) {
    const parts = ['am', 'broadcast', '-n', `${this.pkg}/.CommandReceiver`, '-a', `${this.pkg}.${action}`];
    for (const [k, v] of Object.entries(extras)) parts.push('--es', k, v);
    return parts.join(' ');
  }

  /** Fire-and-forget: send one GPS fix to the phone. */
  sendLocation({ lat, lng, speed = 0, bearing = 0, accuracy = 5, altitude = 10 }) {
    if (![lat, lng, speed, bearing, accuracy, altitude].every(Number.isFinite)) return false;
    const cmd = this.broadcastCommand('SET_LOCATION', {
      lat: lat.toFixed(7),
      lng: lng.toFixed(7),
      spd: speed.toFixed(2),
      brg: bearing.toFixed(1),
      acc: accuracy.toFixed(1),
      alt: altitude.toFixed(1),
    });
    return this.write(cmd);
  }

  sendStop() {
    return this.write(this.broadcastCommand('STOP', {}));
  }

  write(cmd) {
    if (this.dryRun) {
      this.sent++;
      this.lastSentAt = Date.now();
      if (process.env.VERBOSE) console.log('[dry-run]', cmd);
      return true;
    }
    if (!this.shell) return false;
    // A lost ACK must not wedge the queue forever.
    if (this.pending > 0 && Date.now() - this.lastSentAt > 5000) this.pending = 0;
    if (this.pending >= this.maxPending) {
      this.dropped++;
      return false;
    }
    this.pending++;
    this.sent++;
    this.lastSentAt = Date.now();
    this.shell.stdin.write(`${cmd} >/dev/null 2>&1; echo __ACK__\n`);
    return true;
  }

  /** Grants the mock-location app-op and launches the companion app (needs USB debugging). */
  async setupPhone() {
    if (this.dryRun) return { ok: true, log: ['dry-run: skipped'] };
    const s = this.serialArgs();
    const log = [];
    const steps = [
      ...(this.reversePort ? [['reverse', `tcp:${this.reversePort}`, `tcp:${this.reversePort}`]] : []),
      ['shell', 'appops', 'set', this.pkg, 'android:mock_location', 'allow'],
      ['shell', 'pm', 'grant', this.pkg, 'android.permission.ACCESS_FINE_LOCATION'],
      ['shell', 'am', 'start', '-n', `${this.pkg}/.MainActivity`, '--ez', 'autostart', 'true'],
    ];
    let ok = true;
    for (const args of steps) {
      const r = await this.exec([...s, ...args]);
      log.push(`$ adb ${args.join(' ')}\n${(r.stdout + r.stderr).trim() || 'OK'}`);
      if (!r.ok) ok = false;
    }
    return { ok, log };
  }
}
