import { ImageResponse } from "next/og";

/**
 * iOS does not read the manifest's icons for "Add to Home Screen" — it looks
 * for this. Without it the home-screen tile is a screenshot of the page.
 *
 * 180px is what iOS asks for, and unlike the maskable Android icon it is never
 * cropped, so the drop can sit larger in the frame.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
            width: 104,
            height: 104,
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
