/**
 * Turn stored poll responses into the structures the model consumes.
 *
 * The model needs roughly the last hour: 45 minutes of rainfall lags plus the
 * current wind and forecast. Everything here reads from disk — nothing calls
 * data.gov.sg, so a request never waits on an upstream fetch and a rate limit
 * can never affect a page load.
 */
import { readRaw, slotsFor } from "./store";
import type { RealtimePage } from "./datagov";
import type { Station, Window, WindVector, AreaForecast } from "./forecast";
import { kmBetween, buildFeatures } from "./forecast";
import type { Model } from "./forecast";

/** NEA publishes forecast text; the model is keyed on codes. */
const TEXT_TO_CODE: Record<string, string> = {
  "Fair (Day)": "FA", "Fair (Night)": "FN", "Fair": "FA", "Fair & Warm": "FW",
  "Partly Cloudy (Day)": "PC", "Partly Cloudy (Night)": "PN", "Partly Cloudy": "PC",
  "Cloudy": "CL", "Windy": "WD", "Light Rain": "LR", "Moderate Rain": "RA",
  "Rain": "RA", "Heavy Rain": "HR", "Passing Showers": "PS", "Light Showers": "LS",
  "Showers": "SH", "Heavy Showers": "HS", "Thundery Showers": "TL",
  "Heavy Thundery Showers": "HT",
  "Heavy Thundery Showers with Gusty Winds": "HG",
  "Mist": "BR", "Slightly Hazy": "LH", "Hazy": "LH",
};

export interface Observations {
  stations: Station[];
  /** newest first: [now, -15, -30, -45] */
  history: Window[];
  wind: WindVector | null;
  islandWet: number[];
  islandMm: number[];
  areas: Array<{ name: string; lon: number; lat: number }>;
  /** per area, the forecast in force */
  forecastByArea: Map<string, AreaForecast>;
  /** slot key of the most recent rainfall observation */
  observedAt: string | null;
  /** how old that slot is, in minutes — null when there is nothing stored */
  ageMinutes: number | null;
  /** lag positions with no stored slot behind them, e.g. [2] */
  missingLags: number[];
}

/** Minutes between two slot keys, e.g. 2026-08-30T1430. */
function slotMinutes(a: string, b: string): number {
  const ms = (s: string) =>
    Date.UTC(
      +s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10),
      +s.slice(11, 13), +s.slice(13, 15),
    );
  return (ms(a) - ms(b)) / 60000;
}

