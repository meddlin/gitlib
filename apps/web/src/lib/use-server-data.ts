import { useEffect, useState } from "react";

export type ServerData<T> = { status: "loading" } | { status: "done"; value: T };

/**
 * Loads data for one repo when the component mounts and again when `key` changes; "loading" until it
 * arrives. A rejected call is turned into a value by `onError` so callers only handle one shape.
 */
export function useServerData<T>(key: string, load: (key: string) => Promise<T>, onError: (message: string) => T): ServerData<T> {
  const [state, setState] = useState<{ key: string; value: T } | null>(null);

  useEffect(() => {
    let cancelled = false;
    load(key)
      .then((value) => !cancelled && setState({ key, value }))
      .catch((caught: unknown) => {
        if (!cancelled) setState({ key, value: onError(caught instanceof Error ? caught.message : "Something went wrong.") });
      });
    return () => {
      cancelled = true;
    };
    // `load` and `onError` are module-level functions in every caller, so `key` is the only real input.
  }, [key]);

  return state && state.key === key ? { status: "done", value: state.value } : { status: "loading" };
}
