import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME,
  THEMES,
  THEME_SCRIPT,
  THEME_STORAGE_KEY,
  applyTheme,
  isThemeId,
  readStoredTheme,
  setTheme,
} from "../src/lib/themes";
import { stubLocalStorage, stubWindow } from "./browser-stubs";

/** Just enough of `document.documentElement` and `matchMedia` to observe what a theme does to the page. */
function fakeDom(prefersDark: boolean) {
  const classes = new Set<string>();
  const documentElement = {
    dataset: {} as Record<string, string>,
    classList: {
      toggle: (name: string, force: boolean) => void (force ? classes.add(name) : classes.delete(name)),
    },
  };
  const matchMedia = (query: string) => ({ matches: query.includes("dark") && prefersDark });
  return { documentElement, classes, matchMedia };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("THEMES", () => {
  it("has unique ids, and includes the default", () => {
    const ids = THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_THEME);
  });

  it("gives every theme a mode the page can act on", () => {
    for (const theme of THEMES) expect(["system", "light", "dark"]).toContain(theme.mode);
  });
});

describe("isThemeId", () => {
  it("accepts known ids only", () => {
    for (const theme of THEMES) expect(isThemeId(theme.id)).toBe(true);
    for (const value of ["", "Dark", "neon", null, undefined, 1, {}]) expect(isThemeId(value)).toBe(false);
  });
});

describe("readStoredTheme", () => {
  it("returns the saved theme", () => {
    stubLocalStorage({ initial: { [THEME_STORAGE_KEY]: "ocean" } });
    expect(readStoredTheme()).toBe("ocean");
  });

  it("falls back to the default for nothing saved or an unknown id", () => {
    stubLocalStorage();
    expect(readStoredTheme()).toBe(DEFAULT_THEME);
    stubLocalStorage({ initial: { [THEME_STORAGE_KEY]: "neon" } });
    expect(readStoredTheme()).toBe(DEFAULT_THEME);
  });

  it("falls back to the default when storage is unavailable", () => {
    stubLocalStorage({ broken: true });
    expect(readStoredTheme()).toBe(DEFAULT_THEME);
  });
});

describe("applyTheme", () => {
  it("sets the scheme and the dark class from the theme's own mode", () => {
    const dom = fakeDom(false);
    vi.stubGlobal("document", { documentElement: dom.documentElement });
    vi.stubGlobal("matchMedia", dom.matchMedia);

    applyTheme("ocean");
    expect(dom.documentElement.dataset["scheme"]).toBe("ocean");
    expect(dom.classes.has("dark")).toBe(true);

    applyTheme("sunset");
    expect(dom.documentElement.dataset["scheme"]).toBe("sunset");
    expect(dom.classes.has("dark")).toBe(false);
  });

  it("follows the operating system for the system theme", () => {
    for (const prefersDark of [true, false]) {
      const dom = fakeDom(prefersDark);
      vi.stubGlobal("document", { documentElement: dom.documentElement });
      vi.stubGlobal("matchMedia", dom.matchMedia);

      applyTheme("system");

      expect(dom.documentElement.dataset["scheme"]).toBe("system");
      expect(dom.classes.has("dark")).toBe(prefersDark);
    }
  });
});

describe("setTheme", () => {
  it("saves the theme, applies it, and tells subscribers", () => {
    const { data } = stubLocalStorage();
    const target = stubWindow();
    const dom = fakeDom(false);
    vi.stubGlobal("document", { documentElement: dom.documentElement });
    vi.stubGlobal("matchMedia", dom.matchMedia);
    const listener = vi.fn();
    target.addEventListener("gitlib-theme-change", listener);

    setTheme("forest");

    expect(data.get(THEME_STORAGE_KEY)).toBe("forest");
    expect(dom.documentElement.dataset["scheme"]).toBe("forest");
    expect(dom.classes.has("dark")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("still applies the theme when storage is unavailable", () => {
    stubLocalStorage({ broken: true });
    stubWindow();
    const dom = fakeDom(false);
    vi.stubGlobal("document", { documentElement: dom.documentElement });
    vi.stubGlobal("matchMedia", dom.matchMedia);

    setTheme("orchid");

    expect(dom.documentElement.dataset["scheme"]).toBe("orchid");
  });
});

describe("THEME_SCRIPT", () => {
  // The script is serialised into the page <head> and runs before React, so it must work on its own.
  function run(options: { stored?: string; prefersDark?: boolean; brokenStorage?: boolean }) {
    const dom = fakeDom(options.prefersDark ?? false);
    const localStorage = {
      getItem: () => {
        if (options.brokenStorage) throw new Error("blocked");
        return options.stored ?? null;
      },
    };
    vm.runInNewContext(THEME_SCRIPT, {
      localStorage,
      matchMedia: dom.matchMedia,
      document: { documentElement: dom.documentElement },
    });
    return dom;
  }

  it("applies the saved theme before first paint", () => {
    const dom = run({ stored: "ocean" });
    expect(dom.documentElement.dataset["scheme"]).toBe("ocean");
    expect(dom.classes.has("dark")).toBe(true);
  });

  it("agrees with applyTheme for every theme", () => {
    for (const theme of THEMES) {
      for (const prefersDark of [true, false]) {
        const fromScript = run({ stored: theme.id, prefersDark });

        const fromApp = fakeDom(prefersDark);
        vi.stubGlobal("document", { documentElement: fromApp.documentElement });
        vi.stubGlobal("matchMedia", fromApp.matchMedia);
        applyTheme(theme.id);

        expect(fromScript.documentElement.dataset["scheme"], `${theme.id} scheme`).toBe(fromApp.documentElement.dataset["scheme"]);
        expect(fromScript.classes.has("dark"), `${theme.id} dark (OS prefers dark: ${prefersDark})`).toBe(fromApp.classes.has("dark"));
      }
    }
  });

  it("uses the default theme when nothing valid is saved, or storage throws", () => {
    for (const options of [{}, { stored: "neon" }, { brokenStorage: true }]) {
      const dom = run({ ...options, prefersDark: true });
      expect(dom.documentElement.dataset["scheme"]).toBe(DEFAULT_THEME);
      expect(dom.classes.has("dark")).toBe(true); // "system" follows the OS preference
    }
  });
});
