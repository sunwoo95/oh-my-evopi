import { describe, expect, it } from "vitest";
import {
	CredentialPool,
	createAuthRetryKeyState,
	createPoolResolver,
	fnv1a32,
	isAuthRetryableError,
	isUsageLimitOutcome,
	MissingApiKeyError,
	OAuthError,
	resolveNextAuthRetryKey,
	withAuth,
} from "../src/core/auth-pool/index.js";

describe("CredentialPool ordering", () => {
	it("places the prime auth.json primary first and de-dupes", () => {
		const pool = new CredentialPool({ primary: "prime", pool: ["a", "prime", "b", ""] });
		expect(pool.credentials).toEqual(["prime", "a", "b"]);
		expect(pool.size).toBe(3);
	});

	it("falls through to pool members when prime has no credential", () => {
		const pool = new CredentialPool({ pool: ["a", "b"] });
		expect(pool.credentials).toEqual(["a", "b"]);
	});

	it("round-robin starts at the primary then advances across selections", () => {
		const pool = new CredentialPool({ primary: "k0", pool: ["k1", "k2"] });
		// The first selection starts at the primary (index 0); each later one
		// advances the start, and every order wraps to cover all credentials.
		expect(pool.select()).toEqual(["k0", "k1", "k2"]);
		expect(pool.select()).toEqual(["k1", "k2", "k0"]);
		expect(pool.select()).toEqual(["k2", "k0", "k1"]);
	});

	it("session stickiness maps the same session to the same start deterministically", () => {
		const pool = new CredentialPool({ primary: "k0", pool: ["k1", "k2"] });
		const first = pool.select("session-42");
		const again = pool.select("session-42");
		expect(again).toEqual(first);
		// A different session may start elsewhere but always covers all creds.
		expect(new Set(pool.select("other"))).toEqual(new Set(["k0", "k1", "k2"]));
	});

	it("single-credential and empty pools are stable", () => {
		expect(new CredentialPool({ primary: "solo" }).select()).toEqual(["solo"]);
		expect(new CredentialPool({}).select()).toEqual([]);
		expect(new CredentialPool({}).select("s")).toEqual([]);
	});

	it("fnv1a32 is deterministic and stays in uint32", () => {
		const h = fnv1a32("session-42");
		expect(h).toBe(fnv1a32("session-42"));
		expect(Number.isInteger(h)).toBe(true);
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThanOrEqual(0xffffffff);
		expect(fnv1a32("session-42")).not.toBe(fnv1a32("session-43"));
	});
});

describe("createPoolResolver bridges pool rotation into the a/b/c contract", () => {
	it("returns primary on initial resolve, rotates on lastChance, exhausts to undefined", async () => {
		const pool = new CredentialPool({ primary: "prime", pool: ["s1", "s2"] });
		const resolver = createPoolResolver(pool);
		expect(await resolver({ lastChance: false, error: undefined })).toBe("prime");
		// refresh-same hands back the credential the failed attempt used
		expect(await resolver({ lastChance: false, error: new Error("401"), previousKey: "prime" })).toBe("prime");
		// rotation walks the remaining pool then exhausts
		expect(await resolver({ lastChance: true, error: new Error("401") })).toBe("s1");
		expect(await resolver({ lastChance: true, error: new Error("401") })).toBe("s2");
		expect(await resolver({ lastChance: true, error: new Error("401") })).toBeUndefined();
	});
});

