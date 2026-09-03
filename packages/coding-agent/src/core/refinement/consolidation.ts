/**
 * Harness consolidation helpers (B4 / EvoHarness-RL P3+P4: note consolidation
 * vocabulary, per-kind capacity, LFU eviction).
 *
 * The paper's experience store is capacity-bounded per category (Kmax = 80,
 * Table 4) and evicts by usage count (LFU, `paper:763-770`); its
 * note-consolidation prompt asks the summarizer to decide ADD / UPDATE /
 * REMOVE / SKIP per note (`paper:904-925`). evopi maps that onto the existing
 * per-entry refinement edits:
 *
 * - ADD → `create`, UPDATE → `update`, REMOVE → `delete` (aliases accepted at
 *   parse time), SKIP → an explicit `{"action":"skip"}` edit that is recorded
 *   but never applied.
 * - The cap is enforced by the host at apply time on the TARGET store only:
 *   `prompt`/`memory` overflow is auto-evicted (lowest `metadata.usage_count`
 *   first, ties → oldest `updated_at`), recorded as ordinary rollback-able
 *   `delete` edits; `skill`/`subagent` overflow rejects the ADD instead, so a
 *   Python module or delegation spec is never removed without a planner REMOVE.
 * - Progress-ledger entries (`metadata.bpe === "progress"`) have their own cap
 *   in the kernel and are excluded from counts and eviction.
 *
 * Everything here is pure. Nothing is consulted unless a cap is resolved
 * (`settingsManager.getHarnessCapPerKind()`), so evo-off stays byte-identical.
 */

import { isProgressEntry } from "./progress-ledger.js";
import type {
	HarnessEntry,
	HarnessScope,
	HarnessState,
	RefinementAction,
	RefinementEdit,
	RefinementKind,
} from "./refinement.js";

/** Paper Table 4: experience capacity Kmax = 80 per category. */
export const DEFAULT_HARNESS_CAP_PER_KIND = 80;

/** Kinds whose overflow is auto-evicted (LFU). The others reject the ADD. */
export const AUTO_EVICT_KINDS: readonly RefinementKind[] = ["prompt", "memory"];

const ALL_KINDS: readonly RefinementKind[] = ["prompt", "memory", "skill", "subagent"];

export interface ConsolidationPolicy {
	/** Maximum non-progress entries per kind in the target store. */
	capPerKind: number;
	/** Current non-progress entry counts of the target store, when known. */
	counts?: Partial<Record<RefinementKind, number>>;
}

/** Whether a kind's overflow is auto-evicted (`prompt`, `memory`) rather than rejected. */
export function isAutoEvictKind(kind: RefinementKind): boolean {
	return AUTO_EVICT_KINDS.includes(kind);
}

/** `metadata.usage_count` as a non-negative integer; non-numeric or negative → 0. */
export function usageCount(entry: Pick<HarnessEntry, "metadata">): number {
	const raw = entry.metadata?.usage_count;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
	return Math.floor(raw);
}

