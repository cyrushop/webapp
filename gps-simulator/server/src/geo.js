// Pure geodesy helpers. All distances in metres, angles in degrees.

export const EARTH_RADIUS_M = 6371008.8;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function isValidLatLng(p) {
  return (
    p != null &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

export function normalizeLng(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Great-circle distance (haversine). */
export function distance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, 0..360 (0 = north, 90 = east). */
export function bearing(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached travelling `dist` metres from p on `brg` degrees. */
export function destination(p, brg, dist) {
  const δ = dist / EARTH_RADIUS_M;
  const θ = toRad(brg);
  const φ1 = toRad(p.lat);
  const λ1 = toRad(p.lng);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lng: normalizeLng(toDeg(λ2)) };
}

/** Linear interpolation between two close points (fine for segments < a few km). */
export function lerp(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Shift a point by east/north metres (local tangent plane approximation). */
export function offsetMeters(p, eastM, northM) {
  const dLat = northM / EARTH_RADIUS_M;
  const dLng = eastM / (EARTH_RADIUS_M * Math.cos(toRad(p.lat)));
  return { lat: p.lat + toDeg(dLat), lng: normalizeLng(p.lng + toDeg(dLng)) };
}

/** Standard normal sample (Box–Muller). */
export function gaussian(rng = Math.random) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Smooth, bounded GPS drift. A mean-reverting random walk (Ornstein–Uhlenbeck style)
 * so consecutive fixes wander slightly instead of jumping randomly each tick.
 */
export class Drift {
  constructor({ amplitudeM = 3, reversion = 0.25, rng = Math.random } = {}) {
    this.amplitudeM = amplitudeM;
    this.reversion = reversion;
    this.rng = rng;
    this.e = 0;
    this.n = 0;
  }

  step() {
    if (this.amplitudeM <= 0) {
      this.e = 0;
      this.n = 0;
      return { east: 0, north: 0 };
    }
    const sigma = this.amplitudeM * 0.35;
    this.e += -this.reversion * this.e + sigma * gaussian(this.rng);
    this.n += -this.reversion * this.n + sigma * gaussian(this.rng);
    const mag = Math.hypot(this.e, this.n);
    if (mag > this.amplitudeM) {
      this.e *= this.amplitudeM / mag;
      this.n *= this.amplitudeM / mag;
    }
    return { east: this.e, north: this.n };
  }

  apply(p) {
    const { east, north } = this.step();
    return offsetMeters(p, east, north);
  }
}

/**
 * Community-circulated cooldown table (distance km -> wait minutes).
 * Originates from Pokémon GO player testing; NOT an official Niantic/Scopely figure,
 * and not verified for Pikmin Bloom. Kept editable from the UI for that reason.
 */
export const DEFAULT_COOLDOWN_TABLE = [
  [1, 0.5],
  [2, 1],
  [4, 2],
  [10, 8],
  [12, 9],
  [15, 11],
  [20, 13],
  [25, 15],
  [30, 18],
  [40, 22],
  [45, 23],
  [60, 25],
  [80, 27],
  [100, 30],
  [125, 33],
  [150, 36],
  [180, 39],
  [200, 42],
  [300, 50],
  [350, 53],
  [400, 56],
  [500, 64],
  [600, 72],
  [700, 80],
  [800, 86],
  [1000, 100],
  [1250, 118],
  [1266, 120],
];

/** Minutes to wait for a jump of `km`, using the first table row whose distance >= km. */
export function cooldownMinutes(km, table = DEFAULT_COOLDOWN_TABLE) {
  if (!(km > 0)) return 0;
  const rows = [...table].sort((a, b) => a[0] - b[0]);
  for (const [d, m] of rows) if (km <= d) return m;
  return rows.length ? rows[rows.length - 1][1] : 0;
}
