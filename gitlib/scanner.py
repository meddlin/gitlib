from __future__ import annotations

import json
import os
from pathlib import Path
import re
import tomllib


TECH_ORDER = [
    "Node.js",
    "Next.js",
    "React",
    "TypeScript",
    "Tailwind",
    "Vite",
    "Express",
    "Python",
    "FastAPI",
    "Flask",
    "Django",
    "Typer",
    "Click",
    ".NET",
    "C#",
    "Docker",
    "Rust",
    "Go",
    "Ruby",
]

TECH_RANK = {name: index for index, name in enumerate(TECH_ORDER)}
PACKAGE_SECTIONS = ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")
PACKAGE_CONFIG_TAGS = {
    "next.config.js": "Next.js",
    "next.config.mjs": "Next.js",
    "next.config.cjs": "Next.js",
    "next.config.ts": "Next.js",
    "tsconfig.json": "TypeScript",
    "tailwind.config.js": "Tailwind",
    "tailwind.config.mjs": "Tailwind",
    "tailwind.config.cjs": "Tailwind",
    "tailwind.config.ts": "Tailwind",
    "vite.config.js": "Vite",
    "vite.config.mjs": "Vite",
    "vite.config.cjs": "Vite",
    "vite.config.ts": "Vite",
}
PYTHON_TAG_MAP = {
    "fastapi": "FastAPI",
    "flask": "Flask",
    "django": "Django",
    "typer": "Typer",
    "click": "Click",
}
NODE_TAG_MAP = {
    "next": "Next.js",
    "react": "React",
    "react-dom": "React",
    "typescript": "TypeScript",
    "tailwindcss": "Tailwind",
    "vite": "Vite",
    "express": "Express",
}
REQUIREMENTS_NAME = re.compile(r"^\s*([A-Za-z0-9_.-]+)")


def sort_technologies(technologies: set[str]) -> list[str]:
    return sorted(technologies, key=lambda item: (TECH_RANK.get(item, len(TECH_ORDER)), item))


def _collect_package_dependencies(data: dict[str, object]) -> set[str]:
    names: set[str] = set()
    for section in PACKAGE_SECTIONS:
        value = data.get(section)
        if isinstance(value, dict):
            names.update(name.lower() for name in value if isinstance(name, str))
    return names


def _add_node_tags_from_package(path: Path, technologies: set[str]) -> None:
    technologies.add("Node.js")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return

    if not isinstance(payload, dict):
        return

    dependencies = _collect_package_dependencies(payload)
    for dependency, tag in NODE_TAG_MAP.items():
        if dependency in dependencies:
            technologies.add(tag)


def _extract_requirement_name(value: str) -> str | None:
    stripped = value.strip()
    if not stripped or stripped.startswith("#") or stripped.startswith("-"):
        return None
    match = REQUIREMENTS_NAME.match(stripped)
    if not match:
        return None
    return match.group(1).lower()


def _add_python_tags_from_names(names: set[str], technologies: set[str]) -> None:
    if not names:
        return
    technologies.add("Python")
    for dependency, tag in PYTHON_TAG_MAP.items():
        if dependency in names:
            technologies.add(tag)


def _add_tags_from_requirements(path: Path, technologies: set[str]) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return

    names = {name for line in lines if (name := _extract_requirement_name(line))}
    _add_python_tags_from_names(names, technologies)


def _parse_pyproject_dependency_strings(values: object) -> set[str]:
    names: set[str] = set()
    if isinstance(values, list):
        for entry in values:
            if isinstance(entry, str):
                name = _extract_requirement_name(entry)
                if name:
                    names.add(name)
    return names


def _collect_poetry_dependencies(values: object) -> set[str]:
    if not isinstance(values, dict):
        return set()
    return {name.lower() for name in values if isinstance(name, str) and name.lower() != "python"}


def _add_tags_from_pyproject(path: Path, technologies: set[str]) -> None:
    technologies.add("Python")
    try:
        payload = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return

    names: set[str] = set()

    project = payload.get("project")
    if isinstance(project, dict):
        names.update(_parse_pyproject_dependency_strings(project.get("dependencies")))
        optional = project.get("optional-dependencies")
        if isinstance(optional, dict):
            for value in optional.values():
                names.update(_parse_pyproject_dependency_strings(value))

    tool = payload.get("tool")
    if isinstance(tool, dict):
        poetry = tool.get("poetry")
        if isinstance(poetry, dict):
            names.update(_collect_poetry_dependencies(poetry.get("dependencies")))
            group = poetry.get("group")
            if isinstance(group, dict):
                for value in group.values():
                    if isinstance(value, dict):
                        names.update(_collect_poetry_dependencies(value.get("dependencies")))

    _add_python_tags_from_names(names, technologies)


def _max_depth_for(repo_root: Path, current: Path) -> int:
    relative = current.relative_to(repo_root)
    if not relative.parts:
        return 0
    return len(relative.parts)


def scan_repo(
    repo_root: Path,
    ignore_dirs: set[str] | frozenset[str],
    nested_repo_roots: set[Path] | frozenset[Path],
    max_depth: int = 3,
) -> list[str]:
    repo_root = repo_root.resolve(strict=False)
    normalized_nested_roots = {path.resolve(strict=False) for path in nested_repo_roots}
    technologies: set[str] = set()
    nested_by_parent: dict[Path, set[str]] = {}
    for child in normalized_nested_roots:
        nested_by_parent.setdefault(child.parent, set()).add(child.name)

    for dirpath, dirnames, filenames in os.walk(repo_root, topdown=True, followlinks=False):
        current = Path(dirpath).resolve(strict=False)

        if any(current == child or current.is_relative_to(child) for child in normalized_nested_roots):
            dirnames[:] = []
            continue

        depth = _max_depth_for(repo_root, current)

        if depth > max_depth:
            dirnames[:] = []
            continue

        excluded_children = nested_by_parent.get(current, set())
        dirnames[:] = [
            name for name in dirnames if name not in ignore_dirs and name not in excluded_children
        ]

        if depth == max_depth:
            dirnames[:] = []

        for filename in filenames:
            path = current / filename

            if filename == "package.json":
                _add_node_tags_from_package(path, technologies)
                continue

            if filename in PACKAGE_CONFIG_TAGS:
                technologies.add(PACKAGE_CONFIG_TAGS[filename])
                continue

            if filename == "pyproject.toml":
                _add_tags_from_pyproject(path, technologies)
                continue

            if filename == "requirements.txt":
                _add_tags_from_requirements(path, technologies)
                continue

            if filename.endswith(".csproj") or filename.endswith(".sln"):
                technologies.update({".NET", "C#"})
                continue

            if filename == "Dockerfile" or filename in {"docker-compose.yml", "docker-compose.yaml"}:
                technologies.add("Docker")
                continue

            if filename == "Cargo.toml":
                technologies.add("Rust")
                continue

            if filename == "go.mod":
                technologies.add("Go")
                continue

            if filename == "Gemfile":
                technologies.add("Ruby")

    return sort_technologies(technologies)
