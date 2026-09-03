/**
 * evopi-auth-pool — credential pool rotation + auth retry.
 *
 * Backport of `@oh-my-pi/pi-ai`'s `auth-retry.ts` (a/b/c retry policy) and the
 * round-robin pool-selection core from `auth-storage.ts`, over a self-contained
 * error-classification `compat` layer (evopi's `@evopi/pi-ai` has no `error`
 * module). Places the prime `~/.evopi/auth.json` credential first and rotates
 * through additional pool members on failure. The Bun.serve auth-broker /
 * auth-gateway sidecars are deferred to v2 (DECISIONS Q1).
 */
export {
	extractHttpStatusFromError,
	isAccountPolicyError,
	isAuthRetryableAssistantError,
	isAuthRetryableError,
	isConcurrencyCapExclusion,
	isInvalidatedOAuthTokenError,
	isUsageLimit,
	isUsageLimitOutcome,
	MissingApiKeyError,
	OAuthError,
	type OAuthErrorKind,
	type OAuthErrorOptions,
	status,
} from "./classify.js";
export { envPoolVarName, getEnvCredentialPool, getEnvPoolKeys, rebindAuthHeader } from "./env.js";
export {
	classifyOneshotFailure,
	extractRetryHintFromText,
	getHeadersFromError,
	getRetryAfterMsFromHeaders,
	type HeadersLike,
	isTransientStatus,
	type OneshotFailureKind,
	type OneshotRetryInfo,
	type OneshotRetryOptions,
	retryTransientCompletion,
} from "./oneshot-retry.js";
export { CredentialPool, type CredentialPoolOptions, createPoolResolver, fnv1a32 } from "./pool.js";
export {
	type ApiKey,
	type ApiKeyResolveContext,
	type ApiKeyResolver,
	AUTH_RETRY_MAX_ATTEMPTS,
	AUTH_RETRY_STEPS,
	type AuthRetryKeyState,
	createAuthRetryKeyState,
	isApiKeyResolver,
	resolveApiKeyOnce,
	resolveNextAuthRetryKey,
	resolveRetryKey,
	seedApiKeyResolver,
	withAuth,
} from "./retry.js";
export { type WithAuthStreamOptions, withAuthStream } from "./stream.js";
