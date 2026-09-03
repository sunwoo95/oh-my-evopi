# prime 상류 제안 D2 — steering interrupt / abort reason (2단계)

> 대상: prime `packages/agent` (evopi 사본 `packages/agent/src/{agent-loop,agent,types}.ts`, prime과 import 지정자 1행만 다름 — `docs/analysis/d2-steering-abort.md` §전제).
> 근거 분석: `docs/analysis/d2-steering-abort.md`. 결정: DECISIONS D2-1/D2-5(2단계, 1차는 미사용 시 동작 불변).
> evopi 는 수용 전까지 세션/sdk 레이어 에뮬레이션(route (b))으로 동일 체감을 제공하고, 수용 시 `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` 의 steering seam 을 루프 계약으로 치환한다.
> 아래 본문은 상류 이슈/PR 에 그대로 붙일 수 있도록 영문으로 작성.

---

## Summary

Two independent PRs against `packages/agent`, ordered so that the first is behaviour-neutral for every existing caller:

| Stage | Scope | Behaviour when unused |
|---|---|---|
| 1 | `Agent.abort(reason)` + `abortReasonText()`; opt-in placeholder tool results for aborted turns and for tool calls left behind by a sequential-mode abort break | identical (fixed sentinel text kept; placeholders off by default) |
| 2 | `hasSteeringMessages` / `waitForSteeringMessages` / `interruptMode`; `AgentTool.interruptible`; `ToolCallContext.steeringSignal` (5th `execute` argument); not-yet-started skip with a synthesized result | identical (`interruptMode` defaults to `"wait"`, the current semantics) |

All API shapes below are lifted from oh-my-pi (omp) so tools and extensions written for omp keep working. omp anchors are cited as `omp agent-loop.ts:<line>` (= `oh-my-pi/packages/agent/src/agent-loop.ts`), prime anchors as `agent-loop.ts:<line>` (= the 963-line file shared by prime and evopi).

---

## Stage 1 — abort reason + placeholders (behaviour-neutral)

### 1a. `Agent.abort(reason?)` and `abortReasonText()`

Today `Agent.abort()` takes no argument (`agent.ts:319-321`) and every aborted assistant message carries the fixed `errorMessage: "Request was aborted"` (`agent-loop.ts:28`, `:132-147`); aborted tool results carry `"Tool execution aborted"` (`:876`). Hosts cannot label an interrupt ("Interrupted by user", "Deadline exceeded", …) without post-editing the transcript.

omp: `abort(reason?: unknown)` (`omp agent.ts:1103-1105`) forwards to `AbortController.abort(reason)`; `abortReasonText(signal)` (`omp agent-loop.ts:2105-2114`) surfaces a string or non-`AbortError` `Error` reason, else the sentinel.

```ts
// agent.ts:319 (was: abort(): void)
abort(reason?: unknown): void {
	this.activeRun?.abortController.abort(reason);
}

// agent-loop.ts — new helper next to createAbortError() (:38)
/**
 * `abort(reason)` with a string or a non-AbortError Error surfaces that text on the
 * synthesized assistant message / tool results; a bare `abort()` (default AbortError
 * DOMException reason) keeps the generic sentinel.
 */
export function abortReasonText(signal: AbortSignal | undefined): string {
	const reason = signal?.reason;
	if (typeof reason === "string" && reason.trim().length > 0) return reason;
	if (reason instanceof Error && reason.name !== "AbortError" && reason.message.trim().length > 0) {
		return reason.message;
	}
	return ABORT_ERROR_MESSAGE; // "Request was aborted"
}
```

Call sites (pure substitution; output unchanged for `abort()` without a reason):

```ts
// agent-loop.ts:132-147 createAbortedAssistantMessage(config, partialMessage)  →  add `signal` param
errorMessage: abortReasonText(signal),

// agent-loop.ts:874-879 executePreparedToolCall catch
result: createErrorToolResult(
	signal?.aborted ? abortReasonText(signal) : error instanceof Error ? error.message : String(error),
),
```

`isAbortError()` (`:102-104`) is unaffected: internal abort errors are still created by `createAbortError()` with the sentinel; only the *emitted* text changes when a reason is supplied.

### 1b. Placeholder tool results (opt-in)

Two gaps leave `toolCall` blocks without a matching `toolResult` in the loop's own output:

1. **Aborted turn.** `agent-loop.ts:343-347` emits `turn_end { toolResults: [] }` and `agent_end` for `stopReason === "aborted" | "error"`, so partial `toolCall` blocks retained by `createAbortedAssistantMessage()` (`:138`, `cloneAssistantContent`) have no results.
2. **Sequential-mode abort break.** `executeToolCallsSequential` breaks at `:619-621` / `:656-658`; remaining calls get neither `tool_execution_*` events nor results (parallel mode does produce `"Tool execution aborted"` results for every call, `:677-712` + `:874-879`).

