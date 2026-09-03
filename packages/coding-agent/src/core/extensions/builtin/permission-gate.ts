/**
 * Built-in permission gate — the intent layer of evopi's two-layer permission
 * model (D4). Runs a boot-time sandbox capability probe and blocks dangerous
 * shell commands at the `tool_call` boundary before they execute.
 *
 * This is the in-tree, always-loaded promotion of the file-based
 * `examples/extensions/permission-gate.ts`. The enforcement layer (bubblewrap
 * bash wrapping) is a separate concern gated by {@link probeSandbox}; when the
 * OS sandbox is unavailable (e.g. a container without unprivileged user
 * namespaces — see sandbox-probe.ts) this intent layer plus the deployment's
 * own container boundary is the fallback (D3 [폴백]).
 *
 * Mode is read once per session from `EVOPI_PERMISSION_GATE`:
 * - `block` (default) — interactive: prompt for confirmation; non-interactive:
 *   block dangerous commands. This is the R3 [자동확정] behavior.
 * - `warn` — never blocks; notifies on a dangerous command (R3 [폴백-경고만]).
 * - `off` — gate disabled (e.g. the `eval` profile's unattended auto-approve).
 *
 * The mode maps to the D4 profiles: strict/dev → `block`, eval → `off`.
 */

import { probeSandbox, type SandboxProbeResult } from "../../sandbox-probe.js";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolCallEvent } from "../types.js";
import { isToolCallEventType } from "../types.js";

export type PermissionGateMode = "block" | "warn" | "off";

const DANGEROUS_PATTERNS: readonly RegExp[] = [
	/\brm\s+(-[a-z]*r[a-z]*f?|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b[^\n]*\b777\b/i,
	/\bmkfs\b/i,
	/\bdd\b[^\n]*\bof=\/dev\//i,
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // classic fork bomb
	/>\s*\/dev\/sda\b/i,
];

/** Whether a shell command string matches a destructive pattern the gate guards. */
export function isDangerousCommand(command: string): boolean {
	return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

/**
 * Extract the shell command a tool_call would run, if any. Covers `bash`
 * (`command`) and `ipython` shell escapes / process spawns (`code` containing
 * `!cmd`, `os.system`, or `subprocess`), which is evopi's default tool.
 */
export function extractShellCommand(event: ToolCallEvent): string | undefined {
	if (isToolCallEventType("bash", event)) return event.input.command;
	if (isToolCallEventType("ipython", event)) {
		const code = event.input.code;
		if (typeof code !== "string") return undefined;
		if (/^\s*!/m.test(code) || /\bos\.system\b/.test(code) || /\bsubprocess\b/.test(code)) return code;
	}
	return undefined;
}

function readMode(): PermissionGateMode {
	const raw = (process.env.EVOPI_PERMISSION_GATE ?? "").trim().toLowerCase();
	if (raw === "warn" || raw === "off" || raw === "block") return raw;
	return "block";
}

/**
 * Build the built-in permission-gate factory.
 *
 * `probe` is injectable for tests; it defaults to the real {@link probeSandbox}.
 * `mode` is injectable for tests; it defaults to reading `EVOPI_PERMISSION_GATE`
 * at session_start.
 */
export function createPermissionGateExtension(options?: {
	probe?: () => SandboxProbeResult;
	mode?: () => PermissionGateMode;
}): ExtensionFactory {
	const probe = options?.probe ?? (() => probeSandbox());
	const readModeFn = options?.mode ?? readMode;
	return (pi: ExtensionAPI) => permissionGateImpl(pi, probe, readModeFn);
}

/** Always-on gate with default wiring, for tests and embedders. */
export const permissionGateExtension: ExtensionFactory = createPermissionGateExtension();

function permissionGateImpl(
	pi: ExtensionAPI,
	probe: () => SandboxProbeResult,
	readModeFn: () => PermissionGateMode,
): void {
	let mode: PermissionGateMode = "block";

	pi.on("session_start", (_event, ctx) => {
		mode = readModeFn();
		if (mode === "off") return;
		const result = probe();
		if (result.available) {
			ctx.ui.notify(`OS sandbox available (${result.kind}${result.version ? ` ${result.version}` : ""})`, "info");
		} else {
			// The "불가" detection log the R3 gate requires.
			ctx.ui.notify(
				`OS sandbox unavailable: ${result.detail}. Intent-layer permission gate active (mode=${mode}).`,
				"warning",
			);
		}
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (mode === "off") return undefined;
		const command = extractShellCommand(event);
		if (command === undefined || !isDangerousCommand(command)) return undefined;

		if (mode === "warn") {
			ctx.ui.notify(`⚠️ Dangerous command allowed (warn mode): ${command}`, "warning");
			return undefined;
		}

		// mode === "block"
		if (!ctx.hasUI) {
			return { block: true, reason: `Dangerous command blocked (no UI for confirmation): ${command}` };
		}
		const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["No", "Yes"]);
		if (choice !== "Yes") {
			return { block: true, reason: "Blocked by user" };
		}
		return undefined;
	});
}
