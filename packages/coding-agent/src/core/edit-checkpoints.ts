/**
 * Edit checkpoints (NS-D4) — file before-images for `/rewind`.
 *
 * Producers:
 * - the kernel `edit` skill captures the before-image *inside the kernel
 *   process* right before `write_text` (skills/edit/src/edit/__init__.py); the
 *   host only learns about an edit from a display event processed after the
 *   file is already rewritten, so it cannot snapshot itself. The `!edit --path`
 *   shell form runs in a bash subprocess with the same env and is captured too
 *   (`source: "shell"`).
 * - the host-side `hashline_edit` tool snapshots before the Patcher applies.
 * - `/rewind` itself appends `kind: "rewind"` records so a rewind is undoable.
 *
 * Layout under `<session artifact dir>/edit-checkpoints/`:
 *
 *   index.jsonl      one JSON record per edit, appended in chronological order
 *   blobs/<sha256>   content-addressed before-images (deduplicated)
 *
 * The on-disk record uses snake_case keys (the Python writer's shape); this
 * module parses tolerantly and writes the same shape. Everything here is pure
 * `node:fs` and unit-testable without a kernel. Retention: oldest-first prune
 * by record count and total unique blob bytes; the whole directory disappears
 * with the session (session-file-actions.ts deletes the artifact dir).
 */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const EDIT_CHECKPOINT_DIRNAME = "edit-checkpoints";
/** Env var the host sets on the kernel (only when enabled for a persistent session). */
export const EDIT_CHECKPOINT_DIR_ENV = "EVOPI_EDIT_CHECKPOINT_DIR";
export const EDIT_CHECKPOINT_MAX_FILE_BYTES_ENV = "EVOPI_EDIT_CHECKPOINT_MAX_FILE_BYTES";
/** Session `custom` entry (bookkeeping only; never reaches the model) correlating records with a tool call. */
export const EDIT_CHECKPOINT_CUSTOM_ENTRY = "edit_checkpoint";

const INDEX_BASENAME = "index.jsonl";
const BLOBS_DIRNAME = "blobs";

export type EditCheckpointSource = "kernel" | "shell" | "hashline" | "rewind";

export interface EditCheckpointRecord {
	v: 1;
	/** Unique, time-ordered id (`<ns-timestamp>-<hex>`). The `/rewind <seq>` target. */
	seq: string;
	ts: string;
	kind: "edit" | "rewind";
	source: EditCheckpointSource;
	/** Real path of the edited file. */
	path: string;
	/** sha256 of the before-image blob; null when skipped (oversized) or the file did not exist. */
	beforeSha256: string | null;
	beforeBytes: number;
	/** The file did not exist before this edit (hashline create); rewinding removes it. */
	beforeMissing?: boolean;
	/** sha256 of the file bytes right after the edit; null when the edit removed the file. */
	afterSha256: string | null;
	startLine?: number;
	cellId?: string | null;
	skipped?: "oversized";
	/** `kind: "rewind"` — the checkpoint seq this rewind restored to. */
	rewindOf?: string;
}

export interface EditCheckpointRetention {
	maxRecords: number;
	maxTotalBytes: number;
}

export function editCheckpointDirIn(artifactDir: string): string {
	return join(artifactDir, EDIT_CHECKPOINT_DIRNAME);
}

export function editCheckpointIndexPath(dir: string): string {
	return join(dir, INDEX_BASENAME);
}

export function editCheckpointBlobPath(dir: string, sha256: string): string {
	return join(dir, BLOBS_DIRNAME, sha256);
}

