import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rain — Singapore",
  description:
    "Will it rain where you are, and when will it stop? Built from Singapore's rain gauges and NEA's forecast.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#EDF1F3" },
    { media: "(prefers-color-scheme: dark)", color: "#080B0E" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
