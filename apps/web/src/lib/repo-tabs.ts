import { useSyncExternalStore } from "react";

/**
 * Optional tabs on the repo detail page that can be switched off on the Settings page.
 * Overview is always shown. Saved in this browser, like the colour scheme.
 */
export const OPTIONAL_REPO_TABS = [
  { id: "issues", label: "Issues", description: "Open issues from the repository's GitHub remote." },
  { id: "pulls", label: "Pull requests", description: "Open pull requests from the repository's GitHub remote." },
  {
    id: "community",
    label: "Community",
    description: "GitHub's community health score and which recommended files the repository is missing.",
  },
] as const;

export type OptionalRepoTab = (typeof OPTIONAL_REPO_TABS)[number]["id"];

export type RepoTabVisibility = Record<OptionalRepoTab, boolean>;

/** Every tab is on until the user turns it off. */
export const DEFAULT_REPO_TABS: RepoTabVisibility = { issues: true, pulls: true, community: true };

export const REPO_TABS_STORAGE_KEY = "gitlib-repo-tabs";
const REPO_TABS_CHANGE_EVENT = "gitlib-repo-tabs-change";

function parse(raw: string | null): RepoTabVisibility {
  if (!raw) return DEFAULT_REPO_TABS;
  try {
    const stored: unknown = JSON.parse(raw);
    const record = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
    const next = { ...DEFAULT_REPO_TABS };
    for (const { id } of OPTIONAL_REPO_TABS) if (typeof record[id] === "boolean") next[id] = record[id];
    return next;
  } catch {
    return DEFAULT_REPO_TABS;
  }
}

// useSyncExternalStore needs a referentially stable snapshot, so cache by the raw stored string.
let cachedRaw: string | null = null;
let cached: RepoTabVisibility = DEFAULT_REPO_TABS;

export function readRepoTabs(): RepoTabVisibility {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(REPO_TABS_STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); fall back to the defaults.
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

export function setRepoTabVisible(tab: OptionalRepoTab, visible: boolean): void {
  const next = { ...readRepoTabs(), [tab]: visible };
  try {
    localStorage.setItem(REPO_TABS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not persisted; the change below still applies for this page view.
  }
  cachedRaw = null; // force a re-read (or, if storage is blocked, fall back to defaults + this change)
  cached = next;
  window.dispatchEvent(new Event(REPO_TABS_CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(REPO_TABS_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange); // another tab changed it
  return () => {
    window.removeEventListener(REPO_TABS_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Which optional repo tabs are shown (all of them during SSR) and a setter that persists the choice. */
export function useRepoTabs(): [RepoTabVisibility, typeof setRepoTabVisible] {
  const tabs = useSyncExternalStore(subscribe, readRepoTabs, () => DEFAULT_REPO_TABS);
  return [tabs, setRepoTabVisible];
}
