import {
  GitLibError,
  SearchUnavailableError,
  createApplication,
  type Env,
  type GitLibApp,
  type SearchBackend,
  type SystemDeps,
} from "@gitlib/core";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { editNotes } from "./notes.js";
import { renderDetail, renderJson, renderSearchResults, renderTable, repoToDict, searchResultToDict } from "./render.js";

export const VERSION = "0.1.0";

export interface CliIo {
  /** Merged over `process.env`, so callers only need to pass overrides. */
  env?: Env;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  system?: SystemDeps;
  /** Replaces the Meilisearch backend; tests use this to avoid a real server. */
  searchBackend?: SearchBackend | null;
}

type Invocation =
  | { name: "list"; technology?: string; notesOnly?: boolean; worktrees?: boolean; json?: boolean }
  | { name: "show"; repo: string; json?: boolean }
  | {
      name: "search";
      query: string;
      technology?: string;
      notesOnly?: boolean;
      worktrees?: boolean;
      limit?: number;
      json?: boolean;
    }
  | { name: "reindex" }
  | { name: "scan" }
  | { name: "tui" }
  | { name: "open-code"; repo: string }
  | { name: "open-remote"; repo: string }
  | { name: "notes-edit"; repo: string };

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError("must be a positive whole number");
  return parsed;
}

function buildProgram(
  streams: { out: (text: string) => void; err: (text: string) => void },
  onInvoke: (invocation: Invocation) => void,
): Command {
  const program = new Command("gitlib")
    .version(VERSION)
    .exitOverride()
    .configureOutput({ writeOut: streams.out, writeErr: streams.err });

  program
    .command("list", { isDefault: true })
    .description("List repositories")
    .option("--tech <technology>", "only repositories tagged with this technology")
    .option("--notes-only", "only repositories that have notes")
    .option("--worktrees", "include linked git worktrees (hidden by default)")
    .option("--json", "machine-readable output")
    .action((options: { tech?: string; notesOnly?: boolean; worktrees?: boolean; json?: boolean }) =>
      onInvoke({
        name: "list",
        technology: options.tech,
        notesOnly: options.notesOnly,
        worktrees: options.worktrees,
        json: options.json,
      }),
    );

  program
    .command("show")
    .description("Show repository details")
    .argument("<repo>")
    .option("--json", "machine-readable output")
    .action((repo: string, options: { json?: boolean }) =>
      onInvoke({ name: "show", repo, json: options.json }),
    );

  program
    .command("search")
    .description("Full-text search across names, descriptions, notes and READMEs")
    .argument("<query...>", "words to search for")
    .option("--tech <technology>", "only repositories tagged with this technology")
    .option("--notes-only", "only repositories that have notes")
    .option("--worktrees", "include linked git worktrees (hidden by default)")
    .option("--limit <count>", "most results to return", parsePositiveInt)
    .option("--json", "machine-readable output")
    .action(
      (
        words: string[],
        options: { tech?: string; notesOnly?: boolean; worktrees?: boolean; limit?: number; json?: boolean },
      ) =>
        onInvoke({
          name: "search",
          query: words.join(" "),
          technology: options.tech,
          notesOnly: options.notesOnly,
          worktrees: options.worktrees,
          limit: options.limit,
          json: options.json,
        }),
    );

  program
    .command("reindex")
    .description("Rebuild the Meilisearch index from the scanned repositories and their READMEs")
    .action(() => onInvoke({ name: "reindex" }));

  program
    .command("scan")
    .description("Refresh repository metadata")
    .action(() => onInvoke({ name: "scan" }));

  program
    .command("tui")
    .description("Launch the interactive terminal UI")
    .action(() => onInvoke({ name: "tui" }));

  const open = program.command("open").description("Open repositories in external tools");
  open
    .command("code")
    .description("Open a repository in VS Code")
    .argument("<repo>")
    .action((repo: string) => onInvoke({ name: "open-code", repo }));
  open
    .command("remote")
    .description("Open a repository remote in your browser")
    .argument("<repo>")
    .action((repo: string) => onInvoke({ name: "open-remote", repo }));

  const notes = program.command("notes").description("Manage notes");
  notes
    .command("edit")
    .description("Edit repository notes")
    .argument("<repo>")
    .action((repo: string) => onInvoke({ name: "notes-edit", repo }));

  return program;
}

