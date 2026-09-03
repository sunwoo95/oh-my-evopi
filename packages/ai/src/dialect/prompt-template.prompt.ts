// Generated from oh-my-pi dialect prompt "prompt-template.md" (M8 backport).
// omp imported this via `with { type: "text" }` (a Bun loader feature); evopi
// builds with tsgo, so the prompt text is inlined as a TS module instead.
const prompt =
	"# Tools\n\nYou may call one or more functions to assist with the user query.\nTool calls are emitted as text using the exact syntax below, not as native provider tool messages.\n\nAvailable functions are listed inside `<tools></tools>` as one JSON object per line:\n\n<tools>\n{{TOOLS}}\n</tools>\n\n{{DIALECT}}\n";
export default prompt;
