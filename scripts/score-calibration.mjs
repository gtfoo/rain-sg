/**
 * Does the headline mean what it says, measured on what was actually served?
 *
 * The reliability diagram that set the "estimates uncalibrated" label was built
 * by replaying the model over a held-out period. This scores the verification
 * log instead — the forecasts the running app recorded at the time — against
 * the rain that followed. It is the only check that uses a period which did not
 * exist when the cumulative table was fitted, which is the whole point: that
 * table was fitted on 2025 and every other check has reused 2025 or 2026.
 *
 * Scored at every gauge rather than at one address, because the log holds all 88
 * and a single point would throw away most of the sample.
 *
 *   DATA_DIR=/home/deploy/rain-sg-data node scripts/score-calibration.mjs
 *   DATA_DIR=... node scripts/score-calibration.mjs --from 2026-09-10
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DATA = process.env.DATA_DIR;
if (!DATA) { console.error("DATA_DIR is required"); process.exit(1); }
const FROM = arg("from", "0000-00-00");
const TO = arg("to", "9999-99-99");

const model = JSON.parse(fs.readFileSync(new URL("../src/model/model.json", import.meta.url)));
// --cum swaps in a candidate table so a refit can be scored against the
// shipped one on the same rows. Without it this scores what is live.
const altCum = arg("cum", null);
if (altCum) model.cum = JSON.parse(fs.readFileSync(altCum, "utf8"));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logOdds = (p) => { const q = Math.max(1e-4, Math.min(0.9999, p)); return Math.log(q / (1 - q)); };
const cumulative = (p) => {
  const out = []; let survive = 1;
  for (let l = 0; l < p.length; l++) {
    survive *= 1 - p[l];
    const c = model.cum?.[l];
    out.push(c ? sigmoid(c.a * logOdds(1 - survive) + c.b) : Math.max(...p.slice(0, l + 1)));
  }
  return out;
};

// ------------------------------------------------------------ what fell
// day -> slot -> stationId -> 0|1.  A window is wet if ANY reading in it was;
// a station absent from a window is unknown, never dry.
const RAW = path.join(DATA, "raw");
const obs = new Map();
for (const f of fs.readdirSync(RAW)) {
  const m = f.match(/^rainfall_(\d{4}-\d{2}-\d{2})T(\d{4})\.json\.gz$/);
  if (!m || m[1] < FROM || m[1] > TO) continue;
  let pages;
  try { pages = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW, f)))); } catch { continue; }
  const key = `${m[1]}T${m[2]}`;
  const w = obs.get(key) ?? new Map();
  for (const p of pages)
    for (const r of p.readings ?? [])
      for (const d of r.data) w.set(d.stationId, (w.get(d.stationId) ?? 0) || (d.value > 0 ? 1 : 0));
  obs.set(key, w);
}

const shift = (key, mins) => {
  const [day, hhmm] = key.split("T");
  const t = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10),
                     +hhmm.slice(0, 2), +hhmm.slice(2)) + mins * 60_000;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
};

// ------------------------------------------------------ what was served
const VDIR = path.join(DATA, "verification");
const rows = new Map();          // `${issued}|${station}` -> {p, seq}
let lines = 0;
for (const f of fs.readdirSync(VDIR).sort()) {
  const day = f.replace(".jsonl", "");
  if (day < FROM || day > TO) continue;
  for (const line of fs.readFileSync(path.join(VDIR, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    lines++;
    const r = JSON.parse(line);
    const key = `${r.issued}|${r.stationId}`;
    const seq = r.seq ?? 0;
    // A slot is written once per reading as it fills; keep the fullest.
    const prev = rows.get(key);
    if (prev && prev.seq >= seq) continue;
    rows.set(key, { p: r.p, seq });
  }
}

// ---------------------------------------------------------------- score
const EDGES = [0, 0.01, 0.02, 0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 1.01];
const mk = () => EDGES.slice(0, -1).map(() => ({ n: 0, p: 0, y: 0 }));
const hour = mk(), at15 = mk();
const put = (bins, p, y) => {
  let i = EDGES.findIndex((e, k) => p >= e && p < EDGES[k + 1]);
  if (i < 0) i = EDGES.length - 2;
  const b = bins[i]; b.n++; b.p += p; b.y += y;
};
let skippedWet = 0, skippedUnknown = 0;

for (const [key, row] of rows) {
  const [issued, station] = key.split("|");
  const now = obs.get(issued)?.get(station);
  if (now === undefined) { skippedUnknown++; continue; }
  // The cumulative table answers "chance of rain when you are currently dry",
  // and was fitted that way; scoring it from a wet start would measure a
  // different question.
  if (now === 1) { skippedWet++; continue; }

  const p = row.p.map((v) => v / 10000);
  const cum = cumulative(p);

  // within the hour: any of the next four windows wet
  let anyWet = 0, complete = true;
  for (let l = 0; l < 4; l++) {
    const y = obs.get(shift(issued, 15 * (l + 1)))?.get(station);
    if (y === undefined) { complete = false; break; }
    if (y === 1) anyWet = 1;
  }
  if (complete) put(hour, cum[3], anyWet);

  const y15 = obs.get(shift(issued, 15))?.get(station);
  if (y15 !== undefined) put(at15, p[0], y15);
}

const show = (name, bins) => {
  const tot = bins.reduce((s, b) => s + b.n, 0);
  let ece = 0;
  console.log(`\n${name}   n=${tot.toLocaleString()}`);
  console.log("  predicted band        n     mean predicted    observed      gap");
  for (let i = 0; i < bins.length; i++) {
    const b = bins[i];
    if (!b.n) continue;
    const mp = b.p / b.n, my = b.y / b.n;
    ece += (b.n / tot) * Math.abs(mp - my);
    const flag = b.n >= 200 && Math.abs(mp - my) > 0.05 ? "  <—" : "";
    console.log(`  ${(100*EDGES[i]).toFixed(0).padStart(3)}-${(100*EDGES[i+1]).toFixed(0).padStart(3)}%  ${String(b.n).padStart(9)}      ` +
      `${(100*mp).toFixed(1).padStart(6)}%     ${(100*my).toFixed(1).padStart(6)}%   ${(100*(mp-my)).toFixed(1).padStart(6)}${flag}`);
  }
  console.log(`  expected calibration error ${(100*ece).toFixed(2)} pts`);
};

console.log(`PRODUCTION CALIBRATION — verification log, ${FROM} to ${TO}`  + (altCum ? `   [candidate table: ${altCum.split("/").pop()}]` : "   [shipped table]"));
console.log(`${lines.toLocaleString()} rows, ${rows.size.toLocaleString()} station-slots after dedupe`);
console.log(`(${skippedWet.toLocaleString()} skipped as already raining, ${skippedUnknown.toLocaleString()} as not reporting)`);
show("THE HEADLINE: chance of any rain within the hour", hour);
show("For comparison, the +15 min bar", at15);
