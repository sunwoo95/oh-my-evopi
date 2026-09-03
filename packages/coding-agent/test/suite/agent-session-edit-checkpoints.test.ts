/**
 * NS-D4 edit checkpoints + /rewind, exercised offline against the faux
 * provider. A fake `ipython` tool stands in for the kernel: it snapshots the
 * before-image into the session's edit-checkpoint store exactly like the edit
 * skill does inside the kernel process, then rewrites the file.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@evopi/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@evopi/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	EDIT_CHECKPOINT_CUSTOM_ENTRY,
	EDIT_CHECKPOINT_DIR_ENV,
	EDIT_CHECKPOINT_MAX_FILE_BYTES_ENV,
	editCheckpointDirIn,
	readEditCheckpointIndex,
	recordEditCheckpoint,
} from "../../src/core/edit-checkpoints.js";
import {
	convertToLlm,
	EDIT_REWIND_NOTICE_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
} from "../../src/core/messages.js";
import type { Settings } from "../../src/core/settings-manager.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

/** Fake kernel: snapshot `path` into the store (if enabled), then write `content`. */
function createFakeIpythonTool(store: { dir?: string }): AgentTool {
	return {
		name: "ipython",
		label: "ipython",
		description: "fake kernel",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		execute: async (_toolCallId, params) => {
			const { path, content } = params as { path: string; content: string };
			if (store.dir) {
				recordEditCheckpoint(store.dir, {
					path,
					before: readFileSync(path),
					after: Buffer.from(content),
					source: "kernel",
					maxFileBytes: 4 * 1024 * 1024,
					startLine: 1,
					cellId: "cell-1",
				});
			}
			writeFileSync(path, content);
			return { content: [{ type: "text", text: `Edited ${path}` }], details: {} };
		},
	};
}

async function createRewindHarness(options: { settings?: Partial<Settings>; persistSession?: boolean } = {}) {
	const store: { dir?: string } = {};
	const harness = await createHarness({
		persistSession: options.persistSession ?? true,
		tools: [createFakeIpythonTool(store)],
		settings: options.settings,
	});
	harnesses.push(harness);
	const artifactDir = harness.sessionManager.getSessionArtifactDir();
	// Mirror the host: the kernel only gets a checkpoint dir when enabled + persistent.
	if (artifactDir && harness.settingsManager.getEditCheckpointSettings().enabled) {
		store.dir = editCheckpointDirIn(artifactDir);
	}
	const target = join(harness.tempDir, "target.txt");
	writeFileSync(target, "v1\n");
	return { harness, store, target };
}

async function editViaFakeKernel(harness: Harness, target: string, content: string, userText = "edit the file") {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("ipython", { path: target, content }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt(userText);
	expect(readFileSync(target, "utf-8")).toBe(content);
}

function checkpointEntries(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === EDIT_CHECKPOINT_CUSTOM_ENTRY);
}

function lastCommandResult(harness: Harness) {
	const results = harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
	);
	return results.at(-1);
}

function rewindNotices(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === EDIT_REWIND_NOTICE_CUSTOM_TYPE,
	);
}

function kernelEnv(harness: Harness): Record<string, string> {
	return (harness.session as unknown as { _rlmKernelEnv(): Record<string, string> })._rlmKernelEnv();
}

