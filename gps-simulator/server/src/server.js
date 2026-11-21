import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Engine } from './engine.js';
import { AdbBridge } from './adb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '../../web');
// Leaflet is served from node_modules so the UI works without any CDN.
const LEAFLET_ROOT = path.resolve(__dirname, '../node_modules/leaflet/dist');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const TICK_MS = Math.max(200, Number(process.env.TICK_MS || 1000));
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');

const engine = new Engine({ tickMs: TICK_MS });
const adb = new AdbBridge({
  adbPath: process.env.ADB_PATH || 'adb',
  serial: process.env.ADB_SERIAL || '',
  pkg: process.env.MOCK_PKG || 'com.pikminbridge.mock',
  dryRun: DRY_RUN,
});

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
  if (rel.startsWith('/vendor/leaflet/')) {
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

const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ origin, req }) => originAllowed(origin, req.headers.host),
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
    broadcast('state', { ...engine.snapshot(), adb: adb.status });
  }, 100);
});
engine.on('route', (points) => broadcast('route', points));
engine.on('location', (fix) => adb.sendLocation(fix));
engine.on('stopMocking', () => adb.sendStop());
adb.on('status', (st) => broadcast('adb', st));

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
  clearAction: () => (engine.clearAction(), { ok: true }),
  cooldown: (d) => ({ ok: true, cooldown: engine.cooldownFor({ lat: Number(d.lat), lng: Number(d.lng) }) }),
  stopMocking: () => (engine.stopMocking(), { ok: true }),
  devices: () => adb.devices(),
  selectDevice: (d) => adb.selectDevice(String(d.serial || '')),
  connect: () => adb.connect(),
  setupPhone: () => adb.setupPhone(),
};

wss.on('connection', (ws) => {
  send(ws, 'hello', { version: 1, dryRun: DRY_RUN, tickMs: TICK_MS });
  send(ws, 'state', { ...engine.snapshot(), adb: adb.status });
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
  console.log(`GPS simulator bridge on http://${shown}:${PORT}  (tick ${TICK_MS} ms${DRY_RUN ? ', DRY RUN' : ''})`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn('WARNING: listening beyond localhost — anyone on this network can control the phone location.');
  }
  engine.start();
  const r = await adb.connect();
  console.log(r.ok ? `adb: connected ${adb.serial || ''}` : `adb: ${r.error} (UI 可重試)`);
});

function shutdown() {
  engine.stop();
  adb.disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
