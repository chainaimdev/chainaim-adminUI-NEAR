"use client";
/** Ink (default) / cream switch. The choice is remembered in this browser only; failing storage is harmless. */
import { useEffect, useState } from "react";

type Theme = "ink" | "cream";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("ink");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "cream" ? "cream" : "ink");
  }, []);
  const flip = (): void => {
    const next: Theme = theme === "ink" ? "cream" : "ink";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("cs-theme", next);
    } catch {
      // storage blocked (private window, policy): the theme still changes for this page
    }
    setTheme(next);
  };
  return (
    <button type="button" className="btn" onClick={flip} aria-label={`Switch to ${theme === "ink" ? "cream" : "ink"} theme`}>
      {theme === "ink" ? "◐ Cream theme" : "◑ Ink theme"}
    </button>
  );
}
