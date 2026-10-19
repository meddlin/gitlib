import { useEffect, useSyncExternalStore } from "react";

/**
 * Colour schemes selectable on the Settings page. The palettes themselves live in
 * styles.css, keyed by `[data-scheme="<id>"]`; `mode` says whether the scheme is
 * built on the light or the dark neutral palette (it drives the `dark` class).
 */
export const THEMES = [
  { id: "system", label: "System", description: "Follow your operating system's light or dark setting.", mode: "system" },
  { id: "light", label: "Light", description: "Clean and bright.", mode: "light" },
  { id: "dark", label: "Dark", description: "Easy on the eyes in low light.", mode: "dark" },
  { id: "ocean", label: "Ocean", description: "Deep blue-tinted dark scheme.", mode: "dark" },
  { id: "forest", label: "Forest", description: "Green-tinted dark scheme.", mode: "dark" },
  { id: "sunset", label: "Sunset", description: "Warm amber-tinted light scheme.", mode: "light" },
  { id: "orchid", label: "Orchid", description: "Soft violet-tinted light scheme.", mode: "light" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "system";
export const THEME_STORAGE_KEY = "gitlib-theme";

const THEME_CHANGE_EVENT = "gitlib-theme-change";

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

/**
 * Runs inline in <head> before first paint so the saved scheme applies without a
 * flash. Self-contained (it is serialised into the page), so it duplicates the
 * small id -> mode table instead of importing it.
 */
export const THEME_SCRIPT = `(function(){var modes=${JSON.stringify(
  Object.fromEntries(THEMES.map((theme) => [theme.id, theme.mode])),
)};var id;try{id=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}if(!modes[id])id=${JSON.stringify(DEFAULT_THEME)};var mode=modes[id];var dark=mode==="system"?matchMedia("(prefers-color-scheme: dark)").matches:mode==="dark";var root=document.documentElement;root.dataset.scheme=id;root.classList.toggle("dark",dark)})()`;

export function readStoredTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(stored)) return stored;
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); fall back to the default.
  }
  return DEFAULT_THEME;
}

/** Apply a scheme to the document without persisting it. */
export function applyTheme(id: ThemeId): void {
  const mode = THEMES.find((theme) => theme.id === id)?.mode ?? "system";
  const dark = mode === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : mode === "dark";
  const root = document.documentElement;
  root.dataset.scheme = id;
  root.classList.toggle("dark", dark);
}

export function setTheme(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // Not persisted, but still applies for this page view.
  }
  applyTheme(id);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange); // another tab changed it
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Current scheme id (the default during SSR) and a setter that persists it. */
export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const theme = useSyncExternalStore(subscribe, readStoredTheme, () => DEFAULT_THEME);
  return [theme, setTheme];
}

/**
 * Keeps the document in step with the stored scheme after load: follows the OS
 * setting while on "system", and picks up changes made in another tab.
 */
export function useThemeSync(): void {
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => applyTheme(readStoredTheme());
    query.addEventListener("change", sync);
    window.addEventListener("storage", sync);
    return () => {
      query.removeEventListener("change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
}
