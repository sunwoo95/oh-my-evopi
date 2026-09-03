import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@evopi/pi-ai";
import { AssistantMessageEventStream } from "@evopi/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { applyOwnedDialectContext, resolveOwnedDialect, wrapOwnedDialectStream } from "../src/core/dialect-mode.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const originalEnvDialect = process.env.EVOPI_DIALECT;

function makeModel(id: string, provider = "local-llm"): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://localhost:11434/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	} as Model<Api>;
}

function registryWithModelsJson(dir: string, providers: Record<string, unknown>): ModelRegistry {
	const modelsJsonPath = join(dir, "models.json");
	writeFileSync(modelsJsonPath, JSON.stringify({ providers }, null, "\t"));
	return ModelRegistry.create(AuthStorage.inMemory(), modelsJsonPath);
}

const TOOLS: NonNullable<Context["tools"]> = [
	{
		name: "read_file",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
];

describe("resolveOwnedDialect", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "evopi-dialect-"));
		delete process.env.EVOPI_DIALECT;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (originalEnvDialect === undefined) delete process.env.EVOPI_DIALECT;
		else process.env.EVOPI_DIALECT = originalEnvDialect;
	});

	it("returns undefined with no configuration (default path stays untouched)", () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), join(dir, "models.json"));
		expect(resolveOwnedDialect(makeModel("qwen3-coder"), registry)).toBeUndefined();
	});

	it("reads an explicit models.json dialect field", () => {
		const registry = registryWithModelsJson(dir, {
			"local-llm": {
				baseUrl: "http://localhost:11434/v1",
				apiKey: "none",
				api: "openai-completions",
				models: [{ id: "my-model", dialect: "hermes" }],
			},
		});
		expect(resolveOwnedDialect(makeModel("my-model"), registry)).toBe("hermes");
	});

	it('resolves "auto" through the model-id heuristic and inherits provider-level dialect', () => {
		const registry = registryWithModelsJson(dir, {
			"local-llm": {
				baseUrl: "http://localhost:11434/v1",
				apiKey: "none",
				api: "openai-completions",
				dialect: "auto",
				models: [{ id: "qwen3-coder-30b" }, { id: "glm-4.7-flash" }],
			},
		});
		expect(resolveOwnedDialect(makeModel("qwen3-coder-30b"), registry)).toBe("qwen3");
		expect(resolveOwnedDialect(makeModel("glm-4.7-flash"), registry)).toBe("glm");
	});

	it("lets EVOPI_DIALECT override the model field, including disabling with off", () => {
		const registry = registryWithModelsJson(dir, {
			"local-llm": {
				baseUrl: "http://localhost:11434/v1",
				apiKey: "none",
				api: "openai-completions",
				models: [{ id: "my-model", dialect: "hermes" }],
			},
		});
		process.env.EVOPI_DIALECT = "glm";
		expect(resolveOwnedDialect(makeModel("my-model"), registry)).toBe("glm");
		process.env.EVOPI_DIALECT = "off";
		expect(resolveOwnedDialect(makeModel("my-model"), registry)).toBeUndefined();
	});

	it("falls back to native tools on an unknown value", () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), join(dir, "models.json"));
		process.env.EVOPI_DIALECT = "not-a-dialect";
		expect(resolveOwnedDialect(makeModel("my-model"), registry)).toBeUndefined();
	});
});

