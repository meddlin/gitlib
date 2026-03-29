from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess
from typing import Mapping
from urllib.parse import urlsplit
import webbrowser

from gitlib.config import AppConfig, load_config
from gitlib.discovery import discover_repos
from gitlib.models import DiscoveredRepo, RemoteTarget, RepoDetails, RepoRecord
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


REMOTE_LINE_RE = re.compile(r"^(?P<name>\S+)\s+(?P<url>\S+)\s+\((?P<kind>fetch|push)\)$")
SCP_STYLE_RE = re.compile(r"^[^@]+@(?P<host>[^:]+):")
SCP_PATH_RE = re.compile(r"^[^@]+@(?P<host>[^:]+):(?P<path>.+)$")


def _extract_remote_host(url: str) -> str:
    if "://" in url:
        without_scheme = url.split("://", 1)[1]
        host_part = without_scheme.split("/", 1)[0]
        if "@" in host_part:
            host_part = host_part.split("@", 1)[1]
        if ":" in host_part:
            host_part = host_part.split(":", 1)[0]
        return host_part

    match = SCP_STYLE_RE.match(url)
    if match:
        return match.group("host")

    if ":" in url and "/" not in url.split(":", 1)[0]:
        return url.split(":", 1)[0]

    return url


def _classify_provider(host: str) -> str:
    normalized = host.casefold()
    if "github" in normalized:
        return "GitHub"
    if "gitlab" in normalized:
        return "GitLab"
    return f"Other ({host})" if host else "Other"


def _normalize_repo_path(path: str) -> str | None:
    normalized = path.strip().strip("/")
    if not normalized:
        return None

    if normalized.endswith(".git"):
        normalized = normalized[:-4]
    normalized = normalized.rstrip("/")
    if not normalized:
        return None

    return normalized


def _build_https_landing_page(host: str, path: str) -> str | None:
    normalized_path = _normalize_repo_path(path)
    if not host or normalized_path is None:
        return None
    return f"https://{host}/{normalized_path}"


def normalize_remote_landing_page(url: str) -> str | None:
    if "://" in url:
        parsed = urlsplit(url)
        if parsed.scheme in {"http", "https"}:
            if not parsed.hostname:
                return None
            normalized_path = _normalize_repo_path(parsed.path)
            if normalized_path is None:
                return None
            netloc = parsed.hostname
            if parsed.port is not None:
                netloc = f"{netloc}:{parsed.port}"
            return f"{parsed.scheme}://{netloc}/{normalized_path}"

        if parsed.scheme == "ssh":
            if not parsed.hostname:
                return None
            return _build_https_landing_page(parsed.hostname, parsed.path)

        return None

    match = SCP_PATH_RE.match(url)
    if match:
        return _build_https_landing_page(match.group("host"), match.group("path"))

    return None


def _format_remote_target(name: str, fetch_url: str, push_url: str) -> RemoteTarget:
    fetch_host = _extract_remote_host(fetch_url)
    push_host = _extract_remote_host(push_url)
    fetch_provider = _classify_provider(fetch_host)
    push_provider = _classify_provider(push_host)
    push_differs = fetch_url != push_url
    return RemoteTarget(
        name=name,
        fetch_url=fetch_url,
        push_url=push_url,
        provider=fetch_provider,
        host=fetch_host,
        push_differs=push_differs,
        push_provider=push_provider if push_differs else None,
        push_host=push_host if push_differs else None,
        landing_page_url=normalize_remote_landing_page(fetch_url),
    )


def load_git_remotes(repo_path: Path) -> tuple[list[RemoteTarget], str | None]:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_path), "remote", "-v"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        return [], str(exc)

    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or f"git exited with status {result.returncode}"
        return [], message

    remotes_by_name: dict[str, dict[str, str]] = {}
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = REMOTE_LINE_RE.match(stripped)
        if not match:
            continue

        name = match.group("name")
        kind = match.group("kind")
        url = match.group("url")
        remotes_by_name.setdefault(name, {})[kind] = url

    remotes: list[RemoteTarget] = []
    for name in sorted(remotes_by_name):
        fetch_url = remotes_by_name[name].get("fetch", "")
        push_url = remotes_by_name[name].get("push", fetch_url)
        if not fetch_url:
            continue
        remotes.append(_format_remote_target(name, fetch_url, push_url))

    return remotes, None


def load_repo_readme(repo_path: Path) -> tuple[str | None, str | None]:
    readme_path = repo_path / "README.md"
    if not readme_path.exists():
        return None, None

    try:
        return readme_path.read_text(encoding="utf-8", errors="replace"), None
    except OSError as exc:
        return None, str(exc)


