import { ImageResponse } from "next/og";

/**
 * Home-screen and tab icon.
 *
 * A generated PNG rather than the SVG this replaced, because that is what makes
 * the app installable: Chrome wants a raster icon of at least 192px declared in
 * the manifest before it will offer "Install" instead of "Save page as".
 *
 * The drop is a square with three rounded corners, rotated — Satori renders a
 * subset of CSS and this shape needs none of the parts it lacks. It sits at 52%
 * of the canvas so it survives a maskable crop, which keeps the safe zone to the
 * middle 80%.
 */
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0e1317",
        }}
      >
        <div
          style={{
            width: 265,
            height: 265,
            background: "#5aaee0",
            borderRadius: "50% 50% 50% 4%",
            transform: "rotate(-45deg)",
          }}
        />
      </div>
    ),
    size,
  );
}
