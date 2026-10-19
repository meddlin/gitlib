export interface DiscoveredRepo {
  rootPath: string;
  relativePath: string;
  absolutePath: string;
  name: string;
  /** A linked `git worktree` checkout rather than a standalone clone. */
  isWorktree: boolean;
}

export interface RepoRecord {
  id: number;
  rootPath: string;
  relativePath: string;
  absolutePath: string;
  name: string;
  lastSeenAt: string;
  lastScannedAt: string | null;
  isMissing: boolean;
  /** A linked `git worktree` checkout; hidden from listings unless worktrees are requested. */
  isWorktree: boolean;
  /** Pinned by the user; clients list favorites ahead of other repos. */
  isFavorite: boolean;
  technologies: string[];
  notes: string;
  hasNotes: boolean;
  /** Short, user-written summary of the repo (distinct from free-form notes). */
  description: string;
}

export interface RemoteTarget {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  provider: string;
  host: string;
  pushDiffers: boolean;
  pushProvider: string | null;
  pushHost: string | null;
  landingPageUrl: string | null;
}

export interface RepoDetails {
  repo: RepoRecord;
  remotes: RemoteTarget[];
  remoteError: string | null;
  readmeMarkdown: string | null;
  readmeError: string | null;
}
