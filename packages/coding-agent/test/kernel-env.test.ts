import { describe, expect, it } from "vitest";
import {
	buildKernelEnv,
	describeWithheldKernelEnv,
	isAgentSecretEnvName,
	isKernelAllowlistedEnvName,
	KERNEL_ENV_POLICY_ENV,
	KERNEL_ENV_WITHHELD_LIST_CAP,
	KERNEL_INHERIT_SECRETS_ENV,
	kernelEnvPolicyFromEnv,
	kernelInheritsSecretsFromEnv,
	resolveKernelEnvPolicy,
} from "../src/core/kernel/kernel-env.js";

const HOST: NodeJS.ProcessEnv = {
	PATH: "/usr/bin",
	HOME: "/home/u",
	ANTHROPIC_API_KEY: "sk-ant-secret",
	OPENAI_API_KEY: "sk-openai",
	EVOPI_API_KEY_POOL_ANTHROPIC: "a,b,c",
	AWS_BEARER_TOKEN_BEDROCK: "bedrock",
	// project-facing credentials the user's own tooling reads — must survive
	GH_TOKEN: "ghp_x",
	AWS_ACCESS_KEY_ID: "AKIA",
	AWS_SECRET_ACCESS_KEY: "aws-secret",
	GOOGLE_APPLICATION_CREDENTIALS: "/adc.json",
	SERPER_API_KEY: "serper",
	EVOPI_CODING_AGENT_DIR: "/tmp/agent",
};

describe("kernel env", () => {
	it("withholds agent provider credentials by default and keeps everything else", () => {
		const { env, withheld } = buildKernelEnv(HOST, { inheritSecrets: false });
		expect(withheld).toEqual([
			"ANTHROPIC_API_KEY",
			"AWS_BEARER_TOKEN_BEDROCK",
			"EVOPI_API_KEY_POOL_ANTHROPIC",
			"OPENAI_API_KEY",
		]);
		for (const name of withheld) expect(env[name]).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
		expect(env.GH_TOKEN).toBe("ghp_x");
		expect(env.AWS_ACCESS_KEY_ID).toBe("AKIA");
		expect(env.AWS_SECRET_ACCESS_KEY).toBe("aws-secret");
		expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/adc.json");
		expect(env.SERPER_API_KEY).toBe("serper");
		expect(env.EVOPI_CODING_AGENT_DIR).toBe("/tmp/agent");
	});

	it("applies explicit overrides verbatim after filtering", () => {
		const { env } = buildKernelEnv(HOST, {
			inheritSecrets: false,
			overrides: { EVOPI_KERNEL_OWNER_PID: "42", EVOPI_BASH_SHELL: "/bin/zsh" },
		});
		expect(env.EVOPI_KERNEL_OWNER_PID).toBe("42");
		expect(env.EVOPI_BASH_SHELL).toBe("/bin/zsh");
	});

	it("passes secrets through when inheritance is requested", () => {
		const { env, withheld } = buildKernelEnv(HOST, { inheritSecrets: true });
		expect(withheld).toEqual([]);
		expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
		expect(env.EVOPI_API_KEY_POOL_ANTHROPIC).toBe("a,b,c");
	});

	it("reads the opt-out from the host env when not specified", () => {
		expect(kernelInheritsSecretsFromEnv({})).toBe(false);
		expect(kernelInheritsSecretsFromEnv({ [KERNEL_INHERIT_SECRETS_ENV]: "1" })).toBe(true);
		expect(kernelInheritsSecretsFromEnv({ [KERNEL_INHERIT_SECRETS_ENV]: "true" })).toBe(true);
		expect(kernelInheritsSecretsFromEnv({ [KERNEL_INHERIT_SECRETS_ENV]: "0" })).toBe(false);
		const { withheld } = buildKernelEnv({ ...HOST, [KERNEL_INHERIT_SECRETS_ENV]: "1" });
		expect(withheld).toEqual([]);
	});

	it("skips undefined values and never leaks pool env by prefix", () => {
		expect(isAgentSecretEnvName("EVOPI_API_KEY_POOL_OPENAI")).toBe(true);
		expect(isAgentSecretEnvName("EVOPI_API_KEY_POOL")).toBe(false);
		expect(isAgentSecretEnvName("SERPER_API_KEY")).toBe(false);
		const { env } = buildKernelEnv({ A: undefined, B: "b" }, { inheritSecrets: false });
		expect("A" in env).toBe(false);
		expect(env.B).toBe("b");
	});
});

