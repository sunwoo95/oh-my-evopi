/**
 * withAuthStream — credential rotation for streaming model requests (B2/M16).
 *
 * pi-ai providers never throw after the stream starts; failures arrive as an
 * `error` event carrying a resolved AssistantMessage. `withAuth` (promise
 * contract) therefore cannot rotate keys on the stream path. This mirrors
 * omp's replay-buffer machinery (`stream.ts:1470-1592`) on evopi primitives:
 *
 * - Events are buffered while still replay-safe (**only `start`** qualifies —
 *   the first text/thinking/toolcall/done event means content reached the
 *   consumer and the attempt can no longer be silently replayed).
 * - An auth-classified `error` event before that boundary retries silently
 *   with the next credential via the existing a/b/c retry state machine.
 * - After the boundary, everything passes through untouched.
 * - On exhaustion the last attempt's buffered events are replayed and its
 *   terminal error event is delivered.
 *
 * Every failure path terminates the outer stream by pushing an `error` event
 * with a complete AssistantMessage — pi-ai's EventStream has no `fail()`, and
 * an unterminated stream would hang the agent loop's `result()`.
 */

import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Model } from "@evopi/pi-ai";
import { createAssistantMessageEventStream } from "@evopi/pi-ai";
import { isAuthRetryableAssistantError } from "./classify.js";
import { type ApiKeyResolver, createAuthRetryKeyState, resolveNextAuthRetryKey } from "./retry.js";

export interface WithAuthStreamOptions {
	signal?: AbortSignal;
	/** Used to synthesize a terminal error AssistantMessage for pre-stream throws. */
	model: Model<Api>;
	/** Override the auth classification of terminal error messages (tests). */
	isAuthErrorEvent?: (error: AssistantMessage) => boolean;
}

type AttemptOutcome =
	| { kind: "delivered" }
	| { kind: "auth-failure"; error: Error; buffered: AssistantMessageEvent[]; terminal: AssistantMessageEvent };

function makeErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		provider: model.provider,
		model: model.id,
		api: model.api,
	} as AssistantMessage;
}

export function withAuthStream(
	resolver: ApiKeyResolver,
	attempt: (key: string) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
	opts: WithAuthStreamOptions,
): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	const isAuthError = opts.isAuthErrorEvent ?? isAuthRetryableAssistantError;
	const signal = opts.signal;

	const emitTerminal = (buffered: AssistantMessageEvent[], terminal: AssistantMessageEvent): void => {
		for (const event of buffered) outer.push(event);
		outer.push(terminal);
		outer.end();
	};

	const runAttempt = async (key: string): Promise<AttemptOutcome> => {
		const buffered: AssistantMessageEvent[] = [];
		let replaySafe = true;
		let inner: AssistantMessageEventStream;
		try {
			inner = await attempt(key);
		} catch (error) {
			// Defensive: pi-ai contract is no-throw, but a broken custom provider
			// pre-stream throw is still auth-rotatable when it classifies as such.
			const failure = makeErrorMessage(opts.model, error);
			const terminal: AssistantMessageEvent = { type: "error", reason: "error", error: failure };
			if (isAuthError(failure)) {
				return {
					kind: "auth-failure",
					error: error instanceof Error ? error : new Error(String(error)),
					buffered,
					terminal,
				};
			}
			emitTerminal(buffered, terminal);
			return { kind: "delivered" };
		}

		for await (const event of inner) {
			if (replaySafe && event.type === "start") {
				buffered.push(event);
				continue;
			}
			if (replaySafe && event.type === "error") {
				// stopReason "aborted" is a user cancel — never rotated, always delivered.
				if (event.error.stopReason === "error" && isAuthError(event.error) && !signal?.aborted) {
					return {
						kind: "auth-failure",
						error: new Error(event.error.errorMessage ?? "authentication failed"),
						buffered,
						terminal: event,
					};
				}
				emitTerminal(buffered, event);
				return { kind: "delivered" };
			}
			// First replay-unsafe event: flush the buffer and go transparent.
			if (replaySafe) {
				replaySafe = false;
				for (const bufferedEvent of buffered) outer.push(bufferedEvent);
				buffered.length = 0;
			}
			outer.push(event);
		}
		// Providers complete via a done/error event; reaching here means the inner
		// stream ended. Mirror its termination on the outer stream.
		if (replaySafe) {
			// Ended without any content or terminal event — treat as an empty
			// delivery so the consumer is not left hanging.
			for (const bufferedEvent of buffered) outer.push(bufferedEvent);
		}
		outer.end();
		return { kind: "delivered" };
	};

	void (async () => {
		try {
			const initialKey = (await resolver({ lastChance: false, error: undefined, signal })) || undefined;
			if (!initialKey) {
				const failure = makeErrorMessage(
					opts.model,
					new Error(`No API key found for provider "${opts.model.provider}"`),
				);
				emitTerminal([], { type: "error", reason: "error", error: failure });
				return;
			}

			const state = createAuthRetryKeyState(initialKey);
			let outcome = await runAttempt(initialKey);
			while (outcome.kind === "auth-failure" && !signal?.aborted) {
				const nextKey = await resolveNextAuthRetryKey(state, resolver, outcome.error, signal);
				if (!nextKey) break;
				outcome = await runAttempt(nextKey);
			}
			// Exhausted (or aborted mid-rotation): report the most recent failure.
			if (outcome.kind === "auth-failure") {
				emitTerminal(outcome.buffered, outcome.terminal);
			}
		} catch (error) {
			// Absolute backstop: the outer stream must always terminate.
			const failure = makeErrorMessage(opts.model, error);
			emitTerminal([], { type: "error", reason: "error", error: failure });
		}
	})();

	return outer;
}
