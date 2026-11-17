import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage, stubWindow } from "./browser-stubs";

type RepoTabs = typeof import("../src/lib/repo-tabs");

// The module caches the last value it read, so each test gets a fresh copy.
let tabs: RepoTabs;

beforeEach(async () => {
  vi.resetModules();
  tabs = await import("../src/lib/repo-tabs");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readRepoTabs", () => {
  it("shows every tab when nothing is saved", () => {
    stubLocalStorage();
    expect(tabs.readRepoTabs()).toEqual({ issues: true, pulls: true, community: true });
  });

  it("applies saved choices on top of the defaults", () => {
    stubLocalStorage({ initial: { [tabs.REPO_TABS_STORAGE_KEY]: JSON.stringify({ pulls: false }) } });
    expect(tabs.readRepoTabs()).toEqual({ issues: true, pulls: false, community: true });
  });

  it("ignores unknown tabs and values that are not booleans", () => {
    stubLocalStorage({
      initial: { [tabs.REPO_TABS_STORAGE_KEY]: JSON.stringify({ issues: "no", pulls: 0, community: false, wiki: false }) },
    });
    expect(tabs.readRepoTabs()).toEqual({ issues: true, pulls: true, community: false });
  });

  it.each(["not json", "null", "42", '"issues"', "[]"])("falls back to the defaults for stored %s", (raw) => {
    stubLocalStorage({ initial: { [tabs.REPO_TABS_STORAGE_KEY]: raw } });
    expect(tabs.readRepoTabs()).toEqual(tabs.DEFAULT_REPO_TABS);
  });

  it("falls back to the defaults when storage is unavailable", () => {
    stubLocalStorage({ broken: true });
    expect(tabs.readRepoTabs()).toEqual(tabs.DEFAULT_REPO_TABS);
  });

  it("returns the same object while the stored value is unchanged", () => {
    // useSyncExternalStore re-renders forever if the snapshot is a new object on every read.
    stubLocalStorage({ initial: { [tabs.REPO_TABS_STORAGE_KEY]: JSON.stringify({ issues: false }) } });
    expect(tabs.readRepoTabs()).toBe(tabs.readRepoTabs());
  });

  it("picks up a change made elsewhere, such as another browser tab", () => {
    const { storage } = stubLocalStorage();
    expect(tabs.readRepoTabs().issues).toBe(true);
    storage.setItem(tabs.REPO_TABS_STORAGE_KEY, JSON.stringify({ issues: false }));
    expect(tabs.readRepoTabs().issues).toBe(false);
  });
});

describe("setRepoTabVisible", () => {
  it("saves the choice and keeps the other tabs as they were", () => {
    const { data } = stubLocalStorage({ initial: { [tabs.REPO_TABS_STORAGE_KEY]: JSON.stringify({ issues: false }) } });
    stubWindow();

    tabs.setRepoTabVisible("community", false);

    expect(JSON.parse(data.get(tabs.REPO_TABS_STORAGE_KEY)!)).toEqual({ issues: false, pulls: true, community: false });
    expect(tabs.readRepoTabs()).toEqual({ issues: false, pulls: true, community: false });
  });

  it("can switch a tab back on", () => {
    stubLocalStorage();
    stubWindow();
    tabs.setRepoTabVisible("pulls", false);
    tabs.setRepoTabVisible("pulls", true);
    expect(tabs.readRepoTabs().pulls).toBe(true);
  });

  it("tells subscribers about the change", () => {
    stubLocalStorage();
    const target = stubWindow();
    const listener = vi.fn();
    target.addEventListener("gitlib-repo-tabs-change", listener);

    tabs.setRepoTabVisible("issues", false);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("still applies the change for this page view when storage is unavailable", () => {
    stubLocalStorage({ broken: true });
    stubWindow();

    tabs.setRepoTabVisible("issues", false);

    expect(tabs.readRepoTabs()).toEqual({ issues: false, pulls: true, community: true });
  });
});

describe("OPTIONAL_REPO_TABS", () => {
  it("describes exactly the tabs that have a visibility setting", () => {
    expect(tabs.OPTIONAL_REPO_TABS.map((tab) => tab.id).sort()).toEqual(Object.keys(tabs.DEFAULT_REPO_TABS).sort());
  });
});
