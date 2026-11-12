import { describe, expect, it } from "vitest";
import {
  COMMUNITY_ITEMS,
  COMMUNITY_SCOPES,
  DEFAULT_COMMUNITY_SCOPE,
  isStale,
  missingItems,
  oldestFetchedAt,
  parseCommunityProfile,
  parseCommunityScope,
  parseStoredProfile,
  planningIssueDraft,
  refreshIntervalMs,
  scoreTone,
  serializeProfile,
} from "../src/lib/community";
import { formatAgo } from "../src/lib/format";

/** Shaped like a real response from `GET /repos/meddlin/gitlib/community/profile`. */
const sparse = {
  health_percentage: 28,
  description: "CLI interface to manage local git repos",
  documentation: "https://github.com/meddlin/gitlib/tree/master/docs",
  files: {
    code_of_conduct: null,
    code_of_conduct_file: null,
    contributing: null,
    issue_template: null,
    pull_request_template: null,
    license: null,
    readme: {
      url: "https://api.github.com/repos/meddlin/gitlib/contents/README.md",
      html_url: "https://github.com/meddlin/gitlib/blob/main/README.md",
    },
  },
  updated_at: null,
};

describe("parseCommunityProfile", () => {
  it("reports GitHub's score and which files are missing", () => {
    const profile = parseCommunityProfile(sparse);
    expect(profile.score).toBe(28);
    expect(profile.items.filter((item) => item.present).map((item) => item.id)).toEqual(["description", "readme"]);
    expect(missingItems(profile).map((item) => item.label)).toEqual([
      "License",
      "Code of conduct",
      "Contributing guide",
      "Issue template",
      "Pull request template",
    ]);
  });

  it("links present files to GitHub", () => {
    const readme = parseCommunityProfile(sparse).items.find((item) => item.id === "readme");
    expect(readme?.url).toBe("https://github.com/meddlin/gitlib/blob/main/README.md");
  });

  it("treats a blank description as missing", () => {
    const profile = parseCommunityProfile({ ...sparse, description: "   " });
    expect(profile.items.find((item) => item.id === "description")?.present).toBe(false);
    expect(parseCommunityProfile({ ...sparse, description: null }).items[0]?.present).toBe(false);
  });

  it("finds a full set of files", () => {
    const entry = { url: "https://api.github.com/x", html_url: "https://github.com/o/r/blob/main/X.md" };
    const profile = parseCommunityProfile({
      health_percentage: 100,
      description: "d",
      files: {
        code_of_conduct: { name: "Contributor Covenant", key: "contributor_covenant", url: "u", html_url: null },
        code_of_conduct_file: entry,
        contributing: entry,
        issue_template: entry,
        pull_request_template: entry,
        license: { ...entry, name: "MIT License", key: "mit" },
        readme: entry,
      },
    });
    expect(profile.score).toBe(100);
    expect(missingItems(profile)).toEqual([]);
  });

  it("falls back to code_of_conduct when the file entry is absent", () => {
    const profile = parseCommunityProfile({
      ...sparse,
      files: { ...sparse.files, code_of_conduct: { name: "Contributor Covenant", html_url: null } },
    });
    expect(profile.items.find((item) => item.id === "code_of_conduct")?.present).toBe(true);
  });

  it("never links outside github.com", () => {
    const profile = parseCommunityProfile({
      ...sparse,
      files: { ...sparse.files, readme: { html_url: "javascript:alert(1)" }, license: { html_url: "https://evil.example/x" } },
    });
    expect(profile.items.find((item) => item.id === "readme")).toMatchObject({ present: true, url: null });
    expect(profile.items.find((item) => item.id === "license")).toMatchObject({ present: true, url: null });
  });

  it("clamps and rounds the score", () => {
    expect(parseCommunityProfile({ ...sparse, health_percentage: 130 }).score).toBe(100);
    expect(parseCommunityProfile({ ...sparse, health_percentage: -4 }).score).toBe(0);
    expect(parseCommunityProfile({ ...sparse, health_percentage: 57.6 }).score).toBe(58);
  });

  it("rejects bodies that aren't a community profile", () => {
    expect(() => parseCommunityProfile(null)).toThrow(/unexpected community profile/);
    expect(() => parseCommunityProfile({ message: "Moved Permanently" })).toThrow(/unexpected community profile/);
    expect(() => parseCommunityProfile({ health_percentage: "28" })).toThrow(/unexpected community profile/);
  });

  it("copes with a missing files object", () => {
    const profile = parseCommunityProfile({ health_percentage: 10, description: null });
    expect(missingItems(profile)).toHaveLength(7);
  });
});

describe("scoreTone", () => {
  it("bands scores", () => {
    expect(scoreTone(100)).toBe("good");
    expect(scoreTone(80)).toBe("good");
    expect(scoreTone(79)).toBe("fair");
    expect(scoreTone(50)).toBe("fair");
    expect(scoreTone(49)).toBe("poor");
    expect(scoreTone(0)).toBe("poor");
  });
});

describe("planningIssueDraft", () => {
  it("titles each item distinctly, so a filed issue can be recognised by its title", () => {
    const titles = COMMUNITY_ITEMS.map((item) => item.task);
    expect(new Set(titles).size).toBe(COMMUNITY_ITEMS.length);
    expect(titles.every((title) => title.length > 0 && title.length <= 120)).toBe(true);
  });

  it("explains where the item came from and links to the community page", () => {
    const license = COMMUNITY_ITEMS.find((item) => item.id === "license")!;
    const draft = planningIssueDraft(license, { slug: "meddlin/gitlib", score: 28 });
    expect(draft.title).toBe("Add a license");
    expect(draft.body).toContain("meddlin/gitlib");
    expect(draft.body).toContain("28%");
    expect(draft.body).toContain("https://github.com/meddlin/gitlib/community");
    expect(draft.body).toContain(license.hint);
  });
});

