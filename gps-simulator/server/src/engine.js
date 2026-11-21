import { EventEmitter } from 'node:events';
import {
  Drift,
  DEFAULT_COOLDOWN_TABLE,
  cooldownMinutes,
  destination,
  distance,
  gaussian,
  isValidLatLng,
} from './geo.js';
import { RoutePlayer, LOOP_MODES } from './route.js';

const KMH_TO_MS = 1000 / 3600;

export const DEFAULT_SETTINGS = {
  speedKmh: 6,
  speedVariancePct: 8, // ± random speed wobble per tick
  jitterM: 3, // max GPS drift radius in metres (0 disables)
  jitterWhenIdle: true,
  accuracyM: 5, // reported horizontal accuracy
  loopMode: 'circuit',
  autoMarkOnTeleport: true, // treat a teleport as an in-game action for cooldown purposes
  cooldownTable: DEFAULT_COOLDOWN_TABLE,
};

/**
 * Movement state machine. Emits:
 *   'location' {lat,lng,speed(m/s),bearing,accuracy}  — each tick, the fix sent to the phone
 *   'state'    full UI snapshot                         — each tick and on every change
 */
export class Engine extends EventEmitter {
  constructor({ tickMs = 1000, start = { lat: 35.658581, lng: 139.745433 }, rng = Math.random } = {}) {
    super();
    this.tickMs = tickMs;
    this.rng = rng;
    this.settings = { ...DEFAULT_SETTINGS };
    this.position = { ...start }; // true (un-jittered) position
    this.output = { ...start }; // last jittered fix
    this.bearing = 0;
    this.currentSpeed = 0; // m/s actually travelled last tick
    this.mode = 'idle'; // idle | route | joystick
    this.route = null; // RoutePlayer
    this.routePoints = [];
    this.routeState = 'stopped'; // stopped | running | paused | finished
    this.joystick = { x: 0, y: 0 };
    this.lastAction = null; // { lat, lng, at }
    this.drift = new Drift({ amplitudeM: this.settings.jitterM, rng });
    this.mocking = true; // false after "restore real GPS"
    this.timer = null;
    this.lastTick = Date.now();
  }

