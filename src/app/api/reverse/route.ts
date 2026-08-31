/**
 * Reverse geocode: the coordinate a phone's GPS gives us, turned into a name.
 *
 * Proxied for the same reason /api/search is — the OneMap token stays on the
 * server and the browser never holds one.
 */
import { NextRequest, NextResponse } from "next/server";
import { reverseGeocode, inSingapore } from "@/lib/onemap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const lat = Number(req.nextUrl.searchParams.get("lat"));
  const lon = Number(req.nextUrl.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon are required" }, { status: 400 });
  }
  // Outside Singapore there is nothing to name and nothing to forecast; the
  // forecast route says so properly, so this stays quiet rather than raising a
  // second error about the same coordinate.
  if (!inSingapore(lat, lon)) return NextResponse.json({ name: null });

  try {
    return NextResponse.json({ name: await reverseGeocode(lat, lon) });
  } catch (err) {
    console.error("reverse geocode failed", err);
    // The name is cosmetic — the forecast does not depend on it. A 200 with
    // nothing keeps this off the page's error path, where it would look like
    // the forecast had failed.
    return NextResponse.json({ name: null });
  }
}