def select_preferred_remote(remotes: list[RemoteTarget]) -> RemoteTarget | None:
    for remote in remotes:
        if remote.name == "origin" and remote.landing_page_url:
            return remote
    for remote in remotes:
        if remote.landing_page_url:
            return remote
    return None


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

    def load_repositories(self) -> list[RepoRecord]:
        return self.store.list_repositories(include_missing=False)

    def filter_repositories(
        self,
        repositories: list[RepoRecord],
        search: str | None = None,
        technology: str | None = None,
        notes_only: bool = False,
    ) -> list[RepoRecord]:
        filtered = repositories

        if search:
            needle = search.casefold()
            filtered = [
                repo
                for repo in filtered
                if needle in repo.name.casefold()
                or needle in repo.relative_path.casefold()
                or needle in repo.absolute_path.casefold()
                or any(needle in tag.casefold() for tag in repo.technologies)
                or needle in repo.notes.casefold()
            ]

        if technology:
            needle = technology.casefold()
            filtered = [
                repo
                for repo in filtered
                if any(tag.casefold() == needle for tag in repo.technologies)
            ]

        if notes_only:
            filtered = [repo for repo in filtered if repo.has_notes]

        return filtered

    def list_repositories(
        self,
        search: str | None = None,
        technology: str | None = None,
        notes_only: bool = False,
        refresh: bool = True,
    ) -> list[RepoRecord]:
        repositories = self.refresh() if refresh else self.load_repositories()

        return self.filter_repositories(
            repositories,
            search=search,
            technology=technology,
            notes_only=notes_only,
        )

    def get_repository(self, selector: str, refresh: bool = False) -> RepoRecord:
        if refresh:
            self.refresh()
        return self.store.resolve_repository(selector)

    def show_repository(self, selector: str) -> RepoRecord:
        return self.get_repository(selector, refresh=True)

    def get_repository_details(self, selector: str, refresh: bool = False) -> RepoDetails:
        repo = self.get_repository(selector, refresh=refresh)
        repo_path = Path(repo.absolute_path)
        remotes, remote_error = load_git_remotes(repo_path)
        readme_markdown, readme_error = load_repo_readme(repo_path)
        return RepoDetails(
            repo=repo,
            remotes=remotes,
            remote_error=remote_error,
            readme_markdown=readme_markdown,
            readme_error=readme_error,
        )

    def open_repository_in_vscode(self, selector: str, refresh: bool = False) -> RepoRecord:
        repo = self.get_repository(selector, refresh=refresh)
        command = [*self.config.vscode_command, repo.absolute_path]

        try:
            result = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
            )
        except OSError as exc:
            raise RuntimeError(f"Unable to launch VS Code: {exc}") from exc

        if result.returncode != 0:
            message = result.stderr.strip() or result.stdout.strip() or f"command exited with status {result.returncode}"
            raise RuntimeError(f"Unable to launch VS Code: {message}")

        return repo

    def open_repository_remote(self, selector: str, refresh: bool = False) -> tuple[RepoRecord, RemoteTarget]:
        details = self.get_repository_details(selector, refresh=refresh)
        repo = details.repo

        if details.remote_error:
            raise RuntimeError(f"Remote links unavailable for {repo.relative_path}: {details.remote_error}")

        remote = select_preferred_remote(details.remotes)
        if remote is None or remote.landing_page_url is None:
            raise RuntimeError(f"No remote landing page available for {repo.relative_path}.")

        try:
            opened = webbrowser.open(remote.landing_page_url)
        except (OSError, webbrowser.Error) as exc:
            raise RuntimeError(f"Unable to open {remote.name} for {repo.relative_path}: {exc}") from exc

        if not opened:
            raise RuntimeError(f"Unable to open {remote.name} for {repo.relative_path}.")

        return repo, remote

    def save_repository_notes(self, selector: str, notes: str, refresh: bool = False) -> RepoRecord:
        if refresh:
            self.refresh()
        repo = self.store.resolve_repository(selector)
        self.store.update_notes(repo.id, notes)
        return self.store.resolve_repository(selector)

    def edit_repository_notes(self, selector: str, notes: str) -> RepoRecord:
        return self.save_repository_notes(selector, notes, refresh=True)


def create_application(env: Mapping[str, str] | None = None) -> GitLibApp:
    config = load_config(env)
    store = Store(config.db_path)
    return GitLibApp(config, store)
