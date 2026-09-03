from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from rlm import harness as package_harness
from rlm import rlm as callable_rlm
from rlm.harness import HarnessState, get_harness_state

PYTHON_REFERENCE = {
    "type": "python",
    "import": "agent_skills.example",
    "callable": "run",
    "call_pattern": "await run(...)",
}


class HarnessStateTest(unittest.TestCase):
    def test_crud_for_all_entry_kinds(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            created = {
                "prompt": state.create_prompt_note(
                    "Prompt note",
                    "Prompt content",
                    id="prompt_entry",
                    path="prompt/path",
                    metadata={"kind": "prompt"},
                ),
                "memory": state.create_memory(
                    "Memory",
                    "Memory content",
                    id="memory_entry",
                    path="memory/path",
                    metadata={"kind": "memory"},
                ),
                "skill": state.create_skill(
                    "Skill",
                    "Skill content",
                    id="skill_entry",
                    path="skill/path",
                    reference=PYTHON_REFERENCE,
                    arguments={"target": {"type": "string", "required": True}},
                    metadata={"kind": "skill"},
                ),
                "subagent": state.create_subagent(
                    "Subagent",
                    "Subagent content",
                    id="subagent_entry",
                    path="subagent/path",
                    metadata={"kind": "subagent"},
                ),
            }

            for kind, entry in created.items():
                self.assertEqual(entry.kind, kind)
                self.assertIn("content", state.get(kind, entry.id).content.lower())
                self.assertIn(entry, state.list(kind))

            state.update_prompt_note("prompt_entry", "Prompt note", "Prompt content updated")
            state.update_memory("memory_entry", "Memory", "Memory content updated")
            state.update_skill(
                "skill_entry",
                "Skill",
                "Skill content updated",
                reference=PYTHON_REFERENCE,
                arguments={"target": {"type": "string", "required": True}, "mode": {"type": "string"}},
            )
            state.update_subagent("subagent_entry", "Subagent", "Subagent content updated")

            for kind in ("prompt", "memory", "skill", "subagent"):
                entry_id = f"{kind}_entry"
                self.assertEqual(state.get(kind, entry_id).version, 2)
                self.assertIn("updated", state.get(kind, entry_id).content)
                delete_method = getattr(state, f"delete_{'prompt_note' if kind == 'prompt' else kind}")
                self.assertTrue(delete_method(entry_id))
                self.assertIsNone(state.get(kind, entry_id))
                self.assertFalse(delete_method(entry_id))

            self.assertEqual(state.list(), [])

    def test_persists_entries_and_refinements(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            memory = state.create_memory(
                "Prefer focused patches",
                "Small harness updates are easier to validate than broad rewrites.",
                path="engineering",
            )
            skill = state.create_skill(
                "Check failures first",
                "Inspect current failure evidence before editing code.",
                id="failure_first",
                reference=PYTHON_REFERENCE,
                arguments={"failure_log": {"type": "string", "description": "Current failure evidence."}},
            )
            subagent = state.create_subagent(
                "Reviewer",
                "Review the proposed patch for regressions and missing tests.",
                metadata={"max_turns": 3},
            )
            state.create_prompt_note("Refinement cadence", "Refine only after repeated evidence.")
            event = state.record_refinement(
                "skill failed twice",
                ["updated failure_first skill", "added reviewer subagent"],
                evidence="two failed validations",
                outcome="next validation passed",
            )

            reloaded = HarnessState(state.file_path)

            self.assertEqual(reloaded.get("memory", memory.id).content, memory.content)
            self.assertEqual(reloaded.get("skill", skill.id).version, 1)
            self.assertEqual(reloaded.get("skill", skill.id).arguments["failure_log"]["type"], "string")
            self.assertEqual(reloaded.get("subagent", subagent.id).metadata["max_turns"], 3)
            self.assertEqual(reloaded.refinements[0].id, event.id)
            self.assertIn("Prefer focused patches", reloaded.overview())
            self.assertIn(
                "Call contract: installed Python skills use await <skill_import>(...)",
                reloaded.overview(),
            )
            overview = reloaded.overview()
            self.assertIn("handle = await rlm('sub-task')", overview)
            self.assertIn("never the child's answer", overview)
            self.assertIn("receiver_role='parent'", overview)
            self.assertIn("await rlm.list_subagents()", overview)
            self.assertIn("receiver_role='child'", overview)
            self.assertIn("refinements: 1", reloaded.overview())

    def test_load_ignores_unknown_json_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state_path.write_text(
                json.dumps(
                    {
                        "schema": 1,
                        "entries": {
                            "memory": {
                                "known": {
                                    "id": "mismatched",
                                    "kind": "skill",
                                    "title": "Known memory",
                                    "content": "Loaded despite extra keys.",
                                    "path": 123,
                                    "source": None,
                                    "version": "2",
                                    "metadata": "not a dict",
                                    "unexpected": True,
                                },
                                "missing_content": {
                                    "title": "Missing content",
                                }
                            }
                        },
                        "refinements": [
                            {
                                "id": "refine_extra",
                                "trigger": "extra keys",
                                "changes": [1, "loaded"],
                                "ignored": "value",
                            },
                            {
                                "id": "refine_missing_changes",
                                "trigger": "missing changes",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            state = HarnessState(state_path)

            self.assertEqual(state.get("memory", "known").content, "Loaded despite extra keys.")
            self.assertEqual(state.get("memory", "known").id, "known")
            self.assertEqual(state.get("memory", "known").kind, "memory")
            self.assertEqual(state.get("memory", "known").path, "general")
            self.assertEqual(state.get("memory", "known").source, "agent")
            self.assertIsNone(state.get("memory", "mismatched"))
            self.assertEqual(state.get("memory", "known").version, 2)
            self.assertEqual(state.get("memory", "known").metadata, {})
            self.assertIsNone(state.get("memory", "missing_content"))
            self.assertEqual(state.refinements[0].id, "refine_extra")
            self.assertEqual(state.refinements[0].changes, ["1", "loaded"])
            self.assertEqual(len(state.refinements), 1)
            self.assertIn("1, loaded", state.overview())

            updated = state.update_memory("known", "Known memory", "Updated content.")
            self.assertEqual(updated.version, 3)

    def test_skill_arguments_are_first_class(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            created = state.create_skill(
                "Edit file",
                "Apply a targeted edit.",
                id="edit_file",
                reference={
                    "type": "python",
                    "import": "agent_skills.file_edit",
                    "callable": "file_edit",
                    "call_pattern": "await file_edit(path=..., find=..., replace=...)",
                },
                arguments={
                    "path": {"type": "string", "required": True},
                    "find": {"type": "string", "required": True},
                    "replace": {"type": "string", "required": True},
                },
            )
            updated = state.update_skill(
                "edit_file",
                "Edit file",
                "Apply a targeted edit after reading context.",
                reference={
                    "type": "python",
                    "import": "agent_skills.file_edit",
                    "callable": "file_edit",
                    "call_pattern": "await file_edit(path=..., find=..., replace=...)",
                },
                arguments={
                    "path": {"type": "string", "required": True},
                    "find": {"type": "string", "required": True},
                    "replace": {"type": "string", "required": True},
                    "validate": {"type": "boolean", "default": True},
                },
            )
            reloaded = HarnessState(state.file_path)

            self.assertEqual(created.arguments["path"]["required"], True)
            self.assertEqual(created.reference["type"], "python")
            self.assertEqual(updated.version, 2)
            self.assertEqual(reloaded.get("skill", "edit_file").arguments["validate"]["default"], True)
            self.assertEqual(reloaded.get("skill", "edit_file").reference["import"], "agent_skills.file_edit")
            self.assertIn('"path"', reloaded.overview())
            self.assertIn("agent_skills", reloaded.overview())

    def test_skill_references_must_be_python(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(ValueError, "Python reference"):
                state.create_skill("No reference", "missing", arguments={})
            with self.assertRaisesRegex(ValueError, "reference.type must be 'python'"):
                state.create_skill(
                    "Shell reference",
                    "bad",
                    reference={"type": "shell", "command": "edit"},
                    arguments={},
                )
            with self.assertRaisesRegex(ValueError, "Python import"):
                state.create_skill("No import", "bad", reference={"type": "python", "callable": "run"}, arguments={})
            with self.assertRaisesRegex(ValueError, "callable or call_pattern"):
                state.create_skill(
                    "No callable",
                    "bad",
                    reference={"type": "python", "import": "agent_skills.bad"},
                    arguments={},
                )

    def test_load_tolerates_corrupt_or_non_object_state(self) -> None:
        for payload in ("not json at all", "null", "[]", '"a string"', "123"):
            with tempfile.TemporaryDirectory() as temp_dir:
                state_path = Path(temp_dir) / "harness_state.json"
                state_path.write_text(payload, encoding="utf-8")

                state = HarnessState(state_path)

                self.assertEqual(state.list(), [])
                self.assertEqual(state.refinements, [])
                # The store must remain usable and self-heal on the next write.
                created = state.create_memory("Recovered", "Works after corruption.", id="recovered")
                self.assertEqual(HarnessState(state_path).get("memory", "recovered").content, created.content)

    def test_update_skill_preserves_omitted_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_skill(
                "Edit file",
                "Apply an edit.",
                id="edit_file",
                reference=PYTHON_REFERENCE,
                arguments={"path": {"type": "string", "required": True}},
            )

            # Updating only title/content (arguments omitted) must keep the contract.
            state.update_skill("edit_file", "Edit file", "Apply an edit carefully.", reference=PYTHON_REFERENCE)
            self.assertEqual(state.get("skill", "edit_file").arguments, {"path": {"type": "string", "required": True}})

            # An explicit empty dict still clears it.
            state.update_skill("edit_file", "Edit file", "Now argument-free.", reference=PYTHON_REFERENCE, arguments={})
            self.assertEqual(state.get("skill", "edit_file").arguments, {})

    def test_update_skill_without_reference_preserves_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_skill(
                "Edit file",
                "Apply an edit.",
                id="edit_file",
                reference=PYTHON_REFERENCE,
                arguments={"path": {"type": "string", "required": True}},
            )

            # A title/content-only update must not require re-sending the reference,
            # and must preserve the existing reference and arguments.
            updated = state.update_skill("edit_file", "Edit file", "Apply an edit carefully.")

            self.assertEqual(updated.version, 2)
            self.assertEqual(updated.reference, PYTHON_REFERENCE)
            self.assertEqual(updated.arguments, {"path": {"type": "string", "required": True}})
            self.assertEqual(updated.content, "Apply an edit carefully.")

    def test_update_preserves_omitted_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("Grouped", "content", id="grouped", path="repo/testing")

            # Updating without a path keeps the custom grouping path.
            state.update_memory("grouped", "Grouped", "new content")
            self.assertEqual(state.get("memory", "grouped").path, "repo/testing")

            # An explicit path still moves it.
            state.update_memory("grouped", "Grouped", "newer", path="repo/other")
            self.assertEqual(state.get("memory", "grouped").path, "repo/other")

    def test_in_memory_state_never_touches_disk(self) -> None:
        previous = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
            os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
            try:
                state = HarnessState(in_memory=True)
                created = state.create_memory("Volatile", "in memory only", id="volatile")
                state.record_refinement("trigger", ["change"])

                self.assertIsNone(state.file_path)
                self.assertEqual(created.content, "in memory only")
                self.assertEqual(state.get("memory", "volatile").content, "in memory only")
                # Local in-memory operations do not resolve or persist a path.
                self.assertEqual(list(Path(temp_dir).iterdir()), [])
            finally:
                if previous is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

    def test_in_memory_state_global_flag_uses_global_env_store(self) -> None:
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = HarnessState(in_memory=True)
                global_entry = state.create_memory("Global note", "persisted", id="global_note", global_=True)
            finally:
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIsNone(state.file_path)
            self.assertEqual(global_entry.scope, "global")
            self.assertEqual(global_entry.content, "persisted")
            self.assertIsNone(state.get("memory", "global_note"))
            self.assertEqual(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "global_note").content,
                "persisted",
            )

    def test_in_memory_state_global_flag_uses_default_global_store(self) -> None:
        previous_agent_dir = os.environ.get("EVOPI_CODING_AGENT_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            agent_dir = Path(temp_dir) / "agent"
            os.environ["EVOPI_CODING_AGENT_DIR"] = str(agent_dir)
            os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
            try:
                state = HarnessState(in_memory=True)
                global_entry = state.create_memory("Default global", "persisted", id="default_global", global_=True)
            finally:
                if previous_agent_dir is None:
                    os.environ.pop("EVOPI_CODING_AGENT_DIR", None)
                else:
                    os.environ["EVOPI_CODING_AGENT_DIR"] = previous_agent_dir
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIsNone(state.file_path)
            self.assertEqual(global_entry.scope, "global")
            self.assertIsNone(state.get("memory", "default_global"))
            self.assertEqual(
                HarnessState(agent_dir / "harness" / "harness_state.json", scope="global")
                .get("memory", "default_global")
                .content,
                "persisted",
            )

    def test_reloads_external_writes_before_mutating(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            kernel_state = HarnessState(state_path)
            kernel_state.create_memory("Kernel note", "Written from the kernel.", id="kernel")

            # Simulate the host /refine command rewriting the same file from another
            # process. A second instance loads the current file, adds an entry, saves.
            host_state = HarnessState(state_path)
            host_state.create_memory("Host note", "Written by /refine.", id="host")
            # Guarantee the mtime advances even on coarse-resolution filesystems.
            future = state_path.stat().st_mtime + 5
            os.utime(state_path, (future, future))

            # A read on the long-lived kernel state must observe the host write.
            self.assertEqual(kernel_state.get("memory", "host").content, "Written by /refine.")

            # A mutation must merge onto the host write instead of clobbering it.
            kernel_state.create_memory("Second kernel note", "Written later.", id="kernel_2")

            reloaded = HarnessState(state_path)
            self.assertIsNotNone(reloaded.get("memory", "kernel"))
            self.assertIsNotNone(reloaded.get("memory", "host"))
            self.assertIsNotNone(reloaded.get("memory", "kernel_2"))

    def test_create_detects_externally_written_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "harness_state.json"
            state = HarnessState(state_path)

            # Another process creates the same entry on disk after our last load.
            other = HarnessState(state_path)
            other.create_memory("External", "Written elsewhere.", id="dup")
            future = state_path.stat().st_mtime + 5
            os.utime(state_path, (future, future))

            # create() must observe the external entry and honor create-or-fail.
            with self.assertRaisesRegex(ValueError, "already exists"):
                state.create_memory("Local", "Should not overwrite.", id="dup")
            self.assertEqual(state.get("memory", "dup").content, "Written elsewhere.")

    def test_explicit_create_and_update_enforce_entry_existence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            first = state.create_skill("Triage", "old", id="triage", reference=PYTHON_REFERENCE, arguments={})
            with self.assertRaisesRegex(ValueError, "already exists"):
                state.create_skill("Triage", "duplicate", id="triage", reference=PYTHON_REFERENCE, arguments={})
            with self.assertRaisesRegex(ValueError, "does not exist"):
                state.update_skill("missing", "Missing", "missing", reference=PYTHON_REFERENCE, arguments={})

            second = state.update_skill("triage", "Triage", "new", reference=PYTHON_REFERENCE, arguments={})

            self.assertEqual(first.id, second.id)
            self.assertEqual(second.content, "new")
            self.assertEqual(second.version, 2)

    def test_explicit_state_dir_cache_uses_harness_state_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = get_harness_state(temp_dir)
            again = get_harness_state(temp_dir)

            self.assertIs(state, again)
            self.assertEqual(state.file_path, Path(temp_dir).resolve() / "harness_state.json")

    def test_explicit_state_dir_global_flag_uses_matching_state_file(self) -> None:
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            explicit_dir = Path(temp_dir) / "explicit"
            env_global_dir = Path(temp_dir) / "env-global"
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(env_global_dir)
            try:
                state = get_harness_state(explicit_dir)
                global_entry = state.create_memory("Scoped global", "custom dir", id="scoped_global", global_=True)
            finally:
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(global_entry.scope, "global")
            self.assertIsNotNone(
                HarnessState(explicit_dir / "harness_state.json", scope="global").get("memory", "scoped_global")
            )
            self.assertFalse((env_global_dir / "harness_state.json").exists())

    def test_env_default_state_keeps_env_global_target_after_explicit_dir_cache_hit(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            env_global_dir = Path(temp_dir) / "env-global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(env_global_dir)
            try:
                cached_from_env = get_harness_state()
                # An explicit state_dir that aliases the env local dir must not
                # redirect the env-default singleton's global target.
                cached_from_explicit = get_harness_state(local_dir)
                global_entry = cached_from_env.create_memory(
                    "Env global",
                    "still targets the env global dir",
                    id="env_global_after_hit",
                    global_=True,
                )
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIs(cached_from_env, cached_from_explicit)
            self.assertEqual(global_entry.scope, "global")
            self.assertIsNotNone(
                HarnessState(env_global_dir / "harness_state.json", scope="global").get(
                    "memory", "env_global_after_hit"
                )
            )
            self.assertIsNone(
                HarnessState(local_dir / "harness_state.json").get("memory", "env_global_after_hit")
            )

    def test_local_state_requires_local_path(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        try:
            os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            os.environ.pop("RLM_SESSION_DIR", None)
            with self.assertRaisesRegex(RuntimeError, "Local harness state requires"):
                HarnessState()
        finally:
            if previous_local is None:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            else:
                os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
            if previous_session is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous_session

    def test_default_state_uses_global_harness_env_dir(self) -> None:
        previous = os.environ.get("RLM_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
            try:
                state = HarnessState()
            finally:
                if previous is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous

            self.assertEqual(state.file_path, Path(temp_dir).resolve() / "harness_state.json")

    def test_global_scope_default_state_uses_global_harness_env_dir(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = HarnessState(scope="global")
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(state.scope, "global")
            self.assertEqual(state.file_path, global_dir.resolve() / "harness_state.json")

    def test_default_state_is_local_and_global_flag_targets_global_store(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = get_harness_state()
                global_state = get_harness_state(global_=True)
                local_entry = state.create_memory("Local note", "Only this session.", id="local_note")
                global_entry = state.create_memory("Global note", "All sessions.", id="global_note", global_=True)
                kwargs_entry = state.create_memory(
                    "Kwargs global note",
                    "All sessions via kwargs.",
                    id="kwargs_global_note",
                    **{"global": True},
                )
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(state.file_path, local_dir.resolve() / "harness_state.json")
            self.assertEqual(global_state.file_path, global_dir.resolve() / "harness_state.json")
            self.assertEqual(local_entry.scope, "local")
            self.assertEqual(global_entry.scope, "global")
            self.assertEqual(kwargs_entry.scope, "global")
            self.assertIsNotNone(HarnessState(local_dir / "harness_state.json").get("memory", "local_note"))
            self.assertIsNone(HarnessState(local_dir / "harness_state.json").get("memory", "global_note"))
            self.assertIsNotNone(HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "global_note"))
            self.assertIsNotNone(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "kwargs_global_note")
            )

    def test_global_kwarg_must_be_boolean(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(TypeError, "global must be a bool"):
                state.create_memory("Bad global flag", "bad", id="bad_global", **{"global": "false"})

    def test_state_cache_keeps_scope_distinct_when_local_and_global_share_a_file(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = temp_dir
            try:
                state = get_harness_state()
                global_state = get_harness_state(global_=True)
                local_entry = state.create_memory("Local note", "Only this session.", id="local_note")
                global_entry = state.create_memory("Global note", "All sessions.", id="global_note", global_=True)
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertIsNot(state, global_state)
            self.assertEqual(state.file_path, global_state.file_path)
            self.assertEqual(state.scope, "local")
            self.assertEqual(global_state.scope, "global")
            self.assertEqual(local_entry.scope, "local")
            self.assertEqual(global_entry.scope, "global")
            reloaded = HarnessState(Path(temp_dir) / "harness_state.json")
            self.assertEqual(reloaded.get("memory", "local_note").scope, "local")
            self.assertEqual(reloaded.get("memory", "global_note").scope, "global")

    def test_scope_prefixed_ids_route_to_the_displayed_scope(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = get_harness_state()
                state.create_memory("Global note", "v1", id="routed", global_=True)

                # The overview displays [global:routed]; that id must be usable as-is
                # and imply the global scope without passing global_.
                updated = state.update_memory("global:routed", "Global note", "v2")
                self.assertEqual(updated.scope, "global")
                self.assertEqual(state.get("memory", "global:routed").content, "v2")
                self.assertIsNone(state.get("memory", "routed"))

                state.create_memory("Local note", "local", id="local_note")
                self.assertEqual(state.get("memory", "local:local_note").content, "local")
                self.assertTrue(state.delete_memory("local:local_note"))
                self.assertIsNone(state.get("memory", "local_note"))
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "routed").content,
                "v2",
            )

    def test_create_with_prefixed_id_does_not_mint_literal_id(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = get_harness_state()
                entry = state.create_memory("Validation", "content", id="global:validation")
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(entry.id, "validation")
            self.assertEqual(entry.scope, "global")
            global_store = HarnessState(global_dir / "harness_state.json", scope="global")
            self.assertIsNotNone(global_store.get("memory", "validation"))
            self.assertIsNone(global_store.get("memory", "global:validation"))
            self.assertFalse((local_dir / "harness_state.json").exists())

    def test_module_harness_binds_lazily_to_env_set_after_import(self) -> None:
        # Forkserver scenario: rlm is imported in the template process without the
        # per-session env; the child applies env after fork. rlm.harness must then
        # resolve against the new env instead of a store frozen at import time.
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            try:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                os.environ.pop("RLM_SESSION_DIR", None)
                # Without local env, local writes fail loudly instead of vanishing.
                with self.assertRaisesRegex(RuntimeError, "global_=True"):
                    package_harness.create_memory("Volatile", "pre-env", id="pre_env")

                os.environ["RLM_HARNESS_STATE_DIR"] = temp_dir
                entry = package_harness.create_memory("Session note", "persisted", id="session_note")
                self.assertIsNone(package_harness.get("memory", "pre_env"))
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_session is None:
                    os.environ.pop("RLM_SESSION_DIR", None)
                else:
                    os.environ["RLM_SESSION_DIR"] = previous_session

            self.assertEqual(entry.scope, "local")
            reloaded = HarnessState(Path(temp_dir) / "harness_state.json")
            self.assertEqual(reloaded.get("memory", "session_note").content, "persisted")

    def test_module_harness_without_env_raises_on_local_writes_and_reads_work(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        try:
            os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            os.environ.pop("RLM_SESSION_DIR", None)

            for mutate in (
                lambda: package_harness.create_memory("Lost", "content", id="lost"),
                lambda: package_harness.update_memory("lost", "Lost", "content"),
                lambda: package_harness.delete_memory("lost"),
                lambda: package_harness.upsert("memory", "Lost", "content", id="lost"),
                lambda: package_harness.record_refinement("trigger", ["change"]),
            ):
                with self.assertRaisesRegex(RuntimeError, "Local harness state requires.*global_=True"):
                    mutate()

            # Reads keep working against an empty view.
            self.assertIsNone(package_harness.get("memory", "lost"))
            self.assertEqual(package_harness.list(), [])
            self.assertIn("memory: 0", package_harness.overview())
            self.assertEqual(package_harness.snapshot()["refinements"], [])
        finally:
            if previous_local is None:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
            else:
                os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
            if previous_session is None:
                os.environ.pop("RLM_SESSION_DIR", None)
            else:
                os.environ["RLM_SESSION_DIR"] = previous_session

    def test_module_harness_without_env_still_routes_global_writes(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            global_dir = Path(temp_dir) / "global"
            try:
                os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                os.environ.pop("RLM_SESSION_DIR", None)
                os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
                entry = package_harness.create_memory("Lesson", "keep me", id="no_session_lesson", global_=True)
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_session is None:
                    os.environ.pop("RLM_SESSION_DIR", None)
                else:
                    os.environ["RLM_SESSION_DIR"] = previous_session
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(entry.scope, "global")
            self.assertEqual(
                HarnessState(global_dir / "harness_state.json", scope="global").get("memory", "no_session_lesson").content,
                "keep me",
            )

    def test_import_rlm_without_env_does_not_raise(self) -> None:
        env = dict(os.environ)
        env.pop("RLM_HARNESS_STATE_DIR", None)
        env.pop("RLM_SESSION_DIR", None)
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
        result = subprocess.run(
            [sys.executable, "-c", "import rlm; repr(rlm.harness); rlm.harness.overview(); rlm.harness.create_memory"],
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_empty_local_state_dir_env_is_treated_as_unset(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_session = os.environ.get("RLM_SESSION_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            try:
                # Empty local dir must not fall through to the global agent-dir default.
                os.environ["RLM_HARNESS_STATE_DIR"] = ""
                os.environ.pop("RLM_SESSION_DIR", None)
                with self.assertRaisesRegex(RuntimeError, "Local harness state requires"):
                    HarnessState()

                # With a session dir it takes the session fallback instead.
                os.environ["RLM_SESSION_DIR"] = temp_dir
                state = HarnessState()
                self.assertEqual(state.file_path, Path(temp_dir).resolve() / "harness" / "harness_state.json")

                # A whitespace-only session dir is also unset.
                os.environ["RLM_SESSION_DIR"] = "   "
                with self.assertRaisesRegex(RuntimeError, "Local harness state requires"):
                    HarnessState()
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_session is None:
                    os.environ.pop("RLM_SESSION_DIR", None)
                else:
                    os.environ["RLM_SESSION_DIR"] = previous_session

    def test_explicit_dir_aliasing_env_local_dir_keeps_env_global_target(self) -> None:
        previous_local = os.environ.get("RLM_HARNESS_STATE_DIR")
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            local_dir = Path(temp_dir) / "local"
            env_global_dir = Path(temp_dir) / "env-global"
            os.environ["RLM_HARNESS_STATE_DIR"] = str(local_dir)
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(env_global_dir)
            try:
                # First construction happens via an explicit dir that merely aliases
                # the env local dir; global writes must still hit the env global dir.
                state = get_harness_state(local_dir)
                global_entry = state.create_memory("Aliased", "still global", id="alias_global", global_=True)
            finally:
                if previous_local is None:
                    os.environ.pop("RLM_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_HARNESS_STATE_DIR"] = previous_local
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual(global_entry.scope, "global")
            self.assertIsNotNone(
                HarnessState(env_global_dir / "harness_state.json", scope="global").get("memory", "alias_global")
            )
            self.assertIsNone(
                HarnessState(local_dir / "harness_state.json").get("memory", "alias_global")
            )

    def test_callable_rlm_exposes_harness_state_helpers(self) -> None:
        self.assertIs(callable_rlm.harness, package_harness)
        self.assertIs(callable_rlm.get_harness_state, get_harness_state)

    def test_record_refinement_accepts_single_change_string(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            event = state.record_refinement("manual cli test", "single change")

            self.assertEqual(event.changes, ["single change"])
            self.assertEqual(state.refinements[0].changes, ["single change"])

    def test_unknown_kind_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.upsert("tool", "Tool", "Tool content")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.get("tool", "tool")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.delete("tool", "tool")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.list("tool")
            with self.assertRaisesRegex(ValueError, "unknown harness kind"):
                state.recall("anything", kind="tool")


class ProgressLedgerTest(unittest.TestCase):
    def test_commit_creates_a_tagged_memory_entry_with_stable_id(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            entry = state.commit("Add failing test", "open", note="covers the regression")

            self.assertEqual(entry.kind, "memory")
            self.assertEqual(entry.id, "progress:add_failing_test")
            self.assertEqual(entry.title, "Add failing test")
            self.assertEqual(entry.content, "covers the regression")
            self.assertEqual(entry.path, "progress")
            self.assertEqual(entry.metadata["bpe"], "progress")
            self.assertEqual(entry.metadata["status"], "open")
            self.assertEqual(entry.metadata["order"], 0)
            self.assertIn("updated_turn", entry.metadata)
            # Same store surface as any other memory entry.
            self.assertIs(state.get("memory", "progress:add_failing_test"), entry)
            # Without a note the content is the status text.
            self.assertEqual(state.commit("Run the suite").content, "open")

    def test_commit_updates_status_in_place_and_preserves_order(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.commit("First", "open")
            state.commit("Second", "open", note="second note")
            state.commit("Third", "open")

            updated = state.commit("Second", "active")

            self.assertEqual(updated.id, "progress:second")
            self.assertEqual(updated.metadata["status"], "active")
            self.assertEqual(updated.metadata["order"], 1)
            self.assertEqual(updated.version, 2)
            # A status-only update keeps the earlier note.
            self.assertEqual(updated.content, "second note")
            self.assertEqual([entry.title for entry in state.progress()], ["First", "Second", "Third"])
            self.assertEqual(len(state.progress()), 3)

            state.commit("Second", "done")
            self.assertEqual([entry.title for entry in state.progress(include_done=False)], ["First", "Third"])
            # Persisted through the normal store; order survives reload.
            reloaded = HarnessState(state.file_path)
            self.assertEqual([entry.metadata["order"] for entry in reloaded.progress()], [0, 1, 2])

    def test_commit_rejects_invalid_status_and_empty_subgoal(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")

            with self.assertRaisesRegex(ValueError, "invalid progress status 'wip'"):
                state.commit("Something", "wip")
            with self.assertRaisesRegex(ValueError, "non-empty"):
                state.commit("   ")
            self.assertEqual(state.progress(), [])

    def test_commit_caps_non_done_subgoals_at_eight(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            for index in range(8):
                state.commit(f"Subgoal {index}", "open")

            with self.assertRaisesRegex(ValueError, "8 non-done subgoals.*mark one done first"):
                state.commit("Subgoal 8", "open")
            # Re-committing an existing non-done subgoal is not a new slot.
            state.commit("Subgoal 3", "blocked")
            # Adding a ninth directly as done is fine, and freeing a slot lets a new one in.
            state.commit("Subgoal 8", "done")
            state.commit("Subgoal 0", "done")
            state.commit("Subgoal 9", "active")

            self.assertEqual(len(state.progress()), 10)
            self.assertEqual(len(state.progress(include_done=False)), 8)

    def test_plan_renders_markers_in_ledger_order(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            self.assertEqual(
                state.plan(),
                "# PLAN\n(no subgoals committed yet; use rlm.harness.commit('<subgoal>', 'open'))",
            )

            state.commit("Reproduce", "done")
            state.commit("Fix parser", "active", note="edge case in tokenizer")
            state.commit("Add tests", "open")
            state.commit("Ship", "blocked", note="waiting on review")

            self.assertEqual(
                state.plan(),
                "\n".join(
                    [
                        "# PLAN (1/4 done)",
                        "[x] Reproduce",
                        "[>] Fix parser - edge case in tokenizer",
                        "[ ] Add tests",
                        "[!] Ship - waiting on review",
                    ]
                ),
            )

    def test_progress_entries_are_excluded_from_recall(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.commit("Fix tokenizer edge case", "active")
            lesson = state.create_memory("Tokenizer lesson", "tokenizer edge case needs a regression test", id="lesson")

            hits = state.recall("tokenizer edge case")

            self.assertEqual([entry.id for entry in hits], [lesson.id])


class RecallTest(unittest.TestCase):
    def test_recall_ranks_by_jaccard_and_respects_limit_and_kind(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("pytest venv", "use uv venv for pytest runs", id="pytest_venv")
            state.create_memory("npm build", "run npm install before npm build", id="npm_build")
            state.create_memory("uv basics", "uv venv creates the environment", id="uv_basics")
            state.create_prompt_note("Testing policy", "always run pytest before finishing", id="testing_policy")

            hits = state.recall("run pytest with uv venv")

            self.assertEqual(hits[0].id, "pytest_venv")
            self.assertEqual(len(hits), 3)
            self.assertNotIn("npm_build", [entry.id for entry in hits[:2]])
            self.assertEqual([entry.id for entry in state.recall("run pytest with uv venv", limit=1)], ["pytest_venv"])
            self.assertEqual(
                [entry.id for entry in state.recall("run pytest with uv venv", kind="prompt")], ["testing_policy"]
            )
            self.assertEqual(state.recall("run pytest", limit=0), [])

    def test_recall_increments_usage_count_and_persists(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("pytest venv", "use uv venv for pytest runs", id="pytest_venv", metadata={"scope": "local"})
            state.create_memory("npm build", "run npm install before npm build", id="npm_build")

            state.recall("pytest venv")
            state.recall("pytest venv")
            hit = state.recall("pytest venv")[0]

            self.assertEqual(hit.metadata["usage_count"], 3)
            # Existing metadata is kept; recall is bookkeeping, not an edit.
            self.assertEqual(hit.metadata["scope"], "local")
            self.assertEqual(hit.version, 1)
            self.assertNotIn("usage_count", state.get("memory", "npm_build").metadata)
            reloaded = HarnessState(state.file_path)
            self.assertEqual(reloaded.get("memory", "pytest_venv").metadata["usage_count"], 3)

    def test_recall_without_match_returns_empty_and_does_not_save(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = HarnessState(Path(temp_dir) / "harness_state.json")
            state.create_memory("pytest venv", "use uv venv for pytest runs", id="pytest_venv")
            before = state.file_path.stat().st_mtime_ns
            os.utime(state.file_path, ns=(before - 10_000_000_000, before - 10_000_000_000))
            state.load()
            stamped = state.file_path.stat().st_mtime_ns

            self.assertEqual(state.recall("completely unrelated words"), [])
            self.assertEqual(state.recall(""), [])
            self.assertEqual(state.recall("!!! ???"), [])

            self.assertEqual(state.file_path.stat().st_mtime_ns, stamped)
            self.assertNotIn("usage_count", state.get("memory", "pytest_venv").metadata)

    def test_recall_routes_global_flag_to_global_store(self) -> None:
        previous_global = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
        with tempfile.TemporaryDirectory() as temp_dir:
            global_dir = Path(temp_dir) / "global"
            os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = str(global_dir)
            try:
                state = HarnessState(Path(temp_dir) / "local" / "harness_state.json")
                state.create_memory("Global lesson", "always pin the toolchain", id="pin_toolchain", global_=True)
                hits = state.recall("pin the toolchain", global_=True)
            finally:
                if previous_global is None:
                    os.environ.pop("RLM_GLOBAL_HARNESS_STATE_DIR", None)
                else:
                    os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = previous_global

            self.assertEqual([entry.id for entry in hits], ["pin_toolchain"])
            self.assertEqual(hits[0].scope, "global")
            self.assertEqual(state.recall("pin the toolchain"), [])
            self.assertEqual(
                HarnessState(global_dir / "harness_state.json", scope="global")
                .get("memory", "pin_toolchain")
                .metadata["usage_count"],
                1,
            )


if __name__ == "__main__":
    unittest.main()
