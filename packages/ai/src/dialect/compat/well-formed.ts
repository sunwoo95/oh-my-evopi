/**
 * `String.prototype.toWellFormed` is ES2024; this workspace's tsconfig targets
 * `lib: ["ES2022"]`, so the method is unavailable to the type checker (and to
 * older runtimes). This helper feature-detects the native method and otherwise
 * falls back to replacing lone surrogates with U+FFFD — the same replacement
 * `toWellFormed` performs. (Mirrors the isWellFormed shim used in @evopi/mnemopi.)
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function toWellFormed(text: string): string {
	const native = (text as { toWellFormed?: () => string }).toWellFormed;
	if (typeof native === "function") return native.call(text);
	return text.replace(LONE_SURROGATE, "�");
}
