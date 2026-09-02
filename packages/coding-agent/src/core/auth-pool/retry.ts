/**
 * Backport of `@oh-my-pi/pi-ai` `auth-retry.ts` (the bounded a/b/c credential
 * retry policy), rewired onto the self-contained {@link ./classify.js} layer.
 * The upstream file is Bun-free; only its `error`/`pi-utils` imports are
 * redirected here. `withOAuthAccess` (which depends on the full AuthStorage
 * `OAuthAccess` shape) is out of scope for the v1 pool; the exported surface is
 * the API-key resolver contract plus {@link withAuth}, which the pool resolver
 * (see {@link ./pool.js}) drives.
 */
import {
	extractHttpStatusFromError,
	isAccountPolicyError,
	isAuthRetryableError,
	isConcurrencyCapExclusion,
	isInvalidatedOAuthTokenError,
	isUsageLimit,
	isUsageLimitOutcome,
	MissingApiKeyError,
	OAuthError,
	status as errorStatus,
} from "./classify.js";

/**
 * Context passed to an {@link ApiKeyResolver} on each resolution attempt.
 *
 * - `error === undefined` → **initial resolve** (cheap; may return a cached key).
 * - `error !== undefined && !lastChance` → **step (b): refresh the SAME account**.
 * - `error !== undefined && lastChance` → **step (c): rotate to a sibling**.
 */
export interface ApiKeyResolveContext {
	/** True when the resolver should rotate to a sibling credential. */
	lastChance: boolean;
	/** The auth error that triggered this re-resolution, or `undefined` on the initial resolve. */
	error: unknown;
	/** Bearer used by the failed attempt, when the caller can expose it. */
	previousKey?: string;
	/** Caller cancel signal, threaded into any credential refresh / rotation work. */
	signal?: AbortSignal;
}

/** Resolves the API key to send for a request, retried through the a/b/c policy. */
export type ApiKeyResolver = (ctx: ApiKeyResolveContext) => Promise<string | undefined> | string | undefined;

/** A static bearer string, or a {@link ApiKeyResolver} that mints/rotates one. */
export type ApiKey = string | ApiKeyResolver;

/** Narrows {@link ApiKey} to its resolver form. */
export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return typeof key === "function";
}

/** Performs the initial resolve of an {@link ApiKey} (`error: undefined`, `lastChance: false`). */
export async function resolveApiKeyOnce(key: ApiKey | undefined, signal?: AbortSignal): Promise<string | undefined> {
	if (key === undefined) return undefined;
	if (isApiKeyResolver(key)) return (await key({ lastChance: false, error: undefined, signal })) || undefined;
	return key;
}

/**
 * Wraps a resolver with a bearer already selected for this request: the first
 * initial resolution reuses `seed`, all later resolutions delegate to `resolver`.
 */
export function seedApiKeyResolver(seed: string | undefined, resolver: ApiKeyResolver): ApiKeyResolver {
	let seedPending = seed !== undefined;
	return ctx => {
		if (seedPending && ctx.error === undefined) {
			seedPending = false;
			return seed;
		}
		return resolver(ctx);
	};
}

export { isAuthRetryableError };

/** Legacy bounded a/b/c retry sequence: `false` → refresh-same, `true` → rotate/switch. */
export const AUTH_RETRY_STEPS: readonly boolean[] = [false, true];

export const AUTH_RETRY_MAX_ATTEMPTS = 64;

function isDirectCredentialRotationError(error: unknown): boolean {
	if (isAccountPolicyError(error)) return true;
	if (isUsageLimit(error) || isInvalidatedOAuthTokenError(error)) return true;
	const httpStatus = errorStatus(error);
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	// A 403 normally means a valid token lacks access, so rotate through siblings.
	// A concurrency-cap 403 is transient; don't burn a sibling before backoff.
	const isForbidden =
		httpStatus === 403 ||
		(httpStatus === undefined && message !== undefined && extractHttpStatusFromError({ message }) === 403);
	if (isForbidden && !isConcurrencyCapExclusion(httpStatus, message)) return true;
	return isUsageLimitOutcome(httpStatus, message);
}

/** Resolve a single retry step, swallowing resolver failures into `undefined`. */
export async function resolveRetryKey(
	resolver: ApiKeyResolver,
	lastChance: boolean,
	error: unknown,
	signal?: AbortSignal,
	previousKey?: string,
): Promise<string | undefined> {
	try {
		const rotateSibling = lastChance || (!lastChance && isDirectCredentialRotationError(error));
		return (await resolver({ lastChance: rotateSibling, error, signal, previousKey })) || undefined;
	} catch {
		return undefined;
	}
}

