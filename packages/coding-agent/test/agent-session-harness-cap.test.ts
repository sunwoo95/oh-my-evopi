/**
 * B4 cap plumbing: AgentSession passes `settingsManager.getHarnessCapPerKind()`
 * into both the planning call and the apply call of a refinement, and passes
 * nothing when the cap is unresolved (evo off, unset), keeping prime behavior.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@evopi/pi-agent-core";
import { getModel } from "@evopi/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const { planRefinementMock, applyRefinementProposalSpy } = vi.hoisted(() => ({
	planRefinementMock: vi.fn(),
	applyRefinementProposalSpy: vi.fn(),
}));

vi.mock("../src/core/refinement/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/refinement/index.js")>();
	applyRefinementProposalSpy.mockImplementation(actual.applyRefinementProposal);
	return { ...actual, planRefinement: planRefinementMock, applyRefinementProposal: applyRefinementProposalSpy };
});

const model = getModel("anthropic", "claude-sonnet-4-5")!;

describe("AgentSession harness cap plumbing (B4)", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "evopi-harness-cap-"));
		for (const key of [ENV_AGENT_DIR, "EVOPI_EVO", "EVOPI_HARNESS_CAP_PER_KIND"]) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		const agentDir = join(tempDir, "agent");
		process.env[ENV_AGENT_DIR] = agentDir;
		mkdirSync(agentDir, { recursive: true });
		planRefinementMock.mockReset();
		planRefinementMock.mockImplementation(async () => ({
			proposal: { summary: "noop", rationale: "test", edits: [], expectedOutcome: "none" },
			id: "refine_20260903000000000",
		}));
		applyRefinementProposalSpy.mockClear();
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(overrides: Record<string, unknown> = {}): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settingsManager = SettingsManager.create(tempDir, join(tempDir, "agent"));
		settingsManager.applyOverrides(overrides);
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: () => {
				throw new Error("no model calls expected");
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	it("passes the configured cap to the planner and the apply step", async () => {
		const root = createSession({ harness: { capPerKind: 3 } });
		const result = await root.refine({ global: true });
		expect(result.id).toBe("refine_20260903000000000");
		expect(planRefinementMock).toHaveBeenCalledTimes(1);
		expect(planRefinementMock.mock.calls[0][5]).toEqual({ global: true, capPerKind: 3 });
		expect(applyRefinementProposalSpy).toHaveBeenCalledTimes(1);
		expect(applyRefinementProposalSpy.mock.calls[0][2]).toMatchObject({
			id: "refine_20260903000000000",
			scope: "global",
			capPerKind: 3,
		});
	});

	it("lets EVOPI_HARNESS_CAP_PER_KIND override the setting", async () => {
		process.env.EVOPI_HARNESS_CAP_PER_KIND = "5";
		const root = createSession({ harness: { capPerKind: 3 } });
		await root.refine({ global: true });
		expect(planRefinementMock.mock.calls[0][5]).toEqual({ global: true, capPerKind: 5 });
		expect(applyRefinementProposalSpy.mock.calls[0][2]).toMatchObject({ capPerKind: 5 });
	});

	it("passes no cap at all when evo is off and nothing is configured (prime behavior)", async () => {
		const root = createSession();
		await root.refine({ global: true, instructions: "keep it" });
		expect(planRefinementMock.mock.calls[0][5]).toEqual({ global: true, instructions: "keep it" });
		expect(planRefinementMock.mock.calls[0][5]).not.toHaveProperty("capPerKind");
		expect(applyRefinementProposalSpy.mock.calls[0][2]).not.toHaveProperty("capPerKind");
	});
});
