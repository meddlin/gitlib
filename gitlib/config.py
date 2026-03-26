from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import textwrap
import tomllib
from typing import Mapping


DEFAULT_ROOTS = ("~/git",)
DEFAULT_IGNORE_DIRS = (
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "venv",
    "env",
    "obj",
    "bin",
    "lib",
    "include",
    ".pytest_cache",
)


class ConfigError(RuntimeError):
    pass


@dataclass(slots=True, frozen=True)
class AppConfig:
    app_home: Path
    config_path: Path
    db_path: Path
    roots: tuple[Path, ...]
    ignore_dirs: frozenset[str]


def get_app_home(env: Mapping[str, str] | None = None) -> Path:
    source = env if env is not None else os.environ
    configured = source.get("GITLIB_HOME")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".git-library"


def _default_config_text() -> str:
    roots = "\n".join(f'  "{root}",' for root in DEFAULT_ROOTS)
    ignore_dirs = "\n".join(f'  "{name}",' for name in DEFAULT_IGNORE_DIRS)
    return textwrap.dedent(
        f"""\
        roots = [
        {roots}
        ]

        ignore_dirs = [
        {ignore_dirs}
        ]
        """
    )


def _write_default_config(config_path: Path) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(_default_config_text(), encoding="utf-8")


def _normalize_root(value: str, config_path: Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = (config_path.parent / path).resolve(strict=False)
    return path.resolve(strict=False)


def load_config(env: Mapping[str, str] | None = None) -> AppConfig:
    app_home = get_app_home(env)
    config_path = app_home / "config.toml"
    db_path = app_home / "gitlib.db"

    if not config_path.exists():
        _write_default_config(config_path)

    try:
        data = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ConfigError(f"Unable to load config at {config_path}: {exc}") from exc

    roots_raw = data.get("roots", list(DEFAULT_ROOTS))
    ignore_dirs_raw = data.get("ignore_dirs", list(DEFAULT_IGNORE_DIRS))

    if not isinstance(roots_raw, list) or not all(isinstance(item, str) for item in roots_raw):
        raise ConfigError(f"Config key 'roots' must be a list of strings in {config_path}")
    if not isinstance(ignore_dirs_raw, list) or not all(
        isinstance(item, str) for item in ignore_dirs_raw
    ):
        raise ConfigError(f"Config key 'ignore_dirs' must be a list of strings in {config_path}")

    app_home.mkdir(parents=True, exist_ok=True)

    return AppConfig(
        app_home=app_home,
        config_path=config_path,
        db_path=db_path,
        roots=tuple(_normalize_root(item, config_path) for item in roots_raw),
        ignore_dirs=frozenset(ignore_dirs_raw),
    )
