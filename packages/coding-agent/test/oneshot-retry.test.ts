import type { AssistantMessage } from "@evopi/pi-ai";
import { describe, expect, it } from "vitest";
import {
	classifyOneshotFailure,
	extractRetryHintFromText,
	getRetryAfterMsFromHeaders,
	retryTransientCompletion,
} from "../src/core/auth-pool/oneshot-retry.js";

function message(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		timestamp: Date.now(),
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		provider: "test",
		model: "test-model",
		api: "anthropic-messages",
		...overrides,
	} as AssistantMessage;
}

const errorMessageOf = (text: string) => message({ stopReason: "error", errorMessage: text });

describe("classifyOneshotFailure", () => {
	it("classifies the documented marker sets", () => {
		expect(classifyOneshotFailure("overloaded_error: try later", undefined)).toBe("transient");
		expect(classifyOneshotFailure("HTTP 503 Service Unavailable", 503)).toBe("transient");
		// A 429 whose body names an account cap rotates as usage-limit; a 429 with
		// an uninformative body stays transient (both retry — lane differs).
		expect(classifyOneshotFailure("quota_exceeded for this billing period", 429)).toBe("usage-limit");
		expect(classifyOneshotFailure("rate limit exceeded, slow down", 429)).toBe("transient");
		expect(classifyOneshotFailure("prompt is too long: 250000 tokens", 400)).toBe("context-overflow");
		expect(classifyOneshotFailure("payload too large", 413)).toBe("payload-rejected");
		expect(classifyOneshotFailure("failed to parse tool call arguments as json", 500)).toBe("deterministic-parse");
		expect(classifyOneshotFailure("boom", undefined)).toBe("unknown");
	});
});

describe("retry hints", () => {
	it("parses body-text hints (ported pi-utils patterns)", () => {
		expect(extractRetryHintFromText("Please retry in 250ms")).toBe(250);
		expect(extractRetryHintFromText("try again in ~2 min")).toBe(120_000);
		expect(extractRetryHintFromText('"retryDelay": "1.5s"')).toBe(1500);
		expect(extractRetryHintFromText("no hint here")).toBeUndefined();
	});

	it("parses retry-after headers and takes the max candidate", () => {
		expect(getRetryAfterMsFromHeaders({ "retry-after": "2", "retry-after-ms": "1500" })).toBe(2000);
		expect(getRetryAfterMsFromHeaders({})).toBeUndefined();
	});
});

describe("retryTransientCompletion", () => {
	it("retries a transient resolved-error message and returns the recovery", async () => {
		let attempts = 0;
		const result = await retryTransientCompletion(
			async () => {
				attempts++;
				return attempts < 3 ? errorMessageOf("overloaded_error retry-after-ms=1") : message({});
			},
			{ baseDelayMs: 1, maxAttempts: 3 },
		);
		expect(attempts).toBe(3);
		expect(result.stopReason).toBe("stop");
	});

	it("returns a non-retryable failure unchanged on the first attempt", async () => {
		let attempts = 0;
		const result = await retryTransientCompletion(async () => {
			attempts++;
			return errorMessageOf("prompt is too long for this model");
		});
		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("rethrows non-retryable thrown errors unchanged", async () => {
		let attempts = 0;
		await expect(
			retryTransientCompletion(async () => {
				attempts++;
				throw new Error("HTTP 400: invalid request");
			}),
		).rejects.toThrow("invalid request");
		expect(attempts).toBe(1);
	});

	it("retries thrown transient errors and honors maxAttempts", async () => {
		let attempts = 0;
		await expect(
			retryTransientCompletion(
				async () => {
					attempts++;
					throw new Error("HTTP 503: overloaded");
				},
				{ baseDelayMs: 1, maxAttempts: 2 },
			),
		).rejects.toThrow("overloaded");
		expect(attempts).toBe(2);
	});

	it("surfaces the failure instead of parking when the hint exceeds maxDelayMs", async () => {
		let attempts = 0;
		const result = await retryTransientCompletion(
			async () => {
				attempts++;
				return errorMessageOf("rate_limit_error, try again in 10 min");
			},
			{ baseDelayMs: 1, maxAttempts: 3, maxDelayMs: 5_000 },
		);
		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
	});

	it("an abort during backoff rejects with the abort reason", async () => {
		const controller = new AbortController();
		const pending = retryTransientCompletion(async () => errorMessageOf("overloaded_error"), {
			baseDelayMs: 5_000,
			maxAttempts: 3,
			signal: controller.signal,
		});
		const reason = new Error("user cancelled");
		setTimeout(() => controller.abort(reason), 10);
		await expect(pending).rejects.toThrow("user cancelled");
	});
});
