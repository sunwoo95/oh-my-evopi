import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildFeedbackBlock,
	createGroundedRefineExtension,
	type GroundedFeedback,
	isFailureStatus,
	readFeedbackFromEnv,
} from "../src/core/extensions/builtin/grounded-refine.js";
import type {
	ExtensionAPI,
	ExtensionContext,
	RefinePreparation,
	SessionBeforeRefineEvent,
	SessionBeforeRefineResult,
} from "../src/core/extensions/types.js";
import type { RefinementProposal } from "../src/core/refinement/refinement.js";

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

function makeCtx(opts?: { model?: unknown; notices?: Array<{ message: string; type: string }> }): ExtensionContext {
	const notices = opts?.notices ?? [];
	return {
		hasUI: false,
		model: opts?.model,
		ui: { notify: (message: string, type = "info") => notices.push({ message, type }) },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth" }) },
	} as unknown as ExtensionContext;
}

async function fireRefine(
	handlers: Map<string, Array<(e: any, ctx: any) => any>>,
	ctx: ExtensionContext,
): Promise<SessionBeforeRefineResult | undefined> {
	const event: SessionBeforeRefineEvent = {
		type: "session_before_refine",
		preparation,
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

const noFeedback = () => undefined;
const feedback = (fb: GroundedFeedback) => () => fb;

describe("isFailureStatus", () => {
	it("recognizes failure markers case-insensitively, treats others as non-failure", () => {
		for (const s of ["fail", "FAILED", " failure ", "error", "errored"]) expect(isFailureStatus(s)).toBe(true);
		for (const s of ["pass", "ok", "success", "passed", "skipped", "weird"]) expect(isFailureStatus(s)).toBe(false);
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
});

describe("grounded-refine hook — D1 trigger + D4 injection", () => {
	it("no signal source → returns undefined (prime turn_interval path untouched)", async () => {
		const { api, handlers } = makeMockApi();
		createGroundedRefineExtension({ readFeedback: noFeedback })(api);
		expect(await fireRefine(handlers, makeCtx())).toBeUndefined();
	});

	it("non-failure signal → {skip:true} (D1: refine only on failure)", async () => {
		const { api, handlers } = makeMockApi();
		createGroundedRefineExtension({ readFeedback: feedback({ task: "T", status: "pass" }) })(api);
		expect(await fireRefine(handlers, makeCtx())).toEqual({ skip: true });
	});

	it("failure signal → {proposal} from the grounded planner (D4)", async () => {
		const { api, handlers } = makeMockApi();
		const proposal: RefinementProposal = { summary: "s", rationale: "r", expectedOutcome: "e", edits: [] };
		let seen: GroundedFeedback | undefined;
		createGroundedRefineExtension({
			readFeedback: feedback({ task: "T", status: "fail", detail: "boom" }),
			planner: async ({ feedback: fb }) => {
				seen = fb;
				return proposal;
			},
		})(api);
		const result = await fireRefine(handlers, makeCtx());
		expect(result).toEqual({ proposal });
		expect(seen).toEqual({ task: "T", status: "fail", detail: "boom" });
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
