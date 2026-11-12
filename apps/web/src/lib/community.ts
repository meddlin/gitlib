/**
 * GitHub's community profile ("community standards") for a repo: a percentage score plus which of the
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

export const DEFAULT_REFRESH_HOURS = 24;

/**
 * How old a stored profile may get before it is fetched again, from `GITLIB_COMMUNITY_REFRESH_HOURS`
 * (decimals are fine). Unset, blank or unusable means a day; `0` turns automatic refreshing off, leaving
 * only the buttons, in which case this returns null.
 */
export function refreshIntervalMs(setting: string | undefined, defaultHours = DEFAULT_REFRESH_HOURS): number | null {
  const hours = setting?.trim() ? Number(setting) : defaultHours;
  if (!Number.isFinite(hours) || hours < 0) return defaultHours * 3_600_000;
  return hours === 0 ? null : hours * 3_600_000;
}

/** Whether a profile fetched at `fetchedAt` (an ISO timestamp, or undefined if never fetched) is due again. */
export function isStale(fetchedAt: string | undefined, now: number, intervalMs: number): boolean {
  if (fetchedAt === undefined) return true;
  const fetched = Date.parse(fetchedAt);
  return !Number.isFinite(fetched) || now - fetched >= intervalMs;
}

/**
 * What goes into the database: just the facts GitHub reported. Labels and hints are not stored, so wording
 * changes in `COMMUNITY_ITEMS` apply to profiles saved earlier.
 */
export function serializeProfile(profile: CommunityProfile): string {
  return JSON.stringify({
    score: profile.score,
    items: profile.items.map(({ id, present, url }) => ({ id, present, url })),
  });
}

/**
 * Reads back what `serializeProfile` wrote. Returns null for anything unusable, including a profile saved
 * before a checklist item existed, so the caller fetches a fresh one instead of showing a partial checklist.
 */
export function parseStoredProfile(payload: string): CommunityProfile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw["score"] !== "number" || !Number.isFinite(raw["score"]) || !Array.isArray(raw["items"])) {
    return null;
  }
  const saved = new Map<unknown, Record<string, unknown>>();
  for (const entry of raw["items"]) if (isRecord(entry)) saved.set(entry["id"], entry);

  const items: CommunityItem[] = [];
  for (const item of COMMUNITY_ITEMS) {
    const entry = saved.get(item.id);
    if (!entry || typeof entry["present"] !== "boolean") return null;
    items.push({ ...item, present: entry["present"], url: githubUrl(entry["url"]) });
  }
  return { score: Math.min(100, Math.max(0, Math.round(raw["score"]))), items };
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
      `GitHub's community profile for ${repo.slug} lists the ${item.label.toLowerCase()} as missing (community profile score ${repo.score}%).`,
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

/**
 * Which repositories get a community score: only the ones you've favorited, or all of them. A repo you haven't
 * favorited is one you're probably not investing in, so by default gitlib neither fetches nor shows its score.
 * A GitHub repo you haven't cloned counts as a favorite when it is starred. Opening a repo's own page always
 * shows its score, whatever this says, since that is asking for it.
 */
export const COMMUNITY_SCOPES = ["favorites", "all"] as const;
export type CommunityScope = (typeof COMMUNITY_SCOPES)[number];
export const DEFAULT_COMMUNITY_SCOPE: CommunityScope = "favorites";

/** The saved choice; anything unrecognisable (no file, a bad edit, an old value) means the default. */
export function parseCommunityScope(raw: unknown): CommunityScope {
  return COMMUNITY_SCOPES.find((scope) => scope === raw) ?? DEFAULT_COMMUNITY_SCOPE;
}

/** What a table needs of a stored profile: the score and which checklist items are missing. */
export interface CommunityScoreEntry {
  score: number;
  missing: CommunityItemId[];
}

/** A stored profile as the repository list reads it, with when it was fetched. */
export interface CommunitySlugScore extends CommunityScoreEntry {
  fetchedAt: string;
}

/** The oldest fetch time among the given repos' stored scores (`owner/repo`, any case); null when none has one. */
export function oldestFetchedAt(slugs: readonly string[], scores: Readonly<Record<string, CommunitySlugScore>>): string | null {
  let oldest: string | null = null;
  for (const slug of slugs) {
    const fetchedAt = scores[slug.toLowerCase()]?.fetchedAt;
    if (fetchedAt !== undefined && (oldest === null || fetchedAt < oldest)) oldest = fetchedAt;
  }
  return oldest;
}
