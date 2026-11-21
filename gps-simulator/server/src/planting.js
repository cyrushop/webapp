// Flower-planting ESTIMATOR. Pikmin Bloom publishes no formula; every default below is a
// community-reported figure (player tests / wikis), not an official value, and is user-editable.
//
// Model
//   petals/s  = rate for the squad size (only while moving and not over the speed cap)
//   flowers/s = petals/s × flowersPerPetal(speed) × fresh
//   fresh     = 1 when the current map cell's last planting was ≥ cooldown ago, else 0
//               (a cell holds one flower that can't be replaced for ~5 min; petals spent on
//                such cells are counted as wasted)

const toRad = (d) => (d * Math.PI) / 180;

export const DEFAULT_PLANTING = {
  enabled: true,
  squad: 40, // Pikmin in the squad (10–40)
  // Petals per second by squad size. 40 → 6 petals / 10 s; 10–19 → 3 petals / 20 s (community).
  // 20–39 are linearly interpolated between those two reports.
  petalRateMin: 0.15, // at 10 Pikmin
  petalRateMax: 0.6, // at 40 Pikmin
  // Flowers per petal: ~36 walking, ~50 cycling at 17–19 km/h (community reports).
  flowersPerPetalWalk: 36,
  walkRefKmh: 5,
  flowersPerPetalFast: 50,
  fastRefKmh: 18,
  speedCapKmh: 20, // reports range 15–20 km/h; above this nothing is planted
  cooldownMin: 5,
  cellM: 10, // grid cell size used to detect re-planting the same spot (approximation)
  petalsAvailable: 0, // 0 = unlimited
};

export function petalRate(cfg, squad = cfg.squad) {
  const s = Math.min(40, Math.max(10, squad));
  return cfg.petalRateMin + ((cfg.petalRateMax - cfg.petalRateMin) * (s - 10)) / 30;
}

export function flowersPerPetal(cfg, speedKmh) {
  const { walkRefKmh: a, fastRefKmh: b, flowersPerPetalWalk: fa, flowersPerPetalFast: fb } = cfg;
  if (b <= a) return fa;
  const t = Math.min(1, Math.max(0, (speedKmh - a) / (b - a)));
  return fa + (fb - fa) * t;
}

/** Fraction of visits that can plant when the same spot is passed every `periodSec`. */
export function freshFraction(periodSec, cooldownSec) {
  if (!(periodSec > 0) || periodSec >= cooldownSec) return 1;
  return 1 / Math.ceil(cooldownSec / periodSec);
}

/**
 * Planner: expected output for a route lap. `lapM` = metres per lap; for ping-pong pass the
 * one-way length and pingpong=true (each point is revisited about every round trip).
 */
export function estimateRoute(cfg, { lapM, speedKmh, pingpong = false }) {
  const speed = Math.max(0.1, speedKmh);
  const overCap = speed > cfg.speedCapKmh;
  const lapSec = lapM / (speed / 3.6);
  const periodSec = pingpong ? lapSec * 2 : lapSec;
  const fresh = freshFraction(periodSec, cfg.cooldownMin * 60);
  const pps = overCap ? 0 : petalRate(cfg);
  const fpp = flowersPerPetal(cfg, speed);
  const perHourPetals = pps * 3600;
  const perHourFlowers = perHourPetals * fpp * fresh;
  return {
    lapSec,
    fresh,
    overCap,
    petalsPerHour: perHourPetals,
    flowersPerHour: perHourFlowers,
    flowersFirstLap: pps * lapSec * fpp,
    flowersPerLap: pps * lapSec * fpp * fresh,
    hoursUntilEmpty: cfg.petalsAvailable > 0 && perHourPetals > 0 ? cfg.petalsAvailable / perHourPetals : null,
  };
}

export class PlantingTracker {
  constructor(cfg = DEFAULT_PLANTING) {
    this.cfg = { ...cfg };
    this.reset();
  }

  reset() {
    this.flowers = 0;
    this.petalsUsed = 0;
    this.petalsWasted = 0;
    this.plantingSec = 0;
    this.overSpeedSec = 0;
    this.cells = new Map(); // cellKey -> last planted at (ms)
    this.window = []; // [t, flowers] for the recent-rate readout
    this.curCell = null;
    this.curFresh = false;
    this.startedAt = Date.now();
  }

  update(patch = {}) {
    const c = this.cfg;
    for (const k of Object.keys(DEFAULT_PLANTING)) {
      if (k === 'enabled') {
        if (typeof patch.enabled === 'boolean') c.enabled = patch.enabled;
      } else if (Number.isFinite(patch[k]) && patch[k] >= 0) {
        c[k] = patch[k];
      }
    }
    c.squad = Math.min(40, Math.max(10, Math.round(c.squad)));
    c.cellM = Math.max(1, c.cellM);
  }

  cellKey(p) {
    const m = this.cfg.cellM;
    const y = Math.floor((p.lat * 111320) / m);
    const x = Math.floor((p.lng * 111320 * Math.cos(toRad(p.lat))) / m);
    return `${x}:${y}`;
  }

  get petalsLeft() {
    return this.cfg.petalsAvailable > 0 ? Math.max(0, this.cfg.petalsAvailable - this.petalsUsed) : Infinity;
  }

  /** Called once per engine tick with the true (un-jittered) position. */
  tick({ dt, movedM, position, now = Date.now() }) {
    const c = this.cfg;
    if (!c.enabled || !(dt > 0) || !(movedM > 0.05)) return;
    const speedKmh = (movedM / dt) * 3.6;
    if (speedKmh > c.speedCapKmh) {
      this.overSpeedSec += dt;
      return;
    }
    const petals = Math.min(petalRate(c) * dt, this.petalsLeft);
    if (!(petals > 0)) return;
    this.petalsUsed += petals;
    this.plantingSec += dt;

    // Decide freshness when ENTERING a cell; several ticks inside the same cell share it.
    const key = this.cellKey(position);
    if (key !== this.curCell) {
      const last = this.cells.get(key);
      this.curCell = key;
      this.curFresh = last == null || now - last >= c.cooldownMin * 60000;
      if (this.curFresh) this.cells.set(key, now);
    }
    if (!this.curFresh) {
      this.petalsWasted += petals;
      return;
    }
    const f = petals * flowersPerPetal(c, speedKmh);
    this.flowers += f;
    this.window.push([now, f]);
    if (this.cells.size > 50000) {
      // Forget cells whose cooldown expired long ago.
      for (const [k, t] of this.cells) if (now - t > c.cooldownMin * 60000) this.cells.delete(k);
    }
  }

  snapshot(now = Date.now()) {
    while (this.window.length && now - this.window[0][0] > 60000) this.window.shift();
    const lastMinute = this.window.reduce((s, [, f]) => s + f, 0);
    // Average over the time actually covered (≤ 60 s) so the rate isn't understated at start.
    const spanSec = this.window.length ? Math.min(60, Math.max(1, (now - this.window[0][0]) / 1000 + 1)) : 60;
    return {
      cfg: this.cfg,
      flowers: this.flowers,
      petalsUsed: this.petalsUsed,
      petalsWasted: this.petalsWasted,
      petalsLeft: Number.isFinite(this.petalsLeft) ? this.petalsLeft : null,
      plantingSec: this.plantingSec,
      overSpeedSec: this.overSpeedSec,
      flowersPerHourNow: (lastMinute / spanSec) * 3600,
      petalRate: petalRate(this.cfg),
      startedAt: this.startedAt,
    };
  }
}
