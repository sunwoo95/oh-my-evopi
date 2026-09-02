/**
 * Native gateway for hashline (등급 C, R6).
 *
 * Routes the three tree-sitter/diff kernels through `@evopi/pi-natives-loader`
 * instead of the Bun-only upstream wrapper. When the prebuilt addon is
 * unavailable (unsupported platform / load failure), the syntax probes report
 * "no structural evidence" (`null`), which callers already treat as a safe
 * withhold; `diffLineRuns` falls back to a pure-TS LCS line diff so recovery
 * line remapping still works everywhere.
 */

import {
	type BlockRangeOptions,
	type DiffRun,
	type EnclosingBoundaryOptions,
	loadNatives,
	type NodeSpan,
} from "@evopi/pi-natives-loader";

export type { NodeSpan, DiffRun };

export function diffLineRuns(oldText: string, newText: string): DiffRun[] {
	const native = loadNatives();
	if (native) {
		return native.diffLineRuns(oldText, newText);
	}
	return diffLineRunsFallback(oldText, newText);
}

export function nodeChainAt(options: BlockRangeOptions): NodeSpan[] | null {
	const native = loadNatives();
	return native ? native.nodeChainAt(options) : null;
}

export function enclosingBlockBoundaries(options: EnclosingBoundaryOptions): number[] | null {
	const native = loadNatives();
	return native ? native.enclosingBlockBoundaries(options) : null;
}

/**
 * Pure-TS line diff producing coalesced runs, used only when the native addon
 * is absent. Standard LCS over lines; runs are `unchanged` / `removed` / `added`
 * in the order the native kernel emits them (removals before additions).
 */
function diffLineRunsFallback(oldText: string, newText: string): DiffRun[] {
	const a = oldText.split("\n");
	const b = newText.split("\n");
	const n = a.length;
	const m = b.length;

	// LCS length table.
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}

	const runs: DiffRun[] = [];
	const push = (added: boolean, removed: boolean) => {
		const last = runs[runs.length - 1];
		if (last && last.added === added && last.removed === removed) {
			last.count += 1;
		} else {
			runs.push({ count: 1, added, removed });
		}
	};

	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			push(false, false);
			i++;
			j++;
		} else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
			push(false, true);
			i++;
		} else {
			push(true, false);
			j++;
		}
	}
	while (i < n) {
		push(false, true);
		i++;
	}
	while (j < m) {
		push(true, false);
		j++;
	}
	return runs;
}
