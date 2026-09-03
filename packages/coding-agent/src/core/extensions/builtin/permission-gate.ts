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

// Deliberately tight: a missed destructive command costs far more than a
// confirmation prompt. Patterns are matched against the whole command text, so
// compound forms (`cd x && rm -rf /`) are caught without shell tokenizing.
const DANGEROUS_PATTERNS: readonly RegExp[] = [
	/\brm\s+(-[a-z]*r[a-z]*f?|--recursive)/i,
	/\brm\b[^\n]*--no-preserve-root/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b[^\n]*\b777\b/i,
	/\b(chmod|chown)\b\s+-[a-z]*R[a-z]*\b[^\n]*\s\/(\s|$)/, // recursive mode/owner change rooted at /
	/\bmkfs(\.[a-z0-9]+)?\b/i,
	/\bdd\b[^\n]*\bof=\/dev\//i,
	/\bshred\b[^\n]*\/dev\//i,
	/\bcryptsetup\b/i,
	/:\(\)\s*\{\s*:\|:&\s*\}\s*;/, // classic fork bomb
	/>\s*\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|nvme\d)/i, // raw write to a block device
	/>\s*\/etc\/(passwd|shadow|sudoers)\b/i,
	/\btee\b[^\n]*\/etc\/(passwd|shadow|sudoers)\b/i,
	/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, // pipe a download straight into a shell
	/\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/i,
	/\beval\s+["']?\$\(\s*(curl|wget)\b/i,
	/\bkill\s+-9\s+(-1|1)\b/,
	/\b(shutdown|reboot|halt|poweroff)\b/i,
	/\binit\s+0\b/,
	/\bnc\b[^\n]*\s-[a-z]*[ec]\b/i, // netcat with -e/-c (remote shell)
];

/** Whether a shell command string matches a destructive pattern the gate guards. */
export function isDangerousCommand(command: string): boolean {
	return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

/** Python constructs in an ipython cell that hand a string to a shell. */
const IPYTHON_SHELL_MARKERS: readonly RegExp[] = [
	/^\s*!/m, // IPython `!cmd` escape
	/\bbash\s*\(/, // rlm.bash() — evopi's primary shell path from a cell
	/\bos\.(system|popen|exec[lv]p?e?|spawn[lv]p?e?)\b/,
	/\bsubprocess\b/,
	/\bpexpect\b/,
];

/**
 * Extract the shell command a tool_call would run, if any. Covers `bash`
 * (`command`) and `ipython` cells that reach a shell — the runtime's `bash()`
 * helper, IPython `!cmd` escapes, and process spawns via os/subprocess/pexpect.
 * The whole cell text is returned so the patterns see the command literal.
 */
export function extractShellCommand(event: ToolCallEvent): string | undefined {
	if (isToolCallEventType("bash", event)) return event.input.command;
	if (isToolCallEventType("ipython", event)) {
		const code = event.input.code;
		if (typeof code !== "string") return undefined;
		if (IPYTHON_SHELL_MARKERS.some((marker) => marker.test(code))) return code;
	}
	return undefined;
}

// Files whose *modification* from a cell or shell command needs confirmation.
// Reads stay free (dotenv loading, `cat .env`), and the ubiquitous example /
// template variants are not secrets.
const PROTECTED_PATH_PATTERNS: readonly RegExp[] = [
	/(^|[\s"'/=])\.env(?!\.(example|sample|template|dist)\b)(\.[a-z0-9_-]+)?(?=$|[\s"'\\)])/i,
	/(^|[\s"'])\.git(\/|["'\s]|$)/,
	/(^|[\s"'~/])\.ssh(\/|["'\s]|$)/,
	/\bid_(rsa|dsa|ecdsa|ed25519)\b/,
	/[\w./-]+\.(pem|key|p12|pfx)\b/i,
	/\.aws\/credentials\b/,
	/(^|[\s"'~/])\.gnupg(\/|["'\s]|$)/,
	/\/agent\/auth\.json\b/,
];

// Python / shell constructs that write, delete, or re-permission a path.
const MUTATION_MARKERS: readonly RegExp[] = [
	/\bedit\s*\(/, // Python edit skill
	/\bopen\s*\([^)]*["'][wax]\+?b?["']/, // open(path, "w"/"a"/"x")
	/\.write_(text|bytes)\s*\(/,
	/\bshutil\.(rmtree|move|copy\w*)\s*\(/,
	/\bos\.(remove|unlink|rename|replace|chmod|chown|truncate)\s*\(/,
	/\.(unlink|rename|replace|chmod|rmdir|touch)\s*\(/, // pathlib
	/(^|[^<>])>{1,2}\s*["']?[^\s"']/, // shell redirection into a file
	/\b(rm|mv|cp|chmod|chown|truncate|tee|ln)\s/,
	/\bsed\s+-[a-z]*i/,
];

/** The protected path an operation would modify, or undefined when it only reads / touches nothing sensitive. */
export function protectedPathWrite(text: string): string | undefined {
	if (!MUTATION_MARKERS.some((m) => m.test(text))) return undefined;
	for (const pattern of PROTECTED_PATH_PATTERNS) {
		const match = pattern.exec(text);
		if (match) return match[0].trim().replace(/^["'/=]+|["'\\)]+$/g, "") || match[0].trim();
	}
	return undefined;
}

/** Text a tool_call would hand to a shell or interpreter: bash command or the whole ipython cell. */
export function extractExecutableText(event: ToolCallEvent): string | undefined {
	if (isToolCallEventType("bash", event)) return event.input.command;
	if (isToolCallEventType("ipython", event)) {
		const code = event.input.code;
		return typeof code === "string" ? code : undefined;
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
		let hazard: { kind: string; text: string } | undefined;
		if (command !== undefined && isDangerousCommand(command)) {
			hazard = { kind: "Dangerous command", text: command };
		} else {
			const text = extractExecutableText(event);
			if (text !== undefined) {
				const protectedPath = protectedPathWrite(text);
				if (protectedPath !== undefined) hazard = { kind: `Write to protected path ${protectedPath}`, text };
			}
		}
		if (!hazard) return undefined;

		if (mode === "warn") {
			ctx.ui.notify(`⚠️ ${hazard.kind} allowed (warn mode): ${hazard.text}`, "warning");
			return undefined;
		}

		// mode === "block"
		if (!ctx.hasUI) {
			return { block: true, reason: `${hazard.kind} blocked (no UI for confirmation): ${hazard.text}` };
		}
		const choice = await ctx.ui.select(`⚠️ ${hazard.kind}:\n\n  ${hazard.text}\n\nAllow?`, ["No", "Yes"]);
		if (choice !== "Yes") {
			return { block: true, reason: "Blocked by user" };
		}
		return undefined;
	});
}
