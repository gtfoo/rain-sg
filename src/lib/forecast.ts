/**
 * Rain probability for a point in Singapore, 15 minutes to 2 hours ahead.
 *
 * The model is eight logistic regressions — one per lead — with Platt
 * calibration applied per lead AND per island-wetness band. Inference is a few
 * hundred multiplications; the whole model is a ~10 KB JSON file.
 *
 * Feature construction here must match the training pipeline exactly. Where a
 * choice looks arbitrary it is usually load-bearing; see AGENTS.md.
 */

export interface Station {
  id: string;
  name: string;
  lon: number;
  lat: number;
}

/** One 15-minute window of observations across the whole network. */
export interface Window {
  /** wet = 1, dry = 0, not reported = null. Missing is NOT dry — see AGENTS.md. */
  wet: Map<string, 0 | 1>;
  /** millimetres in the window. Intensity carries the growth/decay signal. */
  mm: Map<string, number>;
}

export interface WindVector {
  /** eastward component of travel, knots */
  u: number;
  /** northward component of travel, knots */
  v: number;
}

export interface AreaForecast {
  /** NEA code, e.g. "TL" for Thundery Showers */
  code: string;
  /** windows elapsed since the forecast's valid_period_start; may be negative */
  since: number;
}

export interface PlattParams { a: number; b: number }

export interface Model {
  cols: number[];
  weights: number[][];
  platt: Array<{ global: PlattParams; bands: PlattParams[] }>;
  clim: { ph: number[]; pm: number[]; p: number };
  codeProb: Record<string, number[]>;
  pGlobal: number;
  nlead: number;
  nf: number;
}

const NF_MAX = 27;

export function kmBetween(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const dx = (a.lon - b.lon) * 111.3 * Math.cos((a.lat * Math.PI) / 180);
  const dy = (a.lat - b.lat) * 110.6;
  return Math.hypot(dx, dy);
}

const logOdds = (p: number) => {
  const q = Math.max(1e-4, Math.min(0.9999, p));
  return Math.log(q / (1 - q));
};
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Island-wetness band. Calibration differs sharply between these. */
export const bandOf = (islandWet: number) => (islandWet < 0.02 ? 0 : islandWet < 0.2 ? 1 : 2);

/**
 * NEA's categorical forecast as a probability, for a target `lead` windows out.
 *
 * The bin is `since + 1 + lead`, and the table is fitted across all eight
 * offsets — fitting it only on the observed window leaves bins 3-7 empty and
 * inference silently reads the global base rate instead.
 */
export function neaProbability(model: Model, fc: AreaForecast | null, lead: number): number {
  if (!fc) return model.pGlobal;
  const table = model.codeProb[fc.code];
  if (!table) return model.pGlobal;
  const bin = Math.max(0, Math.min(model.nlead - 1, fc.since + 1 + lead));
  return table[bin];
}

export interface FeatureInputs {
  station: Station;
  /** most recent window first: [now, -15, -30, -45, ...] */
  history: Window[];
  wind: WindVector | null;
  /** wet fraction across all reporting stations, [now, -15, -30] */
  islandWet: number[];
  /** mean millimetres across all reporting stations, [now, -15, -30] */
  islandMm: number[];
  neighbours: { within5: Station[]; within15: Station[]; within20: Station[] };
  forecast: AreaForecast | null;
  /** SGT hour and zero-based month at issue time */
  hour: number;
  month: number;
}

