/**
 * Hashline edit tool (M6, `--tools` gated).
 *
 * A structural, line-anchored editor built on `@evopi/hashline`: the model
 * authors a hashline patch (`[path#TAG]` section headers plus `PUT`/`CUT`/
 * `REM`/`MV` ops) and the tool applies it through the real {@link Patcher},
 * {@link NodeFilesystem}, and {@link InMemorySnapshotStore}. It is NOT part of
 * the default toolset — the base session activates only `ipython` — and is
 * loadable only when explicitly allowlisted (`--tools hashline_edit`).
 *
 * Standalone tag synchronization: this host does not ship a hashline-aware
 * read tool that mints section tags, so the model has no minted `#TAG` to
 * quote. To keep the tool usable on its own, the executor records the current
 * on-disk content of each targeted file and rewrites that section's header tag
 * to the freshly computed content hash before applying. Edits therefore anchor
 * against live content (line numbers from a just-read file apply directly); the
 * seen-line guard is disabled for the same reason. Drift protection across
 * turns — the core value of the tag when a read tool mints it — is intentionally
 * out of scope for this gated backport.
 */

import { readFileSync } from "node:fs";
import {
	formatHashlineHeader,
	InMemorySnapshotStore,
	NodeFilesystem,
	normalizeToLF,
	Patch,
	Patcher,
	stripBom,
} from "@evopi/hashline";
import type { AgentToolResult } from "@evopi/pi-agent-core";
import { type Static, Type } from "typebox";
import { recordEditCheckpoint } from "../edit-checkpoints.js";
import type { ToolDefinition } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

export interface HashlineEditToolOptions {
	/**
	 * NS-D4 edit checkpoints: returns the session's checkpoint directory, or
	 * undefined when disabled / non-persistent. Re-read on every call so a
	 * settings change applies without rebuilding the tool.
	 */
	checkpointDir?: () => string | undefined;
	/** Largest before-image snapshotted (bytes); larger files are recorded as skipped. */
	checkpointMaxFileBytes?: number;
}

const DEFAULT_CHECKPOINT_MAX_FILE_BYTES = 4 * 1024 * 1024;

