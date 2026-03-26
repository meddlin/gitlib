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
