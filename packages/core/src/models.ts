export interface DiscoveredRepo {
  rootPath: string;
  relativePath: string;
  absolutePath: string;
  name: string;
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
