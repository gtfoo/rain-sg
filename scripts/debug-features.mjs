/**
 * Inspect what the model is actually being fed. Not shipped — a dev tool.
 * Run: DATA_DIR=... node --experimental-strip-types scripts/debug-features.mjs
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";

const DATA = process.env.DATA_DIR;
if (!DATA) { console.error("DATA_DIR required"); process.exit(1); }
const RAW = path.join(DATA, "raw");

const slots = (api) =>
  fs.readdirSync(RAW).filter(f => f.startsWith(api + "_")).sort().reverse()
    .map(f => f.slice(api.length + 1, -".json.gz".length));

const read = (api, slot) =>
  JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW, `${api}_${slot}.json.gz`))).toString());

console.log("=== slots on disk ===");
for (const api of ["rainfall", "wind-speed", "wind-direction", "two-hr-forecast"]) {
  console.log("  " + api.padEnd(18) + slots(api).join(", "));
}

const rs = slots("rainfall");
console.log("\n=== rainfall, newest slot ===");
const pages = read("rainfall", rs[0]);
let nStations = 0, nReadings = 0, wet = 0, reporting = 0;
const stations = new Map();
for (const p of pages) {
  for (const s of p.stations ?? []) stations.set(s.id, s);
  for (const r of p.readings ?? []) {
    nReadings++;
    for (const d of r.data) { reporting++; if (d.value > 0) wet++; }
  }
}
nStations = stations.size;
console.log(`  stations listed: ${nStations}`);
console.log(`  reading records: ${nReadings}   station-values: ${reporting}   wet: ${wet}`);
console.log(`  -> island wet fraction: ${(wet / Math.max(1, reporting) * 100).toFixed(2)}%`);

console.log("\n=== how many pages did the live poll store? ===");
console.log(`  pages: ${pages.length}`);
console.log("  NOTE: a live (no ?date=) call is capped at 2 pages in fetchEndpoint.");
console.log("  Each page holds 25 reading-records; one live call returns the latest only.");

console.log("\n=== two-hr-forecast ===");
const fc = read("two-hr-forecast", slots("two-hr-forecast")[0]);
const items = fc.flatMap(p => p.items ?? []);
console.log(`  pages: ${fc.length}  items: ${items.length}`);
if (items.length) {
  const it = items[items.length - 1];
  console.log(`  newest valid_period.start: ${it.valid_period.start}`);
  console.log(`  issued: ${it.timestamp ?? it.update_timestamp ?? "(none)"}`);
  console.log(`  sample area: ${it.forecasts[0].area} -> ${it.forecasts[0].forecast}`);
}
console.log(`  areas listed: ${(fc[0]?.area_metadata ?? []).length}`);
