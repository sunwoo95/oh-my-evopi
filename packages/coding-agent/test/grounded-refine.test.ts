import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as PiAi from "@evopi/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildFeedbackBlock,
	countRecallHits,
	createDiskRecallTracker,
	createGroundedRefineExtension,
	type DiskRecallTracker,
	type GroundedFeedback,
	type GroundedPlannerArgs,
	isFailureStatus,
	isPassStatus,
	isRecallCell,
	readFeedbackFromEnv,
	usageCountIndex,
} from "../src/core/extensions/builtin/grounded-refine.js";
import type {
	ExtensionAPI,
	ExtensionContext,
	RefinePreparation,
	SessionBeforeRefineEvent,
	SessionBeforeRefineResult,
} from "../src/core/extensions/types.js";
import {
	applyRefinementProposal,
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
	type HarnessState,
	loadHarnessState,
	REFINEMENT_SYSTEM_PROMPT,
	type RefinementProposal,
	saveHarnessState,
} from "../src/core/refinement/index.js";
import { getSessionArtifactPath } from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@evopi/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

beforeEach(() => {
	completeSimpleMock.mockReset();
});

// --- Minimal mock session: capture the handler the factory registers, then
// fire it the same way ExtensionRunner.emit does for session_before_refine. ---

function makeMockApi() {
	const handlers = new Map<string, Array<(e: any, ctx: any) => any>>();
	const api = {
		on(event: string, handler: (e: any, ctx: any) => any) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

const preparation: RefinePreparation = {
	trigger: "auto",
	instructions: undefined,
	scope: "local",
	planningState: { entries: {} } as any,
	history: [],
	conversationText: "user: do a thing\nassistant: done",
};

function makeCtx(opts?: {
	model?: unknown;
	notices?: Array<{ message: string; type: string }>;
	auth?: { ok: boolean; apiKey?: string; error?: string };
	sessionDir?: string;
	sessionId?: string;
}): ExtensionContext {
	const notices = opts?.notices ?? [];
	return {
		hasUI: false,
		model: opts?.model,
		ui: { notify: (message: string, type = "info") => notices.push({ message, type }) },
		modelRegistry: { getApiKeyAndHeaders: async () => opts?.auth ?? { ok: false, error: "no auth" } },
		sessionManager:
			opts?.sessionDir && opts?.sessionId
				? { getSessionDir: () => opts.sessionDir, getSessionId: () => opts.sessionId }
				: undefined,
	} as unknown as ExtensionContext;
}

async function fireRefine(
	handlers: Map<string, Array<(e: any, ctx: any) => any>>,
	ctx: ExtensionContext,
	prep: RefinePreparation = preparation,
): Promise<SessionBeforeRefineResult | undefined> {
	const event: SessionBeforeRefineEvent = {
		type: "session_before_refine",
		preparation: prep,
		signal: new AbortController().signal,
	};
	let result: SessionBeforeRefineResult | undefined;
	for (const handler of handlers.get("session_before_refine") ?? []) {
		const r = await handler(event, ctx);
		if (r) {
			result = r;
			if (r.skip || r.proposal) return r;
		}
	}
	return result;
}

async function fireSessionStart(handlers: Map<string, Array<(e: any, ctx: any) => any>>, ctx: ExtensionContext) {
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, ctx);
	}
}

async function fireToolCall(
	handlers: Map<string, Array<(e: any, ctx: any) => any>>,
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
) {
	for (const handler of handlers.get("tool_call") ?? []) {
		await handler({ type: "tool_call", toolName, toolCallId: "1", input }, ctx);
	}
}

const noFeedback = () => undefined;
const feedback = (fb: GroundedFeedback) => () => fb;
const emptyProposal: RefinementProposal = { summary: "s", rationale: "r", expectedOutcome: "e", edits: [] };
const zeroHits = () => ({ hits: 0, calls: 0 });
const noopTracker: DiskRecallTracker = { snapshot() {}, hits: () => 0 };

