from __future__ import annotations

from collections import defaultdict
from contextlib import closing
from pathlib import Path
import sqlite3
from typing import Iterable

from gitlib.models import DiscoveredRepo, RepoRecord
from gitlib.scanner import sort_technologies


class RepoSelectorError(RuntimeError):
    pass


class RepoNotFoundError(RepoSelectorError):
    pass


class AmbiguousRepoSelectorError(RepoSelectorError):
    def __init__(self, selector: str, matches: list[str]) -> None:
        self.selector = selector
        self.matches = matches
        message = f"Repository selector '{selector}' is ambiguous. Matches: {', '.join(matches)}"
        super().__init__(message)


class Store:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS repos (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    root_path TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    absolute_path TEXT NOT NULL,
                    name TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    last_scanned_at TEXT,
                    is_missing INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(root_path, relative_path)
                );

                CREATE TABLE IF NOT EXISTS repo_notes (
                    repo_id INTEGER PRIMARY KEY,
                    notes TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS repo_technologies (
                    repo_id INTEGER NOT NULL,
                    technology TEXT NOT NULL,
                    PRIMARY KEY (repo_id, technology),
                    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
                );
                """
            )

    def sync_repositories(
        self,
        discovered: Iterable[DiscoveredRepo],
        scanned_roots: Iterable[Path],
        seen_at: str,
    ) -> dict[tuple[str, str], int]:
        discovered_list = list(discovered)
        scanned_root_values = [str(root.resolve(strict=False)) for root in scanned_roots]
        seen_keys = {(repo.root_path, repo.relative_path) for repo in discovered_list}
        repo_ids: dict[tuple[str, str], int] = {}

        with closing(self._connect()) as connection, connection:
            for repo in discovered_list:
                connection.execute(
                    """
                    INSERT INTO repos (
                        root_path,
                        relative_path,
                        absolute_path,
                        name,
                        last_seen_at,
                        is_missing
                    )
                    VALUES (?, ?, ?, ?, ?, 0)
                    ON CONFLICT(root_path, relative_path) DO UPDATE SET
                        absolute_path = excluded.absolute_path,
                        name = excluded.name,
                        last_seen_at = excluded.last_seen_at,
                        is_missing = 0
                    """,
                    (
                        repo.root_path,
                        repo.relative_path,
                        repo.absolute_path,
                        repo.name,
                        seen_at,
                    ),
                )
                row = connection.execute(
                    "SELECT id FROM repos WHERE root_path = ? AND relative_path = ?",
                    (repo.root_path, repo.relative_path),
                ).fetchone()
                if row is None:
                    continue
                repo_id = int(row["id"])
                repo_ids[(repo.root_path, repo.relative_path)] = repo_id
                connection.execute(
                    "INSERT OR IGNORE INTO repo_notes(repo_id, notes) VALUES (?, '')",
                    (repo_id,),
                )

            if scanned_root_values:
                rows = connection.execute(
                    f"""
                    SELECT id, root_path, relative_path
                    FROM repos
                    WHERE root_path IN ({",".join("?" for _ in scanned_root_values)})
                    """,
                    scanned_root_values,
                ).fetchall()
                missing_ids = [
                    int(row["id"])
                    for row in rows
                    if (row["root_path"], row["relative_path"]) not in seen_keys
                ]
                if missing_ids:
                    connection.executemany(
                        "UPDATE repos SET is_missing = 1 WHERE id = ?",
                        ((repo_id,) for repo_id in missing_ids),
                    )

        return repo_ids

    def replace_technologies(self, repo_id: int, technologies: list[str], scanned_at: str) -> None:
        ordered = sort_technologies(set(technologies))
        with closing(self._connect()) as connection, connection:
            connection.execute("DELETE FROM repo_technologies WHERE repo_id = ?", (repo_id,))
            if ordered:
                connection.executemany(
                    "INSERT INTO repo_technologies(repo_id, technology) VALUES (?, ?)",
                    ((repo_id, technology) for technology in ordered),
                )
            connection.execute(
                "UPDATE repos SET last_scanned_at = ? WHERE id = ?",
                (scanned_at, repo_id),
            )

    def _load_technologies(self, connection: sqlite3.Connection) -> dict[int, list[str]]:
        technologies: dict[int, list[str]] = defaultdict(list)
        rows = connection.execute(
            "SELECT repo_id, technology FROM repo_technologies ORDER BY technology"
        ).fetchall()
        for row in rows:
            technologies[int(row["repo_id"])].append(str(row["technology"]))
        return technologies

    def list_repositories(self, include_missing: bool = False) -> list[RepoRecord]:
        with closing(self._connect()) as connection, connection:
            query = """
                SELECT
                    repos.id,
                    repos.root_path,
                    repos.relative_path,
                    repos.absolute_path,
                    repos.name,
                    repos.last_seen_at,
                    repos.last_scanned_at,
                    repos.is_missing,
                    COALESCE(repo_notes.notes, '') AS notes
                FROM repos
                LEFT JOIN repo_notes ON repo_notes.repo_id = repos.id
            """
            params: tuple[object, ...] = ()
            if not include_missing:
                query += " WHERE repos.is_missing = 0"
            query += " ORDER BY repos.relative_path"
            rows = connection.execute(query, params).fetchall()
            technologies = self._load_technologies(connection)

        records: list[RepoRecord] = []
        for row in rows:
            repo_id = int(row["id"])
            records.append(
                RepoRecord(
                    id=repo_id,
                    root_path=str(row["root_path"]),
                    relative_path=str(row["relative_path"]),
                    absolute_path=str(row["absolute_path"]),
                    name=str(row["name"]),
                    last_seen_at=str(row["last_seen_at"]),
                    last_scanned_at=str(row["last_scanned_at"]) if row["last_scanned_at"] else None,
                    is_missing=bool(row["is_missing"]),
                    technologies=sort_technologies(set(technologies.get(repo_id, []))),
                    notes=str(row["notes"]),
                )
            )
        return records

    def resolve_repository(self, selector: str) -> RepoRecord:
        normalized = selector.strip().strip("/")
        normalized = normalized.removeprefix("./")
        repositories = self.list_repositories(include_missing=False)

        for repo in repositories:
            if repo.relative_path == normalized:
                return repo

        matches = [repo for repo in repositories if repo.name == normalized]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            relative_paths = [repo.relative_path for repo in matches]
            raise AmbiguousRepoSelectorError(normalized, relative_paths)

        raise RepoNotFoundError(f"Repository '{selector}' was not found.")

    def update_notes(self, repo_id: int, notes: str) -> None:
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO repo_notes(repo_id, notes) VALUES (?, ?)
                ON CONFLICT(repo_id) DO UPDATE SET notes = excluded.notes
                """,
                (repo_id, notes),
            )
