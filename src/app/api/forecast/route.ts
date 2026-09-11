/**
 * Forecast for a point. Reads only from disk — never calls data.gov.sg, so a
 * page load cannot wait on an upstream fetch or be affected by a rate limit.
 */
import { NextRequest, NextResponse } from "next/server";
import modelJson from "@/model/model.json";
import type { Model } from "@/lib/forecast";
import {
  forecastAtPoint, cumulative, upwindRain, upwindClearing, kmBetween,
} from "@/lib/forecast";
import { loadObservations, makeFeaturesFor } from "@/lib/observations";
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

  const featuresFor = makeFeaturesFor(model, obs);

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
    // Chance of ANY rain by each horizon. Sent from here rather than
    // derived on the client, because turning eight per-window numbers
    // into this one needs a calibration that lives in the model file.
    cum: cumulative(model, out.p),
    // Two halves of one question, and which one applies depends on whether you
    // are already in the rain. Dry: where is it coming from. Wet: where has it
    // already finished.
    upwind: rainingNow
      ? null
      : upwindRain({ lat, lon }, obs.stations, obs.history[0].wet, obs.wind, obs.areas),
    clearing: rainingNow
      ? upwindClearing(
          { lat, lon }, obs.stations,
          obs.history[0].wet, obs.history[2]?.wet ?? new Map(),
          obs.wind, obs.areas,
        )
      : null,
    spread: out.spread,
    rainingNow,
    nearestKm: out.nearestKm,
    observedAt: obs.observedAt,
    // Flipped only once a reliability diagram shows 70% has meant 70%.
    calibrated: false,
  });
}