/** Build the feature vector. Index positions are fixed by the trained model. */
export function buildFeatures(model: Model, inp: FeatureInputs, lead: number): Float64Array | null {
  const { station, history, wind, islandWet, islandMm, neighbours } = inp;
  const now = history[0];
  if (!now) return null;

  const wetHere = now.wet.get(station.id);
  if (wetHere === undefined) return null; // station not reporting: no forecast

  const islN = islandWet[0];
  if (!Number.isFinite(islN)) return null;

  const x = new Float64Array(NF_MAX);
  const lagWet = (k: number) => history[k]?.wet.get(station.id) ?? 0;

  x[0] = wetHere;
  x[1] = lagWet(1);
  x[2] = lagWet(2);
  x[3] = lagWet(3);

  const fracWet = (list: Station[]) => {
    let n = 0, k = 0;
    for (const s of list) {
      const v = now.wet.get(s.id);
      if (v === undefined) continue;
      n++; k += v;
    }
    return n ? k / n : NaN;
  };
  const f5 = fracWet(neighbours.within5);
  const f15 = fracWet(neighbours.within15);
  x[4] = Number.isFinite(f5) ? f5 : islN;
  x[5] = Number.isFinite(f15) ? f15 : islN;
  x[6] = islN;
  x[7] = Number.isFinite(islandWet[2]) ? islandWet[2] : islN;

  x[8] = logOdds(model.clim.ph[inp.hour]);
  x[9] = logOdds(model.clim.pm[inp.month]);
  x[13] = logOdds(neaProbability(model, inp.forecast, lead));

  const u = wind?.u ?? 0;
  const v = wind?.v ?? 0;
  const speed = Math.hypot(u, v);
  x[14] = u / 5;
  x[15] = v / 5;
  x[16] = speed / 5;

  // Upwind vs downwind. Rain to the west only matters if the flow carries it
  // toward you — upwind versus downwind separates the base rate 5.6x.
  let upN = 0, upK = 0, upMm = 0, upMmN = 0, downN = 0, downK = 0;
  if (speed > 0.01) {
    const ux = u / speed, uy = v / speed;
    for (const nb of neighbours.within20) {
      const d = kmBetween(station, nb);
      if (d === 0) continue;
      const dx = ((nb.lon - station.lon) * 111.3 * Math.cos((station.lat * Math.PI) / 180)) / d;
      const dy = ((nb.lat - station.lat) * 110.6) / d;
      const wetNb = now.wet.get(nb.id);
      if (wetNb === undefined) continue;
      if (dx * ux + dy * uy < 0) {
        upN++; upK += wetNb;
        const mm = now.mm.get(nb.id);
        if (mm !== undefined) { upMm += mm; upMmN++; }
      } else {
        downN++; downK += wetNb;
      }
    }
  }
  x[17] = upN ? upK / upN : islN;
  x[20] = downN ? downK / downN : islN;

  // Intensity. A cell fading 8 -> 4 -> 2 mm/h is dying; 2 -> 5 -> 9 is growing.
  // Binarised they are identical, and decay dominates the error at long lead.
  const mmNow = now.mm.get(station.id);
  const mmPrev = history[3]?.mm.get(station.id);
  x[23] = mmNow !== undefined ? Math.log1p(mmNow * 4) / 2 : 0;
  x[24] = mmNow !== undefined && mmPrev !== undefined
    ? Math.max(-2, Math.min(2, (mmNow - mmPrev) * 2))
    : 0;
  x[25] = upMmN ? Math.log1p((upMm / upMmN) * 4) / 2 : 0;
  x[26] = Number.isFinite(islandMm[0]) && Number.isFinite(islandMm[2])
    ? Math.max(-2, Math.min(2, (islandMm[0] - islandMm[2]) * 8))
    : 0;

  return x;
}

/** Calibrated probability of rain in the window `lead` steps ahead. */
export function predict(model: Model, x: Float64Array, lead: number): number {
  const cols = model.cols;
  const w = model.weights[lead];
  let z = w[cols.length];
  for (let j = 0; j < cols.length; j++) z += w[j] * x[cols[j]];

  const cal = model.platt[lead];
  const pl = cal.bands ? cal.bands[bandOf(x[6])] : cal.global;
  return sigmoid(pl.a * z + pl.b);
}

/**
 * Forecast for an arbitrary point — a OneMap search result, say.
 *
 * We run the model at the nearest gauges, where every feature is genuinely
 * observed, and distance-weight the resulting probabilities. Interpolating the
 * *features* instead would feed the model values it never saw in training
 * (a binary "wet here" becomes 0.37), which is a silent distribution shift.
 *
 * The spread between neighbours is a free uncertainty estimate: where they
 * disagree, the local field is genuinely ambiguous and the UI should say so.
 */
export interface PointForecast {
  /** probability per lead, 15..120 min */
  p: number[];
  /** low/high across contributing gauges, per lead */
  spread: Array<{ lo: number; hi: number }>;
  /** how far the nearest gauge is — the CBD is ~2.8 km from one */
  nearestKm: number;
  contributors: Array<{ station: Station; km: number }>;
}

export function forecastAtPoint(
  model: Model,
  point: { lon: number; lat: number },
  featuresFor: (s: Station, lead: number) => Float64Array | null,
  stations: Station[],
  k = 4,
): PointForecast | null {
  const ranked = stations
    .map((s) => ({ station: s, km: kmBetween(point, s) }))
    .sort((a, b) => a.km - b.km)
    // Rank among gauges that are actually REPORTING, not merely nearby. Taking
    // the k nearest and then discarding the silent ones refuses a forecast for
    // a point whose four closest gauges happen to be quiet, even with a working
    // one just past them — measured at 24 of 36 probe points across the island
    // after a poll stored a partial slot. Distance still decides the order; a
    // silent gauge simply does not get a vote.
    .filter((r) => featuresFor(r.station, 0) !== null)
    .slice(0, k);
  if (!ranked.length) return null;

  const p: number[] = [];
  const spread: Array<{ lo: number; hi: number }> = [];
  const contributors: Array<{ station: Station; km: number }> = [];

  for (let lead = 0; lead < model.nlead; lead++) {
    let num = 0, den = 0, lo = 1, hi = 0;
    for (const r of ranked) {
      const x = featuresFor(r.station, lead);
      if (!x) continue;
      const pr = predict(model, x, lead);
      const w = 1 / Math.max(0.5, r.km) ** 2; // inverse distance squared
      num += pr * w;
      den += w;
      lo = Math.min(lo, pr);
      hi = Math.max(hi, pr);
      if (lead === 0) contributors.push(r);
    }
    if (!den) return null;
    p.push(num / den);
    spread.push({ lo, hi });
  }
  return { p, spread, nearestKm: ranked[0].km, contributors };
}
