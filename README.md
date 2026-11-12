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

## Chat

The **Ask** button in the web app's top bar slides out a chat panel on the right. It answers questions about your
repositories with a model on an [Ollama](https://ollama.com/) server, which can be another machine on your network;
nothing is sent anywhere else. Ollama is optional: without it the panel says it cannot reach the server and nothing
else changes. How the options were weighed is in [`docs/ollama-integration.md`](docs/ollama-integration.md).

- The model sees a capped list of every repository (name, path, technologies, description, favorites) and, on a
  repository's page, that repository's notes and the start of its README. It cannot browse files, run commands or
  search, so it answers only from what gitlib knows and says so when it does not know.
- Replies stream in as they are written. **Stop** cancels the request on the Ollama server too.
- The conversation lives in the browser tab and survives moving between pages, not a reload. The model is picked from
  the panel's list of what the server has installed, and the choice is remembered in that browser.
- Replies are shown as Markdown without images: text a model writes can be shaped by a hostile README, and an image
  address can carry data out.
- Long conversations are cut to fit the context window (oldest turns first) before they are sent, because Ollama
  would otherwise drop text without saying so.

Set it in `~/.git-library/config.toml` (all keys optional):

```toml
[ollama]
enabled = true                        # false = never contact Ollama
host = "http://127.0.0.1:11434"
model = ""                            # blank = the first installed model
num_ctx = 8192                        # context window, in tokens, sent with every request
```

`GITLIB_OLLAMA_HOST`, `GITLIB_OLLAMA_MODEL` and `GITLIB_OLLAMA_NUM_CTX` override them. In Docker, `localhost` is the
container itself, so set `GITLIB_OLLAMA_HOST` in `.env` to the Ollama machine's address, and on that machine start
Ollama with `OLLAMA_HOST=0.0.0.0:11434` so it listens beyond loopback. Ollama has no login of its own and the web app
has none either, so keep both off the internet. On a 12 GB graphics card an 8B-class model with `num_ctx = 8192` is a
reasonable start; check with `ollama ps` on that machine that the model is fully on the GPU.

## Dependabot watch

`gitlib dependabot check` reports which open [Dependabot](https://docs.github.com/code-security/dependabot) pull
requests on your **starred** repositories can be merged and which need work. "Starred" is the Star toggle in gitlib
(`repo_favorites`), not GitHub stars, and only favorites with a github.com remote can be watched; the report says
how many were skipped and why. Nothing is ever written to GitHub, and the verdict comes only from fields GitHub
returns (never from the PR text, which quotes third-party release notes). The research and the reasoning behind it
are in [`docs/dependabot-watch.md`](docs/dependabot-watch.md).

```bash
export GITLIB_GITHUB_TOKEN=...      # or GITHUB_TOKEN; GitHub's GraphQL API does not answer without one
gitlib dependabot check             # asks GitHub, saves the result, prints it grouped by bucket
gitlib dependabot check --json      # the same, machine-readable
gitlib dependabot check --no-save   # print only; nothing is stored and no lock is taken
gitlib dependabot show [--json]     # the newest saved check, without contacting GitHub
gitlib dependabot dismiss meddlin/gitlib#41 [--until 2026-12-01]   # put a PR aside
gitlib dependabot restore meddlin/gitlib#41
```

| Bucket | Meaning |
| --- | --- |
| **Ready** | Not a draft, mergeable, up to date, checks passing, no review blocking it, a patch or minor update. Merge it from its page. |
| **Review first** | Nothing is broken, but look first: a major bump, an update type the commit message does not state, a `security` label, a review that is required, extra commits on the branch, or **CI unknown** (below). |
| **Needs work** | Merge conflicts, behind the base branch, changes requested, or failing checks. Suggests `@dependabot rebase` or `@dependabot recreate` where they apply. |
| **Waiting** | Checks still running, a draft, or GitHub still calculating mergeability (`UNKNOWN`, which is transient; run the check again). |

The report only ever *suggests* comments for you to post; `@dependabot merge` and its siblings stopped working on
2026-01-27 and are never suggested. It asks GitHub once per owner (one GraphQL search for the owner's open Dependabot
PRs, plus one small lookup that tells which watched repositories your token cannot see at all), so a check costs a
few points of the 5,000 an hour; the report prints the actual cost. Anything it could not check is listed under
`NOT CHECKED` or `INCOMPLETE` rather than left out, and the command exits with status 1 if a whole owner failed.

**In the web app.** The **Dependabot** page (`/dependabot`) lists the newest saved check by bucket with each PR's
reasons and suggested comments, **Snooze** (a week) and **Dismiss** (until it closes) buttons, a **Put aside** list
with **Restore**, and a **Check now** button that takes the same lock as the CLI. It reads the database, never GitHub,
until you press the button; if another check is running (the CLI) it says so and picks up the result. Without a token
the page still shows the last saved check and explains what to set. The badge on the **Dependabot** link counts the
PRs that need a person (ready, review first, needs work; not those waiting on checks) and refreshes every minute.

**Schedule.** The **Schedule** panel on the Dependabot page turns on automatic checks on the days and at the time
you choose (server time; the page shows the zone, and in Docker it is UTC unless you set `TZ` in `.env`). The schedule is stored in `planning.db` because it is your choice,
not derived data. It runs inside the web server, which starts it at boot (the production server calls
`POST /api/dependabot/start` once it is listening; the dev server starts it with the first page), looks at the clock
every minute and starts a check when the latest slot is newer than the last saved check. That is also the catch-up:
a restart after a missed slot runs it at once, but turning the schedule on at 14:00 does not owe you 08:00. A check
that could not ask some owner is retried every 30 minutes for six hours; one that threw (a rejected token, GitHub
down) waits 30 minutes and shows its error under the panel. A check started any other way (the button, the CLI)
counts for the slot, and they all share the lock, so a host cron job running `gitlib dependabot check` and the
schedule can coexist. The schedule only runs while the server is up, so on a laptop that sleeps use a host scheduler
instead (see the research note's scheduling table) and leave this off.

**Notes from the local model.** If Ollama is configured (see [Chat](#chat)), the web server also writes a short
plain-language note under each PR that needs a person (*needs work* and *review first*; not *ready* or *waiting*):
what the update is, what its release notes say about breaking changes, what to look at first. The model is shown the
verdict's facts, the title, the failed check names and a markup-stripped, 4,000-character slice of the PR description
(fetched when needed and never stored), with the rules fixed in code and the description marked as untrusted data;
the reply is capped at 220 tokens. **The verdict never reads the note**, which is stored separately with the model's
name and shown under a label saying so, through the same image-free renderer as chat. Notes are written one PR at a
time on a single shared model lane, **behind chat**: sending a chat message stops the note being written, which is
simply written again afterwards. A note is rewritten only when the facts it came from change, and deleted when its PR
leaves the list. With Ollama off or unreachable nothing else changes; the page says why notes are paused.

**Saved runs.** Each check is stored in `gitlib.db` (`dependabot_runs`, `dependabot_findings`; the newest 60 runs
are kept) so the findings can be read offline and compared over time; they are derived from GitHub and can be fetched
again. If one owner cannot be asked (network, rate limit), the last findings for its repositories are kept, marked
`last seen <time>`, and the run is flagged `NOT CHECKED`, so a blip does not empty the list. A lock row in the same
database stops two checks (this command, the web page, a schedule) from running at once; it lapses after 15 minutes
if the holder crashed. **Putting a PR aside** is your decision, not derived data, so it is stored in `planning.db`
(and covered by `gitlib backup`): `dismiss` hides it until it closes or until the date you give, and reports leave it
out while counting it under `Put aside`.

**CI unknown.** A PR whose check results GitHub did not return is shown as `CI unknown` with the reason, filed under
*Review first*, and never as ready. GitHub's token guide lists the Checks API among the things fine-grained tokens
cannot do, and whether GraphQL `statusCheckRollup` works with one is undocumented, so with a fine-grained token you
may see `CI unknown` on every PR. [`docs/dependabot-watch.md`](docs/dependabot-watch.md#verify-with-your-own-token)
has the commands that settle it.

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

### Projects

The **Projects** page (`/projects`) groups repositories and gitlib issues under a name, so one project can span
several repos. A project page has two parts that are kept apart on purpose:

- **Repositories** and **Gitlib issues** are gitlib's own data, stored in `planning.db`. You can add, remove and
  edit them, and nothing in them is ever sent to GitHub.
- **Milestones** are goals within a project, each with a title, an optional due date and an optional Markdown
  description. They show as cards at the top of the project page, each with its due date and how many of its
  issues are closed. Pick an issue's milestone from its row on the project page or from the issue's own page; the
  project page groups its issues by milestone and shows how many of each are closed. An issue can only be in a
  milestone of its own project, so moving it to another project (or out of its project) takes it out of its
  milestone, and deleting a milestone leaves its issues in the project. A due date is a calendar day with no time
  zone, and a milestone is flagged overdue only while it still has open (or no) issues after that day. Deleting a
  project deletes its milestones.
- **On GitHub** is a read-only preview: for each repo in the project that has a GitHub remote it shows the open
  pull requests, open issues and the latest commits on the default branch. Every row links out to GitHub and is
  named `owner/repo#12`, so it cannot be mistaken for a gitlib issue (`repo#3`). Gitlib never writes to GitHub
  here, never saves what it reads, and never reads it back into planning: the only copy is an in-memory cache that
  lasts about five minutes (the **Refresh** button skips it) and is gone when the server restarts. A repo with no
  GitHub remote, or one GitHub cannot show (not found, rate limited), is reported on its own line. Set
  `GITHUB_TOKEN` to read private repos and avoid the 60-requests-an-hour limit for anonymous use.

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

- The **Repositories** page has four tabs over one list: **Combined** (the default), **Local**, **GitHub**
  and **GitLab**. Combined joins each local clone with the GitHub and GitLab repos its remotes point at, so
  one row shows where a project lives (clone, GitHub, GitLab) and which of those it is missing; clones of the
  same remote collapse into one row. GitHub lists every repo the token's user owns, collaborates on or reaches
  through an organization (`GITLIB_GITHUB_TOKEN`; the token needs read access to repositories). GitLab lists
  the projects the user is a member of with `GITLIB_GITLAB_TOKEN` (a personal access token with `read_api`),
  or only a user's public projects with just `GITLIB_GITLAB_USERNAME`; set `GITLIB_GITLAB_URL` for a
  self-hosted instance. Each host's list is stored in the local database (`remote_repo_listings` table), so
  the page reads it at once, survives restarts, and never calls GitHub or GitLab per view. The server checks
  it in the background when it is missing or older than `GITLIB_REPO_REFRESH_HOURS` (default 6, `0` = only
  on the button); a check sends each page's ETag, and a host that answers *Not Modified* costs no GitHub
  quota and downloads nothing. **Refresh** fetches both complete lists now. If a check fails (a revoked
  token, a rate limit) the stored list stays on screen with the error noted, and automatic retries pause for
  half an hour. A host that isn't configured is noted on the page and the rest still works, and clones link
  to GitHub or GitLab from their remotes either way. The **Local** tab is the full table (favorites, descriptions, issue
  counts, community scores, preview pane); the other tabs list repos with links out, and clones open their
  detail page. The tab is kept in the URL (`?source=`).
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
- A **blue dot** beside a repo's name means the branch it has checked out is behind the remote branch it
  tracks (`origin/main` and so on): the remote has commits the clone lacks, so it needs a `git pull`. Hover
  for the branch. Gitlib asks each remote with `git ls-remote`, which only reads, so it works on the
  read-only Docker mount, and it never fetches or pulls for you. A clone that has diverged counts as behind
  (a pull still has something to bring in); one that is only ahead, up to date, on a detached HEAD, on a
  branch with no upstream, or a linked worktree shows no dot. Answers are cached for five minutes;
  **Rescan** asks again at once, so run it after pulling. The server needs its own access to each remote
  (see Troubleshooting in [the runbook](docs/runbook.md)); repos it could not reach are counted in a note
  above the table.
- The **Planning** page (`/planning`) holds gitlib's own issues; see [Planning](#planning).
- The **Dependabot** page (`/dependabot`) shows the newest saved check of your starred repositories' Dependabot PRs,
  with a **Check now** button and a count badge in the top bar; see [Dependabot watch](#dependabot-watch).
- The **Ask** button opens a chat panel for questions about your repositories; see [Chat](#chat).
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
gitlib dependabot check [--json] [--no-save]
gitlib dependabot show [--json]
gitlib dependabot dismiss <owner/repo#number> [--until DATE]
gitlib dependabot restore <owner/repo#number>
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
- `gitlib dependabot check|show|dismiss|restore` reports which Dependabot PRs on starred repositories can be merged,
  shows the last saved report, and puts PRs aside (see [Dependabot watch](#dependabot-watch)).
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