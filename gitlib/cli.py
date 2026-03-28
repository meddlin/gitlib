from __future__ import annotations

import argparse
import os
import sys
from typing import Mapping, Sequence

from gitlib.app import create_application
from gitlib.notes import NotesError, edit_notes
from gitlib.render import render_detail, render_json, render_table, repo_to_dict
from gitlib.store import AmbiguousRepoSelectorError, RepoNotFoundError, RepoSelectorError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gitlib")
    subparsers = parser.add_subparsers(dest="command")

    list_parser = subparsers.add_parser("list", help="List repositories")
    list_parser.add_argument("--tech", dest="technology")
    list_parser.add_argument("--notes-only", action="store_true")
    list_parser.add_argument("--json", action="store_true", dest="json_output")

    show_parser = subparsers.add_parser("show", help="Show repository details")
    show_parser.add_argument("repo")
    show_parser.add_argument("--json", action="store_true", dest="json_output")

    subparsers.add_parser("scan", help="Refresh repository metadata")
    subparsers.add_parser("tui", help="Launch the interactive terminal UI")

    notes_parser = subparsers.add_parser("notes", help="Manage notes")
    notes_subparsers = notes_parser.add_subparsers(dest="notes_command", required=True)
    notes_edit_parser = notes_subparsers.add_parser("edit", help="Edit repository notes")
    notes_edit_parser.add_argument("repo")

    return parser


def _resolve_env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    if env is None:
        return os.environ
    merged = dict(os.environ)
    merged.update(env)
    return merged


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    merged_env = _resolve_env(env)

    command = args.command or "list"

    try:
        app = create_application(merged_env)

        if command == "list":
            repositories = app.list_repositories(
                technology=getattr(args, "technology", None),
                notes_only=getattr(args, "notes_only", False),
            )
            if getattr(args, "json_output", False):
                print(render_json([repo_to_dict(repo) for repo in repositories]))
            else:
                print(render_table(repositories))
            return 0

        if command == "show":
            repository = app.show_repository(args.repo)
            if args.json_output:
                print(render_json(repo_to_dict(repository)))
            else:
                print(render_detail(repository))
            return 0

        if command == "scan":
            repositories = app.refresh()
            print(f"Scanned {len(repositories)} repositories.")
            return 0

        if command == "tui":
            try:
                from gitlib.tui import run_tui
            except ImportError as exc:
                print(f"Unable to start TUI: {exc}", file=sys.stderr)
                return 1
            run_tui(app)
            return 0

        if command == "notes" and args.notes_command == "edit":
            repository = app.show_repository(args.repo)
            updated_notes = edit_notes(repository.notes, merged_env)
            repository = app.edit_repository_notes(args.repo, updated_notes)
            print(f"Updated notes for {repository.relative_path}.")
            return 0

    except (NotesError, RepoSelectorError, RuntimeError) as exc:
        if isinstance(exc, AmbiguousRepoSelectorError):
            print(str(exc), file=sys.stderr)
        elif isinstance(exc, RepoNotFoundError):
            print(str(exc), file=sys.stderr)
        else:
            print(str(exc), file=sys.stderr)
        return 1

    parser.print_help(sys.stderr)
    return 1
