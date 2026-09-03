/**
 * Built-in permission gate — the intent layer of evopi's two-layer permission
 * model (D4). Runs a boot-time sandbox capability probe and gates tool calls at
 * the `tool_call` boundary before they execute.
 *
 * This is the in-tree, always-loaded promotion of the file-based
 * `examples/extensions/permission-gate.ts`. The enforcement layer (bubblewrap
 * bash wrapping) is a separate concern gated by {@link probeSandbox}; when the
 * OS sandbox is unavailable (e.g. a container without unprivileged user
 * namespaces — see sandbox-probe.ts) this intent layer plus the deployment's
 * own container boundary is the fallback (D3 [폴백]).
 *
 * Approval tiers (NS-D5). Every tool call is classified into a tier —
 * `read` (a cell that only computes / reads), `write` (a cell that mutates a
 * path, the kernel `edit` skill in both its `await edit(...)` and `!edit --path`
 * forms, `edit` / `hashline_edit`), or `exec` (bash, a cell that reaches a
 * shell, and extension/MCP tools unless `approval.toolTiers` says otherwise).
 * The hazard axis — destructive shell patterns and protected-path writes — is
 * detected on top of the tier. Each axis carries a policy: `auto` (run),
 * `warn` (run + notify), `ask` (confirm in the TUI, block without a UI) or
 * `deny`. The stricter of the tier policy and the hazard policy applies.
 *
 * Presets: `dev` (default) = tiers auto, hazard ask — byte-identical to the
 * legacy `block` mode; `strict` = write/exec ask; `yolo` = everything auto (gate
 * off, the legacy `off`). Resolution, highest first: `EVOPI_APPROVAL` (preset
 * and/or `read=..,write=..,exec=..,hazard=..`), `EVOPI_PERMISSION_GATE`
 * (`off` → yolo; `block`/`warn` → hazard-axis overlay only), `approval.<axis>`,
 * `approval.preset`, `permissionGate.mode` (same mapping), then `dev`.
 * Everything is read once per `session_start`.
 *
 * `permissionGate.allow` (settings.json, global or project) is a list of regex
 * sources; a call whose text matches any of them is auto-approved, hazard and
 * tier prompts alike (A3).
 *
 * Every non-auto decision is recorded in the session log as a
 * `permission_gate` entry carrying only a truncated sha256 of the text, never
 * the text itself (A5).
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix } from "node:path";
import { probeSandbox, type SandboxProbeResult } from "../../sandbox-probe.js";
import type { ApprovalPolicy, ApprovalPreset, ApprovalSettings, ApprovalTier } from "../../settings-manager.js";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ToolCallEvent } from "../types.js";
import { isToolCallEventType } from "../types.js";

export type { ApprovalPolicy, ApprovalPreset, ApprovalSettings, ApprovalTier };

/** Legacy three-mode view; `block`/`warn` become a hazard-axis overlay, `off` the `yolo` preset. */
export type PermissionGateMode = "block" | "warn" | "off";

