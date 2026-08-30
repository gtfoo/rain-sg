/**
 * Does the served model actually respond to rain?
 *
 * A calm evening and a broken pipeline produce the same near-zero output, so
 * "the numbers look plausible" is not evidence. This feeds synthetic feature
 * vectors straight to the shipped model file and checks the probabilities move
 * the way training said they should.
 *
 * Run: node scripts/sanity.mjs
 */
import fs from "node:fs";

const M = JSON.parse(fs.readFileSync(new URL("../src/model/model.json", import.meta.url)));
const sig = (z) => 1 / (1 + Math.exp(-z));
const lo = (p) => { const q = Math.max(1e-4, Math.min(0.9999, p)); return Math.log(q / (1 - q)); };
const bandOf = (isl) => (isl < 0.02 ? 0 : isl < 0.2 ? 1 : 2);

function predict(x, lead) {
  const w = M.weights[lead];
  let z = w[M.cols.length];
  for (let j = 0; j < M.cols.length; j++) z += w[j] * x[M.cols[j]];
  const cal = M.platt[lead];
  const pl = cal.bands ? cal.bands[bandOf(x[6])] : cal.global;
  return sig(pl.a * z + pl.b);
}

/** Build a feature vector for a described situation. */
function features({ wetNow, lags, near5, near15, island, islandPrev, hour, month, code, since,
                    windU = 0, windV = 0, upwind = 0, downwind = 0, mm = 0, mmTrend = 0,
                    upwindMm = 0, islandMmTrend = 0 }) {
  const x = new Float64Array(27);
  x[0] = wetNow; x[1] = lags; x[2] = lags; x[3] = lags;
  x[4] = near5; x[5] = near15; x[6] = island; x[7] = islandPrev;
  x[8] = lo(M.clim.ph[hour]); x[9] = lo(M.clim.pm[month]);
  const table = M.codeProb[code];
  const bin = Math.max(0, Math.min(M.nlead - 1, since + 1));
  x[13] = lo(table ? table[bin] : M.pGlobal);
  const sp = Math.hypot(windU, windV);
  x[14] = windU / 5; x[15] = windV / 5; x[16] = sp / 5;
  x[17] = upwind; x[20] = downwind;
  x[23] = Math.log1p(mm * 4) / 2; x[24] = mmTrend;
  x[25] = Math.log1p(upwindMm * 4) / 2; x[26] = islandMmTrend;
  return x;
}

const cases = [
  {
    name: "calm night, nothing anywhere, Partly Cloudy (Night)",
    f: features({ wetNow: 0, lags: 0, near5: 0, near15: 0, island: 0, islandPrev: 0,
                  hour: 22, month: 7, code: "PN", since: 0 }),
    expect: "very low - this is what we are seeing live",
  },
  {
    name: "raining hard here, island-wide, Thundery Showers",
    f: features({ wetNow: 1, lags: 1, near5: 1, near15: 0.8, island: 0.6, islandPrev: 0.5,
                  hour: 15, month: 0, code: "TL", since: 0,
                  windU: -6, windV: -2, upwind: 0.8, downwind: 0.7,
                  mm: 3, mmTrend: 0.5, upwindMm: 2.5, islandMmTrend: 0.4 }),
    expect: "high - persistence plus everything wet",
  },
  {
    name: "dry here, heavy rain UPWIND, Thundery Showers",
    f: features({ wetNow: 0, lags: 0, near5: 0, near15: 0.3, island: 0.25, islandPrev: 0.2,
                  hour: 15, month: 0, code: "TL", since: 0,
                  windU: -6, windV: -2, upwind: 0.9, downwind: 0.0,
                  mm: 0, mmTrend: 0, upwindMm: 3, islandMmTrend: 0.5 }),
    expect: "elevated - rain heading this way",
  },
  {
    name: "dry here, same rain but DOWNWIND (moving away)",
    f: features({ wetNow: 0, lags: 0, near5: 0, near15: 0.3, island: 0.25, islandPrev: 0.3,
                  hour: 15, month: 0, code: "TL", since: 0,
                  windU: -6, windV: -2, upwind: 0.0, downwind: 0.9,
                  mm: 0, mmTrend: 0, upwindMm: 0, islandMmTrend: -0.4 }),
    expect: "lower than upwind - this is what downwind is for",
  },
];

console.log("model: " + M.cols.length + " features, " + M.nlead + " leads, " +
            (M.platt[0].bands ? M.platt[0].bands.length + " calibration bands" : "global calibration"));
console.log("");
for (const c of cases) {
  const ps = Array.from({ length: M.nlead }, (_, l) => predict(c.f, l));
  console.log(c.name);
  console.log("  " + ps.map((p) => (100 * p).toFixed(1).padStart(6) + "%").join(""));
  console.log("  expected: " + c.expect);
  console.log("");
}
const up = predict(cases[2].f, 0), down = predict(cases[3].f, 0);
console.log("upwind vs downwind at +15min: " + (100 * up).toFixed(1) + "% vs " +
            (100 * down).toFixed(1) + "%  ->  " +
            (up > down ? "PASS (upwind higher, as designed)" : "FAIL (direction ignored)"));