describe("applyOwnedDialectContext", () => {
	it("renders the tool catalog, re-encodes history, and strips native tools without mutating the input", () => {
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "read the readme", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "t1", name: "read_file", arguments: { path: "README.md" } }],
					timestamp: 2,
					stopReason: "toolUse",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					provider: "local-llm",
					model: "my-model",
					api: "openai-completions",
				} as unknown as Context["messages"][number],
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "read_file",
					content: [{ type: "text", text: "# readme" }],
					isError: false,
					timestamp: 3,
				} as unknown as Context["messages"][number],
			],
			tools: TOOLS,
		};
		const snapshot = JSON.stringify(context.messages);

		const owned = applyOwnedDialectContext(context, "hermes");

		expect(owned).toBeDefined();
		expect(owned!.context.tools).toBeUndefined();
		expect(owned!.context.systemPrompt).toContain("You are a helpful assistant.");
		expect(owned!.context.systemPrompt).toContain("read_file");
		// toolResult roles cannot survive: the wire history must be dialect text.
		expect(owned!.context.messages.some((message) => message.role === "toolResult")).toBe(false);
		expect(owned!.wireTools).toBe(TOOLS);
		// Input context untouched.
		expect(JSON.stringify(context.messages)).toBe(snapshot);
		expect(context.tools).toBe(TOOLS);
	});

	it("returns undefined when the context has no tools", () => {
		const context: Context = { systemPrompt: "sp", messages: [] };
		expect(applyOwnedDialectContext(context, "hermes")).toBeUndefined();
	});
});

describe("wrapOwnedDialectStream", () => {
	function partial(): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			timestamp: Date.now(),
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			provider: "local-llm",
			model: "my-model",
			api: "openai-completions",
		} as AssistantMessage;
	}

	it("re-materializes hermes in-band text as native toolcall events (real pi-ai stream objects)", async () => {
		const inner = new AssistantMessageEventStream();
		const wrapped = wrapOwnedDialectStream(inner, TOOLS, "hermes");

		const message = partial();
		const inband = '<tool_call>\n{"name": "read_file", "arguments": {"path": "README.md"}}\n</tool_call>';
		inner.push({ type: "start", partial: message });
		inner.push({ type: "text_start", contentIndex: 0, partial: message });
		inner.push({ type: "text_delta", contentIndex: 0, delta: inband, partial: message });
		inner.push({ type: "text_end", contentIndex: 0, content: inband, partial: message });
		inner.push({ type: "done", reason: "stop", message });
		inner.end(message);

		const events: string[] = [];
		let final: AssistantMessage | undefined;
		for await (const event of wrapped) {
			events.push(event.type);
			if (event.type === "done") final = event.message;
		}

		expect(events).toContain("toolcall_start");
		expect(events).toContain("toolcall_end");
		const toolCalls = final!.content.filter((block) => block.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toMatchObject({ name: "read_file", arguments: { path: "README.md" } });
		expect(final!.stopReason).toBe("toolUse");
	});

	it("passes plain text through unchanged", async () => {
		const inner = new AssistantMessageEventStream();
		const wrapped = wrapOwnedDialectStream(inner, TOOLS, "hermes");

		const message = partial();
		inner.push({ type: "start", partial: message });
		inner.push({ type: "text_delta", contentIndex: 0, delta: "just an answer", partial: message });
		inner.push({ type: "done", reason: "stop", message });
		inner.end(message);

		let final: AssistantMessage | undefined;
		for await (const event of wrapped) {
			if (event.type === "done") final = event.message;
		}

		const text = final!.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
		expect(text).toBe("just an answer");
		expect(final!.content.some((block) => block.type === "toolCall")).toBe(false);
	});

	it("aborts the provider on fabricated tool responses but still delivers the parsed toolcall", async () => {
		const inner = new AssistantMessageEventStream();
		let fabricated = false;
		const wrapped = wrapOwnedDialectStream(inner, TOOLS, "hermes", () => {
			fabricated = true;
		});

		const message = partial();
		const inband =
			'<tool_call>\n{"name": "read_file", "arguments": {"path": "README.md"}}\n</tool_call>\n<tool_response>\n{"fake": true}';
		inner.push({ type: "start", partial: message });
		inner.push({ type: "text_delta", contentIndex: 0, delta: inband, partial: message });

		let final: AssistantMessage | undefined;
		for await (const event of wrapped) {
			if (event.type === "done") final = event.message;
		}

		expect(fabricated).toBe(true);
		expect(final!.content.some((block) => block.type === "toolCall")).toBe(true);
	});
});