async function execute(
  invocation: Invocation,
  app: GitLibApp,
  env: Env,
  print: (text: string) => void,
  printError: (text: string) => void,
  color: boolean,
): Promise<number> {
  switch (invocation.name) {
    case "list": {
      const repositories = app.listRepositories({
        technology: invocation.technology ?? null,
        notesOnly: invocation.notesOnly ?? false,
        includeWorktrees: invocation.worktrees ?? false,
      });
      print(invocation.json ? renderJson(repositories.map(repoToDict)) : renderTable(repositories));
      return 0;
    }
    case "show": {
      const repository = app.showRepository(invocation.repo);
      print(invocation.json ? renderJson(repoToDict(repository)) : renderDetail(repository));
      return 0;
    }
    case "search": {
      const result = await app.searchRepositories(invocation.query, {
        technology: invocation.technology ?? null,
        notesOnly: invocation.notesOnly ?? false,
        includeWorktrees: invocation.worktrees ?? false,
        limit: invocation.limit,
      });
      if (result.notice) printError(`Using basic matching: ${result.notice}`);
      print(invocation.json ? renderJson(searchResultToDict(invocation.query, result)) : renderSearchResults(result, color));
      return 0;
    }
    case "reindex": {
      const count = await app.reindexSearch();
      print(`Indexed ${count} ${count === 1 ? "repository" : "repositories"} for search.`);
      return 0;
    }
    case "scan": {
      print(`Scanned ${app.refresh().length} repositories.`);
      if (app.search.enabled) {
        try {
          const count = await app.reindexSearch();
          print(`Indexed ${count} ${count === 1 ? "repository" : "repositories"} for search.`);
        } catch (error) {
          if (!(error instanceof SearchUnavailableError)) throw error;
          printError(`Search index not updated: ${error.message}`);
        }
      }
      return 0;
    }
    case "tui": {
      let runTui: typeof import("./tui/index.js").runTui;
      try {
        ({ runTui } = await import("./tui/index.js"));
      } catch (error) {
        printError(`Unable to start TUI: ${(error as Error).message}`);
        return 1;
      }
      await runTui(app);
      return 0;
    }
    case "open-code": {
      const repository = app.openRepositoryInVscode(invocation.repo, true);
      print(`Opened ${repository.relativePath} in VS Code.`);
      return 0;
    }
    case "open-remote": {
      const { repo, remote } = app.openRepositoryRemote(invocation.repo, true);
      print(`Opened ${remote.name} for ${repo.relativePath}.`);
      return 0;
    }
    case "notes-edit": {
      const current = app.showRepository(invocation.repo);
      const updated = editNotes(current.notes, env);
      const repository = app.editRepositoryNotes(invocation.repo, updated);
      print(`Updated notes for ${repository.relativePath}.`);
      if (app.search.enabled) {
        try {
          await app.syncRepositorySearch(invocation.repo);
        } catch (error) {
          if (!(error instanceof SearchUnavailableError)) throw error;
          printError(`Search index not updated: ${error.message}`);
        }
      }
      return 0;
    }
  }
}

/** Runs the CLI and resolves with the process exit code. */
export async function main(argv: readonly string[], io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const print = (text: string) => void stdout.write(`${text}\n`);
  const printError = (text: string) => void stderr.write(`${text}\n`);

  let invocation: Invocation | undefined;
  const program = buildProgram(
    { out: (text) => void stdout.write(text), err: (text) => void stderr.write(text) },
    (value) => {
      invocation = value;
    },
  );

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }

  if (!invocation) {
    stderr.write(program.helpInformation());
    return 1;
  }

  const env: Env = { ...process.env, ...io.env };

  try {
    const app = createApplication(env, io.system, io.searchBackend);
    const color = Boolean((stdout as { isTTY?: boolean }).isTTY) && !env["NO_COLOR"];
    return await execute(invocation, app, env, print, printError, color);
  } catch (error) {
    if (error instanceof GitLibError) {
      printError(error.message);
      return 1;
    }
    throw error;
  }
}
