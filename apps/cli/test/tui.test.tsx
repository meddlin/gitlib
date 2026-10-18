import { createApplication, type GitLibApp } from "@gitlib/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitLibTui } from "../src/tui/App.js";
import { computeLayout, type Rect } from "../src/tui/layout.js";
import { TuiModel } from "../src/tui/model.js";
import { Fixture, fakeSystem } from "./fixture.js";
import { renderToFakeTerminal } from "./ink-harness.js";

const KEYS = {
  down: "\u001B[B",
  up: "\u001B[A",
  tab: "\t",
  shiftTab: "\u001B[Z",
  escape: "\u001B",
  ctrlS: "\u0013",
  enter: "\r",
  backspace: "\u007F",
};

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

let fx: Fixture;
beforeEach(() => {
  fx = new Fixture();
  fx.writeConfig();
});
let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  fx.cleanup();
});

function mount(app: GitLibApp) {
  const model = new TuiModel(app);
  model.start();
  const size = { columns: 160, rows: 44 };
  const view = renderToFakeTerminal(<GitLibTui model={model} size={size} />, size);
  unmount = view.unmount;
  return {
    model,
    stdin: view.stdin,
    frame: () => view.lastFrame(),
    async press(...keys: string[]) {
      for (const key of keys) {
        view.stdin.write(key);
        await tick();
      }
    },
    /** Sends an SGR mouse report for a zero-based cell. */
    async mouse(kind: "click" | "wheelUp" | "wheelDown", x: number, y: number) {
      const code = kind === "click" ? 0 : kind === "wheelUp" ? 64 : 65;
      const suffix = `;${x + 1};${y + 1}`;
      view.stdin.write(`\u001B[<${code}${suffix}M`);
      if (kind === "click") view.stdin.write(`\u001B[<${code}${suffix}m`);
      await tick();
    },
    async click(rect: Rect, dx = 0, dy = 0) {
      await this.mouse("click", rect.x + dx, rect.y + dy);
    },
    layout: computeLayout(size.columns, size.rows),
    async type(text: string) {
      for (const char of text) await this.press(char);
    },
  };
}

