/**
 * Location search. Proxies OneMap so credentials stay server-side — the browser
 * never holds a OneMap token, and never talks to OneMap directly.
 */
import { NextRequest, NextResponse } from "next/server";
import { search, inSingapore } from "@/lib/onemap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ results: [] });

  try {
    const places = await search(q, 6);
    // Drop anything outside Singapore: we have no gauges there, so a forecast
    // would be an extrapolation dressed up as an observation.
    const results = places.filter((p) => inSingapore(p.lat, p.lon));
    return NextResponse.json({ results });
  } catch (err) {
    console.error("search failed", err);
    return NextResponse.json(
      { results: [], error: "Search is unavailable right now." },
      { status: 502 },
    );
  }
}
