import type { RemoteTarget, RepoDetails } from "@gitlib/core";

export function formatRemoteSummary(remote: RemoteTarget): string {
  let line = `${remote.name} -> ${remote.provider} (${remote.host})`;
  if (remote.pushDiffers && remote.pushProvider && remote.pushHost) {
    line += ` | push differs: ${remote.pushProvider} (${remote.pushHost})`;
  }
  return line;
}

export function formatRemoteBlock(remote: RemoteTarget): string {
  return `${formatRemoteSummary(remote)}\nlanding page: ${remote.landingPageUrl ?? "unavailable"}`;
}

export function formatRemoteTargets(details: RepoDetails | null): string {
  if (details === null || details.remoteError || details.remotes.length === 0) return "-";
  return details.remotes.map(formatRemoteBlock).join("\n\n");
}

export function formatRepoSummary(details: RepoDetails | null): string {
  if (details === null) return "No repository selected.";

  const { repo } = details;
  let remotes: string;
  if (details.remoteError) remotes = "unavailable";
  else if (details.remotes.length > 0) remotes = `${details.remotes.length} configured`;
  else remotes = "none";

  return [
    `repo: ${repo.name}`,
    `relative_path: ${repo.relativePath}`,
    `absolute_path: ${repo.absolutePath}`,
    `technologies: ${repo.technologies.length > 0 ? repo.technologies.join(", ") : "-"}`,
    `remotes: ${remotes}`,
    `last_scanned_at: ${repo.lastScannedAt || "-"}`,
  ].join("\n");
}

export function formatReadme(details: RepoDetails | null): string {
  if (details === null) return "No repository selected.";
  if (details.readmeError) return `Unable to load README.md: ${details.readmeError}`;
  if (details.readmeMarkdown === null) return "README.md not found.";
  return details.readmeMarkdown;
}
