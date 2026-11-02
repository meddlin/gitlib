# Gitlib

## Overview

Gitlib is a local-first tool for managing Git repositories stored under `~/git`.
It scans your local repos, tracks detected technologies, and lets you store notes
for each project without depending on GitHub.

On first run, Gitlib bootstraps its local app data in `~/.git-library/`.

## Quick Standup

Use these commands to quickly get the project running locally after you've cloned it. You may need
to update values in `.env` after this.

```
cp .env.example .env
docker compose up -d --build
```

## Project Layout

Gitlib is an npm-workspaces monorepo written entirely in TypeScript:

```text
apps/
  cli/    gitlib       – the `gitlib` command and the Ink-based terminal UI
  web/    @gitlib/web  – TanStack Start web app (Tailwind + shadcn/ui)
packages/
  core/   @gitlib/core – discovery, tech scanning, SQLite store, config, remotes (UI-agnostic)
```

Apps are deployable entry points; packages are libraries they share. `@gitlib/core` has no
terminal or browser dependencies, so the CLI and the web app both build on it. Its data types
are plain camelCase objects.

## Run the App

Requires Node.js 24 or newer (the store uses the built-in `node:sqlite` module).

```bash
npm install
```

Run it directly from source:

```bash
npm run gitlib -- list
npm run gitlib -- tui
```

Or build it and use the `gitlib` command:

```bash
npm run build
npm link -w gitlib   # puts `gitlib` on your PATH
gitlib list
gitlib tui
```

Other scripts:

```bash
npm test             # vitest, all packages
npm run typecheck    # tsc --noEmit across the workspace
```

Operational notes:

- Linked `git worktree` checkouts (for example `.claude/worktrees/*`) are discovered but
  hidden from listings by default, because they are extra checkouts of a repo you already
  have rather than separate repos. Use `gitlib list --worktrees`, the TUI `w` key, or the
  web app's **Show worktrees** checkbox to see them. Submodules are still listed as repos.

- First run creates `~/.git-library/` for config and SQLite data (override with `GITLIB_HOME`).
- The default scan root is `~/git`.
- The SQLite schema is unchanged from the original Python version, so an existing
  `~/.git-library/gitlib.db` keeps working.

## Search