describe("isFailureStatus", () => {
	it("recognizes failure markers case-insensitively, treats others as non-failure", () => {
		for (const s of ["fail", "FAILED", " failure ", "error", "errored"]) expect(isFailureStatus(s)).toBe(true);
		for (const s of ["pass", "ok", "success", "passed", "skipped", "weird"]) expect(isFailureStatus(s)).toBe(false);
	});
});

describe("isPassStatus", () => {
	it("recognizes the strict pass list case-insensitively; unknown statuses are neither pass nor failure", () => {
		for (const s of ["pass", "PASSED", " ok ", "success", "succeeded", "solved"]) expect(isPassStatus(s)).toBe(true);
		for (const s of ["fail", "skipped", "timeout", "weird", "partial"]) {
			expect(isPassStatus(s)).toBe(false);
		}
		expect(isFailureStatus("skipped")).toBe(false);
	});
});

describe("buildFeedbackBlock", () => {
	it("Minimal omits detail; Standard includes it", () => {
		const fb: GroundedFeedback = { task: "T1", status: "fail", detail: "assert x==1" };
		const minimal = buildFeedbackBlock(fb, false);
		expect(minimal).toContain("<external_feedback>");
		expect(minimal).toContain("status: fail");
		expect(minimal).toContain("task: T1");
		expect(minimal).not.toContain("assert x==1");
		const standard = buildFeedbackBlock(fb, true);
		expect(standard).toContain("detail: assert x==1");
	});

	it("normalizes pass markers to `pass` and leaves unknown statuses raw", () => {
		expect(buildFeedbackBlock({ task: "T", status: "SOLVED" }, false)).toContain("status: pass");
		expect(buildFeedbackBlock({ task: "T", status: "errored" }, false)).toContain("status: fail");
		expect(buildFeedbackBlock({ task: "T", status: "timeout" }, false)).toContain("status: timeout");
	});
});

describe("grounded-refine hook — D1 trigger + D4 injection", () => {
	it("no signal source → returns undefined (prime turn_interval path untouched)", async () => {
		const { api, handlers } = makeMockApi();
		createGroundedRefineExtension({ readFeedback: noFeedback })(api);
		expect(await fireRefine(handlers, makeCtx())).toBeUndefined();
	});

	it("non-failure signal with recall hits → {skip:true} (D1: refine only on failure)", async () => {
		const { api, handlers } = makeMockApi();
		createGroundedRefineExtension({
			readFeedback: feedback({ task: "T", status: "pass" }),
			recallTrace: () => ({ hits: 3, calls: 1 }),
		})(api);
		expect(await fireRefine(handlers, makeCtx())).toEqual({ skip: true });
	});

	it("failure signal → {proposal} from the grounded planner (D4) in failure mode", async () => {
		const { api, handlers } = makeMockApi();
		const proposal: RefinementProposal = { summary: "s", rationale: "r", expectedOutcome: "e", edits: [] };
		let seen: GroundedPlannerArgs | undefined;
		createGroundedRefineExtension({
			readFeedback: feedback({ task: "T", status: "fail", detail: "boom" }),
			planner: async (args) => {
				seen = args;
				return proposal;
			},
		})(api);
		const result = await fireRefine(handlers, makeCtx());
		expect(result).toEqual({ proposal });
		expect(seen?.feedback).toEqual({ task: "T", status: "fail", detail: "boom" });
		expect(seen?.mode).toBe("failure");
		expect(seen?.recall).toBeUndefined();
	});

	it("failure signal but planner unavailable → undefined (falls back to built-in planner)", async () => {
		const { api, handlers } = makeMockApi();
		createGroundedRefineExtension({
			readFeedback: feedback({ task: "T", status: "fail" }),
			planner: async () => undefined,
		})(api);
		expect(await fireRefine(handlers, makeCtx())).toBeUndefined();
	});

	it("default planner returns undefined (no model) without throwing", async () => {
		const { api, handlers } = makeMockApi();
		const notices: Array<{ message: string; type: string }> = [];
		createGroundedRefineExtension({ readFeedback: feedback({ task: "T", status: "fail" }) })(api);
		expect(await fireRefine(handlers, makeCtx({ model: undefined, notices }))).toBeUndefined();
		expect(notices.some((n) => n.type === "warning" && /no active model/.test(n.message))).toBe(true);
	});
});

