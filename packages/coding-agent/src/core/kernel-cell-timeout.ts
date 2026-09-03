/** Wire-safe types and parsing for the immediate `/kernel timeout` APIs (A4). */

/**
 * Where the effective per-cell cap comes from, highest precedence first:
 * `chat` (this session's `/kernel timeout`, persisted in the session log),
 * `env` (`EVOPI_KERNEL_CELL_TIMEOUT_MS`), `settings` (`kernel.cellTimeoutMs`),
 * `default` (30 minutes).
 */
export type KernelCellTimeoutSource = "default" | "settings" | "env" | "chat";

export interface KernelCellTimeoutStatus {
	/** Effective cap for the next cell in ms; 0 = no cap. */
	timeoutMs: number;
	source: KernelCellTimeoutSource;
	/**
	 * Set when `EVOPI_KERNEL_CELL_TIMEOUT_MS` is present: it will shadow a `--global`
	 * save in new sessions (env beats settings). Value is the env-resolved cap.
	 */
	envTimeoutMs?: number;
	/** The user cell running right now, if any. */
	activeCell?: { elapsedMs: number; timeoutMs: number; timedOut: boolean };
}

export interface SetKernelCellTimeoutResult extends KernelCellTimeoutStatus {
	/** True when the running cell's cap was re-armed; false when no cell runs or its cap already fired. */
	appliedToRunningCell: boolean;
	/** A cell was running but its cap had already fired — the new value only reaches the next cell. */
	runningCellTooLate: boolean;
	globalSaved: boolean;
	globalError?: string;
}

/**
 * Parse the `/kernel timeout` argument: `<ms>` (digits), `<n>s|m|h` (decimals
 * allowed), or `off|none|0` for no cap. Returns undefined for anything else.
 */
export function parseKernelTimeoutArg(text: string): number | undefined {
	const raw = text.trim().toLowerCase();
	if (raw === "off" || raw === "none" || raw === "0") return 0;
	if (/^\d+$/.test(raw)) {
		const ms = Number(raw);
		return Number.isSafeInteger(ms) ? ms : undefined;
	}
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw);
	if (!match) return undefined;
	const value = Number(match[1]);
	const unit = match[2];
	const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
	const ms = Math.round(value * factor);
	return Number.isSafeInteger(ms) ? ms : undefined;
}

/**
 * Mirror of SettingsManager's env parsing: `off|none` -> 0, digits -> ms,
 * anything else (including unset) -> undefined.
 */
export function parseKernelCellTimeoutEnv(raw: string | undefined): number | undefined {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "off" || value === "none") return 0;
	if (/^\d+$/.test(value)) return Number(value);
	return undefined;
}

/** Human-friendly cap: `off`, `750ms`, `1.5s`, `30m`, `2h`. */
export function formatKernelTimeout(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "off";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const trim = (n: number) => String(Math.round(n * 10) / 10);
	if (ms < 60_000) return `${trim(ms / 1_000)}s`;
	if (ms < 3_600_000) return `${trim(ms / 60_000)}m`;
	return `${trim(ms / 3_600_000)}h`;
}
