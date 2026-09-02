import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	buildDatabricksModelCache,
	DATABRICKS_MODELS_CACHE_FILE,
	DATABRICKS_PROVIDER_ID,
	DATABRICKS_PROVIDER_NAME,
	databricksModelsFromCache,
	fetchDatabricksClaudeEndpoints,
	loadDatabricksModelCache,
	normalizeDatabricksWorkspaceUrl,
	saveDatabricksModelCache,
} from "../src/core/databricks-auth.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { ProviderAuthFlows, type ProviderAuthFlowsHost } from "../src/modes/interactive/auth-flows.js";

const WORKSPACE = "https://lge-esdatapf.cloud.databricks.com";

describe("normalizeDatabricksWorkspaceUrl", () => {
	it("accepts a bare host", () => {
		const result = normalizeDatabricksWorkspaceUrl("lge-esdatapf.cloud.databricks.com");
		expect(result.workspaceUrl).toBe(WORKSPACE);
		expect(result.anthropicBaseUrl).toBe(`${WORKSPACE}/serving-endpoints/anthropic`);
	});

	it("accepts the full ANTHROPIC_BASE_URL form and strips it to the workspace", () => {
		const result = normalizeDatabricksWorkspaceUrl(`${WORKSPACE}/serving-endpoints/anthropic`);
		expect(result.workspaceUrl).toBe(WORKSPACE);
		expect(result.anthropicBaseUrl).toBe(`${WORKSPACE}/serving-endpoints/anthropic`);
	});

	it("strips trailing slashes and a bare serving-endpoints path", () => {
		expect(normalizeDatabricksWorkspaceUrl(`${WORKSPACE}/`).workspaceUrl).toBe(WORKSPACE);
		expect(normalizeDatabricksWorkspaceUrl(`${WORKSPACE}/serving-endpoints/`).workspaceUrl).toBe(WORKSPACE);
	});

	it("rejects empty and malformed input", () => {
		expect(() => normalizeDatabricksWorkspaceUrl("   ")).toThrow("cannot be empty");
		expect(() => normalizeDatabricksWorkspaceUrl("ftp://example.com")).toThrow("Invalid Databricks workspace URL");
	});
});

