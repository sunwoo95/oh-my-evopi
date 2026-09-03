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
 * Mode is read once per session. `EVOPI_PERMISSION_GATE` wins over the
 * `permissionGate.mode` setting:
 * - `block` (default) — interactive: prompt for confirmation; non-interactive:
 *   block dangerous commands. This is the R3 [자동확정] behavior.
 * - `warn` — never blocks; notifies on a dangerous command (R3 [폴백-경고만]).
 * - `off` — gate disabled (e.g. the `eval` profile's unattended auto-approve).
 *
 * `permissionGate.allow` (settings.json, global or project) is a list of regex
 * sources; a command matching any of them skips the gate entirely (A3).
 *
 * Every decision is recorded in the session log as a `permission_gate` entry
 * carrying only a truncated sha256 of the command, never its text (A5).
 *
 * The mode maps to the D4 profiles: strict/dev → `block`, eval → `off`.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix } from "node:path";
import { probeSandbox, type SandboxProbeResult } from "../../sandbox-probe.js";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolCallEvent } from "../types.js";
import { isToolCallEventType } from "../types.js";

export type PermissionGateMode = "block" | "warn" | "off";

/** Settings-file view of the gate (`permissionGate` in settings.json). */
export interface PermissionGateSettingsView {
	mode?: PermissionGateMode;
	/** Regex sources; a command matching any of them bypasses the gate. */
	allow?: readonly string[];
}

