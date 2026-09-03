import type { Api, AssistantMessage, AssistantMessageEventStream, Model } from "@evopi/pi-ai";
import { createAssistantMessageEventStream } from "@evopi/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CredentialPool,
	createPoolResolver,
	envPoolVarName,
	getEnvCredentialPool,
	getEnvPoolKeys,
	isAuthRetryableAssistantError,
	rebindAuthHeader,
	withAuthStream,
} from "../src/core/auth-pool/index.js";

const MODEL: Model<Api> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "http://localhost/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
} as Model<Api>;

function message(overrides: Partial<AssistantMessage>): AssistantMessage {
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
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		provider: MODEL.provider,
		model: MODEL.id,
		api: MODEL.api,
		...overrides,
	} as AssistantMessage;
}

/** Script one attempt stream: events pushed synchronously, then ended. */
function scriptedStream(script: (stream: AssistantMessageEventStream) => void): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	script(stream);
	return stream;
}

function stream401(): AssistantMessageEventStream {
	return scriptedStream((s) => {
		const failure = message({ stopReason: "error", errorMessage: "HTTP 401: invalid api key" });
		s.push({ type: "start", partial: failure });
		s.push({ type: "error", reason: "error", error: failure });
		s.end(failure);
	});
}

function streamSuccess(text: string): AssistantMessageEventStream {
	return scriptedStream((s) => {
		const final = message({ content: [{ type: "text", text }] });
		s.push({ type: "start", partial: final });
		s.push({ type: "text_delta", contentIndex: 0, delta: text, partial: final });
		s.push({ type: "done", reason: "stop", message: final });
		s.end(final);
	});
}

async function collect(stream: AssistantMessageEventStream): Promise<{ types: string[]; final?: AssistantMessage }> {
	const types: string[] = [];
	let final: AssistantMessage | undefined;
	for await (const event of stream) {
		types.push(event.type);
		if (event.type === "done") final = event.message;
		if (event.type === "error") final = event.error;
	}
	return { types, final };
}

function poolResolver(keys: string[], primary?: string) {
	// No sessionId: a fresh pool's round-robin starts at index 0, keeping the
	// attempt order deterministic for these tests. (With a sessionId the order
	// starts at the FNV session hash — sticky, but index-dependent.)
	return createPoolResolver(new CredentialPool({ primary, pool: keys }));
}

describe("withAuthStream", () => {
	it("rotates silently on a pre-boundary 401 and delivers only the succeeding attempt", async () => {
		const attempts: string[] = [];
		const outer = withAuthStream(
			poolResolver(["k1", "k2"]),
			(key) => {
				attempts.push(key);
				return key === "k1" ? stream401() : streamSuccess("hello");
			},
			{ model: MODEL },
		);

		const { types, final } = await collect(outer);

		expect(attempts).toEqual(["k1", "k2"]);
		// Exactly one start (the successful attempt's), no error event leaked.
		expect(types.filter((t) => t === "start")).toHaveLength(1);
		expect(types).not.toContain("error");
		expect(types).toContain("done");
		expect(final?.stopReason).toBe("stop");
	});

	it("rotates on an SDK-shaped '401 <text>' terminal error (regression: v0.9.6 sandbox)", async () => {
		const attempts: string[] = [];
		const outer = withAuthStream(
			poolResolver(["bad-key", "good-key"]),
			(key) => {
				attempts.push(key);
				if (key === "bad-key") {
					return scriptedStream((s) => {
						const failure = message({ stopReason: "error", errorMessage: "401 invalid openai api key" });
						s.push({ type: "start", partial: failure });
						s.push({ type: "error", reason: "error", error: failure });
						s.end(failure);
					});
				}
				return streamSuccess("pong");
			},
			{ model: MODEL },
		);

		const { types, final } = await collect(outer);

		expect(attempts).toEqual(["bad-key", "good-key"]);
		expect(types).not.toContain("error");
		expect(final?.stopReason).toBe("stop");
	});

	it("never retries after a replay-unsafe event has been delivered", async () => {
		const attempts: string[] = [];
		const outer = withAuthStream(
			poolResolver(["k1", "k2"]),
			(key) => {
				attempts.push(key);
				return scriptedStream((s) => {
					const failure = message({ stopReason: "error", errorMessage: "HTTP 401: expired mid-stream" });
					s.push({ type: "start", partial: failure });
					s.push({ type: "text_delta", contentIndex: 0, delta: "partial text", partial: failure });
					s.push({ type: "error", reason: "error", error: failure });
					s.end(failure);
				});
			},
			{ model: MODEL },
		);

		const { types } = await collect(outer);

		expect(attempts).toEqual(["k1"]);
		expect(types).toEqual(["start", "text_delta", "error"]);
	});

	it("rotates through the whole pool on direct-rotation errors (403) and reports the last failure", async () => {
		// A 403/usage-limit failure is "direct credential rotation": every sibling
		// is tried. (A plain 401 gets refresh-same + ONE sibling switch by policy.)
		const attempts: string[] = [];
		const outer = withAuthStream(
			poolResolver(["k1", "k2", "k2", "k3"]),
			(key) => {
				attempts.push(key);
				return scriptedStream((s) => {
					const failure = message({ stopReason: "error", errorMessage: "HTTP 403: quota_exceeded" });
					s.push({ type: "start", partial: failure });
					s.push({ type: "error", reason: "error", error: failure });
					s.end(failure);
				});
			},
			{ model: MODEL },
		);

		const { types, final } = await collect(outer);

		// Pool deduped k2; every distinct credential attempted exactly once.
		expect(attempts).toEqual(["k1", "k2", "k3"]);
		expect(types).toEqual(["start", "error"]);
		expect(final?.errorMessage).toContain("403");
	});

	it("stops after one sibling switch on a plain 401 (legacy auth policy)", async () => {
		const attempts: string[] = [];
		const outer = withAuthStream(
			poolResolver(["k1", "k2", "k3"]),
			(key) => {
				attempts.push(key);
				return stream401();
			},
			{ model: MODEL },
		);

		const { types, final } = await collect(outer);

		expect(attempts).toEqual(["k1", "k2"]);
		expect(types).toEqual(["start", "error"]);
		expect(final?.errorMessage).toContain("401");
	});

	it("passes non-auth terminal errors through without rotation", async () => {
		const attempts: string[] = [];
		const outer = withAuthStream(
			poolResolver(["k1", "k2"]),
			(key) => {
				attempts.push(key);
				return scriptedStream((s) => {
					const failure = message({ stopReason: "error", errorMessage: "HTTP 500: internal server error" });
					s.push({ type: "start", partial: failure });
					s.push({ type: "error", reason: "error", error: failure });
					s.end(failure);
				});
			},
			{ model: MODEL },
		);

		const { types, final } = await collect(outer);

		expect(attempts).toEqual(["k1"]);
		expect(types).toEqual(["start", "error"]);
		expect(final?.errorMessage).toContain("500");
	});

	it("delivers an aborted terminal event untouched and stops rotating on abort", async () => {
		const controller = new AbortController();
		const attempts: string[] = [];
		const outer = withAuthStream(
			poolResolver(["k1", "k2"]),
			(key) => {
				attempts.push(key);
				controller.abort();
				return stream401();
			},
			{ model: MODEL, signal: controller.signal },
		);

		const { types } = await collect(outer);

		expect(attempts).toEqual(["k1"]);
		expect(types).toEqual(["start", "error"]);
	});

	it("terminates with a synthesized error when the resolver yields no key (no hang)", async () => {
		const outer = withAuthStream(
			async () => undefined,
			() => streamSuccess("never reached"),
			{ model: MODEL },
		);

		const { types, final } = await collect(outer);

		expect(types).toEqual(["error"]);
		expect(final?.errorMessage).toContain("No API key found");
	});
});

