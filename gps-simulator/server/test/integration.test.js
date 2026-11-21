import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server.js');
let proc;

before(async () => {
  proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DRY_RUN: '1', TICK_MS: '200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 5000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('GPS simulator bridge')) {
        clearTimeout(t);
        resolve();
      }
    });
  });
});

after(() => proc?.kill());

const open = (url, opts) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

function nextMessage(ws, pred, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    const on = (raw) => {
      const m = JSON.parse(String(raw));
      if (pred(m)) {
        clearTimeout(t);
        ws.off('message', on);
        resolve(m);
      }
    };
    ws.on('message', on);
  });
}

test('/device rejects browser origins', async () => {
  await assert.rejects(open(`ws://127.0.0.1:${PORT}/device`, { origin: 'http://localhost:1234' }), /401/);
});

test('/ws rejects foreign origins', async () => {
  await assert.rejects(open(`ws://127.0.0.1:${PORT}/ws`, { origin: 'https://evil.example' }), /401/);
});

test('phone link receives fixes and becomes the active transport', async () => {
  const phone = await open(`ws://127.0.0.1:${PORT}/device`);
  phone.send(JSON.stringify({ t: 'hello', model: 'Pixel 10 Pro', sdk: 37, app: '0.2.0' }));
  phone.send(JSON.stringify({ t: 'status', providers: ['gps', 'network', 'fused'], mockApp: true, fixes: 0 }));

  const fix = await nextMessage(phone, (m) => m.t === 'fix');
  assert.ok(Number.isFinite(fix.lat) && Number.isFinite(fix.lng));

  const ui = await open(`ws://127.0.0.1:${PORT}/ws`, { origin: `http://127.0.0.1:${PORT}` });
  const st = await nextMessage(ui, (m) => m.type === 'state' && m.data.device?.connected);
  assert.equal(st.data.transport, 'ws');
  assert.equal(st.data.device.model, 'Pixel 10 Pro');
  assert.equal(st.data.device.mockApp, true);

  // Teleport from the UI arrives at the phone.
  ui.send(JSON.stringify({ type: 'teleport', id: 1, data: { lat: 22.282, lng: 114.188, force: true } }));
  const moved = await nextMessage(phone, (m) => m.t === 'fix' && Math.abs(m.lat - 22.282) < 0.001);
  assert.ok(Math.abs(moved.lng - 114.188) < 0.001);

  // Restore real GPS -> stop frame.
  ui.send(JSON.stringify({ type: 'stopMocking', id: 2 }));
  await nextMessage(phone, (m) => m.t === 'stop');

  phone.close();
  const after = await nextMessage(ui, (m) => m.type === 'device' && m.data.connected === false);
  assert.notEqual(after.data.transport, 'ws');
  ui.close();
});