export function loadObservations(lags = 4): Observations {
  // Four extra, because a gap means the slot 45 minutes back is further down
  // the list than position three.
  const rainSlots = slotsFor("rainfall", lags + 4);
  const stationMap = new Map<string, Station>();
  const newest = rainSlots[0] ?? null;

  // Each stored slot goes at the position its OWN timestamp says, not at its
  // position in the list.
  //
  // This used to read rainSlots[0..3] as [now, -15, -30, -45]. After a missing
  // slot — one in 681 so far — everything behind the gap shifted, so "15
  // minutes ago" was silently 30 and the lag features described a different
  // hour than the model was told. Absence treated as continuity, which is the
  // same failure as counting a missing gauge as dry. A hole now stays a hole:
  // buildFeatures already guards every lag read with `?? 0` and every island
  // figure with Number.isFinite.
  const history: Window[] = Array.from({ length: lags }, () => ({
    wet: new Map<string, 0 | 1>(), mm: new Map<string, number>(),
  }));
  const filled = new Array<boolean>(lags).fill(false);

  for (const slot of rainSlots) {
    if (!newest) break;
    const i = Math.round(slotMinutes(newest, slot) / 15);
    if (i < 0 || i >= lags || filled[i]) continue;
    filled[i] = true;
    const { wet, mm } = history[i];
    {
      const pages = readRaw<RealtimePage[]>("rainfall", slot) ?? [];
      for (const p of pages) {
        for (const s of p.stations ?? []) {
          if (!stationMap.has(s.id)) {
            stationMap.set(s.id, {
              id: s.id, name: s.name,
              lon: s.location.longitude, lat: s.location.latitude,
            });
          }
        }
        for (const r of p.readings ?? []) {
          for (const d of r.data) {
            // Millimetres accumulate across the 5-minute readings inside a
            // 15-minute window; wet is "any rain at all".
            mm.set(d.stationId, (mm.get(d.stationId) ?? 0) + d.value);
            const prev = wet.get(d.stationId) ?? 0;
            wet.set(d.stationId, (d.value > 0 ? 1 : prev) as 0 | 1);
          }
        }
      }
    }
  }

  const stations = [...stationMap.values()];

  const islandWet: number[] = [];
  const islandMm: number[] = [];
  for (const w of history) {
    let n = 0, k = 0, tot = 0, mn = 0;
    for (const [, v] of w.wet) { n++; k += v; }
    for (const [, v] of w.mm) { mn++; tot += v; }
    islandWet.push(n ? k / n : NaN);
    islandMm.push(mn ? tot / mn : NaN);
  }

  // Wind: island-mean travel vector. Direction is where wind comes FROM, so
  // the travel vector is negated. Averaging degrees directly is wrong — 350
  // and 10 average to 180, the exact opposite — so we average u/v components.
  let wind: WindVector | null = null;
  {
    const dirSlot = slotsFor("wind-direction", 1)[0];
    const spdSlot = slotsFor("wind-speed", 1)[0];
    if (dirSlot && spdSlot) {
      const dirPages = readRaw<RealtimePage[]>("wind-direction", dirSlot) ?? [];
      const spdPages = readRaw<RealtimePage[]>("wind-speed", spdSlot) ?? [];
      const speeds = new Map<string, number>();
      for (const p of spdPages)
        for (const r of p.readings ?? [])
          for (const d of r.data) speeds.set(d.stationId, d.value);
      let u = 0, v = 0, n = 0;
      for (const p of dirPages) {
        for (const r of p.readings ?? []) {
          for (const d of r.data) {
            const sp = speeds.get(d.stationId);
            if (sp === undefined) continue;
            const rad = (d.value * Math.PI) / 180;
            u += -sp * Math.sin(rad);
            v += -sp * Math.cos(rad);
            n++;
          }
        }
      }
      if (n) wind = { u: u / n, v: v / n };
    }
  }

  // Forecast: the one in force, ordered by ISSUE time and applied only once
  // issued. Ordering by valid_period.start instead is lookahead, and stable
  // sort then silently keeps the wrong duplicate — both have bitten before.
  const areas: Array<{ name: string; lon: number; lat: number }> = [];
  const seenArea = new Set<string>();
  const forecastByArea = new Map<string, AreaForecast>();
  {
    const slot = slotsFor("two-hr-forecast", 1)[0];
    if (slot) {
      const pages = readRaw<RealtimePage[]>("two-hr-forecast", slot) ?? [];
      const items = pages.flatMap((p) => p.items ?? []);
      for (const p of pages) {
        for (const a of p.area_metadata ?? []) {
          if (seenArea.has(a.name)) continue;
          seenArea.add(a.name);
          areas.push({
            name: a.name,
            lon: a.label_location.longitude,
            lat: a.label_location.latitude,
          });
        }
      }
      const issued = (it: (typeof items)[number]) =>
        it.timestamp ?? it.update_timestamp ?? it.valid_period.start;
      items.sort((a, b) => issued(a).localeCompare(issued(b)));
      const nowSlot = rainSlots[0];
      for (const it of items) {
        for (const f of it.forecasts) {
          const code = TEXT_TO_CODE[f.forecast];
          if (!code) continue;
          // `since` may be negative: a forecast is usually issued before its
          // period begins. Storing it unsigned discarded 46% of windows.
          const since = nowSlot
            ? Math.round(
                slotMinutes(nowSlot, toSlot(it.valid_period.start)) / 15,
              )
            : 0;
          forecastByArea.set(f.area, { code, since });
        }
      }
    }
  }

  // Wall-clock age of the newest slot. A slot key is the START of its window
  // and NEA publishes 6-9 minutes behind, so 0-30 minutes is healthy; beyond
  // that the poller has missed cycles and "now" is not now.
  const nowSlot = (() => {
    const t = new Date(Date.now() + 8 * 3600_000);
    const mi = String(Math.floor(t.getUTCMinutes() / 15) * 15).padStart(2, "0");
    return `${t.toISOString().slice(0, 10)}T${String(t.getUTCHours()).padStart(2, "0")}${mi}`;
  })();

  return {
    stations, history, wind, islandWet, islandMm, areas, forecastByArea,
    observedAt: newest,
    ageMinutes: newest ? slotMinutes(nowSlot, newest) : null,
    missingLags: filled.map((ok, i) => (ok ? -1 : i)).filter((i) => i >= 0),
  };
}

