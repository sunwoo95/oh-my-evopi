import { describe, expect, it } from "vitest";
import {
	bpeClass,
	bpeLabel,
	isProgressEntry,
	PLAN_EMPTY_HINT,
	progressStatus,
	renderPlanBlock,
	sortProgressEntries,
} from "../src/core/refinement/progress-ledger.js";
import {
	formatHarnessStateForPrompt,
	type HarnessEntry,
	type HarnessState,
} from "../src/core/refinement/refinement.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

function entry(overrides: Partial<HarnessEntry> & { id: string }): HarnessEntry {
	return {
		kind: "memory",
		title: overrides.id,
		content: "content",
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "agent",
		created_at: "2026-09-01T00:00:00Z",
		updated_at: "2026-09-01T00:00:00Z",
		version: 1,
		...overrides,
	};
}

function progress(id: string, title: string, status: string, order: number, note?: string): HarnessEntry {
	return entry({
		id: `progress:${id}`,
		title,
		content: note ?? status,
		path: "progress",
		metadata: { bpe: "progress", status, order, updated_turn: "2026-09-01T00:00:00Z" },
	});
}

function stateWith(entries: HarnessEntry[], refinements: HarnessState["refinements"] = []): HarnessState {
	const state: HarnessState = {
		schema: 1,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements,
	};
	for (const item of entries) {
		state.entries[item.kind][item.id] = item;
	}
	return state;
}

const LEDGER = [
	progress("reproduce", "Reproduce", "done", 0),
	progress("fix_parser", "Fix parser", "active", 1, "edge case in tokenizer"),
	progress("add_tests", "Add tests", "open", 2),
	progress("ship", "Ship", "blocked", 3, "waiting on review"),
];

const LESSONS = [
	entry({ id: "lesson_a", title: "Aardvark lesson", content: "run the suite before shipping" }),
	entry({
		id: "belief_1",
		title: "Belief about repo",
		content: "the repo uses tabs",
		metadata: { bpe: "belief" },
	}),
	entry({ id: "note", kind: "prompt", title: "Prompt note", content: "prefer small edits", path: "policy" }),
];

describe("progress-ledger helpers", () => {
	it("recognizes progress entries and classifies BPE by metadata.bpe", () => {
		expect(isProgressEntry(LEDGER[0])).toBe(true);
		expect(isProgressEntry(LESSONS[0])).toBe(false);
		expect(bpeClass(LEDGER[0])).toBe("progress");
		expect(bpeClass(LESSONS[1])).toBe("belief");
		// Untagged, unknown, or non-string tags all default to experience.
		expect(bpeClass(LESSONS[0])).toBe("experience");
		expect(bpeClass(entry({ id: "x", metadata: { bpe: "wat" } }))).toBe("experience");
		expect(bpeClass(entry({ id: "y", metadata: { bpe: 3 } }))).toBe("experience");
		expect(bpeLabel(LEDGER[0])).toBe("[progress]");
		expect(bpeLabel(LESSONS[0])).toBe("[experience]");
	});

	it("normalizes progress status and sorts by metadata.order", () => {
		expect(progressStatus(LEDGER[1])).toBe("active");
		expect(progressStatus(entry({ id: "z", metadata: { bpe: "progress", status: "weird" } }))).toBe("open");
		const shuffled = [LEDGER[3], LESSONS[0], LEDGER[1], LEDGER[0], LEDGER[2]];
		expect(sortProgressEntries(shuffled).map((e) => e.id)).toEqual([
			"progress:reproduce",
			"progress:fix_parser",
			"progress:add_tests",
			"progress:ship",
		]);
		// Entries without an order sort last, then by id.
		const noOrder = entry({ id: "progress:b", metadata: { bpe: "progress", status: "open" } });
		const noOrder2 = entry({ id: "progress:a", metadata: { bpe: "progress", status: "open" } });
		expect(sortProgressEntries([noOrder, LEDGER[3], noOrder2]).map((e) => e.id)).toEqual([
			"progress:ship",
			"progress:a",
			"progress:b",
		]);
	});

	it("renders the PLAN block with the same markers as harness.py", () => {
		expect(renderPlanBlock([...LESSONS, ...LEDGER])).toBe(
			[
				"# PLAN (1/4 done)",
				"[x] Reproduce",
				"[>] Fix parser - edge case in tokenizer",
				"[ ] Add tests",
				"[!] Ship - waiting on review",
			].join("\n"),
		);
	});

	it("renders the goal objective under the header and a hint when the ledger is empty", () => {
		expect(renderPlanBlock([], { goalObjective: "Ship v1" })).toBe(`# PLAN\nGoal: Ship v1\n${PLAN_EMPTY_HINT}`);
		expect(renderPlanBlock(LESSONS)).toBe(`# PLAN\n${PLAN_EMPTY_HINT}`);
		const long = renderPlanBlock(LEDGER, { goalObjective: `${"g".repeat(300)}\n  multi line` });
		expect(long.split("\n")[1]).toMatch(/^Goal: g{197}\.\.\.$/);
	});
});

