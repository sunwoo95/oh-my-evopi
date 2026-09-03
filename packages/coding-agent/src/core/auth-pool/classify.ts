/**
 * Self-contained error-classification layer for the auth-pool retry driver.
 *
 * Upstream (`@oh-my-pi/pi-ai`) splits these across `error/{auth-classify,flags,
 * rate-limit}` (≈1350 lines) plus `@oh-my-pi/pi-utils`. evopi's `@evopi/pi-ai`
 * has no `error` module at all, so — mirroring the M8 dialect `compat/` port —
 * the classifiers the retry state machine actually consults are reproduced here
 * as a self-contained module.
 *
 * Scope note: the retry a/b/c policy only needs to route between
 * "refresh-same" / "rotate-sibling" / "not-retryable", which is driven by HTTP
 * status (401 → refresh then rotate; 403/usage-limit → direct rotate) plus a
 * handful of body markers. The full upstream text classifiers carry dozens of
 * provider-specific regexes (Codex `cyber_policy`, Google RPC reasons, CN quota
 * phrasing, DashScope token caps, …); those are deliberately reduced here to a
 * documented marker set. On-wire behavior for the common providers is
 * preserved; exotic provider-specific quota phrasings fall back to the
 * conservative status-driven decision rather than a bespoke branch.
 */

/** Whether an OAuth failure represents an explicit token-refresh request vs a hard failure. */
export type OAuthErrorKind = "http" | "token-refresh" | "token-invalidated" | "timeout" | "polling";

export interface OAuthErrorOptions {
	kind?: OAuthErrorKind;
	provider?: string;
	status?: number;
	cause?: unknown;
}

/** Port of `@oh-my-pi/pi-ai` `error/oauth.ts` `OAuthError`, without the flag-attachment machinery. */
export class OAuthError extends Error {
	readonly kind: OAuthErrorKind;
	readonly provider: string | undefined;
	readonly status: number | undefined;

	constructor(message: string, options: OAuthErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "OAuthError";
		this.kind = options.kind ?? "http";
		this.provider = options.provider;
		this.status = options.status;
	}
}

/** Port of `@oh-my-pi/pi-ai` `error/auth.ts` `MissingApiKeyError`. */
export class MissingApiKeyError extends Error {
	readonly provider: string | undefined;

	constructor(provider?: string, message?: string) {
		super(message ?? (provider ? `No API key for provider: ${provider}` : "No API key available"));
		this.name = "MissingApiKeyError";
		this.provider = provider;
	}
}

const STATUS_MESSAGE_PATTERNS: readonly RegExp[] = [
	/\berror\s*[:=]\s*(\d{3})\b/i,
	/error\s*\((\d{3})\)/i,
	/status\s*[:=]?\s*(\d{3})/i,
	/\bhttp\s*(\d{3})\b/i,
	/\b(\d{3})\s*(?:status|error)\b/i,
];

function extractStatusFromMessage(message: string): number | undefined {
	for (const pattern of STATUS_MESSAGE_PATTERNS) {
		const match = pattern.exec(message);
		if (!match) continue;
		const value = Number(match[1]);
		if (Number.isFinite(value) && value >= 100 && value <= 599) return value;
	}
	return undefined;
}

type HttpErrorLike = {
	message?: string;
	name?: string;
	status?: number | string;
	statusCode?: number | string;
	response?: { status?: number | string };
	cause?: unknown;
};

function extractHttpStatusFromErrorInternal(error: unknown, depth: number): number | undefined {
	if (!error || typeof error !== "object" || depth > 2) return undefined;
	const info = error as HttpErrorLike;
	const rawStatus = info.status ?? info.statusCode ?? info.response?.status;

	let status: number | undefined;
	if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
		status = rawStatus;
	} else if (typeof rawStatus === "string") {
		const parsed = Number(rawStatus);
		if (Number.isFinite(parsed)) status = parsed;
	}
	if (status !== undefined && status >= 100 && status <= 599) return status;

	if (info.message) {
		const extracted = extractStatusFromMessage(info.message);
		if (extracted !== undefined) return extracted;
	}
	if (info.cause) return extractHttpStatusFromErrorInternal(info.cause, depth + 1);
	return undefined;
}

/**
 * Port of `@oh-my-pi/pi-utils` `extractHttpStatusFromError`: reads
 * `status`/`statusCode`/`response.status`, then a status embedded in the
 * message, then recurses one level into `cause` (depth-capped at 2). Also
 * covers the `AIError.status` accessor the retry driver imports under that name.
 */
export function extractHttpStatusFromError(error: unknown): number | undefined {
	return extractHttpStatusFromErrorInternal(error, 0);
}

/** Alias for the upstream `AIError.status` accessor (same status-extraction contract). */
export const status = extractHttpStatusFromError;

