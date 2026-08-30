"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Place {
  name: string;
  address: string;
  postal: string | null;
  lat: number;
  lon: number;
}

interface Forecast {
  /** probability per lead, +15 .. +120 min */
  p: number[];
  /** low/high across contributing gauges — where they disagree, so should we */
  spread: Array<{ lo: number; hi: number }>;
  /** whether it is raining at the location right now */
  rainingNow: boolean;
  nearestKm: number;
  /** timestamp of the observations behind this, ISO SGT */
  observedAt: string;
  /** true once a reliability diagram justifies the numbers */
  calibrated: boolean;
}

const LEAD_MIN = [15, 30, 45, 60, 75, 90, 105, 120];

/**
 * The headline. This is the product — a sentence, not a chart.
 *
 * Two different questions depending on state: dry means "will it rain?", wet
 * means "when will it stop?". The second is where the model is strongest
 * (+26% over NEA, +33% once rain is settled) and no local product answers it,
 * so the app should notice which you are in rather than making you ask.
 */
function verdict(f: Forecast): { head: string; detail: string } {
  const pct = (i: number) => Math.round(f.p[i] * 100);

  if (f.rainingNow) {
    // First lead where it more likely than not has stopped.
    const stops = f.p.findIndex((p) => p < 0.5);
    if (stops === -1) {
      return { head: "Raining now", detail: "Likely to continue for the next two hours." };
    }
    const mins = LEAD_MIN[stops];
    return {
      head: "Raining now",
      detail:
        mins <= 30
          ? `Should ease within about ${mins} minutes.`
          : `Easing in about ${mins} minutes.`,
    };
  }

  const peak = f.p.reduce((best, p, i) => (p > f.p[best] ? i : best), 0);
  const peakPct = pct(peak);

  if (peakPct < 15) {
    return { head: "Dry", detail: "Nothing on the way for the next two hours." };
  }
  // First lead that crosses a threshold worth acting on.
  const onset = f.p.findIndex((p) => p >= 0.3);
  if (onset === -1) {
    return {
      head: "Probably dry",
      detail: `Around ${peakPct}% at most, near ${LEAD_MIN[peak]} minutes from now.`,
    };
  }
  return {
    head: `Rain likely\nin ~${LEAD_MIN[onset]} min`,
    detail: `Heaviest around ${peakPct}% near ${LEAD_MIN[peak]} minutes.`,
  };
}

function shade(p: number): string {
  if (p < 0.08) return "var(--r0)";
  if (p < 0.25) return "var(--r1)";
  if (p < 0.5) return "var(--r2)";
  if (p < 0.75) return "var(--r3)";
  return "var(--r4)";
}

export default function Page() {
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [place, setPlace] = useState<Place | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadForecast = useCallback(async (p: Place) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/forecast?lat=${p.lat}&lon=${p.lon}`);
      if (!res.ok) throw new Error(String(res.status));
      setForecast(await res.json());
    } catch {
      setForecast(null);
      setError("Can't reach the forecast right now.");
    } finally {
      setBusy(false);
    }
  }, []);

  // Search as you type, debounced. Two characters minimum, matching the API.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (query.trim().length < 2) {
      setPlaces([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const body = await res.json();
        setPlaces(body.results ?? []);
      } catch {
        setPlaces([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError("This browser can't share your location.");
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p: Place = {
          name: "Your location",
          address: "",
          postal: null,
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        };
        setPlace(p);
        setPlaces([]);
        setQuery("");
        void loadForecast(p);
      },
      () => {
        setBusy(false);
        setError("Couldn't get your location. Search for a place instead.");
      },
      { timeout: 8000, maximumAge: 60_000 },
    );
  }, [loadForecast]);

  const pick = (p: Place) => {
    setPlace(p);
    setPlaces([]);
    setQuery("");
    void loadForecast(p);
  };

  const v = forecast ? verdict(forecast) : null;

  return (
    <main className="wrap">
      <div className="card">
        <header className="top">
          <div className="loc">{place ? place.name : "Where are you?"}</div>
          {place && (
            <button className="chg" onClick={() => { setPlace(null); setForecast(null); }}>
              Change
            </button>
          )}
        </header>

        {!place && (
          <div className="find">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a place in Singapore"
              aria-label="Search a place in Singapore"
            />
            <button className="geo" onClick={useMyLocation}>Use my location</button>
            {searching && <p className="hint">Searching…</p>}
            {!!places.length && (
              <ul className="results">
                {places.map((p, i) => (
                  <li key={`${p.name}-${i}`}>
                    <button onClick={() => pick(p)}>
                      <span className="rname">{p.name}</span>
                      <span className="raddr">{p.address}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {busy && <p className="hint pad">Checking the gauges…</p>}
        {error && <p className="err">{error}</p>}

        {forecast && v && !busy && (
          <>
            <section className="verdict">
              <p className="head">{v.head}</p>
              <p className="detail">{v.detail}</p>
            </section>

            <section className="strip" aria-label="Chance of rain by time">
              <div className="bars">
                {forecast.p.map((p, i) => (
                  <div
                    key={i}
                    className="bar"
                    style={{ height: `${Math.max(3, p * 74)}%`, background: shade(p) }}
                    title={`${LEAD_MIN[i]} min: ${Math.round(p * 100)}%`}
                  >
                    {p >= 0.08 && <span>{Math.round(p * 100)}%</span>}
                  </div>
                ))}
              </div>
              <div className="axis">
                <span>NOW</span><span>1 HR</span><span>2 HR</span>
              </div>
            </section>

            <footer className="foot">
              <span>Nearest gauge {forecast.nearestKm.toFixed(1)} km</span>
              <span>{forecast.calibrated ? "Calibrated" : "Estimates uncalibrated"}</span>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
