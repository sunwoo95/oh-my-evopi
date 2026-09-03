"""Edit-skill checkpoint capture (NS-D4).

Run from evopi-runtime so ``rlm`` is importable:

    cd evopi-runtime && PYTHONPATH=../packages/coding-agent/skills/edit/src \
      uv run --group dev python -m unittest discover \
      -s ../packages/coding-agent/skills/edit/test -p 'test_*.py'
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SKILL = Path(__file__).parents[1] / "src" / "edit" / "__init__.py"


def _load():
    spec = importlib.util.spec_from_file_location("edit_checkpoint_test", SKILL)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EditCheckpointTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "edit-checkpoints")
        self.target = Path(self.tmp.name) / "target.txt"
        self.target.write_text("alpha\nbeta\ngamma\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _run(self, **env: str) -> str:
        with mock.patch.dict(os.environ, env, clear=False):
            return asyncio.run(self.module.run(str(self.target), "beta", "BETA"))

    def _records(self) -> list[dict]:
        index = Path(self.root) / "index.jsonl"
        if not index.exists():
            return []
        return [json.loads(line) for line in index.read_text(encoding="utf-8").splitlines() if line]

    def test_disabled_when_env_unset_is_byte_identical(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "EVOPI_EDIT_CHECKPOINT_DIR"}
        emitted: list[dict] = []
        with mock.patch.dict(os.environ, env, clear=True), mock.patch("rlm.emit", emitted.append):
            result = asyncio.run(self.module.run(str(self.target), "beta", "BETA"))
        self.assertEqual(result, f"Edited {self.target.resolve()}")
        self.assertEqual(self.target.read_text(encoding="utf-8"), "alpha\nBETA\ngamma\n")
        self.assertFalse(os.path.exists(self.root))
        self.assertEqual(len(emitted), 1)
        payload = emitted[0][self.module._DIFF_DISPLAY_MIME]
        self.assertEqual(
            payload,
            {"path": str(self.target.resolve()), "old_str": "beta", "new_str": "BETA", "start_line": 2},
        )

    def test_enabled_writes_blob_and_index_record(self) -> None:
        emitted: list[dict] = []
        with mock.patch("rlm.emit", emitted.append):
            self._run(EVOPI_EDIT_CHECKPOINT_DIR=self.root)
        records = self._records()
        self.assertEqual(len(records), 1)
        record = records[0]
        before = "alpha\nbeta\ngamma\n".encode("utf-8")
        after = "alpha\nBETA\ngamma\n".encode("utf-8")
        self.assertEqual(record["v"], 1)
        self.assertEqual(record["kind"], "edit")
        self.assertEqual(record["source"], "shell")  # no live REPL protocol in-process
        self.assertEqual(record["path"], str(self.target.resolve()))
        self.assertEqual(record["before_sha256"], hashlib.sha256(before).hexdigest())
        self.assertEqual(record["before_bytes"], len(before))
        self.assertEqual(record["after_sha256"], hashlib.sha256(after).hexdigest())
        self.assertEqual(record["start_line"], 2)
        self.assertIsNone(record["cell_id"])
        self.assertNotIn("skipped", record)
        blob = Path(self.root) / "blobs" / record["before_sha256"]
        self.assertEqual(blob.read_bytes(), before)
        self.assertEqual(oct(blob.stat().st_mode & 0o777), oct(0o600))
        # The display payload carries the seq so hosts can correlate it.
        payload = emitted[0][self.module._DIFF_DISPLAY_MIME]
        self.assertEqual(payload["checkpoint_seq"], record["seq"])
        self.assertRegex(record["seq"], r"^\d{20}-[0-9a-f]{8}$")

    def test_identical_before_images_are_deduplicated(self) -> None:
        self._run(EVOPI_EDIT_CHECKPOINT_DIR=self.root)
        # Revert by hand and edit again: the same before-image must reuse one blob.
        self.target.write_text("alpha\nbeta\ngamma\n", encoding="utf-8")
        self._run(EVOPI_EDIT_CHECKPOINT_DIR=self.root)
        records = self._records()
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["before_sha256"], records[1]["before_sha256"])
        self.assertNotEqual(records[0]["seq"], records[1]["seq"])
        self.assertEqual(len(os.listdir(os.path.join(self.root, "blobs"))), 1)

    def test_oversized_file_is_recorded_as_skipped_without_blob(self) -> None:
        self._run(EVOPI_EDIT_CHECKPOINT_DIR=self.root, EVOPI_EDIT_CHECKPOINT_MAX_FILE_BYTES="4")
        records = self._records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["skipped"], "oversized")
        self.assertIsNone(records[0]["before_sha256"])
        self.assertFalse(os.path.exists(os.path.join(self.root, "blobs")))
        self.assertEqual(self.target.read_text(encoding="utf-8"), "alpha\nBETA\ngamma\n")

    def test_unwritable_checkpoint_dir_never_fails_the_edit(self) -> None:
        blocker = Path(self.tmp.name) / "blocked"
        blocker.write_text("not a directory", encoding="utf-8")
        emitted: list[dict] = []
        with mock.patch("rlm.emit", emitted.append):
            result = self._run(EVOPI_EDIT_CHECKPOINT_DIR=str(blocker))
        self.assertEqual(result, f"Edited {self.target.resolve()}")
        self.assertEqual(self.target.read_text(encoding="utf-8"), "alpha\nBETA\ngamma\n")
        self.assertNotIn("checkpoint_seq", emitted[0][self.module._DIFF_DISPLAY_MIME])

    def test_failed_edit_leaves_no_checkpoint(self) -> None:
        with mock.patch.dict(os.environ, {"EVOPI_EDIT_CHECKPOINT_DIR": self.root}):
            with self.assertRaises(ValueError):
                asyncio.run(self.module.run(str(self.target), "missing", "x"))
        self.assertFalse(os.path.exists(self.root))


if __name__ == "__main__":
    unittest.main()
