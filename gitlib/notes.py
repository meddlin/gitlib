from __future__ import annotations

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
from typing import Mapping


class NotesError(RuntimeError):
    pass


def edit_notes(initial_notes: str, env: Mapping[str, str] | None = None) -> str:
    source = env if env is not None else os.environ
    editor = source.get("EDITOR", "vi")

    with tempfile.NamedTemporaryFile("w+", encoding="utf-8", delete=False, suffix=".md") as handle:
        temp_path = Path(handle.name)
        handle.write(initial_notes)
        handle.flush()

    try:
        command = [*shlex.split(editor), str(temp_path)]
        result = subprocess.run(command, check=False, env=dict(source))
        if result.returncode != 0:
            raise NotesError(f"Editor exited with status {result.returncode}")
        return temp_path.read_text(encoding="utf-8").rstrip()
    except OSError as exc:
        raise NotesError(f"Unable to launch editor '{editor}': {exc}") from exc
    finally:
        temp_path.unlink(missing_ok=True)
