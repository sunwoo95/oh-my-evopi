import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	editCheckpointBlobPath,
	editCheckpointDirIn,
	readEditCheckpointIndex,
	sha256Hex,
} from "../src/core/edit-checkpoints.js";
import { createHashlineEditTool } from "../src/core/tools/hashline-edit.js";

let cwd = "";
let dir = "";

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "evopi-hashline-checkpoint-"));
	dir = editCheckpointDirIn(join(cwd, ".artifacts"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

const ORIGINAL = "one\ntwo\nthree\n";

describe("hashline_edit checkpoints (NS-D4)", () => {
	it("snapshots the before-image before applying and records the after-sha", async () => {
		const target = join(cwd, "a.txt");
		writeFileSync(target, ORIGINAL);
		const tool = createHashlineEditTool(cwd, { checkpointDir: () => dir });

		const result = await tool.execute("call-7", { patch: "[a.txt#0000]\nPUT 2.=2:\n+TWO" });

		expect(readFileSync(target, "utf-8")).toBe("one\nTWO\nthree\n");
		expect(result.details?.sections[0]).toMatchObject({ op: "update" });
		const records = readEditCheckpointIndex(dir);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			kind: "edit",
			source: "hashline",
			path: target,
			cellId: "call-7",
			beforeSha256: sha256Hex(ORIGINAL),
			beforeBytes: ORIGINAL.length,
			afterSha256: sha256Hex("one\nTWO\nthree\n"),
		});
		expect(readFileSync(editCheckpointBlobPath(dir, records[0].beforeSha256!), "utf-8")).toBe(ORIGINAL);
	});

	it("records deletions with a null after-sha and skips no-op sections", async () => {
		const target = join(cwd, "gone.txt");
		writeFileSync(target, ORIGINAL);
		const tool = createHashlineEditTool(cwd, { checkpointDir: () => dir });

		await tool.execute("call-8", { patch: "[gone.txt#0000]\nREM" });

		expect(existsSync(target)).toBe(false);
		const [record] = readEditCheckpointIndex(dir);
		expect(record).toMatchObject({ path: target, afterSha256: null, beforeSha256: sha256Hex(ORIGINAL) });
	});

	it("is byte-identical when no checkpoint dir is configured", async () => {
		const target = join(cwd, "a.txt");
		writeFileSync(target, ORIGINAL);
		const plain = createHashlineEditTool(cwd);
		const off = createHashlineEditTool(cwd, { checkpointDir: () => undefined });

		const first = await plain.execute("call-1", { patch: "[a.txt#0000]\nPUT 2.=2:\n+TWO" });
		writeFileSync(target, ORIGINAL);
		const second = await off.execute("call-2", { patch: "[a.txt#0000]\nPUT 2.=2:\n+TWO" });

		expect(second).toEqual(first);
		expect(existsSync(dir)).toBe(false);
	});

	it("never fails the edit when the checkpoint dir is unwritable", async () => {
		const target = join(cwd, "a.txt");
		writeFileSync(target, ORIGINAL);
		const blocker = join(cwd, "blocked");
		writeFileSync(blocker, "not a directory");
		const tool = createHashlineEditTool(cwd, { checkpointDir: () => join(blocker, "edit-checkpoints") });

		const result = await tool.execute("call-9", { patch: "[a.txt#0000]\nPUT 2.=2:\n+TWO" });

		expect(readFileSync(target, "utf-8")).toBe("one\nTWO\nthree\n");
		expect(result.details?.sections[0]).toMatchObject({ op: "update" });
	});
});
