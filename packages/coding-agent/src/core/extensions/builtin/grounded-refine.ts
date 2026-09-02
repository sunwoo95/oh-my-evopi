/**
 * Built-in grounded-refine — evopi's evo-layer delta over prime's continual
 * harness refinement (Evo-Harness paper: D1 = 식(6) paper:425-431, D4 = Table 4
 * paper:992-1034; DECISIONS R4). It gates `/refine` on an external pass/fail
 * signal and, on failure, injects that signal into the refinement planner.
 *
 * Two evo elements, on one `session_before_refine` hook:
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
 *
 * Safety constraint (SPEC §4:56, DECISIONS R4): an evo-on arm must only be
 * configured with a grounded signal wired. Absent a signal, this extension is
 * a no-op and prime's stock behavior is preserved. The extension itself is only
 * loaded when evo is enabled (see agent-session-services.ts); when evo is off
 * it is never registered, so `hasHandlers("session_before_refine")` stays false
 * and the whole hook is short-circuited (agent-session.ts:8229).
 */
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	RefinePreparation,
} from "../types.js";
import { normalizeRefinementProposal, REFINEMENT_SYSTEM_PROMPT, type RefinementProposal } from "../../refinement/refinement.js";
import { readFileSync } from "node:fs";
import { completeSimple } from "@evopi/pi-ai";
import { retryTransientCompletion } from "../../auth-pool/oneshot-retry.js";

/** External grounding signal, as written to `EVOPI_FEEDBACK_FILE`. */
export interface GroundedFeedback {
	/** Task/case identifier the signal is about. */
	task: string;
	/** Outcome marker. Failure markers trigger refinement; anything else skips. */
	status: string;
	/** Optional diagnostic text (only injected when detail level is Standard). */
	detail?: string;
}

/** Reads the current external feedback signal, or undefined when unconfigured/unreadable. */
export type FeedbackReader = () => GroundedFeedback | undefined;

/** Replaces the built-in planner with a grounded one; undefined falls back to it. */
export type GroundedPlanner = (args: {
	feedback: GroundedFeedback;
	preparation: RefinePreparation;
	ctx: ExtensionContext;
	signal: AbortSignal;
}) => Promise<RefinementProposal | undefined>;

const FAILURE_MARKERS = new Set(["fail", "failed", "failure", "error", "errored"]);

/** Whether a status string denotes a failure (D1 trigger condition). */
export function isFailureStatus(status: string): boolean {
	return FAILURE_MARKERS.has(status.trim().toLowerCase());
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
	const lines = [`status: ${isFailureStatus(feedback.status) ? "fail" : feedback.status}`, `task: ${feedback.task}`];
	if (standard && feedback.detail) lines.push(`detail: ${feedback.detail}`);
	return `<external_feedback>\n${lines.join("\n")}\n</external_feedback>`;
}

/**
 * Default grounded planner: an LLM call mirroring the built-in `planRefinement`
 * (same system prompt), with an `<external_feedback>` block added to the user
 * prompt. Uses the session's current model + auth. Returns undefined (→ built-in
 * planner) when no model/auth is available or the response is unparseable.
 */
async function defaultGroundedPlanner(args: {
	feedback: GroundedFeedback;
	preparation: RefinePreparation;
	ctx: ExtensionContext;
	signal: AbortSignal;
}): Promise<RefinementProposal | undefined> {
	const { feedback, preparation, ctx, signal } = args;
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
	const userPrompt = [
		feedbackBlock,
		"An external grounding signal reports the trajectory above FAILED. Focus the refinement on durable, reusable lessons that would prevent this failure class next time.",
		`<scope_policy>\n${scopePolicy}\n</scope_policy>`,
		preparation.instructions ? `<user_refine_instructions>\n${preparation.instructions}\n</user_refine_instructions>` : "",
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
					systemPrompt: REFINEMENT_SYSTEM_PROMPT,
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
 * `readFeedback` and `planner` are injectable for tests; they default to the
 * env-file reader and the LLM planner above.
 */
export function createGroundedRefineExtension(options?: {
	readFeedback?: FeedbackReader;
	planner?: GroundedPlanner;
}): ExtensionFactory {
	const readFeedback = options?.readFeedback ?? readFeedbackFromEnv;
	const planner = options?.planner ?? defaultGroundedPlanner;
	return (pi: ExtensionAPI) => {
		pi.on("session_before_refine", async (event, ctx) => {
			const feedback = readFeedback();
			// No signal source configured → do not interfere (prime turn_interval path).
			if (!feedback) return undefined;
			// D1: refine only on a failure signal; otherwise suppress this round.
			if (!isFailureStatus(feedback.status)) {
				return { skip: true };
			}
			// D4: failure → replace planner with one that sees the grounding signal.
			const proposal = await planner({ feedback, preparation: event.preparation, ctx, signal: event.signal });
			if (!proposal) return undefined;
			return { proposal };
		});
	};
}

/** Grounded-refine with default wiring, for embedders. */
export const groundedRefineExtension: ExtensionFactory = createGroundedRefineExtension();
