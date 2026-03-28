# Gitlib

## Overview

Gitlib is a local-first tool for managing Git repositories stored under `~/git`.
It scans your local repos, tracks detected technologies, and lets you store notes
for each project without depending on GitHub.

On first run, Gitlib bootstraps its local app data in `~/.git-library/`.

## Run the App

Run it directly from the repository:

```bash
python3 -m gitlib list
python3 -m gitlib tui
```

Or install it in editable mode and use the `gitlib` command:

```bash
pip install -e .
gitlib list
gitlib tui
```

Operational notes:

- First run creates `~/.git-library/` for config and SQLite data.
- The default scan root is `~/git`.

## Current CLI Commands

These commands are implemented today:

```bash
gitlib list [--tech TAG] [--notes-only] [--json]
gitlib show <repo> [--json]
gitlib scan
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
- `o` opens the preferred remote landing page in your browser
- `Ctrl+S` saves notes
- `Esc` cancels note editing or leaves the focused input

To scroll a long `README.md`, move focus into the README pane with `Tab` or click it with
the mouse, then use the arrow keys or normal terminal scrolling keys.
