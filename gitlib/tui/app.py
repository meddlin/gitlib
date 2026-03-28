from __future__ import annotations

from dataclasses import dataclass
import webbrowser

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Checkbox, DataTable, Footer, Header, Input, Static

from gitlib.app import GitLibApp
from gitlib.models import RemoteTarget, RepoDetails, RepoRecord
from gitlib.store import RepoSelectorError
from gitlib.tui.widgets import RepoDetailPane, RepoFilterBar


@dataclass(slots=True)
class RepoFilters:
    search: str = ""
    technology: str = ""
    notes_only: bool = False


class GitLibTuiApp(App[None]):
    CSS = """
    Screen {
        layout: vertical;
    }

    #filter-bar {
        dock: top;
        height: auto;
        padding: 0 1;
        background: $surface;
    }

    #filter-bar Input {
        width: 1fr;
        margin-right: 1;
    }

    #filter-bar Checkbox {
        width: auto;
        margin-top: 1;
    }

    #content {
        height: 1fr;
        layout: horizontal;
    }

    #repo-list-pane {
        width: 3fr;
        padding: 1;
        border: round $panel;
    }

    #repo-table {
        height: 1fr;
    }

    #detail-pane {
        width: 2fr;
    }

    #status {
        dock: bottom;
        height: auto;
        padding: 0 1;
        background: $surface-darken-1;
    }
    """

    BINDINGS = [
        Binding("q", "request_quit", "Quit"),
        Binding("ctrl+c", "request_quit", "", show=False),
        Binding("r", "refresh_data", "Refresh"),
        Binding("/", "focus_search", "Search"),
        Binding("e", "edit_notes", "Edit"),
        Binding("o", "open_remote", "Open Remote"),
        Binding("ctrl+s", "save_notes", "Save"),
        Binding("escape", "escape", "Cancel"),
    ]

    def __init__(self, gitlib: GitLibApp) -> None:
        super().__init__()
        self.gitlib = gitlib
        self.repositories: list[RepoRecord] = []
        self.filtered_repositories: list[RepoRecord] = []
        self.repo_details_cache: dict[str, RepoDetails] = {}
        self.selected_relative_path: str | None = None
        self.edit_mode = False
        self.did_request_exit = False
        self._suppress_selection_events = False

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        yield RepoFilterBar(id="filter-bar")
        with Horizontal(id="content"):
            with Vertical(id="repo-list-pane"):
                yield Static("Repositories", id="repo-list-title")
                yield DataTable(id="repo-table")
            yield RepoDetailPane(id="detail-pane")
        yield Static("Press r to scan repositories.", id="status")
        yield Footer()

    def on_mount(self) -> None:
        table = self.repo_table
        table.cursor_type = "row"
        table.zebra_stripes = True
        table.add_columns("repo", "relative_path", "technologies", "notes")
        table.focus()
        self._refresh_data(initial=True)

    @property
    def repo_table(self) -> DataTable:
        return self.query_one("#repo-table", DataTable)

    @property
    def detail_pane(self) -> RepoDetailPane:
        return self.query_one("#detail-pane", RepoDetailPane)

    @property
    def search_input(self) -> Input:
        return self.query_one("#search-filter", Input)

    @property
    def technology_input(self) -> Input:
        return self.query_one("#technology-filter", Input)

    @property
    def notes_only_checkbox(self) -> Checkbox:
        return self.query_one("#notes-only-filter", Checkbox)

    def set_status(self, message: str) -> None:
        self.query_one("#status", Static).update(message)

    def current_filters(self) -> RepoFilters:
        return RepoFilters(
            search=self.search_input.value.strip(),
            technology=self.technology_input.value.strip(),
            notes_only=self.notes_only_checkbox.value,
        )

    def _refresh_data(self, initial: bool = False) -> None:
        if self.edit_mode and not initial:
            self.set_status("Save or cancel note edits before refreshing.")
            return

        preserved = self.selected_relative_path

        try:
            self.repositories = self.gitlib.refresh()
        except RuntimeError as exc:
            self.set_status(f"Refresh failed: {exc}")
            return

        self.repo_details_cache.clear()
        self._rebuild_table(preferred_selection=preserved)
        count = len(self.filtered_repositories)
        if initial:
            self.set_status(f"Loaded {count} repositories.")
        else:
            self.set_status(f"Refreshed {count} repositories.")

    def _reload_cached_data(self, preferred_selection: str | None = None) -> None:
        self.repositories = self.gitlib.load_repositories()
        self.repo_details_cache.clear()
        self._rebuild_table(preferred_selection=preferred_selection or self.selected_relative_path)

    def _filtered_rows(self) -> list[RepoRecord]:
        filters = self.current_filters()
        return self.gitlib.filter_repositories(
            self.repositories,
            search=filters.search,
            technology=filters.technology,
            notes_only=filters.notes_only,
        )

    def _rebuild_table(self, preferred_selection: str | None = None) -> None:
        self.filtered_repositories = self._filtered_rows()

        table = self.repo_table
        self._suppress_selection_events = True
        try:
            table.clear(columns=False)
            for repo in self.filtered_repositories:
                table.add_row(
                    repo.name,
                    repo.relative_path,
                    ", ".join(repo.technologies) if repo.technologies else "-",
                    "yes" if repo.has_notes else "-",
                    key=repo.relative_path,
                )
            if not self.filtered_repositories:
                self.selected_relative_path = None
                self.detail_pane.show_repository(None)
                return

            selected_index = 0
            if preferred_selection is not None:
                for index, repo in enumerate(self.filtered_repositories):
                    if repo.relative_path == preferred_selection:
                        selected_index = index
                        break
            table.move_cursor(row=selected_index, column=0, animate=False, scroll=True)
            self._show_repository(self.filtered_repositories[selected_index])
        finally:
            self._suppress_selection_events = False

    def _repository_for_row_key(self, row_key: object) -> RepoRecord | None:
        value = getattr(row_key, "value", row_key)
        if value is None:
            return None
        relative_path = str(value)
        for repo in self.filtered_repositories:
            if repo.relative_path == relative_path:
                return repo
        return None

    def _details_for_repository(self, repo: RepoRecord) -> RepoDetails:
        cached = self.repo_details_cache.get(repo.relative_path)
        if cached is not None and cached.repo.notes == repo.notes:
            return cached

        details = self.gitlib.get_repository_details(repo.relative_path, refresh=False)
        self.repo_details_cache[repo.relative_path] = details
        return details

    def _selected_repository(self) -> RepoRecord | None:
        if self.selected_relative_path is None:
            return None
        for repo in self.repositories:
            if repo.relative_path == self.selected_relative_path:
                return repo
        return None

    def _preferred_remote(self, details: RepoDetails) -> RemoteTarget | None:
        for remote in details.remotes:
            if remote.name == "origin" and remote.landing_page_url:
                return remote
        for remote in details.remotes:
            if remote.landing_page_url:
                return remote
        return None

    def _show_repository(self, repo: RepoRecord | None) -> None:
        if repo is None:
            self.selected_relative_path = None
            self.detail_pane.show_repository(None)
            return

        self.selected_relative_path = repo.relative_path
        details = self._details_for_repository(repo)
        self.detail_pane.show_repository(details)
        if details.remote_error:
            self.set_status(f"Selected {repo.relative_path}. Remotes unavailable: {details.remote_error}")
        else:
            self.set_status(f"Selected {repo.relative_path}.")

    def _cancel_note_edit(self) -> None:
        if self.selected_relative_path is None:
            self.edit_mode = False
            self.detail_pane.set_edit_mode(False)
            return

        self.edit_mode = False
        self.detail_pane.set_edit_mode(False)
        try:
            repo = self.gitlib.get_repository(self.selected_relative_path, refresh=False)
        except RepoSelectorError as exc:
            self.set_status(f"Unable to reload notes: {exc}")
            return

        self.repo_details_cache.pop(repo.relative_path, None)
        self._show_repository(repo)
        self.repo_table.focus()
        self.set_status(f"Canceled note edits for {repo.relative_path}.")

    def action_request_quit(self) -> None:
        self.did_request_exit = True
        self.exit()

    def action_refresh_data(self) -> None:
        self._refresh_data()

    def action_focus_search(self) -> None:
        self.search_input.focus()
        self.set_status("Search focused.")

    def action_edit_notes(self) -> None:
        if self.selected_relative_path is None:
            self.set_status("No repository selected.")
            return

        self.edit_mode = True
        self.detail_pane.set_edit_mode(True)
        self.detail_pane.notes_editor.focus()
        self.set_status("Editing notes. Press Ctrl+S to save or Esc to cancel.")

    def action_save_notes(self) -> None:
        if not self.edit_mode or self.selected_relative_path is None:
            self.set_status("No note edit in progress.")
            return

        try:
            repo = self.gitlib.save_repository_notes(
                self.selected_relative_path,
                self.detail_pane.notes_editor.text,
                refresh=False,
            )
        except RuntimeError as exc:
            self.set_status(f"Save failed: {exc}")
            return

        self.edit_mode = False
        self.detail_pane.set_edit_mode(False)
        self.repo_details_cache.pop(repo.relative_path, None)
        self._reload_cached_data(preferred_selection=repo.relative_path)
        self.repo_table.focus()
        self.set_status(f"Saved notes for {repo.relative_path}.")

    def action_open_remote(self) -> None:
        repo = self._selected_repository()
        if repo is None:
            self.set_status("No repository selected.")
            return

        details = self._details_for_repository(repo)
        if details.remote_error:
            self.set_status(f"Remote links unavailable for {repo.relative_path}: {details.remote_error}")
            return

        remote = self._preferred_remote(details)
        if remote is None or remote.landing_page_url is None:
            self.set_status(f"No remote landing page available for {repo.relative_path}.")
            return

        try:
            opened = webbrowser.open(remote.landing_page_url)
        except (OSError, webbrowser.Error) as exc:
            self.set_status(f"Unable to open {remote.name} for {repo.relative_path}: {exc}")
            return

        if not opened:
            self.set_status(f"Unable to open {remote.name} for {repo.relative_path}.")
            return

        self.set_status(f"Opened {remote.name} for {repo.relative_path}.")

    def action_escape(self) -> None:
        if self.edit_mode:
            self._cancel_note_edit()
            return

        if self.focused is not None and self.focused is not self.repo_table:
            self.repo_table.focus()
            self.set_status("Focus returned to repository list.")

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id not in {"search-filter", "technology-filter"}:
            return
        self._rebuild_table(preferred_selection=self.selected_relative_path)

    def on_checkbox_changed(self, event: Checkbox.Changed) -> None:
        if event.checkbox.id != "notes-only-filter":
            return
        self._rebuild_table(preferred_selection=self.selected_relative_path)

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        if self._suppress_selection_events:
            return
        repo = self._repository_for_row_key(event.row_key)
        self._show_repository(repo)

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        if self._suppress_selection_events:
            return
        repo = self._repository_for_row_key(event.row_key)
        self._show_repository(repo)


def run_tui(gitlib: GitLibApp) -> None:
    app = GitLibTuiApp(gitlib)
    app.run()