describe("fetchDatabricksClaudeEndpoints", () => {
	it("queries the serving-endpoints API with bearer auth and filters to Claude endpoints", async () => {
		let requestedUrl: string | undefined;
		let authHeader: string | undefined;
		const fetchFn = (async (url: unknown, init?: RequestInit) => {
			requestedUrl = String(url);
			authHeader = (init?.headers as Record<string, string>).Authorization;
			return new Response(
				JSON.stringify({
					endpoints: [
						{ name: "databricks-claude-sonnet-5", state: { ready: "READY" }, task: "llm/v1/chat" },
						{ name: "databricks-meta-llama-3-3-70b-instruct" },
						{ name: "databricks-claude-opus-4-8" },
						{ notAName: true },
					],
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const endpoints = await fetchDatabricksClaudeEndpoints(WORKSPACE, "dapi-test-token", { fetchFn });

		expect(requestedUrl).toBe(`${WORKSPACE}/api/2.0/serving-endpoints`);
		expect(authHeader).toBe("Bearer dapi-test-token");
		expect(endpoints.map((endpoint) => endpoint.name)).toEqual([
			"databricks-claude-sonnet-5",
			"databricks-claude-opus-4-8",
		]);
	});

	it("throws with status and a hint on auth failures", async () => {
		const fetchFn = (async () => new Response("invalid token", { status: 403 })) as typeof fetch;

		await expect(fetchDatabricksClaudeEndpoints(WORKSPACE, "bad", { fetchFn })).rejects.toThrow(
			/HTTP 403.*access token/s,
		);
	});
});

describe("databricks model cache", () => {
	const workspace = normalizeDatabricksWorkspaceUrl(WORKSPACE);

	it("maps endpoints to anthropic-messages models with sensible defaults", () => {
		const cache = buildDatabricksModelCache(workspace, [
			{ name: "databricks-claude-sonnet-5" },
			{ name: "databricks-claude-3-5-sonnet" },
		]);
		const models = databricksModelsFromCache(cache);

		expect(models).toHaveLength(2);
		const [sonnet5, legacy] = models;
		expect(sonnet5!.provider).toBe(DATABRICKS_PROVIDER_ID);
		expect(sonnet5!.api).toBe("anthropic-messages");
		expect(sonnet5!.baseUrl).toBe(`${WORKSPACE}/serving-endpoints/anthropic`);
		expect(sonnet5!.id).toBe("databricks-claude-sonnet-5");
		expect(sonnet5!.name).toBe("Claude Sonnet 5");
		expect(sonnet5!.reasoning).toBe(true);
		expect(sonnet5!.maxTokens).toBe(32_000);
		// Claude 3.x endpoints predate extended thinking and cap output at 8k.
		expect(legacy!.reasoning).toBe(false);
		expect(legacy!.maxTokens).toBe(8_192);
	});

	it("round-trips through the cache file and rejects corrupted content", () => {
		const dir = mkdtempSync(join(tmpdir(), "evopi-databricks-"));
		try {
			const cache = buildDatabricksModelCache(workspace, [{ name: "databricks-claude-haiku-4-5" }]);
			saveDatabricksModelCache(dir, cache);
			expect(loadDatabricksModelCache(dir)).toEqual(cache);

			writeFileSync(join(dir, DATABRICKS_MODELS_CACHE_FILE), "not json");
			expect(loadDatabricksModelCache(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns undefined when no cache file exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "evopi-databricks-"));
		try {
			expect(loadDatabricksModelCache(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("ModelRegistry databricks integration", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "evopi-databricks-registry-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("serves stored models with bearer auth headers and persists them across registry instances", async () => {
		const workspace = normalizeDatabricksWorkspaceUrl(WORKSPACE);
		const cache = buildDatabricksModelCache(workspace, [{ name: "databricks-claude-sonnet-5" }]);

		const authStorage = AuthStorage.inMemory();
		const registry = ModelRegistry.create(authStorage, join(dir, "models.json"));
		registry.storeDatabricksModelCache(cache);
		registry.refresh();

		const model = registry.getAll().find((m) => m.provider === DATABRICKS_PROVIDER_ID);
		expect(model).toBeDefined();
		expect(model!.baseUrl).toBe(`${WORKSPACE}/serving-endpoints/anthropic`);

		// Models exist but stay unconfigured until a token is stored (e.g. after /logout).
		expect(registry.hasConfiguredAuth(model!)).toBe(false);

		authStorage.set(DATABRICKS_PROVIDER_ID, { type: "api_key", key: "dapi-test-token" });
		expect(registry.hasConfiguredAuth(model!)).toBe(true);

		const auth = await registry.getApiKeyAndHeaders(model!);
		expect(auth).toMatchObject({
			ok: true,
			apiKey: "dapi-test-token",
			headers: {
				Authorization: "Bearer dapi-test-token",
				"x-databricks-use-coding-agent-mode": "true",
			},
		});

		// A fresh registry (new process) reloads the cache from disk.
		const reloaded = ModelRegistry.create(AuthStorage.inMemory(), join(dir, "models.json"));
		expect(reloaded.getAll().some((m) => m.provider === DATABRICKS_PROVIDER_ID)).toBe(true);
	});

	it("offers Databricks in the login provider menu before any models exist, without duplicates after login", () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), join(dir, "models.json"));
		const host = { modelRegistry: registry } as unknown as ProviderAuthFlowsHost;
		const authFlows = new ProviderAuthFlows(host);

		const optionsBefore = authFlows
			.getLoginProviderOptions("api_key")
			.filter((option) => option.id === DATABRICKS_PROVIDER_ID);
		expect(optionsBefore).toEqual([
			{ id: DATABRICKS_PROVIDER_ID, name: DATABRICKS_PROVIDER_NAME, authType: "api_key" },
		]);

		const workspace = normalizeDatabricksWorkspaceUrl(WORKSPACE);
		registry.storeDatabricksModelCache(buildDatabricksModelCache(workspace, [{ name: "databricks-claude-sonnet-5" }]));
		registry.refresh();

		const optionsAfter = authFlows
			.getLoginProviderOptions("api_key")
			.filter((option) => option.id === DATABRICKS_PROVIDER_ID);
		expect(optionsAfter).toHaveLength(1);
		expect(optionsAfter[0]!.name).toBe(DATABRICKS_PROVIDER_NAME);
	});
});
