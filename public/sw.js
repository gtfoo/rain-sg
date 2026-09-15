/*
 * Offline shell for Rain SG.
 *
 * Two jobs. It is what Chrome checks for before offering to install the app at
 * all, and it means opening the icon without signal shows the app saying so
 * rather than the browser's error page.
 *
 * WHAT IS NEVER CACHED: anything under /api/. This is a NOWCAST — the whole
 * claim is "in the next fifteen minutes" — so a cached forecast is not merely
 * stale, it is actively wrong in the way the app exists to avoid. A page that
 * cheerfully redisplays "Rain likely in ~15 min" from an hour ago is worse than
 * one that admits it cannot reach the server. The forecast route already
 * refuses observations older than an hour; caching its answer here would sneak
 * that failure back in below the level it can see.
 */
const VERSION = "v1";
const SHELL = `shell-${VERSION}`;
const STATIC = `static-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.add("/"))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => !n.endsWith(VERSION)).map((n) => caches.delete(n))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cached, see above

  // Next's hashed build output is immutable, so cache-first is safe and is what
  // makes a cold offline load instant.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // The page itself: network first, so a deploy is picked up immediately and a
  // cached HTML can never reference chunks that no longer exist. The cache is
  // only there for when the network is not.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit || Response.error())),
    );
  }
});