describe("withAuth drives the pool through real credential rotation", () => {
	it("rotates prime → pool through direct-rotation 403s to a healthy sibling", async () => {
		// 403 is a direct-rotation error, so the driver walks every sibling
		// (unlike an ordinary 401, which permits a single legacy switch).
		const pool = new CredentialPool({ primary: "bad0", pool: ["bad1", "good"] });
		const resolver = createPoolResolver(pool);
		const seen: string[] = [];
		const result = await withAuth(resolver, async (key) => {
			seen.push(key);
			if (key !== "good") {
				const err = new Error("forbidden") as Error & { status: number };
				err.status = 403;
				throw err;
			}
			return "ok";
		});
		expect(result).toBe("ok");
		expect(seen).toEqual(["bad0", "bad1", "good"]);
	});

	it("an ordinary 401 permits a single sibling switch", async () => {
		const pool = new CredentialPool({ primary: "bad0", pool: ["good"] });
		const resolver = createPoolResolver(pool);
		const seen: string[] = [];
		const result = await withAuth(resolver, async (key) => {
			seen.push(key);
			if (key !== "good") {
				const err = new Error("unauthorized") as Error & { status: number };
				err.status = 401;
				throw err;
			}
			return "ok";
		});
		expect(result).toBe("ok");
		expect(seen).toEqual(["bad0", "good"]);
	});

	it("throws MissingApiKeyError when the pool is empty", async () => {
		const resolver = createPoolResolver(new CredentialPool({}));
		await expect(withAuth(resolver, async () => "never")).rejects.toBeInstanceOf(MissingApiKeyError);
	});

	it("propagates a non-auth error without rotating", async () => {
		const pool = new CredentialPool({ primary: "k0", pool: ["k1"] });
		const resolver = createPoolResolver(pool);
		let attempts = 0;
		await expect(
			withAuth(resolver, async () => {
				attempts += 1;
				throw new Error("boom (not auth)");
			}),
		).rejects.toThrow("boom (not auth)");
		expect(attempts).toBe(1);
	});

	it("exhausts the pool and throws the last auth error when all creds fail", async () => {
		const pool = new CredentialPool({ primary: "a", pool: ["b"] });
		const resolver = createPoolResolver(pool);
		const err = () => {
			const e = new Error("forbidden") as Error & { status: number };
			e.status = 403;
			return e;
		};
		await expect(withAuth(resolver, async () => Promise.reject(err()))).rejects.toThrow("forbidden");
	});
});

describe("retry classification (compat layer)", () => {
	it("treats 401/403 and usage limits as retryable, transient concurrency caps as not", () => {
		expect(isAuthRetryableError(Object.assign(new Error("x"), { status: 401 }))).toBe(true);
		expect(isAuthRetryableError(Object.assign(new Error("x"), { status: 403 }))).toBe(true);
		expect(isAuthRetryableError(new OAuthError("refresh needed", { kind: "token-refresh" }))).toBe(true);
		expect(isAuthRetryableError(new Error("usage_limit_reached"))).toBe(true);
		expect(isAuthRetryableError(Object.assign(new Error("concurrent limit"), { status: 429 }))).toBe(false);
		expect(isAuthRetryableError(Object.assign(new Error("teapot"), { status: 418 }))).toBe(false);
	});

	it("isUsageLimitOutcome rotates on account-scoped caps but not bare 403", () => {
		expect(isUsageLimitOutcome(403, "Reached overall message rate limit")).toBe(true);
		expect(isUsageLimitOutcome(403, "invalid credentials")).toBe(false);
		expect(isUsageLimitOutcome(429, undefined)).toBe(true);
	});

	it("token-refresh on a static-key pool declines (no live bearer to mint)", async () => {
		// A token-refresh request asks the resolver to mint a NEW bearer for the
		// same account. evopi's pool holds static keys, so the refresh yields the
		// same already-attempted bearer, which the driver dedupes → declines
		// (and token-refresh never falls through to sibling rotation).
		const state = createAuthRetryKeyState("k0");
		const resolver = createPoolResolver(new CredentialPool({ primary: "k0", pool: ["k1"] }));
		const err = new OAuthError("refresh", { kind: "token-refresh" });
		await resolver({ lastChance: false, error: undefined });
		expect(await resolveNextAuthRetryKey(state, resolver, err, undefined)).toBeUndefined();
	});

	it("a resolver that mints a fresh bearer replays it once on token-refresh", async () => {
		// Contrast: a live-minting resolver DOES get exactly one refresh replay.
		const state = createAuthRetryKeyState("stale");
		let minted = 0;
		const resolver = () => `fresh-${++minted}`;
		const err = new OAuthError("refresh", { kind: "token-refresh" });
		expect(await resolveNextAuthRetryKey(state, resolver, err, undefined)).toBe("fresh-1");
		// second identical token-refresh does not replay again
		expect(await resolveNextAuthRetryKey(state, resolver, err, undefined)).toBeUndefined();
	});

	it("ordinary 401 does one refresh-same then one sibling switch", async () => {
		const state = createAuthRetryKeyState("k0");
		const resolver = createPoolResolver(new CredentialPool({ primary: "k0", pool: ["k1"] }));
		await resolver({ lastChance: false, error: undefined });
		const err = Object.assign(new Error("unauthorized"), { status: 401 });
		// refresh-same returns k0, but it was already attempted → acceptRetryKey
		// rejects the duplicate, so the driver falls through to sibling rotation.
		expect(await resolveNextAuthRetryKey(state, resolver, err, undefined)).toBe("k1");
	});
});
