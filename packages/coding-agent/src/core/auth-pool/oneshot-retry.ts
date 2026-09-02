/**
 * Transient-failure retry for **oneshot** (non-agent-loop) completions.
 *
 * Ported from omp `packages/ai/src/oneshot-retry.ts` (235 lines, Bun-free) with
 * the M8/M9 compat rule — reproduce only reachable behavior:
 * - omp's `AIError` bitflag classifier (flags.ts, 865 lines of provider text
 *   heuristics) is reduced to `classifyOneshotFailure` below: HTTP-status-driven
 *   plus the documented marker sets that the oneshot decision tree actually
 *   reads (context-overflow evidence list ported verbatim; content-blocked and
 *   transient markers reduced to documented cases; exotic inputs fall back to
 *   conservative non-retry).
 * - `extractRetryHint` (pi-utils fetch-retry.ts) is only ever called here with
 *   `source: undefined`, so just its body-text patterns are ported
 *   (`extractRetryHintFromText`).
 * - `retry-after.ts` header helpers are ported near-verbatim (self-contained).
 * - evopi's `AssistantMessage` has no `errorStatus` field, so for resolved
 *   error messages the HTTP status is recovered from the message text via the
 *   existing `status()` extractor.
 * - `Promise.withResolvers` (ES2024) replaced with manual resolvers (lib ES2022).
 *
 * Why this exists: `completeSimple` surfaces transient provider failures
 * (overloaded_error, rate_limit_error, HTTP 429/5xx) as a **resolved**
 * `AssistantMessage` with `stopReason: "error"`. Oneshots (summaries, titles,
 * refinement planning) have no replay hazard, so re-issuing the whole request
 * is safe and almost always what the caller wants.
 */

import type { AssistantMessage } from "@evopi/pi-ai";
import { isUsageLimitOutcome, status as statusOf } from "./classify.js";

export type HeadersLike = Headers | Record<string, string | undefined> | undefined | null;

export interface OneshotRetryOptions {
	/** Total attempts, including the first. Default 3. Values < 1 are treated as 1. */
	maxAttempts?: number;
	/** First backoff step in ms; doubles per attempt. Default 500. */
	baseDelayMs?: number;
	/**
	 * Upper bound for a single wait. Default 30_000. A provider retry hint
	 * longer than this aborts the retry instead of parking the caller.
	 */
	maxDelayMs?: number;
	/**
	 * Stops further attempts. This helper does NOT pass the signal into `run` —
	 * cancelling the in-flight request is the closure's job, because a
	 * per-attempt deadline must be rebuilt on every attempt.
	 */
	signal?: AbortSignal;
	/**
	 * Headers of the attempt that just failed, used to honor `retry-after`.
	 * A transient failure arrives as a **resolved** `AssistantMessage`, which
	 * carries no headers — callers that capture them via `onResponse` should
	 * return the latest capture here. Thrown errors need no wiring.
	 */
	getResponseHeaders?: () => HeadersLike;
	/** Observability hook. Fires immediately before sleeping. */
	onRetry?: (info: OneshotRetryInfo) => void;
}

/** Reduced classification label (omp uses `AIError` bitflags; see header note). */
export type OneshotFailureKind =
	| "abort"
	| "content-blocked"
	| "context-overflow"
	| "payload-rejected"
	| "deterministic-parse"
	| "transient"
	| "usage-limit"
	| "unknown";

export interface OneshotRetryInfo {
	/** 1-based index of the attempt that just failed. */
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	/** True when `delayMs` came from a provider retry hint rather than backoff. */
	fromRetryHint: boolean;
	errorMessage: string;
	/** Reduced classification of the failure (omp: `AIError` bit id). */
	kind: OneshotFailureKind;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
/** Cap on pure backoff growth. A provider hint may still exceed this, up to `maxDelayMs`. */
const BACKOFF_CEILING_MS = 8_000;
const RETRY_AFTER_MS_SUFFIX = /(?:^|\s)retry-after-ms=([0-9]+(?:\.[0-9]+)?)(?=\s|$)/i;

// llama.cpp reports deterministic tool-call JSON parse failures as HTTP 500.
// Replaying the same prompt produces the same malformed output. (omp flags.ts:212)
const LLAMA_CPP_TOOL_CALL_PARSE_PATTERN =
	/failed to parse tool call arguments as json|\[json\.exception\.parse_error\.101\]/i;

// Ported verbatim from omp flags.ts CONTEXT_OVERFLOW_EVIDENCE_PATTERNS.
const CONTEXT_OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter
	/exceeds the available context size/i, // llama.cpp server
	/requested tokens?.*exceed.*context (window|length|size)/i,
	/context (window|length|size).*(exceeded|overflow|too small)/i,
	/(prompt|input).*(too long|too large).*(context|n_ctx)/i,
	/requested tokens?.*(exceeds?|greater than).*(n_ctx|context)/i,
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
	/request_too_large[^\n]*\btokens?\b/i,
];