export interface AuthRetryKeyState {
	/** Bearer strings already sent during this logical operation. */
	attemptedKeys: Set<string>;
	/** Bearer used by the most recent failed attempt. */
	lastKey: string;
	/** Whether the current credential already consumed its 401 refresh-same retry. */
	refreshedCurrent: boolean;
	/** Whether the legacy non-usage auth path already switched to one sibling. */
	legacyAuthSwitchUsed: boolean;
	/** Whether this operation already replayed once after an explicit token-refresh request. */
	tokenRefreshReplayUsed?: boolean;
	/** Total outbound attempts accepted for this operation, including the initial request. */
	attempts: number;
}

export function createAuthRetryKeyState(initialKey: string): AuthRetryKeyState {
	return {
		attemptedKeys: new Set([initialKey]),
		lastKey: initialKey,
		refreshedCurrent: false,
		legacyAuthSwitchUsed: false,
		tokenRefreshReplayUsed: false,
		attempts: 1,
	};
}

function acceptRetryKey(state: AuthRetryKeyState, key: string, refreshedCurrent: boolean): string | undefined {
	if (state.attemptedKeys.has(key) || state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	state.attemptedKeys.add(key);
	state.attempts += 1;
	state.lastKey = key;
	state.refreshedCurrent = refreshedCurrent;
	return key;
}

export async function resolveNextAuthRetryKey(
	state: AuthRetryKeyState,
	resolver: ApiKeyResolver,
	error: unknown,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	if (state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	if (error instanceof OAuthError && error.kind === "token-refresh") {
		if (state.tokenRefreshReplayUsed) return undefined;
		state.tokenRefreshReplayUsed = true;
		const refreshed = await resolveRetryKey(resolver, false, error, signal, state.lastKey);
		state.refreshedCurrent = true;
		if (signal?.aborted || refreshed === undefined) return undefined;
		return acceptRetryKey(state, refreshed, true);
	}
	const directRotation = isDirectCredentialRotationError(error);
	if (!directRotation) {
		if (state.legacyAuthSwitchUsed) return undefined;
		if (!state.refreshedCurrent) {
			const refreshed = await resolveRetryKey(resolver, false, error, signal, state.lastKey);
			state.refreshedCurrent = true;
			if (signal?.aborted) return undefined;
			if (refreshed !== undefined) {
				const accepted = acceptRetryKey(state, refreshed, true);
				if (accepted !== undefined) return accepted;
			}
		}
	}

	if (signal?.aborted) return undefined;
	const rotated = await resolveRetryKey(resolver, true, error, signal, state.lastKey);
	if (signal?.aborted || rotated === undefined) return undefined;
	const accepted = acceptRetryKey(state, rotated, !directRotation);
	if (accepted !== undefined && !directRotation) state.legacyAuthSwitchUsed = true;
	return accepted;
}

/**
 * Runs an auth-protected operation through the central a/b/c retry policy.
 *
 * - A static string key → a single `attempt` with no retry.
 * - A resolver → initial `attempt`, then resolver-driven retries until the
 *   applicable policy is exhausted, the resolver declines or cycles, or the
 *   operation reaches {@link AUTH_RETRY_MAX_ATTEMPTS}.
 */
export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string) => Promise<T>,
	opts?: { isAuthError?: (error: unknown) => boolean; signal?: AbortSignal; missingKeyMessage?: string },
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const missingKey = (): Error => new MissingApiKeyError(undefined, opts?.missingKeyMessage);

	if (!isApiKeyResolver(key)) {
		if (key === undefined) throw missingKey();
		return attempt(key);
	}

	const resolver = key;
	const signal = opts?.signal;
	const initialKey = await resolveRetryKey(resolver, false, undefined, signal);
	if (initialKey === undefined) throw missingKey();

	const state = createAuthRetryKeyState(initialKey);
	let lastError: unknown;
	try {
		return await attempt(initialKey);
	} catch (error) {
		if (!isAuthError(error)) throw error;
		lastError = error;
	}

	while (true) {
		const nextKey = await resolveNextAuthRetryKey(state, resolver, lastError, signal);
		if (nextKey === undefined) break;
		try {
			return await attempt(nextKey);
		} catch (error) {
			if (!isAuthError(error)) throw error;
			lastError = error;
		}
	}

	throw lastError;
}