describe("formatHarnessStateForPrompt bpeView", () => {
	const state = stateWith([...LESSONS, ...LEDGER]);

	it("is byte-identical to the stock output when the option is absent or off (evo off)", () => {
		const stock = formatHarnessStateForPrompt(state);
		expect(formatHarnessStateForPrompt(state, { bpeView: undefined, goalObjective: undefined })).toBe(stock);
		expect(formatHarnessStateForPrompt(state, { bpeView: false, goalObjective: "ignored when off" })).toBe(stock);
		// Off path: no PLAN, no labels, progress entries still listed as plain memories.
		expect(stock).not.toContain("# PLAN");
		expect(stock).not.toContain("[experience]");
		expect(stock).not.toContain("rlm.harness.commit(");
		expect(stock).not.toContain("rlm.harness.recall(");
		expect(stock).toContain("memory: 6");
		expect(stock).toContain("[local:progress:reproduce] Reproduce (progress, v1)");
	});

	it("prepends the PLAN block, labels entries, and lifts progress entries out of the memory section", () => {
		const output = formatHarnessStateForPrompt(state, { bpeView: true, goalObjective: "Ship v1" });
		expect(output.startsWith("# PLAN (1/4 done)\nGoal: Ship v1\n[x] Reproduce\n")).toBe(true);
		expect(output.indexOf("# PLAN")).toBeLessThan(output.indexOf("# Continual Harness State"));
		expect(output).toContain("- [experience] [local:lesson_a] Aardvark lesson (general, v1)");
		expect(output).toContain("- [belief] [local:belief_1] Belief about repo (general, v1)");
		expect(output).toContain("- [experience] [local:note] Prompt note (policy, v1)");
		// Progress entries render once (in the PLAN), not as memory lines, and do not
		// consume the per-kind slot budget.
		expect(output).toContain("memory: 2");
		expect(output).not.toContain("[local:progress:reproduce]");
		expect(output).not.toContain("[progress] [local:");
		expect(output).toContain("Progress and recall: when you decompose work, call `rlm.harness.commit(");
		expect(output).toContain("keeping at most 8 non-done subgoals");
		expect(output).toContain('call `rlm.harness.recall("<query>")` to pull relevant lessons and skills');
	});

	it("omits the REPL commit/recall guidance without ipython but still renders the PLAN", () => {
		const output = formatHarnessStateForPrompt(state, { bpeView: true, includeIpythonExamples: false });
		expect(output.startsWith("# PLAN (1/4 done)\n[x] Reproduce")).toBe(true);
		expect(output).not.toContain("rlm.harness.commit(");
		expect(output).not.toContain("rlm.harness.recall(");
	});

	it("renders an empty-ledger hint when no subgoals were committed", () => {
		const output = formatHarnessStateForPrompt(stateWith(LESSONS), { bpeView: true });
		expect(output.startsWith(`# PLAN\n${PLAN_EMPTY_HINT}\n\n# Continual Harness State`)).toBe(true);
	});

	it("passes progress-free entries to the selector seam in bpeView", () => {
		const seen: string[] = [];
		formatHarnessStateForPrompt(state, {
			bpeView: true,
			selectEntries: (kind, entries) => {
				if (kind === "memory") seen.push(...entries.map((e) => e.id));
				return entries;
			},
		});
		// Lexicographic (path, title, id) order: "Aardvark lesson" sorts before "Belief about repo".
		expect(seen).toEqual(["lesson_a", "belief_1"]);
	});
});

describe("buildSystemPrompt harness BPE gate", () => {
	const harnessState = stateWith([...LESSONS, ...LEDGER]);
	const base = {
		selectedTools: ["ipython"],
		contextFiles: [],
		skills: [],
		cwd: "/repo",
		messagesPath: "/repo/.pi/sessions/session.jsonl",
		harnessState,
	};

	it("keeps the system prompt byte-identical when the gate is off", () => {
		const stock = buildSystemPrompt(base);
		const gatedOff = buildSystemPrompt({ ...base, harnessBpeView: undefined, harnessGoalObjective: undefined });
		expect(gatedOff).toBe(stock);
		expect(stock).not.toContain("# PLAN");
	});

	it("renders the PLAN block and labels when the gate is on", () => {
		const prompt = buildSystemPrompt({ ...base, harnessBpeView: true, harnessGoalObjective: "Ship v1" });
		expect(prompt).toContain(
			"# PLAN (1/4 done)\nGoal: Ship v1\n[x] Reproduce\n[>] Fix parser - edge case in tokenizer",
		);
		expect(prompt).toContain("- [experience] [local:lesson_a]");
		expect(prompt.indexOf("# PLAN")).toBeLessThan(prompt.indexOf("# Continual Harness State"));
	});
});
