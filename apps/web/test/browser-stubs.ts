import { vi } from "vitest";

/** An in-memory `localStorage`. Pass `broken: true` to make every call throw, like private mode or blocked cookies. */
export function stubLocalStorage(options: { broken?: boolean; initial?: Record<string, string> } = {}) {
  const data = new Map(Object.entries(options.initial ?? {}));
  const guard = <T>(fn: () => T): T => {
    if (options.broken) throw new DOMException("Storage is unavailable", "SecurityError");
    return fn();
  };
  const storage = {
    getItem: (key: string) => guard(() => data.get(key) ?? null),
    setItem: (key: string, value: string) => guard(() => void data.set(key, value)),
    removeItem: (key: string) => guard(() => void data.delete(key)),
  };
  vi.stubGlobal("localStorage", storage);
  return { data, storage };
}

/** A `window` that is just an event target: enough for code that only subscribes to and dispatches events. */
export function stubWindow() {
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  return target;
}
