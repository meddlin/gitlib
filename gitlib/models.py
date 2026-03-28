from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True, frozen=True)
class DiscoveredRepo:
    root_path: str
    relative_path: str
    absolute_path: str
    name: str


@dataclass(slots=True)
class RepoRecord:
    id: int
    root_path: str
    relative_path: str
    absolute_path: str
    name: str
    last_seen_at: str
    last_scanned_at: str | None
    is_missing: bool
    technologies: list[str]
    notes: str

    @property
    def has_notes(self) -> bool:
        return bool(self.notes.strip())


@dataclass(slots=True)
class RemoteTarget:
    name: str
    fetch_url: str
    push_url: str
    provider: str
    host: str
    push_differs: bool
    push_provider: str | None = None
    push_host: str | None = None
    landing_page_url: str | None = None


@dataclass(slots=True)
class RepoDetails:
    repo: RepoRecord
    remotes: list[RemoteTarget]
    remote_error: str | None = None
    readme_markdown: str | None = None
    readme_error: str | None = None

    @property
    def has_remotes(self) -> bool:
        return bool(self.remotes)
