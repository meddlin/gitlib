import { describe, expect, it } from "vitest";
import { COMMUNITY_ITEMS, missingItems, parseCommunityProfile, planningIssueDraft, scoreTone } from "../src/lib/community";

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
