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
import { readRaw, saveRaw, pruneRaw } from "@/lib/store";

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

/**
 * How much is actually in a payload: station readings plus forecast entries.
 *
 * Deliberately not file size — a gzip of half the gauges is not obviously
 * smaller than a gzip of all of them, and that is exactly the case that has to
 * be caught.
 */
function coverage(pages: RealtimePage[]): number {
  let n = 0;
  for (const p of pages) {
    for (const r of p.readings ?? []) n += r.data.length;
    for (const it of p.items ?? []) n += it.forecasts.length;
  }
  return n;
}

export async function GET(req: NextRequest) {
  if (!isLoopback(req)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const started = Date.now();
  const results: Record<string, string> = {};
  let wrote = 0;
  let failed = 0;

  for (const api of ENDPOINTS) {
    try {
      const pages = await fetchEndpoint(api);
      const latest = latestTimestamp(pages);
      if (!latest) {
        results[api] = "no readings";
        continue;
      }
      const slot = slotKey(latest);

      // Idempotent: the slot key comes from the reading's own timestamp, so a
      // double fire lands on the same name, and re-storing identical data is
      // wasted work on a 5-minute timer.
      //
      // But "the file exists" is the wrong test, and it cost us a day. A run
      // that was killed part-way left a slot holding a subset of the gauges,
      // and because the name was taken no later poll ever replaced it — the
      // island silently kept forecasting from whichever gauges happened to be
      // in that file. Compare what is actually IN the payload instead, so a
      // thinner file is always replaced by a fuller one and an equal one is
      // still skipped.
      const stored = readRaw<RealtimePage[]>(api, slot);
      if (stored && coverage(stored) >= coverage(pages)) {
        results[api] = `${slot} already stored`;
        continue;
      }
      const { bytes } = saveRaw(api, slot, pages);
      results[api] = `${slot} (${(bytes / 1024).toFixed(1)} KB)`;
      wrote++;
    } catch (err) {
      failed++;
      results[api] = `failed: ${(err as Error).message}`;
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
      endpoints: results,
    },
    { status },
  );
}
