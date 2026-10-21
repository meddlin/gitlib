import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AmbiguousRepoSelectorError,
  ConfigError,
  DEFAULT_IGNORE_DIRS,
  GitLibError,
  buildNestedRepoMap,
  createApplication,
  discoverRepos,
  loadConfig,
  parseGitHubRepo,
  parseGitRemotes,
  selectGitHubRepo,
  repoKey,
  scanRepo,
  technologyCategory,
} from "../src/index.js";
import { Fixture, fakeSystem } from "./fixture.js";

let fx: Fixture;
beforeEach(() => {
  fx = new Fixture();
});
afterEach(() => fx.cleanup());

const ignoreDirs = () => new Set<string>(DEFAULT_IGNORE_DIRS);

describe("discovery", () => {
  it("finds nested and hidden repos and ignores noise", () => {
    fx.makeRepo("top-level");
    fx.makeRepo("group/nested");
    fx.makeRepo(".hidden-repo");
    fx.makeRepo("node_modules/ignored");
    fx.makeRepo("include/ignored-too");

    const discovered = discoverRepos([fx.gitRoot], ignoreDirs());

    expect(discovered.map((repo) => repo.relativePath)).toEqual([
      ".hidden-repo",
      "group/nested",
      "top-level",
    ]);
  });

  it("treats a .git file (worktree/submodule) as a repo marker", () => {
    fx.makeDir("wt", { ".git": "gitdir: /elsewhere" });
    expect(discoverRepos([fx.gitRoot], ignoreDirs()).map((r) => r.relativePath)).toEqual(["wt"]);
  });

  it("flags linked git worktrees but not submodules or standalone repos", () => {
    fx.initRealGitRepo("main-repo");
    fx.addWorktree("main-repo", "main-repo/.claude/worktrees/feature");
    fx.makeDir("sub", { ".git": "gitdir: ../main-repo/.git/modules/sub" });
    fx.makeRepo("plain");

    const byPath = Object.fromEntries(
      discoverRepos([fx.gitRoot], new Set(["node_modules"])).map((repo) => [repo.relativePath, repo.isWorktree]),
    );

    expect(byPath).toEqual({
      "main-repo": false,
      "main-repo/.claude/worktrees/feature": true,
      plain: false,
      sub: false,
    });
  });

  it("skips roots that do not exist", () => {
    expect(discoverRepos([path.join(fx.base, "missing")], ignoreDirs())).toEqual([]);
  });
});

describe("scanner", () => {
  it("excludes nested git repos but includes non-git subprojects", () => {
    const parent = fx.makeRepo("workspace", {
      "web/package.json": JSON.stringify({ dependencies: { next: "14.0.0", react: "18.0.0" } }),
    });
    fx.makeRepo("workspace/tools/child", {
      "package.json": JSON.stringify({ dependencies: { express: "4.0.0" } }),
    });

    const discovered = discoverRepos([fx.gitRoot], ignoreDirs());
    const nestedMap = buildNestedRepoMap(discovered);
    const parentRepo = discovered.find((repo) => repo.relativePath === "workspace")!;

    expect(scanRepo(parent, ignoreDirs(), nestedMap.get(repoKey(parentRepo))!)).toEqual([
      "Node.js",
      "Next.js",
      "React",
    ]);
  });

  it("does not descend deeper than the max depth", () => {
    const repo = fx.makeRepo("deep", { "a/b/c/d/Cargo.toml": "" });
    expect(scanRepo(repo, ignoreDirs(), [])).toEqual([]);
    expect(scanRepo(repo, ignoreDirs(), [], 4)).toEqual(["Rust"]);
  });
});