Gitlib can search repository names, paths, descriptions, notes and **README contents** with typo
tolerance, relevance ranking and highlighted snippets, powered by [Meilisearch](https://www.meilisearch.com/).
Meilisearch is optional: without it, search falls back to plain substring matching (and the web app
says so). Why Meilisearch was chosen over the alternatives is recorded in
[`docs/search-options.md`](docs/search-options.md).

Start a local server (any of these):

```bash
brew install meilisearch && meilisearch --no-analytics          # http://127.0.0.1:7700
docker run -p 7700:7700 -v "$PWD/meili_data:/meili_data" getmeili/meilisearch:latest
```

Then build the index and search:

```bash
gitlib reindex                       # index every scanned repo, including READMEs
gitlib search invoices               # ranked results with highlighted snippets
gitlib search "tomato planner" --tech TypeScript --json
```

The index is a derived copy of your data: `gitlib scan` and the web app's **Rescan** rebuild it, and
saving notes or a description updates that repo. If you ever suspect it is stale, run `gitlib reindex`.

Configure it in `~/.git-library/config.toml` (all keys optional):

```toml
[search]
enabled = true                        # false = never contact Meilisearch
host = "http://127.0.0.1:7700"
api_key = ""                          # master/search key if your server needs one
index = "gitlib_repos"
```

`GITLIB_MEILI_HOST` and `GITLIB_MEILI_API_KEY` override `host` and `api_key`. The web app's search bar
is pinned to the top of the Repositories page (press `/` to focus it).

## Planning

The web app's **Planning** page (`/planning`) is a place to file and track work against any
repository gitlib has scanned. Issues are **gitlib's own**: they are stored in gitlib and are never
read from, copied from or sent to GitHub or GitLab (the repo page's **Issues** and **Pull requests**
tabs are separate and stay read-only GitHub views).

- **New issue** files one against any repo (title, optional Markdown description). Issues are numbered
  per repo, so they read as `repo#3`. Open an issue to edit it, close it, or reopen it. The list filters
  by state and repo, and the filters live in the URL (`?state=closed&repo=…`).
- Descriptions are rendered as Markdown with raw HTML dropped and only `http(s)` links made live.
- An issue is tied to its repo by the repo's relative path. If a repo is moved or deleted its issues
  stay readable and are labelled "repository not found"; new issues can only be filed against repos
  gitlib currently sees.

Planning data lives in its own file, `~/.git-library/planning.db`, not in `gitlib.db`. `gitlib.db` is
rebuilt by rescanning and its tables are shared with the original Python version; planning data cannot
be rebuilt, so it has its own versioned schema (append-only migrations tracked in `PRAGMA
user_version`; a database written by a newer gitlib is refused rather than opened). Snapshot it with:

```bash
gitlib planning backup                    # ~/.git-library/backups/planning-<timestamp>.db
gitlib planning backup /path/to/copy.db   # refuses to overwrite an existing file
```

`gitlib backup` covers the planning database together with everything else; see
[Backup and restore](#backup-and-restore). In Docker, `planning.db` sits in the `gitlib-data` volume with the
rest of gitlib's data.

## Web App

`apps/web/` is a [TanStack Start](https://tanstack.com/start) app that reads the same
`~/.git-library` data as the CLI (via `@gitlib/core`, on the server only):

```bash
npm run web          # dev server at http://localhost:4000
npm run build -w @gitlib/web && npm run preview -w @gitlib/web   # production build
```

- Each repo has a detail page (click its name) with Overview, **Issues** and **Pull requests** tabs; the
  last two list open GitHub items and say so in a banner. Public repos work as-is; set
  `GITLIB_GITHUB_TOKEN` (or `GITHUB_TOKEN`) for private repos and a higher rate limit. The web server
  reads it from the environment or from `.env.local` / `.env` in `apps/web/` or the repo root (both
  gitignored); `apps/web/.env.example` shows the format.
- The repo table's **Community** column and each repo's **Community** tab show GitHub's
  [community profile](https://docs.github.com/rest/metrics/community) score. The column gives the
  percentage plus one square per recommended item (description, README, license, code of conduct,
  contributing guide, issue and pull request templates), hollow when missing; hover for the names, click
  through to the tab for what each item is for. It is sortable (lowest first). Scores are stored in the
  local database (`github_community_profiles` table in `gitlib.db`), so the table shows them at once and
  works offline. They are fetched from GitHub again once a day (the server checks hourly, and a page load
  also starts a refresh when scores are older than that), or whenever you press **Refresh scores** on the
  repository list or **Refresh** on a repo's Community tab. **Rescan** does not touch them. Set
  `GITLIB_COMMUNITY_REFRESH_HOURS` to change the interval (`0` = only on the buttons). A refresh costs one
  GitHub request per repo, so without a token (60 requests an hour) it stops early and says so, leaving the
  rest of the limit for the Issues and Pull requests tabs; the oldest scores are refreshed first, so the
  next run carries on. Set `GITLIB_GITHUB_TOKEN` to refresh everything.
  Each missing item on the Community tab has an **Add to planning** button that files a gitlib
  [planning](#planning) issue for it (stored in gitlib only); once filed, the row links to that issue.
- The **Planning** page (`/planning`) holds gitlib's own issues; see [Planning](#planning).
- Lists every git repo found under your configured scan roots (scanned on first load; use
  **Rescan** after adding repos).
- Add or edit a short **description** per repo. It is stored in the shared SQLite database
  (`repo_descriptions` table) and is searchable.
- Cards highlight each repo's detected **languages and frameworks** (colour-coded by
  language / framework / runtime / tooling). Click any badge, or one of the chips under the
  search box, to filter; filters live in the URL (`?q=…&tech=…`).
- The **Settings** page (gear icon, `/settings`) picks a colour scheme: System (follows the
  OS), Light, Dark, or one of the generated Ocean, Forest, Sunset and Orchid schemes. The
  choice is saved in the browser's `localStorage`. Palettes are defined in
  `apps/web/src/styles.css`; add a scheme there and in `apps/web/src/lib/themes.ts`.

## Run with Docker

`docker-compose.yml` runs the production build of the web app plus Meilisearch for search. The same file
works on a Mac with Docker Desktop and on a homelab VM; only `.env` differs.

```bash
cp .env.example .env               # optional: set GITLIB_REPOS if your repos are not in ~/git
docker compose up -d --build       # http://localhost:4000
```

The web app listens on **port 4000** (`GITLIB_PORT` to change it) and is published on `127.0.0.1` only, because it
has **no login**. On a server or homelab VM, set `GITLIB_BIND=0.0.0.0` in `.env` (then `docker compose up -d`) to
reach it from other machines on a trusted LAN, and keep it off the internet or behind an authenticating reverse
proxy. See [docs/runbook.md](docs/runbook.md#3-homelab-install) if the page still does not load.

- Your repos are mounted read-only at `/home/node/git`, the default scan root for the container user. The host
  directory is `~/git` unless you set `GITLIB_REPOS` in `.env` (e.g. `GITLIB_REPOS=/Volumes/work/code`); run
  `docker compose up -d` afterwards and press **Rescan**.
- Config, notes, descriptions and planning data live in the `gitlib-data` volume (`GITLIB_HOME=/data`); the
  search index lives in `meili-data` and is rebuilt automatically, so it is not backed up.
- `docker compose down` keeps your data; `docker compose down -v` **deletes it**.
- The `gitlib` CLI is in the image: `docker compose exec web gitlib scan`.

### Backup and restore

```bash
scripts/backup.sh                           # -> backups/gitlib-backup-<timestamp>.tar.gz, safe while running
scripts/restore.sh backups/gitlib-backup-<timestamp>.tar.gz
```

A backup holds `config.toml`, `gitlib.db` (notes, descriptions, favorites) and `planning.db`, with checksums.
Archives are verified when written and again before a restore, and a restore first saves what it replaces.
Restoring a local backup into the homelab instance is the intended way to promote data between them. The full
procedure, scheduling, off-site copies, disaster recovery and troubleshooting are in
**[`docs/runbook.md`](docs/runbook.md)**, which is also the install and setup guide for a local machine and a
homelab VM.

## Current CLI Commands

These commands are implemented today:

```bash
gitlib list [--tech TAG] [--notes-only] [--worktrees] [--json]
gitlib show <repo> [--json]
gitlib scan
gitlib open code <repo>
gitlib open remote <repo>
gitlib tui
gitlib notes edit <repo>
gitlib planning backup [path]
gitlib backup create [dir] [--keep N]
gitlib backup verify <archive>
gitlib backup restore <archive> [--yes]
```

Command summary:

- `gitlib list` lists all discovered repos.
- `gitlib list --tech TAG` filters repos by a detected technology tag.
- `gitlib list --notes-only` shows only repos with notes.
- `gitlib list --worktrees` also lists linked `git worktree` checkouts (hidden by default).
- `gitlib list --json` returns machine-readable output.
- `gitlib show <repo>` shows details for one repo.
- `gitlib scan` refreshes repo discovery and technology metadata.
- `gitlib open code <repo>` opens the repo root in a new VS Code window.
- `gitlib open remote <repo>` opens the preferred configured remote in your browser.
- `gitlib tui` launches the interactive terminal UI.
- `gitlib notes edit <repo>` opens your configured editor to update repo notes.
- `gitlib planning backup [path]` snapshots the planning database (see [Planning](#planning)).
- `gitlib backup create [dir]` writes a verified archive of everything gitlib stores that cannot be rebuilt
  (config, notes, descriptions, favorites, planning) to `dir` (default `$GITLIB_BACKUP_DIR`, else
  `<gitlib home>/backups`); `--keep N` prunes older archives.
- `gitlib backup verify <archive>` checks checksums, SQLite integrity and schema version without restoring.
- `gitlib backup restore <archive>` describes the archive; add `--yes` to replace the current data (the old data
  is saved first). Stop the web app before restoring. See [Backup and restore](#backup-and-restore).

## TUI Mode

Launch the full-screen terminal UI with:

```bash
gitlib tui
```

The TUI mirrors the current CLI capabilities:

- Repo list
- Repo detail view
- Compact notes editor
- Scrollable rendered `README.md` preview from the repo root
- Remote landing-page links for configured remotes
- Refresh scan
- Note editing

Keybindings:

- `q` and `Ctrl+C` quit the TUI
- `r` refreshes repo data and runs a scan
- `/` focuses search
- `e` enters notes edit mode
- `v` opens the selected repo in VS Code
- `o` opens the preferred remote landing page in your browser
- `w` shows or hides linked git worktrees (hidden by default)
- `Ctrl+S` saves notes
- `Esc` cancels note editing or leaves the focused input

- `Tab` / `Shift+Tab` cycle focus: repo list, README pane, search, technology filter, notes-only checkbox, worktrees checkbox
- Arrow keys, `PgUp`/`PgDn`, `Home` and `End` move through the repo list or scroll the README
  (whichever has focus)
- `Space` or `Enter` toggles the "Notes only" or "Worktrees" checkbox when it has focus

To scroll a long `README.md`, press `Tab` once to move focus into the README pane, then use
the arrow keys or `PgUp`/`PgDn`. Press `Esc` to return to the repo list.

### Mouse

The TUI enables terminal mouse reporting, so you can:

- click a repo row to select it, and click the search / technology fields, the "Notes only"
  and "Worktrees" checkboxes, or the README pane to focus them
- click the Notes box to start editing, then click inside it to place the cursor
- click the shortcut bar at the bottom (Refresh, Search, Edit, VS Code, Open Remote, Save,
  Cancel, Quit) instead of using the keys
- scroll the wheel over the repo list (moves the selection) or the README / notes

While mouse reporting is on, most terminals need **Shift** (Option on macOS Terminal/iTerm2)
held to select text with the mouse. Keyboard control is unchanged.

## VS Code Launcher

Gitlib defaults to launching VS Code with:

```toml
vscode_command = ["code", "--new-window"]
```

You can change that in `~/.git-library/config.toml` if you use another build, for example:

```toml
vscode_command = ["code-insiders", "--new-window"]
```

The default requires the `code` shell command to be installed and available on `PATH`.

### How to Configure

Your `~/.git-library/config.toml` needs:

```
roots = [
    "~/git",
]

vscode_command = [
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "--new-window",
]

ignore_dirs = [
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "venv",
    "env",
    "obj",
    "bin",
    "lib",
    "include",
    ".pytest_cache",
]
```