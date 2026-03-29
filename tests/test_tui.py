from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from gitlib.app import create_application
from gitlib.cli import main
from gitlib.config import DEFAULT_IGNORE_DIRS


TEXTUAL_AVAILABLE = importlib.util.find_spec("textual") is not None

if TEXTUAL_AVAILABLE:
    from textual.widgets import DataTable, Markdown

    from gitlib.tui.app import GitLibTuiApp


@unittest.skipUnless(TEXTUAL_AVAILABLE, "textual is not installed")
class GitLibTuiTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_path = Path(self.temp_dir.name)
        self.git_root = self.base_path / "git"
        self.git_root.mkdir()
        self.app_home = self.base_path / "gitlib-home"
        self.write_config()

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

    def init_real_git_repo(self, relative_path: str) -> Path:
        repo_path = self.git_root / relative_path
        repo_path.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", str(repo_path)], check=True, capture_output=True, text=True)
        return repo_path

    def env(self, **overrides: str) -> dict[str, str]:
        env = {"GITLIB_HOME": str(self.app_home)}
        env.update(overrides)
        return env

    def run_cli(self, args: list[str]) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(args, env=self.env())
        return code, stdout.getvalue(), stderr.getvalue()

    def create_tui(self) -> GitLibTuiApp:
        app = create_application(self.env())
        return GitLibTuiApp(app)

    async def test_tui_launches_and_selection_updates_detail(self) -> None:
        alpha = self.init_real_git_repo("alpha")
        (alpha / "package.json").write_text(
            json.dumps({"dependencies": {"react": "18.0.0"}}),
            encoding="utf-8",
        )
        (alpha / "README.md").write_text("# Alpha\n\nAlpha docs.\n", encoding="utf-8")
        self.init_real_git_repo("beta")

        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            table = app.query_one("#repo-table", DataTable)
            self.assertEqual(table.row_count, 2)
            self.assertEqual(app.selected_relative_path, "alpha")
            readme_view = app.detail_pane.readme_view
            self.assertIn("# Alpha", readme_view.source)

            await pilot.press("down")
            await pilot.pause()

            self.assertEqual(app.selected_relative_path, "beta")
            self.assertEqual(app.detail_pane.notes_editor.text, "")
            summary = app.query_one("#repo-summary").renderable
            self.assertIn("remotes: none", str(summary))
            self.assertEqual(app.detail_pane.readme_view.source, "README.md not found.")

    async def test_filters_update_visible_repositories(self) -> None:
        self.make_repo(
            "next-app",
            {"package.json": json.dumps({"dependencies": {"next": "14.0.0", "react": "18.0.0"}})},
        )
        self.make_repo(
            "python-cli",
            {"pyproject.toml": "[project]\ndependencies = ['typer>=0.12.0']\n"},
        )
        self.make_repo("notes-only")

        service = create_application(self.env())
        service.refresh()
        service.save_repository_notes("notes-only", "tracked", refresh=False)

        app = GitLibTuiApp(service)

        async with app.run_test() as pilot:
            await pilot.pause()
            app.search_input.value = "python"
            await pilot.pause()
            self.assertEqual([repo.relative_path for repo in app.filtered_repositories], ["python-cli"])

            app.search_input.value = ""
            app.technology_input.value = "Node.js"
            await pilot.pause()
            self.assertEqual([repo.relative_path for repo in app.filtered_repositories], ["next-app"])

            app.technology_input.value = ""
            app.notes_only_checkbox.value = True
            await pilot.pause()
            self.assertEqual([repo.relative_path for repo in app.filtered_repositories], ["notes-only"])

    async def test_refresh_preserves_selection_when_repo_still_exists(self) -> None:
        self.make_repo("alpha")
        self.make_repo("beta")

        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press("down")
            await pilot.pause()
            self.assertEqual(app.selected_relative_path, "beta")

            self.make_repo("gamma")
            await pilot.press("r")
            await pilot.pause()

            self.assertEqual(app.selected_relative_path, "beta")
            self.assertIn("gamma", [repo.relative_path for repo in app.repositories])

    async def test_inline_notes_save_is_visible_in_cli_output(self) -> None:
        self.make_repo("alpha")
        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press("e")
            await pilot.pause()
            app.detail_pane.notes_editor.load_text("saved from tui")
            await pilot.pause()
            await pilot.press("ctrl+s")
            await pilot.pause()

            self.assertFalse(app.edit_mode)
            self.assertEqual(app.selected_relative_path, "alpha")

        code, stdout, stderr = self.run_cli(["show", "alpha", "--json"])
        self.assertEqual(code, 0, stderr)
        payload = json.loads(stdout)
        self.assertEqual(payload["notes"], "saved from tui")

    async def test_readme_preview_updates_with_selection_and_refresh(self) -> None:
        alpha = self.init_real_git_repo("alpha")
        (alpha / "README.md").write_text("# Alpha\n\nFirst version.\n", encoding="utf-8")
        beta = self.init_real_git_repo("beta")
        (beta / "README.md").write_text("# Beta\n\nSecond repo.\n", encoding="utf-8")

        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            self.assertIn("First version.", app.detail_pane.readme_view.source)

            await pilot.press("down")
            await pilot.pause()
            self.assertIn("# Beta", app.detail_pane.readme_view.source)

            (alpha / "README.md").write_text("# Alpha\n\nUpdated after refresh.\n", encoding="utf-8")
            await pilot.press("up")
            await pilot.pause()
            await pilot.press("r")
            await pilot.pause()

            self.assertEqual(app.selected_relative_path, "alpha")
            self.assertIn("Updated after refresh.", app.detail_pane.readme_view.source)

    async def test_readme_preview_handles_missing_and_broken_readme(self) -> None:
        self.init_real_git_repo("alpha")
        broken_repo = self.init_real_git_repo("beta")
        (broken_repo / "README.md").mkdir()

        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            self.assertEqual(app.detail_pane.readme_view.source, "README.md not found.")

            await pilot.press("down")
            await pilot.pause()
            self.assertIn("Unable to load README.md:", app.detail_pane.readme_view.source)

    async def test_readme_preview_can_focus_scroll_and_escape(self) -> None:
        lines = "\n".join(f"Paragraph {index}" for index in range(40))
        alpha = self.init_real_git_repo("alpha")
        (alpha / "README.md").write_text(f"# Alpha\n\n{lines}\n", encoding="utf-8")

        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            readme_view = app.detail_pane.readme_view

            for _ in range(4):
                if app.focused is readme_view:
                    break
                await pilot.press("tab")
                await pilot.pause()

            self.assertIs(app.focused, readme_view)
            initial_scroll = readme_view.scroll_y

            for _ in range(8):
                await pilot.press("down")
            await pilot.pause()

            self.assertGreater(readme_view.scroll_y, initial_scroll)

            await pilot.press("escape")
            await pilot.pause()
            self.assertIs(app.focused, app.repo_table)

    async def test_quit_binding_exits_cleanly(self) -> None:
        self.make_repo("alpha")
        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press("q")
            await pilot.pause()
            self.assertTrue(app.did_request_exit)

    async def test_remote_status_displays_remote_targets(self) -> None:
        local_only = self.init_real_git_repo("local-only")
        with_remote = self.init_real_git_repo("with-remote")
        (with_remote / "README.md").write_text("# With Remote\n\nRemote docs.\n", encoding="utf-8")
        subprocess.run(
            ["git", "-C", str(with_remote), "remote", "add", "origin", "https://github.com/example/origin.git"],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            ["git", "-C", str(with_remote), "remote", "add", "gitlab", "https://gitlab.com/example/project.git"],
            check=True,
            capture_output=True,
            text=True,
        )

        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            summary = app.query_one("#repo-summary").renderable
            remote_targets = app.query_one("#remote-targets").renderable
            self.assertIn("remotes: none", str(summary))
            self.assertEqual(str(remote_targets), "-")

            await pilot.press("down")
            await pilot.pause()

            summary = app.query_one("#repo-summary").renderable
            remote_targets = app.query_one("#remote-targets").renderable
            self.assertIn("remotes: 2 configured", str(summary))
            self.assertIn("origin -> GitHub (github.com)", str(remote_targets))
            self.assertIn("landing page: https://github.com/example/origin", str(remote_targets))
            self.assertIn("gitlab -> GitLab (gitlab.com)", str(remote_targets))
            self.assertIn("landing page: https://gitlab.com/example/project", str(remote_targets))
            self.assertIn("# With Remote", app.detail_pane.readme_view.source)
            self.assertEqual(local_only.name, "local-only")

    async def test_open_vscode_launches_selected_repo(self) -> None:
        self.make_repo("alpha")
        app = self.create_tui()

        with patch("gitlib.app.subprocess.run") as run_mock:
            run_mock.return_value = subprocess.CompletedProcess(
                args=["code", "--new-window"],
                returncode=0,
                stdout="",
                stderr="",
            )
            async with app.run_test() as pilot:
                await pilot.pause()
                await pilot.press("v")
                await pilot.pause()

                run_mock.assert_called_once_with(
                    ["code", "--new-window", str(self.git_root / "alpha")],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                status = app.query_one("#status").renderable
                self.assertIn("Opened alpha in VS Code.", str(status))

    async def test_open_vscode_failure_does_not_crash_tui(self) -> None:
        self.make_repo("alpha")
        app = self.create_tui()

        with patch("gitlib.app.subprocess.run") as run_mock:
            run_mock.return_value = subprocess.CompletedProcess(
                args=["code", "--new-window"],
                returncode=1,
                stdout="",
                stderr="code command not found",
            )
            async with app.run_test() as pilot:
                await pilot.pause()
                await pilot.press("v")
                await pilot.pause()

                status = app.query_one("#status").renderable
                self.assertIn("Unable to launch VS Code: code command not found", str(status))

    async def test_open_vscode_with_no_selected_repo_shows_status(self) -> None:
        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press("v")
            await pilot.pause()

            status = app.query_one("#status").renderable
            self.assertIn("No repository selected.", str(status))

    async def test_refresh_preserves_selection_and_remote_details(self) -> None:
        self.init_real_git_repo("alpha")
        beta = self.init_real_git_repo("beta")
        subprocess.run(
            ["git", "-C", str(beta), "remote", "add", "origin", "https://github.com/example/origin.git"],
            check=True,
            capture_output=True,
            text=True,
        )

        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press("down")
            await pilot.pause()
            self.assertEqual(app.selected_relative_path, "beta")

            self.init_real_git_repo("gamma")
            await pilot.press("r")
            await pilot.pause()

            self.assertEqual(app.selected_relative_path, "beta")
            summary = app.query_one("#repo-summary").renderable
            remote_targets = app.query_one("#remote-targets").renderable
            self.assertIn("remotes: 1 configured", str(summary))
            self.assertIn("origin -> GitHub (github.com)", str(remote_targets))
            self.assertIn("landing page: https://github.com/example/origin", str(remote_targets))

    async def test_remote_lookup_failure_shows_in_app_error(self) -> None:
        self.make_repo("broken")
        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            summary = app.query_one("#repo-summary").renderable
            status = app.query_one("#status").renderable
            self.assertIn("remotes: unavailable", str(summary))
            self.assertIn("Remotes unavailable", str(status))

    async def test_remote_targets_show_push_difference(self) -> None:
        self.init_real_git_repo("alpha")
        beta = self.init_real_git_repo("beta")
        subprocess.run(
            ["git", "-C", str(beta), "remote", "add", "origin", "https://github.com/example/project.git"],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [
                "git",
                "-C",
                str(beta),
                "remote",
                "set-url",
                "--push",
                "origin",
                "https://gitlab.com/example/project.git",
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press("down")
            await pilot.pause()

            remote_targets = app.query_one("#remote-targets").renderable
            self.assertIn("origin -> GitHub (github.com)", str(remote_targets))
            self.assertIn("landing page: https://github.com/example/project", str(remote_targets))
            self.assertIn("push differs: GitLab (gitlab.com)", str(remote_targets))

    async def test_remote_targets_show_unavailable_landing_page(self) -> None:
        alpha = self.init_real_git_repo("alpha")
        beta = self.init_real_git_repo("beta")
        subprocess.run(
            [
                "git",
                "-C",
                str(beta),
                "remote",
                "add",
                "origin",
                str(self.base_path / "mirrors" / "beta.git"),
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press("down")
            await pilot.pause()

            self.assertEqual(app.selected_relative_path, "beta")
            remote_targets = app.query_one("#remote-targets").renderable
            self.assertIn("origin ->", str(remote_targets))
            self.assertIn("landing page: unavailable", str(remote_targets))
            self.assertEqual(alpha.name, "alpha")

    async def test_open_remote_prefers_origin_when_available(self) -> None:
        alpha = self.init_real_git_repo("alpha")
        beta = self.init_real_git_repo("beta")
        subprocess.run(
            ["git", "-C", str(beta), "remote", "add", "gitlab", "https://gitlab.com/example/project.git"],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            ["git", "-C", str(beta), "remote", "add", "origin", "https://github.com/example/project.git"],
            check=True,
            capture_output=True,
            text=True,
        )

        app = self.create_tui()

        with patch("gitlib.app.webbrowser.open", return_value=True) as open_mock:
            async with app.run_test() as pilot:
                await pilot.pause()
                await pilot.press("down")
                await pilot.pause()
                await pilot.press("o")
                await pilot.pause()

                open_mock.assert_called_once_with("https://github.com/example/project")
                status = app.query_one("#status").renderable
                self.assertIn("Opened origin for beta.", str(status))
                self.assertEqual(alpha.name, "alpha")

    async def test_open_remote_falls_back_to_first_parseable_remote(self) -> None:
        self.init_real_git_repo("alpha")
        beta = self.init_real_git_repo("beta")
        subprocess.run(
            ["git", "-C", str(beta), "remote", "add", "gitlab", "https://gitlab.com/example/project.git"],
            check=True,
            capture_output=True,
            text=True,
        )

        app = self.create_tui()

        with patch("gitlib.app.webbrowser.open", return_value=True) as open_mock:
            async with app.run_test() as pilot:
                await pilot.pause()
                await pilot.press("down")
                await pilot.pause()
                await pilot.press("o")
                await pilot.pause()

                open_mock.assert_called_once_with("https://gitlab.com/example/project")
                status = app.query_one("#status").renderable
                self.assertIn("Opened gitlab for beta.", str(status))

    async def test_open_remote_handles_missing_link_and_browser_failure(self) -> None:
        self.init_real_git_repo("alpha")
        beta = self.init_real_git_repo("beta")
        gamma = self.init_real_git_repo("gamma")
        subprocess.run(
            [
                "git",
                "-C",
                str(beta),
                "remote",
                "add",
                "origin",
                str(self.base_path / "mirrors" / "beta.git"),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            ["git", "-C", str(gamma), "remote", "add", "origin", "https://github.com/example/project.git"],
            check=True,
            capture_output=True,
            text=True,
        )

        app = self.create_tui()

        async with app.run_test() as pilot:
            await pilot.pause()
            await pilot.press("down")
            await pilot.pause()
            await pilot.press("o")
            await pilot.pause()

            status = app.query_one("#status").renderable
            self.assertIn("No remote landing page available for beta.", str(status))

            with patch("gitlib.app.webbrowser.open", return_value=False) as open_mock:
                await pilot.press("down")
                await pilot.pause()
                await pilot.press("o")
                await pilot.pause()

                open_mock.assert_called_once_with("https://github.com/example/project")
                status = app.query_one("#status").renderable
                self.assertIn("Unable to open origin for gamma.", str(status))
