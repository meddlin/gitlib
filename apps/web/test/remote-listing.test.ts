import { afterEach, describe, expect, it, vi } from "vitest";
import { listGitHubRepos } from "../src/server/github.server";
import { gitlabHost, listGitLabProjects } from "../src/server/gitlab.server";
import { ProviderSetupError } from "../src/server/provider-errors";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const stubFetch = (...responses: Response[]) => {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const githubRepo = (n: number) => ({
  full_name: `me/repo-${n}`,
  name: `repo-${n}`,
  description: n === 0 ? null : `repo ${n}`,
  html_url: `https://github.com/me/repo-${n}`,
  private: n === 1,
  fork: false,
  archived: false,
  pushed_at: "2026-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
  language: "TypeScript",
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("listGitHubRepos", () => {
  it("needs a token", async () => {
    vi.stubEnv("GITLIB_GITHUB_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    await expect(listGitHubRepos()).rejects.toBeInstanceOf(ProviderSetupError);
  });

  it("maps repos and keeps paging until a short page", async () => {
    vi.stubEnv("GITLIB_GITHUB_TOKEN", "ghp_test");
    const fetchMock = stubFetch(
      json(Array.from({ length: 100 }, (_, n) => githubRepo(n))),
      json([githubRepo(100)]),
    );
    const repos = await listGitHubRepos();

    expect(repos).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("page=2");
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)["Authorization"]).toBe("Bearer ghp_test");
    expect(repos[1]).toMatchObject({
      provider: "github",
      key: "github.com/me/repo-1",
      fullName: "me/repo-1",
      isPrivate: true,
      updatedAt: "2026-01-01T00:00:00Z",
      language: "TypeScript",
    });
    expect(repos[0]!.description).toBe("");
  });

  it("explains a rejected token", async () => {
    vi.stubEnv("GITLIB_GITHUB_TOKEN", "bad");
    stubFetch(json({}, 401));
    await expect(listGitHubRepos()).rejects.toThrow("GitHub rejected the token");
  });
});

describe("listGitLabProjects", () => {
  const project = (path: string, extra: Record<string, unknown> = {}) => ({
    path_with_namespace: path,
    path: path.split("/").at(-1),
    description: null,
    web_url: `https://gitlab.com/${path}`,
    visibility: "private",
    archived: false,
    last_activity_at: "2026-02-01T00:00:00Z",
    ...extra,
  });

  it("needs a token or a username", async () => {
    vi.stubEnv("GITLIB_GITLAB_TOKEN", "");
    vi.stubEnv("GITLIB_GITLAB_USERNAME", "");
    await expect(listGitLabProjects()).rejects.toBeInstanceOf(ProviderSetupError);
  });

  it("lists member projects with the token, including nested groups", async () => {
    vi.stubEnv("GITLIB_GITLAB_TOKEN", "glpat_test");
    vi.stubEnv("GITLIB_GITLAB_URL", "");
    const fetchMock = stubFetch(
      json([
        project("team/sub/app"),
        project("me/fork", { visibility: "public", forked_from_project: { id: 1 }, archived: true }),
      ]),
    );
    const repos = await listGitLabProjects();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://gitlab.com/api/v4/projects?");
    expect(String(url)).toContain("membership=true");
    expect((init!.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat_test");
    expect(repos[0]).toMatchObject({
      provider: "gitlab",
      key: "gitlab.com/team/sub/app",
      fullName: "team/sub/app",
      name: "app",
      isPrivate: true,
    });
    expect(repos[1]).toMatchObject({ isPrivate: false, isFork: true, isArchived: true });
  });

  it("falls back to a user's public projects, on a self-hosted URL", async () => {
    vi.stubEnv("GITLIB_GITLAB_TOKEN", "");
    vi.stubEnv("GITLIB_GITLAB_USERNAME", "me");
    vi.stubEnv("GITLIB_GITLAB_URL", "https://git.example.com/");
    const fetchMock = stubFetch(json([project("me/thing", { visibility: "public" })]));
    const repos = await listGitLabProjects();

    expect(String(fetchMock.mock.calls[0]![0])).toContain("https://git.example.com/api/v4/users/me/projects?");
    expect(gitlabHost()).toBe("git.example.com");
    expect(repos[0]!.key).toBe("git.example.com/me/thing");
  });

  it("reports an unknown user", async () => {
    vi.stubEnv("GITLIB_GITLAB_TOKEN", "");
    vi.stubEnv("GITLIB_GITLAB_USERNAME", "nobody");
    stubFetch(json({}, 404));
    await expect(listGitLabProjects()).rejects.toThrow("no user named nobody");
  });
});
