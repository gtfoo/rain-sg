"use client";

import { useEffect, useState } from "react";

/**
 * Registers the offline shell, and says so when there is no connection.
 *
 * The banner matters more here than the caching does. Installed to a home
 * screen, this looks like a native app, and a native-looking app that opens to
 * a forecast is trusted — so it has to be obvious when the number on screen
 * cannot have been refreshed. A nowcast nobody can refresh is just a picture of
 * the past.
 */
export default function ServiceWorker() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      // After load, so registration never competes with the first paint.
      const register = () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {
          // Unsupported, blocked, or private browsing. The app works without
          // it; offline is simply not available.
        });
      };
      if (document.readyState === "complete") register();
      else window.addEventListener("load", register, { once: true });
    }

    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  if (!offline) return null;
  return (
    <p className="offline" role="status">
      You&apos;re offline — this forecast cannot be refreshed, so treat it as
      the last one that reached you rather than the current one.
    </p>
  );
}
