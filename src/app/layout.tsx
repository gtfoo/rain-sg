import type { Metadata, Viewport } from "next";
import "./globals.css";
import ThemeToggle from "./ThemeToggle";

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
      <head>
        {/*
          Applies a stored theme BEFORE first paint. A React effect runs after
          paint, which is too late: the page would render in the system theme
          and snap to the chosen one. That flash is worst for someone who
          picked light on a dark-mode phone — exactly the person who bothered.

          try/catch because localStorage throws outright in Safari private
          browsing rather than returning null.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('rain:theme');" +
              "if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}",
          }}
        />
      </head>
      <body>
        <ThemeToggle />
        {children}
      </body>
    </html>
  );
}
