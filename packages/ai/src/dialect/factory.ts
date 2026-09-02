import anthropicDefinition from "./anthropic.js";
import deepseekDefinition from "./deepseek.js";
import geminiDefinition from "./gemini.js";
import gemmaDefinition from "./gemma.js";
import glmDefinition from "./glm.js";
import harmonyDefinition from "./harmony.js";
import hermesDefinition from "./hermes.js";
import kimiDefinition from "./kimi.js";
import minimaxDefinition from "./minimax.js";
import qwen3Definition from "./qwen3.js";
import type { Dialect, DialectDefinition, InbandScanner, InbandScannerOptions } from "./types.js";
import xmlDefinition from "./xml.js";

const DIALECT_DEFINITIONS: Record<Dialect, DialectDefinition> = {
	glm: glmDefinition,
	hermes: hermesDefinition,
	kimi: kimiDefinition,
	xml: xmlDefinition,
	anthropic: anthropicDefinition,
	deepseek: deepseekDefinition,
	minimax: minimaxDefinition,
	harmony: harmonyDefinition,
	qwen3: qwen3Definition,
	gemini: geminiDefinition,
	gemma: gemmaDefinition,
};

export function getDialectDefinition(dialect: Dialect): DialectDefinition {
	return DIALECT_DEFINITIONS[dialect];
}

export function createInbandScanner(dialect: Dialect, options: InbandScannerOptions = {}): InbandScanner {
	return getDialectDefinition(dialect).createScanner(options);
}
