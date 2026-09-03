import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyRewind,
	buildEditCheckpointEntryData,
	EDIT_CHECKPOINT_CUSTOM_ENTRY,
	type EditCheckpointBranchEntry,
	type EditCheckpointRecord,
	editCheckpointBlobPath,
	editCheckpointDirIn,
	editCheckpointIndexPath,
	editCheckpointIndexSize,
	formatEditCheckpointLabel,
	formatEditCheckpointList,
	listEditCheckpoints,
	newEditCheckpointSeq,
	parseEditCheckpointRecord,
	planRewind,
	pruneEditCheckpoints,
	readEditCheckpointIndex,
	readEditCheckpointIndexFrom,
	recordEditCheckpoint,
	resolveEditCheckpointTarget,
	sha256Hex,
} from "../src/core/edit-checkpoints.js";

const MAX = 4 * 1024 * 1024;

let root = "";
let dir = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "evopi-edit-checkpoints-"));
	dir = editCheckpointDirIn(join(root, "artifacts"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function file(name: string, content: string): string {
	const path = join(root, name);
	mkdirSync(join(root), { recursive: true });
	writeFileSync(path, content);
	return path;
}

/** Simulate the kernel edit skill: snapshot `before`, then write `after`. */
function kernelEdit(path: string, after: string, extra: Partial<Parameters<typeof recordEditCheckpoint>[1]> = {}) {
	const before = readFileSync(path);
	const record = recordEditCheckpoint(dir, {
		path,
		before,
		after: Buffer.from(after),
		source: "kernel",
		maxFileBytes: MAX,
		...extra,
	});
	writeFileSync(path, after);
	return record;
}

describe("edit checkpoint paths and seqs", () => {
	it("places the store inside the session artifact directory", () => {
		const artifactDir = "/home/u/.evopi/agent/session-artifacts/abc-123";
		expect(editCheckpointDirIn(artifactDir)).toBe(join(artifactDir, "edit-checkpoints"));
		expect(editCheckpointIndexPath(editCheckpointDirIn(artifactDir))).toBe(
			join(artifactDir, "edit-checkpoints", "index.jsonl"),
		);
		expect(editCheckpointBlobPath(editCheckpointDirIn(artifactDir), "ab")).toBe(
			join(artifactDir, "edit-checkpoints", "blobs", "ab"),
		);
	});

	it("mints Python-compatible, time-ordered seqs", () => {
		const a = newEditCheckpointSeq(1_000);
		const b = newEditCheckpointSeq(2_000);
		expect(a).toMatch(/^\d{20}-[0-9a-f]{8}$/);
		expect(a < b).toBe(true);
	});
});

describe("index parsing", () => {
	it("parses the Python writer's snake_case records and ignores unknown keys / garbage", () => {
		const line = JSON.stringify({
			v: 1,
			seq: "00000000000000000001-abcdef01",
			ts: "2026-09-03T00:00:00.000+00:00",
			kind: "edit",
			source: "shell",
			path: "/tmp/a.py",
			before_sha256: "aa",
			before_bytes: 12,
			after_sha256: "bb",
			start_line: 3,
			cell_id: null,
			future_field: true,
		});
		expect(parseEditCheckpointRecord(line)).toEqual({
			v: 1,
			seq: "00000000000000000001-abcdef01",
			ts: "2026-09-03T00:00:00.000+00:00",
			kind: "edit",
			source: "shell",
			path: "/tmp/a.py",
			beforeSha256: "aa",
			beforeBytes: 12,
			afterSha256: "bb",
			startLine: 3,
			cellId: null,
		});
		expect(parseEditCheckpointRecord("not json")).toBeUndefined();
		expect(parseEditCheckpointRecord('{"seq":"x"}')).toBeUndefined();
		expect(parseEditCheckpointRecord('{"seq":"x","path":"/p","skipped":"oversized"}')).toMatchObject({
			skipped: "oversized",
			beforeSha256: null,
			source: "kernel",
			kind: "edit",
		});
	});

	it("reads an absent index as empty and skips malformed lines", () => {
		expect(readEditCheckpointIndex(dir)).toEqual([]);
		expect(editCheckpointIndexSize(dir)).toBe(0);
		mkdirSync(dir, { recursive: true });
		writeFileSync(editCheckpointIndexPath(dir), 'garbage\n{"seq":"s1","path":"/p","after_sha256":"x"}\n\n');
		expect(readEditCheckpointIndex(dir).map((record) => record.seq)).toEqual(["s1"]);
	});

	it("reads incrementally from a byte cursor and only consumes complete lines", () => {
		const target = file("a.txt", "one");
		const first = kernelEdit(target, "two");
		const afterFirst = editCheckpointIndexSize(dir);
		const second = kernelEdit(target, "three");
		let cursor = readEditCheckpointIndexFrom(dir, 0);
		expect(cursor.records.map((record) => record.seq)).toEqual([first.seq, second.seq]);
		expect(cursor.nextOffset).toBe(editCheckpointIndexSize(dir));
		cursor = readEditCheckpointIndexFrom(dir, afterFirst);
		expect(cursor.records.map((record) => record.seq)).toEqual([second.seq]);
		// A writer mid-append: the partial tail is left for the next call.
		const partial = '{"seq":"s3","path":"/p"';
		writeFileSync(editCheckpointIndexPath(dir), partial, { flag: "a" });
		const tail = readEditCheckpointIndexFrom(dir, cursor.nextOffset);
		expect(tail.records).toEqual([]);
		expect(tail.nextOffset).toBe(cursor.nextOffset);
		// A rewritten (shrunken) index resets the cursor instead of reading past EOF.
		writeFileSync(editCheckpointIndexPath(dir), "");
		expect(readEditCheckpointIndexFrom(dir, 10_000)).toEqual({ records: [], nextOffset: 0 });
	});
});

describe("recording", () => {
	it("stores content-addressed blobs, dedupes identical before-images and records oversized files as skipped", () => {
		const target = file("a.txt", "same");
		const first = kernelEdit(target, "changed");
		writeFileSync(target, "same");
		const second = kernelEdit(target, "changed-again");
		expect(first.beforeSha256).toBe(sha256Hex("same"));
		expect(second.beforeSha256).toBe(first.beforeSha256);
		expect(readdirSync(join(dir, "blobs"))).toEqual([first.beforeSha256]);
		expect(readFileSync(editCheckpointBlobPath(dir, first.beforeSha256!), "utf-8")).toBe("same");
		expect(first.afterSha256).toBe(sha256Hex("changed"));

		const big = kernelEdit(target, "x", { maxFileBytes: 2 });
		expect(big.skipped).toBe("oversized");
		expect(big.beforeSha256).toBeNull();
		expect(big.beforeBytes).toBe("changed-again".length);
		expect(readdirSync(join(dir, "blobs"))).toEqual([first.beforeSha256]);

		const records = readEditCheckpointIndex(dir);
		expect(records.map((record) => record.seq)).toEqual([first.seq, second.seq, big.seq]);
		expect(records[2]).toMatchObject({ skipped: "oversized", kind: "edit", source: "kernel" });
	});

	it("round-trips create/delete records (beforeMissing / null after)", () => {
		const created = recordEditCheckpoint(dir, {
			path: join(root, "new.txt"),
			before: null,
			after: Buffer.from("fresh"),
			source: "hashline",
			maxFileBytes: MAX,
			cellId: "call-1",
		});
		const removed = recordEditCheckpoint(dir, {
			path: join(root, "gone.txt"),
			before: Buffer.from("bye"),
			after: null,
			source: "hashline",
			maxFileBytes: MAX,
		});
		const [a, b] = readEditCheckpointIndex(dir);
		expect(a).toMatchObject({ seq: created.seq, beforeMissing: true, beforeSha256: null, cellId: "call-1" });
		expect(b).toMatchObject({ seq: removed.seq, afterSha256: null, beforeSha256: sha256Hex("bye") });
	});
});

describe("planRewind", () => {
	it("restores the earliest before-image at/after the target per path and detects drift", () => {
		const a = file("a.txt", "a0");
		const b = file("b.txt", "b0");
		const a1 = kernelEdit(a, "a1");
		const b1 = kernelEdit(b, "b1");
		const a2 = kernelEdit(a, "a2");
		const records = readEditCheckpointIndex(dir);

		const fromA1 = planRewind(dir, records, a1.seq);
		expect(fromA1.files.map((f) => [f.path, f.record.seq, f.drift, f.unchanged, f.restorable])).toEqual([
			[a, a1.seq, false, false, true],
			[b, b1.seq, false, false, true],
		]);
		// A hand-revert to the before-image is "unchanged": drifted, but never blocks.
		writeFileSync(b, "b0");
		expect(planRewind(dir, records, a1.seq).files.find((f) => f.path === b)).toMatchObject({
			drift: true,
			unchanged: true,
		});
		writeFileSync(b, "b1");
		expect(fromA1.files[0].expectedSha256).toBe(a2.afterSha256);

		const fromA2 = planRewind(dir, records, a2.seq);
		expect(fromA2.files.map((f) => f.path)).toEqual([a]);
		expect(fromA2.files[0].record.seq).toBe(a2.seq);

		writeFileSync(a, "edited by hand");
		const drifted = planRewind(dir, records, a1.seq);
		expect(drifted.files.find((f) => f.path === a)?.drift).toBe(true);
		expect(drifted.files.find((f) => f.path === b)?.drift).toBe(false);

		expect(() => planRewind(dir, records, "nope")).toThrow(/not in this session's edit-checkpoint index/);
	});

	it("marks oversized and blob-less records as unrestorable", () => {
		const a = file("a.txt", "a0");
		const big = kernelEdit(a, "a1", { maxFileBytes: 1 });
		const b = file("b.txt", "b0");
		const gone = kernelEdit(b, "b1");
		rmSync(editCheckpointBlobPath(dir, gone.beforeSha256!));
		const plan = planRewind(dir, readEditCheckpointIndex(dir), big.seq);
		expect(plan.files.map((f) => [f.path, f.restorable, f.unrestorableReason])).toEqual([
			[a, false, "oversized"],
			[b, false, "blob-missing"],
		]);
	});
});

describe("applyRewind", () => {
	it("restores files atomically, appends undoable rewind records and refuses drift without force", () => {
		const a = file("a.txt", "a0");
		const b = file("b.txt", "b0");
		const a1 = kernelEdit(a, "a1");
		kernelEdit(b, "b1");
		writeFileSync(b, "b-external");
		let records = readEditCheckpointIndex(dir);

		const refused = applyRewind(dir, planRewind(dir, records, a1.seq), { maxFileBytes: MAX });
		expect(refused.restored).toEqual([a]);
		expect(refused.skipped).toEqual([{ path: b, reason: "drift" }]);
		expect(readFileSync(a, "utf-8")).toBe("a0");
		expect(readFileSync(b, "utf-8")).toBe("b-external");
		expect(refused.rewindRecords).toHaveLength(1);
		expect(refused.rewindRecords[0]).toMatchObject({
			kind: "rewind",
			source: "rewind",
			path: a,
			rewindOf: a1.seq,
			beforeSha256: sha256Hex("a1"),
			afterSha256: sha256Hex("a0"),
		});
		expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);

		records = readEditCheckpointIndex(dir);
		const forced = applyRewind(dir, planRewind(dir, records, a1.seq), { force: true, maxFileBytes: MAX });
		expect(forced.restored).toEqual([b]);
		expect(readFileSync(b, "utf-8")).toBe("b0");
		// `a` is already at its target state: left alone, no extra rewind record.
		expect(forced.unchanged).toEqual([a]);
		expect(forced.rewindRecords.map((record) => record.path)).toEqual([b]);
		expect(readFileSync(a, "utf-8")).toBe("a0");

		// Undo the first rewind by rewinding to before its own record.
		records = readEditCheckpointIndex(dir);
		const undo = applyRewind(dir, planRewind(dir, records, refused.rewindRecords[0].seq), { maxFileBytes: MAX });
		expect(undo.restored).toContain(a);
		expect(readFileSync(a, "utf-8")).toBe("a1");
	});

	it("removes files that did not exist before the checkpoint and reports unrestorable ones", () => {
		const created = join(root, "created.txt");
		recordEditCheckpoint(dir, {
			path: created,
			before: null,
			after: Buffer.from("new"),
			source: "hashline",
			maxFileBytes: MAX,
		});
		writeFileSync(created, "new");
		const big = file("big.txt", "b0");
		const bigRecord = kernelEdit(big, "b1", { maxFileBytes: 1 });
		const records = readEditCheckpointIndex(dir);
		const result = applyRewind(dir, planRewind(dir, records, records[0].seq), { maxFileBytes: MAX });
		expect(result.removed).toEqual([created]);
		expect(existsSync(created)).toBe(false);
		expect(result.skipped).toEqual([{ path: big, reason: "oversized" }]);
		expect(readFileSync(big, "utf-8")).toBe("b1");
		expect(bigRecord.skipped).toBe("oversized");
	});
});

describe("pruneEditCheckpoints", () => {
	it("drops the oldest records past the count cap and garbage-collects unreferenced blobs", () => {
		const a = file("a.txt", "v0");
		for (let i = 1; i <= 5; i++) kernelEdit(a, `v${i}`);
		expect(readdirSync(join(dir, "blobs"))).toHaveLength(5);
		const result = pruneEditCheckpoints(dir, { maxRecords: 2, maxTotalBytes: MAX });
		expect(result).toEqual({ droppedRecords: 3, removedBlobs: 3 });
		const kept = readEditCheckpointIndex(dir);
		expect(kept.map((record) => record.beforeSha256)).toEqual([sha256Hex("v3"), sha256Hex("v4")]);
		expect(readdirSync(join(dir, "blobs")).sort()).toEqual([sha256Hex("v3"), sha256Hex("v4")].sort());
		expect(pruneEditCheckpoints(dir, { maxRecords: 2, maxTotalBytes: MAX })).toEqual({
			droppedRecords: 0,
			removedBlobs: 0,
		});
	});

	it("prunes by total unique blob bytes, keeping at least the newest record", () => {
		const a = file("a.txt", "aaaaaaaaaa"); // 10 bytes
		kernelEdit(a, "bbbbbbbbbb");
		kernelEdit(a, "cccccccccc");
		kernelEdit(a, "dddddddddd");
		const result = pruneEditCheckpoints(dir, { maxRecords: 200, maxTotalBytes: 15 });
		expect(result.droppedRecords).toBe(2);
		expect(readEditCheckpointIndex(dir).map((record) => record.beforeSha256)).toEqual([sha256Hex("cccccccccc")]);
		// Even a single over-cap record survives (the newest state is never dropped).
		expect(pruneEditCheckpoints(dir, { maxRecords: 200, maxTotalBytes: 1 })).toEqual({
			droppedRecords: 0,
			removedBlobs: 0,
		});
	});
});

function userEntry(id: string, text: string): EditCheckpointBranchEntry {
	return { id, type: "message", timestamp: "2026-09-03T00:00:00.000Z", message: { role: "user", content: text } };
}

function checkpointEntry(id: string, toolCallId: string, records: EditCheckpointRecord[], toolName = "ipython") {
	return {
		id,
		type: "custom",
		timestamp: "2026-09-03T00:00:01.000Z",
		customType: EDIT_CHECKPOINT_CUSTOM_ENTRY,
		data: buildEditCheckpointEntryData(toolCallId, toolName, records),
	} satisfies EditCheckpointBranchEntry;
}

describe("listEditCheckpoints", () => {
	it("groups branch entries by user turn, lists rewinds alone and unions orphaned index records", () => {
		const a = file("a.txt", "a0");
		const b = file("b.txt", "b0");
		const a1 = kernelEdit(a, "a1");
		const a2 = kernelEdit(a, "a2");
		const b1 = kernelEdit(b, "b1", { source: "shell" });
		const orphan = kernelEdit(b, "b2", { source: "shell" });
		const rewind = recordEditCheckpoint(dir, {
			path: a,
			before: Buffer.from("a2"),
			after: Buffer.from("a0"),
			source: "rewind",
			kind: "rewind",
			maxFileBytes: MAX,
			rewindOf: a1.seq,
		});
		const records = readEditCheckpointIndex(dir);
		const branch: EditCheckpointBranchEntry[] = [
			userEntry("u1", "  fix the   parser  please "),
			checkpointEntry("c1", "call-1", [a1]),
			checkpointEntry("c2", "call-2", [a2, b1]),
			{ id: "x", type: "custom", timestamp: "", customType: "something_else", data: { records: [] } },
			userEntry("u2", "second turn"),
			checkpointEntry("c3", "rewind:1", [rewind], "rewind"),
		];
		const items = listEditCheckpoints(branch, records);
		expect(items.map((item) => [item.index, item.kind, item.seq, item.pruned])).toEqual([
			[1, "turn", a1.seq, false],
			[2, "shell", orphan.seq, false],
			[3, "rewind", rewind.seq, false],
		]);
		expect(items[0].turn).toEqual({ entryId: "u1", ordinal: 1, preview: "fix the parser please" });
		expect(items[0].toolCallIds).toEqual(["call-1", "call-2"]);
		expect(items[0].files).toEqual([
			{ path: a, edits: 2, sources: ["kernel"] },
			{ path: b, edits: 1, sources: ["shell"] },
		]);
		expect(items[2].turn?.ordinal).toBe(2);
		expect(formatEditCheckpointLabel(items[0])).toBe('1. turn 1 "fix the parser please" · 2 files');
		expect(formatEditCheckpointLabel(items[1])).toBe("2. (shell) · 1 file");
		expect(formatEditCheckpointLabel(items[2])).toBe('3. rewind turn 2 "second turn" · 1 file');
		const listing = formatEditCheckpointList(items);
		expect(listing).toContain("Edit checkpoints (3):");
		expect(listing).toContain(`      ${a} (2 edits)`);
		expect(listing).toContain(`      ${b} (shell)`);
		expect(formatEditCheckpointList([])).toContain("No edit checkpoints");
	});

	it("flags groups whose records were pruned and treats an unavailable index as unknown", () => {
		const a = file("a.txt", "a0");
		const a1 = kernelEdit(a, "a1");
		const branch = [userEntry("u1", "hi"), checkpointEntry("c1", "call-1", [a1])];
		expect(listEditCheckpoints(branch, [])[0].pruned).toBe(true);
		expect(listEditCheckpoints(branch, undefined)[0]).toMatchObject({ pruned: false, seq: a1.seq, kind: "turn" });
		expect(formatEditCheckpointLabel(listEditCheckpoints(branch, [])[0])).toContain("(pruned)");
	});

	it("resolves targets by listing position or seq with actionable errors", () => {
		const a = file("a.txt", "a0");
		const a1 = kernelEdit(a, "a1");
		const a2 = kernelEdit(a, "a2");
		const records = readEditCheckpointIndex(dir);
		const items = listEditCheckpoints([userEntry("u1", "hi"), checkpointEntry("c1", "call-1", [a1, a2])], records);
		expect(resolveEditCheckpointTarget(items, records, "1")).toEqual({ seq: a1.seq, item: items[0] });
		expect(resolveEditCheckpointTarget(items, records, ` ${a2.seq} `)).toEqual({ seq: a2.seq, item: undefined });
		expect(() => resolveEditCheckpointTarget(items, records, "2")).toThrow(/out of range \(1-1\)/);
		expect(() => resolveEditCheckpointTarget([], records, "1")).toThrow(/No edit checkpoints/);
		expect(() => resolveEditCheckpointTarget(items, records, "bogus")).toThrow(/Unknown checkpoint "bogus"/);
		const pruned = listEditCheckpoints([userEntry("u1", "hi"), checkpointEntry("c1", "call-1", [a1])], []);
		expect(() => resolveEditCheckpointTarget(pruned, [], "1")).toThrow(/pruned by retention/);
	});
});
