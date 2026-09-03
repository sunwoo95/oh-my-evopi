/**
 * Built-in grounded-refine — evopi's evo-layer delta over prime's continual
 * harness refinement (Evo-Harness paper: D1 = 식(6) paper:425-431, D4 = Table 4
 * paper:992-1034; DECISIONS R4). It gates `/refine` on an external pass/fail
 * signal and, on failure, injects that signal into the refinement planner.
 *
 * Three evo elements, on one `session_before_refine` hook:
 * - **D1 (failure-only trigger)**: read an external feedback signal
 *   (`EVOPI_FEEDBACK_FILE` → JSON `{ task, status, detail? }`). If the signal
 *   says "not a failure", skip the refinement round entirely (`{ skip: true }`).
 *   If no signal source is configured at all, do NOT interfere — return
 *   `undefined` so prime's built-in turn_interval planner runs unchanged. This
 *   is the "quiet stall" guard from evo.md's safety note (SPEC §4:49-51).
 * - **D4 (grounded feedback injection)**: on a failure signal, replace the
 *   built-in planner with one whose prompt embeds an `<external_feedback>`
 *   block (Minimal: status/task; Standard opt-in via `EVOPI_FEEDBACK_DETAIL`:
 *   + diagnostic text). Injection MUST go through returning `{ proposal }`:
 *   the built-in planner reads `options.instructions` (refinement.ts:915), not
 *   the hook's `preparation`, so mutating preparation is a dead end
 *   (agent-session.ts:8256). This mirrors examples/extensions/custom-refinement.ts.
 * - **Branch (d) — success-without-experience note (B3, EvoHarness-RL P5,
 *   `paper:879-882` condition (3): "recall returned empty and you finished")**:
 *   on a PASS signal, when no stored experience was recalled during this
 *   session (zero `metadata.usage_count` growth on disk since `session_start`),
 *   force one "note" refinement round that records the successful approach as
 *   experience. Once per `feedback.task` per session; a PASS with recall hits,
 *   or any unknown status, still skips (D1 preserved).
 *
 * Recall observation is host-side: the kernel's `rlm.harness.recall()` bumps
 * `metadata.usage_count` on every hit and saves (harness.py), and emits nothing
 * else, so hits are the usage_count delta of the local+global stores since
 * `session_start`; recall CALLS are counted by scanning ipython `tool_call`
 * code for `rlm.harness.recall(` (wording only — a kernel-side recall log is v2).
 *
 * Safety constraint (SPEC §4:56, DECISIONS R4): an evo-on arm must only be
 * configured with a grounded signal wired. Absent a signal, this extension is
 * a no-op and prime's stock behavior is preserved. The extension itself is only
 * loaded when evo is enabled (see agent-session-services.ts); when evo is off
 * it is never registered, so `hasHandlers("session_before_refine")` stays false
 * and the whole hook is short-circuited (agent-session.ts:8229).
 */

import { readFileSync } from "node:fs";
import { completeSimple } from "@evopi/pi-ai";
import { retryTransientCompletion } from "../../auth-pool/oneshot-retry.js";
import { usageCount } from "../../refinement/consolidation.js";
import {
	buildRefinementSystemPrompt,
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
	type HarnessState,
	loadHarnessState,
	normalizeRefinementProposal,
	type RefinementKind,
	type RefinementProposal,
	renderHarnessOverviewForPrompt,
	resolveConsolidationPolicy,
} from "../../refinement/refinement.js";
import { getSessionArtifactPath } from "../../session-manager.js";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	isToolCallEventType,
	type RefinePreparation,
} from "../types.js";

/** External grounding signal, as written to `EVOPI_FEEDBACK_FILE`. */
export interface GroundedFeedback {
	/** Task/case identifier the signal is about. */
	task: string;
	/** Outcome marker. Failure markers trigger refinement; pass markers may trigger a note round; anything else skips. */
	status: string;
	/** Optional diagnostic text (only injected when detail level is Standard). */
	detail?: string;
}

/** Reads the current external feedback signal, or undefined when unconfigured/unreadable. */
export type FeedbackReader = () => GroundedFeedback | undefined;

/** Recall evidence for this session: `hits` = usage_count growth on disk, `calls` = observed `recall(` cells. */
export interface RecallTrace {
	hits: number;
	calls: number;
}

/** Produces the session's recall trace at planning time; injectable for tests. */
export type RecallTraceReader = (ctx: ExtensionContext) => RecallTrace;

