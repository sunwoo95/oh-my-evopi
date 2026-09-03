/**
 * Credential pool with round-robin / session-sticky selection, backported from
 * the pool concept in `@oh-my-pi/pi-ai` `auth-storage.ts` (the
 * `#getNextRoundRobinIndex` / `#getHashedIndex` / `#getCredentialOrder`
 * selection core, extracted from the 6934-line Bun+sqlite AuthStorage — the
 * rest of which is out of the v1 backport scope per DECISIONS Q1).
 *
 * evopi's prime-derived credential store keeps a single credential per provider
 * (`~/.evopi/auth.json`). This layer places that prime credential first
 * ("prime auth.json 1차") and rotates through additional pool members
 * ("풀 2차") when a credential fails, bridged into the auth-retry a/b/c contract
 * via {@link createPoolResolver}.
 *
 * The session→index hash uses FNV-1a (pure TS) rather than upstream's
 * `Bun.hash.xxHash32`: it is only an internal load-distribution / session
 * stickiness index, never an on-wire value, so byte-compatibility with Bun is
 * not required — only determinism per session.
 */
import type { ApiKeyResolveContext, ApiKeyResolver } from "./retry.js";

/** FNV-1a 32-bit over the UTF-8 code units of `text`. Deterministic, Bun-free. */
export function fnv1a32(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i) & 0xff;
		// hash *= 16777619, kept in uint32 via the >>> 0 below.
		hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
	}
	return hash >>> 0;
}

export interface CredentialPoolOptions {
	/**
	 * The prime auth.json credential for this provider, always tried first
	 * (index 0) regardless of round-robin state. `undefined` when prime has no
	 * stored credential — selection then falls through to the pool members.
	 */
	primary?: string;
	/** Additional pool credentials tried after the primary, in rotation. */
	pool?: readonly string[];
}

/**
 * An ordered, de-duplicated credential pool for one provider. Index 0 is the
 * prime auth.json primary (when present); the remainder are pool secondaries.
 */
export class CredentialPool {
	readonly credentials: readonly string[];
	/** Next round-robin start index (advances on each non-session selection). */
	#roundRobin = -1;

	constructor(options: CredentialPoolOptions = {}) {
		const ordered: string[] = [];
		const seen = new Set<string>();
		const add = (key: string | undefined) => {
			if (key === undefined || key.length === 0 || seen.has(key)) return;
			seen.add(key);
			ordered.push(key);
		};
		add(options.primary);
		for (const key of options.pool ?? []) add(key);
		this.credentials = ordered;
	}

	get size(): number {
		return this.credentials.length;
	}

	/** Advance and return the next round-robin start index (wraps at total). */
	#nextRoundRobinIndex(total: number): number {
		if (total <= 1) return 0;
		const next = (this.#roundRobin + 1) % total;
		this.#roundRobin = next;
		return next;
	}

	/** Deterministic session→start-index mapping (same session starts on the same credential). */
	#hashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		return fnv1a32(sessionId) % total;
	}

	/**
	 * Credential indices in priority order. With `sessionId` the order starts
	 * from the session-hashed index (stickiness); without it, from the advancing
	 * round-robin index (load distribution). The order wraps so every credential
	 * is reachable if earlier ones are blocked.
	 *
	 * `advance: false` peeks the session order without moving round-robin state.
	 */
	order(sessionId?: string, advance = true): number[] {
		const total = this.credentials.length;
		if (total <= 1) return total === 0 ? [] : [0];
		const start = sessionId
			? this.#hashedIndex(sessionId, total)
			: advance
				? this.#nextRoundRobinIndex(total)
				: (this.#roundRobin + 1) % total;
		const out: number[] = [];
		for (let i = 0; i < total; i++) out.push((start + i) % total);
		return out;
	}

	/** The ordered credential values for a selection (see {@link order}). */
	select(sessionId?: string, advance = true): string[] {
		return this.order(sessionId, advance).map((i) => this.credentials[i]!);
	}
}

/**
 * Bridge a {@link CredentialPool} into the auth-retry {@link ApiKeyResolver}
 * a/b/c contract:
 *
 * - initial resolve (`error === undefined`) → the first credential in the
 *   pool's selection order (prime auth.json primary for a fresh pool).
 * - refresh-same (`error`, `!lastChance`) → re-returns the current credential
 *   (evopi has no live token-mint here; a same-account refresh is a no-op replay
 *   that lets the driver's refresh step pass through to sibling rotation).
 * - rotate (`lastChance`) → the next not-yet-tried credential in order, or
 *   `undefined` once the pool is exhausted (terminating the retry loop).
 *
 * A per-resolver cursor tracks position; `previousKey` from the driver keeps the
 * "current" credential aligned with what the failed attempt actually sent.
 */
export function createPoolResolver(pool: CredentialPool, sessionId?: string): ApiKeyResolver {
	const order = pool.select(sessionId);
	let cursor = 0;
	return (ctx: ApiKeyResolveContext): string | undefined => {
		if (order.length === 0) return undefined;
		if (ctx.error === undefined) {
			cursor = 0;
			return order[0];
		}
		if (!ctx.lastChance) {
			// Refresh-same: hand back the credential the failed attempt used.
			return ctx.previousKey ?? order[cursor];
		}
		// Rotate to the next credential not yet attempted.
		cursor += 1;
		return cursor < order.length ? order[cursor] : undefined;
	};
}
