"use client";

import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "rain:theme";

/**
 * Fallback chrome tint, used only if the stylesheet has not applied yet. The
 * real value is read back off the page below, so the address bar cannot drift
 * from the palette the way a second hardcoded copy would.
 */
const FALLBACK: Record<"light" | "dark", string> = {
  light: "#edf1f3",
  dark: "#080b0e",
};

function paintedGround(fallback: string): string {
  try {
    const v = getComputedStyle(document.body).getPropertyValue("--ground").trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    // Safari private browsing throws on access rather than returning null.
    return "system";
  }
}

/**
 * "system" removes the attribute rather than writing a resolved value, so a
 * phone that flips to dark at sunset follows along without the app watching
 * for it. Writing "light" or "dark" at that moment would freeze it.
 */
function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;

  // The tags in layout.tsx are media-scoped, so an explicit choice needs its
  // own unscoped tag or the browser chrome keeps following the system while
  // the page does not.
  const resolved =
    choice === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      : choice;
  let tag = document.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-explicit]');
  if (!tag) {
    tag = document.createElement("meta");
    tag.name = "theme-color";
    tag.dataset.explicit = "true";
    document.head.appendChild(tag);
  }
  tag.content = paintedGround(FALLBACK[resolved]);
}

const OPTIONS: { value: ThemeChoice; label: string; hint: string }[] = [
  { value: "system", label: "Auto", hint: "Match system setting" },
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Always dark" },
];

export default function ThemeToggle() {
  // Starts at "system" on both server and client so the first render matches
  // the HTML. The inline script in layout.tsx has already painted the stored
  // choice by then, so this only corrects which button looks pressed.
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => setChoice(readStored()), []);

  function pick(next: ThemeChoice) {
    setChoice(next);
    apply(next);
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // Applies for this session; it just will not be remembered.
    }
  }

  return (
    <div className="theme" role="group" aria-label="Colour theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => pick(o.value)}
          aria-pressed={choice === o.value}
          title={o.hint}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
