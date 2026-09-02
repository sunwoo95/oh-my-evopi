/**
 * STEP 14 keyless smoke of the evo-on D1 trigger logic, against real product source.
 *
 * Exercises grounded-refine's pure, key-independent surface directly:
 *   - readFeedbackFromEnv(): parses EVOPI_FEEDBACK_FILE JSON {task,status,detail?}
 *   - isFailureStatus(): D1 failure-only trigger
 *   - buildFeedbackBlock(): the <external_feedback> block injected on failure
 *
 * The LLM injection (defaultGroundedPlanner, grounded-refine.ts:113) needs a real
 * key and short-circuits to undefined without one (:126-128), so it is NOT reachable
 * keyless in-product — see RESULTS.md. This smoke covers everything that IS.
 *
 * Run from package root: ../../node_modules/.bin/tsx step14-evoon-logic-smoke.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFailureStatus, readFeedbackFromEnv, buildFeedbackBlock } from "./src/core/extensions/builtin/grounded-refine.js";

let failed = false;
function assert(cond: unknown, msg: string): void {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		failed = true;
	} else {
		console.log(`  ok  ${msg}`);
	}
}

const dir = mkdtempSync(join(tmpdir(), "evopi-step14-"));
try {
	// D1 quiet-stall guard: no signal configured → do not interfere.
	delete process.env.EVOPI_FEEDBACK_FILE;
	assert(readFeedbackFromEnv() === undefined, "unconfigured signal → undefined (quiet-stall guard, SPEC §4:49-51)");

	// D1 failure classification.
	assert(isFailureStatus("fail") && isFailureStatus("FAILED") && isFailureStatus(" error "), "failure markers classified as failure");
	assert(!isFailureStatus("pass") && !isFailureStatus("ok") && !isFailureStatus("success"), "non-failure markers skip refinement");

	// Feedback file round-trip (the evoon arm's grounded signal).
	const fbPath = join(dir, "feedback.json");
	writeFileSync(fbPath, JSON.stringify({ task: "T-42", status: "fail", detail: "verify: expected subset mismatch" }));
	process.env.EVOPI_FEEDBACK_FILE = fbPath;
	const fb = readFeedbackFromEnv();
	assert(fb?.task === "T-42" && fb?.status === "fail", "EVOPI_FEEDBACK_FILE JSON round-trips {task,status,detail}");

	// Malformed / partial signal → treated as unconfigured (no interference).
	const badPath = join(dir, "bad.json");
	writeFileSync(badPath, JSON.stringify({ status: "fail" })); // missing task
	process.env.EVOPI_FEEDBACK_FILE = badPath;
	assert(readFeedbackFromEnv() === undefined, "signal missing required field → undefined (no interference)");

	// Minimal (default) vs Standard detail levels.
	const block = buildFeedbackBlock(fb!, false);
	assert(block.includes("status: fail") && block.includes("task: T-42"), "Minimal block carries status + task");
	assert(!block.includes("detail:"), "Minimal block omits diagnostic detail");
	const stdBlock = buildFeedbackBlock(fb!, true);
	assert(stdBlock.includes("detail: verify: expected subset mismatch"), "Standard block includes diagnostic detail");

	console.log(failed ? "\nSMOKE: FAIL" : "\nSMOKE: PASS — evo-on D1 trigger + feedback-block logic verified keyless against product source.");
} finally {
	delete process.env.EVOPI_FEEDBACK_FILE;
	rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