// Reduced marker sets (documented cases only; see header note).
const CONTENT_BLOCKED_PATTERN = /content_filter|content management policy|blocked by (?:the )?content|"SAFETY"/i;
const TRANSIENT_TEXT_PATTERN =
	/overloaded_error|rate_limit_error|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|socket hang up|fetch failed|network error|internal server error|service unavailable|bad gateway/i;

/** omp error/retryable.ts isTransientStatus, verbatim. */
export function isTransientStatus(status: number | undefined): boolean {
	return status !== undefined && (status === 408 || status === 429 || status >= 500);
}

export function classifyOneshotFailure(
	errorMessage: string,
	errorStatus: number | undefined,
	thrown?: unknown,
): OneshotFailureKind {
	if (
		(thrown instanceof Error && thrown.name === "AbortError") ||
		(thrown === undefined && /\baborted?\b/i.test(errorMessage) && errorMessage.length < 120)
	) {
		return "abort";
	}
	if (LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(errorMessage)) return "deterministic-parse";
	if (CONTENT_BLOCKED_PATTERN.test(errorMessage)) return "content-blocked";
	if (CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage))) return "context-overflow";
	if (errorStatus === 413) return "payload-rejected";
	if (isUsageLimitOutcome(errorStatus, errorMessage)) return "usage-limit";
	if (isTransientStatus(errorStatus) || TRANSIENT_TEXT_PATTERN.test(errorMessage)) return "transient";
	return "unknown";
}

/** Retryable when the provider says transient, or when it says "wait, then retry". */
function isRetryableOneshotFailure(kind: OneshotFailureKind): boolean {
	return kind === "transient" || kind === "usage-limit";
}

function backoffDelayMs(attempt: number, baseDelayMs: number): number {
	const growth = Math.min(baseDelayMs * 2 ** (attempt - 1), BACKOFF_CEILING_MS);
	// 75-100% jitter so a fleet of concurrent oneshots does not re-converge.
	return Math.round(growth * (0.75 + Math.random() * 0.25));
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("oneshot retry aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				reject(signal.reason ?? new Error("oneshot retry aborted"));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

// --- retry-after header helpers (omp utils/retry-after.ts, near-verbatim) ---

export function getRetryAfterMsFromHeaders(headers: HeadersLike): number | undefined {
	if (!headers) return undefined;

	const retryAfterMs = parseRetryAfterMsHeader(getHeaderValue(headers, "retry-after-ms"));
	const retryAfter = parseRetryAfterHeader(getHeaderValue(headers, "retry-after"));
	const resetMs = parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset-ms"), "ms");
	const resetSeconds = parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset"), "s");

	const candidates = [retryAfterMs, retryAfter, resetMs, resetSeconds].filter(
		(value): value is number => value !== undefined,
	);
	if (candidates.length === 0) return undefined;
	return Math.max(...candidates);
}

export function getHeadersFromError(error: unknown): HeadersLike {
	if (!error || typeof error !== "object") return undefined;
	const record = error as { headers?: unknown; response?: { headers?: unknown }; cause?: unknown };
	const direct = extractHeaders(record.headers) ?? extractHeaders(record.response?.headers);
	if (direct) return direct;
	if (record.cause) return getHeadersFromError(record.cause);
	return undefined;
}

function extractHeaders(value: unknown): HeadersLike {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (typeof value === "object") return value as Record<string, string | undefined>;
	return undefined;
}

function getHeaderValue(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
	if (headers instanceof Headers) {
		return headers.get(name) ?? undefined;
	}
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target && typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

/** `retry-after-ms` (Anthropic-style): a plain millisecond delta. */
function parseRetryAfterMsHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Number(value.trim());
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	return Math.ceil(ms);
}

function parseRetryAfterHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) {
		if (numeric <= 0) return undefined;
		return Math.ceil(numeric * 1000);
	}

	const dateMs = Date.parse(trimmed);
	if (!Number.isNaN(dateMs)) {
		const delay = dateMs - Date.now();
		return delay > 0 ? Math.ceil(delay) : undefined;
	}
	return undefined;
}

function parseResetHeader(value: string | undefined, unit: "ms" | "s"): number | undefined {
	if (!value) return undefined;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return undefined;

	const nowMs = Date.now();
	let targetMs: number | undefined;

	if (unit === "ms") {
		if (numeric > 1e12) targetMs = numeric;
		else if (numeric > 1e9) targetMs = numeric * 1000;
		else return Math.ceil(numeric);
	} else {
		if (numeric > 1e12) targetMs = numeric;
		else if (numeric > 1e9) targetMs = numeric * 1000;
		else return Math.ceil(numeric * 1000);
	}

	if (targetMs <= nowMs) return undefined;
	return Math.ceil(targetMs - nowMs);
}

// --- body-text retry hints (pi-utils fetch-retry.ts body half, verbatim patterns) ---

const QUOTA_RESET_PATTERN = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i;
const PLEASE_RETRY_PATTERN = /Please retry in ([0-9.]+)(ms|s)/i;
const RETRY_DELAY_FIELD_PATTERN = /"retryDelay":\s*"([0-9.]+)(ms|s)"/i;
const TRY_AGAIN_PATTERN = /try again in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
const WILL_RESET_IN_PATTERN = /(?:will\s+)?reset in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;

