import type { RemoteTarget } from "./models.js";

const REMOTE_LINE = /^(?<name>\S+)\s+(?<url>\S+)\s+\((?<kind>fetch|push)\)$/;
const SCP_STYLE = /^[^@]+@(?<host>[^:]+):/;
const SCP_PATH = /^[^@]+@(?<host>[^:]+):(?<path>.+)$/;

export function extractRemoteHost(url: string): string {
  if (url.includes("://")) {
    let hostPart = url.split("://", 2)[1]!.split("/", 1)[0]!;
    if (hostPart.includes("@")) hostPart = hostPart.slice(hostPart.indexOf("@") + 1);
    if (hostPart.includes(":")) hostPart = hostPart.slice(0, hostPart.indexOf(":"));
    return hostPart;
  }

  const match = SCP_STYLE.exec(url);
  if (match?.groups) return match.groups["host"]!;

  const colon = url.indexOf(":");
  if (colon !== -1 && !url.slice(0, colon).includes("/")) return url.slice(0, colon);

  return url;
}

export function classifyProvider(host: string): string {
  const normalized = host.toLowerCase();
  if (normalized.includes("github")) return "GitHub";
  if (normalized.includes("gitlab")) return "GitLab";
  return host ? `Other (${host})` : "Other";
}

function normalizeRepoPath(value: string): string | null {
  let normalized = value.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized) return null;
  if (normalized.endsWith(".git")) normalized = normalized.slice(0, -4);
  normalized = normalized.replace(/\/+$/, "");
  return normalized || null;
}

function buildHttpsLandingPage(host: string, repoPath: string): string | null {
  const normalizedPath = normalizeRepoPath(repoPath);
  if (!host || normalizedPath === null) return null;
  return `https://${host}/${normalizedPath}`;
}

export function normalizeRemoteLandingPage(url: string): string | null {
  if (url.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const scheme = parsed.protocol.replace(/:$/, "");
    if (scheme === "http" || scheme === "https") {
      if (!parsed.hostname) return null;
      const normalizedPath = normalizeRepoPath(decodeURIComponent(parsed.pathname));
      if (normalizedPath === null) return null;
      return `${scheme}://${parsed.host}/${normalizedPath}`;
    }
    if (scheme === "ssh") {
      if (!parsed.hostname) return null;
      return buildHttpsLandingPage(parsed.hostname, decodeURIComponent(parsed.pathname));
    }
    return null;
  }

  const match = SCP_PATH.exec(url);
  if (match?.groups) return buildHttpsLandingPage(match.groups["host"]!, match.groups["path"]!);
  return null;
}

export function formatRemoteTarget(name: string, fetchUrl: string, pushUrl: string): RemoteTarget {
  const fetchHost = extractRemoteHost(fetchUrl);
  const pushHost = extractRemoteHost(pushUrl);
  const pushDiffers = fetchUrl !== pushUrl;
  return {
    name,
    fetchUrl,
    pushUrl,
    provider: classifyProvider(fetchHost),
    host: fetchHost,
    pushDiffers,
    pushProvider: pushDiffers ? classifyProvider(pushHost) : null,
    pushHost: pushDiffers ? pushHost : null,
    landingPageUrl: normalizeRemoteLandingPage(fetchUrl),
  };
}

/** Parses the output of `git remote -v` into remotes sorted by name. */
export function parseGitRemotes(output: string): RemoteTarget[] {
  const remotesByName = new Map<string, { fetch?: string; push?: string }>();
  for (const line of output.split(/\r?\n/)) {
    const match = REMOTE_LINE.exec(line.trim());
    if (!match?.groups) continue;
    const { name, url, kind } = match.groups as { name: string; url: string; kind: "fetch" | "push" };
    const entry = remotesByName.get(name) ?? {};
    entry[kind] = url;
    remotesByName.set(name, entry);
  }

  const remotes: RemoteTarget[] = [];
  for (const name of [...remotesByName.keys()].sort()) {
    const entry = remotesByName.get(name)!;
    const fetchUrl = entry.fetch ?? "";
    if (!fetchUrl) continue;
    remotes.push(formatRemoteTarget(name, fetchUrl, entry.push ?? fetchUrl));
  }
  return remotes;
}

export function selectPreferredRemote(remotes: readonly RemoteTarget[]): RemoteTarget | null {
  return (
    remotes.find((remote) => remote.name === "origin" && remote.landingPageUrl) ??
    remotes.find((remote) => remote.landingPageUrl) ??
    null
  );
}

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/** Extracts `owner/repo` from a github.com landing page URL; null for other hosts (including GitHub Enterprise). */
export function parseGitHubRepo(landingPageUrl: string | null): GitHubRepoRef | null {
  if (!landingPageUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(landingPageUrl);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  const [owner, repo, ...rest] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repo || rest.length > 0) return null;
  return { owner, repo };
}

/** The GitHub repository behind a repo's preferred remote, if that remote is on github.com. */
export function selectGitHubRepo(remotes: readonly RemoteTarget[]): GitHubRepoRef | null {
  const preferred = selectPreferredRemote(remotes);
  const fromPreferred = preferred ? parseGitHubRepo(preferred.landingPageUrl) : null;
  if (fromPreferred) return fromPreferred;
  for (const remote of remotes) {
    const ref = parseGitHubRepo(remote.landingPageUrl);
    if (ref) return ref;
  }
  return null;
}