// Deliberately tight: a missed destructive command costs far more than a
// confirmation prompt. Patterns are matched against the whole command text, so
// compound forms (`cd x && rm -rf /`) are caught without shell tokenizing.
// Recursive `rm` is the exception: it is classified per target by
// {@link hasDangerousRecursiveRm} so `rm -rf ./dist` under the project passes.
const DANGEROUS_PATTERNS: readonly RegExp[] = [
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

// --- recursive rm classifier -------------------------------------------------

/** Shell list/pipeline separators; segments are evaluated left to right so `cd` can be tracked. */
const SHELL_SEGMENT_SPLIT = /&&|\|\||;|\||\n/;

/**
 * `cd <target>` in command position. Tolerates the wrappers the ipython shell
 * markers produce (`await bash("cd / && …")`, `!cd`, `$(cd …)`).
 */
const CD_RE = /^(?:\s*(?:await|sudo|then|do|else|\{|\(|[\w.]+\(|["'`!]))*\s*cd(?=\s|$)\s*([^\s;&|)`'"]*)/;

/**
 * Every `rm` invocation with its raw argument text. The leading class lets an
 * embedded literal (`bash("rm -rf /")`, `!rm -rf /`) match; the argument run
 * stops at a list separator or closing quote/paren so the literal's own
 * delimiters are not read as targets.
 */
const RM_RE = /(?:^|[\s;&|(`!'"])(?:\S*\/)?rm\s+((?:"[^"\n]*"|'[^'\n]*'|[^\n;&|)`'"])*)/g;

const HOME_PREFIX_RE = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/;

/** Whitespace split that honors quotes (stripped) and backslash escapes. */
function splitShellArgs(text: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let hasToken = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			else if (ch === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			hasToken = true;
		} else if (ch === "\\" && i + 1 < text.length) {
			current += text[++i];
			hasToken = true;
		} else if (/\s/.test(ch)) {
			if (hasToken) out.push(current);
			current = "";
			hasToken = false;
		} else {
			current += ch;
			hasToken = true;
		}
	}
	if (hasToken) out.push(current);
	return out;
}

function normalizeDir(dir: string): string {
	const resolved = posix.resolve(dir);
	return resolved === "/" ? resolved : resolved.replace(/\/+$/, "");
}

function isInside(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
}

/** Track the directory a later relative `rm` target resolves against. Unknown expansions leave it untouched. */
function applyCd(segment: string, current: string | undefined, home: string): string | undefined {
	const match = CD_RE.exec(segment);
	if (!match) return current;
	const target = match[1];
	if (target === "" || target === "~") return home;
	if (target.startsWith("~/")) return normalizeDir(posix.join(home, target.slice(2)));
	if (target.startsWith("$")) return current;
	if (target === "-") return undefined;
	if (posix.isAbsolute(target)) return normalizeDir(target);
	return current === undefined ? undefined : normalizeDir(posix.join(current, target));
}

/**
 * Whether one `rm -r` target is destructive: `/`, `~`/`$HOME`, a bare `*` or
 * `/*`, or a path that resolves outside the session cwd (via `..`, an absolute
 * path, or an earlier `cd`). With no cwd known, absolute paths and `..` are
 * conservatively dangerous; plain relative paths pass.
 */
function isDangerousRmTarget(
	rawTarget: string,
	dir: string | undefined,
	cwd: string | undefined,
	home: string,
): boolean {
	let target = rawTarget;
	if (target === "") return false;
	if (/^\/+$/.test(target) || /^\/+\*+$/.test(target) || /^\*+$/.test(target)) return true;
	const homeMatch = HOME_PREFIX_RE.exec(target);
	if (homeMatch) {
		const rest = target.slice(homeMatch[0].length).replace(/^\/+/, "");
		if (rest === "" || /^\*+$/.test(rest)) return true;
		target = posix.join(home, rest);
	} else if (target.startsWith("$")) {
		// Unknown variable expansion ($TMPDIR/x, "$OUT") — treated like a relative path.
		return false;
	}

	if (posix.isAbsolute(target)) {
		if (cwd === undefined) return true;
		return !isInside(posix.resolve(target), cwd);
	}
	const base = dir ?? cwd;
	if (base === undefined) {
		return target.split("/").includes("..");
	}
	const resolved = posix.resolve(base, target);
	if (cwd === undefined) return true; // base came from `cd /abs` while the session cwd is unknown
	return !isInside(resolved, cwd);
}

/**
 * Whether `command` contains a recursive `rm` whose target is destructive
 * (see {@link isDangerousRmTarget}). Relative targets under the cwd pass,
 * which is the A3 false-positive reduction (`rm -rf ./tmp-build`).
 */
export function hasDangerousRecursiveRm(command: string, cwd?: string): boolean {
	const home = process.env.HOME?.trim() || homedir();
	const sessionCwd = cwd && posix.isAbsolute(cwd) ? normalizeDir(cwd) : undefined;
	let dir = sessionCwd;
	for (const segment of command.split(SHELL_SEGMENT_SPLIT)) {
		RM_RE.lastIndex = 0;
		for (let match = RM_RE.exec(segment); match; match = RM_RE.exec(segment)) {
			let recursive = false;
			let endOfFlags = false;
			const targets: string[] = [];
			for (const token of splitShellArgs(match[1])) {
				if (!endOfFlags && token === "--") {
					endOfFlags = true;
					continue;
				}
				if (!endOfFlags && token.length > 1 && token.startsWith("-")) {
					if (token === "--recursive" || (!token.startsWith("--") && /[rR]/.test(token))) recursive = true;
					continue;
				}
				if (/[<>]/.test(token)) continue; // redirection, not a target
				targets.push(token);
			}
			if (!recursive) continue;
			if (targets.some((target) => isDangerousRmTarget(target, dir, sessionCwd, home))) return true;
		}
		dir = applyCd(segment, dir, home);
	}
	return false;
}

/**
 * Whether a shell command string matches a destructive pattern the gate guards.
 * `cwd` (the session working directory) lets recursive `rm` targets under the
 * project pass; without it, absolute and `..` targets are treated as dangerous.
 */
export function isDangerousCommand(command: string, options?: { cwd?: string }): boolean {
	if (DANGEROUS_PATTERNS.some((p) => p.test(command))) return true;
	return hasDangerousRecursiveRm(command, options?.cwd);
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

function parseMode(raw: unknown): PermissionGateMode | undefined {
	if (typeof raw !== "string") return undefined;
	const value = raw.trim().toLowerCase();
	return value === "warn" || value === "off" || value === "block" ? value : undefined;
}

/** `EVOPI_PERMISSION_GATE` wins; then `permissionGate.mode`; default `block`. */
function resolveMode(settings: PermissionGateSettingsView | undefined): PermissionGateMode {
	return parseMode(process.env.EVOPI_PERMISSION_GATE) ?? parseMode(settings?.mode) ?? "block";
}

// --- telemetry (A5) ---------------------------------------------------------

export type PermissionGateDecision =
	| "allowed-by-whitelist"
	| "warned"
	| "blocked"
	| "confirmed-by-user"
	| "denied-by-user";

export type PermissionGateHazardKind = "dangerous-command" | "protected-path-write";

/** Session-log entry (`permission_gate`). Carries a truncated command hash, never the command. */
export interface PermissionGateLogEntry {
	decision: PermissionGateDecision;
	hazardKind: PermissionGateHazardKind;
	tool: string;
	/** First 16 hex chars of sha256(command text). */
	commandSha256: string;
	mode: PermissionGateMode;
}

export const PERMISSION_GATE_ENTRY_TYPE = "permission_gate";

export function hashCommandForLog(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

interface Hazard {
	/** Human-readable kind shown in prompts/notices. */
	kind: string;
	hazardKind: PermissionGateHazardKind;
	/** The command or cell text that triggered the hazard. */
	text: string;
}

function detectHazard(event: ToolCallEvent, cwd: string | undefined): Hazard | undefined {
	const command = extractShellCommand(event);
	if (command !== undefined && isDangerousCommand(command, { cwd })) {
		return { kind: "Dangerous command", hazardKind: "dangerous-command", text: command };
	}
	const text = extractExecutableText(event);
	if (text === undefined) return undefined;
	const protectedPath = protectedPathWrite(text);
	if (protectedPath === undefined) return undefined;
	return { kind: `Write to protected path ${protectedPath}`, hazardKind: "protected-path-write", text };
}

/**
 * Build the built-in permission-gate factory.
 *
 * `probe` is injectable for tests; it defaults to the real {@link probeSandbox}.
 * `mode` is injectable for tests; it defaults to `EVOPI_PERMISSION_GATE`, then
 * `permissionGate.mode` from `settings`, then `block`.
 * `settings` reads the `permissionGate` settings block (mode + allow list) at
 * session_start; omit it for env-only wiring.
 */
export function createPermissionGateExtension(options?: {
	probe?: () => SandboxProbeResult;
	mode?: () => PermissionGateMode;
	settings?: () => PermissionGateSettingsView | undefined;
}): ExtensionFactory {
	const probe = options?.probe ?? (() => probeSandbox());
	const readSettings = options?.settings ?? (() => undefined);
	const readModeFn = options?.mode ?? (() => resolveMode(readSettings()));
	return (pi: ExtensionAPI) => permissionGateImpl(pi, probe, readModeFn, readSettings);
}

/** Always-on gate with default wiring, for tests and embedders. */
export const permissionGateExtension: ExtensionFactory = createPermissionGateExtension();

function permissionGateImpl(
	pi: ExtensionAPI,
	probe: () => SandboxProbeResult,
	readModeFn: () => PermissionGateMode,
	readSettings: () => PermissionGateSettingsView | undefined,
): void {
	let mode: PermissionGateMode = "block";
	let allow: RegExp[] | undefined;
	const reportedInvalid = new Set<string>();

	const compileAllow = (ctx: ExtensionContext): RegExp[] => {
		const compiled: RegExp[] = [];
		const sources = readSettings()?.allow ?? [];
		for (const source of sources) {
			if (typeof source !== "string") continue;
			try {
				compiled.push(new RegExp(source));
			} catch (error) {
				if (reportedInvalid.has(source)) continue;
				reportedInvalid.add(source);
				const detail = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`permissionGate.allow: ignoring invalid regex ${JSON.stringify(source)} (${detail})`,
					"warning",
				);
			}
		}
		return compiled;
	};

	const record = (entry: PermissionGateLogEntry): void => {
		try {
			pi.appendEntry(PERMISSION_GATE_ENTRY_TYPE, entry);
		} catch {
			// Telemetry must never break the gate.
		}
	};

	pi.on("session_start", (_event, ctx) => {
		mode = readModeFn();
		allow = compileAllow(ctx);
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
		const hazard = detectHazard(event, ctx.cwd);
		if (!hazard) return undefined;

		const entry = (decision: PermissionGateDecision): PermissionGateLogEntry => ({
			decision,
			hazardKind: hazard.hazardKind,
			tool: event.toolName,
			commandSha256: hashCommandForLog(hazard.text),
			mode,
		});

		allow ??= compileAllow(ctx);
		if (allow.some((pattern) => pattern.test(hazard.text))) {
			record(entry("allowed-by-whitelist"));
			return undefined;
		}

		if (mode === "warn") {
			ctx.ui.notify(`⚠️ ${hazard.kind} allowed (warn mode): ${hazard.text}`, "warning");
			record(entry("warned"));
			return undefined;
		}

		// mode === "block"
		if (!ctx.hasUI) {
			record(entry("blocked"));
			return { block: true, reason: `${hazard.kind} blocked (no UI for confirmation): ${hazard.text}` };
		}
		const choice = await ctx.ui.select(`⚠️ ${hazard.kind}:\n\n  ${hazard.text}\n\nAllow?`, ["No", "Yes"]);
		if (choice !== "Yes") {
			record(entry("denied-by-user"));
			return { block: true, reason: "Blocked by user" };
		}
		record(entry("confirmed-by-user"));
		return undefined;
	});
}