describe("grounded-refine hook — branch (d) success-without-experience note (B3)", () => {
	it("pass ∧ zero recall hits → planner runs in success-note mode with the recall trace → {proposal}", async () => {
		const { api, handlers } = makeMockApi();
		let seen: GroundedPlannerArgs | undefined;
		createGroundedRefineExtension({
			readFeedback: feedback({ task: "T", status: "passed" }),
			recallTrace: () => ({ hits: 0, calls: 2 }),
			planner: async (args) => {
				seen = args;
				return emptyProposal;
			},
		})(api);
		expect(await fireRefine(handlers, makeCtx())).toEqual({ proposal: emptyProposal });
		expect(seen?.mode).toBe("success-note");
		expect(seen?.recall).toEqual({ hits: 0, calls: 2 });
		expect(seen?.feedback.task).toBe("T");
	});

	it("pass ∧ recall hits > 0 → {skip:true} and the planner is never called (D1 preserved)", async () => {
		const { api, handlers } = makeMockApi();
		const planner = vi.fn(async () => emptyProposal);
		createGroundedRefineExtension({
			readFeedback: feedback({ task: "T", status: "pass" }),
			recallTrace: () => ({ hits: 1, calls: 0 }),
			planner,
		})(api);
		expect(await fireRefine(handlers, makeCtx())).toEqual({ skip: true });
		expect(planner).not.toHaveBeenCalled();
	});

	it("notes each task once per session: same task → skip, different task → note again, session_start resets", async () => {
		const { api, handlers } = makeMockApi();
		let current: GroundedFeedback = { task: "A", status: "pass" };
		const planner = vi.fn(async () => emptyProposal);
		createGroundedRefineExtension({ readFeedback: () => current, recallTrace: zeroHits, planner })(api);
		const ctx = makeCtx();

		expect(await fireRefine(handlers, ctx)).toEqual({ proposal: emptyProposal });
		expect(await fireRefine(handlers, ctx)).toEqual({ skip: true });
		expect(planner).toHaveBeenCalledTimes(1);

		current = { task: "B", status: "ok" };
		expect(await fireRefine(handlers, ctx)).toEqual({ proposal: emptyProposal });
		expect(planner).toHaveBeenCalledTimes(2);

		await fireSessionStart(handlers, ctx);
		current = { task: "A", status: "pass" };
		expect(await fireRefine(handlers, ctx)).toEqual({ proposal: emptyProposal });
		expect(planner).toHaveBeenCalledTimes(3);
	});

	it("pass ∧ zero hits but planner unavailable → {skip:true} (never the ungrounded planner) and task stays un-noted", async () => {
		const { api, handlers } = makeMockApi();
		let available = false;
		const planner = vi.fn(async () => (available ? emptyProposal : undefined));
		createGroundedRefineExtension({
			readFeedback: feedback({ task: "T", status: "pass" }),
			recallTrace: zeroHits,
			planner,
		})(api);
		expect(await fireRefine(handlers, makeCtx())).toEqual({ skip: true });
		available = true;
		expect(await fireRefine(handlers, makeCtx())).toEqual({ proposal: emptyProposal });
		expect(planner).toHaveBeenCalledTimes(2);
	});

	it("unknown status → {skip:true} even with zero hits (strict pass list)", async () => {
		const { api, handlers } = makeMockApi();
		const planner = vi.fn(async () => emptyProposal);
		createGroundedRefineExtension({
			readFeedback: feedback({ task: "T", status: "weird" }),
			recallTrace: zeroHits,
			planner,
		})(api);
		expect(await fireRefine(handlers, makeCtx())).toEqual({ skip: true });
		expect(planner).not.toHaveBeenCalled();
	});

	it("counts ipython recall( cells via tool_call and resets the counter on session_start", async () => {
		const { api, handlers } = makeMockApi();
		let seen: GroundedPlannerArgs | undefined;
		let task = "T1";
		createGroundedRefineExtension({
			readFeedback: () => ({ task, status: "pass" }),
			recallTracker: noopTracker,
			planner: async (args) => {
				seen = args;
				return emptyProposal;
			},
		})(api);
		const ctx = makeCtx();
		await fireToolCall(handlers, ctx, "ipython", { code: "hits = rlm.harness.recall('parser bug')" });
		await fireToolCall(handlers, ctx, "ipython", { code: "h = rlm.harness\nprint(h.recall('x', kind='skill'))" });
		await fireToolCall(handlers, ctx, "ipython", { code: "print('recall me not')" });
		await fireToolCall(handlers, ctx, "bash", { command: "echo rlm.harness.recall(" });

		expect(await fireRefine(handlers, ctx)).toEqual({ proposal: emptyProposal });
		expect(seen?.recall).toEqual({ hits: 0, calls: 2 });

		await fireSessionStart(handlers, ctx);
		task = "T2";
		expect(await fireRefine(handlers, ctx)).toEqual({ proposal: emptyProposal });
		expect(seen?.recall).toEqual({ hits: 0, calls: 0 });
	});

	it("isRecallCell matches direct and aliased recall calls only", () => {
		expect(isRecallCell("await rlm.harness.recall('q')")).toBe(true);
		expect(isRecallCell('rlm.harness.recall ("q", limit=5)')).toBe(true);
		expect(isRecallCell("store.recall(q)")).toBe(true);
		expect(isRecallCell("rlm.harness.commit('subgoal', 'done')")).toBe(false);
		expect(isRecallCell("# recall is a word")).toBe(false);
	});
});

