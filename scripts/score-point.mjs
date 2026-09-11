/**
 * Score what the app actually served at a point, against what fell.
 *
 * Reads the verification log — the forecasts the poller recorded at the time —
 * and joins them to the stored rainfall. So this is not a replay: it is the
 * numbers a person standing there would have been shown.
 *
 * Station probabilities are blended exactly as forecastAtPoint does (four
 * nearest REPORTING gauges, inverse distance squared), because a different
 * blend here would score a forecast nobody saw.
 *
 *   DATA_DIR=/home/deploy/rain-sg-data node scripts/score-point.mjs \
 *     --day 2026-09-11 --lat 1.303446 --lon 103.789068 --name "one-north Eden"
 *
 * Defaults to today in SGT and to one-north Eden.
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

const sgtToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const DAY = arg("day", sgtToday);
const LAT = Number(arg("lat", 1.303446));
const LON = Number(arg("lon", 103.789068));
const NAME = arg("name", "one-north Eden");
const LEAD_MIN = [15, 30, 45, 60, 75, 90, 105, 120];

const model = JSON.parse(fs.readFileSync(new URL("../src/model/model.json", import.meta.url)));
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
const kmBetween = (a, b) =>
  Math.hypot((a.lat - b.lat) * 110.6, (a.lon - b.lon) * 111.3 * Math.cos((a.lat * Math.PI) / 180));

// ------------------------------------------------------------- what fell
const RAW = path.join(DATA, "raw");
const stations = new Map();
const obs = new Map();                       // slot -> stationId -> {wet, mm}
for (const f of fs.readdirSync(RAW).filter((x) => x.startsWith(`rainfall_${DAY}T`))) {
  const slot = f.slice(`rainfall_${DAY}T`.length, -".json.gz".length);
  let pages;
  try { pages = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW, f)))); } catch { continue; }
  const m = obs.get(slot) ?? new Map();
  for (const p of pages) {
    for (const s of p.stations ?? [])
      stations.set(s.id, { id: s.id, name: s.name, lat: s.location.latitude, lon: s.location.longitude });
    // A window is wet if ANY reading in it was, and millimetres accumulate —
    // the same convention the model was trained on.
    for (const r of p.readings ?? [])
      for (const d of r.data) {
        const c = m.get(d.stationId) ?? { wet: 0, mm: 0 };
        c.mm += d.value; if (d.value > 0) c.wet = 1;
        m.set(d.stationId, c);
      }
  }
  obs.set(slot, m);
}
if (!stations.size) { console.error(`no rainfall stored for ${DAY} under ${RAW}`); process.exit(1); }

const ranked = [...stations.values()]
  .map((s) => ({ s, km: kmBetween({ lat: LAT, lon: LON }, s) }))
  .sort((a, b) => a.km - b.km);

// ------------------------------------------------------ what we served
const vf = path.join(DATA, "verification", `${DAY}.jsonl`);
if (!fs.existsSync(vf)) { console.error(`no verification log at ${vf}`); process.exit(1); }
// A slot is written once per reading as it fills, so the log holds up to three
// rows per station per slot. Keep the highest seq — the forecast made with the
// most complete window, which is the one most visitors were actually shown.
// Counting every row would triple each window.
const byIssue = new Map();
const seqSeen = new Map();
for (const line of fs.readFileSync(vf, "utf8").trim().split("\n")) {
  if (!line) continue;
  const r = JSON.parse(line);
  const slot = r.issued.slice(11);
  const key = `${slot}|${r.stationId}`;
  const seq = r.seq ?? 0;
  if (seqSeen.has(key) && seqSeen.get(key) >= seq) continue;
  seqSeen.set(key, seq);
  const m = byIssue.get(slot) ?? new Map();
  m.set(r.stationId, r.p);
  byIssue.set(slot, m);
}

const served = new Map();
for (const [slot, m] of byIssue) {
  const use = ranked.filter((r) => m.has(r.s.id)).slice(0, 4);
  if (!use.length) continue;
  const p = [];
  for (let l = 0; l < model.nlead; l++) {
    let num = 0, den = 0;
    for (const r of use) {
      const w = 1 / Math.max(0.5, r.km) ** 2;
      num += (m.get(r.s.id)[l] / 10000) * w;
      den += w;
    }
    p.push(num / den);
  }
  served.set(slot, { p, cum: cumulative(p), nearest: use[0].km });
}

const truthAt = (slot) => {
  const m = obs.get(slot);
  if (!m) return null;
  for (const r of ranked) { const v = m.get(r.s.id); if (v) return v; }
  return null;
};
const shift = (slot, mins) => {
  const t = +slot.slice(0, 2) * 60 + +slot.slice(2) + mins;
  return String(Math.floor(t / 60) % 24).padStart(2, "0") + String(((t % 60) + 60) % 60).padStart(2, "0");
};

const slots = [...served.keys()].sort();
console.log(`${NAME}  (${LAT}, ${LON})   ${DAY}`);
console.log(`nearest gauge: ${ranked[0].s.name}, ${ranked[0].km.toFixed(2)} km\n`);

// --------------------------------------------------------------- timeline
console.log("  issued   +15min   within 1hr   next window        mm");
let firstWet = null, lastWet = null;
for (const slot of slots) {
  const now = truthAt(slot);
  if (now?.wet) { if (!firstWet) firstWet = slot; lastWet = slot; }
  const nxt = truthAt(shift(slot, 15));
  if (!nxt) continue;
  const s = served.get(slot);
  console.log(`  ${slot.slice(0,2)}:${slot.slice(2)}   ${(100*s.p[0]).toFixed(0).padStart(5)}%   ` +
    `${(100*s.cum[3]).toFixed(0).padStart(9)}%   ${nxt.wet ? "RAIN" : "dry "}   ` +
    `${nxt.mm ? nxt.mm.toFixed(1).padStart(8) : "       -"}`);
}

// ------------------------------------------------------------------ onset
if (firstWet) {
  console.log(`\nRain began ${firstWet.slice(0,2)}:${firstWet.slice(2)}, last seen ${lastWet.slice(0,2)}:${lastWet.slice(2)}`);
  console.log("Warning before it began:");
  for (const back of [15, 30, 45, 60, 90, 120]) {
    const s = served.get(shift(firstWet, -back));
    if (!s) continue;
    console.log(`  ${String(back).padStart(3)} min before   +15min ${(100*s.p[0]).toFixed(0).padStart(3)}%   ` +
      `within the hour ${(100*s.cum[3]).toFixed(0).padStart(3)}%   within two ${(100*s.cum[7]).toFixed(0).padStart(3)}%`);
  }
}

// ----------------------------------------------------------------- scoring
let n = 0, ours = 0, none = 0, persist = 0;
let dryN = 0, dryOurs = 0, dryNone = 0, wetN = 0, wetOurs = 0, wetKeeps = 0;
for (const slot of slots) {
  const now = truthAt(slot);
  if (!now) continue;
  const s = served.get(slot);
  for (let l = 0; l < model.nlead; l++) {
    const t = truthAt(shift(slot, 15 * (l + 1)));
    if (!t) continue;
    const y = t.wet;
    n++; ours += (s.p[l] - y) ** 2; none += y; persist += (now.wet - y) ** 2;
    if (now.wet) { wetN++; wetOurs += (s.p[l] - y) ** 2; wetKeeps += (1 - y) ** 2; }
    else { dryN++; dryOurs += (s.p[l] - y) ** 2; dryNone += y; }
  }
}
const pct = (a, b) => (b === 0 ? "n/a" : `${(100 * (1 - a / b)).toFixed(1)}%`);
console.log(`\nBrier, all leads, n=${n}   (wet outcome rate ${(100*none/Math.max(1,n)).toFixed(1)}%)`);
console.log(`  ours              ${(ours/n).toFixed(4)}`);
console.log(`  always "no rain"  ${(none/n).toFixed(4)}   ours ${pct(ours, none)} better`);
console.log(`  persistence       ${(persist/n).toFixed(4)}   ours ${pct(ours, persist)} better`);
if (dryN) console.log(`\n  "will it rain?"      dry now, n=${dryN}   ours ${(dryOurs/dryN).toFixed(4)}   vs no-rain ${pct(dryOurs, dryNone)}`);
if (wetN) console.log(`  "when will it stop?" raining, n=${wetN}   ours ${(wetOurs/wetN).toFixed(4)}   vs "keeps raining" ${pct(wetOurs, wetKeeps)}`);