omp always emits placeholders (`omp agent-loop.ts:1314-1336`, `createAbortedToolResult`). pi-ai's `transformMessages` (`packages/ai/src/providers/transform-messages.ts:171-219`) already repairs the *provider* payload (aborted assistant turns are dropped; missing results become `"No result provided"`), so the placeholders matter for transcript/session-file completeness and for hosts that persist `agent_end.messages`. To stay neutral, gate them:

```ts
// types.ts AgentLoopConfig (additive)
/**
 * Emit synthesized `toolResult` messages for tool calls that never produced one:
 * an aborted/errored assistant turn, or calls skipped by a sequential-mode abort.
 * - "none" (default): current behaviour (`turn_end.toolResults` may be shorter than the calls).
 * - "error-result": one `isError` result per orphan call, text = abortReasonText(signal) or
 *   the assistant `errorMessage`; emitted with message_start/message_end and included in
 *   `turn_end.toolResults`.
 */
abortedToolCallPlaceholders?: "none" | "error-result";
```

```ts
// agent-loop.ts — helper
function createPlaceholderToolResult(toolCall: AgentToolCall, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text }],
		details: {},
		isError: true,
		timestamp: Date.now(),
	};
}

// agent-loop.ts:343-347
if (message.stopReason === "error" || message.stopReason === "aborted") {
	const toolResults: ToolResultMessage[] = [];
	if (config.abortedToolCallPlaceholders === "error-result") {
		const text = message.errorMessage ?? abortReasonText(signal);
		for (const toolCall of message.content.filter((c) => c.type === "toolCall")) {
			const placeholder = createPlaceholderToolResult(toolCall, text);
			currentContext.messages.push(placeholder);
			newMessages.push(placeholder);
			toolResults.push(placeholder);
			await emitToolResultMessage(placeholder, emit);
		}
	}
	await emit({ type: "turn_end", message, toolResults });
	await emit({ type: "agent_end", messages: newMessages });
	return;
}

// agent-loop.ts:619-621 and :656-658 (sequential break) — same gate
if (signal?.aborted) {
	if (config.abortedToolCallPlaceholders === "error-result") {
		for (const remaining of toolCalls.slice(index)) {   // calls not yet finalized
			const placeholder = createPlaceholderToolResult(remaining, abortReasonText(signal));
			await emitToolResultMessage(placeholder, emit);
			messages.push(placeholder);
		}
	}
	break;
}
```

Tests to add in `packages/agent/test/agent-loop.test.ts` (existing abort cases `:112-269` stay green because the default is `"none"`): (i) `abort("Interrupted by user")` → aborted message `errorMessage === "Interrupted by user"`, aborted parallel tool results carry the same text; (ii) bare `abort()` → byte-identical to today; (iii) `abortedToolCallPlaceholders: "error-result"` → every `toolCall` in an aborted turn / after a sequential break has exactly one `toolResult` in `agent_end.messages` and `turn_end.toolResults`.

---

## Stage 2 — steering interrupt mechanism

Today steering is consumed only at `agent-loop.ts:314` (run start) and `:397-410` (after the *whole* tool batch). A queued user message waits for the longest tool in the batch. omp interrupts mid-batch without ever hard-killing a side-effecting tool (`omp agent-loop.ts:2336-2352`, `types.ts:786-796`, `:545-561`).

### 2a. `AgentLoopConfig` additions (omp `types.ts:150-160`, `:262-270`)

```ts
// types.ts AgentLoopConfig (additive)
/**
 * When to interrupt tool execution for steering messages.
 * - "wait" (default — current behaviour): steering is only drained after the tool batch.
 * - "immediate": peek `hasSteeringMessages` after every tool completion and on
 *   `waitForSteeringMessages` wake-ups; on detection abort interruptible tools, raise the
 *   cooperative `steeringSignal`, and skip not-yet-started calls in the batch.
 */
interruptMode?: "immediate" | "wait";
/** Non-consuming peek; the queue is still drained only by `getSteeringMessages`. */
hasSteeringMessages?: () => boolean | Promise<boolean>;
/** Resolves when a steering message is queued (or `signal` aborts); must not consume the queue. */
waitForSteeringMessages?: (signal?: AbortSignal) => Promise<void>;
```

`Agent` (agent.ts:462-493 `createLoopConfig`) wires them to its `PendingMessageQueue` (`:119-167`) and `steer()` (`:285-287`) resolves pending waiters (omp `agent.ts:995-998`, `:1494-1514`):

```ts
// agent.ts
private steeringWaiters = new Set<() => void>();

steer(message: AgentMessage | AgentMessage[]): void {
	this.steeringQueue.enqueue(message);
	for (const wake of this.steeringWaiters) wake();
	this.steeringWaiters.clear();
}

// createLoopConfig(...)
interruptMode: this.interruptMode,                 // new public field, default "wait"
hasSteeringMessages: () => this.steeringQueue.hasItems(),
waitForSteeringMessages: (signal) =>
	new Promise<void>((resolve) => {
		if (this.steeringQueue.hasItems() || signal?.aborted) return resolve();
		const wake = () => { signal?.removeEventListener("abort", wake); this.steeringWaiters.delete(wake); resolve(); };
		this.steeringWaiters.add(wake);
		signal?.addEventListener("abort", wake, { once: true });
	}),
```