describe("stored profiles", () => {
  it("round-trips through the database payload", () => {
    const profile = parseCommunityProfile(sparse);
    expect(parseStoredProfile(serializeProfile(profile))).toEqual(profile);
  });

  it("keeps only what GitHub reported, so labels and hints can change later", () => {
    const stored = JSON.parse(serializeProfile(parseCommunityProfile(sparse)));
    expect(Object.keys(stored.items[0]).sort()).toEqual(["id", "present", "url"]);
    expect(JSON.stringify(stored)).not.toContain("hint");
  });

  it("rejects payloads it can't trust", () => {
    expect(parseStoredProfile("not json")).toBeNull();
    expect(parseStoredProfile("null")).toBeNull();
    expect(parseStoredProfile(JSON.stringify({ score: "28", items: [] }))).toBeNull();
    // Saved before a checklist item existed: better to fetch again than to show a partial checklist.
    const partial = JSON.parse(serializeProfile(parseCommunityProfile(sparse)));
    partial.items.pop();
    expect(parseStoredProfile(JSON.stringify(partial))).toBeNull();
  });

  it("never yields a link outside github.com, even from a tampered row", () => {
    const tampered = JSON.parse(serializeProfile(parseCommunityProfile(sparse)));
    tampered.items[1].url = "javascript:alert(1)";
    expect(parseStoredProfile(JSON.stringify(tampered))?.items[1]?.url).toBeNull();
  });
});

describe("refreshIntervalMs", () => {
  const HOUR = 3_600_000;

  it("defaults to a day", () => {
    expect(refreshIntervalMs(undefined)).toBe(24 * HOUR);
    expect(refreshIntervalMs("")).toBe(24 * HOUR);
    expect(refreshIntervalMs("  ")).toBe(24 * HOUR);
  });

  it("takes hours, decimals included", () => {
    expect(refreshIntervalMs("6")).toBe(6 * HOUR);
    expect(refreshIntervalMs("0.5")).toBe(HOUR / 2);
  });

  it("treats 0 as off and nonsense as the default", () => {
    expect(refreshIntervalMs("0")).toBeNull();
    expect(refreshIntervalMs("soon")).toBe(24 * HOUR);
    expect(refreshIntervalMs("-3")).toBe(24 * HOUR);
  });
});

describe("isStale", () => {
  const now = Date.parse("2026-11-02T12:00:00+00:00");
  const DAY = 24 * 3_600_000;

  it("is due when never fetched or unreadable", () => {
    expect(isStale(undefined, now, DAY)).toBe(true);
    expect(isStale("yesterday-ish", now, DAY)).toBe(true);
  });

  it("is due once the interval has passed", () => {
    expect(isStale("2026-11-02T00:00:00+00:00", now, DAY)).toBe(false);
    expect(isStale("2026-11-01T12:00:00+00:00", now, DAY)).toBe(true);
    expect(isStale("2026-10-20T00:00:00+00:00", now, DAY)).toBe(true);
  });
});

describe("formatAgo", () => {
  const now = Date.parse("2026-11-02T12:00:00+00:00");

  it("reads at a glance", () => {
    expect(formatAgo("2026-11-02T11:59:40+00:00", now)).toBe("just now");
    expect(formatAgo("2026-11-02T11:15:00+00:00", now)).toBe("45 min ago");
    expect(formatAgo("2026-11-02T07:00:00+00:00", now)).toBe("5 h ago");
    expect(formatAgo("2026-10-30T12:00:00+00:00", now)).toBe("3 days ago");
    expect(formatAgo("garbage", now)).toBe("");
  });
});

describe("parseCommunityScope", () => {
  it("scores only favorites unless told otherwise", () => {
    expect(DEFAULT_COMMUNITY_SCOPE).toBe("favorites");
    expect(COMMUNITY_SCOPES).toEqual(["favorites", "all"]);
  });

  it("reads a saved choice", () => {
    expect(parseCommunityScope("all")).toBe("all");
    expect(parseCommunityScope("favorites")).toBe("favorites");
  });

  it("falls back to the default for anything else", () => {
    for (const raw of [undefined, null, "", "everyone", "ALL", 1, true, {}, ["all"]]) {
      expect(parseCommunityScope(raw), String(raw)).toBe("favorites");
    }
  });
});

describe("oldestFetchedAt", () => {
  const scores = {
    "me/app": { score: 50, missing: [], fetchedAt: "2026-03-02T00:00:00.000Z" },
    "me/lib": { score: 80, missing: [], fetchedAt: "2026-03-01T00:00:00.000Z" },
    "me/new": { score: 90, missing: [], fetchedAt: "2026-03-05T00:00:00.000Z" },
  } as const;

  it("is the oldest fetch among the repos asked about", () => {
    expect(oldestFetchedAt(["me/app", "me/lib", "me/new"], scores)).toBe("2026-03-01T00:00:00.000Z");
    expect(oldestFetchedAt(["me/app", "me/new"], scores)).toBe("2026-03-02T00:00:00.000Z");
  });

  it("matches names without regard to case and skips repos with no stored score", () => {
    expect(oldestFetchedAt(["Me/App", "someone/else"], scores)).toBe("2026-03-02T00:00:00.000Z");
  });

  it("is null when none has one", () => {
    expect(oldestFetchedAt([], scores)).toBeNull();
    expect(oldestFetchedAt(["someone/else"], scores)).toBeNull();
  });
});
