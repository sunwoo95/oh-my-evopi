import { describe, expect, it } from "vitest";
import { isClientScopedEnvKey, workerBaseEnv } from "../src/modes/daemon/daemon-worker-env.js";

describe("daemon worker env (client-scoped EVOPI_* knobs)", () => {
	const supervisorEnv: NodeJS.ProcessEnv = {
		PATH: "/usr/bin",
		HOME: "/home/a",
		EVOPI_APPROVAL: "strict",
		EVOPI_EVO: "on",
		EVOPI_INTERNAL_DAEMON_CATALOG: "1",
		ANTHROPIC_API_KEY: "k",
	};

	it("classifies EVOPI_* as client-scoped except EVOPI_INTERNAL_* and the daemon-topology path vars", () => {
		expect(isClientScopedEnvKey("EVOPI_APPROVAL")).toBe(true);
		expect(isClientScopedEnvKey("EVOPI_API_KEY_POOL_OPENAI")).toBe(true);
		expect(isClientScopedEnvKey("EVOPI_INTERNAL_DAEMON_CATALOG")).toBe(false);
		expect(isClientScopedEnvKey("PATH")).toBe(false);
		// Structural, not a per-session runtime knob: stripping these left a worker's
		// self-healing replacement supervisor unable to find the real agent dir.
		expect(isClientScopedEnvKey("EVOPI_CODING_AGENT_DIR")).toBe(false);
		expect(isClientScopedEnvKey("EVOPI_SESSION_DIR")).toBe(false);
		expect(isClientScopedEnvKey("EVOPI_CODING_AGENT_SESSION_DIR")).toBe(false);
	});

	it("keeps EVOPI_CODING_AGENT_DIR through workerBaseEnv even with a client launch env", () => {
		const envWithAgentDir: NodeJS.ProcessEnv = { ...supervisorEnv, EVOPI_CODING_AGENT_DIR: "/tmp/real-agent-dir" };
		const base = workerBaseEnv(envWithAgentDir, { PATH: "/usr/bin" });
		expect(base.EVOPI_CODING_AGENT_DIR).toBe("/tmp/real-agent-dir");
	});

	it("drops the supervisor's EVOPI_* knobs when a client launch env is present", () => {
		const base = workerBaseEnv(supervisorEnv, { PATH: "/usr/bin", HOME: "/home/b" });
		expect(base).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/a",
			EVOPI_INTERNAL_DAEMON_CATALOG: "1",
			ANTHROPIC_API_KEY: "k",
		});
		// The overlay the supervisor applies afterwards reflects the client exactly:
		// a knob the client did not set stays unset (the v0.12.0 sticky-strict bug).
		const worker: NodeJS.ProcessEnv = { ...base, PATH: "/usr/bin", HOME: "/home/b" };
		expect(worker.EVOPI_APPROVAL).toBeUndefined();
		expect(worker.EVOPI_EVO).toBeUndefined();
	});

	it("lets the client's own EVOPI_* values win through the overlay", () => {
		const launchEnv = { EVOPI_APPROVAL: "yolo" };
		const worker: NodeJS.ProcessEnv = { ...workerBaseEnv(supervisorEnv, launchEnv), ...launchEnv };
		expect(worker.EVOPI_APPROVAL).toBe("yolo");
		expect(worker.EVOPI_EVO).toBeUndefined();
	});

	it("keeps the supervisor env unchanged for clients without a launch env (legacy)", () => {
		expect(workerBaseEnv(supervisorEnv, undefined)).toEqual(supervisorEnv);
	});
});
