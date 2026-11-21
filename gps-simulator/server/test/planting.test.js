import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLANTING,
  PlantingTracker,
  estimateRoute,
  flowersPerPetal,
  freshFraction,
  petalRate,
} from '../src/planting.js';
import { offsetMeters } from '../src/geo.js';
import { Engine } from '../src/engine.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const START = { lat: 35.658581, lng: 139.745433 };

test('petal rate matches the community reports at 10 and 40 Pikmin', () => {
  assert.ok(near(petalRate(DEFAULT_PLANTING, 40), 0.6, 1e-9)); // 6 petals / 10 s
  assert.ok(near(petalRate(DEFAULT_PLANTING, 10), 0.15, 1e-9)); // 3 petals / 20 s
  assert.ok(near(petalRate(DEFAULT_PLANTING, 25), 0.375, 1e-9));
});

test('flowers per petal interpolates walk → cycling and clamps', () => {
  assert.equal(flowersPerPetal(DEFAULT_PLANTING, 3), 36);
  assert.equal(flowersPerPetal(DEFAULT_PLANTING, 25), 50);
  assert.ok(near(flowersPerPetal(DEFAULT_PLANTING, 11.5), 43, 1e-9));
});

test('fresh fraction for short loops', () => {
  assert.equal(freshFraction(400, 300), 1);
  assert.equal(freshFraction(300, 300), 1);
  assert.equal(freshFraction(200, 300), 0.5); // every 2nd pass can plant
  assert.equal(freshFraction(60, 300), 0.2);
});

test('route planner: 1 km circuit at 6 km/h with 40 Pikmin', () => {
  const r = estimateRoute(DEFAULT_PLANTING, { lapM: 1000, speedKmh: 6 });
  assert.ok(near(r.lapSec, 600, 0.01));
  assert.equal(r.fresh, 1);
  assert.ok(near(r.petalsPerHour, 2160, 1e-6));
  // fpp at 6 km/h = 36 + 14 * (1/13)
  assert.ok(near(r.flowersPerHour, 2160 * (36 + 14 / 13), 1e-6));
  assert.equal(estimateRoute(DEFAULT_PLANTING, { lapM: 1000, speedKmh: 25 }).flowersPerHour, 0);
});

test('tracker: straight walk plants, standing still and over-speed do not', () => {
  const t = new PlantingTracker(DEFAULT_PLANTING);
  let p = START;
  let now = 1_000_000;
  for (let i = 0; i < 60; i++) {
    p = offsetMeters(p, 0, 1.5); // 1.5 m/s = 5.4 km/h
    t.tick({ dt: 1, movedM: 1.5, position: p, now: (now += 1000) });
  }
  const s = t.snapshot(now);
  assert.ok(near(s.petalsUsed, 36, 1e-6)); // 0.6/s × 60 s
  assert.equal(s.petalsWasted, 0);
  assert.ok(s.flowers > 36 * 36 && s.flowers < 36 * 50);

  t.tick({ dt: 1, movedM: 0, position: p, now: (now += 1000) });
  t.tick({ dt: 1, movedM: 10, position: offsetMeters(p, 0, 10), now: (now += 1000) }); // 36 km/h
  const s2 = t.snapshot(now);
  assert.ok(near(s2.petalsUsed, 36, 1e-6));
  assert.equal(s2.overSpeedSec, 1);
});

test('tracker: pacing back and forth on a short line wastes petals', () => {
  const t = new PlantingTracker(DEFAULT_PLANTING);
  let now = 0;
  const a = START;
  const b = offsetMeters(START, 0, 30);
  // 30 m line walked back and forth for 4 minutes (< 5 min cooldown)
  for (let i = 0; i < 240; i++) {
    const phase = (i % 40) / 20; // 0..2
    const f = phase <= 1 ? phase : 2 - phase;
    const p = { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
    t.tick({ dt: 1, movedM: 1.5, position: p, now: (now += 1000) });
  }
  const s = t.snapshot(now);
  assert.ok(s.petalsWasted > s.petalsUsed * 0.7, `wasted ${s.petalsWasted} of ${s.petalsUsed}`);
});

test('tracker: petal stock runs out', () => {
  const t = new PlantingTracker({ ...DEFAULT_PLANTING, petalsAvailable: 3 });
  let p = START;
  for (let i = 0; i < 20; i++) {
    p = offsetMeters(p, 1.5, 0);
    t.tick({ dt: 1, movedM: 1.5, position: p, now: i * 1000 });
  }
  assert.ok(near(t.snapshot().petalsUsed, 3, 1e-9));
  assert.equal(t.snapshot().petalsLeft, 0);
});

test('engine feeds the tracker while walking a route', () => {
  const e = new Engine({ start: START, rng: () => 0.5 });
  e.updateSettings({ speedKmh: 5.4, speedVariancePct: 0, jitterM: 0, loopMode: 'once', planting: { squad: 20 } });
  e.setRoute([START, offsetMeters(START, 0, 500)]);
  e.startRoute();
  let t = 2_000_000;
  e.lastTick = t;
  for (let i = 0; i < 30; i++) e.tick((t += 1000));
  const s = e.snapshot().planting;
  assert.equal(s.cfg.squad, 20);
  assert.ok(near(s.petalsUsed, 30 * 0.3, 1e-6));
  assert.ok(s.flowers > 0);
});
