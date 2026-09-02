/**
 * STEP 14 keyless faux-provider smoke.
 *
 * No API key is available in the sandbox, so a real A/B run is SKIPPED
 * (SPEC §7:78). This proves the keyless provider path the evo-on arm's grounded
 * planner relies on: `completeSimple()` (the exact primitive
 * grounded-refine's defaultGroundedPlanner calls) routed through the pi-ai mock
 * provider, returning a canned refinement proposal with zero cost and no key.
 *
 * Lives in eval/ (outside metaharness/) so the metaharness copy stays unmodified.
 * Run: cd eval && bun faux-provider-smoke.ts
 */
import { completeSimple } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

function assert(cond: unknown, msg: string): void {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`  ok  ${msg}`);
}

async function main() {
	// Prove no real credential is in play.
	const keyEnvs = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FIREWORKS_API_KEY", "GEMINI_API_KEY"];
	const present = keyEnvs.filter((k) => process.env[k]);
	console.log(`env keys present: ${present.length === 0 ? "(none)" : present.join(",")}`);

	registerMockApi();

	// Canned proposal in the exact JSON shape defaultGroundedPlanner parses
	// (RefinementProposal: summary/rationale/edits/expectedOutcome).
	const cannedProposal = JSON.stringify({
		summary: "retry failed edit",
		rationale: "external_feedback reported status=fail",
		edits: [],
		expectedOutcome: "task passes on next attempt",
	});

	const mock = createMockModel({
		id: "mock-refine",
		responses: [{ content: [cannedProposal], usage: { input: 12, output: 34 } }],
	});

	const context = {
		messages: [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: "<external_feedback>\nstatus: fail\ntask: T\n</external_feedback>" }],
			},
		],
	};

	console.log("\ncalling completeSimple(mockModel, context) — no HTTP, no key:");
	const result = await completeSimple(mock as never, context as never, { maxTokens: 512 } as never);

	const text = result.content
		.filter((b: { type: string }) => b.type === "text")
		.map((b: { text: string }) => b.text)
		.join("");

	console.log("\n=== assertions ===");
	assert(present.length === 0, "no provider API key in environment (keyless)");
	assert(result.provider === "mock", `provider is mock (got ${result.provider})`);
	assert(result.stopReason === "stop", `stopReason=stop (got ${result.stopReason})`);
	assert(result.usage?.cost?.total === 0, `zero cost (got ${result.usage?.cost?.total})`);
	assert(mock.calls.length === 1, `mock recorded exactly one call (got ${mock.calls.length})`);
	const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
	assert(parsed.summary === "retry failed edit", "canned proposal JSON round-trips (planner-parseable)");
	assert(Array.isArray(parsed.edits), "proposal has edits array");

	console.log("\nSMOKE: PASS — keyless completeSimple path works; evo-on planner can run against a faux provider.");
}

main().catch((e) => {
	console.error("SMOKE: ERROR", e);
	process.exit(2);
});
