from __future__ import annotations

from rich.markup import escape
from rich.text import Text
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Checkbox, Input, Static, TextArea

from gitlib.models import RemoteTarget, RepoDetails


def format_remote_summary(remote: RemoteTarget) -> str:
    line = f"{remote.name} -> {remote.provider} ({remote.host})"
    if remote.push_differs and remote.push_provider and remote.push_host:
        line += f" | push differs: {remote.push_provider} ({remote.push_host})"
    return line


def format_remote_block(remote: RemoteTarget) -> Text:
    markup = escape(format_remote_summary(remote)) + "\nlanding page: "
    if remote.landing_page_url:
        escaped_url = escape(remote.landing_page_url)
        markup += f"[link={escaped_url}]{escaped_url}[/link]"
    else:
        markup += "unavailable"
    return Text.from_markup(markup)


def format_repo_summary(details: RepoDetails | None) -> str:
    if details is None:
        return "No repository selected."

    repo = details.repo
    technologies = ", ".join(repo.technologies) if repo.technologies else "-"
    if details.remote_error:
        remotes = "unavailable"
    elif details.remotes:
        remotes = f"{len(details.remotes)} configured"
    else:
        remotes = "none"
    lines = [
        f"repo: {repo.name}",
        f"relative_path: {repo.relative_path}",
        f"absolute_path: {repo.absolute_path}",
        f"technologies: {technologies}",
        f"remotes: {remotes}",
        f"last_scanned_at: {repo.last_scanned_at or '-'}",
    ]
    return "\n".join(lines)


class RepoFilterBar(Horizontal):
    def compose(self) -> ComposeResult:
        yield Input(placeholder="Search repos", id="search-filter")
        yield Input(placeholder="Technology tag", id="technology-filter")
        yield Checkbox("Notes only", id="notes-only-filter")


class RepoDetailPane(Vertical):
    DEFAULT_CSS = """
    RepoDetailPane {
        padding: 1;
        border: round $panel;
    }

    #detail-title {
        text-style: bold;
        margin-bottom: 1;
    }

    #repo-summary {
        height: auto;
        min-height: 8;
        margin-bottom: 1;
    }

    #remote-targets-label {
        margin-top: 1;
    }

    #remote-targets {
        height: auto;
        min-height: 3;
        margin-bottom: 1;
    }

    #notes-label {
        margin-top: 1;
    }

    #notes-editor {
        height: 1fr;
        border: round $panel-lighten-1;
    }
    """

    def compose(self) -> ComposeResult:
        yield Static("Repository Details", id="detail-title")
        yield Static("No repository selected.", id="repo-summary")
        yield Static("Remote Targets", id="remote-targets-label")
        yield Static("-", id="remote-targets")
        yield Static("Notes", id="notes-label")
        yield TextArea("", id="notes-editor")

    def on_mount(self) -> None:
        editor = self.notes_editor
        editor.read_only = True
        editor.show_line_numbers = False

    @property
    def notes_editor(self) -> TextArea:
        return self.query_one("#notes-editor", TextArea)

    def show_repository(self, details: RepoDetails | None) -> None:
        self.query_one("#repo-summary", Static).update(format_repo_summary(details))
        self.query_one("#remote-targets", Static).update(self._format_remote_targets(details))
        notes = "" if details is None else details.repo.notes
        self.notes_editor.load_text(notes)
        self.notes_editor.read_only = True

    def set_edit_mode(self, enabled: bool) -> None:
        self.notes_editor.read_only = not enabled

    def _format_remote_targets(self, details: RepoDetails | None) -> str | Text:
        if details is None:
            return "-"
        if details.remote_error:
            return "-"
        if not details.remotes:
            return "-"
        return Text("\n\n").join([format_remote_block(remote) for remote in details.remotes])