describe("recall observation helpers", () => {
	function entryState(scope: "local" | "global", entries: Array<{ id: string; usage?: unknown }>): HarnessState {
		const state = loadHarnessState(join(tmpdir(), "definitely-missing-evopi-harness"), scope);
		for (const { id, usage } of entries) {
			state.entries.memory[id] = {
				id,
				kind: "memory",
				title: id,
				content: id,
				path: "general",
				scope,
				reference: {},
				arguments: {},
				metadata: usage === undefined ? {} : { usage_count: usage },
				source: "test",
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				version: 1,
			};
		}
		return state;
	}

	it("usageCountIndex keys entries by scope:kind:id and treats non-numeric counts as 0", () => {
		const index = usageCountIndex([
			entryState("global", [{ id: "a", usage: 3 }]),
			entryState("local", [{ id: "a", usage: "x" }, { id: "b" }]),
		]);
		expect([...index.entries()]).toEqual([
			["global:memory:a", 3],
			["local:memory:a", 0],
			["local:memory:b", 0],
		]);
	});

	it("countRecallHits sums positive deltas, counts new entries from 0, and clamps decreases", () => {
		const baseline = new Map([
			["a", 2],
			["c", 5],
		]);
		const current = new Map([
			["a", 5],
			["b", 1],
			["c", 1],
		]);
		expect(countRecallHits(baseline, current)).toBe(4);
		expect(countRecallHits(new Map(), new Map())).toBe(0);
	});

	describe("createDiskRecallTracker", () => {
		let root: string | undefined;
		afterEach(() => {
			if (root) rmSync(root, { recursive: true, force: true });
			root = undefined;
		});

		it("measures usage_count growth of the local + global stores since the snapshot", () => {
			root = mkdtempSync(join(tmpdir(), "evopi-recall-"));
			const globalDir = join(root, "global-harness");
			const sessionDir = join(root, "sessions");
			const sessionId = "sess-1";
			const localDir = getLocalHarnessStateDir(getSessionArtifactPath(sessionDir, sessionId))!;

			const globalState = entryState("global", [{ id: "g", usage: 4 }]);
			const localState = entryState("local", [{ id: "l", usage: 1 }]);
			saveHarnessState(globalDir, globalState);
			saveHarnessState(localDir, localState);

			const tracker = createDiskRecallTracker({ globalHarnessStateDir: globalDir });
			const ctx = makeCtx({ sessionDir, sessionId });
			tracker.snapshot(ctx);
			expect(tracker.hits(ctx)).toBe(0);

			// Kernel recall hit on the local store: only usage_count changes.
			localState.entries.memory.l.metadata.usage_count = 2;
			saveHarnessState(localDir, localState);
			expect(tracker.hits(ctx)).toBe(1);

			// Global hit (other kernels share this file) also counts.
			globalState.entries.memory.g.metadata.usage_count = 6;
			saveHarnessState(globalDir, globalState);
			expect(tracker.hits(ctx)).toBe(3);

			// Re-snapshot (new session) resets the baseline.
			tracker.snapshot(ctx);
			expect(tracker.hits(ctx)).toBe(0);
		});

		it("without a snapshot every existing usage_count counts as a hit (conservative), and missing stores read as empty", () => {
			root = mkdtempSync(join(tmpdir(), "evopi-recall-"));
			const globalDir = join(root, "global-harness");
			saveHarnessState(globalDir, entryState("global", [{ id: "g", usage: 2 }]));
			const tracker = createDiskRecallTracker({ globalHarnessStateDir: globalDir });
			expect(tracker.hits(makeCtx())).toBe(2);
			const empty = createDiskRecallTracker({ globalHarnessStateDir: join(root, "nope") });
			expect(empty.hits(makeCtx({ sessionDir: join(root, "no-sessions"), sessionId: "x" }))).toBe(0);
		});

		it("defaults to the agent's global harness dir", () => {
			// Only asserts the default path resolution is wired; contents are environment-specific.
			expect(getGlobalHarnessStateDir()).toMatch(/harness$/);
		});
	});
});

