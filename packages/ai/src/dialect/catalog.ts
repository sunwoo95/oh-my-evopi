import { toolWireSchema } from "./compat/schema.js";
import { getDialectDefinition } from "./factory.js";
import promptTemplate from "./prompt-template.prompt.js";
import type { Dialect, InbandTool } from "./types.js";

const TOOLS_TOKEN = "{{TOOLS}}";
const DIALECT_PROMPT_TOKEN = "{{DIALECT}}";

export function renderToolCatalog(tools: readonly InbandTool[]): string {
	return tools
		.map(tool =>
			JSON.stringify({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description ?? "",
					parameters: toolWireSchema(tool),
				},
			}),
		)
		.join("\n");
}

export function renderInbandToolPrompt(tools: readonly InbandTool[], dialect: Dialect): string {
	const prompt = getDialectDefinition(dialect).prompt.trim();
	return promptTemplate
		.replace(TOOLS_TOKEN, () => renderToolCatalog(tools))
		.replace(DIALECT_PROMPT_TOKEN, () => prompt);
}