export function extractRetryHintFromText(body: string | undefined): number | undefined {
	if (!body) return undefined;

	const quotaMatch = QUOTA_RESET_PATTERN.exec(body);
	if (quotaMatch) {
		const hours = quotaMatch[1] ? Number.parseInt(quotaMatch[1], 10) : 0;
		const minutes = quotaMatch[2] ? Number.parseInt(quotaMatch[2], 10) : 0;
		const seconds = Number.parseFloat(quotaMatch[3]!);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			if (totalMs > 0) return totalMs;
		}
	}
	// Account-reset hints take precedence over short retry hints.
	for (const pattern of [WILL_RESET_IN_PATTERN, PLEASE_RETRY_PATTERN, RETRY_DELAY_FIELD_PATTERN, TRY_AGAIN_PATTERN]) {
		const match = pattern.exec(body);
		if (match?.[1]) {
			const value = Number.parseFloat(match[1]);
			if (Number.isFinite(value) && value > 0) {
				const unitMs = unitToMs(match[2]!);
				if (unitMs !== undefined) return value * unitMs;
			}
		}
	}
	return undefined;
}

function unitToMs(unit: string): number | undefined {
	switch (unit.toLowerCase()) {
		case "ms":
			return 1;
		case "s":
		case "sec":
			return 1000;
		case "m":
		case "min":
		case "mins":
		case "minute":
		case "minutes":
			return 60_000;
		case "h":
		case "hr":
		case "hrs":
		case "hour":
		case "hours":
			return 3_600_000;
		default:
			return undefined;
	}
}

/**
 * Run a oneshot completion, retrying transient provider failures.
 *
 * Handles both failure shapes: a resolved `AssistantMessage` carrying
 * `stopReason: "error"` (what `completeSimple` produces) and a thrown error.
 * A non-retryable failure is returned or rethrown unchanged.
 */
export async function retryTransientCompletion(
	run: (attempt: number) => Promise<AssistantMessage>,
	options?: OneshotRetryOptions,
): Promise<AssistantMessage> {
	const maxAttempts = Math.max(1, options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const signal = options?.signal;

	for (let attempt = 1; ; attempt++) {
		let message: AssistantMessage | undefined;
		let thrown: unknown;
		try {
			message = await run(attempt);
			if (message.stopReason !== "error") return message;
		} catch (error) {
			thrown = error;
		}
		// A caller abort is never a transient failure — surface it immediately.
		if (signal?.aborted) {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}

		const errorMessage =
			thrown !== undefined
				? thrown instanceof Error
					? thrown.message
					: String(thrown)
				: ((message as AssistantMessage).errorMessage ?? "unknown error");
		// evopi AssistantMessage carries no errorStatus; recover it from the text.
		const errorStatus = thrown !== undefined ? statusOf(thrown) : statusOf(new Error(errorMessage));
		const kind = classifyOneshotFailure(errorMessage, errorStatus, thrown);
		if (kind === "abort") {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}
		const lastAttempt = attempt >= maxAttempts;
		if (lastAttempt || !isRetryableOneshotFailure(kind)) {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}

		const headers: HeadersLike = thrown !== undefined ? getHeadersFromError(thrown) : options?.getResponseHeaders?.();
		const headerHintMs = getRetryAfterMsFromHeaders(headers);
		const extractedTextHintMs = extractRetryHintFromText(errorMessage);
		const suffixValue = RETRY_AFTER_MS_SUFFIX.exec(errorMessage)?.[1];
		const parsedSuffixMs = suffixValue === undefined ? undefined : Number(suffixValue);
		const suffixHintMs =
			parsedSuffixMs !== undefined && Number.isFinite(parsedSuffixMs) && parsedSuffixMs > 0
				? Math.ceil(parsedSuffixMs)
				: undefined;
		const textHintMs =
			extractedTextHintMs === undefined && suffixHintMs === undefined
				? undefined
				: Math.max(extractedTextHintMs ?? 0, suffixHintMs ?? 0);
		const hintMs =
			headerHintMs === undefined && textHintMs === undefined
				? undefined
				: Math.max(headerHintMs ?? 0, textHintMs ?? 0);
		// An over-cap hint means "come back much later"; surface the failure instead.
		if (hintMs !== undefined && hintMs > maxDelayMs) {
			if (thrown !== undefined) throw thrown;
			return message as AssistantMessage;
		}
		const backoff = backoffDelayMs(attempt, baseDelayMs);
		const delayMs = Math.min(Math.max(hintMs ?? 0, backoff), maxDelayMs);

		options?.onRetry?.({
			attempt,
			maxAttempts,
			delayMs,
			fromRetryHint: hintMs !== undefined && hintMs >= backoff,
			errorMessage,
			kind,
		});
		// Aborting mid-backoff rejects with the caller's abort reason.
		await sleep(delayMs, signal);
	}
}
