/**
 * OneMap: turning what someone types into a coordinate.
 *
 * Adapted from carpark-sg, which has already found the edge cases. Two of them
 * are load-bearing and are kept here deliberately:
 *
 *  - the token is minted from email+password, never pasted. OneMap tokens last
 *    ~3 days, so a pasted ONEMAP_TOKEN works on the day you set it and silently
 *    fails on the droplet by the weekend.
 *  - the header is `Authorization: <token>`, NOT `Bearer <token>`.
 *
 * Server-side only: credentials never reach a browser.
 */

const TOKEN_URL = "https://www.onemap.gov.sg/api/auth/post/getToken";
const SEARCH_URL = "https://www.onemap.gov.sg/api/common/elastic/search";

/** Refresh well before expiry rather than racing the deadline. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

let cached: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<string | null> | null = null;

export async function getToken(): Promise<string | null> {
  const manual = process.env.ONEMAP_TOKEN?.trim();
  if (manual) return manual;

  const email = process.env.ONEMAP_EMAIL?.trim();
  const password = process.env.ONEMAP_PASSWORD;
  if (!email || !password) return null;

  if (cached && Date.now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;

  // Collapse concurrent callers onto one token request rather than stampeding.
  if (inFlight) return inFlight;
  inFlight = mint(email, password).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function mint(email: string, password: string): Promise<string | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      // Deliberately does not echo the body — it can contain the submitted
      // credentials.
      console.error(`OneMap token request failed: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { access_token?: string; expiry_timestamp?: string | number };
    if (!body.access_token) {
      console.error("OneMap token response contained no access_token");
      return null;
    }
    const n = Number(body.expiry_timestamp);
    cached = {
      token: body.access_token,
      expiresAt: Number.isFinite(n) && n > 0 ? n * 1000 : Date.now() + 24 * 60 * 60 * 1000,
    };
    return cached.token;
  } catch (err) {
    console.error("OneMap token request threw", err);
    return null;
  }
}

export interface Place {
  name: string;
  address: string;
  postal: string | null;
  lat: number;
  lon: number;
}

/**
 * OneMap cannot find a building by its own name when that name contains "&".
 * "TEKKA MARKET & FOOD CENTRE" is indexed under exactly that string and returns
 * nothing; drop the ampersand and it is found. Substituting "and" does not work.
 *
 * That matters more than one hawker centre suggests: "Market & Food Centre" is a
 * naming convention across Singapore, so every one of them is unsearchable.
 */
function retrySpelling(query: string): string | null {
  if (!query.includes("&")) return null;
  const stripped = query.replace(/&/g, " ").replace(/\s{2,}/g, " ").trim();
  return stripped && stripped !== query.trim() ? stripped : null;
}

interface SearchHit {
  SEARCHVAL: string;
  ADDRESS: string;
  POSTAL: string;
  LATITUDE: string;
  LONGITUDE: string;
}

/** Up to `limit` matches for a free-text query, best first. */
export async function search(query: string, limit = 5): Promise<Place[]> {
  const q = query.trim();
  if (!q) return [];

  const url =
    `${SEARCH_URL}?searchVal=${encodeURIComponent(q)}` +
    `&returnGeom=Y&getAddrDetails=Y&pageNum=1`;

  const token = await getToken();
  const res = await fetch(url, token ? { headers: { Authorization: token } } : undefined);
  if (!res.ok) throw new Error(`OneMap search failed: HTTP ${res.status}`);

  const body = (await res.json()) as { found?: number; results?: SearchHit[] };
  const hits = body.results ?? [];

  if (!hits.length) {
    // Only ever one retry deep: retrySpelling returns null for its own output,
    // so this cannot recurse.
    const again = retrySpelling(q);
    return again ? search(again, limit) : [];
  }

  return hits.slice(0, limit).map((h) => ({
    name: h.SEARCHVAL,
    address: h.ADDRESS,
    postal: h.POSTAL && h.POSTAL !== "NIL" ? h.POSTAL : null,
    lat: Number(h.LATITUDE),
    lon: Number(h.LONGITUDE),
  }));
}

/** Rough bounds of Singapore, for rejecting coordinates we cannot forecast. */
export const SG_BOUNDS = { minLat: 1.13, maxLat: 1.49, minLon: 103.58, maxLon: 104.14 };

export function inSingapore(lat: number, lon: number): boolean {
  return (
    lat >= SG_BOUNDS.minLat &&
    lat <= SG_BOUNDS.maxLat &&
    lon >= SG_BOUNDS.minLon &&
    lon <= SG_BOUNDS.maxLon
  );
}
