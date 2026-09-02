import { describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
		].join("\n");

		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		messages = {
			create: () => ({
				asResponse: async () => createSseResponse(),
			}),
		};
	}

	return { default: FakeAnthropic };
});

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

const databricksModel: Model<"anthropic-messages"> = {
	id: "databricks-claude-sonnet-5",
	name: "Claude Sonnet 5",
	api: "anthropic-messages",
	provider: "databricks",
	baseUrl: "https://my-workspace.cloud.databricks.com/serving-endpoints/anthropic",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
};

describe("Anthropic Messages bearer auth (Databricks-style endpoints)", () => {
	it("drops x-api-key when a custom Authorization header is supplied", async () => {
		const { streamAnthropic } = await import("../src/providers/anthropic.js");
		const s = streamAnthropic(databricksModel, context, {
			apiKey: "dapi-test-token",
			headers: {
				Authorization: "Bearer dapi-test-token",
				"x-databricks-use-coding-agent-mode": "true",
			},
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}

		const opts = mockState.constructorOpts!;
		expect(opts).toBeDefined();
		// The SDK derives x-api-key from `apiKey`; a custom Authorization header
		// must replace it entirely (Claude Code's ANTHROPIC_AUTH_TOKEN contract).
		expect(opts.apiKey).toBeNull();
		expect(opts.baseURL).toBe(databricksModel.baseUrl);
		const headers = opts.defaultHeaders as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer dapi-test-token");
		expect(headers["x-databricks-use-coding-agent-mode"]).toBe("true");
	});

	it("keeps x-api-key auth when no Authorization header is supplied", async () => {
		const { streamAnthropic } = await import("../src/providers/anthropic.js");
		const s = streamAnthropic(databricksModel, context, { apiKey: "sk-ant-regular-key" });
		for await (const event of s) {
			if (event.type === "error") break;
		}

		const opts = mockState.constructorOpts!;
		expect(opts.apiKey).toBe("sk-ant-regular-key");
	});
});