  start() {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- commands ----------

  updateSettings(patch = {}) {
    const s = this.settings;
    if (Number.isFinite(patch.speedKmh)) s.speedKmh = clamp(patch.speedKmh, 0.5, 60);
    if (Number.isFinite(patch.speedVariancePct)) s.speedVariancePct = clamp(patch.speedVariancePct, 0, 50);
    if (Number.isFinite(patch.jitterM)) {
      s.jitterM = clamp(patch.jitterM, 0, 30);
      this.drift.amplitudeM = s.jitterM;
    }
    if (typeof patch.jitterWhenIdle === 'boolean') s.jitterWhenIdle = patch.jitterWhenIdle;
    if (Number.isFinite(patch.accuracyM)) s.accuracyM = clamp(patch.accuracyM, 1, 100);
    if (LOOP_MODES.includes(patch.loopMode)) {
      s.loopMode = patch.loopMode;
      if (this.route) this.rebuildRoute(true);
    }
    if (typeof patch.autoMarkOnTeleport === 'boolean') s.autoMarkOnTeleport = patch.autoMarkOnTeleport;
    if (Array.isArray(patch.cooldownTable)) {
      const rows = patch.cooldownTable
        .map((r) => [Number(r[0]), Number(r[1])])
        .filter(([d, m]) => d > 0 && m >= 0);
      if (rows.length) s.cooldownTable = rows.sort((a, b) => a[0] - b[0]);
    }
    this.emitState();
  }

  /** Returns cooldown info for jumping to `target` from the last recorded action. */
  cooldownFor(target, now = Date.now()) {
    if (!this.lastAction || !isValidLatLng(target)) {
      return { km: 0, requiredMin: 0, elapsedMin: 0, remainingSec: 0, from: null };
    }
    const km = distance(this.lastAction, target) / 1000;
    const requiredMin = cooldownMinutes(km, this.settings.cooldownTable);
    const elapsedMin = (now - this.lastAction.at) / 60000;
    const remainingSec = Math.max(0, Math.ceil((requiredMin - elapsedMin) * 60));
    return { km, requiredMin, elapsedMin, remainingSec, from: this.lastAction };
  }

  teleport(target, { force = false } = {}) {
    if (!isValidLatLng(target)) return { ok: false, error: 'invalid coordinates' };
    const cd = this.cooldownFor(target);
    if (cd.remainingSec > 0 && !force) {
      return { ok: false, needsConfirm: true, cooldown: cd };
    }
    this.pauseRoute();
    this.position = { lat: target.lat, lng: target.lng };
    this.output = { ...this.position };
    this.currentSpeed = 0;
    this.mocking = true;
    if (this.settings.autoMarkOnTeleport) this.markAction();
    this.pushFix();
    this.emitState();
    return { ok: true, cooldown: cd };
  }

  markAction(at = Date.now()) {
    this.lastAction = { lat: this.position.lat, lng: this.position.lng, at };
    this.emitState();
  }

  clearAction() {
    this.lastAction = null;
    this.emitState();
  }

  setRoute(points) {
    const clean = (points || []).filter(isValidLatLng).map((p) => ({ lat: p.lat, lng: p.lng }));
    if (clean.length < 2) return { ok: false, error: '路線至少需要 2 個點' };
    this.routePoints = clean;
    try {
      this.rebuildRoute(false);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    this.routeState = 'stopped';
    this.emit('route', this.routePoints);
    this.emitState();
    return { ok: true, lengthM: this.route.length };
  }

  rebuildRoute(keepProgress) {
    const prev = this.route;
    this.route = new RoutePlayer(this.routePoints, this.settings.loopMode);
    if (keepProgress && prev) {
      this.route.s = Math.min(prev.s, this.route.length);
      this.route.dir = prev.dir;
      this.route.lap = prev.lap;
    }
  }

  clearRoute() {
    this.route = null;
    this.routePoints = [];
    this.routeState = 'stopped';
    if (this.mode === 'route') this.mode = 'idle';
    this.emit('route', []);
    this.emitState();
  }

  /**
   * Start or resume route playback. If the phone is far from the route start,
   * the caller must confirm a teleport to the start (cooldown check applies).
   */
  startRoute({ teleportToStart = false, force = false } = {}) {
    if (!this.route) return { ok: false, error: '尚未設定路線' };
    if (this.routeState === 'finished') {
      this.route.s = 0;
      this.route.dir = 1;
      this.route.finished = false;
    }
    if (this.routeState === 'stopped' || this.routeState === 'finished') {
      const startPt = this.route.position;
      const gap = distance(this.position, startPt);
      if (gap > 30) {
        if (!teleportToStart) return { ok: false, needsTeleport: true, gapM: gap, cooldown: this.cooldownFor(startPt) };
        const r = this.teleport(startPt, { force });
        if (!r.ok) return r;
      }
    }
    this.routeState = 'running';
    this.mode = 'route';
    this.mocking = true;
    this.emitState();
    return { ok: true };
  }

  pauseRoute() {
    if (this.routeState === 'running') this.routeState = 'paused';
    if (this.mode === 'route') this.mode = 'idle';
    this.emitState();
  }

  stopRoute() {
    if (this.route) {
      this.route.s = 0;
      this.route.dir = 1;
      this.route.finished = false;
      this.route.lap = 0;
    }
    this.routeState = 'stopped';
    if (this.mode === 'route') this.mode = 'idle';
    this.emitState();
  }

  setJoystick(x, y) {
    const nx = clamp(Number(x) || 0, -1, 1);
    const ny = clamp(Number(y) || 0, -1, 1);
    const mag = Math.hypot(nx, ny);
    this.joystick = mag > 1 ? { x: nx / mag, y: ny / mag } : { x: nx, y: ny };
    if (mag > 0.05) {
      if (this.routeState === 'running') this.routeState = 'paused';
      this.mode = 'joystick';
      this.mocking = true;
    } else if (this.mode === 'joystick') {
      this.mode = 'idle';
    }
  }

  stopMocking() {
    this.pauseRoute();
    this.mocking = false;
    this.emit('stopMocking');
    this.emitState();
  }

  // ---------- simulation ----------

  tick(now = Date.now()) {
    const dt = Math.min(5, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    const s = this.settings;
    const wobble = 1 + (s.speedVariancePct / 100) * clamp(gaussian(this.rng) / 2, -1, 1);
    const baseMs = s.speedKmh * KMH_TO_MS * wobble;
    let moved = 0;

    const jmag = Math.hypot(this.joystick.x, this.joystick.y);
    if (this.mode === 'joystick' && jmag > 0.05) {
      // x = east, y = north
      const brg = (Math.atan2(this.joystick.x, this.joystick.y) * 180) / Math.PI;
      moved = baseMs * jmag * dt;
      this.position = destination(this.position, (brg + 360) % 360, moved);
      this.bearing = (brg + 360) % 360;
    } else if (this.mode === 'route' && this.routeState === 'running' && this.route) {
      moved = baseMs * dt;
      const p = this.route.advance(moved);
      this.position = { lat: p.lat, lng: p.lng };
      this.bearing = p.bearing;
      if (this.route.finished) {
        this.routeState = 'finished';
        this.mode = 'idle';
      }
    }
    this.currentSpeed = dt > 0 ? moved / dt : 0;

    const moving = moved > 0;
    this.output = moving || s.jitterWhenIdle ? this.drift.apply(this.position) : { ...this.position };
    if (this.mocking) this.pushFix();
    this.emitState();
  }

  pushFix() {
    const acc = this.settings.accuracyM * (0.8 + this.rng() * 0.4);
    this.emit('location', {
      lat: this.output.lat,
      lng: this.output.lng,
      speed: this.currentSpeed,
      bearing: this.bearing,
      accuracy: acc,
    });
  }

  snapshot() {
    return {
      position: this.position,
      output: this.output,
      bearing: this.bearing,
      speedKmh: this.currentSpeed / KMH_TO_MS,
      mode: this.mode,
      mocking: this.mocking,
      settings: this.settings,
      route: this.route
        ? {
            lengthM: this.route.length,
            progress: this.route.progress,
            lap: this.route.lap,
            travelledM: this.route.travelled,
            state: this.routeState,
            mode: this.route.mode,
          }
        : null,
      lastAction: this.lastAction,
      tickMs: this.tickMs,
    };
  }

  emitState() {
    this.emit('state', this.snapshot());
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
