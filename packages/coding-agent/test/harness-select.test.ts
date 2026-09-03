import { describe, expect, it } from "vitest";
import { createMmrHarnessSelector } from "../src/core/refinement/harness-select.js";
import {
	formatHarnessStateForPrompt,
	type HarnessEntry,
	type HarnessState,
} from "../src/core/refinement/refinement.js";

function entry(overrides: Partial<HarnessEntry> & { id: string }): HarnessEntry {
	return {
		kind: "memory",
		title: overrides.id,
		content: "content",
		path: `memory/${overrides.id}.md`,
		scope: "global",
		reference: {},
		arguments: {},
		metadata: {},
		source: "test",
		created_at: "2026-09-01T00:00:00Z",
		updated_at: "2026-09-01T00:00:00Z",
		version: 1,
		...overrides,
	};
}

function stateWith(memories: HarnessEntry[]): HarnessState {
	return {
		schema: 1,
		entries: { prompt: {}, memory: Object.fromEntries(memories.map((m) => [m.id, m])), skill: {}, subagent: {} },
		refinements: [],
	} as unknown as HarnessState;
}

const NOW = Date.parse("2026-09-02T00:00:00Z");

describe("createMmrHarnessSelector", () => {
	it("diversifies near-duplicate entries instead of taking the lexicographic head", () => {
		// Three near-identical "npm build" lessons and one distinct "pytest" lesson.
		// Lexicographic head (limit 2) would pick two npm duplicates; MMR keeps one
		// npm and the distinct pytest entry.
		const entries = [
			entry({ id: "a1", title: "npm build fails", content: "run npm install before npm build in ci pipelines" }),
			entry({ id: "a2", title: "npm build failure", content: "run npm install before npm build in ci pipeline" }),
			entry({ id: "a3", title: "npm build broken", content: "run npm install before npm build in the ci pipeline" }),
			entry({ id: "z9", title: "pytest venv", content: "use uv venv for pytest runs, pip is blocked by pep 668" }),
		];
		const selector = createMmrHarnessSelector({ now: () => NOW });

		const picked = selector("memory", entries, 2).map((e) => e.id);

		expect(picked).toHaveLength(2);
		expect(picked).toContain("z9");
	});

	it("weights recency as relevance", () => {
		const entries = [
			entry({
				id: "old",
				title: "alpha lesson",
				content: "totally distinct topic one",
				updated_at: "2026-07-01T00:00:00Z",
			}),
			entry({
				id: "new",
				title: "beta lesson",
				content: "another unrelated topic two",
				updated_at: "2026-09-01T23:00:00Z",
			}),
		];
		const selector = createMmrHarnessSelector({ now: () => NOW });

		expect(selector("memory", entries, 1).map((e) => e.id)).toEqual(["new"]);
	});

	it("enforces the character budget while always keeping one entry", () => {
		const entries = [
			entry({ id: "big", title: "big", content: "x".repeat(500), updated_at: "2026-09-01T12:00:00Z" }),
			entry({ id: "small", title: "small", content: "distinct tiny lesson", updated_at: "2026-09-01T00:00:00Z" }),
		];
		const selector = createMmrHarnessSelector({ now: () => NOW, charBudget: 50 });

		const picked = selector("memory", entries, 5).map((e) => e.id);
		// The first MMR pick (most recent) always fits; the rest must respect the budget.
		expect(picked[0]).toBe("big");
		expect(picked).toHaveLength(1);
	});

	it("is deterministic for a fixed clock", () => {
		const entries = [
			entry({ id: "a", content: "one topic entirely" }),
			entry({ id: "b", content: "different topic entirely" }),
			entry({ id: "c", content: "third topic entirely" }),
		];
		const selector = createMmrHarnessSelector({ now: () => NOW });
		const run1 = selector("memory", entries, 3).map((e) => e.id);
		const run2 = selector("memory", entries, 3).map((e) => e.id);
		expect(run1).toEqual(run2);
	});
});

describe("formatHarnessStateForPrompt selector seam", () => {
	const memories = [
		entry({ id: "m1", title: "Aardvark", content: "lesson a" }),
		entry({ id: "m2", title: "Zebra", content: "lesson z" }),
	];

	it("keeps the lexicographic slice byte-identical when no selector is passed", () => {
		const state = stateWith(memories);
		const withoutSeam = formatHarnessStateForPrompt(state);
		// The seam is optional — omitting it must not change a single byte.
		const withUndefined = formatHarnessStateForPrompt(state, { selectEntries: undefined });
		expect(withUndefined).toBe(withoutSeam);
		expect(withoutSeam).toContain("Aardvark");
		expect(withoutSeam).toContain("Zebra");
	});

	it("renders the selector's subset and counts the overflow", () => {
		const state = stateWith(memories);
		const output = formatHarnessStateForPrompt(state, {
			selectEntries: (_kind, entries) => entries.filter((e) => e.id === "m2"),
		});
		expect(output).toContain("Zebra");
		expect(output).not.toContain("Aardvark");
		expect(output).toContain("+1 more memory entries");
	});
});
