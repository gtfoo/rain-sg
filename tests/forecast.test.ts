/**
 * The things the card says, and the guards on saying them.
 *
 * Every assertion here corresponds to a decision that was measured rather than
 * chosen — the cumulative table exists because chaining the windows naively
 * overstates by nearly double at two hours, and the 1 m/s floor exists because
 * below it the island-mean wind direction wanders and "upwind" stops meaning
 * anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cumulative, upwindRain, upwindClearing, adjustForClearing } from "../src/lib/forecast";
import type { Model, Station } from "../src/lib/forecast";
import modelJson from "../src/model/model.json" with { type: "json" };

const model = modelJson as unknown as Model;

const st = (id: string, lat: number, lon: number): Station => ({ id, name: id, lat, lon });
const HERE = { lat: 1.3000, lon: 103.8000 };
// ~1 degree of longitude is 111 km here, so 0.05 deg is about 5.6 km.
const WEST = st("W", 1.3000, 103.7500);
const EAST = st("E", 1.3000, 103.8500);
const AREAS = [
  { name: "Westside", lat: 1.3000, lon: 103.7500 },
  { name: "Eastside", lat: 1.3000, lon: 103.8500 },
];
// Travel vector points east, so the wind comes FROM the west.
const FROM_WEST = { u: 4, v: 0 };
const wetMap = (pairs: Array<[string, 0 | 1]>) => new Map<string, 0 | 1>(pairs);

test("cumulative never decreases as the horizon grows", () => {
  // "Chance of rain by +30" cannot be less than "by +15" — it contains it.
  const p = [0.05, 0.10, 0.20, 0.30, 0.25, 0.15, 0.10, 0.05];
  const c = cumulative(model, p);
  assert.equal(c.length, p.length);
  for (let i = 1; i < c.length; i++) assert.ok(c[i] >= c[i - 1] - 1e-9, `fell at ${i}`);
  for (const v of c) assert.ok(v >= 0 && v <= 1, `out of range: ${v}`);
});

test("cumulative is at least the largest single window", () => {
  const p = [0.02, 0.60, 0.05, 0, 0, 0, 0, 0];
  const c = cumulative(model, p);
  assert.ok(c[7] >= 0.55, `two-hour chance ${c[7]} should not undercut a 60% window`);
});

test("cumulative stays below the naive chaining that overstates", () => {
  // 1 - prod(1-p) reads 17.8% at two hours where the truth is 10.9%. The table
  // exists to pull that down; if a future refit ever pushes it back above the
  // chained figure, something has gone backwards.
  const p = new Array(8).fill(0.05);
  const naive = 1 - p.reduce((s, v) => s * (1 - v), 1);
  assert.ok(cumulative(model, p)[7] < naive);
});

test("upwind rain: found to the west when the wind is from the west", () => {
  const got = upwindRain(HERE, [WEST, EAST], wetMap([["W", 1], ["E", 1]]), FROM_WEST, AREAS);
  assert.ok(got, "expected a result");
  assert.equal(got.area, "Westside", "named by nearest NEA area, not the gauge");
  assert.equal(got.dir, "west");
  assert.ok(got.km > 5 && got.km < 7, `distance looked wrong: ${got.km}`);
});

test("upwind rain ignores rain that is downwind", () => {
  // Rain leaving you is not rain arriving. Island-wide wetness lifted every
  // station regardless of direction and produced a four-hour false alarm.
  assert.equal(upwindRain(HERE, [WEST, EAST], wetMap([["E", 1]]), FROM_WEST, AREAS), null);
});

test("upwind rain says nothing when the wind is too weak to have a direction", () => {
  const calm = { u: 0.3, v: 0.1 };
  assert.equal(upwindRain(HERE, [WEST, EAST], wetMap([["W", 1]]), calm, AREAS), null);
  assert.equal(upwindRain(HERE, [WEST, EAST], wetMap([["W", 1]]), null, AREAS), null);
});

test("clearing needs a gauge that WAS raining and has stopped", () => {
  const stoppedWest = upwindClearing(
    HERE, [WEST, EAST], wetMap([["W", 0], ["E", 1]]), wetMap([["W", 1], ["E", 1]]), FROM_WEST, AREAS,
  );
  assert.ok(stoppedWest);
  assert.equal(stoppedWest.area, "Westside");

  // Dry now and dry before is not clearing — it never rained there.
  assert.equal(
    upwindClearing(HERE, [WEST, EAST], wetMap([["W", 0]]), wetMap([["W", 0]]), FROM_WEST, AREAS),
    null,
  );
  // Still raining upwind is not clearing either.
  assert.equal(
    upwindClearing(HERE, [WEST, EAST], wetMap([["W", 1]]), wetMap([["W", 1]]), FROM_WEST, AREAS),
    null,
  );
});

test("the clearing adjustment is inert, as shipped", () => {
  // Held back on purpose: it scored +1.8% on held-out days of 2025 and -0.6% on
  // fresh 2026. If this ever fails, someone has enabled it — which needs a
  // different period's evidence, not a rerun of the old one.
  for (let lead = 0; lead < model.nlead; lead++) {
    assert.equal(adjustForClearing(model, 0.42, lead, 0.9), 0.42);
    assert.equal(adjustForClearing(model, 0.42, lead, null), 0.42);
  }
});
