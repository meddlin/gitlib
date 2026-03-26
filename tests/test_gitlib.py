from __future__ import annotations

import io
import json
import os
from pathlib import Path
import sys
import tempfile
import textwrap
import unittest
from contextlib import redirect_stderr, redirect_stdout

from gitlib.app import build_nested_repo_map, create_application
from gitlib.cli import main
from gitlib.config import DEFAULT_IGNORE_DIRS
from gitlib.discovery import discover_repos
from gitlib.scanner import scan_repo
from gitlib.store import AmbiguousRepoSelectorError


class GitLibTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_path = Path(self.temp_dir.name)
        self.git_root = self.base_path / "git"
        self.git_root.mkdir()
        self.app_home = self.base_path / "gitlib-home"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_config(self, roots: list[Path] | None = None) -> None:
        roots = roots or [self.git_root]
        self.app_home.mkdir(parents=True, exist_ok=True)
        roots_block = "\n".join(f'  "{root}",' for root in roots)
        ignore_block = "\n".join(f'  "{item}",' for item in DEFAULT_IGNORE_DIRS)
        config = textwrap.dedent(
            f"""\
            roots = [
            {roots_block}
            ]

            ignore_dirs = [
            {ignore_block}
            ]
            """
        )
        (self.app_home / "config.toml").write_text(config, encoding="utf-8")

    def make_repo(self, relative_path: str, files: dict[str, str] | None = None) -> Path:
        repo_path = self.git_root / relative_path
        (repo_path / ".git").mkdir(parents=True, exist_ok=True)
        for file_path, contents in (files or {}).items():
            target = repo_path / file_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(contents, encoding="utf-8")
        return repo_path

    def make_dir(self, relative_path: str, files: dict[str, str] | None = None) -> Path:
        directory = self.git_root / relative_path
        directory.mkdir(parents=True, exist_ok=True)
        for file_path, contents in (files or {}).items():
            target = directory / file_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(contents, encoding="utf-8")
        return directory

    def env(self, **overrides: str) -> dict[str, str]:
        env = {"GITLIB_HOME": str(self.app_home)}
        env.update(overrides)
        return env

    def run_cli(self, args: list[str], **env_overrides: str) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(args, env=self.env(**env_overrides))
        return code, stdout.getvalue(), stderr.getvalue()

    def test_discovery_finds_nested_and_hidden_repos_and_ignores_noise(self) -> None:
        self.make_repo("top-level")
        self.make_repo("group/nested")
        self.make_repo(".hidden-repo")
        self.make_repo("node_modules/ignored")
        self.make_repo("include/ignored-too")

        discovered = discover_repos([self.git_root], set(DEFAULT_IGNORE_DIRS))
        relative_paths = [repo.relative_path for repo in discovered]

        self.assertEqual(relative_paths, [".hidden-repo", "group/nested", "top-level"])

    def test_scan_excludes_nested_git_repos_but_includes_non_git_subprojects(self) -> None:
        parent = self.make_repo(
            "workspace",
            {
                "web/package.json": json.dumps(
                    {
                        "dependencies": {
                            "next": "14.0.0",
                            "react": "18.0.0",
                        }
                    }
                )
            },
        )
        self.make_repo(
            "workspace/tools/child",
            {"package.json": json.dumps({"dependencies": {"express": "4.0.0"}})},
        )

        discovered = discover_repos([self.git_root], set(DEFAULT_IGNORE_DIRS))
        nested_map = build_nested_repo_map(discovered)
        parent_repo = next(repo for repo in discovered if repo.relative_path == "workspace")
        technologies = scan_repo(parent, set(DEFAULT_IGNORE_DIRS), nested_map[(parent_repo.root_path, parent_repo.relative_path)])

        self.assertEqual(technologies, ["Node.js", "Next.js", "React"])

    def test_selector_resolution_accepts_unique_name_and_rejects_ambiguous_name(self) -> None:
        self.write_config()
        self.make_repo("clients/app")
        self.make_repo("archive/app")
        self.make_repo("solo")

        app = create_application(self.env())
        app.refresh()

        self.assertEqual(app.show_repository("solo").relative_path, "solo")
        self.assertEqual(app.show_repository("clients/app").relative_path, "clients/app")

        with self.assertRaises(AmbiguousRepoSelectorError):
            app.show_repository("app")

    def test_notes_edit_round_trip(self) -> None:
        self.write_config()
        self.make_repo("notes-repo")

        editor_script = self.base_path / "write_notes.py"
        editor_script.write_text(
            textwrap.dedent(
                """\
                from pathlib import Path
                import sys

                Path(sys.argv[1]).write_text("First line\\nSecond line\\n", encoding="utf-8")
                """
            ),
            encoding="utf-8",
        )

        code, _, stderr = self.run_cli(
            ["notes", "edit", "notes-repo"],
            EDITOR=f"{sys.executable} {editor_script}",
        )
        self.assertEqual(code, 0, stderr)

        code, stdout, stderr = self.run_cli(["show", "notes-repo", "--json"])
        self.assertEqual(code, 0, stderr)
        payload = json.loads(stdout)
        self.assertEqual(payload["notes"], "First line\nSecond line")

    def test_tech_detection_covers_multiple_stacks(self) -> None:
        self.write_config()
        self.make_repo(
            "next-app",
            {
                "package.json": json.dumps(
                    {
                        "dependencies": {
                            "next": "14.0.0",
                            "react": "18.0.0",
                            "react-dom": "18.0.0",
                            "tailwindcss": "3.0.0",
                        },
                        "devDependencies": {"typescript": "5.0.0"},
                    }
                )
            },
        )
        self.make_repo(
            "python-cli",
            {
                "pyproject.toml": textwrap.dedent(
                    """\
                    [project]
                    dependencies = ["typer>=0.12.0", "click>=8.1.0"]
                    """
                )
            },
        )
        self.make_repo(
            "dotnet-app",
            {
                "Project.sln": "",
                "src/Project.csproj": "<Project />",
            },
        )
        self.make_repo("docker-only", {"Dockerfile": "FROM python:3.13"})
        self.make_repo("unknown")

        app = create_application(self.env())
        repositories = {repo.relative_path: repo for repo in app.refresh()}

        self.assertEqual(
            repositories["next-app"].technologies,
            ["Node.js", "Next.js", "React", "TypeScript", "Tailwind"],
        )
        self.assertEqual(repositories["python-cli"].technologies, ["Python", "Typer", "Click"])
        self.assertEqual(repositories["dotnet-app"].technologies, [".NET", "C#"])
        self.assertEqual(repositories["docker-only"].technologies, ["Docker"])
        self.assertEqual(repositories["unknown"].technologies, [])

    def test_list_and_show_json_have_stable_shapes(self) -> None:
        self.write_config()
        self.make_repo(
            "json-repo",
            {"package.json": json.dumps({"dependencies": {"react": "18.0.0"}})},
        )

        app = create_application(self.env())
        repo = app.show_repository("json-repo")
        app.store.update_notes(repo.id, "tracked note")

        code, stdout, stderr = self.run_cli(["list", "--json"])
        self.assertEqual(code, 0, stderr)
        payload = json.loads(stdout)
        self.assertEqual(len(payload), 1)
        self.assertEqual(
            set(payload[0]),
            {
                "name",
                "relative_path",
                "absolute_path",
                "technologies",
                "has_notes",
                "last_scanned_at",
                "notes",
            },
        )

        code, stdout, stderr = self.run_cli(["show", "json-repo", "--json"])
        self.assertEqual(code, 0, stderr)
        detail = json.loads(stdout)
        self.assertEqual(set(detail), set(payload[0]))
        self.assertEqual(detail["notes"], "tracked note")


if __name__ == "__main__":
    unittest.main()
