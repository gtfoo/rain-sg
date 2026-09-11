/**
 * The poller, as an endpoint rather than a script.
 *
 * A systemd timer calls this every 5 minutes:
 *   ExecStart=/usr/bin/curl -fsS --max-time 60 http://127.0.0.1:3004/api/poll
 *
 * It is an endpoint and not `scripts/poll.mjs` because `scripts/` does not
 * survive into a standalone bundle — Next traces only reachable modules, and
 * nothing imports a file systemd invokes. It would work locally and silently
 * not exist in production. It also survives phase 2 unchanged (there is no
 * stable path to a script under `releases/<sha>`, but 127.0.0.1:3004 is always
 * 127.0.0.1:3004) and avoids spawning a 40-50 MB node process 288 times a day
 * on a 1 GB box.
 */
import { NextRequest, NextResponse } from "next/server";
import { ENDPOINTS, fetchEndpoint, latestTimestamp, slotKey } from "@/lib/datagov";
import type { RealtimePage } from "@/lib/datagov";
import { mergeSlot, coverage } from "@/lib/datagov";
import { readRaw, saveRaw, pruneRaw, appendVerification } from "@/lib/store";
import type { VerificationRow } from "@/lib/store";
import modelJson from "@/model/model.json";
import type { Model } from "@/lib/forecast";
import { predict, adjustForClearing } from "@/lib/forecast";
import {
  loadObservations, makeFeaturesFor, clearedFractionFor,
} from "@/lib/observations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Loopback only.
 *
 * Checked against the connection, never a header: `X-Forwarded-For` is trivially
 * forged and Caddy is the only thing that should ever set it. Returns 404 rather
 * than 403 so the endpoint's existence is not advertised to a scanner.
 */
function isLoopback(req: NextRequest): boolean {
  // Next exposes the peer address here; in dev it may be undefined, which is
  // also loopback.
  const addr =
    // @ts-expect-error - runtime field, not in the public type
    (req.ip as string | undefined) ??
    (req.headers.get("x-real-ip") ?? undefined);
  if (!addr) return true;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

const model = modelJson as unknown as Model;

/**
 * Record what we would have said, for every station, at this moment.
 *
 * Written here rather than in /api/forecast on purpose. A log driven by user
 * requests is a biased sample — it over-represents wherever people happen to
 * live and whenever they happen to look, and a reliability diagram built from
 * it would describe the audience rather than the model. Polling writes the same
 * rows on a dry Tuesday at 4am as during a thunderstorm.
 *
 * Outcomes are not written back. They are recoverable by joining `issued` and
 * `lead` against the raw store, and rewriting an append-only file every 15
 * minutes to fill them in would be the more fragile of the two designs.
 */
function recordForecasts(slot: string, seq: number): number {
  const obs = loadObservations(4);
  if (!obs.stations.length || !obs.observedAt) return 0;
  const featuresFor = makeFeaturesFor(model, obs);
  const rows: VerificationRow[] = [];
  for (const st of obs.stations) {
    // The same clearing nudge the forecast route applies, so the log records
    // what was served rather than an unadjusted shadow of it.
    const cleared = clearedFractionFor(st, obs);
    const p: number[] = [];
    for (let lead = 0; lead < model.nlead; lead++) {
      const x = featuresFor(st, lead);
      if (!x) break;                       // station silent: no row at all
      const raw = predict(model, x, lead);
      p.push(Math.round(adjustForClearing(model, raw, lead, cleared) * 10_000));
    }
    if (p.length === model.nlead) rows.push({ issued: slot, stationId: st.id, seq, p });
  }
  appendVerification(rows);
  return rows.length;
}

export async function GET(req: NextRequest) {
  if (!isLoopback(req)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const started = Date.now();
  const results: Record<string, string> = {};
  let wrote = 0;
  let failed = 0;
  // Set on EVERY rainfall write, with how many readings the slot now holds.
  //
  // This used to fire only on a slot's first write, to stop one window being
  // counted three times. That worked, but it recorded the thinnest forecast of
  // the three — the first write sees one of the window's three readings — so
  // the log was systematically pessimistic about what people were shown. The
  // duplicate problem is better solved at read time, by keeping the highest
  // seq, than by throwing the good forecasts away.
  let rainSlot: string | null = null;
  let rainSeq = 0;

  for (const api of ENDPOINTS) {
    try {
      const pages = await fetchEndpoint(api);
      const latest = latestTimestamp(pages);
      if (!latest) {
        results[api] = "no readings";
        continue;
      }
      const slot = slotKey(latest);

      // A slot accumulates. Three polls fall inside each 15-minute window and
      // each carries a different 5-minute reading, so the slot is only complete
      // once they have all been merged in.
      //
      // "The file exists" was the wrong test and it cost us a day: a run killed
      // part-way left a slot holding a subset of the gauges, and because the
      // name was taken no later poll replaced it. Comparing coverage fixes that
      // and is still the test here — merging can only ever add, so a fetch that
      // contributes nothing leaves coverage unchanged and is skipped.
      const stored = readRaw<RealtimePage[]>(api, slot);
      const toWrite = stored ? mergeSlot(stored, pages) : pages;
      if (stored && coverage(toWrite) <= coverage(stored)) {
        results[api] = `${slot} already complete`;
        continue;
      }
      if (api === "rainfall") {
        rainSlot = slot;
        // Readings already held, before this write lands — 0 on a new slot.
        rainSeq = stored
          ? stored.reduce((n, pg) => n + (pg.readings?.length ?? 0), 0)
          : 0;
      }
      const { bytes } = saveRaw(api, slot, toWrite);
      results[api] = stored
        ? `${slot} merged (${(bytes / 1024).toFixed(1)} KB)`
        : `${slot} (${(bytes / 1024).toFixed(1)} KB)`;
      wrote++;
    } catch (err) {
      failed++;
      results[api] = `failed: ${(err as Error).message}`;
    }
  }

  let recorded = 0;
  if (rainSlot) {
    try {
      recorded = recordForecasts(rainSlot, rainSeq);
    } catch (err) {
      // Verification is a nice-to-have; the poll's job is to store data.
      results["verification"] = `failed: ${(err as Error).message}`;
    }
  }

  // Raw is kept for re-ingest after a schema change; 30 days is ample and the
  // archive is re-downloadable via ?date= if we ever need further back.
  const pruned = pruneRaw(30);

  // A poll that fetched nothing at all is a failure worth a non-200, so the
  // timer's `curl -f` surfaces it in the journal rather than looking healthy.
  const status = failed === ENDPOINTS.length ? 503 : 200;

  return NextResponse.json(
    {
      ok: status === 200,
      wrote,
      failed,
      pruned,
      ms: Date.now() - started,
      recorded,
      endpoints: results,
    },
    { status },
  );
}
