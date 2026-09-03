/**
 * Env-based credential pools (B2/M16).
 *
 * `EVOPI_API_KEY_POOL_<PROVIDER>` (comma-separated) supplies sibling
 * credentials for a provider — consistent with the project rule that API keys
 * live only in shell env vars, never files. The primary credential (whatever
 * `getApiKeyAndHeaders` resolved) always ranks first; pool members are the
 * rotation fallbacks. When the variable is unset or blank, callers skip the
 * pool wrapper entirely, leaving the request path byte-identical.
 *
 * Note: a CredentialPool is constructed per call. Round-robin state resets
 * with it, which is harmless — the sdk always passes a sessionId, so ordering
 * comes from the deterministic FNV-1a session-sticky path.
 */

import { CredentialPool } from "./pool.js";

export function envPoolVarName(provider: string): string {
	return `EVOPI_API_KEY_POOL_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** Parsed pool members, or undefined when the variable is unset/blank. */
export function getEnvPoolKeys(provider: string, env: NodeJS.ProcessEnv = process.env): string[] | undefined {
	const raw = env[envPoolVarName(provider)];
	if (raw === undefined) return undefined;
	const keys = raw
		.split(",")
		.map((key) => key.trim())
		.filter(Boolean);
	return keys.length > 0 ? keys : undefined;
}

/** A pool with the primary credential first, or undefined when no env pool exists. */
export function getEnvCredentialPool(
	provider: string,
	primary?: string,
	env: NodeJS.ProcessEnv = process.env,
): CredentialPool | undefined {
	const pool = getEnvPoolKeys(provider, env);
	if (!pool) return undefined;
	return new CredentialPool({ primary, pool });
}

/**
 * Rebind an `Authorization: Bearer` header to a rotated key. Providers with
 * `authHeader: true` (e.g. Databricks — model-registry.ts getApiKeyAndHeaders)
 * derive the header from the primary key; on rotation the header must follow.
 * Headers not derived from the primary key are left untouched.
 */
export function rebindAuthHeader(
	headers: Record<string, string> | undefined,
	primaryKey: string | undefined,
	key: string,
): Record<string, string> | undefined {
	if (!headers || !primaryKey || headers.Authorization !== `Bearer ${primaryKey}`) return headers;
	return { ...headers, Authorization: `Bearer ${key}` };
}
