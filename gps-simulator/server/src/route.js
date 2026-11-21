import { distance, bearing, lerp, isValidLatLng } from './geo.js';

export const LOOP_MODES = ['once', 'pingpong', 'circuit'];

/**
 * Plays back a polyline at a given distance step.
 * Position is tracked as arc length `s` along the path plus a direction (+1 / -1).
 */
export class RoutePlayer {
  constructor(points, mode = 'once') {
    if (!LOOP_MODES.includes(mode)) throw new Error(`unknown loop mode: ${mode}`);
    const pts = (points || []).filter(isValidLatLng).map((p) => ({ lat: p.lat, lng: p.lng }));
    // Drop consecutive duplicates (zero-length segments).
    const clean = [];
    for (const p of pts) {
      const prev = clean[clean.length - 1];
      if (!prev || distance(prev, p) > 0.01) clean.push(p);
    }
    if (clean.length < 2) throw new Error('route needs at least 2 distinct points');
    if (mode === 'circuit' && distance(clean[0], clean[clean.length - 1]) > 0.5) {
      clean.push({ ...clean[0] });
    }
    this.points = clean;
    this.mode = mode;
    this.cum = [0];
    for (let i = 1; i < clean.length; i++) {
      this.cum.push(this.cum[i - 1] + distance(clean[i - 1], clean[i]));
    }
    this.length = this.cum[this.cum.length - 1];
    this.s = 0;
    this.dir = 1;
    this.lap = 0;
    this.finished = false;
    this.travelled = 0;
  }

  segmentIndex(s) {
    // Binary search for the segment containing s.
    let lo = 0;
    let hi = this.cum.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  pointAt(s) {
    const clamped = Math.max(0, Math.min(this.length, s));
    const i = this.segmentIndex(clamped);
    const a = this.points[i];
    const b = this.points[i + 1];
    const segLen = this.cum[i + 1] - this.cum[i];
    const t = segLen > 0 ? (clamped - this.cum[i]) / segLen : 0;
    const brg = this.dir > 0 ? bearing(a, b) : bearing(b, a);
    return { ...lerp(a, b, t), bearing: brg };
  }

  get position() {
    return this.pointAt(this.s);
  }

  get progress() {
    return this.length > 0 ? this.s / this.length : 0;
  }

  /** Move `d` metres along the route according to the loop mode. */
  advance(d) {
    if (this.finished || !(d > 0)) return this.position;
    this.travelled += d;
    let remaining = d;
    // Loop handles multiple wraps when d > length (e.g. tiny circuit + big tick).
    while (remaining > 0 && !this.finished) {
      const target = this.s + this.dir * remaining;
      if (target >= 0 && target <= this.length) {
        this.s = target;
        remaining = 0;
      } else if (this.mode === 'once') {
        this.s = this.dir > 0 ? this.length : 0;
        this.finished = true;
        remaining = 0;
      } else if (this.mode === 'pingpong') {
        if (target > this.length) {
          remaining = target - this.length;
          this.s = this.length;
          this.dir = -1;
        } else {
          remaining = -target;
          this.s = 0;
          this.dir = 1;
          this.lap++;
        }
      } else {
        // circuit
        remaining = target - this.length;
        this.s = 0;
        this.lap++;
      }
    }
    return this.position;
  }
}