function messageOf(error: unknown): string | undefined {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (typeof error === "object" && error !== null && "message" in error) {
		const m = (error as { message?: unknown }).message;
		if (typeof m === "string") return m;
	}
	return undefined;
}

const INVALIDATED_OAUTH_TOKEN_PATTERN = /\binvalidated oauth token\b/i;

/** Whether an upstream response explicitly says the supplied OAuth bearer was invalidated. */
export function isInvalidatedOAuthTokenError(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "errorMessage" in error) {
		const errObj = error as { errorMessage?: unknown; errorClassificationMessage?: unknown };
		const errorMessage =
			"errorClassificationMessage" in errObj ? errObj.errorClassificationMessage : errObj.errorMessage;
		if (typeof errorMessage === "string" && INVALIDATED_OAUTH_TOKEN_PATTERN.test(errorMessage)) return true;
	}
	const message = messageOf(error);
	return message !== undefined && INVALIDATED_OAUTH_TOKEN_PATTERN.test(message);
}

// Documented usage-limit / account-cap markers (reduced from the upstream
// provider-specific pattern tables to the common cross-provider phrasings).
const USAGE_LIMIT_PATTERN =
	/\b(usage[_ ]?limit(?:_reached)?|quota[_ ]?exceeded|insufficient[_ ]?quota|resource[_ ]?exhausted|quota_exhausted|out of credits|spend limit|billing (?:hard )?cap|monthly limit reached|daily limit reached)\b/i;
const ACCOUNT_SCOPED_403_PATTERN =
	/\b(reached (?:overall|account) (?:message )?rate limit|your limit will reset|account.*(?:rate ?limit|quota))\b/i;
const CONCURRENCY_CAP_PATTERN = /\b(concurrent(?:_| )limit|too many concurrent|concurrency (?:cap|limit))\b/i;
const ACCOUNT_POLICY_PATTERN =
	/\b(cyber_policy|account.*polic|permission_denied|org(?:anization)? (?:restrict|polic))\b/i;

/**
 * A concurrency cap on a non-billing status is shed-and-backoff, not
 * credential-rotatable (a 402 remains an account-billing cap). Mirrors
 * `rate-limit.ts` `isConcurrencyCapExclusion`.
 */
export function isConcurrencyCapExclusion(status: number | undefined, message: string | undefined): boolean {
	return message !== undefined && CONCURRENCY_CAP_PATTERN.test(message) && status !== 402;
}

/**
 * Whether a status/message pair names an account-scoped usage/quota cap that
 * warrants rotating to a sibling credential (vs the caller's backoff lane).
 * Reduced form of `rate-limit.ts` `isUsageLimitOutcome`.
 */
export function isUsageLimitOutcome(status: number | undefined, message: string | undefined): boolean {
	if (isConcurrencyCapExclusion(status, message)) return false;
	if (message && USAGE_LIMIT_PATTERN.test(message)) return true;
	// A 403 or statusless account-scoped cap resets → rotate; a bare 403 stays auth.
	if ((status === 403 || status === undefined) && message && ACCOUNT_SCOPED_403_PATTERN.test(message)) return true;
	// A bare 429/402 with no informative body rotates conservatively.
	if (status === 429 || status === 402) {
		if (!message) return true;
		return USAGE_LIMIT_PATTERN.test(message) || ACCOUNT_SCOPED_403_PATTERN.test(message);
	}
	return false;
}

/** Reduced form of `flags.ts` `isUsageLimit`. */
export function isUsageLimit(error: unknown): boolean {
	const message = messageOf(error);
	const httpStatus = extractHttpStatusFromError(error);
	return isUsageLimitOutcome(httpStatus, message);
}

/** Reduced form of `flags.ts` `isAccountPolicyError`. */
export function isAccountPolicyError(error: unknown): boolean {
	const message = messageOf(error);
	return message !== undefined && ACCOUNT_POLICY_PATTERN.test(message);
}

/**
 * Whether an upstream failure should retry through the credential resolver.
 * Port of `auth-classify.ts` `isAuthRetryableError`, over the reduced classifiers
 * above: a typed token-refresh request, a usage limit, an account policy denial,
 * an invalidated OAuth bearer, a 401/403, or a body-classified usage limit.
 * Transient concurrency-cap 403s stay in the upstream-backoff lane.
 */
export function isAuthRetryableError(error: unknown): boolean {
	if (error instanceof OAuthError && error.kind === "token-refresh") return true;
	if (isUsageLimit(error)) return true;
	if (isAccountPolicyError(error)) return true;
	if (isInvalidatedOAuthTokenError(error)) return true;
	const httpStatus = extractHttpStatusFromError(error);
	const message = messageOf(error);
	if (isConcurrencyCapExclusion(httpStatus, message)) return false;
	if (httpStatus === 401 || httpStatus === 403) return true;
	return isUsageLimitOutcome(httpStatus, message);
}