export function sha256Hex(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Same shape as the Python writer: zero-padded nanosecond wall clock + random suffix. */
export function newEditCheckpointSeq(now = Date.now()): string {
	const ns = (BigInt(now) * 1_000_000n).toString().padStart(20, "0");
	return `${ns}-${randomBytes(4).toString("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Parse one index line; tolerant of unknown keys, undefined for malformed lines. */
export function parseEditCheckpointRecord(line: string): EditCheckpointRecord | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(raw)) return undefined;
	const seq = optionalString(raw.seq);
	const path = optionalString(raw.path);
	if (!seq || !path) return undefined;
	const kind = raw.kind === "rewind" ? "rewind" : "edit";
	const source: EditCheckpointSource =
		raw.source === "shell" || raw.source === "hashline" || raw.source === "rewind" ? raw.source : "kernel";
	const beforeSha = optionalString(raw.before_sha256) ?? optionalString(raw.beforeSha256) ?? null;
	const afterSha = optionalString(raw.after_sha256) ?? optionalString(raw.afterSha256) ?? null;
	const beforeBytes = raw.before_bytes ?? raw.beforeBytes;
	const startLine = raw.start_line ?? raw.startLine;
	const cellId = "cell_id" in raw ? raw.cell_id : raw.cellId;
	const record: EditCheckpointRecord = {
		v: 1,
		seq,
		ts: optionalString(raw.ts) ?? "",
		kind,
		source,
		path,
		beforeSha256: beforeSha,
		beforeBytes: typeof beforeBytes === "number" && Number.isFinite(beforeBytes) ? beforeBytes : 0,
		afterSha256: afterSha,
	};
	if (raw.before_missing === true || raw.beforeMissing === true) record.beforeMissing = true;
	if (typeof startLine === "number") record.startLine = startLine;
	if (typeof cellId === "string" || cellId === null) record.cellId = cellId;
	if (raw.skipped === "oversized") record.skipped = "oversized";
	const rewindOf = optionalString(raw.rewind_of) ?? optionalString(raw.rewindOf);
	if (rewindOf) record.rewindOf = rewindOf;
	return record;
}

function serializeRecord(record: EditCheckpointRecord): string {
	const raw: Record<string, unknown> = {
		v: 1,
		seq: record.seq,
		ts: record.ts,
		kind: record.kind,
		source: record.source,
		path: record.path,
		before_sha256: record.beforeSha256,
		before_bytes: record.beforeBytes,
		after_sha256: record.afterSha256,
	};
	if (record.beforeMissing) raw.before_missing = true;
	if (record.startLine !== undefined) raw.start_line = record.startLine;
	if (record.cellId !== undefined) raw.cell_id = record.cellId;
	if (record.skipped) raw.skipped = record.skipped;
	if (record.rewindOf) raw.rewind_of = record.rewindOf;
	return `${JSON.stringify(raw)}\n`;
}

function parseIndexText(text: string): EditCheckpointRecord[] {
	const records: EditCheckpointRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const record = parseEditCheckpointRecord(line);
		if (record) records.push(record);
	}
	return records;
}

/** All records in chronological (append) order; empty when the index does not exist. */
export function readEditCheckpointIndex(dir: string): EditCheckpointRecord[] {
	let text: string;
	try {
		text = readFileSync(editCheckpointIndexPath(dir), "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return parseIndexText(text);
}

/** Current byte size of the index (0 when absent) — the cursor for incremental attribution. */
export function editCheckpointIndexSize(dir: string): number {
	try {
		return statSync(editCheckpointIndexPath(dir)).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

/**
 * Records appended since `offset` (a byte position). Only complete lines are
 * consumed, so a writer mid-append is picked up on the next call. A shrunken
 * index (pruned/rewritten) resets the cursor to the start.
 */
export function readEditCheckpointIndexFrom(
	dir: string,
	offset: number,
): { records: EditCheckpointRecord[]; nextOffset: number } {
	const path = editCheckpointIndexPath(dir);
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], nextOffset: 0 };
		throw error;
	}
	try {
		const size = statSync(path).size;
		const start = offset > size ? 0 : offset;
		if (size <= start) return { records: [], nextOffset: start };
		const buffer = Buffer.alloc(size - start);
		let read = 0;
		while (read < buffer.length) {
			const chunk = readSync(fd, buffer, read, buffer.length - read, start + read);
			if (chunk === 0) break;
			read += chunk;
		}
		const complete = buffer.subarray(0, read).lastIndexOf(0x0a);
		if (complete < 0) return { records: [], nextOffset: start };
		const text = buffer.subarray(0, complete + 1).toString("utf-8");
		return { records: parseIndexText(text), nextOffset: start + complete + 1 };
	} finally {
		closeSync(fd);
	}
}

function writeFileAtomic(path: string, data: Uint8Array, mode = 0o600): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const tempPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	const descriptor = openSync(tempPath, "w", mode);
	try {
		writeFileSync(descriptor, data);
		fsyncSync(descriptor);
	} catch (error) {
		closeSync(descriptor);
		try {
			unlinkSync(tempPath);
		} catch {
			// best effort
		}
		throw error;
	}
	closeSync(descriptor);
	renameSync(tempPath, path);
}

/** Store a before-image; content-addressed, so identical states share one blob. Returns the sha256. */
export function storeEditCheckpointBlob(dir: string, data: Uint8Array): string {
	const sha = sha256Hex(data);
	const target = editCheckpointBlobPath(dir, sha);
	if (!existsSync(target)) writeFileAtomic(target, data);
	return sha;
}

export function readEditCheckpointBlob(dir: string, sha256: string): Buffer | undefined {
	try {
		return readFileSync(editCheckpointBlobPath(dir, sha256));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Append one record (O_APPEND, single write). */
export function appendEditCheckpointRecord(dir: string, record: EditCheckpointRecord): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const fd = openSync(editCheckpointIndexPath(dir), "a", 0o600);
	try {
		writeFileSync(fd, serializeRecord(record));
	} finally {
		closeSync(fd);
	}
}

export interface RecordEditCheckpointInput {
	path: string;
	/** Bytes before the edit; null when the file did not exist. */
	before: Uint8Array | null;
	/** Bytes after the edit; null when the edit removed the file. */
	after: Uint8Array | null;
	source: EditCheckpointSource;
	kind?: "edit" | "rewind";
	maxFileBytes: number;
	startLine?: number;
	cellId?: string | null;
	rewindOf?: string;
	seq?: string;
	ts?: string;
}

/**
 * Host-side equivalent of the Python `_write_checkpoint`: blob the before-image
 * (unless oversized) and append the record. Returns the record written.
 */
export function recordEditCheckpoint(dir: string, input: RecordEditCheckpointInput): EditCheckpointRecord {
	const record: EditCheckpointRecord = {
		v: 1,
		seq: input.seq ?? newEditCheckpointSeq(),
		ts: input.ts ?? new Date().toISOString(),
		kind: input.kind ?? "edit",
		source: input.source,
		path: input.path,
		beforeSha256: null,
		beforeBytes: input.before?.byteLength ?? 0,
		afterSha256: input.after ? sha256Hex(input.after) : null,
	};
	if (input.startLine !== undefined) record.startLine = input.startLine;
	if (input.cellId !== undefined) record.cellId = input.cellId;
	if (input.rewindOf) record.rewindOf = input.rewindOf;
	if (input.before === null) {
		record.beforeMissing = true;
	} else if (input.before.byteLength > input.maxFileBytes) {
		record.skipped = "oversized";
	} else {
		record.beforeSha256 = storeEditCheckpointBlob(dir, input.before);
	}
	appendEditCheckpointRecord(dir, record);
	return record;
}

// --- Rewind planning -------------------------------------------------------

export type EditRewindSkipReason = "drift" | "oversized" | "blob-missing" | "io";

export interface EditRewindPlanFile {
	path: string;
	/** Earliest record at/after the target for this path — its before-image is restored. */
	record: EditCheckpointRecord;
	/** sha256 the file is expected to have now (after-sha of its latest record; null = absent). */
	expectedSha256: string | null;
	/** sha256 of the live file (null = absent). */
	liveSha256: string | null;
	/** The file changed outside the tracked editors since its last checkpoint. */
	drift: boolean;
	/** The live file already equals the before-image: nothing to write (never blocks a rewind). */
	unchanged: boolean;
	/** False when the before-image was not captured (oversized) or its blob is gone. */
	restorable: boolean;
	unrestorableReason?: "oversized" | "blob-missing";
}

export interface EditRewindPlan {
	fromSeq: string;
	files: EditRewindPlanFile[];
}

export function readLiveSha256(path: string): string | null {
	try {
		return sha256Hex(readFileSync(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/**
 * For every path with a record at/after `fromSeq`, restore the EARLIEST
 * before-image at/after `fromSeq`; drift compares the live sha256 with the
 * after-sha of the LATEST record for that path (any position).
 */
export function planRewind(
	dir: string,
	records: readonly EditCheckpointRecord[],
	fromSeq: string,
	liveSha: (path: string) => string | null = readLiveSha256,
): EditRewindPlan {
	const fromIndex = records.findIndex((record) => record.seq === fromSeq);
	if (fromIndex < 0) {
		throw new Error(`Checkpoint ${fromSeq} is not in this session's edit-checkpoint index (pruned or unknown).`);
	}
	const latestByPath = new Map<string, EditCheckpointRecord>();
	for (const record of records) latestByPath.set(record.path, record);
	const earliestByPath = new Map<string, EditCheckpointRecord>();
	for (const record of records.slice(fromIndex)) {
		if (!earliestByPath.has(record.path)) earliestByPath.set(record.path, record);
	}
	const files: EditRewindPlanFile[] = [];
	for (const [path, record] of earliestByPath) {
		const expected = latestByPath.get(path)?.afterSha256 ?? null;
		const live = liveSha(path);
		let restorable = true;
		let unrestorableReason: EditRewindPlanFile["unrestorableReason"];
		if (record.skipped === "oversized") {
			restorable = false;
			unrestorableReason = "oversized";
		} else if (record.beforeSha256 && !existsSync(editCheckpointBlobPath(dir, record.beforeSha256))) {
			restorable = false;
			unrestorableReason = "blob-missing";
		}
		const beforeSha = record.beforeMissing ? null : record.beforeSha256;
		files.push({
			path,
			record,
			expectedSha256: expected,
			liveSha256: live,
			drift: live !== expected,
			unchanged: restorable && live === beforeSha,
			restorable,
			...(unrestorableReason ? { unrestorableReason } : {}),
		});
	}
	return { fromSeq, files };
}

