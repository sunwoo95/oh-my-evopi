import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Model } from "../src/types.js";

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
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
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
});
