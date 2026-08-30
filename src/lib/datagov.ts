/**
 * Client for data.gov.sg's v2 realtime API.
 *
 * Server-side only. The API key must never reach a browser — data.gov.sg's own
 * guidance is explicit about that, and this module is the only place that reads
 * it.
 *
 * Rate limits are per 10 seconds, not per minute: 6 unauthenticated, 12 with a
 * Dev key, 30 with Prod. The limit is rarely the real constraint though — each
 * request pays a TLS handshake, so sequential fetching tops out near 0.6 req/s
 * whatever the tier. Connection reuse is what actually buys throughput.
 */
import https from "node:https";

const BASE = "https://api-open.data.gov.sg/v2/real-time/api";

/** Reused across calls so the TLS handshake is paid once, not per request. */
const agent = new https.Agent({ keepAlive: true, maxSockets: 6, keepAliveMsecs: 30_000 });

export type Endpoint =
  | "rainfall"
  | "wind-speed"
  | "wind-direction"
  | "two-hr-forecast";

/** The four endpoints the model consumes. Humidity and temperature were tested and dropped. */
export const ENDPOINTS: Endpoint[] = [
  "rainfall",
  "wind-speed",
  "wind-direction",
  "two-hr-forecast",
];

export interface Reading {
  timestamp: string;
  data: Array<{ stationId: string; value: number }>;
}
export interface StationMeta {
  id: string;
  name: string;
  location: { latitude: number; longitude: number };
}
export interface RealtimePage {
  stations?: StationMeta[];
  readings?: Reading[];
  area_metadata?: Array<{ name: string; label_location: { latitude: number; longitude: number } }>;
  items?: Array<{
    timestamp?: string;
    update_timestamp?: string;
    valid_period: { start: string; end: string };
    forecasts: Array<{ area: string; forecast: string }>;
  }>;
  paginationToken?: string;
}

function request(url: string): Promise<{ status: number; body: string }> {
  const key = process.env.DATAGOV_API_KEY?.trim();
  // Degrade rather than fail when unset: the endpoints still work without a
  // key, just at 0.6 req/s. That keeps local development working before the
  // key exists, and a rotated key throttles the app instead of breaking it.
  const headers: Record<string, string> = key ? { "x-api-key": key } : {};
  return new Promise((resolve) => {
    const req = https.get(url, { agent, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.setTimeout(20_000, () => {
      req.destroy();
      resolve({ status: 0, body: "" });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one endpoint, following pagination.
 *
 * `date` omitted returns the latest reading; supplying one returns that whole
 * day and is how backfill works — the archive reaches back to at least 2017,
 * which is what makes a missed poll recoverable rather than a permanent hole.
 */
export async function fetchEndpoint(
  api: Endpoint,
  opts: { date?: string; maxPages?: number } = {},
): Promise<RealtimePage[]> {
  const pages: RealtimePage[] = [];
  let token: string | undefined;
  const cap = opts.maxPages ?? (opts.date ? 400 : 2);

  for (let i = 0; i < cap; i++) {
    let url = `${BASE}/${api}`;
    const qs: string[] = [];
    if (opts.date) qs.push(`date=${opts.date}`);
    if (token) qs.push(`paginationToken=${encodeURIComponent(token)}`);
    if (qs.length) url += `?${qs.join("&")}`;

    let res = await request(url);
    let backoff = 1500;
    // 429 is a rate limit, not an error. Back off and retry rather than
    // dropping the poll — a missed forecast update costs real accuracy.
    while (res.status === 429 || res.status === 0 || res.status >= 500) {
      if (backoff > 30_000) throw new Error(`${api}: giving up after repeated ${res.status}`);
      await sleep(backoff);
      backoff *= 2;
      res = await request(url);
    }

    let parsed: { code?: number; data?: RealtimePage };
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error(`${api}: unparseable response`);
    }
    if (parsed.code !== 0 || !parsed.data) throw new Error(`${api}: code ${parsed.code}`);

    pages.push(parsed.data);
    token = parsed.data.paginationToken;
    if (!token) break;
  }
  return pages;
}

/**
 * The 15-minute window a timestamp belongs to, as an SGT slot key.
 *
 * Singapore has no DST, so SGT is always UTC+8 and this is exact arithmetic.
 * Deriving the key from the reading's own timestamp rather than the wall clock
 * is what makes polling idempotent: a double fire recomputes the same key and
 * rewrites identical bytes.
 */
export function slotKey(iso: string): string {
  const y = iso.slice(0, 4);
  const mo = iso.slice(5, 7);
  const d = iso.slice(8, 10);
  const h = iso.slice(11, 13);
  const mi = String(Math.floor(Number(iso.slice(14, 16)) / 15) * 15).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}${mi}`;
}

/** Latest reading timestamp in a set of pages, or null if there are none. */
export function latestTimestamp(pages: RealtimePage[]): string | null {
  let latest: string | null = null;
  for (const p of pages) {
    for (const r of p.readings ?? []) {
      if (!latest || r.timestamp > latest) latest = r.timestamp;
    }
    for (const it of p.items ?? []) {
      const t = it.timestamp ?? it.update_timestamp ?? it.valid_period.start;
      if (!latest || t > latest) latest = t;
    }
  }
  return latest;
}
