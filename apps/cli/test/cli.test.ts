import fs from "node:fs";
import path from "node:path";
import { createApplication } from "@gitlib/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellSplit } from "../src/notes.js";
import { renderTable } from "../src/render.js";
import { Fixture, fakeSystem } from "./fixture.js";

let fx: Fixture;
beforeEach(() => {
  fx = new Fixture();
});
afterEach(() => fx.cleanup());

describe("notes edit", () => {
  it("round-trips notes through $EDITOR", async () => {
    fx.writeConfig();
    fx.makeRepo("notes-repo");
    const editor = path.join(fx.base, "write-notes.mjs");
    fs.writeFileSync(
      editor,
      'import fs from "node:fs"; fs.writeFileSync(process.argv[2], "First line\\nSecond line\\n");',
    );

    const edit = await fx.runCli(["notes", "edit", "notes-repo"], {
      env: { EDITOR: `"${process.execPath}" "${editor}"` },
    });
    expect(edit.code, edit.stderr).toBe(0);
    expect(edit.stdout.trim()).toBe("Updated notes for notes-repo.");

    const show = await fx.runCli(["show", "notes-repo", "--json"]);
    expect(show.code, show.stderr).toBe(0);
    expect(JSON.parse(show.stdout).notes).toBe("First line\nSecond line");
  });

  it("reports a failing editor", async () => {
    fx.writeConfig();
    fx.makeRepo("notes-repo");
    const result = await fx.runCli(["notes", "edit", "notes-repo"], { env: { EDITOR: "false" } });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Editor exited with status 1");
  });

  it("reports a missing editor", async () => {
    fx.writeConfig();
    fx.makeRepo("notes-repo");
    const result = await fx.runCli(["notes", "edit", "notes-repo"], {
      env: { EDITOR: "definitely-not-an-editor-binary" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unable to launch editor");
  });
});

describe("list and show", () => {
  it("have stable JSON shapes", async () => {
    fx.writeConfig();
    fx.makeRepo("json-repo", { "package.json": JSON.stringify({ dependencies: { react: "18.0.0" } }) });

    const app = createApplication(fx.env());
    const repo = app.showRepository("json-repo");
    app.store.updateNotes(repo.id, "tracked note");

    const list = await fx.runCli(["list", "--json"]);
    expect(list.code, list.stderr).toBe(0);
    const payload = JSON.parse(list.stdout);
    expect(payload).toHaveLength(1);
    expect(Object.keys(payload[0]).sort()).toEqual(
      ["absolute_path", "has_notes", "last_scanned_at", "name", "notes", "relative_path", "technologies"].sort(),
    );
    expect(payload[0]).toMatchObject({
      name: "json-repo",
      technologies: ["Node.js", "React"],
      has_notes: true,
    });

    const show = await fx.runCli(["show", "json-repo", "--json"]);
    expect(show.code, show.stderr).toBe(0);
    const detail = JSON.parse(show.stdout);
    expect(Object.keys(detail).sort()).toEqual(Object.keys(payload[0]).sort());
    expect(detail.notes).toBe("tracked note");
  });

  it("defaults to the list command and renders a table", async () => {
    fx.writeConfig();
    fx.makeRepo("alpha", { "Dockerfile": "FROM scratch" });
    const result = await fx.runCli([]);
    expect(result.code, result.stderr).toBe(0);
    const [header, rule, row] = result.stdout.split("\n");
    expect(header).toMatch(/^repo\s+relative_path\s+technologies\s+notes\s*$/);
    expect(rule).toMatch(/^-+\s+-+\s+-+\s+-+\s*$/);
    expect(row).toMatch(/^alpha\s+alpha\s+Docker\s+-\s*$/);
  });

  it("filters by technology and notes", async () => {
    fx.writeConfig();
    fx.makeRepo("py", { "requirements.txt": "flask\n" });
    fx.makeRepo("plain");
    const byTech = await fx.runCli(["list", "--tech", "python", "--json"]);
    expect(JSON.parse(byTech.stdout).map((r: { name: string }) => r.name)).toEqual(["py"]);
    const notesOnly = await fx.runCli(["list", "--notes-only"]);
    expect(notesOnly.stdout.trim()).toBe("No repositories found.");
  });

  it("reports unknown and ambiguous repos on stderr", async () => {
    fx.writeConfig();
    fx.makeRepo("a/app");
    fx.makeRepo("b/app");

    const missing = await fx.runCli(["show", "nope"]);
    expect(missing).toMatchObject({ code: 1, stdout: "" });
    expect(missing.stderr).toContain("Repository 'nope' was not found.");

    const ambiguous = await fx.runCli(["show", "app"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("ambiguous. Matches: a/app, b/app");
  });

  it("scan reports the number of repositories", async () => {
    fx.writeConfig();
    fx.makeRepo("one");
    fx.makeRepo("two");
    const result = await fx.runCli(["scan"]);
    expect(result.stdout.trim()).toBe("Scanned 2 repositories.");
  });

  it("reports an invalid config on stderr", async () => {
    fs.mkdirSync(fx.appHome, { recursive: true });
    fs.writeFileSync(path.join(fx.appHome, "config.toml"), 'roots = "nope"\n');
    const result = await fx.runCli(["list"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Config key 'roots' must be a list of strings");
  });
});

describe("argument parsing", () => {
  it("shows help and succeeds", async () => {
    const result = await fx.runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: gitlib");
    expect(result.stdout).toContain("notes");
  });

  it("rejects unknown commands", async () => {
    const result = await fx.runCli(["frobnicate"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("error");
  });

  it("requires a subcommand for `open`", async () => {
    const result = await fx.runCli(["open"]);
    expect(result.code).not.toBe(0);
  });
});

describe("open code", () => {
  it("launches VS Code for the selected repo", async () => {
    fx.writeConfig({ vscodeCommand: ["code-insiders", "--new-window"] });
    fx.makeRepo("alpha");
    const system = fakeSystem({ runCommand: () => ({ status: 0, stdout: "", stderr: "" }) });

    const result = await fx.runCli(["open", "code", "alpha"], { system });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("Opened alpha in VS Code.");
    expect(result.stderr).toBe("");
    expect(system.commands).toEqual([["code-insiders", "--new-window", path.join(fx.gitRoot, "alpha")]]);
  });

  it("surfaces launcher failures cleanly", async () => {
    fx.writeConfig();
    fx.makeRepo("alpha");
    const system = fakeSystem({ runCommand: () => ({ status: 1, stdout: "", stderr: "permission denied" }) });

    const result = await fx.runCli(["open", "code", "alpha"], { system });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unable to launch VS Code: permission denied");
  });
});

describe("open remote", () => {
  it("opens the origin landing page", async () => {
    fx.writeConfig();
    const repo = fx.initRealGitRepo("with-remotes");
    fx.git(repo, "remote", "add", "gitlab", "https://gitlab.com/example/project.git");
    fx.git(repo, "remote", "add", "origin", "https://github.com/example/project.git");
    const system = fakeSystem({});

    const result = await fx.runCli(["open", "remote", "with-remotes"], { system });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("Opened origin for with-remotes.");
    expect(result.stderr).toBe("");
    expect(system.urls).toEqual(["https://github.com/example/project"]);
  });

  it("reports when the browser cannot be opened", async () => {
    fx.writeConfig();
    const repo = fx.initRealGitRepo("fallback-remote");
    fx.git(repo, "remote", "add", "gitlab", "https://gitlab.com/example/project.git");

    const result = await fx.runCli(["open", "remote", "fallback-remote"], {
      system: fakeSystem({ openUrl: () => false }),
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unable to open gitlab for fallback-remote.");
  });
});

describe("helpers", () => {
  it("splits shell words like shlex", () => {
    expect(shellSplit(`code --wait`)).toEqual(["code", "--wait"]);
    expect(shellSplit(`"/Applications/My Editor/ed" -w 'a b' c\\ d ""`)).toEqual([
      "/Applications/My Editor/ed",
      "-w",
      "a b",
      "c d",
      "",
    ]);
    expect(() => shellSplit(`vim "unterminated`)).toThrow();
  });

  it("truncates long notes in the table preview", () => {
    const table = renderTable([
      {
        id: 1,
        rootPath: "/r",
        relativePath: "x",
        absolutePath: "/r/x",
        name: "x",
        lastSeenAt: "",
        lastScannedAt: null,
        isMissing: false,
        technologies: [],
        notes: "word ".repeat(30),
        hasNotes: true,
        description: "",
      },
    ]);
    expect(table.split("\n")[2]).toMatch(/\.\.\.$/);
  });
});
