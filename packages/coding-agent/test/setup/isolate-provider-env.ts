import { isAgentSecretEnvName } from "../../src/core/kernel/kernel-env.js";

// Tests decide which providers are configured through fixtures, not through
// whatever credentials the developer's shell or CI sandbox happens to export.
for (const name of Object.keys(process.env)) {
	if (isAgentSecretEnvName(name)) delete process.env[name];
}