function updatedAtMs(entry: HarnessEntry): number {
	const parsed = Date.parse(entry.updated_at);
	// Unparsable timestamps sort as oldest so they are evicted before dated entries.
	return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** LFU order: lowest usage_count first, then oldest updated_at, then id. */
export function compareLfu(a: HarnessEntry, b: HarnessEntry): number {
	const byUsage = usageCount(a) - usageCount(b);
	if (byUsage !== 0) return byUsage;
	const aMs = updatedAtMs(a);
	const bMs = updatedAtMs(b);
	if (aMs !== bMs) return aMs < bMs ? -1 : 1;
	return a.id.localeCompare(b.id);
}

/**
 * Pick `overflow` eviction victims from `entries` in LFU order, never choosing a
 * protected id (entries created or updated by the proposal being applied).
 * Returns fewer than `overflow` when not enough unprotected entries exist.
 */
export function selectLfuEvictions(
	entries: readonly HarnessEntry[],
	overflow: number,
	protectedIds: ReadonlySet<string> = new Set(),
): HarnessEntry[] {
	if (overflow <= 0) return [];
	return [...entries]
		.filter((entry) => !protectedIds.has(entry.id))
		.sort(compareLfu)
		.slice(0, overflow);
}

/**
 * Non-progress entry counts per kind. With `scope`, only entries of that scope
 * are counted (planning states merge global and local entries; the cap applies
 * to the target store alone).
 */
export function countConsolidationEntries(state: HarnessState, scope?: HarnessScope): Record<RefinementKind, number> {
	const counts: Record<RefinementKind, number> = { prompt: 0, memory: 0, skill: 0, subagent: 0 };
	for (const kind of ALL_KINDS) {
		for (const entry of Object.values(state.entries[kind] ?? {})) {
			if (isProgressEntry(entry)) continue;
			if (scope && (entry.scope ?? "global") !== scope) continue;
			counts[kind] += 1;
		}
	}
	return counts;
}

/** Whether a create/update edit targets the progress ledger (excluded from caps). */
export function isProgressEdit(edit: Pick<RefinementEdit, "metadata">): boolean {
	return edit.metadata?.bpe === "progress";
}

/** Error recorded on a rejected ADD to a full `skill`/`subagent` kind. */
export function capacityError(kind: RefinementKind, count: number, capPerKind: number): string {
	return `${kind} kind at capacity (${count}/${capPerKind}); REMOVE first`;
}

/** Reason recorded on an auto-eviction `delete` edit. */
export function evictionReason(entry: HarnessEntry, capPerKind: number): string {
	return `LFU eviction: ${entry.kind} exceeded cap ${capPerKind} (usage_count=${usageCount(entry)}, updated ${entry.updated_at})`;
}

/**
 * Paper D.2 vocabulary mapped onto refinement actions. Matching is trimmed and
 * case-insensitive; anything else is returned unchanged so apply-time validation
 * still reports `unsupported action <x>`.
 */
const ACTION_ALIASES: Record<string, RefinementAction> = {
	add: "create",
	create: "create",
	update: "update",
	remove: "delete",
	delete: "delete",
	skip: "skip",
};

export function normalizeRefinementAction(raw: unknown): unknown {
	if (typeof raw !== "string") return raw;
	return ACTION_ALIASES[raw.trim().toLowerCase()] ?? raw;
}

/**
 * Entry snapshot without kernel bookkeeping. `rlm.harness.recall()` bumps
 * `metadata.usage_count` and saves without touching `version`/`updated_at`
 * (harness.py), so a recall hit during the planning LLM call must not make a
 * planned UPDATE/REMOVE fail as "entry changed during refinement planning".
 * Content edits still bump `version`, so real concurrent edits are detected.
 */
export function stripBookkeeping(entry: HarnessEntry | undefined): HarnessEntry | undefined {
	if (!entry) return undefined;
	const clone: HarnessEntry = JSON.parse(JSON.stringify(entry));
	if (clone.metadata && typeof clone.metadata === "object") {
		const { usage_count: _usageCount, ...metadata } = clone.metadata;
		clone.metadata = metadata;
	}
	return clone;
}

/**
 * System-prompt addendum appended to `REFINEMENT_SYSTEM_PROMPT` when a cap is
 * resolved. Mirrors the paper's note-consolidation rules (`paper:915-925`).
 */
export function consolidationAddendum(policy: ConsolidationPolicy): string {
	const cap = policy.capPerKind;
	const lines = [
		"Consolidation policy (EvoHarness-RL note consolidation):",
		'- Vocabulary: ADD = "create" (genuinely new knowledge not covered by any existing entry); UPDATE = "update" (refines, corrects, or extends an existing entry; reference its id); REMOVE = "delete" (only when trajectory evidence shows the entry is wrong or stale); SKIP = {"action":"skip","kind":"<kind>","reason":"..."} for trivial, redundant, or episode-specific lessons. "add" and "remove" are accepted aliases. Returning no edit is also a valid skip.',
		"- Prefer UPDATE over ADD when an existing entry overlaps. Keep entries short and concrete.",
		`- Capacity: each kind holds at most K=${cap} entries in the target store (progress subgoals excluded).`,
	];
	if (policy.counts) {
		const counts = ALL_KINDS.map((kind) => `${kind} ${policy.counts?.[kind] ?? 0}/${cap}`).join(", ");
		lines.push(`- Current counts: ${counts}.`);
	}
	lines.push(
		`- When prompt or memory exceeds K=${cap} after your edits, the least-recalled entries (lowest \`uses=\` in the overview, ties → oldest updated) are evicted automatically; entries you create or update in this round are never evicted. Pair every ADD to a full kind with a REMOVE of an obsolete entry instead of relying on eviction.`,
		'- skill and subagent entries are never auto-evicted: an ADD to a full skill/subagent kind is rejected ("kind at capacity; REMOVE first"). List the REMOVE edit before the ADD in the edits array.',
	);
	return lines.join("\n");
}
