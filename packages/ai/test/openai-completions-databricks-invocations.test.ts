import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Context, Model, Tool } from "../src/types.js";

type FetchImpl = typeof fetch;

interface FakeOpenAIClientOptions {
	apiKey: string;
	baseURL: string;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders?: Record<string, string>;
	fetch?: FetchImpl;
}

const mockState = vi.hoisted(() => ({
	lastClientOptions: undefined as FakeOpenAIClientOptions | undefined,
	lastCreateParams: undefined as { tools?: unknown[]; reasoning_effort?: string } | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: { tools?: unknown[]; reasoning_effort?: string }) => {
					mockState.lastCreateParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield { choices: [{ delta: {}, finish_reason: "stop" }], usage: undefined };
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({ data: stream, response: { status: 200, headers: new Headers() } });
					return promise;
				},
			},
		};

		constructor(options: FakeOpenAIClientOptions) {
			mockState.lastClientOptions = options;
		}
	}

	return { default: FakeOpenAI };
});

describe("openai-completions Databricks invocations rewrite", () => {
	beforeEach(() => {
		mockState.lastClientOptions = undefined;
		mockState.lastCreateParams = undefined;
	});

	function createModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
		return {
			id: "databricks-gpt-5-6-sol",
			name: "GPT 5.6 Sol",
			api: "openai-completions",
			provider: "databricks",
			baseUrl: "https://my-workspace.cloud.databricks.com/serving-endpoints/databricks-gpt-5-6-sol",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_096,
			...overrides,
		};
	}

	async function runRequest(model: Model<"openai-completions">) {
		await streamOpenAICompletions(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key" },
		).result();
		return mockState.lastClientOptions;
	}

	const echoTool: Tool = {
		name: "echo",
		description: "Echo the input",
		parameters: Type.Object({ text: Type.String() }),
	};

	async function runRequestWithTool(
		model: Model<"openai-completions">,
		options: { reasoningEffort?: "low" | "medium" | "high"; reasoningEnabled?: boolean } = {},
	) {
		const context: Context = {
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [echoTool],
		};
		await streamOpenAICompletions(model, context, { apiKey: "test-key", ...options }).result();
		return mockState.lastCreateParams;
	}

	it("gives a Databricks-provider model a fetch override that rewrites /chat/completions to /invocations", async () => {
		const options = await runRequest(createModel());

		expect(typeof options?.fetch).toBe("function");

		let seenUrl: string | undefined;
		const passthroughFetch = (async (url: Parameters<typeof fetch>[0]) => {
			seenUrl = typeof url === "string" ? url : url.toString();
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = passthroughFetch;
		try {
			await options?.fetch?.(
				"https://my-workspace.cloud.databricks.com/serving-endpoints/databricks-gpt-5-6-sol/chat/completions",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(seenUrl).toBe(
			"https://my-workspace.cloud.databricks.com/serving-endpoints/databricks-gpt-5-6-sol/invocations",
		);
	});

	it("detects Databricks purely from baseUrl even without provider set to databricks", async () => {
		const options = await runRequest(createModel({ provider: "custom-databricks-alias" }));
		expect(typeof options?.fetch).toBe("function");
	});

	it("gives a non-Databricks model no custom fetch at all", async () => {
		const options = await runRequest(
			createModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }),
		);
		expect(options?.fetch).toBeUndefined();
	});

	it("defaults reasoning_effort to none when tools are attached and no effort was requested", async () => {
		const params = await runRequestWithTool(createModel({ reasoning: true }));
		expect(params?.reasoning_effort).toBe("none");
	});

	it("forces reasoning_effort to none even when an explicit effort was requested, since this backend rejects tools with any other value", async () => {
		const params = await runRequestWithTool(createModel({ reasoning: true }), { reasoningEffort: "high" });
		expect(params?.reasoning_effort).toBe("none");
	});

	it("forces reasoning_effort to none for a caller-side default effort (e.g. DEFAULT_THINKING_LEVEL), not just an explicit user choice", async () => {
		// Regression test: the caller layer applies a non-undefined default reasoning
		// effort (DEFAULT_THINKING_LEVEL = "medium") whenever model.reasoning is true,
		// so reasoningEffort is essentially never undefined in real usage. An earlier
		// version of this fix only special-cased the undefined case and never actually
		// engaged.
		const params = await runRequestWithTool(createModel({ reasoning: true }), { reasoningEffort: "medium" });
		expect(params?.reasoning_effort).toBe("none");
	});

	it("does not inject reasoning_effort for a non-Databricks reasoning model with tools attached", async () => {
		const params = await runRequestWithTool(
			createModel({ reasoning: true, provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }),
		);
		expect(params?.reasoning_effort).toBeUndefined();
	});

	it("rejects tools client-side for a model marked supportsFunctionTools: false, without making a network call", async () => {
		// Regression: databricks-gpt-6-astra rejects function tools under every
		// reasoning_effort configuration (explicit values, "none", and the field
		// omitted entirely all 400) — the old blanket "force reasoning_effort to
		// none" override actively broke this model instead of fixing it, since "none"
		// isn't even a valid reasoning_effort value for it.
		const model = createModel({ reasoning: true, compat: { supportsFunctionTools: false } });
		const context: Context = {
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			tools: [echoTool],
		};
		const result = await streamOpenAICompletions(model, context, { apiKey: "test-key" }).result();
		expect(result.errorMessage).toMatch(/does not support function tools/);
		expect(mockState.lastCreateParams).toBeUndefined();
	});

	it("still attaches tools normally for a Databricks model without the supportsFunctionTools override", async () => {
		const params = await runRequestWithTool(createModel({ reasoning: true }));
		expect(params?.tools?.length).toBe(1);
	});

	async function reshapeThroughFetch(model: Model<"openai-completions">, response: Response): Promise<Response> {
		const options = await runRequest(model);
		const fakeFetch = (async () => response) as typeof fetch;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fakeFetch;
		try {
			return await options!.fetch!(
				"https://my-workspace.cloud.databricks.com/serving-endpoints/databricks-gpt-5-6-sol/chat/completions",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	it("reshapes a Databricks-shaped {error_code, message} 400 body into {error: {message}}", async () => {
		const raw = new Response(JSON.stringify({ error_code: "BAD_REQUEST", message: "tools need reasoning_effort" }), {
			status: 400,
		});
		const reshaped = await reshapeThroughFetch(createModel(), raw);
		expect(reshaped.status).toBe(400);
		const body = await reshaped.json();
		expect(body).toEqual({ error: { message: "tools need reasoning_effort", code: "BAD_REQUEST" } });
	});

	it("resolves a JSON-stringified nested message field before reshaping", async () => {
		const raw = new Response(
			JSON.stringify({ error_code: "BAD_REQUEST", message: JSON.stringify({ message: "nested detail" }) }),
			{ status: 400 },
		);
		const reshaped = await reshapeThroughFetch(createModel(), raw);
		const body = await reshaped.json();
		expect(body).toEqual({ error: { message: "nested detail", code: "BAD_REQUEST" } });
	});

	it("passes an already-shaped {error: {message}} body through unchanged", async () => {
		const raw = new Response(JSON.stringify({ error: { message: "already shaped" } }), { status: 400 });
		const reshaped = await reshapeThroughFetch(createModel(), raw);
		const body = await reshaped.json();
		expect(body).toEqual({ error: { message: "already shaped" } });
	});

	it("leaves a successful response completely untouched", async () => {
		const raw = new Response(JSON.stringify({ ok: true }), { status: 200 });
		const reshaped = await reshapeThroughFetch(createModel(), raw);
		expect(reshaped).toBe(raw);
	});
});
