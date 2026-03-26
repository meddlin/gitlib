from __future__ import annotations

import json

from gitlib.models import RepoRecord


def _notes_preview(notes: str, width: int = 50) -> str:
    collapsed = " ".join(notes.split())
    if not collapsed:
        return "-"
    if len(collapsed) <= width:
        return collapsed
    return f"{collapsed[: width - 3]}..."


def repo_to_dict(repo: RepoRecord) -> dict[str, object]:
    return {
        "name": repo.name,
        "relative_path": repo.relative_path,
        "absolute_path": repo.absolute_path,
        "technologies": repo.technologies,
        "has_notes": repo.has_notes,
        "last_scanned_at": repo.last_scanned_at,
        "notes": repo.notes,
    }


def render_json(data: object) -> str:
    return json.dumps(data, indent=2, sort_keys=False)


def render_table(repositories: list[RepoRecord]) -> str:
    if not repositories:
        return "No repositories found."

    headers = ("repo", "relative_path", "technologies", "notes")
    rows = [
        (
            repo.name,
            repo.relative_path,
            ", ".join(repo.technologies) if repo.technologies else "-",
            _notes_preview(repo.notes),
        )
        for repo in repositories
    ]

    widths = [
        max(len(headers[index]), max(len(row[index]) for row in rows))
        for index in range(len(headers))
    ]

    lines = [
        "  ".join(headers[index].ljust(widths[index]) for index in range(len(headers))),
        "  ".join("-" * widths[index] for index in range(len(headers))),
    ]
    for row in rows:
        lines.append("  ".join(row[index].ljust(widths[index]) for index in range(len(row))))
    return "\n".join(lines)


def render_detail(repo: RepoRecord) -> str:
    technologies = ", ".join(repo.technologies) if repo.technologies else "-"
    notes = repo.notes if repo.notes else "-"
    lines = [
        f"repo: {repo.name}",
        f"relative_path: {repo.relative_path}",
        f"absolute_path: {repo.absolute_path}",
        f"technologies: {technologies}",
        f"last_scanned_at: {repo.last_scanned_at or '-'}",
        "notes:",
        notes,
    ]
    return "\n".join(lines)
