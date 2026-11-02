import { useEffect, useState } from "react";
import { getDependabotBadge, type DependabotBadge } from "#/server/dependabot";

const CHANGED = "gitlib:dependabot-changed";
/** The NavBar reads the saved check, which a schedule or the CLI can replace at any time. */
const POLL_MS = 60_000;

/** Tells every NavBar badge on the page to read the saved check again, e.g. after "Check now". */
export function notifyDependabotChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

/** The numbers behind the Dependabot badge; null until the first read, or if reading fails. */
export function useDependabotBadge(): DependabotBadge | null {
  const [badge, setBadge] = useState<DependabotBadge | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getDependabotBadge()
        .then((value) => !cancelled && setBadge(value))
        // A badge that cannot be read is simply absent; it must never break the page around it.
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void load();
    window.addEventListener(CHANGED, load);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(CHANGED, load);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return badge;
}
