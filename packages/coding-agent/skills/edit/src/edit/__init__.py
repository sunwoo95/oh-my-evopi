"""Exact single-occurrence string replacement for existing files."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path


async def run(path: str, old_str: str, new_str: str) -> str:
    """Replace a unique string in a file.

    ``old_str`` must appear exactly once in the file at ``path``; that match is
    replaced with ``new_str`` and the file is written back in place. Prefer this
    over rewriting a whole file for targeted edits.

    Args:
        path: File to edit, relative to the working directory, absolute, or
            `~`-prefixed (the leading `~`/`~user` is expanded to the home dir).
        old_str: Exact text to find. Must occur exactly once in the file.
        new_str: Replacement text.

    Returns:
        A short confirmation message.

    Raises:
        FileNotFoundError: If ``path`` does not exist.
        ValueError: If ``old_str`` is absent or matches more than once.
    """
    filepath = Path(path).expanduser()
    if not filepath.exists():
        raise FileNotFoundError(f"{path} not found")
    content = filepath.read_text(encoding="utf-8")
    count = content.count(old_str)
    if count == 0:
        raise ValueError(f"string not found in {path}")
    if count > 1:
        raise ValueError(
            f"found {count} occurrences in {path}, need exactly 1 — "
            "widen the snippet to make it unique"
        )
    match_index = content.index(old_str)
    start_line = content.count("\n", 0, match_index) + 1
    new_content = content.replace(old_str, new_str, 1)
    resolved_path = str(filepath.resolve())
    # NS-D4: the host only learns about this edit from the display event below,
    # which is processed after the file is already rewritten — so the before-image
    # must be captured here, in the kernel process, right before write_text.
    checkpoint_seq = _checkpoint_before(resolved_path, content, new_content, start_line)
    filepath.write_text(new_content, encoding="utf-8")
    _emit_diff(resolved_path, old_str, new_str, start_line, checkpoint_seq)
    return f"Edited {resolved_path}"


# Keep in sync with DIFF_DISPLAY_MIME in src/core/kernel/index.ts.
_DIFF_DISPLAY_MIME = "application/vnd.evopi.diff+json"


def _emit_diff(
    path: str,
    old_str: str,
    new_str: str,
    start_line: int,
    checkpoint_seq: str | None = None,
) -> None:
    """Stream a diff to the host as a display event; best-effort outside the kernel."""
    try:
        from rlm import emit

        payload: dict[str, object] = {
            "path": path,
            "old_str": old_str,
            "new_str": new_str,
            "start_line": start_line,
        }
        if checkpoint_seq is not None:
            payload["checkpoint_seq"] = checkpoint_seq
        emit(
            {
                _DIFF_DISPLAY_MIME: payload,
                "text/plain": f"Edited {path}",
            }
        )
    except Exception:
        pass


# --- Edit checkpoints (NS-D4) ------------------------------------------------
#
# Layout under ``$EVOPI_EDIT_CHECKPOINT_DIR`` (set by the host only when the
# feature is enabled for a persistent session; unset = no work at all):
#
#   index.jsonl      one JSON record per edit, appended in chronological order
#   blobs/<sha256>   content-addressed before-images (deduplicated)
#
# Keep the record shape in sync with EditCheckpointRecord in
# src/core/edit-checkpoints.ts, which owns retention, /rewind and the drift check.

_CHECKPOINT_DIR_ENV = "EVOPI_EDIT_CHECKPOINT_DIR"
_CHECKPOINT_MAX_FILE_BYTES_ENV = "EVOPI_EDIT_CHECKPOINT_MAX_FILE_BYTES"
_DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024


def _checkpoint_before(path: str, before: str, after: str, start_line: int) -> str | None:
    """Persist ``before`` as a checkpoint; returns its seq, or None when disabled/failed.

    Never raises: a failed checkpoint must not fail the edit (same posture as
    ``_emit_diff``).
    """
    root = os.environ.get(_CHECKPOINT_DIR_ENV)
    if not root:
        return None
    try:
        return _write_checkpoint(root, path, before, after, start_line)
    except Exception:
        return None


def _write_checkpoint(root: str, path: str, before: str, after: str, start_line: int) -> str:
    before_data = before.encode("utf-8")
    after_sha = hashlib.sha256(after.encode("utf-8")).hexdigest()
    seq = _new_seq()
    record: dict[str, object] = {
        "v": 1,
        "seq": seq,
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "kind": "edit",
        "source": _source(),
        "path": path,
        "before_sha256": None,
        "before_bytes": len(before_data),
        "after_sha256": after_sha,
        "start_line": start_line,
        "cell_id": _current_cell_id(),
    }
    if len(before_data) > _max_file_bytes():
        record["skipped"] = "oversized"
    else:
        sha = hashlib.sha256(before_data).hexdigest()
        _store_blob(root, sha, before_data)
        record["before_sha256"] = sha
    _append_index(root, record)
    return seq


def _new_seq() -> str:
    """Unique, time-ordered identifier (nanosecond wall clock + random suffix)."""
    return f"{time.time_ns():020d}-{secrets.token_hex(4)}"


def _max_file_bytes() -> int:
    raw = os.environ.get(_CHECKPOINT_MAX_FILE_BYTES_ENV, "")
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_MAX_FILE_BYTES
    return value if value > 0 else _DEFAULT_MAX_FILE_BYTES


def _source() -> str:
    """``kernel`` inside the REPL process, ``shell`` for the ``!edit`` CLI subprocess."""
    try:
        from rlm import repl

        return "kernel" if repl.is_active() else "shell"
    except Exception:
        return "shell"


def _current_cell_id() -> str | None:
    try:
        from rlm import repl

        return repl._current_cell.get()
    except Exception:
        return None


def _store_blob(root: str, sha: str, data: bytes) -> None:
    blobs = os.path.join(root, "blobs")
    target = os.path.join(blobs, sha)
    if os.path.exists(target):
        return
    os.makedirs(blobs, mode=0o700, exist_ok=True)
    tmp = f"{target}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _append_index(root: str, record: dict[str, object]) -> None:
    os.makedirs(root, mode=0o700, exist_ok=True)
    line = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    fd = os.open(os.path.join(root, "index.jsonl"), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        locked = False
        try:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX)
            locked = True
        except Exception:
            pass
        try:
            view = memoryview(line)
            while view:
                written = os.write(fd, view)
                view = view[written:]
        finally:
            if locked:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except Exception:
                    pass
    finally:
        os.close(fd)