describe("edit checkpoints (NS-D4)", () => {
	it("hands the kernel the checkpoint dir only for enabled persistent sessions", async () => {
		const enabled = await createRewindHarness();
		const env = kernelEnv(enabled.harness);
		expect(env[EDIT_CHECKPOINT_DIR_ENV]).toBe(
			editCheckpointDirIn(enabled.harness.sessionManager.getSessionArtifactDir()!),
		);
		expect(env[EDIT_CHECKPOINT_MAX_FILE_BYTES_ENV]).toBe(String(4 * 1024 * 1024));

		const disabled = await createRewindHarness({ settings: { editCheckpoint: { enabled: false } } });
		expect(kernelEnv(disabled.harness)).not.toHaveProperty(EDIT_CHECKPOINT_DIR_ENV);
		expect(kernelEnv(disabled.harness)).not.toHaveProperty(EDIT_CHECKPOINT_MAX_FILE_BYTES_ENV);

		const inMemory = await createRewindHarness({ persistSession: false });
		expect(kernelEnv(inMemory.harness)).not.toHaveProperty(EDIT_CHECKPOINT_DIR_ENV);

		// Prompt/context surface stays byte-identical: no prompt text is added either way.
		const normalize = (harness: Harness) =>
			harness.session.agent.state.systemPrompt
				.replaceAll(harness.tempDir, "<cwd>")
				.replace(/sessions\/[0-9a-f-]+\.jsonl/g, "sessions/<id>.jsonl");
		expect(normalize(enabled.harness)).toBe(normalize(disabled.harness));
	});

	it("correlates kernel-written records with the ipython tool result and lists them by turn", async () => {
		const { harness, store, target } = await createRewindHarness();
		expect(store.dir).toBeDefined();

		await editViaFakeKernel(harness, target, "v2\n", "please edit the file");

		const entries = checkpointEntries(harness);
		expect(entries).toHaveLength(1);
		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(entries[0]).toMatchObject({
			type: "custom",
			data: {
				toolCallId: (toolResult as { toolCallId: string }).toolCallId,
				toolName: "ipython",
				records: [{ path: target, source: "kernel", kind: "edit" }],
			},
		});
		// Bookkeeping only: the model context is unchanged by the entry.
		expect(convertToLlm(harness.session.messages).map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);

		const items = harness.session.listEditCheckpoints();
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			index: 1,
			kind: "turn",
			turn: { ordinal: 1, preview: "please edit the file" },
			files: [{ path: target, edits: 1, sources: ["kernel"] }],
			pruned: false,
		});

		await harness.session.prompt("/rewind list");
		const listing = lastCommandResult(harness);
		expect(getMessageText(listing)).toContain("Edit checkpoints (1):");
		expect(getMessageText(listing)).toContain(target);
		// Session-command rows never reach the model.
		expect(convertToLlm(harness.session.messages).some((m) => getMessageText(m).includes("Edit checkpoints"))).toBe(
			false,
		);
	});

	it("/rewind <N> restores the file, records an undoable rewind and injects a model-visible notice", async () => {
		const { harness, target } = await createRewindHarness();
		await editViaFakeKernel(harness, target, "v2\n");
		await editViaFakeKernel(harness, target, "v3\n", "and again");
		expect(harness.session.listEditCheckpoints()).toHaveLength(2);

		await harness.session.prompt("/rewind 1");

		expect(readFileSync(target, "utf-8")).toBe("v1\n");
		const result = lastCommandResult(harness);
		expect(getMessageText(result)).toContain("Rewound 1 file to their state before turn 1");
		expect(getMessageText(result)).toContain(`restored ${target}`);
		expect(getMessageText(result)).toContain("kernel namespace untouched");
		expect((result as { details: { success: boolean } }).details.success).toBe(true);

		const notices = rewindNotices(harness);
		expect(notices).toHaveLength(1);
		expect(getMessageText(notices[0])).toContain("<edit_rewind_notice>");
		expect(getMessageText(notices[0])).toContain(target);
		expect(notices[0]).toMatchObject({ display: true, details: { restored: [target], withConversation: false } });
		// The notice is in the model's context (converted to a user message)...
		const llm = convertToLlm(harness.session.messages);
		expect(llm.at(-1)?.role).toBe("user");
		expect(getMessageText(llm.at(-1))).toContain("<edit_rewind_notice>");
		// ...and persisted, so a resume sees it too.
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom_message" && entry.customType === EDIT_REWIND_NOTICE_CUSTOM_TYPE),
		).toBe(true);

		// The rewind is itself a checkpoint: listed, and undoable by rewinding to it.
		const items = harness.session.listEditCheckpoints();
		expect(items.map((item) => item.kind)).toEqual(["turn", "turn", "rewind"]);
		const dir = editCheckpointDirIn(harness.sessionManager.getSessionArtifactDir()!);
		expect(readEditCheckpointIndex(dir).at(-1)).toMatchObject({ kind: "rewind", source: "rewind", path: target });
		await harness.session.prompt("/rewind 3");
		expect(readFileSync(target, "utf-8")).toBe("v3\n");
	});

	it("refuses drifted files without --force and overwrites them with it", async () => {
		const { harness, target } = await createRewindHarness();
		await editViaFakeKernel(harness, target, "v2\n");
		writeFileSync(target, "changed by hand\n");

		await harness.session.prompt("/rewind 1");
		const refused = lastCommandResult(harness);
		expect(getMessageText(refused)).toContain("Refusing to rewind");
		expect(getMessageText(refused)).toContain("--force");
		expect((refused as { details: { success: boolean } }).details.success).toBe(false);
		expect(readFileSync(target, "utf-8")).toBe("changed by hand\n");
		expect(rewindNotices(harness)).toHaveLength(0);

		await harness.session.prompt("/rewind 1 --force");
		expect(readFileSync(target, "utf-8")).toBe("v1\n");
		expect(rewindNotices(harness)).toHaveLength(1);
	});

	it("/rewind --with-conversation moves the leaf to before that turn after restoring files", async () => {
		const { harness, target } = await createRewindHarness();
		await editViaFakeKernel(harness, target, "v2\n", "first turn");
		await editViaFakeKernel(harness, target, "v3\n", "second turn");
		const userTexts = () =>
			harness.session.messages
				.filter((message) => message.role === "user")
				.map((message) => getMessageText(message));
		expect(userTexts()).toEqual(["first turn", "second turn"]);

		await harness.session.prompt("/rewind 2 --with-conversation");

		expect(readFileSync(target, "utf-8")).toBe("v2\n");
		expect(userTexts()).toEqual(["first turn"]);
		const result = lastCommandResult(harness);
		expect(getMessageText(result)).toContain("Conversation moved to before that turn");
		expect(rewindNotices(harness)).toHaveLength(1);
		expect(rewindNotices(harness)[0]).toMatchObject({ details: { withConversation: true } });
		// The second turn's entry is off the branch now, so its (still restorable)
		// record surfaces as untracked; the rewind itself is on the new branch.
		expect(harness.session.listEditCheckpoints().map((item) => item.kind)).toEqual(["turn", "untracked", "rewind"]);
	});

	it("reports usage errors and disabled/non-persistent sessions as command failures", async () => {
		const disabled = await createRewindHarness({ settings: { editCheckpoint: { enabled: false } } });
		await editViaFakeKernel(disabled.harness, disabled.target, "v2\n");
		expect(checkpointEntries(disabled.harness)).toHaveLength(0);
		expect(existsSync(editCheckpointDirIn(disabled.harness.sessionManager.getSessionArtifactDir()!))).toBe(false);
		await disabled.harness.session.prompt("/rewind list");
		expect(getMessageText(lastCommandResult(disabled.harness))).toContain("Edit checkpoints are disabled");

		const inMemory = await createRewindHarness({ persistSession: false });
		await inMemory.harness.session.prompt("/rewind 1");
		expect(getMessageText(lastCommandResult(inMemory.harness))).toContain("persistent session");

		const enabled = await createRewindHarness();
		await enabled.harness.session.prompt("/rewind --bogus");
		expect(getMessageText(lastCommandResult(enabled.harness))).toContain("Unknown option --bogus");
		await enabled.harness.session.prompt("/rewind 1");
		expect(getMessageText(lastCommandResult(enabled.harness))).toContain("No edit checkpoints in this session");
	});
});