export interface EditRewindResult {
	fromSeq: string;
	restored: string[];
	/** Files whose before-image did not exist: removed from disk. */
	removed: string[];
	/** Files already at the target state; left alone, no rewind record. */
	unchanged: string[];
	skipped: Array<{ path: string; reason: EditRewindSkipReason; detail?: string }>;
	/** Records appended for this rewind (one per restored file), so it is itself undoable. */
	rewindRecords: EditCheckpointRecord[];
}

/**
 * Apply a plan atomically per file (temp + fsync + rename). Drifted files are
 * skipped unless `force`. Each restored file gets a `kind: "rewind"` record
 * whose before-image is the pre-rewind live content.
 */
export function applyRewind(
	dir: string,
	plan: EditRewindPlan,
	options: { force?: boolean; maxFileBytes: number },
): EditRewindResult {
	const result: EditRewindResult = {
		fromSeq: plan.fromSeq,
		restored: [],
		removed: [],
		unchanged: [],
		skipped: [],
		rewindRecords: [],
	};
	for (const file of plan.files) {
		if (!file.restorable) {
			result.skipped.push({ path: file.path, reason: file.unrestorableReason ?? "blob-missing" });
			continue;
		}
		if (file.unchanged) {
			result.unchanged.push(file.path);
			continue;
		}
		if (file.drift && !options.force) {
			result.skipped.push({ path: file.path, reason: "drift" });
			continue;
		}
		try {
			let live: Buffer | null = null;
			try {
				live = readFileSync(file.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			let restoredBytes: Buffer | null = null;
			if (file.record.beforeMissing || file.record.beforeSha256 === null) {
				if (live !== null) rmSync(file.path, { force: true });
				result.removed.push(file.path);
			} else {
				const blob = readEditCheckpointBlob(dir, file.record.beforeSha256);
				if (!blob) {
					result.skipped.push({ path: file.path, reason: "blob-missing" });
					continue;
				}
				writeFileAtomic(file.path, blob, 0o644);
				restoredBytes = blob;
				result.restored.push(file.path);
			}
			result.rewindRecords.push(
				recordEditCheckpoint(dir, {
					path: file.path,
					before: live,
					after: restoredBytes,
					source: "rewind",
					kind: "rewind",
					maxFileBytes: options.maxFileBytes,
					rewindOf: plan.fromSeq,
				}),
			);
		} catch (error) {
			result.skipped.push({
				path: file.path,
				reason: "io",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}

// --- Retention -------------------------------------------------------------

export interface EditCheckpointPruneResult {
	droppedRecords: number;
	removedBlobs: number;
}

/**
 * Drop the oldest records past `maxRecords` and until the unique blob bytes
 * they reference fit `maxTotalBytes`; rewrite the index atomically and remove
 * blobs no longer referenced. Cheap enough to run after every recorded edit.
 * Blob GC only runs when records were dropped, so a writer that has stored a
 * blob but not yet appended its line is never raced on the steady-state path.
 */
export function pruneEditCheckpoints(dir: string, retention: EditCheckpointRetention): EditCheckpointPruneResult {
	const records = readEditCheckpointIndex(dir);
	if (records.length === 0) return { droppedRecords: 0, removedBlobs: 0 };
	let keepFrom = Math.max(0, records.length - Math.max(1, retention.maxRecords));
	const uniqueBytes = (from: number): number => {
		const seen = new Map<string, number>();
		for (const record of records.slice(from)) {
			if (record.beforeSha256 && !seen.has(record.beforeSha256)) seen.set(record.beforeSha256, record.beforeBytes);
		}
		let total = 0;
		for (const bytes of seen.values()) total += bytes;
		return total;
	};
	while (keepFrom < records.length - 1 && uniqueBytes(keepFrom) > retention.maxTotalBytes) keepFrom += 1;
	if (keepFrom === 0) return { droppedRecords: 0, removedBlobs: 0 };
	const kept = records.slice(keepFrom);
	writeFileAtomic(editCheckpointIndexPath(dir), Buffer.from(kept.map(serializeRecord).join(""), "utf-8"));
	const referenced = new Set(kept.map((record) => record.beforeSha256).filter((sha): sha is string => !!sha));
	let removedBlobs = 0;
	const blobsDir = join(dir, BLOBS_DIRNAME);
	let names: string[] = [];
	try {
		names = readdirSync(blobsDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const name of names) {
		if (name.endsWith(".tmp") || referenced.has(name)) continue;
		try {
			unlinkSync(join(blobsDir, name));
			removedBlobs += 1;
		} catch {
			// best effort
		}
	}
	return { droppedRecords: keepFrom, removedBlobs };
}

// --- Session correlation / listing ----------------------------------------

/** Minimal structural view of a session entry (works for SessionEntry and AgentConnectionSessionEntry). */
export interface EditCheckpointBranchEntry {
	id: string;
	type: string;
	timestamp: string;
	message?: { role: string; content?: unknown };
	customType?: string;
	data?: unknown;
}

export interface EditCheckpointEntryRecord {
	seq: string;
	path: string;
	source: EditCheckpointSource;
	kind: "edit" | "rewind";
	skipped?: "oversized";
}

/** `data` of an `edit_checkpoint` custom entry. */
export interface EditCheckpointEntryData {
	toolCallId: string;
	/** `ipython` | `hashline_edit` | `rewind`. */
	toolName: string;
	records: EditCheckpointEntryRecord[];
}

export function buildEditCheckpointEntryData(
	toolCallId: string,
	toolName: string,
	records: readonly EditCheckpointRecord[],
): EditCheckpointEntryData {
	return {
		toolCallId,
		toolName,
		records: records.map((record) => ({
			seq: record.seq,
			path: record.path,
			source: record.source,
			kind: record.kind,
			...(record.skipped ? { skipped: record.skipped } : {}),
		})),
	};
}

export function parseEditCheckpointEntryData(value: unknown): EditCheckpointEntryData | undefined {
	if (!isRecord(value) || typeof value.toolCallId !== "string" || !Array.isArray(value.records)) return undefined;
	const records: EditCheckpointEntryRecord[] = [];
	for (const raw of value.records) {
		if (!isRecord(raw) || typeof raw.seq !== "string" || typeof raw.path !== "string") continue;
		const source: EditCheckpointSource =
			raw.source === "shell" || raw.source === "hashline" || raw.source === "rewind" ? raw.source : "kernel";
		records.push({
			seq: raw.seq,
			path: raw.path,
			source,
			kind: raw.kind === "rewind" ? "rewind" : "edit",
			...(raw.skipped === "oversized" ? { skipped: "oversized" as const } : {}),
		});
	}
	return {
		toolCallId: value.toolCallId,
		toolName: typeof value.toolName === "string" ? value.toolName : "ipython",
		records,
	};
}

export interface EditCheckpointListItem {
	/** 1-based position in the listing — the `/rewind <N>` target. */
	index: number;
	/** seq of the group's earliest record — the `/rewind <seq>` target. */
	seq: string;
	timestamp: string;
	/** `turn`: edits made during a user turn; `rewind`: a previous /rewind; `shell`/`untracked`: index-only records. */
	kind: "turn" | "rewind" | "shell" | "untracked";
	turn?: { entryId: string; ordinal: number; preview: string };
	toolCallIds: string[];
	files: Array<{ path: string; edits: number; sources: EditCheckpointSource[] }>;
	/** All of the group's records were pruned from the index (cannot be rewound). */
	pruned: boolean;
}

const PREVIEW_CHARS = 60;

function previewText(content: unknown): string {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text")
			.map((part) => part.text)
			.join(" ");
	}
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > PREVIEW_CHARS ? `${collapsed.slice(0, PREVIEW_CHARS - 1)}…` : collapsed;
}

interface ListGroup {
	key: string;
	kind: EditCheckpointListItem["kind"];
	timestamp: string;
	turn?: EditCheckpointListItem["turn"];
	toolCallIds: string[];
	entryRecords: EditCheckpointEntryRecord[];
	/** Lowest index position among the group's records still on disk. */
	position: number;
}

/**
 * Group the branch's `edit_checkpoint` entries by user turn (rewinds stand
 * alone) and union index records no entry references (crash-orphaned shell or
 * kernel edits). `records === undefined` means "index not available here" (the
 * TUI picker): nothing is flagged pruned and no orphans are listed.
 */
export function listEditCheckpoints(
	branch: readonly EditCheckpointBranchEntry[],
	records: readonly EditCheckpointRecord[] | undefined,
): EditCheckpointListItem[] {
	const positionBySeq = new Map<string, number>();
	const recordBySeq = new Map<string, EditCheckpointRecord>();
	records?.forEach((record, index) => {
		positionBySeq.set(record.seq, index);
		recordBySeq.set(record.seq, record);
	});
	const groups = new Map<string, ListGroup>();
	const order: ListGroup[] = [];
	let currentTurn: EditCheckpointListItem["turn"] | undefined;
	let ordinal = 0;
	const referenced = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "message" && entry.message?.role === "user") {
			ordinal += 1;
			currentTurn = { entryId: entry.id, ordinal, preview: previewText(entry.message.content) };
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== EDIT_CHECKPOINT_CUSTOM_ENTRY) continue;
		const data = parseEditCheckpointEntryData(entry.data);
		if (!data || data.records.length === 0) continue;
		const isRewind = data.toolName === "rewind";
		const key = isRewind
			? `rewind:${entry.id}`
			: currentTurn
				? `turn:${currentTurn.entryId}`
				: `pre-turn:${entry.id}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				kind: isRewind ? "rewind" : "turn",
				timestamp: entry.timestamp,
				turn: currentTurn,
				toolCallIds: [],
				entryRecords: [],
				position: Number.POSITIVE_INFINITY,
			};
			groups.set(key, group);
			order.push(group);
		}
		group.toolCallIds.push(data.toolCallId);
		for (const record of data.records) {
			group.entryRecords.push(record);
			referenced.add(record.seq);
			const position = positionBySeq.get(record.seq);
			if (position !== undefined && position < group.position) group.position = position;
		}
	}
	if (records) {
		records.forEach((record, position) => {
			if (referenced.has(record.seq)) return;
			order.push({
				key: `orphan:${record.seq}`,
				kind: record.source === "shell" ? "shell" : "untracked",
				timestamp: record.ts,
				toolCallIds: [],
				entryRecords: [
					{
						seq: record.seq,
						path: record.path,
						source: record.source,
						kind: record.kind,
						...(record.skipped ? { skipped: record.skipped } : {}),
					},
				],
				position,
			});
		});
	}
	// Chronological by index position; groups whose records are all gone sort first (oldest).
	const entryOrder = new Map(order.map((group, index) => [group.key, index]));
	order.sort((a, b) => {
		const pa = Number.isFinite(a.position) ? a.position : -1;
		const pb = Number.isFinite(b.position) ? b.position : -1;
		if (pa !== pb) return pa - pb;
		return (entryOrder.get(a.key) ?? 0) - (entryOrder.get(b.key) ?? 0);
	});
	return order.map((group, index) => {
		const files = new Map<string, { path: string; edits: number; sources: EditCheckpointSource[] }>();
		for (const record of group.entryRecords) {
			const file = files.get(record.path) ?? { path: record.path, edits: 0, sources: [] };
			file.edits += 1;
			if (!file.sources.includes(record.source)) file.sources.push(record.source);
			files.set(record.path, file);
		}
		const onDisk = group.entryRecords
			.map((record) => ({ record, position: positionBySeq.get(record.seq) }))
			.filter((item): item is { record: EditCheckpointEntryRecord; position: number } => item.position !== undefined)
			.sort((a, b) => a.position - b.position);
		const seq = onDisk[0]?.record.seq ?? group.entryRecords[0].seq;
		return {
			index: index + 1,
			seq,
			timestamp: group.timestamp,
			kind: group.kind,
			...(group.turn ? { turn: group.turn } : {}),
			toolCallIds: group.toolCallIds,
			files: [...files.values()],
			pruned: records !== undefined && onDisk.length === 0,
		};
	});
}

/**
 * Resolve a `/rewind` target: a 1-based listing position or a record seq
 * (mid-turn seqs are accepted verbatim). Returns the seq to plan from and the
 * listing item it belongs to, if any.
 */
export function resolveEditCheckpointTarget(
	items: readonly EditCheckpointListItem[],
	records: readonly EditCheckpointRecord[],
	target: string,
): { seq: string; item?: EditCheckpointListItem } {
	const trimmed = target.trim();
	if (/^\d+$/.test(trimmed)) {
		const item = items[Number(trimmed) - 1];
		if (!item) {
			throw new Error(
				items.length === 0
					? "No edit checkpoints in this session."
					: `Checkpoint ${trimmed} is out of range (1-${items.length}). Run /rewind list.`,
			);
		}
		if (item.pruned) throw new Error(`Checkpoint ${trimmed} was pruned by retention and can no longer be restored.`);
		return { seq: item.seq, item };
	}
	if (!records.some((record) => record.seq === trimmed)) {
		throw new Error(`Unknown checkpoint "${trimmed}". Run /rewind list for valid targets.`);
	}
	const item = items.find((candidate) => candidate.seq === trimmed);
	return { seq: trimmed, item };
}

function describeFiles(item: EditCheckpointListItem): string {
	const count = item.files.length;
	return `${count} file${count === 1 ? "" : "s"}`;
}

/** One-line label for pickers: `3. turn 2 "fix the parser" · 2 files`. */
export function formatEditCheckpointLabel(item: EditCheckpointListItem): string {
	const parts: string[] = [`${item.index}.`];
	if (item.kind === "rewind") parts.push("rewind");
	else if (item.kind === "shell") parts.push("(shell)");
	else if (item.kind === "untracked") parts.push("(untracked)");
	if (item.turn) parts.push(`turn ${item.turn.ordinal}${item.turn.preview ? ` "${item.turn.preview}"` : ""}`);
	parts.push(`· ${describeFiles(item)}`);
	if (item.pruned) parts.push("(pruned)");
	return parts.join(" ");
}

/** Multi-line `/rewind list` output. */
export function formatEditCheckpointList(items: readonly EditCheckpointListItem[]): string {
	if (items.length === 0) {
		return "No edit checkpoints in this session yet. Files edited via the kernel edit skill (and hashline_edit) are snapshotted automatically.";
	}
	const lines = [`Edit checkpoints (${items.length}):`];
	for (const item of items) {
		lines.push(formatEditCheckpointLabel(item));
		for (const file of item.files) {
			const extras: string[] = [];
			if (file.edits > 1) extras.push(`${file.edits} edits`);
			const nonKernel = file.sources.filter((source) => source !== "kernel");
			if (nonKernel.length > 0) extras.push(nonKernel.join(", "));
			lines.push(`      ${file.path}${extras.length > 0 ? ` (${extras.join("; ")})` : ""}`);
		}
	}
	lines.push(
		"Restore with /rewind <N|seq> [--with-conversation] [--force] [--restart-kernel]. Files changed outside the tracked editors since their last checkpoint are refused unless --force.",
	);
	return lines.join("\n");
}
