/**
 * Environment for daemon session workers.
 *
 * The supervisor process keeps the environment of whichever client launched
 * it. Workers are spawned as `{ ...supervisorEnv, ...launchEnv }`, so a knob the
 * *launching* client had set (e.g. `EVOPI_APPROVAL=strict`) survived into every
 * later client's worker whenever that client did not set the key itself — the
 * overlay can override values but cannot express "unset". Found by the v0.12.0
 * sandbox check: a `strict` first run left all following runs strict.
 *
 * EVOPI_* configuration knobs are client-scoped: when a client supplied its
 * launch env, the worker must see exactly the client's view of them, absence
 * included. Internal daemon plumbing (`EVOPI_INTERNAL_*`) is set explicitly by
 * the supervisor and is never stripped.
 */

export function isClientScopedEnvKey(key: string): boolean {
	return key.startsWith("EVOPI_") && !key.startsWith("EVOPI_INTERNAL_");
}

/**
 * Base env for a worker spawn. With a client launch env, the supervisor's own
 * EVOPI_* knobs are dropped so `{ ...base, ...launchEnv }` reflects the client;
 * without one (legacy clients) the supervisor env is used unchanged.
 */
export function workerBaseEnv(
	processEnv: NodeJS.ProcessEnv,
	launchEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
	if (!launchEnv) return { ...processEnv };
	const base: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(processEnv)) {
		if (!isClientScopedEnvKey(key)) base[key] = value;
	}
	return base;
}
