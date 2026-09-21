/**
 * Slot accumulation — the rule that a slot may only ever gain.
 *
 * Both halves of this have failed in production. "The file exists" as the skip
 * test left a slot holding a subset of the gauges that no later poll replaced,
 * and keeping only the first of a window's three readings hid half the rain and
 * understated millimetres by a third against what the model was trained on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { coverage, mergeSlot, slotKey, latestTimestamp } from "../src/lib/datagov";
import type { RealtimePage } from "../src/lib/datagov";

const station = (id: string) => ({ id, name: id, location: { latitude: 1.3, longitude: 103.8 } });
const reading = (ts: string, ids: string[]): RealtimePage => ({
  stations: ids.map(station),
  readings: [{ timestamp: ts, data: ids.map((id) => ({ stationId: id, value: 0 })) }],
});

test("coverage counts what is in the payload, not how many pages", () => {
  assert.equal(coverage([reading("2026-09-01T10:00:00+08:00", ["A", "B"])]), 2);
  assert.equal(
    coverage([reading("2026-09-01T10:00:00+08:00", ["A"]), reading("2026-09-01T10:05:00+08:00", ["B", "C"])]),
    3,
  );
  assert.equal(coverage([]), 0);
});

test("merging a new reading into a slot adds it", () => {
  const stored = [reading("2026-09-01T10:00:00+08:00", ["A", "B"])];
  const fresh = [reading("2026-09-01T10:05:00+08:00", ["A", "B"])];
  const merged = mergeSlot(stored, fresh);
  assert.equal(merged.flatMap((p) => p.readings ?? []).length, 2, "both readings kept");
  assert.equal(coverage(merged), 4);
});

test("merging the same reading twice changes nothing", () => {
  // The poller fires every two minutes but the upstream reading advances every
  // five, so most polls must be no-ops or the slot would be rewritten forever.
  const stored = [reading("2026-09-01T10:00:00+08:00", ["A", "B"])];
  const merged = mergeSlot(stored, [reading("2026-09-01T10:00:00+08:00", ["A", "B"])]);
  assert.equal(coverage(merged), coverage(stored));
});

test("a thinner fetch never replaces a fuller reading", () => {
  // This is the bug that made 24 of 36 points across the island unforecastable:
  // a partial write became permanent because the slot name was taken.
  const full = [reading("2026-09-01T10:00:00+08:00", ["A", "B", "C"])];
  const thin = [reading("2026-09-01T10:00:00+08:00", ["A"])];
  assert.equal(coverage(mergeSlot(full, thin)), 3, "fuller reading survives");
  assert.equal(coverage(mergeSlot(thin, full)), 3, "and replaces the thin one");
});

test("merging is monotone: coverage can only rise", () => {
  const a = [reading("2026-09-01T10:00:00+08:00", ["A", "B"])];
  const b = [reading("2026-09-01T10:05:00+08:00", ["A", "B", "C"])];
  const merged = mergeSlot(a, b);
  assert.ok(coverage(merged) >= coverage(a));
  assert.ok(coverage(merged) >= coverage(b));
});

test("slotKey buckets a reading into its 15-minute window", () => {
  assert.equal(slotKey("2026-09-01T10:00:00+08:00"), "2026-09-01T1000");
  assert.equal(slotKey("2026-09-01T10:14:59+08:00"), "2026-09-01T1000");
  assert.equal(slotKey("2026-09-01T10:15:00+08:00"), "2026-09-01T1015");
  assert.equal(slotKey("2026-09-01T10:59:00+08:00"), "2026-09-01T1045");
});

test("latestTimestamp finds the newest reading regardless of order", () => {
  const pages = [
    reading("2026-09-01T10:05:00+08:00", ["A"]),
    reading("2026-09-01T10:00:00+08:00", ["A"]),
  ];
  assert.equal(latestTimestamp(pages), "2026-09-01T10:05:00+08:00");
  assert.equal(latestTimestamp([]), null);
});