/** Why the grounded planner is being invoked. */
export type GroundedPlannerMode = "failure" | "success-note";

export interface GroundedPlannerArgs {
	feedback: GroundedFeedback;
	preparation: RefinePreparation;
	ctx: ExtensionContext;
	signal: AbortSignal;
	/** `failure` = D4 grounded round; `success-note` = branch (d) note obligation. */
	mode: GroundedPlannerMode;
	/** Present in `success-note` mode. */
	recall?: RecallTrace;
}

/** Replaces the built-in planner with a grounded one; undefined falls back to it. */
export type GroundedPlanner = (args: GroundedPlannerArgs) => Promise<RefinementProposal | undefined>;

const FAILURE_MARKERS = new Set(["fail", "failed", "failure", "error", "errored"]);
const PASS_MARKERS = new Set(["pass", "passed", "ok", "success", "succeeded", "solved"]);

/** Whether a status string denotes a failure (D1 trigger condition). */
export function isFailureStatus(status: string): boolean {
	return FAILURE_MARKERS.has(status.trim().toLowerCase());
}

/** Whether a status string denotes a pass (branch (d) candidate). Unknown statuses are neither. */
export function isPassStatus(status: string): boolean {
	return PASS_MARKERS.has(status.trim().toLowerCase());
}

/** Default feedback reader: parses `EVOPI_FEEDBACK_FILE` as JSON `{task,status,detail?}`. */
export function readFeedbackFromEnv(): GroundedFeedback | undefined {
	const path = (process.env.EVOPI_FEEDBACK_FILE ?? "").trim();
	if (!path) return undefined;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// Signal source declared but unreadable → treat as unconfigured (no interference).
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as GroundedFeedback).task === "string" &&
			typeof (parsed as GroundedFeedback).status === "string"
		) {
			const fb = parsed as GroundedFeedback;
			return { task: fb.task, status: fb.status, detail: typeof fb.detail === "string" ? fb.detail : undefined };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/** Whether the Standard (diagnostic) feedback detail level is opted in. */
function isStandardDetail(): boolean {
	return (process.env.EVOPI_FEEDBACK_DETAIL ?? "").trim().toLowerCase() === "standard";
}

/** Build the `<external_feedback>` block injected into the planner prompt. */
export function buildFeedbackBlock(feedback: GroundedFeedback, standard: boolean): string {
	const status = isFailureStatus(feedback.status) ? "fail" : isPassStatus(feedback.status) ? "pass" : feedback.status;
	const lines = [`status: ${status}`, `task: ${feedback.task}`];
	if (standard && feedback.detail) lines.push(`detail: ${feedback.detail}`);
	return `<external_feedback>\n${lines.join("\n")}\n</external_feedback>`;
}

// --- Recall observation -----------------------------------------------------

/** `scope:kind:id` → `metadata.usage_count` over the given stores. */
export function usageCountIndex(states: readonly HarnessState[]): Map<string, number> {
	const index = new Map<string, number>();
	for (const state of states) {
		for (const kind of Object.keys(state.entries) as RefinementKind[]) {
			for (const entry of Object.values(state.entries[kind])) {
				index.set(`${entry.scope ?? "global"}:${kind}:${entry.id}`, usageCount(entry));
			}
		}
	}
	return index;
}

/** Σ max(0, current − baseline) over the current index; entries new since the baseline count from 0. */
export function countRecallHits(baseline: ReadonlyMap<string, number>, current: ReadonlyMap<string, number>): number {
	let hits = 0;
	for (const [key, count] of current) {
		hits += Math.max(0, count - (baseline.get(key) ?? 0));
	}
	return hits;
}

/** Cells that call the kernel's recall API (`rlm.harness.recall(...)`, or an aliased `<x>.recall(`). */
const RECALL_CALL_PATTERN = /\brlm\.harness\.recall\s*\(|\.recall\s*\(/;

/** Whether an ipython cell issues a harness recall call (best-effort textual scan). */
export function isRecallCell(code: string): boolean {
	return RECALL_CALL_PATTERN.test(code);
}

export interface DiskRecallTracker {
	/** Record the current usage_count index as the session baseline. */
	snapshot(ctx: ExtensionContext): void;
	/** Recall hits since the baseline. Without a baseline every current usage_count counts (conservative). */
	hits(ctx: ExtensionContext): number;
}

function localHarnessStateDirFor(ctx: ExtensionContext): string | undefined {
	const sessionManager = ctx.sessionManager as Partial<ExtensionContext["sessionManager"]> | undefined;
	if (
		!sessionManager ||
		typeof sessionManager.getSessionDir !== "function" ||
		typeof sessionManager.getSessionId !== "function"
	) {
		return undefined;
	}
	try {
		const sessionDir = sessionManager.getSessionDir();
		const sessionId = sessionManager.getSessionId();
		if (!sessionDir || !sessionId) return undefined;
		return getLocalHarnessStateDir(getSessionArtifactPath(sessionDir, sessionId));
	} catch {
		return undefined;
	}
}

/**
 * Observes recall hits through the harness state files: the kernel's
 * `rlm.harness.recall()` increments `metadata.usage_count` on each hit and
 * saves, so the delta of the local + global stores since `session_start` is the
 * session's hit count. Reads disk rather than `preparation.planningState`
 * because global-scope rounds do not include local entries.
 */
export function createDiskRecallTracker(options: { globalHarnessStateDir?: string } = {}): DiskRecallTracker {
	let baseline: Map<string, number> | undefined;
	const read = (ctx: ExtensionContext): Map<string, number> => {
		const states = [loadHarnessState(options.globalHarnessStateDir ?? getGlobalHarnessStateDir(), "global")];
		const localDir = localHarnessStateDirFor(ctx);
		if (localDir) states.push(loadHarnessState(localDir, "local"));
		return usageCountIndex(states);
	};
	return {
		snapshot(ctx) {
			baseline = read(ctx);
		},
		hits(ctx) {
			return countRecallHits(baseline ?? new Map(), read(ctx));
		},
	};
}

// --- Planner ----------------------------------------------------------------

/**
 * Default grounded planner: an LLM call mirroring the built-in `planRefinement`
 * (same system prompt, plus the B4 consolidation addendum when a cap is
 * resolved), with an `<external_feedback>` block added to the user prompt. Uses
 * the session's current model + auth. Returns undefined (→ built-in planner)
 * when no model/auth is available or the response is unparseable.
 */
async function defaultGroundedPlanner(
	args: GroundedPlannerArgs,
	capPerKind: number | undefined,
): Promise<RefinementProposal | undefined> {
	const { feedback, preparation, ctx, signal, mode, recall } = args;
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("grounded-refine: no active model, using default planner", "warning");
		return undefined;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		ctx.ui.notify("grounded-refine: no auth for model, using default planner", "warning");
		return undefined;
	}

	const feedbackBlock = buildFeedbackBlock(feedback, isStandardDetail());
	const scopePolicy =
		preparation.scope === "global"
			? "Requested refinement scope: global. Only propose stable cross-session harness edits."
			: "Requested refinement scope: local. Prefer local harness edits for current task progress; global entries are read-only.";
	// B4: with a resolved cap the planner needs to see existing ids/uses to
	// UPDATE/REMOVE instead of piling up ADDs; the overview is LFU-ordered.
	const consolidation = resolveConsolidationPolicy(preparation.planningState, {
		capPerKind,
		scope: preparation.scope,
	});
	const harnessBlock = consolidation
		? `<current_harness_state>\n${renderHarnessOverviewForPrompt(preparation.planningState, { consolidation })}\n</current_harness_state>`
		: "";
	const instruction =
		mode === "success-note"
			? [
					"The task PASSED and no stored experience was recalled during this session (EvoHarness-RL note obligation: recall returned nothing and you finished).",
					"Record the approach that worked as ONE reusable experience entry: `create` a `memory` (or a `skill` only if it is a repeatable procedure backed by a real Python callable) whose title names the task type and whose content is the concrete procedure or decision that made the task pass.",
					`Set metadata to {"bpe":"experience","origin":"success-no-recall","task":${JSON.stringify(feedback.task)}}. Never create progress entries.`,
					"Return zero or one create edit. Return an empty edits array (or a skip edit) if the approach is trivial or already covered by an existing entry, and list the existing titles you checked in the rationale.",
				].join(" ")
			: "An external grounding signal reports the trajectory above FAILED. Focus the refinement on durable, reusable lessons that would prevent this failure class next time.";
	const recallBlock =
		mode === "success-note" && recall
			? `<recall_trace>\nhits: ${recall.hits}\ncalls: ${recall.calls}\n${
					recall.calls > 0
						? "recall was attempted but returned no stored experience"
						: "recall was never attempted this session"
				}\n</recall_trace>`
			: "";
	const userPrompt = [
		feedbackBlock,
		recallBlock,
		instruction,
		harnessBlock,
		`<scope_policy>\n${scopePolicy}\n</scope_policy>`,
		preparation.instructions
			? `<user_refine_instructions>\n${preparation.instructions}\n</user_refine_instructions>`
			: "",
		`<conversation>\n${preparation.conversationText}\n</conversation>`,
		"Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
	]
		.filter(Boolean)
		.join("\n\n");

	// A transient provider blip (overloaded/429/5xx) must not silently downgrade
	// the grounded arm to the ungrounded default planner — retry it (B4/M18).
	const response = await retryTransientCompletion(
		() =>
			completeSimple(
				model,
				{
					systemPrompt: buildRefinementSystemPrompt(consolidation),
					messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
				},
				{ maxTokens: 4096, apiKey: auth.apiKey, headers: auth.headers, signal },
			),
		{ signal },
	);

	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) {
		ctx.ui.notify("grounded-refine: unparseable plan, using default planner", "warning");
		return undefined;
	}
	return normalizeRefinementProposal(JSON.parse(text.slice(start, end + 1)));
}

/**
 * Build the grounded-refine factory.
 *
 * `readFeedback`, `planner`, and `recallTrace` are injectable for tests; they
 * default to the env-file reader, the LLM planner above, and the disk
 * usage_count tracker + ipython `recall(` call counter. `capPerKind` supplies
 * the resolved B4 cap (`settingsManager.getHarnessCapPerKind()`); undefined
 * keeps the planner prompt free of the consolidation addendum.
 */
export function createGroundedRefineExtension(options?: {
	readFeedback?: FeedbackReader;
	planner?: GroundedPlanner;
	/** Full override of the recall trace (hits + calls). Wins over `recallTracker`. */
	recallTrace?: RecallTraceReader;
	/** Hit source only (default: disk usage_count tracker); calls are still counted from `tool_call`. */
	recallTracker?: DiskRecallTracker;
	capPerKind?: () => number | undefined;
}): ExtensionFactory {
	const readFeedback = options?.readFeedback ?? readFeedbackFromEnv;
	const capPerKind = options?.capPerKind ?? (() => undefined);
	const planner: GroundedPlanner = options?.planner ?? ((args) => defaultGroundedPlanner(args, capPerKind()));
	return (pi: ExtensionAPI) => {
		const tracker = options?.recallTracker ?? createDiskRecallTracker();
		let calls = 0;
		const notedTasks = new Set<string>();
		const recallTrace: RecallTraceReader = options?.recallTrace ?? ((ctx) => ({ hits: tracker.hits(ctx), calls }));

		// Baseline per session (startup/new/resume/fork/reload): recall hits are
		// measured from here, and the once-per-task note guard resets.
		pi.on("session_start", (_event, ctx) => {
			if (!options?.recallTrace) tracker.snapshot(ctx);
			calls = 0;
			notedTasks.clear();
		});

		// Count recall CALLS (deterministic, session-attributed); disk counts HITS.
		pi.on("tool_call", (event) => {
			if (
				isToolCallEventType("ipython", event) &&
				typeof event.input.code === "string" &&
				isRecallCell(event.input.code)
			) {
				calls++;
			}
			return undefined;
		});

		pi.on("session_before_refine", async (event, ctx) => {
			const feedback = readFeedback();
			// (a) No signal source configured → do not interfere (prime turn_interval path).
			if (!feedback) return undefined;
			// (c) D4: failure → replace planner with one that sees the grounding signal.
			if (isFailureStatus(feedback.status)) {
				const proposal = await planner({
					feedback,
					preparation: event.preparation,
					ctx,
					signal: event.signal,
					mode: "failure",
				});
				if (!proposal) return undefined;
				return { proposal };
			}
			// (d) B3: pass ∧ zero recall hits this session → one note round per task.
			if (isPassStatus(feedback.status) && !notedTasks.has(feedback.task)) {
				const recall = recallTrace(ctx);
				if (recall.hits === 0) {
					const proposal = await planner({
						feedback,
						preparation: event.preparation,
						ctx,
						signal: event.signal,
						mode: "success-note",
						recall,
					});
					if (proposal) {
						notedTasks.add(feedback.task);
						return { proposal };
					}
					// Cannot plan the note → stock D1 (pass → skip), never the ungrounded planner.
					return { skip: true };
				}
			}
			// (b) D1: not a failure (pass with recall hits, or unknown status) → suppress this round.
			return { skip: true };
		});
	};
}

/** Grounded-refine with default wiring, for embedders. */
export const groundedRefineExtension: ExtensionFactory = createGroundedRefineExtension();
