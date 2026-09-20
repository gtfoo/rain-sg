/**
 * How did the app do over a stretch of days, across every gauge?
 *
 * Scores the verification log — what the running app recorded at the time —
 * against the rain that followed, and against the three things it has to beat
 * to be worth showing: NEA's own two-hour forecast, assuming it never rains,
 * and assuming the present simply continues.
 *
 * NEA's probability is reconstructed the same way the model consumes it: the
 * forecast in force at the issue slot, ordered by ISSUE time and applied only
 * once issued, with a signed offset. Ordering by valid period instead is
 * lookahead and has broken this three times.
 *
 *   DATA_DIR=/home/deploy/rain-sg-data node scripts/score-days.mjs --days 7
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

const model = JSON.parse(fs.readFileSync(new URL("../src/model/model.json", import.meta.url)));
const NLEAD = model.nlead;
const sgtToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const DAYS = Number(arg("days", 7));
const TO = arg("to", sgtToday);
const FROM = arg("from", new Date(Date.parse(TO + "T00:00:00Z") - (DAYS - 1) * 86_400_000)
  .toISOString().slice(0, 10));

const RAW = path.join(DATA, "raw");
const read = (f) => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW, f)))); } catch { return null; } };
const inRange = (d) => d >= FROM && d <= TO;

// ------------------------------------------------------------- outcomes
const obs = new Map();                       // slotKey -> stationId -> 0|1
const stations = new Map();
for (const f of fs.readdirSync(RAW)) {
  const m = f.match(/^rainfall_(\d{4}-\d{2}-\d{2})T(\d{4})\.json\.gz$/);
  if (!m || !inRange(m[1])) continue;
  const pages = read(f);
  if (!pages) continue;
  const w = obs.get(`${m[1]}T${m[2]}`) ?? new Map();
  for (const p of pages) {
    for (const s of p.stations ?? [])
      if (!stations.has(s.id))
        stations.set(s.id, { id: s.id, lat: s.location.latitude, lon: s.location.longitude });
    for (const r of p.readings ?? [])
      for (const d of r.data) w.set(d.stationId, (w.get(d.stationId) ?? 0) || (d.value > 0 ? 1 : 0));
  }
  obs.set(`${m[1]}T${m[2]}`, w);
}

// ------------------------------------------------- NEA, joined causally
const TEXT_TO_CODE = {
  "Fair (Day)": "FA", "Fair (Night)": "FN", "Fair": "FA", "Fair & Warm": "FW",
  "Partly Cloudy (Day)": "PC", "Partly Cloudy (Night)": "PN", "Partly Cloudy": "PC",
  "Cloudy": "CL", "Windy": "WD", "Light Rain": "LR", "Moderate Rain": "RA",
  "Rain": "RA", "Heavy Rain": "HR", "Passing Showers": "PS", "Light Showers": "LS",
  "Showers": "SH", "Heavy Showers": "HS", "Thundery Showers": "TL",
  "Heavy Thundery Showers": "HT", "Heavy Thundery Showers with Gusty Winds": "HG",
  "Mist": "BR", "Slightly Hazy": "LH", "Hazy": "LH",
};
const km = (a, b) => Math.hypot((a.lat - b.lat) * 110.6, (a.lon - b.lon) * 111.3 * Math.cos((a.lat * Math.PI) / 180));
const toSlot = (iso) => `${iso.slice(0,10)}T${iso.slice(11,13)}${String(Math.floor(+iso.slice(14,16)/15)*15).padStart(2,"0")}`;
const slotMs = (k) => Date.UTC(+k.slice(0,4), +k.slice(5,7)-1, +k.slice(8,10), +k.slice(11,13), +k.slice(13,15));

const areas = [];
const fcAt = new Map();                      // slotKey -> area -> {code, since}
for (const f of fs.readdirSync(RAW)) {
  const m = f.match(/^two-hr-forecast_(\d{4}-\d{2}-\d{2})T(\d{4})\.json\.gz$/);
  if (!m || !inRange(m[1])) continue;
  const pages = read(f);
  if (!pages) continue;
  const slot = `${m[1]}T${m[2]}`;
  const byArea = new Map();
  const items = [];
  for (const p of pages) {
    for (const a of p.area_metadata ?? [])
      if (!areas.find((x) => x.name === a.name))
        areas.push({ name: a.name, lat: a.label_location.latitude, lon: a.label_location.longitude });
    for (const it of p.items ?? []) items.push(it);
  }
  const issued = (it) => it.timestamp ?? it.update_timestamp ?? it.valid_period.start;
  items.sort((a, b) => issued(a).localeCompare(issued(b)));
  for (const it of items)
    for (const fc of it.forecasts) {
      const code = TEXT_TO_CODE[fc.forecast];
      if (!code) continue;
      byArea.set(fc.area, { code, since: Math.round((slotMs(slot) - slotMs(toSlot(it.valid_period.start))) / 900_000) });
    }
  fcAt.set(slot, byArea);
}
const areaOf = new Map();
for (const s of stations.values()) {
  let best = null, bd = Infinity;
  for (const a of areas) { const d = km(s, a); if (d < bd) { bd = d; best = a.name; } }
  areaOf.set(s.id, best);
}
const neaP = (slot, stationId, lead) => {
  const f = fcAt.get(slot)?.get(areaOf.get(stationId));
  if (!f) return null;
  const t = model.codeProb[f.code];
  if (!t) return model.pGlobal;
  return t[Math.max(0, Math.min(NLEAD - 1, f.since + 1 + lead))];
};

// --------------------------------------------------------- what we said
const served = new Map();
for (const f of fs.readdirSync(path.join(DATA, "verification")).sort()) {
  const day = f.replace(".jsonl", "");
  if (!inRange(day)) continue;
  for (const line of fs.readFileSync(path.join(DATA, "verification", f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const key = `${r.issued}|${r.stationId}`;
    const prev = served.get(key);
    const seq = r.seq ?? 0;
    if (prev && prev.seq >= seq) continue;
    served.set(key, { p: r.p, seq });
  }
}

const shift = (key, mins) => {
  const d = new Date(slotMs(key) + mins * 60_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
};

// ----------------------------------------------------------------- score
const lead = Array.from({ length: NLEAD }, () => ({ n: 0, ours: 0, nea: 0, neaN: 0, oursN: 0, zero: 0, persist: 0 }));
const dry = { n: 0, ours: 0, zero: 0 };
const wet = { n: 0, ours: 0, keeps: 0 };
const onset = Array.from({ length: 4 }, () => []);
let wetRate = 0, total = 0;

for (const [key, row] of served) {
  const [issued, st] = key.split("|");
  const now = obs.get(issued)?.get(st);
  if (now === undefined) continue;
  const p = row.p.map((v) => v / 10000);

  for (let l = 0; l < NLEAD; l++) {
    const y = obs.get(shift(issued, 15 * (l + 1)))?.get(st);
    if (y === undefined) continue;
    const L = lead[l];
    L.n++; L.ours += (p[l] - y) ** 2; L.zero += y; L.persist += (now - y) ** 2;
    const pn = neaP(issued, st, l);
    if (pn !== null) { L.neaN++; L.nea += (pn - y) ** 2; L.oursN += (p[l] - y) ** 2; }
    total++; wetRate += y;
    if (now === 1) { wet.n++; wet.ours += (p[l] - y) ** 2; wet.keeps += (1 - y) ** 2; }
    else { dry.n++; dry.ours += (p[l] - y) ** 2; dry.zero += y; }
  }

  // Onset: dry for 45 min, wet next. What were we saying beforehand?
  if (now === 0 && obs.get(shift(issued, 15))?.get(st) === 1) {
    const back = [15, 30, 45].every((m) => obs.get(shift(issued, -m))?.get(st) === 0);
    if (back) for (let b = 0; b < 4; b++) {
      const s = served.get(`${shift(issued, -15 * b)}|${st}`);
      if (s) onset[b].push(s.p[b] / 10000);
    }
  }
}

const pct = (a, b) => (b === 0 ? "   n/a" : `${(100 * (1 - a / b)).toFixed(1)}%`);
console.log(`PERFORMANCE — ${FROM} to ${TO}, every gauge, from the verification log`);
console.log(`${served.size.toLocaleString()} station-slots   wet outcome rate ${(100*wetRate/Math.max(1,total)).toFixed(2)}%\n`);
console.log("  lead        ours        NEA    vs NEA   vs no-rain   vs persistence");
let tO = 0, tN = 0, tON = 0, tZ = 0, tP = 0, tn = 0, tnN = 0;
for (let l = 0; l < NLEAD; l++) {
  const b = lead[l];
  if (!b.n) continue;
  tO += b.ours; tZ += b.zero; tP += b.persist; tn += b.n; tN += b.nea; tON += b.oursN; tnN += b.neaN;
  console.log(`  ${String((l+1)*15).padStart(4)}    ${(b.ours/b.n).toFixed(6)}   ` +
    `${b.neaN ? (b.nea/b.neaN).toFixed(6) : "     -  "}   ${pct(b.oursN, b.nea).padStart(7)}   ` +
    `${pct(b.ours, b.zero).padStart(9)}   ${pct(b.ours, b.persist).padStart(12)}`);
}
console.log(`\n  overall   ${(tO/tn).toFixed(6)}   ${tnN ? (tN/tnN).toFixed(6) : "-"}   ` +
  `${pct(tON, tN).padStart(7)}   ${pct(tO, tZ).padStart(9)}   ${pct(tO, tP).padStart(12)}`);

console.log(`\n  "will it rain?"      dry now, n=${dry.n.toLocaleString()}   vs no-rain ${pct(dry.ours, dry.zero)}`);
console.log(`  "when will it stop?" raining, n=${wet.n.toLocaleString()}   vs "keeps raining" ${pct(wet.ours, wet.keeps)}`);

console.log("\n  Onset — what we said before rain began:");
for (let b = 0; b < 4; b++) {
  if (!onset[b].length) continue;
  const a = [...onset[b]].sort((x, y) => x - y);
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  console.log(`    ${String((b+1)*15).padStart(3)} min before   n=${String(a.length).padStart(5)}   ` +
    `mean ${(100*mean).toFixed(1).padStart(5)}%   median ${(100*a[Math.floor(a.length/2)]).toFixed(1).padStart(5)}%`);
}