describe("default grounded planner prompt", () => {
	const model = { id: "test-model", maxTokens: 8192 };
	const auth = { ok: true, apiKey: "k" };

	function planningState(): HarnessState {
		const state = loadHarnessState(join(tmpdir(), "definitely-missing-evopi-harness"), "local");
		applyRefinementProposal(
			state,
			{
				summary: "seed",
				rationale: "",
				expectedOutcome: "",
				edits: [
					{
						action: "create",
						kind: "memory",
						id: "hot",
						title: "Hot",
						content: "c",
						metadata: { usage_count: 7 },
					},
					{ action: "create", kind: "memory", id: "cold", title: "Cold", content: "c" },
				],
			},
			{ id: "seed", scope: "local" },
		);
		return state;
	}

	function planned(edits: unknown[] = []) {
		completeSimpleMock.mockResolvedValueOnce({
			content: [
				{ type: "text", text: JSON.stringify({ summary: "s", rationale: "r", expectedOutcome: "e", edits }) },
			],
			stopReason: "stop",
		});
	}

	it("without a cap uses REFINEMENT_SYSTEM_PROMPT verbatim and no harness overview (byte-identical to M-phase)", async () => {
		const { api, handlers } = makeMockApi();
		planned();
		createGroundedRefineExtension({ readFeedback: feedback({ task: "T", status: "fail" }) })(api);
		const result = await fireRefine(handlers, makeCtx({ model, auth }), {
			...preparation,
			planningState: planningState(),
		});
		expect(result?.proposal).toBeDefined();
		const request = completeSimpleMock.mock.calls[0][1];
		expect(request.systemPrompt).toBe(REFINEMENT_SYSTEM_PROMPT);
		const userPrompt: string = request.messages[0].content[0].text;
		expect(userPrompt).toContain("status: fail");
		expect(userPrompt).toContain("trajectory above FAILED");
		expect(userPrompt).not.toContain("<current_harness_state>");
		expect(userPrompt).not.toContain("<recall_trace>");
	});

	it("with a cap appends the consolidation addendum and an LFU-ordered overview with target-scope counts", async () => {
		const { api, handlers } = makeMockApi();
		planned([{ action: "ADD", kind: "memory", title: "n", content: "c" }]);
		createGroundedRefineExtension({
			readFeedback: feedback({ task: "T", status: "fail" }),
			capPerKind: () => 80,
		})(api);
		const result = await fireRefine(handlers, makeCtx({ model, auth }), {
			...preparation,
			planningState: planningState(),
		});
		// Alias mapping applies to extension proposals too.
		expect(result?.proposal?.edits[0]?.action).toBe("create");
		const request = completeSimpleMock.mock.calls[0][1];
		expect(request.systemPrompt.startsWith(REFINEMENT_SYSTEM_PROMPT)).toBe(true);
		expect(request.systemPrompt).toContain("K=80");
		expect(request.systemPrompt).toContain("memory 2/80");
		expect(request.systemPrompt).toContain("SKIP");
		const userPrompt: string = request.messages[0].content[0].text;
		expect(userPrompt).toContain("<current_harness_state>");
		expect(userPrompt.indexOf("[local:cold]")).toBeLessThan(userPrompt.indexOf("[local:hot]"));
		expect(userPrompt).toContain("uses=7");
	});

	it("success-note mode injects status: pass, the recall trace, and the note obligation", async () => {
		const { api, handlers } = makeMockApi();
		planned();
		createGroundedRefineExtension({
			readFeedback: feedback({ task: "case-9", status: "solved" }),
			recallTrace: () => ({ hits: 0, calls: 1 }),
		})(api);
		const result = await fireRefine(handlers, makeCtx({ model, auth }));
		expect(result?.proposal).toBeDefined();
		const userPrompt: string = completeSimpleMock.mock.calls[0][1].messages[0].content[0].text;
		expect(userPrompt).toContain("status: pass");
		expect(userPrompt).toContain("<recall_trace>\nhits: 0\ncalls: 1\n");
		expect(userPrompt).toContain("recall was attempted but returned no stored experience");
		expect(userPrompt).toContain("note obligation");
		expect(userPrompt).toContain('"origin":"success-no-recall","task":"case-9"');
		expect(userPrompt).not.toContain("trajectory above FAILED");
	});
});

