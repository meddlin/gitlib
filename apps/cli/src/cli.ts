import path from "node:path";
import {
  GitLibError,
  SearchUnavailableError,
  backupFileName,
  createApplication,
  createBackup,
  getAppHome,
  getBackupDir,
  pruneBackups,
  restoreBackup,
  verifyBackup,
  type BackupManifest,
  type DependabotBackend,
  type Env,
  type GitLibApp,
  type SearchBackend,
  type SystemDeps,
} from "@gitlib/core";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { editNotes } from "./notes.js";
import {
  dependabotReportToDict,
  renderDependabotReport,
  renderDetail,
  renderJson,
  renderSearchResults,
  renderTable,
  repoToDict,
  searchResultToDict,
} from "./render.js";

export const VERSION = "0.1.0";

const TRIGGER_NAMES = { cli: "the CLI", web: "the web page", schedule: "the schedule" } as const;

export interface CliIo {
  /** Merged over `process.env`, so callers only need to pass overrides. */
  env?: Env;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  system?: SystemDeps;
  /** Replaces the Meilisearch backend; tests use this to avoid a real server. */
  searchBackend?: SearchBackend | null;
  /** Replaces the GitHub backend of `dependabot check`; tests use this to avoid the network. */
  dependabotBackend?: DependabotBackend | null;
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
  | { name: "notes-edit"; repo: string }
  | { name: "dependabot-check"; json?: boolean; save: boolean }
  | { name: "dependabot-show"; json?: boolean }
  | { name: "dependabot-dismiss"; pr: DependabotPrRef; until?: string }
  | { name: "dependabot-restore"; pr: DependabotPrRef }
  | { name: "planning-backup"; destination?: string }
  | { name: "backup-create"; directory?: string; keep?: number }
  | { name: "backup-verify"; archive: string }
  | { name: "backup-restore"; archive: string; yes?: boolean };

type BackupInvocation = Extract<Invocation, { name: `backup-${string}` }>;

const isBackupInvocation = (invocation: Invocation): invocation is BackupInvocation =>
  invocation.name.startsWith("backup-");

interface DependabotPrRef {
  repo: string;
  number: number;
}

/** `owner/repo#123`, the way the report prints a pull request. */
function parsePrRef(value: string): DependabotPrRef {
  const match = /^(?<repo>[^#\s]+\/[^#\s]+)#(?<number>\d+)$/.exec(value);
  if (!match?.groups) throw new InvalidArgumentError("expected owner/repo#number, e.g. meddlin/gitlib#41");
  return { repo: match.groups["repo"]!, number: Number(match.groups["number"]) };
}

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

  const dependabot = program.command("dependabot").description("Watch Dependabot pull requests on your starred repositories");
  dependabot
    .command("check")
    .description("Report which open Dependabot PRs on starred repositories can be merged and which need work")
    .option("--json", "machine-readable output")
    .option("--no-save", "do not store the result as the newest run")
    .action((options: { json?: boolean; save: boolean }) => onInvoke({ name: "dependabot-check", json: options.json, save: options.save }));
  dependabot
    .command("show")
    .description("Show the newest stored Dependabot check without contacting GitHub")
    .option("--json", "machine-readable output")
    .action((options: { json?: boolean }) => onInvoke({ name: "dependabot-show", json: options.json }));

  dependabot
    .command("dismiss")
    .description("Put a Dependabot PR aside so reports and the badge leave it out")
    .argument("<pr>", "owner/repo#number, as printed in the report", parsePrRef)
    .option("--until <date>", "bring it back on this date (e.g. 2026-12-01); default is until the PR closes")
    .action((pr: DependabotPrRef, options: { until?: string }) => onInvoke({ name: "dependabot-dismiss", pr, until: options.until }));
  dependabot
    .command("restore")
    .description("Bring a dismissed Dependabot PR back")
    .argument("<pr>", "owner/repo#number", parsePrRef)
    .action((pr: DependabotPrRef) => onInvoke({ name: "dependabot-restore", pr }));

  const planning = program.command("planning").description("Manage gitlib's own planning data (issues)");
  planning
    .command("backup")
    .description("Snapshot planning.db, which cannot be rebuilt by rescanning")
    .argument("[path]", "file to write (default: <gitlib home>/backups/planning-<timestamp>.db)")
    .action((destination: string | undefined) => onInvoke({ name: "planning-backup", destination }));

  const backup = program.command("backup").description("Back up and restore all gitlib data (config, notes, planning)");
  backup
    .command("create")
    .description("Write a verified .tar.gz of config.toml, gitlib.db and planning.db")
    .argument("[dir]", "directory to write into (default: $GITLIB_BACKUP_DIR, else <gitlib home>/backups)")
    .option("--keep <n>", "afterwards delete all but the newest <n> backups in that directory", parsePositiveInt)
    .action((directory: string | undefined, options: { keep?: number }) =>
      onInvoke({ name: "backup-create", directory, keep: options.keep }),
    );
  backup
    .command("verify")
    .description("Check an archive's checksums, SQLite integrity and schema version without restoring it")
    .argument("<archive>")
    .action((archive: string) => onInvoke({ name: "backup-verify", archive }));
  backup
    .command("restore")
    .description("Replace this gitlib's data with an archive (stop the web app first)")
    .argument("<archive>")
    .option("--yes", "actually restore; without it the archive is only verified and described")
    .action((archive: string, options: { yes?: boolean }) =>
      onInvoke({ name: "backup-restore", archive, yes: options.yes }),
    );

  return program;
}

function describeManifest(manifest: BackupManifest): string[] {
  const counts = Object.entries(manifest.summary).map(([key, value]) => `${value} ${key}`);
  return [
    `  created   ${manifest.createdAt} on ${manifest.hostname}${manifest.createdBy ? ` (${manifest.createdBy})` : ""}`,
    `  files     ${manifest.files.map((file) => file.name).join(", ")}`,
    ...(counts.length > 0 ? [`  contents  ${counts.join(", ")}`] : []),
  ];
}

const formatBytes = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`);

/** These work on the data files directly, so they must not go through `createApplication` (it creates them). */
function runBackupCommand(
  invocation: BackupInvocation,
  env: Env,
  print: (text: string) => void,
): number {
  const appHome = getAppHome(env);
  switch (invocation.name) {
    case "backup-create": {
      const directory = path.resolve(invocation.directory ?? getBackupDir(env));
      const result = createBackup(appHome, path.join(directory, backupFileName()), { createdBy: `gitlib ${VERSION}` });
      print(`Backed up ${appHome} to ${result.path} (${formatBytes(result.bytes)}).`);
      for (const line of describeManifest(result.manifest)) print(line);
      if (invocation.keep !== undefined) {
        const removed = pruneBackups(directory, invocation.keep);
        if (removed.length > 0) print(`Removed ${removed.length} older backup${removed.length === 1 ? "" : "s"} (keeping ${invocation.keep}).`);
      }
      return 0;
    }
    case "backup-verify": {
      const manifest = verifyBackup(invocation.archive);
      print(`${invocation.archive} is a valid backup.`);
      for (const line of describeManifest(manifest)) print(line);
      return 0;
    }
    case "backup-restore": {
      const manifest = verifyBackup(invocation.archive);
      if (!invocation.yes) {
        print(`${invocation.archive} is a valid backup:`);
        for (const line of describeManifest(manifest)) print(line);
        print(`\nRestoring would replace the data in ${appHome}. Stop the web app, then re-run with --yes.`);
        return 1;
      }
      const result = restoreBackup(invocation.archive, appHome, { safetyDir: getBackupDir(env) });
      print(`Restored ${result.restored.join(", ")} into ${appHome}.`);
      for (const line of describeManifest(result.manifest)) print(line);
      print(result.safetyBackup ? `The previous data was saved to ${result.safetyBackup}.` : "There was no existing data to save.");
      print("The search index is derived data: restart the web app (or run `gitlib reindex`) to rebuild it.");
      return 0;
    }
  }
}

async function execute(
  invocation: Exclude<Invocation, BackupInvocation>,
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
    case "dependabot-check": {
      const now = new Date();
      const dismissals = app.listDependabotDismissals();
      // A stored check also takes the lock that keeps the web button and the schedule from running at the same time.
      const stored = invocation.save ? await app.runDependabotCheck({ trigger: "cli", now }) : null;
      const report = stored?.report ?? (await app.checkDependabot({ now }));
      const run = stored ? { id: stored.id, trigger: stored.trigger } : null;
      print(
        invocation.json
          ? renderJson(dependabotReportToDict(report, { run, dismissals, now }))
          : renderDependabotReport(report, {
              color,
              dismissals,
              now,
              footer: stored ? [`Saved as run ${stored.id}; read it again with \`gitlib dependabot show\`.`] : [],
            }),
      );
      // A report that could not cover every owner is not a clean bill of health, so a scheduler can notice.
      return report.errors.length > 0 ? 1 : 0;
    }
    case "dependabot-show": {
      const stored = app.latestDependabotRun();
      if (!stored) {
        printError("No Dependabot check has been saved yet. Run `gitlib dependabot check` first.");
        return 1;
      }
      const now = new Date();
      const dismissals = app.listDependabotDismissals();
      const run = { id: stored.id, trigger: stored.trigger };
      print(
        invocation.json
          ? renderJson(dependabotReportToDict(stored.report, { run, dismissals, now }))
          : renderDependabotReport(stored.report, {
              color,
              dismissals,
              now,
              header: [`Stored run ${stored.id}, started by ${TRIGGER_NAMES[stored.trigger]}; GitHub was not contacted.`, ""],
            }),
      );
      return 0;
    }
    case "dependabot-dismiss": {
      const { repo, number } = invocation.pr;
      const dismissal = app.dismissDependabotPr(repo, number, invocation.until ?? null);
      print(
        dismissal.snoozedUntil
          ? `Put ${repo}#${number} aside until ${dismissal.snoozedUntil}.`
          : `Put ${repo}#${number} aside until it closes. Bring it back with \`gitlib dependabot restore ${repo}#${number}\`.`,
      );
      return 0;
    }
    case "dependabot-restore": {
      app.restoreDependabotPr(invocation.pr.repo, invocation.pr.number);
      print(`${invocation.pr.repo}#${invocation.pr.number} is no longer put aside.`);
      return 0;
    }
    case "planning-backup": {
      print(`Backed up the planning database to ${app.backupPlanning(invocation.destination)}.`);
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
    if (isBackupInvocation(invocation)) return runBackupCommand(invocation, env, print);
    const app = createApplication(env, io.system, io.searchBackend, undefined, io.dependabotBackend);
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
