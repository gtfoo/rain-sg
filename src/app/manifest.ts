import type { MetadataRoute } from "next";

/**
 * What makes the app installable rather than downloadable.
 *
 * Without this, Chrome has nothing to install and offers "Save page as…"
 * instead — which is what the site was doing: saving the HTML to Downloads.
 * `display: standalone` is the line that drops the browser chrome so it opens
 * like an app, and the 512px icon is what Chrome checks before offering at all.
 *
 * Colours match the dark palette in globals.css, so the splash screen and the
 * app itself are the same colour rather than flashing white on launch.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Rain SG — will it rain where you are?",
    short_name: "Rain SG",
    description:
      "A two-hour rain forecast for your exact spot in Singapore, in 15-minute steps. Leads with when the rain will stop, and says where the rain already is.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#080b0e",
    theme_color: "#080b0e",
    categories: ["weather", "utilities"],
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