describe("readFeedbackFromEnv", () => {
	let dir: string | undefined;
	afterEach(() => {
		delete process.env.EVOPI_FEEDBACK_FILE;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("returns undefined when EVOPI_FEEDBACK_FILE is unset", () => {
		delete process.env.EVOPI_FEEDBACK_FILE;
		expect(readFeedbackFromEnv()).toBeUndefined();
	});

	it("returns undefined when the file is missing (declared but unreadable)", () => {
		process.env.EVOPI_FEEDBACK_FILE = join(tmpdir(), "definitely-missing-evopi-feedback.json");
		expect(readFeedbackFromEnv()).toBeUndefined();
	});

	it("parses a valid {task,status,detail} signal", () => {
		dir = mkdtempSync(join(tmpdir(), "evopi-fb-"));
		const file = join(dir, "fb.json");
		writeFileSync(file, JSON.stringify({ task: "case-7", status: "fail", detail: "diff mismatch" }));
		process.env.EVOPI_FEEDBACK_FILE = file;
		expect(readFeedbackFromEnv()).toEqual({ task: "case-7", status: "fail", detail: "diff mismatch" });
	});

	it("returns undefined for malformed JSON or missing required fields", () => {
		dir = mkdtempSync(join(tmpdir(), "evopi-fb-"));
		const file = join(dir, "fb.json");
		process.env.EVOPI_FEEDBACK_FILE = file;
		writeFileSync(file, "{not json");
		expect(readFeedbackFromEnv()).toBeUndefined();
		writeFileSync(file, JSON.stringify({ status: "fail" })); // no task
		expect(readFeedbackFromEnv()).toBeUndefined();
	});
});
