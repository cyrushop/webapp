import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, bearing, destination, cooldownMinutes, Drift, offsetMeters } from '../src/geo.js';
import { RoutePlayer } from '../src/route.js';
import { Engine } from '../src/engine.js';

const TOKYO_TOWER = { lat: 35.658581, lng: 139.745433 };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('distance: Tokyo Tower -> Shibuya roughly 3.5–4.5 km', () => {
  const d = distance(TOKYO_TOWER, { lat: 35.658, lng: 139.7016 });
  assert.ok(d > 3500 && d < 4500, `got ${d}`);
});

test('destination/bearing round-trip', () => {
  const p = destination(TOKYO_TOWER, 45, 1000);
  assert.ok(near(distance(TOKYO_TOWER, p), 1000, 0.5));
  assert.ok(near(bearing(TOKYO_TOWER, p), 45, 0.1));
});

test('destination wraps across the antimeridian', () => {
  const p = destination({ lat: 0, lng: 179.999 }, 90, 1000);
  assert.ok(p.lng < -179.99 && p.lng >= -180);
});

test('cooldown table lookup', () => {
  assert.equal(cooldownMinutes(0), 0);
  assert.equal(cooldownMinutes(0.8), 0.5);
  assert.equal(cooldownMinutes(10), 8);
  assert.equal(cooldownMinutes(10.1), 9);
  assert.equal(cooldownMinutes(5000), 120);
});

test('drift stays within amplitude', () => {
  let seed = 1;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const drift = new Drift({ amplitudeM: 3, rng });
  for (let i = 0; i < 2000; i++) {
    const q = drift.apply(TOKYO_TOWER);
    assert.ok(distance(TOKYO_TOWER, q) <= 3.01);
  }
});

const square = [
  TOKYO_TOWER,
  offsetMeters(TOKYO_TOWER, 100, 0),
  offsetMeters(TOKYO_TOWER, 100, 100),
  offsetMeters(TOKYO_TOWER, 0, 100),
];

test('route once stops at the end', () => {
  const r = new RoutePlayer(square, 'once');
  assert.ok(near(r.length, 300, 0.5));
  r.advance(250);
  assert.equal(r.finished, false);
  r.advance(100);
  assert.equal(r.finished, true);
  assert.ok(distance(r.position, square[3]) < 0.5);
});

test('route circuit closes the loop and counts laps', () => {
  const r = new RoutePlayer(square, 'circuit');
  assert.ok(near(r.length, 400, 0.5));
  r.advance(410);
  assert.equal(r.lap, 1);
  assert.ok(near(r.s, 10, 0.01));
  r.advance(1200); // multiple wraps in one step
  assert.equal(r.lap, 4);
});

test('route ping-pong reflects at both ends', () => {
  const r = new RoutePlayer(square, 'pingpong');
  r.advance(350); // 300 out, 50 back
  assert.equal(r.dir, -1);
  assert.ok(near(r.s, 250, 0.01));
  r.advance(300); // 250 to start, 50 out again
  assert.equal(r.dir, 1);
  assert.equal(r.lap, 1);
  assert.ok(near(r.s, 50, 0.01));
});

test('route rejects degenerate input', () => {
  assert.throws(() => new RoutePlayer([TOKYO_TOWER, TOKYO_TOWER], 'once'));
  assert.throws(() => new RoutePlayer(square, 'bogus'));
});

test('engine: walking speed is respected', () => {
  const e = new Engine({ tickMs: 1000, start: TOKYO_TOWER, rng: () => 0.5 });
  e.updateSettings({ speedKmh: 7.2, speedVariancePct: 0, jitterM: 0, loopMode: 'once' });
  e.setRoute(square);
  assert.equal(e.startRoute().ok, true);
  let t = 1_000_000;
  e.lastTick = t;
  for (let i = 0; i < 10; i++) e.tick((t += 1000));
  // 7.2 km/h = 2 m/s -> 20 m in 10 s
  assert.ok(near(e.route.s, 20, 0.5), `s=${e.route.s}`);
});

test('engine: teleport is gated by cooldown unless forced', () => {
  const e = new Engine({ start: TOKYO_TOWER });
  const now = Date.now();
  e.markAction(now);
  const osaka = { lat: 34.6937, lng: 135.5023 };
  const r1 = e.teleport(osaka);
  assert.equal(r1.ok, false);
  assert.equal(r1.needsConfirm, true);
  assert.ok(r1.cooldown.requiredMin >= 50);
  const r2 = e.teleport(osaka, { force: true });
  assert.equal(r2.ok, true);
  assert.ok(distance(e.position, osaka) < 0.01);
});

test('engine: joystick moves north when y=1', () => {
  const e = new Engine({ start: TOKYO_TOWER, rng: () => 0.5 });
  e.updateSettings({ speedKmh: 3.6, speedVariancePct: 0, jitterM: 0 });
  e.setJoystick(0, 1);
  let t = 5_000_000;
  e.lastTick = t;
  e.tick(t + 1000);
  assert.ok(e.position.lat > TOKYO_TOWER.lat);
  assert.ok(near(distance(TOKYO_TOWER, e.position), 1, 0.05));
});

test('engine: far route start requires teleport confirmation', () => {
  const e = new Engine({ start: { lat: 25.034, lng: 121.5645 } });
  e.setRoute(square);
  const r = e.startRoute();
  assert.equal(r.ok, false);
  assert.equal(r.needsTeleport, true);
  const r2 = e.startRoute({ teleportToStart: true, force: true });
  assert.equal(r2.ok, true);
  assert.equal(e.routeState, 'running');
});
