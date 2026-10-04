import { useEffect, useState } from "react";

export function useTheme() {
  const [dark, setDark] = useState(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem("slide-notes:theme"); } catch { /* Fall back to the system theme. */ }
    return saved ? saved === "dark" : !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try { localStorage.setItem("slide-notes:theme", dark ? "dark" : "light"); } catch { /* Theme still works when storage is unavailable. */ }
  }, [dark]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === "slide-notes:theme") setDark(event.newValue === "dark"); };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return { dark, toggleTheme: () => setDark(value => !value) };
}
