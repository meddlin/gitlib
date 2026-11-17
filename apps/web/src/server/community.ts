import { createServerFn } from "@tanstack/react-start";
import { COMMUNITY_SCOPES, type CommunityScope } from "../lib/community";
import { readCommunityScope, writeCommunityScope } from "./community-scope.server";
import {
  localProfileView,
  readCommunityScores,
  refreshAllCommunityScores,
  remoteProfileView,
  type CommunityView,
} from "./community.server";

export type { CommunityScoresView, CommunityView } from "./community.server";

const validateRelativePath = (input: { relativePath: string }) => {
  if (typeof input?.relativePath !== "string" || !input.relativePath) {
    throw new Error("Invalid community profile request.");
  }
  return input;
};

const validateFullName = (input: { fullName: string }) => {
  if (typeof input?.fullName !== "string" || !input.fullName) {
    throw new Error("Invalid community profile request.");
  }
  return input;
};

/** The community profile for a repository gitlib knows about, as last stored; never an arbitrary repo. */
export const getCommunityProfile = createServerFn({ method: "GET" })
  .validator(validateRelativePath)
  .handler(({ data }): Promise<CommunityView> => localProfileView(data.relativePath, false));

/** Asks GitHub again for one repository's profile and stores the answer. */
export const refreshCommunityProfile = createServerFn({ method: "POST" })
  .validator(validateRelativePath)
  .handler(({ data }): Promise<CommunityView> => localProfileView(data.relativePath, true));

/**
 * The community profile for a GitHub repository gitlib lists but has no clone of, by `owner/repo`. Fetched from
 * GitHub when nothing is stored or the stored one is old; never for a repo the catalog doesn't list.
 */
export const getRemoteCommunityProfile = createServerFn({ method: "GET" })
  .validator(validateFullName)
  .handler(({ data }): Promise<CommunityView> => remoteProfileView(data.fullName, false));

/** Asks GitHub again for an uncloned repository's profile and stores the answer. */
export const refreshRemoteCommunityProfile = createServerFn({ method: "POST" })
  .validator(validateFullName)
  .handler(({ data }): Promise<CommunityView> => remoteProfileView(data.fullName, true));

/**
 * Community scores for the repos the Settings page says to score (favorited ones by default), with the missing
 * items behind each, read from gitlib's database. If any are older than the refresh interval a refresh starts
 * in the background and `refreshing` says so.
 */
export const getCommunityScores = createServerFn({ method: "GET" }).handler(() => readCommunityScores());

/**
 * Starts asking GitHub for every scored repo's profile now, whatever the refresh interval says, and returns at
 * once with `refreshing` set. `uncloned` adds the GitHub repos with no clone, which only counts under "all".
 */
export const refreshCommunityScores = createServerFn({ method: "POST" })
  .validator((input: { uncloned: boolean }) => {
    if (typeof input?.uncloned !== "boolean") throw new Error("Invalid community scores request.");
    return input;
  })
  .handler(({ data }) => refreshAllCommunityScores(data.uncloned));

/** Which repositories get a community score; the Settings page shows and changes it. */
export const getCommunityScope = createServerFn({ method: "GET" }).handler((): CommunityScope => readCommunityScope());

/** Saves which repositories get a community score, on the server so it applies in every browser. */
export const saveCommunityScope = createServerFn({ method: "POST" })
  .validator((input: { scope: CommunityScope }) => {
    if (!COMMUNITY_SCOPES.includes(input?.scope)) throw new Error("Invalid community score setting.");
    return input;
  })
  .handler(({ data }): CommunityScope => {
    writeCommunityScope(data.scope);
    return data.scope;
  });
