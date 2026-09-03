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

/** Whether `name` is an agent-side provider credential the kernel must not inherit. */
export function isAgentSecretEnvName(name: string): boolean {
	if (AGENT_SECRET_ENV_NAMES.includes(name)) return true;
	return AGENT_SECRET_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function kernelInheritsSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = (env[KERNEL_INHERIT_SECRETS_ENV] ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

export interface BuildKernelEnvOptions {
	/** Explicit per-kernel overrides; always applied verbatim, after filtering. */
	overrides?: Record<string, string>;
	/** Pass provider credentials through. Defaults to `EVOPI_KERNEL_INHERIT_SECRETS`. */
	inheritSecrets?: boolean;
}

/** Names withheld from the last {@link buildKernelEnv} call, for diagnostics. */
export interface KernelEnvBuildResult {
	env: NodeJS.ProcessEnv;
	withheld: string[];
}

export function buildKernelEnv(hostEnv: NodeJS.ProcessEnv, options: BuildKernelEnvOptions = {}): KernelEnvBuildResult {
	const inherit = options.inheritSecrets ?? kernelInheritsSecretsFromEnv(hostEnv);
	const env: NodeJS.ProcessEnv = {};
	const withheld: string[] = [];
	for (const [name, value] of Object.entries(hostEnv)) {
		if (value === undefined) continue;
		if (!inherit && isAgentSecretEnvName(name)) {
			withheld.push(name);
			continue;
		}
		env[name] = value;
	}
	Object.assign(env, options.overrides);
	withheld.sort();
	return { env, withheld };
}
