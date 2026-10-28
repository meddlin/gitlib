/**
 * GitHub's community profile ("community standards") for a repo: a health percentage plus which of the
 * recommended project files exist. Parsing lives here, free of server code, so it is shared with the UI.
 */

export const COMMUNITY_ITEMS = [
  { id: "description", label: "Description", task: "Add a repository description", hint: "A one-line summary shown at the top of the repository's GitHub page." },
  { id: "readme", label: "README", task: "Add a README", hint: "Explains what the project is and how to get started with it." },
  { id: "license", label: "License", task: "Add a license", hint: "Tells other people what they may do with the code." },
  { id: "code_of_conduct", label: "Code of conduct", task: "Add a code of conduct", hint: "Sets expectations for how people treat each other here." },
  { id: "contributing", label: "Contributing guide", task: "Add a contributing guide", hint: "Explains how to propose a change to the project." },
  { id: "issue_template", label: "Issue template", task: "Add issue templates", hint: "Guides people toward filing useful issues." },
  { id: "pull_request_template", label: "Pull request template", task: "Add a pull request template", hint: "Prompts a checklist on every new pull request." },
] as const;

export type CommunityItemId = (typeof COMMUNITY_ITEMS)[number]["id"];

export interface CommunityItem {
  id: CommunityItemId;
  label: string;
  /** What fixing it means, as the title of a planning issue. Stable, so an already-filed issue can be recognised. */
  task: string;
  hint: string;
  present: boolean;
  /** Where the file lives on GitHub, when it exists and GitHub says where. */
  url: string | null;
}

export interface CommunityProfile {
  /** GitHub's own `health_percentage`, 0 to 100. */
  score: number;
  /** Every recommended item, in checklist order, present or not. */
  items: CommunityItem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only GitHub web links are ever put in an `href`. */
function githubUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Turns the body of `GET /repos/{owner}/{repo}/community/profile` into a profile.
 * Throws when the body isn't recognisably a community profile (e.g. GitHub changed the shape).
 */
export function parseCommunityProfile(raw: unknown): CommunityProfile {
  if (!isRecord(raw) || typeof raw["health_percentage"] !== "number" || !Number.isFinite(raw["health_percentage"])) {
    throw new Error("GitHub returned an unexpected community profile.");
  }
  const files = isRecord(raw["files"]) ? raw["files"] : {};
  const file = (...keys: string[]): Record<string, unknown> | null => {
    for (const key of keys) if (isRecord(files[key])) return files[key];
    return null;
  };

  const found: Record<CommunityItemId, { present: boolean; url: string | null }> = {
    description: { present: typeof raw["description"] === "string" && raw["description"].trim() !== "", url: null },
    readme: fileEntry(file("readme")),
    license: fileEntry(file("license")),
    // `code_of_conduct` is only GitHub's recognised-template summary; the `_file` variant is the real file.
    code_of_conduct: fileEntry(file("code_of_conduct_file", "code_of_conduct")),
    contributing: fileEntry(file("contributing")),
    issue_template: fileEntry(file("issue_template")),
    pull_request_template: fileEntry(file("pull_request_template")),
  };

  return {
    score: Math.min(100, Math.max(0, Math.round(raw["health_percentage"]))),
    items: COMMUNITY_ITEMS.map((item) => ({ ...item, ...found[item.id] })),
  };
}

function fileEntry(entry: Record<string, unknown> | null): { present: boolean; url: string | null } {
  return { present: entry !== null, url: entry ? githubUrl(entry["html_url"]) : null };
}

/** The planning issue that would fix a missing item, for a repo that GitHub scores at `score`. */
export function planningIssueDraft(
  item: Pick<CommunityItem, "task" | "label" | "hint">,
  repo: { slug: string; score: number },
): { title: string; body: string } {
  return {
    title: item.task,
    body: [
      item.hint,
      "",
      `GitHub's community profile for ${repo.slug} lists the ${item.label.toLowerCase()} as missing (health score ${repo.score}%).`,
      "",
      `Community standards: https://github.com/${repo.slug}/community`,
    ].join("\n"),
  };
}

export const missingItems = (profile: CommunityProfile): CommunityItem[] => profile.items.filter((item) => !item.present);

export type ScoreTone = "good" | "fair" | "poor";

/** Coarse bands so a score reads at a glance. These are gitlib's cut-offs, not GitHub's. */
export function scoreTone(score: number): ScoreTone {
  return score >= 80 ? "good" : score >= 50 ? "fair" : "poor";
}

/** Background and text colours for each band; the text variant stays readable in light and dark. */
export const TONE_CLASSES: Record<ScoreTone, { bar: string; text: string }> = {
  good: { bar: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" },
  fair: { bar: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" },
  poor: { bar: "bg-red-500", text: "text-red-700 dark:text-red-400" },
};