describe("application", () => {
  it("resolves unique names and rejects ambiguous ones", () => {
    fx.writeConfig();
    fx.makeRepo("clients/app");
    fx.makeRepo("archive/app");
    fx.makeRepo("solo");

    const app = createApplication(fx.env());
    app.refresh();

    expect(app.showRepository("solo").relativePath).toBe("solo");
    expect(app.showRepository("clients/app").relativePath).toBe("clients/app");
    expect(app.showRepository("./solo/").relativePath).toBe("solo");
    expect(() => app.showRepository("app")).toThrow(AmbiguousRepoSelectorError);
    expect(() => app.showRepository("nope")).toThrow(/was not found/);
  });

  it("detects technologies across stacks", () => {
    fx.writeConfig();
    fx.makeRepo("next-app", {
      "package.json": JSON.stringify({
        dependencies: {
          next: "14.0.0",
          react: "18.0.0",
          "react-dom": "18.0.0",
          tailwindcss: "3.0.0",
        },
        devDependencies: { typescript: "5.0.0" },
      }),
    });
    fx.makeRepo("python-cli", {
      "pyproject.toml": '[project]\ndependencies = ["typer>=0.12.0", "click>=8.1.0"]\n',
    });
    fx.makeRepo("dotnet-app", { "Project.sln": "", "src/Project.csproj": "<Project />" });
    fx.makeRepo("docker-only", { Dockerfile: "FROM python:3.13" });
    fx.makeRepo("unknown");

    const app = createApplication(fx.env());
    const repos = Object.fromEntries(app.refresh().map((repo) => [repo.relativePath, repo]));

    expect(repos["next-app"]!.technologies).toEqual(["Node.js", "Next.js", "React", "TypeScript", "Tailwind"]);
    expect(repos["python-cli"]!.technologies).toEqual(["Python", "Typer", "Click"]);
    expect(repos["dotnet-app"]!.technologies).toEqual([".NET", "C#"]);
    expect(repos["docker-only"]!.technologies).toEqual(["Docker"]);
    expect(repos["unknown"]!.technologies).toEqual([]);
  });

  it("filters by search, technology and notes", () => {
    fx.writeConfig();
    fx.makeRepo("py", { "requirements.txt": "flask==3\n" });
    fx.makeRepo("js", { "package.json": "{}" });

    const app = createApplication(fx.env());
    const repos = app.refresh();
    app.store.updateNotes(repos.find((repo) => repo.name === "js")!.id, "Remember the milk");

    const names = (options: Parameters<typeof app.listRepositories>[0]) =>
      app.listRepositories({ ...options, refresh: false }).map((repo) => repo.name);

    expect(names({ technology: "python" })).toEqual(["py"]);
    expect(names({ search: "flask" })).toEqual(["py"]);
    expect(names({ search: "MILK" })).toEqual(["js"]);
    expect(names({ notesOnly: true })).toEqual(["js"]);
    expect(names({})).toEqual(["js", "py"]);
  });

  it("hides linked worktrees unless asked to include them", () => {
    fx.writeConfig();
    fx.initRealGitRepo("main-repo");
    fx.addWorktree("main-repo", "main-repo/.claude/worktrees/feature");

    const app = createApplication(fx.env());
    const paths = (options: Parameters<typeof app.listRepositories>[0]) =>
      app.listRepositories({ ...options, refresh: false }).map((repo) => repo.relativePath);

    app.refresh();
    expect(paths({})).toEqual(["main-repo"]);
    expect(paths({ includeWorktrees: true })).toEqual([
      "main-repo",
      "main-repo/.claude/worktrees/feature",
    ]);
    // Search never sneaks hidden worktrees back in.
    expect(paths({ search: "feature" })).toEqual([]);
    expect(paths({ search: "feature", includeWorktrees: true })).toEqual([
      "main-repo/.claude/worktrees/feature",
    ]);
  });

  it("upgrades databases created before worktree tracking", () => {
    fx.writeConfig();
    const dbPath = path.join(fx.appHome, "gitlib.db");
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        absolute_path TEXT NOT NULL,
        name TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_scanned_at TEXT,
        is_missing INTEGER NOT NULL DEFAULT 0,
        UNIQUE(root_path, relative_path)
      );
      INSERT INTO repos (root_path, relative_path, absolute_path, name, last_seen_at)
      VALUES ('/r', 'old', '/r/old', 'old', '2020-01-01T00:00:00+00:00');
    `);
    legacy.close();

    const app = createApplication(fx.env());
    expect(app.loadRepositories().map((repo) => [repo.relativePath, repo.isWorktree])).toEqual([["old", false]]);
  });

  it("marks repos missing once they disappear", () => {
    fx.writeConfig();
    fx.makeRepo("keep");
    const gone = fx.makeRepo("gone");

    const app = createApplication(fx.env());
    expect(app.refresh().map((repo) => repo.relativePath)).toEqual(["gone", "keep"]);

    fs.rmSync(gone, { recursive: true });
    expect(app.refresh().map((repo) => repo.relativePath)).toEqual(["keep"]);
    expect(app.store.listRepositories(true).find((repo) => repo.relativePath === "gone")!.isMissing).toBe(true);
  });

  it("persists descriptions separately from notes and makes them searchable", () => {
    fx.writeConfig();
    fx.makeRepo("alpha");
    fx.makeRepo("beta");
    const app = createApplication(fx.env());
    app.refresh();

    const saved = app.saveRepositoryDescription("alpha", "  Billing service  ");
    expect(saved.description).toBe("Billing service");
    expect(saved.notes).toBe("");
    expect(saved.hasNotes).toBe(false);
    expect(app.getRepository("beta").description).toBe("");
    expect(app.listRepositories({ search: "billing", refresh: false }).map((r) => r.name)).toEqual(["alpha"]);

    expect(app.saveRepositoryDescription("alpha", "").description).toBe("");
    expect(createApplication(fx.env()).getRepository("alpha").description).toBe("");
  });

  it("persists favorites across rescans and restarts", () => {
    fx.writeConfig();
    fx.makeRepo("alpha");
    fx.makeRepo("beta");
    const app = createApplication(fx.env());
    app.refresh();

    expect(app.getRepository("alpha").isFavorite).toBe(false);
    expect(app.saveRepositoryFavorite("beta", true).isFavorite).toBe(true);
    expect(app.saveRepositoryFavorite("beta", true).isFavorite).toBe(true);

    app.refresh();
    const reopened = createApplication(fx.env());
    expect(reopened.loadRepositories().map((r) => [r.relativePath, r.isFavorite])).toEqual([
      ["alpha", false],
      ["beta", true],
    ]);

    expect(reopened.saveRepositoryFavorite("beta", false).isFavorite).toBe(false);
  });

  it("persists notes", () => {
    fx.writeConfig();
    fx.makeRepo("alpha");
    const app = createApplication(fx.env());
    app.refresh();

    const saved = app.saveRepositoryNotes("alpha", "hello");
    expect(saved.notes).toBe("hello");
    expect(saved.hasNotes).toBe(true);
    expect(createApplication(fx.env()).getRepository("alpha").notes).toBe("hello");
  });
});

describe("technologyCategory", () => {
  it("classifies detected technologies", () => {
    expect(technologyCategory("TypeScript")).toBe("language");
    expect(technologyCategory("Next.js")).toBe("framework");
    expect(technologyCategory("Node.js")).toBe("runtime");
    expect(technologyCategory("Docker")).toBe("tooling");
    expect(technologyCategory("Something New")).toBe("tooling");
  });
});

describe("config", () => {
  it("writes defaults and honours a custom vscode command", () => {
    fx.writeConfig();
    expect(loadConfig(fx.env()).vscodeCommand).toEqual(["code", "--new-window"]);

    fx.writeConfig({ vscodeCommand: ["code-insiders", "--new-window"] });
    expect(loadConfig(fx.env()).vscodeCommand).toEqual(["code-insiders", "--new-window"]);
  });

  it("bootstraps a default config file on first run", () => {
    const config = loadConfig(fx.env());
    expect(fs.existsSync(config.configPath)).toBe(true);
    expect(config.ignoreDirs.has("node_modules")).toBe(true);
    expect(config.dbPath).toBe(path.join(fx.appHome, "gitlib.db"));
  });

  it("rejects a non-list vscode_command", () => {
    fs.mkdirSync(fx.appHome, { recursive: true });
    fs.writeFileSync(
      path.join(fx.appHome, "config.toml"),
      `roots = ["${fx.gitRoot}"]\nvscode_command = "code --new-window"\nignore_dirs = [".git"]\n`,
    );
    expect(() => loadConfig(fx.env())).toThrow(ConfigError);
  });

  it("reports invalid TOML as a ConfigError", () => {
    fs.mkdirSync(fx.appHome, { recursive: true });
    fs.writeFileSync(path.join(fx.appHome, "config.toml"), "roots = [");
    expect(() => loadConfig(fx.env())).toThrow(/Unable to load config/);
  });

  it("resolves relative roots against the config directory", () => {
    fs.mkdirSync(fx.appHome, { recursive: true });
    fs.writeFileSync(path.join(fx.appHome, "config.toml"), 'roots = ["../git"]\n');
    expect(loadConfig(fx.env()).roots).toEqual([fx.gitRoot]);
  });
});

describe("open in VS Code", () => {
  it("launches the configured command with the repo path", () => {
    fx.writeConfig({ vscodeCommand: ["code-insiders", "--new-window"] });
    fx.makeRepo("alpha");
    const system = fakeSystem({ runCommand: () => ({ status: 0, stdout: "", stderr: "" }) });
    const app = createApplication(fx.env(), system);
    app.refresh();

    expect(app.openRepositoryInVscode("alpha").relativePath).toBe("alpha");
    expect(system.commands).toEqual([["code-insiders", "--new-window", path.join(fx.gitRoot, "alpha")]]);
  });

  it("surfaces spawn failures and non-zero exits", () => {
    fx.writeConfig();
    fx.makeRepo("alpha");
    const app = createApplication(
      fx.env(),
      fakeSystem({
        runCommand: () => {
          throw new Error("code not found");
        },
      }),
    );
    app.refresh();
    expect(() => app.openRepositoryInVscode("alpha")).toThrow("Unable to launch VS Code: code not found");

    const failing = createApplication(
      fx.env(),
      fakeSystem({ runCommand: () => ({ status: 1, stdout: "", stderr: "permission denied" }) }),
    );
    expect(() => failing.openRepositoryInVscode("alpha")).toThrow(GitLibError);
    expect(() => failing.openRepositoryInVscode("alpha")).toThrow(
      "Unable to launch VS Code: permission denied",
    );
  });
});

describe("remotes", () => {
  it("resolves the GitHub repository behind a remote", () => {
    expect(parseGitHubRepo("https://github.com/example/project")).toEqual({ owner: "example", repo: "project" });
    expect(parseGitHubRepo("https://gitlab.com/example/project")).toBeNull();
    expect(parseGitHubRepo("https://github.com/example")).toBeNull();
    expect(parseGitHubRepo(null)).toBeNull();

    const remotes = parseGitRemotes(
      [
        "fork\tgit@github.com:me/project.git (fetch)",
        "fork\tgit@github.com:me/project.git (push)",
        "origin\thttps://gitlab.com/team/project.git (fetch)",
        "origin\thttps://gitlab.com/team/project.git (push)",
      ].join("\n"),
    );
    // origin isn't on GitHub, so the first remote that is wins.
    expect(selectGitHubRepo(remotes)).toEqual({ owner: "me", repo: "project" });
    expect(selectGitHubRepo([])).toBeNull();
  });

  it("opens the origin landing page, preferring origin over other remotes", () => {
    fx.writeConfig();
    const repo = fx.initRealGitRepo("with-remotes");
    fx.git(repo, "remote", "add", "gitlab", "https://gitlab.com/example/project.git");
    fx.git(repo, "remote", "add", "origin", "https://github.com/example/project.git");

    const system = fakeSystem({});
    const app = createApplication(fx.env(), system);
    app.refresh();

    const { repo: opened, remote } = app.openRepositoryRemote("with-remotes");
    expect(opened.relativePath).toBe("with-remotes");
    expect(remote.name).toBe("origin");
    expect(system.urls).toEqual(["https://github.com/example/project"]);
  });

  it("falls back to another remote and reports failures", () => {
    fx.writeConfig();
    const fallback = fx.initRealGitRepo("fallback-remote");
    const noLink = fx.initRealGitRepo("no-link-remote");
    fx.git(fallback, "remote", "add", "gitlab", "https://gitlab.com/example/project.git");
    fx.git(noLink, "remote", "add", "origin", path.join(fx.base, "mirrors", "no-link-remote.git"));

    const system = fakeSystem({});
    const app = createApplication(fx.env(), system);
    app.refresh();

    const { remote } = app.openRepositoryRemote("fallback-remote");
    expect(remote.name).toBe("gitlab");
    expect(system.urls).toEqual(["https://gitlab.com/example/project"]);

    const refusing = createApplication(fx.env(), fakeSystem({ openUrl: () => false }));
    expect(() => refusing.openRepositoryRemote("fallback-remote")).toThrow(
      "Unable to open gitlab for fallback-remote.",
    );
    expect(() => app.openRepositoryRemote("no-link-remote")).toThrow(
      "No remote landing page available for no-link-remote.",
    );
  });

  it("describes remote targets for each URL style", () => {
    fx.writeConfig();
    const none = fx.initRealGitRepo("no-remote");
    const two = fx.initRealGitRepo("with-remotes");
    const scp = fx.initRealGitRepo("ssh-remote");
    const diffPush = fx.initRealGitRepo("different-push");
    const sshUrl = fx.initRealGitRepo("ssh-url-remote");
    const generic = fx.initRealGitRepo("generic-remote");
    const local = fx.initRealGitRepo("local-path-remote");
    fx.git(two, "remote", "add", "origin", "https://github.com/example/origin.git");
    fx.git(two, "remote", "add", "gitlab", "https://gitlab.com/example/project.git");
    fx.git(scp, "remote", "add", "origin", "git@github.com:owner/repo.git");
    fx.git(diffPush, "remote", "add", "origin", "https://github.com/example/project.git");
    fx.git(diffPush, "remote", "set-url", "--push", "origin", "https://gitlab.com/example/project.git");
    fx.git(sshUrl, "remote", "add", "origin", "ssh://git@gitlab.example.com/group/subgroup/project.git");
    fx.git(generic, "remote", "add", "origin", "https://code.example.com/team/project.git");
    fx.git(local, "remote", "add", "origin", path.join(fx.base, "mirrors", "local-path-remote.git"));

    const app = createApplication(fx.env());
    app.refresh();
    const details = (selector: string) => app.getRepositoryDetails(selector);

    expect(path.basename(none)).toBe("no-remote");
    expect(details("no-remote").remotes).toEqual([]);
    expect(details("no-remote").remoteError).toBeNull();

    const withRemotes = details("with-remotes");
    expect(withRemotes.remotes.map((remote) => remote.name)).toEqual(["gitlab", "origin"]);
    expect(withRemotes.remotes[0]).toMatchObject({
      provider: "GitLab",
      host: "gitlab.com",
      landingPageUrl: "https://gitlab.com/example/project",
    });
    expect(withRemotes.remotes[1]).toMatchObject({
      provider: "GitHub",
      host: "github.com",
      landingPageUrl: "https://github.com/example/origin",
      pushDiffers: false,
    });

    expect(details("ssh-remote").remotes[0]).toMatchObject({
      provider: "GitHub",
      host: "github.com",
      landingPageUrl: "https://github.com/owner/repo",
    });
    expect(details("ssh-url-remote").remotes[0]!.landingPageUrl).toBe(
      "https://gitlab.example.com/group/subgroup/project",
    );
    expect(details("generic-remote").remotes[0]!.landingPageUrl).toBe("https://code.example.com/team/project");
    expect(details("local-path-remote").remotes[0]!.landingPageUrl).toBeNull();
    expect(details("different-push").remotes[0]).toMatchObject({
      landingPageUrl: "https://github.com/example/project",
      pushDiffers: true,
      provider: "GitHub",
      host: "github.com",
      pushProvider: "GitLab",
      pushHost: "gitlab.com",
    });
  });

  it("reports an error when git cannot read the directory", () => {
    fx.writeConfig();
    fx.makeRepo("fake-git");
    const app = createApplication(fx.env());
    app.refresh();
    const details = app.getRepositoryDetails("fake-git");
    expect(details.remotes).toEqual([]);
    expect(details.remoteError).toBeTruthy();
  });
});

describe("readme", () => {
  it("loads the root README and reports unreadable ones", () => {
    fx.writeConfig();
    fx.makeRepo("with-readme", { "README.md": "# With README\n\nThis repo has documentation.\n" });
    fx.makeRepo("without-readme");
    fs.mkdirSync(path.join(fx.makeRepo("broken-readme"), "README.md"));

    const app = createApplication(fx.env());
    app.refresh();

    const withReadme = app.getRepositoryDetails("with-readme");
    expect(withReadme.readmeMarkdown).toBe("# With README\n\nThis repo has documentation.\n");
    expect(withReadme.readmeError).toBeNull();

    const without = app.getRepositoryDetails("without-readme");
    expect(without.readmeMarkdown).toBeNull();
    expect(without.readmeError).toBeNull();

    const broken = app.getRepositoryDetails("broken-readme");
    expect(broken.readmeMarkdown).toBeNull();
    expect(broken.readmeError).toContain("README.md");
  });
});
