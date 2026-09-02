/**
 * Local, self-contained reproduction of the `@oh-my-pi/ai` message/tool types
 * the dialect subsystem consumes from its package-internal `../types` module.
 *
 * The upstream `types.ts` re-exports the entire `@oh-my-pi/pi-catalog` graph
 * (`effort`, `types`, `discovery`, ArkType `@oh-my-pi/omptype`, ~15 provider
 * option modules). None of that is reachable from the dialect files — they only
 * touch the structural message/content/tool shapes below — so this shim
 * reproduces exactly that closure and severs the catalog dependency (the SPEC's
 * "evopi-compat 로컬 타입로 catalog 절단").
 *
 * Deliberately narrower than upstream where the dialect never looks: content
 * unions omit `redactedThinking` / `fallback` / `anthropicServerTool` blocks
 * (verified unused via discriminant scan), and message metadata fields
 * (`providerPayload`, `contextSnapshot`, retry/transform records) are dropped.
 * Provider-metadata fields on `ToolCall` are kept optional-and-loose so
 * owned-stream's block cloning stays byte-faithful.
 */
import type { kStreamingPartialJson } from "./block-symbols.js";

export type { AssistantMessageEventStream } from "./event-stream.js";

/** JSON Schema document (draft-agnostic). evopi tools carry plain JSON Schema. */
export type TJsonSchema = Record<string, unknown>;
export type TSchema = TJsonSchema;

export type Api = string;
export type Provider = string;

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	contextTokens?: number;
	reasoningTokens?: number;
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	itemId?: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
	detail?: "auto" | "low" | "high" | "original";
	url?: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Streamed argument JSON, carried on a symbol slot (see ./block-symbols). */
	[kStreamingPartialJson]?: string;
	thoughtSignature?: string;
	intent?: string;
	rawBlock?: string;
	customWireName?: string;
	providerMetadata?: unknown;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ImageContent | ToolCall)[];
	api: Api;
	provider: Provider;
	model: string;
	responseId?: string;
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: TDetails;
	isError: boolean;
	timestamp: number;
}

export type Message = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

export type AssistantMessageEvent =
	| { type: "start"; contentIndex?: undefined; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "image_end"; contentIndex: number; content: ImageContent; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; contentIndex?: undefined; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; contentIndex?: undefined; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/** A tool-call demonstration: keyword-argument payload for one invocation. */
export interface ToolCallExample<TArgs = Record<string, unknown>> {
	caption?: string;
	call: TArgs;
}

/** A right-vs-wrong contrast pair. */
export interface ToolCompareExample<TArgs = Record<string, unknown>> {
	caption?: string;
	good: TArgs;
	bad: TArgs;
}

/** A free-text usage note with no call payload. */
export interface ToolNoteExample {
	caption?: string;
	note: string;
}

export type ToolExample<TArgs = Record<string, unknown>> =
	| ToolCallExample<TArgs>
	| ToolCompareExample<TArgs>
	| ToolNoteExample;

export interface NativeToolMarker {
	type: "computer";
}

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	strict?: boolean;
	deferLoading?: boolean;
	customFormat?: { syntax: "lark" | "regex"; definition: string };
	customWireName?: string;
	native?: NativeToolMarker;
	examples?: readonly ToolExample[];
}

export interface Context {
	systemPrompt?: string[];
	messages: Message[];
	tools?: Tool[];
}
