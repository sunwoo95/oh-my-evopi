/**
 * Owned in-band tool-call dialect mode (B1/M15, R8).
 *
 * Wires the M8 dialect backport (`@evopi/pi-ai/dialect`) into the live stream
 * path so custom/local models without native tool calling (Ollama, vLLM, …)
 * can drive tools through in-band text. Mirrors omp's agent-loop wiring
 * (agent-loop.ts:1602-1773) but lives entirely in the sdk streamFn closure —
 * the prime-skeleton `packages/agent` loop stays untouched.
 *
 * Activation is strictly opt-in: a `dialect` field on the model/provider in
 * models.json, or the `EVOPI_DIALECT` env override. With neither set, every
 * function here returns undefined and the stream path is byte-identical.
 *
 * Type note: the dialect module types against its own `compat` Context/stream
 * (the M8 catalog-cut). pi-ai's shapes are structurally compatible at runtime
 * (providers never emit the compat-only `image_end`; compat Usage is a
 * structural subset), so the boundary is bridged with documented casts.
 */

import type { Api, AssistantMessageEventStream, Context, Model, Tool } from "@evopi/pi-ai";
import {
	type Dialect,
	encodeInbandToolHistory,
	type InbandTool,
	preferredDialect,
	renderInbandToolPrompt,
	wrapInbandToolStream,
} from "@evopi/pi-ai/dialect";
import type { ModelRegistry } from "./model-registry.js";

const DIALECTS: readonly Dialect[] = [
	"glm",
	"hermes",
	"kimi",
	"xml",
	"anthropic",
	"deepseek",
	"harmony",
	"qwen3",
	"gemini",
	"gemma",
	"minimax",
];

const warnedValues = new Set<string>();

function parseDialectValue(raw: string | undefined, modelId: string, source: string): Dialect | undefined {
	const value = (raw ?? "").trim().toLowerCase();
	if (!value || value === "off") return undefined;
	if (value === "auto") return preferredDialect(modelId);
	if ((DIALECTS as readonly string[]).includes(value)) return value as Dialect;
	// Unknown value: warn once per value and fall back to native tools —
	// misconfiguration must not silently change the stream contract.
	if (!warnedValues.has(value)) {
		warnedValues.add(value);
		console.warn(`evopi: unknown dialect "${value}" from ${source}; using native tool calling`);
	}
	return undefined;
}

/**
 * Resolve the owned dialect for a model. `EVOPI_DIALECT` wins (with "off"
 * disabling model-level config); otherwise the models.json `dialect` field.
 */
export function resolveOwnedDialect(model: Model<Api>, registry: ModelRegistry): Dialect | undefined {
	const env = process.env.EVOPI_DIALECT;
	if (env !== undefined && env.trim() !== "") {
		return parseDialectValue(env, model.id, "EVOPI_DIALECT");
	}
	return parseDialectValue(registry.getModelDialect(model), model.id, `models.json (${model.provider}/${model.id})`);
}

export interface OwnedDialectContext {
	/** New context: tools stripped, catalog rendered into the prompt, history re-encoded. */
	context: Context;
	/** The wire tools the scanner should synthesize toolcalls against. */
	wireTools: readonly Tool[];
}

/**
 * Prepare a context for owned in-band tool calling. Returns undefined when the
 * context carries no tools (nothing to own — stream passes through untouched).
 * Never mutates the input context.
 */
export function applyOwnedDialectContext(context: Context, dialect: Dialect): OwnedDialectContext | undefined {
	const tools = context.tools;
	if (!tools || tools.length === 0) return undefined;

	const inbandTools = tools as unknown as readonly InbandTool[];
	const catalogPrompt = renderInbandToolPrompt(inbandTools, dialect);
	const systemPrompt = context.systemPrompt ? `${context.systemPrompt}\n\n${catalogPrompt}` : catalogPrompt;
	const messages = encodeInbandToolHistory(
		context.messages as unknown as Parameters<typeof encodeInbandToolHistory>[0],
		dialect,
		inbandTools,
	) as unknown as Context["messages"];

	return {
		context: { ...context, systemPrompt, messages, tools: undefined },
		wireTools: tools,
	};
}

/**
 * Wrap a provider event stream with the in-band scanner: dialect-format text
 * is re-materialized as native toolcall events, so the agent loop executes
 * tools unchanged. `onFabrication` fires when the model starts fabricating a
 * tool response; the projector pushes `done` first, so aborting the provider
 * there ends the request cleanly without tripping the loop's own signal.
 */
export function wrapOwnedDialectStream(
	inner: AssistantMessageEventStream,
	wireTools: readonly Tool[],
	dialect: Dialect,
	onFabrication?: () => void,
	abortOnFabrication = true,
): AssistantMessageEventStream {
	type CompatStream = Parameters<typeof wrapInbandToolStream>[0];
	return wrapInbandToolStream(
		inner as unknown as CompatStream,
		wireTools as unknown as readonly InbandTool[],
		dialect,
		onFabrication,
		abortOnFabrication,
	) as unknown as AssistantMessageEventStream;
}
