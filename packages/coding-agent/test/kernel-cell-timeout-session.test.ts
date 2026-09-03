import { mkdirSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@evopi/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
} from "@evopi/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { DEFAULT_KERNEL_CELL_TIMEOUT_MS, SettingsManager } from "../src/core/settings-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_COMMAND_PLANE,
	type DaemonCommand,
	isDaemonMutatingCommand,
} from "../src/modes/daemon/daemon-protocol.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const ORIGINAL_ENV = process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS;

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function lastUserText(context: Context): string {
	const last = context.messages[context.messages.length - 1] as AgentMessage | undefined;
	if (!last || last.role !== "user") return "";
	if (typeof last.content === "string") return last.content;
	return last.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

type FakeKernelManager = {
	getActiveCellInfo: () => { elapsedMs: number; timeoutMs: number; timedOut: boolean } | undefined;
	setActiveCellTimeout: ReturnType<typeof vi.fn>;
};

describe("AgentSession /kernel timeout (A4)", () => {
	let tempDir: string;
	let sessions: AgentSession[] = [];

	beforeEach(() => {
		delete process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS;
		tempDir = join(tmpdir(), `evopi-kernel-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const session of sessions) session.dispose();
		sessions = [];
		rmSync(tempDir, { recursive: true, force: true });
		if (ORIGINAL_ENV === undefined) delete process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS;
		else process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS = ORIGINAL_ENV;
	});

	function createSession(options: { sessionManager?: SessionManager; settingsManager?: SettingsManager } = {}) {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = options.sessionManager ?? SessionManager.create(tempDir, join(tempDir, "sessions"));
		const settingsManager = options.settingsManager ?? SettingsManager.create(tempDir, tempDir);
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: (_model, context) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage(`echo: ${lastUserText(context)}`),
					});
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		return session;
	}

	function injectKernel(session: AgentSession, manager: FakeKernelManager | undefined): void {
		(session as unknown as { _ipythonKernelProvisioner: unknown })._ipythonKernelProvisioner = manager
			? { manager }
			: undefined;
	}

	function timeoutEntries(session: AgentSession) {
		return session.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "kernel_cell_timeout_state");
	}

	it("reports the default cap when nothing is configured", () => {
		const session = createSession();
		expect(session.getKernelCellTimeoutStatus()).toEqual({
			timeoutMs: DEFAULT_KERNEL_CELL_TIMEOUT_MS,
			source: "default",
		});
	});

	it("reports settings and env sources, and the env hint", () => {
		const fromSettings = createSession({
			settingsManager: SettingsManager.inMemory({ kernel: { cellTimeoutMs: 5_000 } }),
		});
		expect(fromSettings.getKernelCellTimeoutStatus()).toEqual({ timeoutMs: 5_000, source: "settings" });

		process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS = "off";
		const fromEnv = createSession({
			settingsManager: SettingsManager.inMemory({ kernel: { cellTimeoutMs: 5_000 } }),
		});
		expect(fromEnv.getKernelCellTimeoutStatus()).toEqual({ timeoutMs: 0, source: "env", envTimeoutMs: 0 });
	});

	it("sets a per-chat cap immediately, persists it without transcript messages and validates input", async () => {
		const session = createSession();
		const originalMessages = [...session.messages];

		await expect(session.setKernelCellTimeoutMs(-1)).rejects.toThrow("non-negative integer");
		await expect(session.setKernelCellTimeoutMs(1.5)).rejects.toThrow("non-negative integer");
		expect(timeoutEntries(session)).toHaveLength(0);

		const result = await session.setKernelCellTimeoutMs(90_000);
		expect(result).toEqual({
			timeoutMs: 90_000,
			source: "chat",
			appliedToRunningCell: false,
			runningCellTooLate: false,
			globalSaved: false,
		});
		expect(session.getKernelCellTimeoutStatus()).toEqual({ timeoutMs: 90_000, source: "chat" });
		expect(session.messages).toEqual(originalMessages);
		expect(timeoutEntries(session).at(-1)).toMatchObject({ data: { timeoutMs: 90_000 } });

		await session.setKernelCellTimeoutMs(0);
		expect(session.getKernelCellTimeoutStatus()).toEqual({ timeoutMs: 0, source: "chat" });
	});

	it("beats the env override once set in chat, but keeps the env hint", async () => {
		process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS = "1500";
		const session = createSession();
		expect(session.getKernelCellTimeoutStatus()).toEqual({ timeoutMs: 1_500, source: "env", envTimeoutMs: 1_500 });
		await session.setKernelCellTimeoutMs(5_000);
		expect(session.getKernelCellTimeoutStatus()).toEqual({ timeoutMs: 5_000, source: "chat", envTimeoutMs: 1_500 });
	});

	it("restores the chat cap on resume", async () => {
		const session = createSession();
		await session.setKernelCellTimeoutMs(45_000);
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Missing persisted session file");
		session.dispose();
		sessions = [];

		const resumed = createSession({ sessionManager: SessionManager.open(sessionFile, join(tempDir, "sessions")) });
		expect(resumed.getKernelCellTimeoutStatus()).toEqual({ timeoutMs: 45_000, source: "chat" });
	});

	it("drops the chat cap when navigating to a branch that predates it", async () => {
		const session = createSession();
		await session.prompt("baseline");
		await session.agent.waitForIdle();
		const baselineLeafId = session.sessionManager.getLeafId();
		if (!baselineLeafId) throw new Error("Missing baseline leaf");

		await session.setKernelCellTimeoutMs(7_000);
		expect(session.getKernelCellTimeoutStatus().source).toBe("chat");
		await session.navigateTree(baselineLeafId, { summarize: false });
		expect(session.getKernelCellTimeoutStatus()).toEqual({
			timeoutMs: DEFAULT_KERNEL_CELL_TIMEOUT_MS,
			source: "default",
		});
	});

	it("re-arms the running cell and reports when the cap already fired", async () => {
		const session = createSession();
		const setActiveCellTimeout = vi.fn(() => true);
		injectKernel(session, {
			getActiveCellInfo: () => ({ elapsedMs: 1_234, timeoutMs: 5_000, timedOut: false }),
			setActiveCellTimeout,
		});
		expect(session.getKernelCellTimeoutStatus().activeCell).toEqual({
			elapsedMs: 1_234,
			timeoutMs: 5_000,
			timedOut: false,
		});

		const applied = await session.setKernelCellTimeoutMs(60_000);
		expect(setActiveCellTimeout).toHaveBeenCalledWith(60_000);
		expect(applied.appliedToRunningCell).toBe(true);
		expect(applied.runningCellTooLate).toBe(false);

		injectKernel(session, {
			getActiveCellInfo: () => ({ elapsedMs: 5_100, timeoutMs: 5_000, timedOut: true }),
			setActiveCellTimeout: vi.fn(() => false),
		});
		const late = await session.setKernelCellTimeoutMs(120_000);
		expect(late.appliedToRunningCell).toBe(false);
		expect(late.runningCellTooLate).toBe(true);
		expect(late.timeoutMs).toBe(120_000);

		injectKernel(session, undefined);
		const idle = await session.setKernelCellTimeoutMs(1_000);
		expect(idle).toMatchObject({ appliedToRunningCell: false, runningCellTooLate: false });
		expect(session.getKernelCellTimeoutStatus().activeCell).toBeUndefined();
	});

	it("saves --global for new sessions while keeping this chat on the chat source", async () => {
		const session = createSession();
		const result = await session.setKernelCellTimeoutMs(60_000, { global: true });
		expect(result).toMatchObject({ timeoutMs: 60_000, source: "chat", globalSaved: true });
		expect(result.globalError).toBeUndefined();

		const fresh = SettingsManager.create(tempDir, tempDir);
		expect(fresh.getKernelCellTimeoutMs()).toBe(60_000);
		const next = createSession({
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions-2")),
			settingsManager: fresh,
		});
		expect(next.getKernelCellTimeoutStatus()).toEqual({ timeoutMs: 60_000, source: "settings" });
	});
});

describe("daemon protocol /kernel timeout commands", () => {
	it("schema-gates both commands at revision 26 and routes them to the session", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.get_kernel_cell_timeout_status).toEqual({
			minProtocol: 7,
			minSchemaRevision: 26,
		});
		expect(DAEMON_COMMAND_COMPATIBILITY.set_kernel_cell_timeout).toEqual({ minProtocol: 7, minSchemaRevision: 26 });
		expect(DAEMON_COMMAND_PLANE.get_kernel_cell_timeout_status).toBe("session");
		expect(DAEMON_COMMAND_PLANE.set_kernel_cell_timeout).toBe("session");
		expect(isDaemonMutatingCommand({ type: "get_kernel_cell_timeout_status" })).toBe(false);
		expect(isDaemonMutatingCommand({ type: "set_kernel_cell_timeout" })).toBe(true);
	});

	it("gets and sets the kernel cell timeout directly on the active session", async () => {
		const daemon = new AgentDaemon("/tmp/evopi-kernel-timeout-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/evopi-kernel-timeout-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const getKernelCellTimeoutStatus = vi.fn(() => ({ timeoutMs: 5_000, source: "chat" as const }));
		const setKernelCellTimeoutMs = vi.fn(async () => ({
			timeoutMs: 60_000,
			source: "chat" as const,
			appliedToRunningCell: true,
			runningCellTooLate: false,
			globalSaved: true,
		}));
		const state = {
			activeSessionId: "active-1",
			clients: new Set(),
			pendingAttaches: 0,
			lastEventSequence: 0,
			runtime: {
				metadata: { kind: "subagent", createdAt: 1 },
				session: { getKernelCellTimeoutStatus, setKernelCellTimeoutMs },
			},
		} as unknown as ActiveSessionState;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);
		const client: DaemonSocketClient = {
			id: "client-1",
			socket: { destroyed: false } as Socket,
			attachedActiveSessionIds: new Set([state.activeSessionId]),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		};

		await expect(
			internals.handleCommand(client, {
				type: "get_kernel_cell_timeout_status",
				activeSessionId: state.activeSessionId,
			}),
		).resolves.toMatchObject({ success: true, data: { timeoutMs: 5_000, source: "chat" } });
		await expect(
			internals.handleCommand(client, {
				type: "set_kernel_cell_timeout",
				activeSessionId: state.activeSessionId,
				timeoutMs: 60_000,
				global: true,
			}),
		).resolves.toMatchObject({
			success: true,
			data: { timeoutMs: 60_000, appliedToRunningCell: true, globalSaved: true },
		});
		expect(setKernelCellTimeoutMs).toHaveBeenCalledWith(60_000, { global: true });
	});
});
