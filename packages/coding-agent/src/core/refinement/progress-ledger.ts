/**
 * Progress ledger helpers (B1 / P1, EvoHarness-RL "Progress" partition).
 *
 * The paper's BPE harness splits state into Belief, Progress, and Experience.
 * evopi already has a strong Experience axis (the continual harness entries +
 * refine); this module adds the Progress axis on top of the same store: the
 * Python kernel's `rlm.harness.commit(subgoal, status)` upserts `memory`
 * entries tagged `metadata.bpe = "progress"` (see evopi-runtime harness.py),
 * and the host renders them as a compact `# PLAN` block every time the system
 * prompt is built.
 *
 * Everything here is pure and additive. `formatHarnessStateForPrompt` only
 * consults it when `bpeView` is enabled, which is gated on the evo layer, so
 * evo-off output stays byte-identical.
 */

import type { HarnessEntry } from "./refinement.js";

export type BpeClass = "belief" | "progress" | "experience";
export type ProgressStatus = "open" | "active" | "done" | "blocked";

export const PROGRESS_STATUSES: readonly ProgressStatus[] = ["open", "active", "done", "blocked"];
/** Upper bound on non-done subgoals, mirrored from harness.py (`paper:814`). */
export const MAX_OPEN_PROGRESS = 8;

const BPE_CLASSES: readonly BpeClass[] = ["belief", "progress", "experience"];
const PROGRESS_MARKERS: Record<ProgressStatus, string> = {
	done: "[x]",
	active: "[>]",
	open: "[ ]",
	blocked: "[!]",
};
const PLAN_NOTE_LIMIT = 120;
const PLAN_GOAL_LIMIT = 200;
export const PLAN_EMPTY_HINT = "(no subgoals committed yet; use rlm.harness.commit('<subgoal>', 'open'))";

/** Whether the entry belongs to the progress ledger (`metadata.bpe === "progress"`). */
export function isProgressEntry(entry: HarnessEntry): boolean {
	return entry.metadata?.bpe === "progress";
}

/**
 * BPE class of an entry: `metadata.bpe` when it is one of the three valid
 * classes, otherwise `"experience"` (the default for every untagged lesson,
 * skill, prompt note, or subagent spec).
 */
export function bpeClass(entry: HarnessEntry): BpeClass {
	const raw = entry.metadata?.bpe;
	return typeof raw === "string" && (BPE_CLASSES as readonly string[]).includes(raw)
		? (raw as BpeClass)
		: "experience";
}

/** Normalized progress status; unknown or missing values render as `open`. */
export function progressStatus(entry: HarnessEntry): ProgressStatus {
	const raw = entry.metadata?.status;
	return typeof raw === "string" && (PROGRESS_STATUSES as readonly string[]).includes(raw)
		? (raw as ProgressStatus)
		: "open";
}

function progressOrder(entry: HarnessEntry): number {
	const raw = entry.metadata?.order;
	return typeof raw === "number" && Number.isFinite(raw) ? raw : Number.MAX_SAFE_INTEGER;
}

function compact(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

/** Progress entries only, sorted by `metadata.order` then id (same order as harness.py). */
export function sortProgressEntries(entries: readonly HarnessEntry[]): HarnessEntry[] {
	return entries.filter(isProgressEntry).sort((a, b) => {
		const byOrder = progressOrder(a) - progressOrder(b);
		return byOrder !== 0 ? byOrder : a.id.localeCompare(b.id);
	});
}

/**
 * Render the ledger as a `# PLAN` block: one line per subgoal with the same
 * markers as `HarnessState.plan()` in harness.py (`[x]` done, `[>]` active,
 * `[ ]` open, `[!]` blocked). Non-progress entries in `entries` are ignored so
 * callers can pass a whole kind's entries.
 */
export function renderPlanBlock(entries: readonly HarnessEntry[], options: { goalObjective?: string } = {}): string {
	const ledger = sortProgressEntries(entries);
	const lines: string[] = [];
	const done = ledger.filter((entry) => progressStatus(entry) === "done").length;
	lines.push(ledger.length > 0 ? `# PLAN (${done}/${ledger.length} done)` : "# PLAN");
	const goal = options.goalObjective ? compact(options.goalObjective, PLAN_GOAL_LIMIT) : "";
	if (goal) {
		lines.push(`Goal: ${goal}`);
	}
	if (ledger.length === 0) {
		lines.push(PLAN_EMPTY_HINT);
		return lines.join("\n");
	}
	for (const entry of ledger) {
		const status = progressStatus(entry);
		let line = `${PROGRESS_MARKERS[status]} ${entry.title}`;
		const note = compact(entry.content, PLAN_NOTE_LIMIT);
		if (note && note !== status) {
			line = `${line} - ${note}`;
		}
		lines.push(line);
	}
	return lines.join("\n");
}

/** Bracketed BPE label used to prefix entry lines in the gated three-partition view. */
export function bpeLabel(entry: HarnessEntry): string {
	return `[${bpeClass(entry)}]`;
}