### 2b. `AgentTool.interruptible` (omp `types.ts:786-796`)

```ts
// types.ts AgentTool (additive)
/**
 * Whether the loop may abort this tool mid-execution to deliver a queued steering message.
 * A function resolves it per call from the validated arguments. Enable only for calls that
 * purely *wait* and observe their abort signal cleanly. Honoured only when
 * `interruptMode` is "immediate".
 */
interruptible?: boolean | ((args: Static<TParameters>) => boolean);
```

### 2c. `ToolCallContext` as the 5th `execute` argument (omp `types.ts:545-561`, `agent-loop.ts:2590-2610`)

Adding a trailing parameter is source-compatible for every existing implementer.

```ts
// types.ts
export interface ToolCallContext {
	batchId: string;
	index: number;
	total: number;
	toolCalls: Array<{ id: string; name: string }>;
	/**
	 * Cooperative steering signal: aborted when a queued steering message is detected while this
	 * batch runs. NEVER kills the tool; long-running tools MAY finish early or background
	 * themselves. Ignoring it is always safe (the message injects at the next boundary).
	 */
	steeringSignal?: AbortSignal;
}

// AgentTool.execute
execute: (
	toolCallId: string,
	params: Static<TParameters>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails>,
	context?: ToolCallContext,
) => Promise<AgentToolResult<TDetails>>;
```

### 2d. Loop changes in `executeToolCalls*` (`agent-loop.ts:585-726`)

Mirrors `omp agent-loop.ts:2336-2352` (controllers), `:2416-2454` (`checkSteering`), `:2495-2515` (skip), `:2713` + `:2726-2775` (watcher), `:2814-2823` + `:2980-3010` (tail sweep / synthesized result):

```ts
const interruptImmediately = config.interruptMode === "immediate";
const steeringAbort = new AbortController();      // L2: interruptible tools only
const steeringSoft = new AbortController();       // L3: ctx.steeringSignal for every tool
const interruptibleSignal = signal ? AbortSignal.any([signal, steeringAbort.signal]) : steeringAbort.signal;
let steeringDetected = false;

const checkSteering = async (): Promise<void> => {
	if (!interruptImmediately || signal?.aborted || steeringDetected) return;
	if (config.hasSteeringMessages && (await config.hasSteeringMessages())) {
		steeringDetected = true;
		steeringAbort.abort();
		steeringSoft.abort();
	}
};

// per call, before execute (both sequential and parallel paths):
if (steeringDetected) {
	return { result: createSkippedToolResult(), isError: true };   // not started → synthesized
}
const interruptible = typeof tool.interruptible === "function" ? tool.interruptible(args) : tool.interruptible === true;
const toolSignal = interruptible ? interruptibleSignal : signal;
const result = await tool.execute(toolCall.id, args, toolSignal, onUpdate, {
	batchId, index, total: toolCalls.length, toolCalls: toolCallInfos, steeringSignal: steeringSoft.signal,
});
// after each call finalizes:
await checkSteering();

// watcher while the batch runs (event-driven when waitForSteeringMessages is present):
//   loop { await config.waitForSteeringMessages(batchSignal); await checkSteering(); }  — torn down in finally

function createSkippedToolResult(): AgentToolResult<any> {
	return {
		content: [{
			type: "text",
			text: "Skipped due to queued user message. Do not count this skipped result as completed work or verification. After the queued message is handled on the next step, retry the skipped tool if it is still needed.",
		}],
		details: { __synthetic: true, source: "interrupt_skipped", executed: false },
	};
}
```

Neutrality: with `interruptMode` unset (`"wait"`), `checkSteering` is a no-op, no signal is combined, every tool receives exactly the run signal, no call is skipped, and the 5th argument is the only observable addition (ignored by existing tools).

Tests to add: (i) `"wait"` → existing steering tests (`agent-loop.test.ts`) unchanged; (ii) `"immediate"` + a steer queued while tool A runs → not-yet-started sibling B returns the skipped text with `isError: true`, an `interruptible` C is aborted through its signal, a non-interruptible D keeps running and sees `context.steeringSignal.aborted === true`; the steering message is injected at `:397` before the next provider call within the same run.

---

## Why two PRs

Stage 1 has no default-behaviour change and unblocks hosts (labelled interrupts, complete transcripts) immediately. Stage 2 changes tool dispatch and therefore needs the `"wait"` default plus the watcher lifecycle review; it depends on Stage 1 only for consistent abort texts. evopi tracks both as `docs/design/NEXT-STEPS.md` D2 and replaces its wrapper-level emulation (`tool-definition-wrapper.ts` `ToolSteeringRuntime`, `agent-session.ts` `_trySteerAction`) with the loop contract once Stage 2 lands.
