/**
 * On-disk store. Everything lives under DATA_DIR, outside the app tree.
 *
 * DATA_DIR has no fallback on purpose. A default pointing inside the tree lets
 * the app boot, create an empty directory, report healthy and serve nothing —
 * indistinguishable from "no data yet". indie-degree got this right by design
 * and it is written up as a trade-off on their case-study page; gtfoo got it
 * wrong and the bug is still open there.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export function dataDir(): string {
  const d = process.env.DATA_DIR?.trim();
  if (!d) {
    throw new Error(
      "DATA_DIR is not set. It must point outside the app tree — see AGENTS.md. " +
        "Refusing to guess a path: SQLite and fs.mkdir will both happily create " +
        "an empty one and the app will look healthy while serving nothing.",
    );
  }
  return d;
}

const RAW = () => path.join(dataDir(), "raw");
const GRID = () => path.join(dataDir(), "grid");
const VERIFY = () => path.join(dataDir(), "verification");

export function ensureDirs(): void {
  for (const d of [RAW(), GRID(), VERIFY()]) fs.mkdirSync(d, { recursive: true });
}

/**
 * Write bytes into place atomically.
 *
 * Temp file in the SAME directory then rename(), because rename is only atomic
 * within a filesystem. A reader must never see a half-written file — the poller
 * and the request path touch these concurrently.
 */
export function writeAtomic(file: string, data: Buffer | string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/**
 * Store one endpoint's response for one 15-minute slot, gzipped.
 *
 * Named from the reading's own timestamp, not the wall clock, so a double fire
 * from the timer recomputes the same name and rewrites identical bytes. JSON
 * compresses 14–26x here, which is what makes indefinite retention affordable
 * (~90 MB/year rather than 1.5 GB).
 */
export function saveRaw(api: string, slot: string, pages: unknown): { file: string; bytes: number } {
  ensureDirs();
  const file = path.join(RAW(), `${api}_${slot}.json.gz`);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(pages)), { level: 6 });
  writeAtomic(file, gz);
  return { file, bytes: gz.length };
}

export function hasRaw(api: string, slot: string): boolean {
  try {
    return fs.statSync(path.join(RAW(), `${api}_${slot}.json.gz`)).size > 0;
  } catch {
    return false;
  }
}

export function readRaw<T = unknown>(api: string, slot: string): T | null {
  try {
    const buf = fs.readFileSync(path.join(RAW(), `${api}_${slot}.json.gz`));
    return JSON.parse(zlib.gunzipSync(buf).toString()) as T;
  } catch {
    return null;
  }
}

/** Slot keys present for an endpoint, newest first. */
export function slotsFor(api: string, limit = 12): string[] {
  try {
    return fs
      .readdirSync(RAW())
      .filter((f) => f.startsWith(`${api}_`) && f.endsWith(".json.gz"))
      .map((f) => f.slice(api.length + 1, -".json.gz".length))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Append a forecast and, later, what actually happened.
 *
 * This is the only file here that cannot be reconstructed from anything else.
 * Raw is re-downloadable, grids are re-derivable, the model is retrainable —
 * but a record of what we predicted and what followed exists nowhere but here.
 * It is what lets the app eventually say "when we said 70%, it rained 68% of
 * the time" instead of shipping uncalibrated numbers indefinitely.
 *
 * One JSONL file per day: append-only, cheap to rotate, trivial to scan.
 */
export interface VerificationRow {
  /** slot the forecast was issued at */
  issued: string;
  stationId: string;
  /** 0..7, i.e. +15 .. +120 minutes */
  lead: number;
  p: number;
  /** filled in later, once the target window is observed */
  outcome?: 0 | 1;
}

export function appendVerification(rows: VerificationRow[]): void {
  if (!rows.length) return;
  ensureDirs();
  const day = rows[0].issued.slice(0, 10);
  const file = path.join(VERIFY(), `${day}.jsonl`);
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Delete raw slots older than `days`. Grids and verification are never pruned. */
export function pruneRaw(days = 30): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  let removed = 0;
  try {
    for (const f of fs.readdirSync(RAW())) {
      const m = f.match(/_(\d{4}-\d{2}-\d{2})T/);
      if (m && m[1] < cutoff) {
        fs.unlinkSync(path.join(RAW(), f));
        removed++;
      }
    }
  } catch {
    /* nothing to prune */
  }
  return removed;
}