/** Settings-file view of the gate (`permissionGate` + `approval` in settings.json). */
export interface PermissionGateSettingsView {
	mode?: PermissionGateMode;
	/** Regex sources; a call whose text matches any of them bypasses the gate. */
	allow?: readonly string[];
	/** Approval tiers (NS-D5): preset, per-axis policies and tool tier overrides. */
	approval?: ApprovalSettings;
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
// Layout matters: the Python-side markers come first, the trailing
// SHELL_ONLY_MUTATION_MARKER_COUNT entries only mean a write inside shell text
// (see {@link PYTHON_MUTATION_MARKERS}).
const MUTATION_MARKERS: readonly RegExp[] = [
	/\bedit\s*\(/, // Python edit skill
	/^\s*!\s*edit(?=\s|$)/m, // shell form of the edit skill (`!edit --path …`)
	/\bopen\s*\([^)]*["'][wax]\+?b?["']/, // open(path, "w"/"a"/"x")
	/\.write_(text|bytes)\s*\(/,
	/\bshutil\.(rmtree|move|copy\w*)\s*\(/,
	/\bos\.(remove|unlink|rename|replace|chmod|chown|truncate)\s*\(/,
	/\.(unlink|rename|replace|chmod|rmdir|touch)\s*\(/, // pathlib
	/(^|[^<>])>{1,2}\s*["']?[^\s"']/, // shell redirection into a file
	/\b(rm|mv|cp|chmod|chown|truncate|tee|ln)\s/,
	/\bsed\s+-[a-z]*i/,
];

/** Trailing MUTATION_MARKERS entries that are shell syntax (redirection, rm/mv/…, sed -i), meaningless in plain Python. */
const SHELL_ONLY_MUTATION_MARKER_COUNT = 3;

/**
 * Markers that mean a write in a cell that never reaches a shell. The shell-only
 * markers are excluded so `if x > 3:` or `-> int` does not read as a write.
 */
const PYTHON_MUTATION_MARKERS: readonly RegExp[] = MUTATION_MARKERS.slice(
	0,
	MUTATION_MARKERS.length - SHELL_ONLY_MUTATION_MARKER_COUNT,
);

/** The protected path an operation would modify, or undefined when it only reads / touches nothing sensitive. */
export function protectedPathWrite(text: string): string | undefined {
	if (!MUTATION_MARKERS.some((m) => m.test(text))) return undefined;
	return matchProtectedPath(text);
}

function matchProtectedPath(text: string): string | undefined {
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

// --- approval tiers (NS-D5) --------------------------------------------------

/** Effective policy per axis: the three tool tiers plus the hazard axis (dangerous command / protected-path write). */
export interface ApprovalConfig {
	read: ApprovalPolicy;
	write: ApprovalPolicy;
	exec: ApprovalPolicy;
	hazard: ApprovalPolicy;
}

export type ApprovalAxis = keyof ApprovalConfig;

const APPROVAL_AXES: readonly ApprovalAxis[] = ["read", "write", "exec", "hazard"];

export const APPROVAL_PRESETS: Readonly<Record<ApprovalPreset, Readonly<ApprovalConfig>>> = {
	// == legacy `block`: ordinary reads/writes/execs run; hazards ask (block without a UI).
	dev: { read: "auto", write: "auto", exec: "auto", hazard: "ask" },
	// Every write and every shell/exec call asks; reads stay free.
	strict: { read: "auto", write: "ask", exec: "ask", hazard: "ask" },
	// == legacy `off`: the whole gate is disabled.
	yolo: { read: "auto", write: "auto", exec: "auto", hazard: "auto" },
};

const POLICY_RANK: Readonly<Record<ApprovalPolicy, number>> = { auto: 0, warn: 1, ask: 2, deny: 3 };

function isApprovalPreset(value: unknown): value is ApprovalPreset {
	return value === "dev" || value === "strict" || value === "yolo";
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
	return value === "auto" || value === "warn" || value === "ask" || value === "deny";
}

function isApprovalTier(value: unknown): value is ApprovalTier {
	return value === "read" || value === "write" || value === "exec";
}

function isApprovalAxis(value: unknown): value is ApprovalAxis {
	return isApprovalTier(value) || value === "hazard";
}

/** Legacy mode mapped onto a config: `off` → the `yolo` preset; `block`/`warn` → hazard-axis overlay only. */
export function applyLegacyMode(config: Readonly<ApprovalConfig>, mode: PermissionGateMode): ApprovalConfig {
	if (mode === "off") return { ...APPROVAL_PRESETS.yolo };
	return { ...config, hazard: mode === "warn" ? "warn" : "ask" };
}

/** Legacy mode a config maps back to: all auto → `off`; nothing stricter than warn → `warn`; else `block`. */
export function legacyModeOf(config: Readonly<ApprovalConfig>): PermissionGateMode {
	const policies = APPROVAL_AXES.map((axis) => config[axis]);
	if (policies.every((policy) => policy === "auto")) return "off";
	if (policies.every((policy) => policy === "auto" || policy === "warn")) return "warn";
	return "block";
}

/** Whether every axis is `auto` (the `yolo` preset / legacy `off`): the gate does nothing at all. */
export function isGateDisabled(config: Readonly<ApprovalConfig>): boolean {
	return legacyModeOf(config) === "off";
}

/** The preset a config equals exactly, or `custom`. */
export function presetNameOf(config: Readonly<ApprovalConfig>): ApprovalPreset | "custom" {
	for (const [name, preset] of Object.entries(APPROVAL_PRESETS) as Array<[ApprovalPreset, ApprovalConfig]>) {
		if (APPROVAL_AXES.every((axis) => preset[axis] === config[axis])) return name;
	}
	return "custom";
}

/** `read=auto write=ask exec=ask hazard=ask` */
export function describeApprovalConfig(config: Readonly<ApprovalConfig>): string {
	return APPROVAL_AXES.map((axis) => `${axis}=${config[axis]}`).join(" ");
}

/** A config the legacy block/warn/off modes can express (tiers auto, hazard not deny). */
function isLegacyExpressible(config: Readonly<ApprovalConfig>): boolean {
	return config.read === "auto" && config.write === "auto" && config.exec === "auto" && config.hazard !== "deny";
}

export interface ParsedApprovalEnv {
	preset?: ApprovalPreset;
	overrides: Partial<ApprovalConfig>;
	/** Tokens that were neither a preset nor a valid `axis=policy` pair. */
	invalid: string[];
}

const APPROVAL_ENV = "EVOPI_APPROVAL";
const LEGACY_GATE_ENV = "EVOPI_PERMISSION_GATE";

/**
 * Parse `EVOPI_APPROVAL`: a comma-separated list of a preset name (`dev`,
 * `strict`, `yolo`) and/or `read|write|exec|hazard=auto|warn|ask|deny` pairs,
 * e.g. `strict`, `write=ask,exec=ask`, `strict,hazard=warn`. Case-insensitive.
 * Unset / blank → undefined.
 */
export function parseApprovalEnv(raw: string | undefined): ParsedApprovalEnv | undefined {
	if (typeof raw !== "string" || raw.trim() === "") return undefined;
	const parsed: ParsedApprovalEnv = { overrides: {}, invalid: [] };
	for (const token of raw.split(",")) {
		const trimmed = token.trim();
		if (trimmed === "") continue;
		const value = trimmed.toLowerCase();
		if (isApprovalPreset(value)) {
			parsed.preset = value;
			continue;
		}
		const eq = value.indexOf("=");
		const axis = eq === -1 ? undefined : value.slice(0, eq).trim();
		const policy = eq === -1 ? undefined : value.slice(eq + 1).trim();
		if (isApprovalAxis(axis) && isApprovalPolicy(policy)) {
			parsed.overrides[axis] = policy;
			continue;
		}
		parsed.invalid.push(trimmed);
	}
	return parsed;
}

export interface ApprovalResolution {
	config: ApprovalConfig;
	/** Preset the effective config equals, or `custom`. */
	preset: ApprovalPreset | "custom";
	/** Legacy mode the config maps back to (telemetry `mode`, boot notice). */
	mode: PermissionGateMode;
	/** Human-readable problems with the inputs (ignored `EVOPI_APPROVAL` tokens). */
	warnings: string[];
}

function describeResolution(config: ApprovalConfig, warnings: string[] = []): ApprovalResolution {
	return { config, preset: presetNameOf(config), mode: legacyModeOf(config), warnings };
}

/**
 * Resolve the effective approval config. Highest precedence first:
 * `EVOPI_APPROVAL` (preset replaces, then `axis=policy` pairs overlay) >
 * `EVOPI_PERMISSION_GATE` (`off` → yolo; `block`/`warn` → hazard overlay) >
 * `approval.read/write/exec/hazard` > `approval.preset` > `permissionGate.mode`
 * (same legacy mapping) > `dev`. With nothing set the result is the `dev`
 * preset, i.e. today's `block` behavior.
 */
export function resolveApprovalConfig(input?: {
	env?: Readonly<Record<string, string | undefined>>;
	settings?: PermissionGateSettingsView;
}): ApprovalResolution {
	const env = input?.env ?? process.env;
	const settings = input?.settings;
	let config: ApprovalConfig = { ...APPROVAL_PRESETS.dev };

	const legacySetting = parseMode(settings?.mode);
	if (legacySetting) config = applyLegacyMode(config, legacySetting);

	const approval = settings?.approval;
	if (isApprovalPreset(approval?.preset)) config = { ...APPROVAL_PRESETS[approval.preset] };
	for (const axis of APPROVAL_AXES) {
		const policy = approval?.[axis];
		if (isApprovalPolicy(policy)) config[axis] = policy;
	}

	const legacyEnv = parseMode(env[LEGACY_GATE_ENV]);
	if (legacyEnv) config = applyLegacyMode(config, legacyEnv);

	const warnings: string[] = [];
	const parsedEnv = parseApprovalEnv(env[APPROVAL_ENV]);
	if (parsedEnv) {
		if (parsedEnv.preset) config = { ...APPROVAL_PRESETS[parsedEnv.preset] };
		Object.assign(config, parsedEnv.overrides);
		for (const token of parsedEnv.invalid) {
			warnings.push(
				`${APPROVAL_ENV}: ignoring ${JSON.stringify(token)} (expected dev|strict|yolo or read|write|exec|hazard=auto|warn|ask|deny)`,
			);
		}
	}
	return describeResolution(config, warnings);
}

// --- classification ----------------------------------------------------------

export type PermissionGateHazardKind = "dangerous-command" | "protected-path-write";

export interface PermissionGateHazard {
	/** Human-readable kind shown in prompts/notices. */
	kind: string;
	hazardKind: PermissionGateHazardKind;
	/** The command or cell text that triggered the hazard. */
	text: string;
}

export interface ToolCallClassification {
	tier: ApprovalTier;
	/** Set when the call also trips the hazard axis (destructive command / protected-path write). */
	hazard?: PermissionGateHazard;
	/** Text the allow whitelist, the confirmation prompt and the log hash use. */
	text: string;
}

/** Default tier for tools the gate knows nothing about (extension/MCP tools); omp parity. */
const DEFAULT_TOOL_TIER: ApprovalTier = "exec";

/** An IPython shell escape that runs the kernel `edit` skill: `!edit --path …`. */
const EDIT_SHELL_LINE_RE = /^\s*!\s*edit(?:\s|$)/;

/**
 * Whether a `!edit …` line is a plain skill invocation. Single-quoted arguments
 * are literal; `$(…)`, `${…}` and backticks expand even inside double quotes;
 * unquoted `; & | < > ( )` would run more than the skill. Anything else stays exec.
 */
function isPlainEditShellLine(line: string): boolean {
	if (!EDIT_SHELL_LINE_RE.test(line)) return false;
	const withoutLiterals = line.replace(/'[^'\n]*'/g, "");
	if (/\$\(|\$\{|`/.test(withoutLiterals)) return false;
	return !/[;&|<>()]/.test(withoutLiterals.replace(/"[^"\n]*"/g, ""));
}

/** Tier of an ipython cell: exec when it reaches a shell, write when it mutates a path (incl. the edit skill), else read. */
function classifyIpythonCell(code: string): ApprovalTier {
	const lines = code.split("\n");
	const remainder = lines.some(isPlainEditShellLine)
		? lines.filter((line) => !isPlainEditShellLine(line)).join("\n")
		: code;
	if (IPYTHON_SHELL_MARKERS.some((marker) => marker.test(remainder))) return "exec";
	if (PYTHON_MUTATION_MARKERS.some((marker) => marker.test(code))) return "write";
	return "read";
}

/** `[path#TAG]` section headers of a hashline patch. */
const HASHLINE_HEADER_RE = /^\s*\[([^#\r\n]+)#[0-9a-fA-F]+\]\s*$/gm;

function hashlinePatchPaths(patch: unknown): string[] {
	if (typeof patch !== "string") return [];
	const paths: string[] = [];
	for (const match of patch.matchAll(HASHLINE_HEADER_RE)) paths.push(match[1].trim());
	return paths;
}

function detectHazard(event: ToolCallEvent, cwd: string | undefined): PermissionGateHazard | undefined {
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

function protectedPathHazard(paths: readonly string[], text: string): PermissionGateHazard | undefined {
	for (const path of paths) {
		const protectedPath = matchProtectedPath(path);
		if (protectedPath !== undefined) {
			return { kind: `Write to protected path ${protectedPath}`, hazardKind: "protected-path-write", text };
		}
	}
	return undefined;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "[unserializable input]";
	}
}

/**
 * Classify a tool_call into an approval tier plus the hazard it trips, if any.
 * - `bash` → exec; `ipython` → exec when the cell reaches a shell, write when it
 *   mutates a path (`open(p, "w")`, `Path.write_text`, `shutil`, `os.remove`, the
 *   kernel `edit` skill as `await edit(...)` or a plain `!edit --path …` line),
 *   else read. Hazards are today's dangerous-command / protected-path detection.
 * - `edit` / `hashline_edit` → write; a protected target path is the hazard.
 * - Anything else → `toolTiers[toolName]` when configured, else exec.
 */
export function classifyToolCall(
	event: ToolCallEvent,
	options?: { cwd?: string; toolTiers?: Readonly<Record<string, ApprovalTier>> },
): ToolCallClassification {
	if (isToolCallEventType("bash", event)) {
		const command = typeof event.input.command === "string" ? event.input.command : "";
		return { tier: "exec", hazard: detectHazard(event, options?.cwd), text: command };
	}
	if (isToolCallEventType("ipython", event)) {
		const code = event.input.code;
		if (typeof code !== "string") return { tier: "read", text: "" };
		return { tier: classifyIpythonCell(code), hazard: detectHazard(event, options?.cwd), text: code };
	}
	if (isToolCallEventType("edit", event)) {
		const path = typeof event.input.path === "string" ? event.input.path : "";
		const text = `edit ${path}`.trimEnd();
		return { tier: "write", hazard: protectedPathHazard([path], text), text };
	}
	if (event.toolName === "hashline_edit") {
		const paths = hashlinePatchPaths(event.input.patch);
		const text = `hashline_edit ${paths.join(" ")}`.trimEnd();
		return { tier: "write", hazard: protectedPathHazard(paths, text), text };
	}
	const configured = options?.toolTiers?.[event.toolName];
	return {
		tier: isApprovalTier(configured) ? configured : DEFAULT_TOOL_TIER,
		text: `${event.toolName} ${safeStringify(event.input)}`.trimEnd(),
	};
}

// --- telemetry (A5) ---------------------------------------------------------

export type PermissionGateDecision =
	| "allowed-by-whitelist"
	| "warned"
	| "blocked"
	| "confirmed-by-user"
	| "denied-by-user"
	| "denied-by-policy";

/** Session-log entry (`permission_gate`). Carries a truncated command hash, never the command. */
export interface PermissionGateLogEntry {
	decision: PermissionGateDecision;
	/** Approval tier the call was classified into (NS-D5). */
	tier: ApprovalTier;
	/** Effective policy that produced the decision (the stricter of tier and hazard policy). */
	policy: ApprovalPolicy;
	/** Present when the call tripped the hazard axis. */
	hazardKind?: PermissionGateHazardKind;
	tool: string;
	/** First 16 hex chars of sha256(command text). */
	commandSha256: string;
	/** Legacy mode the effective config maps to (see {@link legacyModeOf}). */
	mode: PermissionGateMode;
}

export const PERMISSION_GATE_ENTRY_TYPE = "permission_gate";

export function hashCommandForLog(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Prompt bodies are capped so a huge cell does not flood the TUI (omp parity: 2000 chars). */
const PROMPT_TEXT_LIMIT = 2000;

function truncateForPrompt(text: string, limit = PROMPT_TEXT_LIMIT): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n… (${text.length - limit} more chars)`;
}

/**
 * Build the built-in permission-gate factory.
 *
 * `probe` is injectable for tests; it defaults to the real {@link probeSandbox}.
 * `mode` (legacy test hook) pins a block/warn/off mode, mapped through
 * {@link applyLegacyMode}; it beats `config`, env and settings.
 * `config` pins a resolved {@link ApprovalConfig}; it beats env and settings.
 * `settings` reads the `permissionGate` block (mode + allow list) and the
 * `approval` block at session_start; omit it for env-only wiring.
 */
export function createPermissionGateExtension(options?: {
	probe?: () => SandboxProbeResult;
	mode?: () => PermissionGateMode;
	config?: () => ApprovalConfig;
	settings?: () => PermissionGateSettingsView | undefined;
}): ExtensionFactory {
	const probe = options?.probe ?? (() => probeSandbox());
	const readSettings = options?.settings ?? (() => undefined);
	const pinnedMode = options?.mode;
	const pinnedConfig = options?.config;
	const resolve = (settings: PermissionGateSettingsView | undefined): ApprovalResolution => {
		if (pinnedMode) return describeResolution(applyLegacyMode(APPROVAL_PRESETS.dev, pinnedMode()));
		if (pinnedConfig) return describeResolution({ ...pinnedConfig() });
		return resolveApprovalConfig({ settings });
	};
	return (pi: ExtensionAPI) => permissionGateImpl(pi, probe, resolve, readSettings);
}

/** Always-on gate with default wiring, for tests and embedders. */
export const permissionGateExtension: ExtensionFactory = createPermissionGateExtension();

interface GateState extends ApprovalResolution {
	allow: RegExp[];
	toolTiers: Record<string, ApprovalTier>;
}

function permissionGateImpl(
	pi: ExtensionAPI,
	probe: () => SandboxProbeResult,
	resolve: (settings: PermissionGateSettingsView | undefined) => ApprovalResolution,
	readSettings: () => PermissionGateSettingsView | undefined,
): void {
	let state: GateState | undefined;
	const reportedInvalid = new Set<string>();

	const notifyOnce = (ctx: ExtensionContext, message: string): void => {
		if (reportedInvalid.has(message)) return;
		reportedInvalid.add(message);
		ctx.ui.notify(message, "warning");
	};

	const compileAllow = (ctx: ExtensionContext, sources: readonly string[]): RegExp[] => {
		const compiled: RegExp[] = [];
		for (const source of sources) {
			if (typeof source !== "string") continue;
			try {
				compiled.push(new RegExp(source));
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				notifyOnce(ctx, `permissionGate.allow: ignoring invalid regex ${JSON.stringify(source)} (${detail})`);
			}
		}
		return compiled;
	};

	const readToolTiers = (settings: PermissionGateSettingsView | undefined): Record<string, ApprovalTier> => {
		const out: Record<string, ApprovalTier> = {};
		for (const [name, tier] of Object.entries(settings?.approval?.toolTiers ?? {})) {
			if (isApprovalTier(tier)) out[name] = tier;
		}
		return out;
	};

	const loadState = (ctx: ExtensionContext): GateState => {
		const settings = readSettings();
		const resolution = resolve(settings);
		for (const warning of resolution.warnings) notifyOnce(ctx, warning);
		state = { ...resolution, allow: compileAllow(ctx, settings?.allow ?? []), toolTiers: readToolTiers(settings) };
		return state;
	};

	const record = (entry: PermissionGateLogEntry): void => {
		try {
			pi.appendEntry(PERMISSION_GATE_ENTRY_TYPE, entry);
		} catch {
			// Telemetry must never break the gate.
		}
	};

	pi.on("session_start", (_event, ctx) => {
		const current = loadState(ctx);
		if (isGateDisabled(current.config)) return;
		const result = probe();
		if (result.available) {
			ctx.ui.notify(`OS sandbox available (${result.kind}${result.version ? ` ${result.version}` : ""})`, "info");
		} else {
			// The "불가" detection log the R3 gate requires.
			ctx.ui.notify(
				`OS sandbox unavailable: ${result.detail}. Intent-layer permission gate active (mode=${current.mode}).`,
				"warning",
			);
		}
		if (!isLegacyExpressible(current.config)) {
			ctx.ui.notify(`Approval preset ${current.preset}: ${describeApprovalConfig(current.config)}`, "info");
		}
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		const current = state ?? loadState(ctx);
		if (isGateDisabled(current.config)) return undefined;

		const call = classifyToolCall(event, { cwd: ctx.cwd, toolTiers: current.toolTiers });
		const { tier, hazard, text } = call;
		const tierPolicy = current.config[tier];
		const hazardPolicy = hazard ? current.config.hazard : undefined;
		// The stricter axis wins; ties go to the hazard axis so the reason names it.
		const axis: ApprovalAxis =
			hazardPolicy !== undefined && POLICY_RANK[hazardPolicy] >= POLICY_RANK[tierPolicy] ? "hazard" : tier;
		const policy = axis === "hazard" && hazardPolicy !== undefined ? hazardPolicy : tierPolicy;
		if (policy === "auto") return undefined;

		const label = hazard ? hazard.kind : `${tier}-tier ${event.toolName} call`;
		const entry = (decision: PermissionGateDecision): PermissionGateLogEntry => ({
			decision,
			tier,
			policy,
			...(hazard ? { hazardKind: hazard.hazardKind } : {}),
			tool: event.toolName,
			commandSha256: hashCommandForLog(text),
			mode: current.mode,
		});

		if (current.allow.some((pattern) => pattern.test(text))) {
			record(entry("allowed-by-whitelist"));
			return undefined;
		}

		if (policy === "warn") {
			ctx.ui.notify(
				hazard
					? `⚠️ ${hazard.kind} allowed (warn mode): ${hazard.text}`
					: `⚠️ ${label} allowed (warn): ${truncateForPrompt(text)}`,
				"warning",
			);
			record(entry("warned"));
			return undefined;
		}

		if (policy === "deny") {
			record(entry("denied-by-policy"));
			return { block: true, reason: `${label} denied by policy (approval.${axis}=deny)` };
		}

		// policy === "ask"
		if (!ctx.hasUI) {
			record(entry("blocked"));
			return {
				block: true,
				reason: hazard
					? `${hazard.kind} blocked (no UI for confirmation): ${hazard.text}`
					: `${label} requires approval but no UI is available (approval.${tier}=ask). Options: set approval.${tier}: auto or approval.preset: dev in ~/.evopi/agent/settings.json, set EVOPI_APPROVAL=dev, or add a permissionGate.allow regex.`,
			};
		}
		const prompt = hazard
			? `⚠️ ${hazard.kind}:\n\n  ${hazard.text}\n\nAllow?`
			: `⚠️ ${tier} tier (${current.preset}): ${event.toolName}\n\n  ${truncateForPrompt(text)}\n\nAllow?`;
		const choice = await ctx.ui.select(prompt, ["No", "Yes"]);
		if (choice !== "Yes") {
			record(entry("denied-by-user"));
			return { block: true, reason: "Blocked by user" };
		}
		record(entry("confirmed-by-user"));
		return undefined;
	});
}
