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

	it("classifies EVOPI_* as client-scoped except EVOPI_INTERNAL_*", () => {
		expect(isClientScopedEnvKey("EVOPI_APPROVAL")).toBe(true);
		expect(isClientScopedEnvKey("EVOPI_API_KEY_POOL_OPENAI")).toBe(true);
		expect(isClientScopedEnvKey("EVOPI_INTERNAL_DAEMON_CATALOG")).toBe(false);
		expect(isClientScopedEnvKey("PATH")).toBe(false);
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
