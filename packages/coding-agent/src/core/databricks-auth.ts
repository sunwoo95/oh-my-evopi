import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@evopi/pi-ai";

export const DATABRICKS_PROVIDER_ID = "databricks";
export const DATABRICKS_PROVIDER_NAME = "Databricks";

/** Model list fetched at login, persisted next to models.json (same pattern as the Prime private-models cache). */
export const DATABRICKS_MODELS_CACHE_FILE = "databricks-models.json";

/**
 * Claude Code sends this header when talking to Databricks Claude serving
 * endpoints; it enables the endpoint's coding-agent mode.
 */
export const DATABRICKS_DEFAULT_HEADERS: Record<string, string> = {
	"x-databricks-use-coding-agent-mode": "true",
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type DatabricksWorkspace = {
	/** Workspace root, e.g. https://my-workspace.cloud.databricks.com */
	workspaceUrl: string;
	/** Anthropic-compatible base URL: {workspaceUrl}/serving-endpoints/anthropic */
	anthropicBaseUrl: string;
};

export type DatabricksServingEndpoint = {
	name: string;
	state?: string;
	task?: string;
};

export type DatabricksCachedModel = {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
};

export type DatabricksModelCache = {
	version: 1;
	workspaceUrl: string;
	anthropicBaseUrl: string;
	models: DatabricksCachedModel[];
	updatedAt: string;
};

/**
 * Accepts a bare host, a workspace URL, or a full serving-endpoints URL (what
 * users have in ANTHROPIC_BASE_URL) and derives both canonical URLs.
 */
export function normalizeDatabricksWorkspaceUrl(input: string): DatabricksWorkspace {
	let raw = input.trim();
	if (!raw) {
		throw new Error("Workspace URL cannot be empty.");
	}
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		raw = `https://${raw}`;
	}

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid Databricks workspace URL: ${input.trim()}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Invalid Databricks workspace URL: ${input.trim()}`);
	}

	// Strip a pasted serving-endpoints path (ANTHROPIC_BASE_URL form) down to the workspace root.
	const path = url.pathname.replace(/\/+$/, "");
	const servingEndpointsIndex = path.indexOf("/serving-endpoints");
	const workspacePath = servingEndpointsIndex >= 0 ? path.slice(0, servingEndpointsIndex) : path;

	const workspaceUrl = `${url.origin}${workspacePath}`.replace(/\/+$/, "");
	return {
		workspaceUrl,
		anthropicBaseUrl: `${workspaceUrl}/serving-endpoints/anthropic`,
	};
}

function isClaudeEndpoint(endpoint: DatabricksServingEndpoint): boolean {
	return endpoint.name.toLowerCase().includes("claude");
}

/**
 * List the workspace's Claude serving endpoints via the Databricks REST API.
 * The personal access token doubles as the inference AUTH_TOKEN.
 */
export async function fetchDatabricksClaudeEndpoints(
	workspaceUrl: string,
	token: string,
	options: { signal?: AbortSignal; fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<DatabricksServingEndpoint[]> {
	const fetchFn = options.fetchFn ?? fetch;
	const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

	const response = await fetchFn(`${workspaceUrl}/api/2.0/serving-endpoints`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
		signal,
	});

	if (!response.ok) {
		const body = (await response.text().catch(() => "")).slice(0, 200);
		const hint =
			response.status === 401 || response.status === 403
				? " Check that the access token is valid and has serving-endpoints access."
				: "";
		throw new Error(`Databricks serving-endpoints request failed (HTTP ${response.status}): ${body}${hint}`);
	}

	const payload = (await response.json()) as { endpoints?: unknown };
	const endpoints = Array.isArray(payload.endpoints) ? payload.endpoints : [];
	return endpoints
		.filter(
			(entry): entry is { name: string; state?: { ready?: string }; task?: string } =>
				typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string",
		)
		.map((entry) => ({
			name: entry.name,
			state: entry.state?.ready,
			task: entry.task,
		}))
		.filter(isClaudeEndpoint);
}

/** "databricks-claude-sonnet-5" -> "Claude Sonnet 5" */
function endpointDisplayName(endpointName: string): string {
	const trimmed = endpointName.replace(/^databricks-/, "");
	return trimmed
		.split("-")
		.map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(" ")
		.replace(/(\d) (\d)/g, "$1.$2");
}

function cachedModelFromEndpoint(endpoint: DatabricksServingEndpoint): DatabricksCachedModel {
	const name = endpoint.name.toLowerCase();
	// Claude 3.x endpoints predate extended thinking and cap output at 8k;
	// Claude 4+ endpoints support both. Endpoint metadata doesn't expose the
	// underlying model limits, so infer from the conventional endpoint names.
	const isLegacyClaude = /claude-(instant|2|3-(5|opus|sonnet|haiku))/.test(name);
	return {
		id: endpoint.name,
		name: endpointDisplayName(endpoint.name),
		reasoning: !isLegacyClaude,
		contextWindow: 200_000,
		maxTokens: isLegacyClaude ? 8_192 : 32_000,
	};
}

export function buildDatabricksModelCache(
	workspace: DatabricksWorkspace,
	endpoints: DatabricksServingEndpoint[],
): DatabricksModelCache {
	return {
		version: 1,
		workspaceUrl: workspace.workspaceUrl,
		anthropicBaseUrl: workspace.anthropicBaseUrl,
		models: endpoints.map(cachedModelFromEndpoint),
		updatedAt: new Date().toISOString(),
	};
}

/** Materialize cached entries as anthropic-messages models for the registry. */
export function databricksModelsFromCache(cache: DatabricksModelCache): Model<Api>[] {
	return cache.models.map(
		(model) =>
			({
				id: model.id,
				name: model.name,
				api: "anthropic-messages",
				provider: DATABRICKS_PROVIDER_ID,
				baseUrl: cache.anthropicBaseUrl,
				reasoning: model.reasoning,
				input: ["text", "image"],
				// Databricks bills through the workspace (DBUs/pay-per-token); no public per-token USD rate.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			}) as Model<Api>,
	);
}

export function saveDatabricksModelCache(directory: string, cache: DatabricksModelCache): string {
	const path = join(directory, DATABRICKS_MODELS_CACHE_FILE);
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(cache, null, "\t")}\n`, "utf-8");
	renameSync(tempPath, path);
	return path;
}

export function loadDatabricksModelCache(directory: string): DatabricksModelCache | undefined {
	const path = join(directory, DATABRICKS_MODELS_CACHE_FILE);
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as DatabricksModelCache;
		if (parsed?.version !== 1 || typeof parsed.anthropicBaseUrl !== "string" || !Array.isArray(parsed.models)) {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}
