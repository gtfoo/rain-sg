/**
 * Forecast for a point. Reads only from disk — never calls data.gov.sg, so a
 * page load cannot wait on an upstream fetch or be affected by a rate limit.
 */
import { NextRequest, NextResponse } from "next/server";
import modelJson from "@/model/model.json";
import type { Model, Station } from "@/lib/forecast";
import { buildFeatures, forecastAtPoint, kmBetween } from "@/lib/forecast";
import { loadObservations, neighboursOf, areaFor } from "@/lib/observations";
import { inSingapore } from "@/lib/onemap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const model = modelJson as unknown as Model;

export async function GET(req: NextRequest) {
  const lat = Number(req.nextUrl.searchParams.get("lat"));
  const lon = Number(req.nextUrl.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat and lon are required" }, { status: 400 });
  }
  if (!inSingapore(lat, lon)) {
    return NextResponse.json(
      { error: "Outside Singapore — there are no gauges to forecast from." },
      { status: 422 },
    );
  }

  const obs = loadObservations(4);
  if (!obs.stations.length || !obs.observedAt) {
    // No stored observations yet: say so rather than inventing a forecast.
    return NextResponse.json(
      { error: "No recent observations. The poller may not have run yet." },
      { status: 503 },
    );
  }

  // SGT is UTC+8 year-round, so this is exact arithmetic rather than a guess.
  const sgt = new Date(Date.now() + 8 * 3600 * 1000);
  const hour = sgt.getUTCHours();
  const month = sgt.getUTCMonth();

  const featuresFor = (s: Station, lead: number) =>
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

  const out = forecastAtPoint(model, { lat, lon }, featuresFor, obs.stations, 4);
  if (!out) {
    return NextResponse.json(
      { error: "Not enough reporting gauges nearby right now." },
      { status: 503 },
    );
  }

  // "Raining now" is taken from the nearest gauge that is actually reporting,
  // not interpolated: it is an observation and should stay one.
  const nearest = obs.stations
    .map((s) => ({ s, km: kmBetween({ lat, lon }, s) }))
    .sort((a, b) => a.km - b.km)
    .find(({ s }) => obs.history[0].wet.has(s.id));
  const rainingNow = nearest ? obs.history[0].wet.get(nearest.s.id) === 1 : false;

  return NextResponse.json({
    p: out.p,
    spread: out.spread,
    rainingNow,
    nearestKm: out.nearestKm,
    observedAt: obs.observedAt,
    // Flipped only once a reliability diagram shows 70% has meant 70%.
    calibrated: false,
  });
}
