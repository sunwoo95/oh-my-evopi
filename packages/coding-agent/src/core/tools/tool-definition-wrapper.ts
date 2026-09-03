import type { AgentTool } from "@evopi/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";

/**
 * Session-owned steering state consulted by wrapped tools (D2 route (b): steering
 * emulation without touching the frozen `packages/agent` loop).
 *
 * The frozen loop hands every tool a single run-abort signal. The session layers
 * omp's L2/L3 on top of it here:
 * - L3 (cooperative): `steeringSignal` reaches every tool via `ctx.steeringSignal`.
 *   It is aborted while a steering message waits for the next turn boundary and
 *   NEVER kills anything; ignoring it is always safe.
 * - L2 (hard): tools that declare `interruptible` additionally observe it through
 *   their abort signal (`AbortSignal.any([runSignal, steeringSignal])`).
 * - Not-yet-started skip: a tool whose `execute` is entered while `steerPending`
 *   is true does not run; it throws {@link SteeringSkippedToolError} so the loop
 *   records an error tool result and reaches the injection boundary sooner.
 *   Parallel-batch siblings that already started cannot be skipped this way.
 */
export interface ToolSteeringRuntime {
	/** Aborted while a steering message is queued for the active run; replaced once it is delivered. */
	steeringSignal: AbortSignal;
	/** True when a queued steering message is waiting for the next turn boundary. */
	steerPending: boolean;
}

/** Resolved per tool call; `undefined` keeps the wrapper byte-identical to the plain pass-through. */
export type ToolSteeringRuntimeProvider = () => ToolSteeringRuntime | undefined;

/** Mirrors omp `createSkippedToolResult(source = "user")` (`oh-my-pi/packages/agent/src/agent-loop.ts:2980-3010`). */
export const STEERING_SKIPPED_TOOL_RESULT_TEXT =
	"Skipped due to queued user message. Do not count this skipped result as completed work or verification. After the queued message is handled on the next step, retry the skipped tool if it is still needed.";

/**
 * Thrown by a wrapped tool that was not started because a steering message is
 * pending. The frozen loop turns it into an `isError` tool result carrying
 * {@link STEERING_SKIPPED_TOOL_RESULT_TEXT} (`agent-loop.ts:868-879`).
 */
export class SteeringSkippedToolError extends Error {
	constructor() {
		super(STEERING_SKIPPED_TOOL_RESULT_TEXT);
		this.name = "SteeringSkippedToolError";
	}
}

/** Resolve a tool's `interruptible` declaration for one call; resolver failures preserve the tool (not interruptible). */
export function resolveToolInterruptible(definition: ToolDefinition<any, any>, args: unknown): boolean {
	const mode = definition.interruptible;
	if (typeof mode === "function") {
		try {
			return mode(args as never) === true;
		} catch {
			return false;
		}
	}
	return mode === true;
}

function combineAbortSignals(signal: AbortSignal | undefined, steeringSignal: AbortSignal): AbortSignal {
	return signal ? AbortSignal.any([signal, steeringSignal]) : steeringSignal;
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
	steering?: ToolSteeringRuntimeProvider,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate) => {
			const runtime = steering?.();
			if (!runtime) {
				return definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext);
			}
			if (runtime.steerPending) {
				return Promise.reject(new SteeringSkippedToolError());
			}
			const toolSignal = resolveToolInterruptible(definition, params)
				? combineAbortSignals(signal, runtime.steeringSignal)
				: signal;
			const ctx = ctxFactory?.();
			const ctxWithSteering = ctx
				? Object.assign(ctx, { steeringSignal: runtime.steeringSignal })
				: ({ steeringSignal: runtime.steeringSignal } as unknown as ExtensionContext);
			return definition.execute(toolCallId, params, toolSignal, onUpdate, ctxWithSteering);
		},
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
	steering?: ToolSteeringRuntimeProvider,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory, steering));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
