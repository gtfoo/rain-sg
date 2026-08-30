/**
 * Backfill recent slots from the day archive.
 *
 * A live poll returns only the latest reading, so a cold start has one 15-minute
 * window and the model wants four. Defaulting the missing lags to "dry" would
 * make the app forecast as though the last 45 minutes were clear even if it had
 * been pouring — the same "missing is not dry" error that understated the base
 * rate by 13% in training.
 *
 * `?date=` returns the whole day, so recovery is always possible: this is also
 * what makes a missed poll a gap rather than a permanent hole, and why the
 * systemd timer can safely use Persistent=false instead of firing a catch-up
 * burst at data.gov.sg.
 *
 * Loopback-only and manual: the timer must never be able to trigger this.
 */
import { NextRequest, NextResponse } from "next/server";
import { ENDPOINTS, fetchEndpoint, slotKey, type RealtimePage } from "@/lib/datagov";
import { hasRaw, saveRaw } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isLoopback(req: NextRequest): boolean {
  const addr =
    // @ts-expect-error - runtime field, not in the public type
    (req.ip as string | undefined) ?? (req.headers.get("x-real-ip") ?? undefined);
  if (!addr) return true;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Today in SGT. Singapore has no DST, so UTC+8 is exact. */
function sgtDate(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3600_000 - offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export async function GET(req: NextRequest) {
  if (!isLoopback(req)) return new NextResponse("Not found", { status: 404 });

  const hours = Math.min(12, Math.max(1, Number(req.nextUrl.searchParams.get("hours") ?? 2)));
  const cutoffMs = Date.now() - hours * 3600_000;
  const results: Record<string, string> = {};
  let wrote = 0;

  for (const api of ENDPOINTS) {
    try {
      // Today, plus yesterday when the window crosses midnight.
      const days = [sgtDate(0)];
      const sgtNow = new Date(Date.now() + 8 * 3600_000);
      if (sgtNow.getUTCHours() < hours) days.push(sgtDate(1));

      const bySlot = new Map<string, RealtimePage[]>();
      for (const day of days) {
        const pages = await fetchEndpoint(api, { date: day });
        // Regroup a day's pages by 15-minute slot so stored files match what
        // the poller writes — same names, same shape, interchangeable.
        for (const p of pages) {
          for (const r of p.readings ?? []) {
            if (new Date(r.timestamp).getTime() < cutoffMs) continue;
            const slot = slotKey(r.timestamp);
            const arr = bySlot.get(slot) ?? [];
            const existing = arr.find((x) => x.stations);
            if (existing) existing.readings?.push(r);
            else arr.push({ stations: p.stations, readings: [r] });
            bySlot.set(slot, arr);
          }
          for (const it of p.items ?? []) {
            const t = it.timestamp ?? it.update_timestamp ?? it.valid_period.start;
            if (new Date(t).getTime() < cutoffMs) continue;
            const slot = slotKey(t);
            const arr = bySlot.get(slot) ?? [];
            const existing = arr.find((x) => x.items);
            if (existing) existing.items?.push(it);
            else arr.push({ area_metadata: p.area_metadata, items: [it] });
            bySlot.set(slot, arr);
          }
        }
      }

      let n = 0;
      for (const [slot, pages] of bySlot) {
        if (hasRaw(api, slot)) continue;   // never overwrite a live poll
        saveRaw(api, slot, pages);
        n++;
        wrote++;
      }
      results[api] = `${n} slot(s) written, ${bySlot.size} seen`;
    } catch (err) {
      results[api] = `failed: ${(err as Error).message}`;
    }
  }

  return NextResponse.json({ ok: true, hours, wrote, endpoints: results });
}