function readBytesOrNull(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Before-images of every path a patch touches (sections + move destinations), keyed by canonical path. */
function captureBeforeImages(patch: Patch, fs: CwdFilesystem): Map<string, Buffer | null> {
	const before = new Map<string, Buffer | null>();
	for (const section of patch.sections) {
		const canonical = fs.canonicalPath(section.path);
		if (!before.has(canonical)) before.set(canonical, readBytesOrNull(canonical));
		let fileOp: { kind: string; dest?: string } | undefined;
		try {
			fileOp = section.parse().fileOp;
		} catch {
			// Malformed body: the patcher reports it; nothing extra to snapshot.
		}
		if (fileOp?.kind === "move" && fileOp.dest) {
			const dest = fs.canonicalPath(fileOp.dest);
			if (!before.has(dest)) before.set(dest, readBytesOrNull(dest));
		}
	}
	return before;
}

/** Record one checkpoint per touched path whose bytes actually changed. Never throws. */
function recordHashlineCheckpoints(
	dir: string,
	before: Map<string, Buffer | null>,
	toolCallId: string,
	maxFileBytes: number,
): void {
	for (const [path, previous] of before) {
		try {
			const after = readBytesOrNull(path);
			if (previous === null && after === null) continue;
			if (previous !== null && after !== null && previous.equals(after)) continue;
			recordEditCheckpoint(dir, {
				path,
				before: previous,
				after,
				source: "hashline",
				maxFileBytes,
				cellId: toolCallId,
			});
		} catch {
			// A failed checkpoint must never fail the edit (same posture as the kernel skill).
		}
	}
}

const hashlineEditSchema = Type.Object(
	{
		patch: Type.String({
			description:
				"A hashline patch. Each section starts with a `[path#TAG]` header (TAG is a 4-hex tag; use any value such as `0000` — it is re-synced to the file's current content) followed by ops: `PUT <start>.=<end>:` then `+`-prefixed body lines to replace a line range, `PUT <N:`/`PUT >N:` to insert before/after line N, `CUT <start>.=<end>` to delete lines, `REM` to delete the file, `MV <dest>` to move it. Anchors are 1-indexed lines of the file's current content.",
		}),
	},
	{ additionalProperties: false },
);

export type HashlineEditToolInput = Static<typeof hashlineEditSchema>;

export interface HashlineEditToolDetails {
	/** Per-section outcome (path, op, first changed line, resulting header). */
	sections: Array<{
		path: string;
		op: "create" | "update" | "delete" | "noop";
		firstChangedLine?: number;
		header: string;
	}>;
	/** Warnings collected across all sections. */
	warnings: string[];
}

/**
 * {@link NodeFilesystem} that resolves every authored path against the agent's
 * cwd (including `~` expansion) rather than `process.cwd()`, matching how the
 * built-in edit tool resolves paths.
 */
class CwdFilesystem extends NodeFilesystem {
	constructor(private readonly cwd: string) {
		super();
	}

	override canonicalPath(path: string): string {
		return resolveToCwd(path, this.cwd);
	}

	override readText(path: string): Promise<string> {
		return super.readText(this.canonicalPath(path));
	}

	override readBinary(path: string): Promise<Uint8Array> {
		return super.readBinary(this.canonicalPath(path));
	}

	override writeText(path: string, content: string) {
		return super.writeText(this.canonicalPath(path), content);
	}

	override delete(path: string): Promise<void> {
		return super.delete(this.canonicalPath(path));
	}

	override move(from: string, to: string, content?: string): Promise<void> {
		return super.move(this.canonicalPath(from), this.canonicalPath(to), content);
	}

	override exists(path: string): Promise<boolean> {
		return super.exists(this.canonicalPath(path));
	}
}

/**
 * Record each targeted file's current content in the snapshot store and return
 * a patch string whose section headers carry the current content tags. Missing
 * files keep their authored header so the patcher surfaces its own
 * "file not found" guidance.
 */
async function syncSectionTags(patch: Patch, fs: CwdFilesystem, snapshots: InMemorySnapshotStore): Promise<string> {
	const rebuilt: string[] = [];
	for (const section of patch.sections) {
		let tag = section.fileHash ?? "0000";
		try {
			const raw = await fs.readText(section.path);
			const normalized = normalizeToLF(stripBom(raw).text);
			tag = snapshots.record(fs.canonicalPath(section.path), normalized);
		} catch {
			// Non-existent (or unreadable) file: leave the authored tag; the
			// patcher reports "File not found. Use the write tool to create new files."
		}
		rebuilt.push(`${formatHashlineHeader(section.path, tag)}\n${section.diff}`);
	}
	return rebuilt.join("\n");
}

export function createHashlineEditToolDefinition(
	cwd: string,
	options?: HashlineEditToolOptions,
): ToolDefinition<typeof hashlineEditSchema, HashlineEditToolDetails | undefined> {
	const fs = new CwdFilesystem(cwd);
	const snapshots = new InMemorySnapshotStore();
	const patcher = new Patcher({ fs, snapshots, enforceSeenLines: false });

	return {
		name: "hashline_edit",
		label: "hashline",
		description:
			"Apply a structural, line-anchored hashline patch to one or more existing files. Author `[path#TAG]` sections with `PUT`/`CUT`/`REM`/`MV` ops anchored to 1-indexed line numbers of each file's current content. Use for precise multi-line replacements, insertions, deletions, whole-file removal, and moves.",
		promptSnippet: "Apply line-anchored hashline patches to existing files",
		parameters: hashlineEditSchema,
		async execute(
			toolCallId,
			input: HashlineEditToolInput,
			signal?: AbortSignal,
		): Promise<AgentToolResult<HashlineEditToolDetails | undefined>> {
			if (signal?.aborted) throw new Error("Operation aborted");
			const parsed = Patch.parse(input.patch, { cwd });
			if (parsed.sections.length === 0) {
				throw new Error("Hashline patch produced no sections. Start each section with a `[path#TAG]` header.");
			}
			// Snapshot before the Patcher writes; only when checkpoints are enabled
			// (undefined dir = byte-identical legacy path).
			const checkpointDir = options?.checkpointDir?.();
			let beforeImages: Map<string, Buffer | null> | undefined;
			if (checkpointDir) {
				try {
					beforeImages = captureBeforeImages(parsed, fs);
				} catch {
					beforeImages = undefined;
				}
			}
			const synced = await syncSectionTags(parsed, fs, snapshots);
			const result = await patcher.apply(Patch.parse(synced, { cwd }));
			if (checkpointDir && beforeImages) {
				recordHashlineCheckpoints(
					checkpointDir,
					beforeImages,
					toolCallId,
					options?.checkpointMaxFileBytes ?? DEFAULT_CHECKPOINT_MAX_FILE_BYTES,
				);
			}

			const sections = result.sections.map((s) => ({
				path: s.path,
				op: s.op,
				firstChangedLine: s.firstChangedLine,
				header: s.header,
			}));
			const warnings = result.sections.flatMap((s) => s.warnings);
			const summary = result.sections
				.map((s) => `${s.op} ${s.path}${s.moveDest ? ` -> ${s.moveDest}` : ""} (${s.header})`)
				.join("\n");

			return {
				content: [
					{
						type: "text",
						text: `Applied hashline patch to ${result.sections.length} section(s).\n${summary}${
							warnings.length > 0 ? `\nWarnings:\n${warnings.join("\n")}` : ""
						}`,
					},
				],
				details: { sections, warnings },
			};
		},
	};
}

export function createHashlineEditTool(cwd: string, options?: HashlineEditToolOptions) {
	return wrapToolDefinition(createHashlineEditToolDefinition(cwd, options));
}
