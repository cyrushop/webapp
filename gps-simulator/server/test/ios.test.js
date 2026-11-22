import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IosBridge } from '../src/ios.js';

// Stand-in for ios/ios_bridge.py speaking the same JSON-lines protocol.
const FAKE = `
import json, sys
def out(o):
    sys.stdout.write(json.dumps(o) + "\\n"); sys.stdout.flush()
out({"t":"status","state":"connecting","message":"..."})
out({"t":"hello","udid":"00008030-TEST","model":"iPhone12,3","ios":"26.5"})
out({"t":"status","state":"ready","message":"ok"})
n = 0
for line in sys.stdin:
    m = json.loads(line)
    if m["t"] == "fix":
        n += 1
        out({"t":"ack","fixes":n,"lat":m["lat"]})
    elif m["t"] == "clear":
        out({"t":"status","state":"cleared","message":"cleared"})
`;

const FAIL = `
import json, sys
sys.stdout.write(json.dumps({"t":"status","state":"error","error":"DeveloperModeIsNotEnabledError","message":"dev mode off"}) + "\\n")
sys.exit(1)
`;

function script(body) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iosb-')), 'helper.py');
  fs.writeFileSync(f, body);
  return f;
}

const waitFor = (bridge, pred, ms = 5000) =>
  new Promise((resolve, reject) => {
    if (pred(bridge.status)) return resolve(bridge.status);
    const t = setTimeout(() => reject(new Error(`timeout; last ${JSON.stringify(bridge.status)}`)), ms);
    const on = (st) => {
      if (pred(st)) {
        clearTimeout(t);
        bridge.off('status', on);
        resolve(st);
      }
    };
    bridge.on('status', on);
  });

test('iPhone bridge: handshake, fixes, clear', async () => {
  const b = new IosBridge({ helper: script(FAKE) });
  assert.equal(b.sendFix({ lat: 1, lng: 2 }), false); // not ready yet
  b.start();
  const st = await waitFor(b, (s) => s.ready);
  assert.equal(st.ios, '26.5');
  assert.equal(st.model, 'iPhone12,3');
  assert.equal(b.sendFix({ lat: 22.282, lng: 114.188 }), true);
  assert.equal(b.sendFix({ lat: 22.283, lng: 114.188 }), true);
  await waitFor(b, (s) => s.acked === 2);
  b.sendStop();
  await waitFor(b, (s) => s.state === 'cleared');
  assert.equal(b.ready, true); // still usable after clearing
  b.stop();
  assert.equal(b.status.state, 'off');
});

test('iPhone bridge: helper error is surfaced and retried', async () => {
  const b = new IosBridge({ helper: script(FAIL), retryMs: 200 });
  b.start();
  const st = await waitFor(b, (s) => s.state === 'error' && s.error === 'DeveloperModeIsNotEnabledError');
  assert.equal(st.ready, false);
  // It restarts on its own: wait for a second "starting" after the error.
  await waitFor(b, (s) => s.state === 'starting', 2000);
  b.stop();
});
