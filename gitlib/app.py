from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping

from gitlib.config import AppConfig, load_config
from gitlib.discovery import discover_repos
from gitlib.models import DiscoveredRepo, RepoRecord
from gitlib.scanner import scan_repo
from gitlib.store import Store


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _repo_key(repo: DiscoveredRepo) -> tuple[str, str]:
    return (repo.root_path, repo.relative_path)


def build_nested_repo_map(
    repositories: list[DiscoveredRepo],
) -> dict[tuple[str, str], set[Path]]:
    nested: dict[tuple[str, str], set[Path]] = {_repo_key(repo): set() for repo in repositories}

    for repo in repositories:
        repo_root = Path(repo.absolute_path)
        key = _repo_key(repo)
        for other in repositories:
            if repo == other:
                continue
            other_root = Path(other.absolute_path)
            try:
                other_root.relative_to(repo_root)
            except ValueError:
                continue
            nested[key].add(other_root)

    return nested


class GitLibApp:
    def __init__(self, config: AppConfig, store: Store) -> None:
        self.config = config
        self.store = store

    def refresh(self) -> list[RepoRecord]:
        discovered = discover_repos(self.config.roots, self.config.ignore_dirs)
        seen_at = utc_now()
        repo_ids = self.store.sync_repositories(discovered, self.config.roots, seen_at)
        nested_repo_map = build_nested_repo_map(discovered)

        for repo in discovered:
            key = _repo_key(repo)
            repo_id = repo_ids[key]
            technologies = scan_repo(
                Path(repo.absolute_path),
                self.config.ignore_dirs,
                nested_repo_map[key],
            )
            self.store.replace_technologies(repo_id, technologies, seen_at)

        return self.store.list_repositories(include_missing=False)

    def list_repositories(
        self,
        technology: str | None = None,
        notes_only: bool = False,
    ) -> list[RepoRecord]:
        repositories = self.refresh()

        if technology:
            needle = technology.casefold()
            repositories = [
                repo
                for repo in repositories
                if any(tag.casefold() == needle for tag in repo.technologies)
            ]

        if notes_only:
            repositories = [repo for repo in repositories if repo.has_notes]

        return repositories

    def show_repository(self, selector: str) -> RepoRecord:
        self.refresh()
        return self.store.resolve_repository(selector)

    def edit_repository_notes(self, selector: str, notes: str) -> RepoRecord:
        self.refresh()
        repo = self.store.resolve_repository(selector)
        self.store.update_notes(repo.id, notes)
        return self.store.resolve_repository(selector)


def create_application(env: Mapping[str, str] | None = None) -> GitLibApp:
    config = load_config(env)
    store = Store(config.db_path)
    return GitLibApp(config, store)
