// Environment handed to the Python kernel subprocess.
//
// The kernel runs model-authored code with the host's uid and filesystem, so
// anything in its environment is readable by that code (`os.environ`) and by
// every process `bash()` spawns from it. The host's LLM-provider credentials
// are the agent's secrets, not the project's: the kernel never needs them
// (provider calls happen in the TypeScript host, and `rlm()` subagents are
// dispatched back to the host over host_request), so they are withheld by
// default. Project-facing credentials the user's own tooling legitimately
// reads (GH_TOKEN, AWS_* profile/IAM, GOOGLE_APPLICATION_CREDENTIALS, the
// websearch skill's SERPER_API_KEY, …) are inherited unchanged.
//
// Opt out with `EVOPI_KERNEL_INHERIT_SECRETS=1` (or `inheritSecrets: true`
// on the manager) when a Python skill genuinely needs a provider key.
//
// Two policies (A2):
// - `denylist` (default) — everything above: withhold only the known agent
//   credentials. Byte-identical to the pre-A2 behaviour.
// - `allowlist` — pass only a fixed safe set (locale, terminal, temp dirs,
//   XDG_*, EVOPI_*, Python tooling, CA bundles, proxies) plus the names the
//   user lists in `kernel.envAllow`, so unknown `*_API_KEY`/`*_TOKEN` variables
//   never reach model-authored code. Agent credentials stay withheld here too
//   unless secrets are inherited.
// `EVOPI_KERNEL_ENV_POLICY=allowlist|denylist` overrides the setting.

const AGENT_SECRET_ENV_NAMES: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"PRIME_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OPENCODE_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"HF_TOKEN",
	"AZURE_OPENAI_API_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"DEEPSEEK_API_KEY",
	"FIREWORKS_API_KEY",
	"KIMI_API_KEY",
	"MOONSHOT_API_KEY",
	"CLOUDFLARE_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"DATABRICKS_TOKEN",
];

const AGENT_SECRET_ENV_PREFIXES: readonly string[] = ["EVOPI_API_KEY_POOL_"];

export const KERNEL_INHERIT_SECRETS_ENV = "EVOPI_KERNEL_INHERIT_SECRETS";
export const KERNEL_ENV_POLICY_ENV = "EVOPI_KERNEL_ENV_POLICY";

export type KernelEnvPolicy = "denylist" | "allowlist";

/** Names always passed in allowlist mode: locale, terminal, temp dirs, shell identity, CA bundles, proxies. */
const KERNEL_ALLOWLIST_NAMES: readonly string[] = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"TZ",
	"LANG",
	"LANGUAGE",
	"TERM",
	"COLORTERM",
	"TMPDIR",
	"TMP",
	"TEMP",
	"VIRTUAL_ENV",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
];

/** Prefix families always passed in allowlist mode (EVOPI_API_KEY_POOL_* is still an agent secret). */
const KERNEL_ALLOWLIST_PREFIXES: readonly string[] = ["LC_", "XDG_", "EVOPI_", "PYTHON", "UV_", "PIP_"];

