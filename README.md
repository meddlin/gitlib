# Gitlib

## Overview

Gitlib is a local-first tool for managing Git repositories stored under `~/git`.
It scans your local repos, tracks detected technologies, and lets you store notes
for each project without depending on GitHub.

On first run, Gitlib bootstraps its local app data in `~/.git-library/`.

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

- First run creates `~/.git-library/` for config and SQLite data (override with `GITLIB_HOME`).
- The default scan root is `~/git`.
- The SQLite schema is unchanged from the original Python version, so an existing
  `~/.git-library/gitlib.db` keeps working.

## Web App

`apps/web/` is a [TanStack Start](https://tanstack.com/start) app that reads the same
`~/.git-library` data as the CLI (via `@gitlib/core`, on the server only):

```bash
npm run web          # dev server at http://localhost:3000
npm run build -w @gitlib/web && npm run preview -w @gitlib/web   # production build
```

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

The web app ships with a `Dockerfile` and `docker-compose.yml`, so you can host it on a VM
(for example on a Proxmox server). The container runs the production build of `apps/web`
with a small Node server (`apps/web/server.mjs`) on port 3000.

### 1. Prepare the VM

Any Linux VM with Docker Engine and the Compose plugin works (e.g. Debian/Ubuntu on Proxmox):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out and back in afterwards
```

### 2. Get the code and your repositories onto the VM

```bash
git clone <this-repo-url> gitlib && cd gitlib
```

Gitlib only discovers repositories it can see on disk, so put the repos you want to browse in a
single directory on the VM (clone them, `rsync` them from your workstation, or mount an NFS/SMB
share from your NAS). Their remotes and detected technologies are read from the checkouts.

### 3. Start it

```bash
GITLIB_REPOS=/srv/git docker compose up -d --build
```

Open `http://<vm-ip>:3000`. Instead of passing variables inline you can put them in a `.env`
file next to `docker-compose.yml`:

| Variable        | Default   | Meaning                                                    |
| --------------- | --------- | ---------------------------------------------------------- |
| `GITLIB_REPOS`  | `./repos` | Host directory with your git repos (mounted read-only)     |
| `GITLIB_PORT`   | `3000`    | Host port the web app is published on                      |
| `TZ`            | `UTC`     | Container time zone                                        |

How it is wired up:

- Your repos are mounted read-only at `/home/node/git` inside the container, which is the
  default scan root (`~/git`) for the container user, so no config changes are needed. Use
  **Rescan** in the UI after adding repos.
- Config (`config.toml`) and the SQLite database (repo descriptions) live in the named volume
  `gitlib-data`, mounted at `/data` (`GITLIB_HOME`). They survive restarts and rebuilds.
  `docker compose down` keeps the volume; `docker compose down -v` deletes it.

### Day-to-day

```bash
docker compose logs -f web          # follow logs
docker compose ps                   # status (includes a health check)
docker compose restart web
git pull && docker compose up -d --build   # update to the latest version
```

Back up the data volume with:

```bash
docker run --rm -v gitlib_gitlib-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/gitlib-data.tgz -C /data .
```

(The volume is prefixed with the Compose project name, which defaults to the directory name;
check `docker volume ls` if yours differs.)

### Security note

The web app has **no authentication**. Do not expose port 3000 to the internet. Keep it on your
LAN/VPN, or put a reverse proxy with authentication in front of it (Caddy, Nginx Proxy Manager,
Traefik, Authelia, …) and bind the port to localhost by changing the `ports` entry in
`docker-compose.yml` to `"127.0.0.1:3000:3000"`.

The CLI, TUI and VS Code / browser launchers are desktop features and are not part of the
container.

## Current CLI Commands

These commands are implemented today:

```bash
gitlib list [--tech TAG] [--notes-only] [--json]
gitlib show <repo> [--json]
gitlib scan
gitlib open code <repo>
gitlib open remote <repo>
gitlib tui
gitlib notes edit <repo>
```

Command summary:

- `gitlib list` lists all discovered repos.
- `gitlib list --tech TAG` filters repos by a detected technology tag.
- `gitlib list --notes-only` shows only repos with notes.
- `gitlib list --json` returns machine-readable output.
- `gitlib show <repo>` shows details for one repo.
- `gitlib scan` refreshes repo discovery and technology metadata.
- `gitlib open code <repo>` opens the repo root in a new VS Code window.
- `gitlib open remote <repo>` opens the preferred configured remote in your browser.
- `gitlib tui` launches the interactive terminal UI.
- `gitlib notes edit <repo>` opens your configured editor to update repo notes.

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
- `Ctrl+S` saves notes
- `Esc` cancels note editing or leaves the focused input

- `Tab` / `Shift+Tab` cycle focus: repo list, README pane, search, technology filter, notes-only checkbox
- Arrow keys, `PgUp`/`PgDn`, `Home` and `End` move through the repo list or scroll the README
  (whichever has focus)
- `Space` or `Enter` toggles the "Notes only" checkbox when it has focus

To scroll a long `README.md`, press `Tab` once to move focus into the README pane, then use
the arrow keys or `PgUp`/`PgDn`. Press `Esc` to return to the repo list.

### Mouse

The TUI enables terminal mouse reporting, so you can:

- click a repo row to select it, and click the search / technology fields, the "Notes only"
  checkbox, or the README pane to focus them
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