/**
 * D2 steering/abort emulation at the session + wrapper layer (route (b); the frozen
 * packages/agent loop is untouched).
 *
 * Covers: steer during a tool batch rides the run (single agent_start, user message before the
 * next provider call), auto-resume after abort, interruptible tools aborted on steer while the
 * run continues, cooperative ctx.steeringSignal, sequential not-yet-started skip synthesis, queue
 * edits staying in sync with the mirrored agent queue, and the opt-out envs restoring the
 * pre-D2 behaviour.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@evopi/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Message,
	type ToolResultMessage,
} from "@evopi/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, resolveSteerAutoResume, resolveSteerDeliveryMode } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	STEERING_SKIPPED_TOOL_RESULT_TEXT,
	type ToolSteeringRuntime,
	wrapToolDefinition,
} from "../src/core/tools/tool-definition-wrapper.js";
import { formatAbortedTurnLabel } from "../src/modes/interactive/interactive-mode.js";
import { createTestResourceLoader } from "./utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: { ...zeroUsage, totalTokens: 0, cost: zeroUsage },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantToolCalls(names: string[]): AssistantMessage {
	return {
		...assistantText(""),
		content: names.map((name, index) => ({ type: "toolCall", id: `call-${name}-${index}`, name, arguments: {} })),
		stopReason: "toolUse",
	};
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function textOf(message: Message | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function toolResults(messages: Message[]): ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("D2 steering emulation", () => {
	let session: AgentSession | undefined;
	let tempDir: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `evopi-steer-emulation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		savedEnv.EVOPI_STEER_MODE = process.env.EVOPI_STEER_MODE;
		savedEnv.EVOPI_STEER_AUTO_RESUME = process.env.EVOPI_STEER_AUTO_RESUME;
		delete process.env.EVOPI_STEER_MODE;
		delete process.env.EVOPI_STEER_AUTO_RESUME;
	});

	afterEach(async () => {
		if (session) {
			await session.abort();
			session.dispose();
			session = undefined;
		}
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Scripted provider: each call consumes the next scripted assistant message; once the script
	 * is exhausted the stream blocks until aborted (so abort tests have a live run to interrupt).
	 */
	function createHarness(script: AssistantMessage[], customTools: ToolDefinition<any, any>[]) {
		const llmCalls: Message[][] = [];
		const events: string[] = [];
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, context, options) => {
				llmCalls.push(context.messages.map((message) => ({ ...message })));
				const stream = new MockAssistantStream();
				const next = script.shift();
				if (!next) {
					queueMicrotask(() => stream.push({ type: "start", partial: assistantText("") }));
					options?.signal?.addEventListener("abort", () =>
						stream.push({
							type: "error",
							reason: "aborted",
							error: { ...assistantText(""), stopReason: "aborted", errorMessage: "Request was aborted" },
						}),
					);
					return stream;
				}
				const message = { ...next, timestamp: Date.now() };
				queueMicrotask(() => {
					stream.push({ type: "start", partial: { ...message, content: [] } });
					stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
				});
				return stream;
			},
		});
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, tempDir),
			resourceLoader: createTestResourceLoader(),
			customTools,
		});
		session.subscribe((event) => {
			if (event.type === "agent_start" || event.type === "agent_end" || event.type === "turn_start") {
				events.push(event.type);
			}
		});
		return { session, llmCalls, events };
	}

	function gatedTool(
		name: string,
		options: { executionMode?: "sequential" | "parallel"; interruptible?: boolean } = {},
	) {
		const started = deferred();
		const gate = deferred();
		let executed = false;
		const definition: ToolDefinition<any, any> = {
			name,
			label: name,
			description: `${name} test tool`,
			parameters: Type.Object({}),
			executionMode: options.executionMode,
			interruptible: options.interruptible,
			execute: (_id, _params, signal) => {
				executed = true;
				started.resolve();
				return new Promise((resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error(`${name} interrupted`)), { once: true });
					void gate.promise.then(() =>
						resolve({ content: [{ type: "text", text: `${name} done` }], details: {} }),
					);
				});
			},
		};
		return { definition, started: started.promise, release: gate.resolve, wasExecuted: () => executed };
	}

	it("delivers a steer queued during a tool batch inside the same run, before the next provider call", async () => {
		const slow = gatedTool("slow_tool");
		const { session, llmCalls, events } = createHarness(
			[assistantToolCalls(["slow_tool"]), assistantText("done")],
			[slow.definition],
		);
		const running = session.prompt("start");
		await slow.started;
		await session.steer("steer msg");
		// Still owned (and editable) by the session until the loop drains it.
		expect(session.getSessionActionSnapshot().steering).toEqual(["steer msg"]);
		slow.release();
		await running;
		await session.waitForIdle();

		expect(events.filter((type) => type === "agent_start")).toHaveLength(1);
		expect(events.filter((type) => type === "agent_end")).toHaveLength(1);
		expect(llmCalls).toHaveLength(2);
		const second = llmCalls[1]!;
		expect(second.at(-1)?.role).toBe("user");
		expect(textOf(second.at(-1))).toBe("steer msg");
		expect(second.at(-2)?.role).toBe("toolResult");
		expect(session.getSessionActionSnapshot().queuedCount).toBe(0);
		expect(session.unfinishedActionCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("settles promptAndWait steering completion when the consuming run ends", async () => {
		const slow = gatedTool("slow_tool");
		const { session, events } = createHarness(
			[assistantToolCalls(["slow_tool"]), assistantText("done")],
			[slow.definition],
		);
		const running = session.prompt("start");
		await slow.started;
		const waited = session.promptAndWait("steered wait", { streamingBehavior: "steer" });
		await tick();
		slow.release();
		await expect(waited).resolves.toBeUndefined();
		await running;
		expect(events.filter((type) => type === "agent_start")).toHaveLength(1);
	});

	it("hard-aborts an interruptible tool on steer while the run continues", async () => {
		const wait = gatedTool("wait_tool", { interruptible: true });
		const { session, llmCalls, events } = createHarness(
			[assistantToolCalls(["wait_tool"]), assistantText("done")],
			[wait.definition],
		);
		const running = session.prompt("start");
		await wait.started;
		await session.steer("s");
		// Never released: only the steer can end the wait.
		await running;

		expect(events.filter((type) => type === "agent_start")).toHaveLength(1);
		expect(llmCalls).toHaveLength(2);
		const [result] = toolResults(llmCalls[1]!);
		expect(result?.isError).toBe(true);
		expect(textOf(result)).toBe("wait_tool interrupted");
		expect(textOf(llmCalls[1]!.at(-1))).toBe("s");
	});

	it("does not hard-abort a non-interruptible tool but exposes the cooperative ctx.steeringSignal", async () => {
		const observed: { hardAborted: boolean; steeringSignalSeen: boolean } = {
			hardAborted: false,
			steeringSignalSeen: false,
		};
		const started = deferred();
		const coop: ToolDefinition<any, any> = {
			name: "coop_tool",
			label: "coop",
			description: "cooperative",
			parameters: Type.Object({}),
			execute: (_id, _params, signal, _onUpdate, ctx: ExtensionContext) => {
				started.resolve();
				return new Promise((resolve) => {
					signal?.addEventListener("abort", () => {
						observed.hardAborted = true;
					});
					ctx.steeringSignal?.addEventListener(
						"abort",
						() => {
							observed.steeringSignalSeen = true;
							resolve({ content: [{ type: "text", text: "backgrounded" }], details: {} });
						},
						{ once: true },
					);
				});
			},
		};
		const { session, llmCalls } = createHarness([assistantToolCalls(["coop_tool"]), assistantText("done")], [coop]);
		const running = session.prompt("start");
		await started.promise;
		await session.steer("s");
		await running;

		expect(observed.steeringSignalSeen).toBe(true);
		expect(observed.hardAborted).toBe(false);
		const [result] = toolResults(llmCalls[1]!);
		expect(result?.isError).toBe(false);
		expect(textOf(result)).toBe("backgrounded");
		expect(textOf(llmCalls[1]!.at(-1))).toBe("s");
	});

	it("skips not-yet-started sequential tools with a synthesized result once a steer is pending", async () => {
		const a = gatedTool("seq_a", { executionMode: "sequential" });
		const b = gatedTool("seq_b", { executionMode: "sequential" });
		const { session, llmCalls, events } = createHarness(
			[assistantToolCalls(["seq_a", "seq_b"]), assistantText("done")],
			[a.definition, b.definition],
		);
		const running = session.prompt("start");
		await a.started;
		await session.steer("s");
		a.release();
		await running;

		expect(b.wasExecuted()).toBe(false);
		expect(events.filter((type) => type === "agent_start")).toHaveLength(1);
		const results = toolResults(llmCalls[1]!);
		expect(results.map((result) => result.toolName)).toEqual(["seq_a", "seq_b"]);
		expect(results[0]?.isError).toBe(false);
		expect(results[1]?.isError).toBe(true);
		expect(textOf(results[1])).toBe(STEERING_SKIPPED_TOOL_RESULT_TEXT);
		expect(textOf(llmCalls[1]!.at(-1))).toBe("s");
	});

	it("keeps the mirrored agent queue in sync with queue edits while steered", async () => {
		const slow = gatedTool("slow_tool");
		const { session, llmCalls } = createHarness(
			[assistantToolCalls(["slow_tool"]), assistantText("done"), assistantText("done again")],
			[slow.definition],
		);
		const running = session.prompt("start");
		await slow.started;
		await session.steer("s1");
		await session.steer("s2");
		expect(session.getSessionActionSnapshot().steering).toEqual(["s1", "s2"]);
		expect(session.mutateQueuedMessage("steering", 0, "s1", { type: "delete" })).toBe("applied");
		expect(
			session.mutateQueuedMessage("steering", 0, "s2", { type: "replace", text: "s2 edited", lane: "steering" }),
		).toBe("applied");
		slow.release();
		await running;
		await session.waitForIdle();

		expect(llmCalls).toHaveLength(2);
		const delivered = llmCalls[1]!.filter((message) => message.role === "user").map(textOf);
		expect(delivered).toEqual(["start", "s2 edited"]);
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("auto-resumes preserved steering/follow-up items once an interactive abort settles", async () => {
		const { session, llmCalls } = createHarness([], []);
		const running = session.prompt("running");
		await tick();
		await session.followUp("f1");
		await session.steer("s1");
		session.requestAbort();
		// prompt() settles only once session input is idle again, which the resumed
		// (blocking) queue prevents; observe the resume through the provider instead.
		void running.catch(() => {});

		await vi.waitFor(() => expect(llmCalls.length).toBeGreaterThanOrEqual(2));
		expect(session.isQueuedWorkSuspended).toBe(false);
		expect(textOf(llmCalls[1]!.at(-1))).toBe("s1"); // steering lane drains first
		expect(session.getSessionActionSnapshot().followUps).toEqual(["f1"]);
	});

	it("keeps manual resume after abort when EVOPI_STEER_AUTO_RESUME=off", async () => {
		process.env.EVOPI_STEER_AUTO_RESUME = "off";
		expect(resolveSteerAutoResume()).toBe(false);
		const { session, llmCalls } = createHarness([], []);
		const running = session.prompt("running");
		await tick();
		await session.followUp("f1");
		session.requestAbort();
		await running.catch(() => {});
		await session.agent.waitForIdle();
		await tick(50);

		expect(llmCalls).toHaveLength(1);
		expect(session.isQueuedWorkSuspended).toBe(true);
		expect(session.getSessionActionSnapshot().followUps).toEqual(["f1"]);
	});

	it("never auto-resumes after a programmatic abort()", async () => {
		const { session, llmCalls } = createHarness([], []);
		const running = session.prompt("running");
		await tick();
		await session.followUp("f1");
		await session.abort();
		await running.catch(() => {});
		await tick(50);

		expect(llmCalls).toHaveLength(1);
		expect(session.isQueuedWorkSuspended).toBe(true);
	});

	it("EVOPI_STEER_MODE=restart restores stop-and-restart delivery without skips or L2/L3 signals", async () => {
		process.env.EVOPI_STEER_MODE = "restart";
		expect(resolveSteerDeliveryMode()).toBe("restart");
		const a = gatedTool("seq_a", { executionMode: "sequential" });
		const b = gatedTool("seq_b", { executionMode: "sequential", interruptible: true });
		const { session, llmCalls, events } = createHarness(
			[assistantToolCalls(["seq_a", "seq_b"]), assistantText("done")],
			[a.definition, b.definition],
		);
		const running = session.prompt("start");
		await a.started;
		await session.steer("s");
		a.release();
		await b.started; // not skipped, and the steer did not abort it (no L2 signal)
		b.release();
		await running;
		await session.waitForIdle();

		expect(events.filter((type) => type === "agent_start")).toHaveLength(2);
		expect(llmCalls).toHaveLength(2);
		const results = toolResults(llmCalls[1]!);
		expect(results.map((result) => [result.toolName, result.isError])).toEqual([
			["seq_a", false],
			["seq_b", false],
		]);
		expect(textOf(llmCalls[1]!.at(-1))).toBe("s");
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});

	it("unifies the aborted-turn label for live and replayed turns", () => {
		expect(formatAbortedTurnLabel({ errorMessage: "Request was aborted" }, 0)).toBe("Operation aborted");
		expect(formatAbortedTurnLabel({ errorMessage: undefined }, 0, " · 3s")).toBe("Operation aborted · 3s");
		expect(formatAbortedTurnLabel({ errorMessage: "Interrupted by user" }, 0)).toBe("Interrupted by user");
		expect(formatAbortedTurnLabel({ errorMessage: "Request was aborted" }, 1)).toBe("Aborted after 1 retry attempt");
		expect(formatAbortedTurnLabel({ errorMessage: "x" }, 2, " · 1s")).toBe("Aborted after 2 retry attempts · 1s");
	});
});

describe("wrapToolDefinition steering seam", () => {
	const definition: ToolDefinition<any, any> = {
		name: "t",
		label: "t",
		description: "t",
		parameters: Type.Object({}),
		interruptible: (args) => (args as { hard?: boolean }).hard === true,
		execute: async (_id, _params, signal, _onUpdate, ctx) => ({
			content: [{ type: "text", text: signal?.aborted ? "aborted" : "ran" }],
			details: { steering: ctx?.steeringSignal?.aborted ?? null },
		}),
	};

	it("is byte-identical without a steering runtime", async () => {
		const tool = wrapToolDefinition(definition, undefined, () => undefined);
		const result = await tool.execute("1", {}, undefined, undefined);
		expect(result.content[0]).toEqual({ type: "text", text: "ran" });
		expect(result.details).toEqual({ steering: null });
	});

	it("rejects with the skip text when a steer is pending and combines signals only for interruptible calls", async () => {
		const controller = new AbortController();
		let pending = true;
		const runtime = (): ToolSteeringRuntime => ({ steeringSignal: controller.signal, steerPending: pending });
		const tool = wrapToolDefinition(definition, undefined, runtime);
		await expect(tool.execute("1", {}, undefined, undefined)).rejects.toThrow(STEERING_SKIPPED_TOOL_RESULT_TEXT);
		pending = false;
		controller.abort();
		const soft = await tool.execute("2", { hard: false }, undefined, undefined);
		expect(soft.content[0]).toEqual({ type: "text", text: "ran" });
		expect(soft.details).toEqual({ steering: true });
		const hard = await tool.execute("3", { hard: true }, new AbortController().signal, undefined);
		expect(hard.content[0]).toEqual({ type: "text", text: "aborted" });
	});
});
