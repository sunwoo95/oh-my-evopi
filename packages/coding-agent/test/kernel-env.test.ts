import { describe, expect, it } from "vitest";
import {
	buildKernelEnv,
	isAgentSecretEnvName,
	KERNEL_INHERIT_SECRETS_ENV,
	kernelInheritsSecretsFromEnv,
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