describe("isAuthRetryableAssistantError", () => {
	it("classifies SDK-shaped '<status> <text>' messages (live provider format)", () => {
		// openai-completions.ts stores `error.message` from the OpenAI SDK APIError,
		// which is "<status> <body>" — the exact text seen in the v0.9.6 sandbox check.
		expect(isAuthRetryableAssistantError({ stopReason: "error", errorMessage: "401 invalid openai api key" })).toBe(
			true,
		);
		expect(
			isAuthRetryableAssistantError({
				stopReason: "error",
				errorMessage: '403 {"type":"error","error":{"type":"permission_error","message":"forbidden"}}',
			}),
		).toBe(true);
		expect(isAuthRetryableAssistantError({ stopReason: "error", errorMessage: "500 internal server error" })).toBe(
			false,
		);
		// A bare number that is not a status prefix must not be mistaken for one.
		expect(isAuthRetryableAssistantError({ stopReason: "error", errorMessage: "401k plan parse failure" })).toBe(
			false,
		);
	});

	it("classifies terminal assistant errors", () => {
		expect(isAuthRetryableAssistantError({ stopReason: "error", errorMessage: "HTTP 401: bad key" })).toBe(true);
		expect(isAuthRetryableAssistantError({ stopReason: "error", errorMessage: "quota_exceeded for org" })).toBe(true);
		expect(isAuthRetryableAssistantError({ stopReason: "error", errorMessage: "HTTP 500: boom" })).toBe(false);
		expect(isAuthRetryableAssistantError({ stopReason: "aborted", errorMessage: "HTTP 401" })).toBe(false);
		expect(isAuthRetryableAssistantError({ stopReason: "error" })).toBe(false);
	});
});

describe("env pool + header rebind", () => {
	it("derives the variable name and parses comma-separated pools", () => {
		expect(envPoolVarName("prime-inference")).toBe("EVOPI_API_KEY_POOL_PRIME_INFERENCE");
		const env = { EVOPI_API_KEY_POOL_OPENAI: "a, b,,c " } as NodeJS.ProcessEnv;
		expect(getEnvPoolKeys("openai", env)).toEqual(["a", "b", "c"]);
		expect(getEnvPoolKeys("openai", {} as NodeJS.ProcessEnv)).toBeUndefined();
		expect(getEnvPoolKeys("openai", { EVOPI_API_KEY_POOL_OPENAI: "  " } as NodeJS.ProcessEnv)).toBeUndefined();
	});

	it("builds a pool with the primary first and returns undefined when unset (gating)", () => {
		const env = { EVOPI_API_KEY_POOL_OPENAI: "b,c" } as NodeJS.ProcessEnv;
		const pool = getEnvCredentialPool("openai", "a", env);
		expect(pool?.credentials).toEqual(["a", "b", "c"]);
		expect(getEnvCredentialPool("openai", "a", {} as NodeJS.ProcessEnv)).toBeUndefined();
	});

	it("rebinds Authorization only when derived from the primary key", () => {
		expect(rebindAuthHeader({ Authorization: "Bearer k1", "x-mode": "on" }, "k1", "k2")).toEqual({
			Authorization: "Bearer k2",
			"x-mode": "on",
		});
		// Header not derived from the primary key stays untouched.
		expect(rebindAuthHeader({ Authorization: "Bearer other" }, "k1", "k2")).toEqual({
			Authorization: "Bearer other",
		});
		expect(rebindAuthHeader(undefined, "k1", "k2")).toBeUndefined();
	});
});
