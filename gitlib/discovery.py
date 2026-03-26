from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

from gitlib.models import DiscoveredRepo


def _relative_path(root: Path, repo_path: Path) -> str:
    relative = repo_path.relative_to(root).as_posix()
    return relative or "."


def discover_repos(roots: Iterable[Path], ignore_dirs: set[str] | frozenset[str]) -> list[DiscoveredRepo]:
    discovered: list[DiscoveredRepo] = []

    for root in roots:
        if not root.exists() or not root.is_dir():
            continue

        root = root.resolve(strict=False)

        for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
            current = Path(dirpath)
            has_git_marker = ".git" in dirnames or ".git" in filenames
            dirnames[:] = [name for name in dirnames if name not in ignore_dirs]

            if not has_git_marker:
                continue

            discovered.append(
                DiscoveredRepo(
                    root_path=str(root),
                    relative_path=_relative_path(root, current),
                    absolute_path=str(current.resolve(strict=False)),
                    name=current.name,
                )
            )

    discovered.sort(key=lambda repo: (repo.root_path, repo.relative_path))
    return discovered
