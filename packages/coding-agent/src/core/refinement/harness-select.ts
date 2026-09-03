/**
 * Harness-entry injection selector (B3/M17, R10).
 *
 * Replaces the lexicographic order+truncate in `formatHarnessStateForPrompt`
 * with an MMR-diversified, budget-capped selection when the evo layer (or the
 * `harness.selection: "mmr"` setting) enables it. Two ideas combined:
 *
 * - **MMR diversification** (mnemopi backport consumption, GAP-2/P2c): entries
 *   are reranked with `mmrRerank` — relevance = recency of `updated_at`,
 *   similarity = Jaccard over title+content — so near-duplicate lessons stop
 *   crowding out distinct ones. No embeddings required.
 * - **Cost-aware injection** (EvoHarness-RL no-training concept ③, D8 backlog,
 *   analogous to EVO-HARNESS's injection budget): an optional character budget
 *   caps how much harness text enters the system prompt per kind.
 *
 * Default behavior everywhere stays the lexicographic slice — this module is
 * only consulted behind the gate (D7: evo off = byte-identical).
 */

import { mmrRerank } from "@evopi/mnemopi";
import type { HarnessEntry, RefinementKind } from "./refinement.js";

export type HarnessEntrySelector = (kind: RefinementKind, entries: HarnessEntry[], limit: number) => HarnessEntry[];

export interface MmrHarnessSelectorOptions {
	/** MMR relevance/diversity trade-off; mnemopi default. */
	lambda?: number;
	/**
	 * Total character budget per kind over the rendered `title + content`
	 * (approximation of token cost). Undefined = no budget, count limit only.
	 */
	charBudget?: number;
	/** Clock for recency scoring; injectable for tests. */
	now?: () => number;
}

const DEFAULT_LAMBDA = 0.7;
/**
 * B2 (recall pull): `metadata.usage_count` is incremented by the kernel's
 * `rlm.harness.recall()` each time an entry is pulled. Frequently recalled
 * lessons earn a small relevance bonus (≤ 0.2) so they survive the per-kind
 * injection limit; the cap keeps a single hot entry from pinning itself.
 */
const USAGE_BONUS_PER_HIT = 0.02;
const USAGE_BONUS_MAX_HITS = 10;

function entryText(entry: HarnessEntry): string {
	return `${entry.title} ${entry.content}`;
}

/**
 * Recency relevance in (0, 1]: newest entry ≈ 1, decaying with age relative to
 * the newest entry (half-life 7 days). Unparsable timestamps score lowest.
 */
function recencyScore(entry: HarnessEntry, newestMs: number, nowMs: number): number {
	const updated = Date.parse(entry.updated_at);
	if (Number.isNaN(updated)) return 0.01;
	const ageMs = Math.max(0, (Number.isNaN(newestMs) ? nowMs : newestMs) - updated);
	const halfLifeMs = 7 * 24 * 3_600_000;
	return Math.max(0.01, 2 ** (-ageMs / halfLifeMs));
}

/** `min(usage_count, 10) * 0.02`; non-numeric or negative counts contribute nothing. */
export function usageBonus(entry: HarnessEntry): number {
	const raw = entry.metadata?.usage_count;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
	return Math.min(Math.floor(raw), USAGE_BONUS_MAX_HITS) * USAGE_BONUS_PER_HIT;
}

/** MMR relevance: recency plus the recall usage bonus, clamped to 1. */
function relevanceScore(entry: HarnessEntry, newestMs: number, nowMs: number): number {
	return Math.min(1, recencyScore(entry, newestMs, nowMs) + usageBonus(entry));
}

export function createMmrHarnessSelector(options: MmrHarnessSelectorOptions = {}): HarnessEntrySelector {
	const lambda = options.lambda ?? DEFAULT_LAMBDA;
	const now = options.now ?? Date.now;

	return (_kind, entries, limit) => {
		if (entries.length === 0 || limit <= 0) return [];

		const nowMs = now();
		const newestMs = entries.reduce((max, entry) => {
			const t = Date.parse(entry.updated_at);
			return Number.isNaN(t) ? max : Math.max(max, t);
		}, Number.NaN);

		const items = entries.map((entry) => ({
			content: entryText(entry),
			score: relevanceScore(entry, newestMs, nowMs),
			entry,
		}));

		const reranked = mmrRerank(items, lambda, limit);

		if (options.charBudget === undefined) {
			return reranked.map((item) => item.entry);
		}

		// Cost-aware cap: keep MMR order, stop once the budget is spent. The
		// first entry always fits so a tiny budget still yields one hint.
		const selected: HarnessEntry[] = [];
		let spent = 0;
		for (const item of reranked) {
			const cost = item.content.length;
			if (selected.length > 0 && spent + cost > options.charBudget) continue;
			selected.push(item.entry);
			spent += cost;
			if (selected.length >= limit) break;
		}
		return selected;
	};
}
