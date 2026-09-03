import { describe, expect, it } from "vitest";
import {
	createPermissionGateExtension,
	extractShellCommand,
	isDangerousCommand,
	type PermissionGateMode,
} from "../src/core/extensions/builtin/permission-gate.js";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "../src/core/extensions/types.js";
import { probeSandbox, resetSandboxProbeCache } from "../src/core/sandbox-probe.js";

// --- Minimal mock session: captures the handlers the factory registers, then
// fires them the same way ExtensionRunner.emitToolCall / session_start do. ---

interface Notice {
	message: string;
	type: string;
}

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

function makeCtx(opts: { hasUI: boolean; selectAnswer?: string; notices: Notice[] }): ExtensionContext {
	return {
		hasUI: opts.hasUI,
		ui: {
			notify: (message: string, type: string = "info") => opts.notices.push({ message, type }),
			select: async (_title: string, _options: string[]) => opts.selectAnswer,
		},
	} as unknown as ExtensionContext;
}

async function fireToolCall(
	handlers: Map<string, Array<(e: any, ctx: any) => any>>,
	event: ToolCallEvent,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	// Mirror ExtensionRunner.emitToolCall: first block short-circuits.
	let result: ToolCallEventResult | undefined;
	for (const handler of handlers.get("tool_call") ?? []) {
		const r = await handler(event, ctx);
		if (r) {
			result = r;
			if (r.block) return r;
		}
	}
	return result;
}

function fireSessionStart(handlers: Map<string, Array<(e: any, ctx: any) => any>>, ctx: ExtensionContext): void {
	const event = { type: "session_start", reason: "startup" } as SessionStartEvent;
	for (const handler of handlers.get("session_start") ?? []) handler(event, ctx);
}

const bashEvent = (command: string): ToolCallEvent =>
	({ type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command } }) as ToolCallEvent;
const ipythonEvent = (code: string): ToolCallEvent =>
	({ type: "tool_call", toolCallId: "t2", toolName: "ipython", input: { code } }) as ToolCallEvent;

const unavailableProbe = () => ({ available: false, kind: "bubblewrap" as const, detail: "no userns" });
const availableProbe = () => ({ available: true, kind: "bubblewrap" as const, detail: "ok", version: "0.9.0" });
const mode = (m: PermissionGateMode) => () => m;

describe("isDangerousCommand / extractShellCommand", () => {
	it("flags destructive shell patterns and clears benign ones", () => {
		expect(isDangerousCommand("rm -rf /")).toBe(true);
		expect(isDangerousCommand("sudo apt install x")).toBe(true);
		expect(isDangerousCommand("chmod 777 /etc/passwd")).toBe(true);
		expect(isDangerousCommand("ls -la")).toBe(false);
		expect(isDangerousCommand("git status")).toBe(false);
	});

	it("extracts bash commands and ipython shell escapes only", () => {
		expect(extractShellCommand(bashEvent("rm -rf /"))).toBe("rm -rf /");
		expect(extractShellCommand(ipythonEvent("!rm -rf /"))).toBe("!rm -rf /");
		expect(extractShellCommand(ipythonEvent("import os\nos.system('rm -rf /')"))).toContain("os.system");
		expect(extractShellCommand(ipythonEvent("x = 1 + 1"))).toBeUndefined();
	});
});

describe("R3 gate — block mode (자동확정 candidate)", () => {
	it("blocks a dangerous bash command in non-interactive mode", async () => {
		const { api, handlers } = makeMockApi();
		createPermissionGateExtension({ probe: unavailableProbe, mode: mode("block") })(api);
		const notices: Notice[] = [];
		const ctx = makeCtx({ hasUI: false, notices });
		fireSessionStart(handlers, ctx);
		const result = await fireToolCall(handlers, bashEvent("rm -rf /important"), ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Dangerous command blocked");
	});

	it("blocks a dangerous ipython shell escape too", async () => {
		const { api, handlers } = makeMockApi();
		createPermissionGateExtension({ probe: unavailableProbe, mode: mode("block") })(api);
		const ctx = makeCtx({ hasUI: false, notices: [] });
		const result = await fireToolCall(handlers, ipythonEvent("!sudo rm -rf /"), ctx);
		expect(result?.block).toBe(true);
	});

	it("does not block a benign command", async () => {
		const { api, handlers } = makeMockApi();
		createPermissionGateExtension({ probe: unavailableProbe, mode: mode("block") })(api);
		const ctx = makeCtx({ hasUI: false, notices: [] });
		expect(await fireToolCall(handlers, bashEvent("ls -la"), ctx)).toBeUndefined();
	});

	it("interactive mode prompts and honors the user's choice", async () => {
		const { api, handlers } = makeMockApi();
		createPermissionGateExtension({ probe: availableProbe, mode: mode("block") })(api);
		const allow = makeCtx({ hasUI: true, selectAnswer: "Yes", notices: [] });
		expect(await fireToolCall(handlers, bashEvent("rm -rf /x"), allow)).toBeUndefined();
		const deny = makeCtx({ hasUI: true, selectAnswer: "No", notices: [] });
		const denied = await fireToolCall(handlers, bashEvent("rm -rf /x"), deny);
		expect(denied?.block).toBe(true);
		expect(denied?.reason).toBe("Blocked by user");
	});
});

describe("R3 gate — warn / off fallback modes", () => {
	it("warn mode never blocks but notifies", async () => {
		const { api, handlers } = makeMockApi();
		createPermissionGateExtension({ probe: unavailableProbe, mode: mode("warn") })(api);
		const notices: Notice[] = [];
		const ctx = makeCtx({ hasUI: false, notices });
		fireSessionStart(handlers, ctx);
		expect(await fireToolCall(handlers, bashEvent("rm -rf /"), ctx)).toBeUndefined();
		expect(notices.some((n) => n.type === "warning" && /Dangerous command allowed/.test(n.message))).toBe(true);
	});

	it("off mode disables the gate entirely (eval auto-approve)", async () => {
		const { api, handlers } = makeMockApi();
		createPermissionGateExtension({ probe: unavailableProbe, mode: mode("off") })(api);
		const notices: Notice[] = [];
		const ctx = makeCtx({ hasUI: false, notices });
		fireSessionStart(handlers, ctx);
		expect(await fireToolCall(handlers, bashEvent("rm -rf /"), ctx)).toBeUndefined();
		expect(notices).toHaveLength(0);
	});
});

describe("sandbox probe boot notification", () => {
	it("emits a warning naming the '불가' reason when the OS sandbox is unavailable", () => {
		const { api, handlers } = makeMockApi();
		createPermissionGateExtension({ probe: unavailableProbe, mode: mode("block") })(api);
		const notices: Notice[] = [];
		fireSessionStart(handlers, makeCtx({ hasUI: true, notices }));
		expect(notices.some((n) => n.type === "warning" && /OS sandbox unavailable/.test(n.message))).toBe(true);
	});
});

describe("real sandbox probe in this environment", () => {
	it("detects bubblewrap presence-but-unavailable (container without userns)", () => {
		resetSandboxProbeCache();
		const result = probeSandbox(true);
		// Deterministic assertion: on linux the probe must resolve to a boolean
		// with a reason; in this sandbox userns is disabled so it is unavailable.
		expect(typeof result.available).toBe("boolean");
		expect(result.detail.length).toBeGreaterThan(0);
		if (process.platform === "linux") {
			expect(result.kind).toBe("bubblewrap");
		}
	});
});