/** Whether `name` is an agent-side provider credential the kernel must not inherit. */
export function isAgentSecretEnvName(name: string): boolean {
	if (AGENT_SECRET_ENV_NAMES.includes(name)) return true;
	return AGENT_SECRET_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Whether an `envAllow` entry (exact name, or `PREFIX*`) matches `name`. */
function matchesAllowEntry(entry: string, name: string): boolean {
	const trimmed = entry.trim();
	if (trimmed === "") return false;
	if (trimmed.endsWith("*")) {
		const prefix = trimmed.slice(0, -1);
		return prefix === "" ? false : name.startsWith(prefix);
	}
	return trimmed === name;
}

/** Whether `name` passes the allowlist policy: the built-in safe set or a user `extraAllow` entry. */
export function isKernelAllowlistedEnvName(name: string, extraAllow: readonly string[] = []): boolean {
	if (KERNEL_ALLOWLIST_NAMES.includes(name)) return true;
	if (KERNEL_ALLOWLIST_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
	return extraAllow.some((entry) => matchesAllowEntry(entry, name));
}

export function kernelInheritsSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env[KERNEL_INHERIT_SECRETS_ENV] ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

/** The policy named by `EVOPI_KERNEL_ENV_POLICY`, or undefined when unset/invalid. */
export function kernelEnvPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): KernelEnvPolicy | undefined {
	const raw = (env[KERNEL_ENV_POLICY_ENV] ?? "").trim().toLowerCase();
	return raw === "allowlist" || raw === "denylist" ? raw : undefined;
}

/** Env override wins, then the configured (settings) policy, then `denylist`. */
export function resolveKernelEnvPolicy(env: NodeJS.ProcessEnv, configured?: KernelEnvPolicy): KernelEnvPolicy {
	return kernelEnvPolicyFromEnv(env) ?? configured ?? "denylist";
}

export interface BuildKernelEnvOptions {
	/** Explicit per-kernel overrides; always applied verbatim, after filtering. */
	overrides?: Record<string, string>;
	/** Pass provider credentials through. Defaults to `EVOPI_KERNEL_INHERIT_SECRETS`. */
	inheritSecrets?: boolean;
	/** Configured filtering policy; `EVOPI_KERNEL_ENV_POLICY` in `hostEnv` overrides it. Default `denylist`. */
	policy?: KernelEnvPolicy;
	/** Extra names (or `PREFIX*`) passed in allowlist mode. Ignored under `denylist`. */
	allow?: readonly string[];
}

/** Names withheld from the last {@link buildKernelEnv} call, for diagnostics. */
export interface KernelEnvBuildResult {
	env: NodeJS.ProcessEnv;
	withheld: string[];
	/** Policy that was applied after the env override. */
	policy: KernelEnvPolicy;
}

export function buildKernelEnv(hostEnv: NodeJS.ProcessEnv, options: BuildKernelEnvOptions = {}): KernelEnvBuildResult {
	const inherit = options.inheritSecrets ?? kernelInheritsSecretsFromEnv(hostEnv);
	const policy = resolveKernelEnvPolicy(hostEnv, options.policy);
	const allow = options.allow ?? [];
	const env: NodeJS.ProcessEnv = {};
	const withheld: string[] = [];
	for (const [name, value] of Object.entries(hostEnv)) {
		if (value === undefined) continue;
		if (isAgentSecretEnvName(name)) {
			if (!inherit) {
				withheld.push(name);
				continue;
			}
		} else if (policy === "allowlist" && !isKernelAllowlistedEnvName(name, allow)) {
			withheld.push(name);
			continue;
		}
		env[name] = value;
	}
	Object.assign(env, options.overrides);
	withheld.sort();
	return { env, withheld, policy };
}

/** How many withheld names the kernel diagnostic line spells out before collapsing to "+N more". */
export const KERNEL_ENV_WITHHELD_LIST_CAP = 12;

/** Human-readable diagnostic for a build that withheld names; undefined when nothing was withheld. */
export function describeWithheldKernelEnv(result: KernelEnvBuildResult): string | undefined {
	const { withheld, policy } = result;
	if (withheld.length === 0) return undefined;
	if (policy === "denylist") {
		return (
			`withheld ${withheld.length} provider credential env var(s) from the kernel ` +
			`(${withheld.join(", ")}); set ${KERNEL_INHERIT_SECRETS_ENV}=1 to pass them through`
		);
	}
	const listed = withheld.slice(0, KERNEL_ENV_WITHHELD_LIST_CAP);
	const more = withheld.length - listed.length;
	const names = more > 0 ? `${listed.join(", ")}, +${more} more` : listed.join(", ");
	return (
		`kernel env allowlist withheld ${withheld.length} env var(s) (${names}); ` +
		`add names to kernel.envAllow or set ${KERNEL_ENV_POLICY_ENV}=denylist`
	);
}
