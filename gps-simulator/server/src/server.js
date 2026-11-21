import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Engine } from './engine.js';
import { AdbBridge } from './adb.js';
import { DeviceLink } from './device.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '../../web');
// Leaflet is served from node_modules so the UI works without any CDN.
const LEAFLET_ROOT = path.resolve(__dirname, '../node_modules/leaflet/dist');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const TICK_MS = Math.max(200, Number(process.env.TICK_MS || 1000));
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
// auto: use the phone's WebSocket link when connected, else fall back to `am broadcast`.
const TRANSPORT = ['auto', 'ws', 'adb'].includes(process.env.TRANSPORT) ? process.env.TRANSPORT : 'auto';
// Allow phones on the LAN (Wi-Fi, no USB) to open /device. Off by default.
const DEVICE_ALLOW_LAN = /^(1|true|yes)$/i.test(process.env.DEVICE_ALLOW_LAN || '');

const engine = new Engine({ tickMs: TICK_MS });
const adb = new AdbBridge({
  adbPath: process.env.ADB_PATH || 'adb',
  serial: process.env.ADB_SERIAL || '',
  pkg: process.env.MOCK_PKG || 'com.pikminbridge.mock',
  dryRun: DRY_RUN,
  reversePort: TRANSPORT === 'adb' ? 0 : PORT,
});
const device = new DeviceLink();

// ---------------- static file server ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  let root = WEB_ROOT;
  if (rel === '/lib/planting.js') {
    root = __dirname;
    rel = '/planting.js';
  } else if (rel.startsWith('/vendor/leaflet/')) {
    root = LEAFLET_ROOT;
    rel = rel.slice('/vendor/leaflet'.length);
  }
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------------- websocket ----------------
// The bridge can drive adb, so refuse WebSocket connections from other websites
// (browsers let any page open a WS to localhost). Only same-host origins are accepted.
function originAllowed(origin, hostHeader) {
  if (!origin) return true; // non-browser clients (curl, scripts) on this machine
  try {
    const o = new URL(origin);
    if (['localhost', '127.0.0.1', '[::1]'].includes(o.hostname)) return true;
    return o.host === hostHeader;
  } catch {
    return false;
  }
}

// Two WebSocket endpoints on one HTTP server: /ws for the browser UI, /device for the phone.
const wss = new WebSocketServer({ noServer: true });
const deviceWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

function isLoopback(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const reject = (code, msg) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (pathname === '/ws') {
    if (!originAllowed(req.headers.origin, req.headers.host)) return reject(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/device') {
    // Browsers always send Origin; the Android app does not. Refusing Origin-bearing requests
    // stops web pages from impersonating the phone.
    if (req.headers.origin) return reject(401, 'Unauthorized');
    if (!DEVICE_ALLOW_LAN && !isLoopback(req.socket.remoteAddress)) return reject(403, 'Forbidden');
    deviceWss.handleUpgrade(req, socket, head, (ws) => device.attach(ws));
  } else {
    reject(404, 'Not Found');
  }
});

function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data }));
}
function broadcast(type, data) {
  for (const ws of wss.clients) send(ws, type, data);
}

// Coalesce state updates to at most ~10/s.
let stateQueued = false;
engine.on('state', () => {
  if (stateQueued) return;
  stateQueued = true;
  setTimeout(() => {
    stateQueued = false;
    broadcast('state', fullState());
  }, 100);
});
engine.on('route', (points) => broadcast('route', points));
function activeTransport() {
  if (TRANSPORT !== 'adb' && device.connected) return 'ws';
  if (TRANSPORT !== 'ws' && adb.status.connected) return 'adb';
  return 'none';
}
function fullState() {
  return { ...engine.snapshot(), adb: adb.status, device: device.status, transport: activeTransport(), transportMode: TRANSPORT };
}
engine.on('location', (fix) => {
  const t = activeTransport();
  if (t === 'ws') device.sendFix(fix);
  else if (t === 'adb') adb.sendLocation(fix);
});
engine.on('stopMocking', () => {
  device.sendStop();
  adb.sendStop();
});
adb.on('status', (st) => broadcast('adb', st));
device.on('status', (st) => {
  broadcast('device', { ...st, transport: activeTransport() });
});

const handlers = {
  teleport: (d) => engine.teleport({ lat: Number(d.lat), lng: Number(d.lng) }, { force: !!d.force }),
  setRoute: (d) => engine.setRoute(d.points),
  clearRoute: () => (engine.clearRoute(), { ok: true }),
  startRoute: (d) => engine.startRoute({ teleportToStart: !!d.teleportToStart, force: !!d.force }),
  pauseRoute: () => (engine.pauseRoute(), { ok: true }),
  stopRoute: () => (engine.stopRoute(), { ok: true }),
  joystick: (d) => (engine.setJoystick(d.x, d.y), { ok: true }),
  settings: (d) => (engine.updateSettings(d), { ok: true }),
  markAction: () => (engine.markAction(), { ok: true }),
  resetPlanting: () => (engine.resetPlanting(), { ok: true }),
  clearAction: () => (engine.clearAction(), { ok: true }),
  cooldown: (d) => ({ ok: true, cooldown: engine.cooldownFor({ lat: Number(d.lat), lng: Number(d.lng) }) }),
  stopMocking: () => (engine.stopMocking(), { ok: true }),
  devices: () => adb.devices(),
  selectDevice: (d) => adb.selectDevice(String(d.serial || '')),
  connect: () => adb.connect(),
  setupPhone: () => adb.setupPhone(),
  reverse: () => adb.reverse(),
};

wss.on('connection', (ws) => {
  send(ws, 'hello', { version: 1, dryRun: DRY_RUN, tickMs: TICK_MS });
  send(ws, 'state', fullState());
  send(ws, 'route', engine.routePoints);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const fn = handlers[msg.type];
    let result;
    try {
      result = fn ? await fn(msg.data || {}) : { ok: false, error: `unknown command ${msg.type}` };
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    // joystick is high-frequency; skip replies for it
    if (msg.id != null && msg.type !== 'joystick') send(ws, 'reply', { id: msg.id, ...result });
  });
});

server.listen(PORT, HOST, async () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(
    `GPS simulator bridge on http://${shown}:${PORT}  (tick ${TICK_MS} ms, transport ${TRANSPORT}${DRY_RUN ? ', DRY RUN' : ''})`,
  );
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn('WARNING: listening beyond localhost — anyone on this network can control the phone location.');
  }
  engine.start();
  // Re-attach automatically after the cable is re-plugged (this also restores `adb reverse`).
  setInterval(() => {
    if (!DRY_RUN && !adb.shell && TRANSPORT !== 'ws') adb.connect().catch(() => {});
    else if (!DRY_RUN && adb.shell && !device.connected && TRANSPORT !== 'adb' && !adb.reverseOk) adb.reverse();
  }, 5000);
  const r = await adb.connect();
  console.log(r.ok ? `adb: connected ${adb.serial || ''}${r.reverse ? ` (reverse tcp:${PORT} ok)` : ''}` : `adb: ${r.error} (UI 可重試)`);
});

function shutdown() {
  engine.stop();
  device.close();
  adb.disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
