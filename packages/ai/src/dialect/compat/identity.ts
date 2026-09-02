/**
 * Compat reproduction of `@oh-my-pi/pi-catalog/identity`'s dialect surface.
 *
 * Upstream `preferredDialect` delegates to the catalog's `classifyModel`
 * taxonomy (a large model-registry-driven classifier). The dialect subsystem
 * only needs the model-family → dialect mapping, so this reproduces it as a
 * substring heuristic over the model id. `demotion.ts` is the only dialect file
 * that calls it, and only to pick a thinking-render form; the fallback ("xml")
 * is always safe.
 */

export type Dialect =
	| "glm"
	| "hermes"
	| "kimi"
	| "xml"
	| "anthropic"
	| "deepseek"
	| "harmony"
	| "qwen3"
	| "gemini"
	| "gemma"
	| "minimax";

export const FALLBACK_DIALECT: Dialect = "xml";

/**
 * Map a model id to its owned-mode dialect. Order matters: more specific
 * families (gemma before gemini, gpt-oss before gpt) are tested first, mirroring
 * the upstream taxonomy's class → dialect switch.
 */
export function preferredDialect(modelId: string): Dialect {
	const id = modelId.toLowerCase();
	const has = (...needles: string[]): boolean => needles.some(n => id.includes(n));

	if (has("claude", "anthropic")) return "anthropic";
	if (has("glm", "zhipu", "chatglm")) return "glm";
	if (has("gemma")) return "gemma";
	if (has("gemini")) return "gemini";
	if (has("kimi", "moonshot")) return "kimi";
	if (has("qwen")) return "qwen3";
	if (has("deepseek")) return "deepseek";
	if (has("minimax")) return "minimax";
	if (has("gpt-oss", "gpt_oss", "gptoss")) return "harmony";
	if (has("gpt", "openai", "o1", "o3", "o4", "codex")) return "harmony";
	return FALLBACK_DIALECT;
}