function toSlot(iso: string): string {
  const mi = String(Math.floor(Number(iso.slice(14, 16)) / 15) * 15).padStart(2, "0");
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${mi}`;
}

/**
 * The model's view of one station, at one lead.
 *
 * Lives here rather than in a route because two callers need exactly the same
 * vector and a second copy would drift: /api/forecast serves it, and /api/poll
 * records it for verification. A forecast we scored differently from the one we
 * served would make the reliability diagram a measurement of the copy.
 */
export function makeFeaturesFor(model: Model, obs: Observations) {
  // SGT is UTC+8 year-round, so this is exact arithmetic rather than a guess.
  const sgt = new Date(Date.now() + 8 * 3600 * 1000);
  const hour = sgt.getUTCHours();
  const month = sgt.getUTCMonth();
  return (s: Station, lead: number) =>
    buildFeatures(model, {
      station: s,
      history: obs.history,
      wind: obs.wind,
      islandWet: obs.islandWet,
      islandMm: obs.islandMm,
      neighbours: neighboursOf(s, obs.stations),
      forecast: (() => {
        const area = areaFor(s, obs.areas);
        return area ? (obs.forecastByArea.get(area) ?? null) : null;
      })(),
      hour,
      month,
    }, lead);
}

/**
 * Of the upwind gauges that were raining half an hour ago, how many have
 * stopped — the clearing edge, as a fraction.
 *
 * Returns null when the question does not apply: the station is not itself
 * raining, the wind is too weak for "upwind" to mean anything, or too few
 * upwind gauges were wet to measure against. Null means "no adjustment",
 * never "no clearing".
 */
export function clearedFractionFor(s: Station, obs: Observations): number | null {
  if (obs.history[0]?.wet.get(s.id) !== 1) return null;
  const before = obs.history[2]?.wet;
  if (!before || !obs.wind) return null;
  const speed = Math.hypot(obs.wind.u, obs.wind.v);
  if (speed < 1) return null;
  const ux = obs.wind.u / speed, uy = obs.wind.v / speed;

  let cleared = 0, wasWet = 0;
  for (const o of obs.stations) {
    if (o.id === s.id) continue;
    const dx = (o.lon - s.lon) * 111.3 * Math.cos((s.lat * Math.PI) / 180);
    const dy = (o.lat - s.lat) * 110.6;
    const d = Math.hypot(dx, dy);
    if (d < 0.5 || d > 20) continue;
    if ((dx / d) * ux + (dy / d) * uy >= 0) continue;      // downwind
    if (before.get(o.id) !== 1) continue;
    wasWet++;
    if (obs.history[0].wet.get(o.id) === 0) cleared++;
  }
  // Under three, the fraction is a coin toss dressed as a measurement.
  return wasWet >= 3 ? cleared / wasWet : null;
}

/** Neighbour lists at the radii the model expects. */
export function neighboursOf(s: Station, all: Station[]) {
  const within = (r: number) => all.filter((o) => o.id !== s.id && kmBetween(s, o) <= r);
  return { within5: within(5), within15: within(15), within20: within(20) };
}

/** Nearest forecast area to a station — 47 areas, median ~1.5 km away. */
export function areaFor(
  s: Station,
  areas: Array<{ name: string; lon: number; lat: number }>,
): string | null {
  let best: string | null = null;
  let bd = Infinity;
  for (const a of areas) {
    const d = kmBetween(s, a);
    if (d < bd) { bd = d; best = a.name; }
  }
  return best;
}