describe("kernel env allowlist policy (A2)", () => {
	const ALLOW_HOST: NodeJS.ProcessEnv = {
		...HOST,
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		TERM: "xterm-256color",
		TMPDIR: "/tmp",
		XDG_CACHE_HOME: "/home/u/.cache",
		VIRTUAL_ENV: "/venv",
		PYTHONPATH: "/lib",
		UV_CACHE_DIR: "/uv",
		https_proxy: "http://proxy:3128",
		EVOPI_FOO: "foo",
		MY_TOOL_TOKEN: "tool-secret",
		MYCO_REGION: "kr",
		MYCO_BUCKET: "b",
	};

	it("keeps the safe set and EVOPI_*, drops unknown names like MY_TOOL_TOKEN", () => {
		const { env, withheld, policy } = buildKernelEnv(ALLOW_HOST, { inheritSecrets: false, policy: "allowlist" });
		expect(policy).toBe("allowlist");
		for (const name of [
			"PATH",
			"HOME",
			"LANG",
			"LC_ALL",
			"TERM",
			"TMPDIR",
			"XDG_CACHE_HOME",
			"VIRTUAL_ENV",
			"PYTHONPATH",
			"UV_CACHE_DIR",
			"https_proxy",
			"EVOPI_FOO",
			"EVOPI_CODING_AGENT_DIR",
		]) {
			expect(env[name], name).toBe(ALLOW_HOST[name]);
		}
		for (const name of ["MY_TOOL_TOKEN", "GH_TOKEN", "AWS_ACCESS_KEY_ID", "SERPER_API_KEY", "MYCO_REGION"]) {
			expect(env[name], name).toBeUndefined();
			expect(withheld).toContain(name);
		}
		// Agent credentials are withheld here too, EVOPI_API_KEY_POOL_* included despite the EVOPI_ prefix.
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.EVOPI_API_KEY_POOL_ANTHROPIC).toBeUndefined();
		expect(withheld).toContain("EVOPI_API_KEY_POOL_ANTHROPIC");
		expect(withheld).toEqual([...withheld].sort());
	});

	it("envAllow passes exact names and PREFIX* entries", () => {
		const { env, withheld } = buildKernelEnv(ALLOW_HOST, {
			inheritSecrets: false,
			policy: "allowlist",
			allow: ["SERPER_API_KEY", "MYCO_*", "", "*"],
		});
		expect(env.SERPER_API_KEY).toBe("serper");
		expect(env.MYCO_REGION).toBe("kr");
		expect(env.MYCO_BUCKET).toBe("b");
		expect(env.MY_TOOL_TOKEN).toBeUndefined(); // a bare "*" entry is not a wildcard
		expect(withheld).not.toContain("SERPER_API_KEY");
		expect(isKernelAllowlistedEnvName("MYCO_X", ["MYCO_*"])).toBe(true);
		expect(isKernelAllowlistedEnvName("OTHER", ["MYCO_*"])).toBe(false);
	});

	it("inheritSecrets passes agent credentials through even under allowlist", () => {
		const { env } = buildKernelEnv(ALLOW_HOST, { inheritSecrets: true, policy: "allowlist" });
		expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
		expect(env.EVOPI_API_KEY_POOL_ANTHROPIC).toBe("a,b,c");
		expect(env.MY_TOOL_TOKEN).toBeUndefined();
	});

	it("denylist (default) is unchanged: only agent credentials are withheld", () => {
		const explicit = buildKernelEnv(ALLOW_HOST, { inheritSecrets: false, policy: "denylist" });
		const implicit = buildKernelEnv(ALLOW_HOST, { inheritSecrets: false });
		expect(implicit.policy).toBe("denylist");
		expect(implicit.env).toEqual(explicit.env);
		expect(implicit.withheld).toEqual([
			"ANTHROPIC_API_KEY",
			"AWS_BEARER_TOKEN_BEDROCK",
			"EVOPI_API_KEY_POOL_ANTHROPIC",
			"OPENAI_API_KEY",
		]);
		expect(implicit.env.MY_TOOL_TOKEN).toBe("tool-secret");
		expect(implicit.env.GH_TOKEN).toBe("ghp_x");
		// `allow` is irrelevant under denylist.
		expect(buildKernelEnv(ALLOW_HOST, { inheritSecrets: false, allow: ["MYCO_*"] }).env).toEqual(explicit.env);
	});

	it("EVOPI_KERNEL_ENV_POLICY overrides the configured policy in both directions", () => {
		const forcedAllow = buildKernelEnv(
			{ ...ALLOW_HOST, [KERNEL_ENV_POLICY_ENV]: "allowlist" },
			{ inheritSecrets: false, policy: "denylist" },
		);
		expect(forcedAllow.policy).toBe("allowlist");
		expect(forcedAllow.env.MY_TOOL_TOKEN).toBeUndefined();
		const forcedDeny = buildKernelEnv(
			{ ...ALLOW_HOST, [KERNEL_ENV_POLICY_ENV]: "DENYLIST" },
			{ inheritSecrets: false, policy: "allowlist" },
		);
		expect(forcedDeny.policy).toBe("denylist");
		expect(forcedDeny.env.MY_TOOL_TOKEN).toBe("tool-secret");
		// Invalid values fall back to the configured policy, then denylist.
		expect(kernelEnvPolicyFromEnv({ [KERNEL_ENV_POLICY_ENV]: "strict" })).toBeUndefined();
		expect(resolveKernelEnvPolicy({ [KERNEL_ENV_POLICY_ENV]: "strict" }, "allowlist")).toBe("allowlist");
		expect(resolveKernelEnvPolicy({}, undefined)).toBe("denylist");
	});

	it("diagnostic line lists withheld names, capped with +N more under allowlist", () => {
		expect(describeWithheldKernelEnv({ env: {}, withheld: [], policy: "denylist" })).toBeUndefined();
		const deny = describeWithheldKernelEnv({ env: {}, withheld: ["ANTHROPIC_API_KEY"], policy: "denylist" });
		expect(deny).toBe(
			"withheld 1 provider credential env var(s) from the kernel (ANTHROPIC_API_KEY); set EVOPI_KERNEL_INHERIT_SECRETS=1 to pass them through",
		);
		const many = Array.from(
			{ length: KERNEL_ENV_WITHHELD_LIST_CAP + 3 },
			(_, i) => `VAR_${String(i).padStart(2, "0")}`,
		);
		const allow = describeWithheldKernelEnv({ env: {}, withheld: many, policy: "allowlist" });
		expect(allow).toContain(`withheld ${many.length} env var(s)`);
		expect(allow).toContain("VAR_11");
		expect(allow).not.toContain("VAR_12");
		expect(allow).toContain("+3 more");
		expect(allow).toContain("kernel.envAllow");
		const few = describeWithheldKernelEnv({ env: {}, withheld: ["A", "B"], policy: "allowlist" });
		expect(few).toContain("(A, B)");
		expect(few).not.toContain("more");
	});
});
