/**
 * Reading the store back into the shape the model expects.
 *
 * Two bugs live here. Lag slots were read by POSITION, so a missing slot slid
 * older data forward and "15 minutes ago" silently became 30. And the forecast
 * join has broken three separate times, every time by ordering on the validity
 * period instead of the issue timestamp.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dir: string;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rain-obs-"));
  process.env.DATA_DIR = dir;
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { saveRaw, ensureDirs } = await import("../src/lib/store");
const { loadObservations } = await import("../src/lib/observations");

/** A slot key N minutes before the given one. */
const shift = (key: string, mins: number) => {
  const ms = Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10),
                      +key.slice(11, 13), +key.slice(13, 15)) + mins * 60_000;
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
};

/** The slot the app would consider "now", so fixtures are never stale. */
const nowSlot = () => {
  const t = new Date(Date.now() + 8 * 3600_000), p = (n: number) => String(n).padStart(2, "0");
  return `${t.toISOString().slice(0, 10)}T${p(t.getUTCHours())}${p(Math.floor(t.getUTCMinutes() / 15) * 15)}`;
};

const rain = (slot: string, wet: 0 | 1) => {
  ensureDirs();
  saveRaw("rainfall", slot, [{
    stations: [{ id: "S1", name: "S1", location: { latitude: 1.3, longitude: 103.8 } }],
    readings: [{ timestamp: `${slot.slice(0, 10)}T00:00:00+08:00`, data: [{ stationId: "S1", value: wet }] }],
  }]);
};

test("a missing slot leaves a hole rather than shifting the lags", () => {
  const now = nowSlot();
  // Deliberately skip -30. Under the old positional read, the -45 slot would
  // have taken position 2 and been reported as half an hour old.
  rain(now, 0);
  rain(shift(now, -15), 0);
  rain(shift(now, -45), 1);

  const obs = loadObservations(4);
  assert.deepEqual(obs.missingLags, [2], "the gap is reported, not filled");
  assert.equal(obs.history[1].wet.get("S1"), 0);
  assert.equal(obs.history[2].wet.get("S1"), undefined, "the hole stays empty");
  assert.equal(obs.history[3].wet.get("S1"), 1, "the -45 reading stayed at -45");
  assert.equal(obs.observedAt, now);
  assert.ok(obs.ageMinutes !== null && obs.ageMinutes < 60, "a current fixture is not stale");
});

test("a complete history reports no holes", () => {
  fs.rmSync(path.join(dir, "raw"), { recursive: true, force: true });
  const now = nowSlot();
  for (const m of [0, -15, -30, -45]) rain(shift(now, m), 0);
  assert.deepEqual(loadObservations(4).missingLags, []);
});

test("the forecast in force is the latest ISSUED, not the latest period", () => {
  fs.rmSync(path.join(dir, "raw"), { recursive: true, force: true });
  const now = nowSlot();
  rain(now, 0);
  const day = now.slice(0, 10);
  ensureDirs();
  // NEA revises a period after issuing it. Ordering by valid_period.start would
  // let the 12:30 entry win over its own 12:53 revision, or — because JS sort
  // is stable — silently keep whichever came first in the file.
  saveRaw("two-hr-forecast", now, [{
    area_metadata: [{ name: "Jurong Island", label_location: { latitude: 1.3, longitude: 103.8 } }],
    items: [
      {
        timestamp: `${day}T12:53:00+08:00`,
        valid_period: { start: `${day}T12:30:00+08:00`, end: `${day}T14:30:00+08:00` },
        forecasts: [{ area: "Jurong Island", forecast: "Thundery Showers" }],
      },
      {
        timestamp: `${day}T12:39:00+08:00`,
        valid_period: { start: `${day}T12:30:00+08:00`, end: `${day}T14:30:00+08:00` },
        forecasts: [{ area: "Jurong Island", forecast: "Passing Showers" }],
      },
    ],
  }]);

  const f = loadObservations(4).forecastByArea.get("Jurong Island");
  assert.ok(f, "the area should have a forecast");
  assert.equal(f.code, "TL", "the 12:53 revision wins over the 12:39 one");
});

test("the offset from a period that has not started yet is negative", () => {
  fs.rmSync(path.join(dir, "raw"), { recursive: true, force: true });
  const now = nowSlot();
  rain(now, 0);
  const future = shift(now, 30);
  ensureDirs();
  // A forecast is usually issued before its period begins. Stored unsigned,
  // that turned 46% of windows into "unknown" with no error anywhere.
  saveRaw("two-hr-forecast", now, [{
    area_metadata: [{ name: "Jurong Island", label_location: { latitude: 1.3, longitude: 103.8 } }],
    items: [{
      timestamp: `${now.slice(0, 10)}T00:00:00+08:00`,
      valid_period: {
        start: `${future.slice(0, 10)}T${future.slice(11, 13)}:${future.slice(13, 15)}:00+08:00`,
        end: `${future.slice(0, 10)}T23:59:00+08:00`,
      },
      forecasts: [{ area: "Jurong Island", forecast: "Fair (Day)" }],
    }],
  }]);

  const f = loadObservations(4).forecastByArea.get("Jurong Island");
  assert.ok(f);
  assert.equal(f.since, -2, "two windows before the period starts");
});