describe("TUI", () => {
  it("lists repositories and updates the detail pane on selection", async () => {
    fx.initRealGitRepo("alpha", { "README.md": "# Alpha\n\nFirst repo.\n" });
    fx.initRealGitRepo("beta");
    const tui = mount(createApplication(fx.env()));

    expect(tui.model.filteredRepositories.map((r) => r.relativePath)).toEqual(["alpha", "beta"]);
    expect(tui.model.selectedRelativePath).toBe("alpha");
    expect(tui.frame()).toContain("Alpha");
    expect(tui.frame()).toContain("First repo.");

    await tui.press(KEYS.down);
    expect(tui.model.selectedRelativePath).toBe("beta");
    expect(tui.frame()).toContain("remotes: none");
    expect(tui.frame()).toContain("README.md not found.");
    expect(tui.model.displayedNotes).toBe("");
  });

  it("filters by search text, technology and notes", async () => {
    fx.makeRepo("python-cli", { "requirements.txt": "typer\n" });
    fx.makeRepo("next-app", { "package.json": JSON.stringify({ dependencies: { next: "14" } }) });
    const noted = fx.makeRepo("notes-only");
    const app = createApplication(fx.env());
    const repos = app.refresh();
    app.store.updateNotes(repos.find((r) => r.relativePath === "notes-only")!.id, "remember this");
    void noted;

    const tui = mount(app);
    const visible = () => tui.model.filteredRepositories.map((r) => r.relativePath);

    await tui.press("/");
    await tui.type("typer");
    expect(visible()).toEqual(["python-cli"]);

    for (let i = 0; i < 5; i++) await tui.press(KEYS.backspace);
    expect(visible()).toHaveLength(3);

    await tui.press(KEYS.tab);
    expect(tui.model.focus).toBe("technology");
    await tui.type("next.js");
    expect(visible()).toEqual(["next-app"]);
    for (let i = 0; i < 7; i++) await tui.press(KEYS.backspace);

    await tui.press(KEYS.tab, " ");
    expect(tui.model.notesOnly).toBe(true);
    expect(visible()).toEqual(["notes-only"]);
    expect(tui.frame()).toContain("[x] Notes only");
  });

  it("does not treat typed letters in a filter as shortcuts", async () => {
    fx.makeRepo("alpha");
    const tui = mount(createApplication(fx.env()));
    await tui.press("/");
    await tui.type("qre");
    expect(tui.model.didRequestExit).toBe(false);
    expect(tui.model.search.value).toBe("qre");
    await tui.press(KEYS.escape);
    expect(tui.model.focus).toBe("table");
    expect(tui.model.status).toBe("Focus returned to repository list.");
  });

  it("refresh preserves the selection and picks up new repos", async () => {
    fx.makeRepo("alpha");
    fx.makeRepo("beta");
    const tui = mount(createApplication(fx.env()));
    await tui.press(KEYS.down);
    expect(tui.model.selectedRelativePath).toBe("beta");

    fx.makeRepo("gamma");
    await tui.press("r");
    expect(tui.model.selectedRelativePath).toBe("beta");
    expect(tui.model.repositories.map((r) => r.relativePath)).toContain("gamma");
    expect(tui.model.status).toContain("Refreshed 3 repositories.");
  });

  it("saves inline notes, visible to the CLI", async () => {
    fx.makeRepo("alpha");
    const tui = mount(createApplication(fx.env()));

    await tui.press("e");
    expect(tui.model.editMode).toBe(true);
    expect(tui.model.focus).toBe("notes");
    await tui.type("saved from tui");
    await tui.press(KEYS.enter);
    await tui.type("line two");
    expect(tui.frame()).toContain("line two");
    await tui.press(KEYS.ctrlS);

    expect(tui.model.editMode).toBe(false);
    expect(tui.model.selectedRelativePath).toBe("alpha");
    expect(tui.model.status).toBe("Saved notes for alpha.");

    const show = await fx.runCli(["show", "alpha", "--json"]);
    expect(JSON.parse(show.stdout).notes).toBe("saved from tui\nline two");
  });

  it("cancels note edits with escape and blocks refresh while editing", async () => {
    fx.makeRepo("alpha");
    const app = createApplication(fx.env());
    app.refresh();
    app.saveRepositoryNotes("alpha", "original");
    const tui = mount(app);

    await tui.press("e");
    await tui.type("!!");
    expect(tui.model.displayedNotes).toBe("original!!");
    await tui.press(KEYS.tab);
    expect(tui.model.focus).toBe("notes");
    await tui.press("r");
    expect(tui.model.displayedNotes).toBe("original!!r");

    await tui.press(KEYS.escape);
    expect(tui.model.editMode).toBe(false);
    expect(tui.model.displayedNotes).toBe("original");
    expect(app.getRepository("alpha").notes).toBe("original");
    expect(tui.model.status).toBe("Canceled note edits for alpha.");
  });

  it("previews READMEs, including missing and unreadable ones", async () => {
    fx.makeRepo("alpha", { "README.md": "# Alpha\n\nFirst version.\n" });
    fx.makeRepo("beta", { "README.md": "# Beta\n" });
    const app = createApplication(fx.env());
    const tui = mount(app);

    expect(tui.frame()).toContain("First version.");
    await tui.press(KEYS.down);
    expect(tui.frame()).toContain("Beta");
    expect(tui.frame()).not.toContain("First version.");

    await tui.press(KEYS.up);
    const fs = await import("node:fs");
    fs.writeFileSync(`${fx.gitRoot}/alpha/README.md`, "# Alpha\n\nUpdated after refresh.\n");
    await tui.press("r");
    expect(tui.model.selectedRelativePath).toBe("alpha");
    expect(tui.frame()).toContain("Updated after refresh.");
  });

  it("shows a message for unreadable READMEs", async () => {
    const fs = await import("node:fs");
    fx.makeRepo("alpha");
    fs.mkdirSync(`${fx.makeRepo("broken")}/README.md`);
    const tui = mount(createApplication(fx.env()));
    expect(tui.model.readmeText).toBe("README.md not found.");
    await tui.press(KEYS.down);
    expect(tui.model.readmeText).toContain("Unable to load README.md:");
  });

  it("can focus, scroll and leave the README pane", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}\n`).join("\n");
    fx.makeRepo("alpha", { "README.md": `# Long\n\n${lines}` });
    const tui = mount(createApplication(fx.env()));

    await tui.press(KEYS.tab);
    expect(tui.model.focus).toBe("readme");
    expect(tui.model.readmeScroll).toBe(0);
    await tui.press(KEYS.down, KEYS.down, KEYS.down);
    expect(tui.model.readmeScroll).toBe(3);
    await tui.press(KEYS.up);
    expect(tui.model.readmeScroll).toBe(2);
    expect(tui.frame()).toMatch(/README\.md \(3-\d+\/\d+\)/);
    await tui.press("\u001B[6~"); // page down
    expect(tui.model.readmeScroll).toBeGreaterThan(10);

    await tui.press(KEYS.escape);
    expect(tui.model.focus).toBe("table");
  });

  it("quits on q", async () => {
    fx.makeRepo("alpha");
    const tui = mount(createApplication(fx.env()));
    await tui.press("q");
    expect(tui.model.didRequestExit).toBe(true);
  });

  it("shows remote targets for the selected repo", async () => {
    fx.initRealGitRepo("alpha");
    const withRemote = fx.initRealGitRepo("beta", { "README.md": "# With Remote\n" });
    fx.git(withRemote, "remote", "add", "origin", "https://github.com/example/origin.git");
    fx.git(withRemote, "remote", "add", "gitlab", "https://gitlab.com/example/project.git");
    const tui = mount(createApplication(fx.env()));

    expect(tui.frame()).toContain("remotes: none");
    await tui.press(KEYS.down);
    const frame = tui.frame();
    expect(frame).toContain("remotes: 2 configured");
    expect(frame).toContain("gitlab -> GitLab (gitlab.com)");
    expect(frame).toContain("landing page: https://gitlab.com/example/project");
    expect(frame).toContain("With Remote");
  });

  it("shows push differences and unavailable landing pages", async () => {
    const diff = fx.initRealGitRepo("alpha");
    fx.git(diff, "remote", "add", "origin", "https://github.com/example/project.git");
    fx.git(diff, "remote", "set-url", "--push", "origin", "https://gitlab.com/example/project.git");
    const local = fx.initRealGitRepo("beta");
    fx.git(local, "remote", "add", "origin", `${fx.base}/mirrors/beta.git`);
    const tui = mount(createApplication(fx.env()));

    expect(tui.frame()).toContain("origin -> GitHub (github.com) | push differs: GitLab");
    expect(tui.frame()).toContain("(gitlab.com)");
    await tui.press(KEYS.down);
    expect(tui.frame()).toContain("landing page: unavailable");
  });

  it("reports remote lookup failures without crashing", () => {
    fx.makeRepo("fake-git");
    const tui = mount(createApplication(fx.env()));
    expect(tui.frame()).toContain("remotes: unavailable");
    expect(tui.model.status).toContain("Remotes unavailable");
  });

  describe("launchers", () => {
    it("opens VS Code for the selected repo", async () => {
      fx.writeConfig({ vscodeCommand: ["code-insiders", "--new-window"] });
      fx.makeRepo("alpha");
      const system = fakeSystem({ runCommand: () => ({ status: 0, stdout: "", stderr: "" }) });
      const tui = mount(createApplication(fx.env(), system));

      await tui.press("v");
      expect(system.commands).toEqual([["code-insiders", "--new-window", `${fx.gitRoot}/alpha`]]);
      expect(tui.model.status).toBe("Opened alpha in VS Code.");
    });

    it("shows launcher failures in the status line", async () => {
      fx.makeRepo("alpha");
      const system = fakeSystem({
        runCommand: () => {
          throw new Error("code command not found");
        },
      });
      const tui = mount(createApplication(fx.env(), system));
      await tui.press("v");
      expect(tui.model.status).toContain("Unable to launch VS Code: code command not found");
      expect(tui.frame()).toContain("Unable to launch VS Code");
    });

    it("tells you when nothing is selected", async () => {
      const tui = mount(createApplication(fx.env()));
      for (const key of ["v", "o", "e"]) {
        await tui.press(key);
        expect(tui.model.status).toBe("No repository selected.");
      }
    });

    it("opens the preferred remote, falling back and reporting failures", async () => {
      const alpha = fx.initRealGitRepo("alpha");
      fx.git(alpha, "remote", "add", "gitlab", "https://gitlab.com/example/project.git");
      const beta = fx.initRealGitRepo("beta");
      fx.git(beta, "remote", "add", "gitlab", "https://gitlab.com/example/other.git");
      fx.git(beta, "remote", "add", "origin", "https://github.com/example/project.git");
      const gamma = fx.initRealGitRepo("gamma");
      fx.git(gamma, "remote", "add", "origin", "https://github.com/example/gamma.git");
      fx.initRealGitRepo("delta");

      let browserWorks = true;
      const system = fakeSystem({ openUrl: () => browserWorks });
      const tui = mount(createApplication(fx.env(), system));

      await tui.press("o");
      expect(tui.model.status).toBe("Opened gitlab for alpha.");
      await tui.press(KEYS.down, "o");
      expect(tui.model.status).toBe("Opened origin for beta.");
      expect(system.urls).toEqual([
        "https://gitlab.com/example/project",
        "https://github.com/example/project",
      ]);

      browserWorks = false;
      await tui.press(KEYS.down, "o");
      expect(tui.model.status).toBe("No remote landing page available for delta.");
      await tui.press(KEYS.down, "o");
      expect(tui.model.status).toBe("Unable to open origin for gamma.");
    });
  });

  describe("mouse", () => {
    it("selects a repository by clicking its row", async () => {
      fx.makeRepo("alpha");
      fx.makeRepo("beta");
      fx.makeRepo("gamma");
      const tui = mount(createApplication(fx.env()));
      await tui.press("/");
      expect(tui.model.focus).toBe("search");

      await tui.click(tui.layout.tableRows, 3, 2);
      expect(tui.model.selectedRelativePath).toBe("gamma");
      expect(tui.model.focus).toBe("table");

      await tui.click(tui.layout.tableRows, 0, 0);
      expect(tui.model.selectedRelativePath).toBe("alpha");
      // Clicking below the last row keeps the selection.
      await tui.click(tui.layout.tableRows, 0, 10);
      expect(tui.model.selectedRelativePath).toBe("alpha");
    });

    it("does not leak mouse reports into text inputs or shortcuts", async () => {
      fx.makeRepo("alpha");
      const tui = mount(createApplication(fx.env()));
      await tui.press("/");
      await tui.mouse("click", 90, 30);
      await tui.mouse("wheelDown", 90, 30);
      expect(tui.model.search.value).toBe("");
      expect(tui.model.didRequestExit).toBe(false);
    });

    it("scrolls the table and README with the wheel", async () => {
      const lines = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}\n`).join("\n");
      fx.makeRepo("alpha", { "README.md": `# Long\n\n${lines}` });
      fx.makeRepo("beta");
      const tui = mount(createApplication(fx.env()));
      const { tableRows, readme } = tui.layout;

      await tui.mouse("wheelDown", tableRows.x + 2, tableRows.y + 1);
      expect(tui.model.selectedRelativePath).toBe("beta");
      await tui.mouse("wheelUp", tableRows.x + 2, tableRows.y + 1);
      expect(tui.model.selectedRelativePath).toBe("alpha");

      await tui.mouse("wheelDown", readme.x + 2, readme.y + 3);
      expect(tui.model.readmeScroll).toBe(3);
      await tui.mouse("wheelUp", readme.x + 2, readme.y + 3);
      expect(tui.model.readmeScroll).toBe(0);
      await tui.mouse("wheelUp", readme.x + 2, readme.y + 3);
      expect(tui.model.readmeScroll).toBe(0);
    });

    it("focuses filter fields, toggles the checkbox and focuses the README", async () => {
      fx.makeRepo("alpha");
      const app = createApplication(fx.env());
      app.refresh();
      app.saveRepositoryNotes("alpha", "noted");
      fx.makeRepo("beta");
      const tui = mount(app);
      const { search, technology, notesOnly, readme } = tui.layout;

      await tui.click(search, 12);
      expect(tui.model.focus).toBe("search");
      await tui.type("alp");
      expect(tui.model.search.value).toBe("alp");
      await tui.click(technology, 14);
      expect(tui.model.focus).toBe("technology");

      await tui.click(notesOnly, 1);
      expect(tui.model.notesOnly).toBe(true);
      expect(tui.model.focus).toBe("notes-only");
      await tui.click(notesOnly, 1);
      expect(tui.model.notesOnly).toBe(false);

      await tui.click(readme, 3, 2);
      expect(tui.model.focus).toBe("readme");
    });

    it("starts editing by clicking notes, places the cursor and saves from the footer", async () => {
      fx.makeRepo("alpha");
      const app = createApplication(fx.env());
      app.refresh();
      app.saveRepositoryNotes("alpha", "first line\nsecond line");
      const tui = mount(app);
      const { notes, footer } = tui.layout;

      await tui.click(notes, 4, 1);
      expect(tui.model.editMode).toBe(true);
      expect(tui.model.notes.position()).toEqual({ row: 1, column: 4 });
      await tui.type("X");
      expect(tui.model.notes.value).toBe("first line\nsecoXnd line");

      // Clicking outside the notes while editing must not change the selection or mode.
      await tui.click(tui.layout.tableRows, 0, 0);
      expect(tui.model.editMode).toBe(true);

      const save = footer.find((button) => button.action === "save")!;
      await tui.click(save.rect, 1);
      expect(tui.model.editMode).toBe(false);
      expect(app.getRepository("alpha").notes).toBe("first line\nsecoXnd line");
    });

    it("runs footer actions: edit, cancel, VS Code, refresh and quit", async () => {
      fx.makeRepo("alpha");
      const system = fakeSystem({ runCommand: () => ({ status: 0, stdout: "", stderr: "" }) });
      const tui = mount(createApplication(fx.env(), system));
      const button = (action: string) => tui.layout.footer.find((b) => b.action === action)!.rect;

      await tui.click(button("edit"));
      expect(tui.model.editMode).toBe(true);
      await tui.click(button("cancel"));
      expect(tui.model.editMode).toBe(false);

      await tui.click(button("vscode"));
      expect(system.commands).toHaveLength(1);
      expect(tui.model.status).toBe("Opened alpha in VS Code.");

      await tui.click(button("refresh"));
      expect(tui.model.status).toContain("Refreshed 1 repositories.");

      await tui.click(button("search"));
      expect(tui.model.focus).toBe("search");

      await tui.click(button("quit"));
      expect(tui.model.didRequestExit).toBe(true);
    });

    it("ignores non-left buttons", async () => {
      fx.makeRepo("alpha");
      fx.makeRepo("beta");
      const tui = mount(createApplication(fx.env()));
      const { tableRows } = tui.layout;
      tui.stdin.write(`\u001B[<2;${tableRows.x + 2};${tableRows.y + 2}M`);
      await tick();
      expect(tui.model.selectedRelativePath).toBe("alpha");
    });
  });
});
