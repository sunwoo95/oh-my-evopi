import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@evopi/pi-agent-core";
import type { Model } from "@evopi/pi-ai";
import { completeSimple } from "@evopi/pi-ai";
import { getAgentDir } from "../../config.js";
import { serializeConversation } from "../compaction/utils.js";
import { convertToLlm } from "../messages.js";
import type { CustomEntry } from "../session-manager.js";
import {
	type ConsolidationPolicy,
	capacityError,
	compareLfu,
	consolidationAddendum,
	countConsolidationEntries,
	evictionReason,
	isAutoEvictKind,
	isProgressEdit,
	normalizeRefinementAction,
	selectLfuEvictions,
	stripBookkeeping,
	usageCount,
} from "./consolidation.js";
import { bpeLabel, isProgressEntry, MAX_OPEN_PROGRESS, renderPlanBlock } from "./progress-ledger.js";

export const REFINEMENT_CUSTOM_TYPE = "evopi.refinement";

export const REFINE_SKILL_NAME = "refine";
const HARNESS_STATE_DIR_NAME = "harness";
const REFINEMENT_HISTORY_FILE_NAME = "refinements.jsonl";
const DEFAULT_OVERVIEW_ENTRY_LIMIT = 6;
const DEFAULT_OVERVIEW_REFINEMENT_LIMIT = 5;
const DEFAULT_OVERVIEW_CONTENT_LIMIT = 180;

export type RefinementKind = "prompt" | "memory" | "skill" | "subagent";
/**
 * `skip` (B4) is the paper's explicit SKIP consolidation verdict: recorded on the
 * result as `skippedEdits`, never applied, never a failure. `add`/`remove` are
 * accepted as aliases of create/delete at parse time.
 */
export type RefinementAction = "create" | "update" | "delete" | "skip";
export type HarnessScope = "local" | "global";

export interface HarnessEntry {
	id: string;
	kind: RefinementKind;
	title: string;
	content: string;
	path: string;
	scope?: HarnessScope;
	reference: Record<string, unknown>;
	arguments: Record<string, unknown>;
	metadata: Record<string, unknown>;
	source: string;
	created_at: string;
	updated_at: string;
	version: number;
}

export interface HarnessRefinementEvent {
	id: string;
	trigger: string;
	changes: string[];
	evidence: string;
	outcome: string;
	created_at: string;
}

export interface HarnessState {
	schema: number;
	entries: Record<RefinementKind, Record<string, HarnessEntry>>;
	refinements: HarnessRefinementEvent[];
}

export interface RefinementEdit {
	action: RefinementAction;
	kind: RefinementKind;
	id?: string;
	title?: string;
	content?: string;
	path?: string;
	reference?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	reason?: string;
}

export interface RefinementProposal {
	summary: string;
	rationale: string;
	edits: RefinementEdit[];
	expectedOutcome: string;
}

export interface AppliedRefinementEdit extends RefinementEdit {
	id: string;
	before?: HarnessEntry;
	after?: HarnessEntry;
	applied: boolean;
	error?: string;
}

/** An explicit planner SKIP: the lesson was judged trivial, redundant, or episode-specific. */
export interface SkippedRefinementEdit {
	action: "skip";
	kind: RefinementKind;
	id?: string;
	reason?: string;
}

export interface RefinementResult {
	id: string;
	summary: string;
	rationale: string;
	expectedOutcome: string;
	appliedEdits: AppliedRefinementEdit[];
	/** Explicit `skip` edits (B4). Present only when the proposal contained at least one. */
	skippedEdits?: SkippedRefinementEdit[];
	harnessStatePath: string;
	rollbackOf?: string;
	scope?: HarnessScope;
}

export interface RefineOptions {
	instructions?: string;
	rollbackId?: string;
	global?: boolean;
	/**
	 * Per-kind capacity of the target store (B4). When set, the planner sees the
	 * consolidation addendum plus an LFU-ordered overview, and applying enforces
	 * the cap (see {@link applyRefinementProposal}). Undefined = uncapped, prompt
	 * and behavior byte-identical to prime.
	 */
	capPerKind?: number;
}

export type AutoRefineReason = "turn_interval" | "compact";

export interface AutoRefineReviewContext {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
}

export interface AutoRefineReview {
	shouldRefine: boolean;
	rationale: string;
	instructions?: string;
}

export const REFINEMENT_SYSTEM_PROMPT = `You are evopi's /refine continual harness subsystem.

Your job is to improve the editable continual harness state from the current trajectory.
This is similar in spirit to context compaction, but instead of summarizing the
conversation you emit precise Create, Update, or Delete edits to reusable state.
The continual harness is the persistent, editable set of prompt notes, memories,
skills, and subagent specs that lets evopi improve reusable behavior
outside the token history.
Use "continual harness" for that persistent artifact layer; keep "RLM" for the
runtime, Python REPL kernel, and native call interface that executes those artifacts.

Continual harness components:
- prompt: supplemental prompt notes only. The base system prompt is immutable and MUST NOT be rewritten.
- memory: durable facts, decisions, failures, preferences, and outcomes.
- skill: installed Python REPL skill. Skill create/update edits MUST include a \`reference\` object with \`{"type":"python"}\`, a Python import, and a callable or call pattern; they also MUST include an \`arguments\` object describing accepted inputs, required fields, defaults, and constraints. Use \`{}\` for \`arguments\` only when the Python callable truly needs no external inputs. Include the RLM-native call form \`await <skill_import>(...)\`.
- subagent: reusable delegation specs, including purpose, instructions, and when to invoke. Include the RLM-native call form: compose a concise task prompt and spawn with \`handle = await rlm("sub-task")\`; admission returns immediately with \`rlm_child_id\`, \`name\`, \`session_dir\`, and \`model\`, never the child's answer. Results arrive only through explicit \`agent_message\` replies or files; children reply with \`await agent_message.send(message, receiver_role="parent")\`. Use \`await rlm.list_subagents()\` to recover direct child handles and \`await agent_message.send(..., receiver_role="child", receiver_name=handle.name)\` for follow-ups. Do not invent wrappers like \`run_subagent(...)\`.

Scope and persistence policy:
- The default editable continual harness store is local to the current evopi session. Use it for session-specific progress, active task state, current-run coordination notes, temporary blockers, and project facts that should not affect other sessions.
- A caller may explicitly request global refinement. Global edits must be stable cross-session lessons, durable user preferences, reusable skills/subagents, or tool/environment facts that should affect future sessions.
- Entry ids in the harness overview may carry a display-only \`local:\` or \`global:\` prefix. Always use the bare id (no prefix) in edits.
- All edits in one refinement apply only to the requested scope's store. During a local refinement, global entries are read-only context: never propose update or delete edits for them; create a local entry instead when a session-specific override is genuinely needed.
- Project/workspace-specific lessons may be persisted globally only when the title, path, or content explicitly names the project/workspace and the lesson is likely to be reused in future sessions for that project. Prefer local edits when the lesson only belongs in the current conversation.
- Use memory for declarative facts and preferences, skill for repeatable procedures exposed as Python calls, prompt for narrow behavioral policy addendums, and subagent for reusable delegation roles.
- Create or update the smallest relevant component: repeated delegation roles should become subagent specs, repeated procedures should become skills, durable facts/preferences should become memories, and narrow behavioral policies should become prompt addendums.
- When an edit is persisted, include metadata such as \`{"scope":"local"}\` or \`{"scope":"global"}\` when that helps future review understand the intended blast radius.

Use the trajectory, current continual harness state, and prior refinement history. Prefer
small evidence-backed edits. If prior refinements caused issues, rollback or
replace the faulty editable entries. Never edit source files directly. Output
JSON only with this exact shape:

{
  "summary": "one sentence",
  "rationale": "why these edits are justified by trajectory evidence",
  "expectedOutcome": "what should improve and how to validate it",
  "edits": [
    {
      "action": "create|update|delete",
      "kind": "prompt|memory|skill|subagent",
      "id": "stable id for update/delete, optional for create",
      "title": "required for create/update except delete",
      "content": "required for create/update except delete",
      "path": "optional grouping path",
      "reference": {"type": "python", "import": "package.module", "callable": "function_name", "call_pattern": "await function_name(...)"},
      "arguments": {"name": {"type": "string", "required": true, "description": "accepted input"}},
      "metadata": {},
      "reason": "why this edit is useful"
    }
  ]
}`;

/**
 * Planner system prompt. Without a policy this is exactly
 * {@link REFINEMENT_SYSTEM_PROMPT}; with one (a per-kind cap is resolved) the
 * consolidation addendum (ADD/UPDATE/REMOVE/SKIP vocabulary, K, current counts,
 * eviction rules) is appended.
 */
export function buildRefinementSystemPrompt(policy?: ConsolidationPolicy): string {
	if (!policy) return REFINEMENT_SYSTEM_PROMPT;
	return `${REFINEMENT_SYSTEM_PROMPT}\n\n${consolidationAddendum(policy)}`;
}

const AUTO_REFINE_REVIEW_SYSTEM_PROMPT = `You are evopi's automatic /refine review gate.

Decide whether this checkpoint should run /refine. Auto /refine writes local continual harness state by default, so approve when the trajectory contains evidence useful to this session's future turns.
Reject one-off noise, unsupported hypotheses, and transient tool outputs. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified lessons likely to be reused in future sessions.

Return JSON only:
{
  "shouldRefine": true|false,
  "rationale": "short reason",
  "instructions": "optional concise instructions for /refine if shouldRefine is true"
}`;

/**
 * Output budgets are derived from the selected model instead of fixed literals.
 * /refine input scales with harness size (entry overview, refinement history, and
 * the trajectory slice), so a constant output cap silently truncates exactly the
 * large multi-edit proposals that matter most. Math.min keeps small models honest.
 */
const REFINEMENT_MAX_OUTPUT_TOKENS = 32_000;
const AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS = 4_096;

const TRUNCATED_JSON_ERROR =
	"the model stopped before completing its JSON object. This usually means the output budget was exhausted; retry with a smaller request.";

function refinementMaxOutputTokens(model: Model<any>): number {
	return Math.min(model.maxTokens, REFINEMENT_MAX_OUTPUT_TOKENS);
}

function autoRefineReviewMaxOutputTokens(model: Model<any>): number {
	return Math.min(model.maxTokens, AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS);
}

function now(): string {
	return new Date().toISOString();
}

function emptyHarnessState(): HarnessState {
	return {
		schema: 1,
		entries: {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
		},
		refinements: [],
	};
}

function slug(raw: string, fallback: string): string {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return normalized || fallback;
}

function cloneEntry(entry: HarnessEntry | undefined): HarnessEntry | undefined {
	return entry ? JSON.parse(JSON.stringify(entry)) : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function normalizeHarnessScope(value: unknown, fallback: HarnessScope): HarnessScope {
	return value === "global" || value === "local" ? value : fallback;
}

export function inferRefinementResultScope(result: RefinementResult): HarnessScope | undefined {
	if (result.scope) {
		return result.scope;
	}

	const scopes = new Set<HarnessScope>();
	for (const edit of result.appliedEdits) {
		const scope = edit.after?.scope ?? edit.before?.scope;
		if (scope) {
			scopes.add(scope);
		}
	}
	return scopes.size === 1 ? [...scopes][0] : undefined;
}

function withDefaultRefinementScope(result: RefinementResult, scope: HarnessScope): RefinementResult {
	const inferred = inferRefinementResultScope(result);
	return { ...result, scope: inferred ?? scope };
}

export function getGlobalHarnessStateDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, HARNESS_STATE_DIR_NAME);
}

export function getLocalHarnessStateDir(sessionArtifactDir: string | undefined): string | undefined {
	return sessionArtifactDir ? join(sessionArtifactDir, HARNESS_STATE_DIR_NAME) : undefined;
}

export function getHarnessStatePath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, "harness_state.json");
}

export function loadHarnessState(
	harnessStateDir: string = getGlobalHarnessStateDir(),
	scope: HarnessScope = "global",
): HarnessState {
	const statePath = getHarnessStatePath(harnessStateDir);
	if (!existsSync(statePath)) {
		return emptyHarnessState();
	}
	let parsed: Partial<HarnessState>;
	try {
		const raw = JSON.parse(readFileSync(statePath, "utf8"));
		// loadHarnessState runs on every system-prompt build and before each /refine, so
		// a corrupt or unreadable (or non-object) state file must degrade to empty rather
		// than throw and break the session. The next saveHarnessState rewrites it cleanly.
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return emptyHarnessState();
		}
		parsed = raw as Partial<HarnessState>;
	} catch {
		return emptyHarnessState();
	}
	const state = emptyHarnessState();
	state.schema = typeof parsed.schema === "number" ? parsed.schema : 1;
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const records = parsed.entries?.[kind];
		if (records && typeof records === "object") {
			for (const [id, rawEntry] of Object.entries(records)) {
				const entry = objectRecord(rawEntry);
				if (!entry) continue;
				state.entries[kind][id] = {
					...(entry as unknown as HarnessEntry),
					scope: normalizeHarnessScope(entry.scope, scope),
					reference: objectRecord(entry.reference) ?? {},
					arguments: objectRecord(entry.arguments) ?? {},
					metadata: objectRecord(entry.metadata) ?? {},
				};
			}
		}
	}
	if (Array.isArray(parsed.refinements)) {
		state.refinements = parsed.refinements;
	}
	return state;
}

export function mergeHarnessStates(globalState: HarnessState, localState?: HarnessState): HarnessState {
	const merged = emptyHarnessState();
	merged.schema = Math.max(globalState.schema, localState?.schema ?? 1);
	for (const kind of Object.keys(merged.entries) as RefinementKind[]) {
		for (const [id, entry] of Object.entries(globalState.entries[kind])) {
			const cloned = cloneEntry(entry)!;
			merged.entries[kind][id] = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "global") };
		}
		for (const [id, entry] of Object.entries(localState?.entries[kind] ?? {})) {
			const cloned = cloneEntry(entry)!;
			const scopedEntry = { ...cloned, scope: normalizeHarnessScope(cloned.scope, "local") };
			const mergedId = merged.entries[kind][id] ? `${scopedEntry.scope}:${id}` : id;
			merged.entries[kind][mergedId] = scopedEntry;
		}
	}
	merged.refinements = [...globalState.refinements, ...(localState?.refinements ?? [])];
	return merged;
}

export function saveHarnessState(harnessStateDir: string, state: HarnessState): string {
	const statePath = getHarnessStatePath(harnessStateDir);
	const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
	mkdirSync(harnessStateDir, { recursive: true });
	try {
		const mode = existsSync(statePath) ? statSync(statePath).mode & 0o777 : 0o600;
		writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode });
		renameSync(tempPath, statePath);
	} finally {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
	}
	return statePath;
}

export function getRefinementHistoryPath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, REFINEMENT_HISTORY_FILE_NAME);
}

function isRefinementResult(data: unknown): data is RefinementResult {
	return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
}

/**
 * Append a global-scope refinement to the cross-session history log so it can be
 * rolled back from any session. Local-scope refinements are recorded only in the
 * session JSONL and roll back via their recorded harnessStatePath.
 */
export function appendGlobalRefinement(harnessStateDir: string, result: RefinementResult): string {
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	mkdirSync(harnessStateDir, { recursive: true });
	appendFileSync(historyPath, `${JSON.stringify(result)}\n`, "utf8");
	return historyPath;
}

export function loadGlobalRefinementHistory(harnessStateDir: string = getGlobalHarnessStateDir()): RefinementResult[] {
	const historyPath = getRefinementHistoryPath(harnessStateDir);
	if (!existsSync(historyPath)) {
		return [];
	}
	const results: RefinementResult[] = [];
	for (const line of readFileSync(historyPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (isRefinementResult(parsed)) {
				results.push(withDefaultRefinementScope(parsed, "global"));
			}
		} catch {
			// Skip malformed lines so a single bad append cannot break rollback.
		}
	}
	return results;
}

/**
 * Merge global and session refinement history, de-duplicating by id. Session entries
 * win on conflict so a session that is mid-flight still resolves its own latest result.
 */
export function mergeRefinementHistory(
	global: readonly RefinementResult[],
	session: readonly RefinementResult[],
): RefinementResult[] {
	const byId = new Map<string, RefinementResult>();
	for (const result of global) {
		byId.set(result.id, result);
	}
	for (const result of session) {
		const existing = byId.get(result.id);
		byId.set(result.id, result.scope || !existing?.scope ? result : { ...result, scope: existing.scope });
	}
	return [...byId.values()];
}

function compactText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatHarnessStateForPrompt(
	state: HarnessState,
	options: {
		maxEntriesPerKind?: number;
		maxRefinements?: number;
		maxContentLength?: number;
		includeIpythonExamples?: boolean;
		includeShellExamples?: boolean;
		includeRefineExamples?: boolean;
		/**
		 * Optional selector replacing the default lexicographic order+truncate
		 * (B3/M17: MMR + budget selection behind the evo gate). Receives the
		 * lexicographically sorted entries of a kind; returns the ordered subset
		 * to render (length ≤ limit).
		 */
		selectEntries?: (kind: RefinementKind, entries: HarnessEntry[], limit: number) => HarnessEntry[];
		/**
		 * B1/M-phase: EvoHarness-RL BPE view behind the evo gate. When true, a
		 * `# PLAN` block built from progress-ledger entries is prepended, entry
		 * lines carry their BPE class (`[progress]`/`[experience]`/`[belief]`),
		 * progress entries are lifted out of the kind sections (they live in the
		 * PLAN), and the REPL guidance gains `rlm.harness.commit` / `recall` hints.
		 * Absent/false = byte-identical to the stock output.
		 */
		bpeView?: boolean;
		/** Optional goal objective rendered under the PLAN header (bpeView only). */
		goalObjective?: string;
	} = {},
): string {
	const maxEntriesPerKind = options.maxEntriesPerKind ?? DEFAULT_OVERVIEW_ENTRY_LIMIT;
	const maxRefinements = options.maxRefinements ?? DEFAULT_OVERVIEW_REFINEMENT_LIMIT;
	const maxContentLength = options.maxContentLength ?? DEFAULT_OVERVIEW_CONTENT_LIMIT;
	const includeIpythonExamples = options.includeIpythonExamples ?? true;
	const includeRefineExamples = options.includeRefineExamples ?? includeIpythonExamples;
	const bpeView = options.bpeView === true;
	const lines = [
		"# Continual Harness State",
		"",
		"Local continual harness entries belong to this evopi session. Global continual harness entries persist across evopi sessions.",
		"The continual harness entries below are compact summaries, not full descriptions. Use them as routing/context hints; inspect or refine the underlying continual harness entry only when detail matters.",
		"Default to local continual harness refinement for current task progress, temporary blockers, and session coordination. Use global continual harness refinement only for stable cross-session lessons, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts.",
		"Use these continual harness prompt notes, memories, skills, and subagent specs when they are relevant. The base system prompt is immutable; prompt entries below are supplemental notes only.",
		"",
		includeRefineExamples
			? "When to call `await refine.run()`: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep `await refine.run()` continual harness edits small and evidence-backed."
			: "When to refine the continual harness: after a repeated failure, a reusable tactic emerges, a repeated delegation role should become a subagent spec, a repeated procedure should become a skill, a durable fact/preference should become a memory, a narrow behavioral policy should become a prompt addendum, a user corrects behavior that should persist locally or globally, validation shows a continual harness entry is wrong, or a skill/subagent/memory/prompt note should be created, updated, deleted, or rolled back. Keep continual harness edits small and evidence-backed.",
		"",
		includeIpythonExamples
			? "Call contract: read each installed Python skill's SKILL.md and call its documented module function in the Python REPL; do not assume a `.run` entrypoint. Use `<skill_import> ...` in shell when a CLI exists. Continual harness skill entries are Python REPL skills with an explicit Python `reference` and `arguments` contract. Spawn a continual harness subagent spec by composing a concise task prompt and calling `handle = await rlm('sub-task')`; admission returns immediately with `rlm_child_id`, `name`, `session_dir`, and `model`, never the child's answer. Results arrive only through explicit `agent_message` replies or files; children reply with `await agent_message.send(message, receiver_role='parent')`. Use `await rlm.list_subagents()` to recover direct child handles and `await agent_message.send(..., receiver_role='child', receiver_name=handle.name)` for follow-ups. Do not invent wrappers such as `call_skill(...)`, `run_subagent(...)`, or named subagent registries."
			: options.includeShellExamples
				? "Call contract: use installed skills as shell commands when available (for example `<skill_import> ...`). Continual harness entries are routing/context hints only in sessions without the Python REPL; do not use Python `await`, `asyncio`, or `rlm` examples unless the prompt also documents a Python kernel."
				: "Call contract: continual harness entries are routing/context hints only in sessions without the Python REPL or shell access; do not use Python `await`, `asyncio`, `rlm`, or shell skill commands unless the prompt also documents those interfaces.",
		"",
	];

	if (bpeView) {
		// Progress partition rendered first (paper: PLAN view every turn), then the
		// BPE-specific REPL guidance. Both live only in this gated branch.
		const progressEntries = Object.values(state.entries.memory).filter(isProgressEntry);
		lines.unshift(renderPlanBlock(progressEntries, { goalObjective: options.goalObjective }), "");
		if (includeIpythonExamples) {
			lines.push(
				`Progress and recall: when you decompose work, call \`rlm.harness.commit("<subgoal>", "open|active|done|blocked")\` for each subgoal and update it as you go, keeping at most ${MAX_OPEN_PROGRESS} non-done subgoals (the PLAN above is rendered from this ledger; \`rlm.harness.plan()\` shows the live view). Before starting a task, call \`rlm.harness.recall("<query>")\` to pull relevant lessons and skills instead of relying on the excerpts below.`,
				"",
			);
		}
	}

	let totalEntries = 0;
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const entries = Object.values(state.entries[kind])
			.filter((entry) => !bpeView || !isProgressEntry(entry))
			.sort((a, b) => [a.path, a.title, a.id].join("\0").localeCompare([b.path, b.title, b.id].join("\0")));
		totalEntries += entries.length;
		const selectedEntries = options.selectEntries
			? options.selectEntries(kind, entries, maxEntriesPerKind).slice(0, maxEntriesPerKind)
			: entries.slice(0, maxEntriesPerKind);
		// Render subagent specs as a task-shaped roster the model can match against — the
		// analogue of Claude Code's agent-type menu — rather than a bare count. In
		// REPL sessions, include the native `rlm` invocation hint.
		if (kind === "subagent" && entries.length > 0 && includeIpythonExamples) {
			lines.push(
				`${kind}: ${entries.length} (invoke a spec by turning it into a concise task prompt and spawning with \`await rlm('<task>')\`; admission returns a child handle, never the answer)`,
			);
		} else {
			lines.push(`${kind}: ${entries.length}`);
		}
		for (const entry of selectedEntries) {
			const argumentsText =
				entry.kind === "skill" && Object.keys(entry.arguments).length > 0
					? ` args=${compactText(JSON.stringify(entry.arguments), maxContentLength)}`
					: "";
			const referenceText =
				entry.kind === "skill" && Object.keys(entry.reference).length > 0
					? ` ref=${compactText(JSON.stringify(entry.reference), maxContentLength)}`
					: "";
			const bpeText = bpeView ? `${bpeLabel(entry)} ` : "";
			lines.push(
				`- ${bpeText}[${entry.scope ?? "global"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${referenceText}${argumentsText}: ${compactText(
					entry.content,
					maxContentLength,
				)}`,
			);
		}
		const overflow = entries.length - selectedEntries.length;
		if (overflow > 0) {
			lines.push(`- +${overflow} more ${kind} entries`);
		}
		lines.push("");
	}

	if (totalEntries === 0) {
		lines.push("No saved harness entries yet.", "");
	}

	lines.push(`recent refinements: ${state.refinements.length}`);
	for (const event of state.refinements.slice(-maxRefinements)) {
		const changes = event.changes.length > 0 ? event.changes.join(", ") : "no applied edits";
		const outcome = event.outcome ? `; outcome: ${compactText(event.outcome, maxContentLength)}` : "";
		lines.push(`- [${event.id}] ${compactText(event.trigger, maxContentLength)}: ${changes}${outcome}`);
	}
	const refinementOverflow = state.refinements.length - Math.min(state.refinements.length, maxRefinements);
	if (refinementOverflow > 0) {
		lines.push(`- +${refinementOverflow} older refinement events`);
	}

	return lines.join("\n").trim();
}

const DEFAULT_REFINE_OVERVIEW_LIMIT = 40;

/**
 * Compact per-entry overview for the planner prompts. Stock: insertion order,
 * at most 40 entries per kind. With `consolidation` (B4, cap resolved): entries
 * are listed in LFU order (eviction candidates first) up to `max(40, cap)`, each
 * line carries ` uses=<usage_count>`, and progress-ledger entries are labelled
 * so the planner can tell which memory entries the cap ignores.
 */
export function renderHarnessOverviewForPrompt(
	state: HarnessState,
	options: { consolidation?: ConsolidationPolicy } = {},
): string {
	const consolidation = options.consolidation;
	const limit = consolidation
		? Math.max(DEFAULT_REFINE_OVERVIEW_LIMIT, consolidation.capPerKind)
		: DEFAULT_REFINE_OVERVIEW_LIMIT;
	const lines: string[] = [];
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		const entries = consolidation
			? [...Object.values(state.entries[kind])].sort(compareLfu)
			: Object.values(state.entries[kind]);
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, limit)) {
			const content = entry.content.replace(/\s+/g, " ").slice(0, 240);
			const argumentsText =
				entry.kind === "skill" && Object.keys(entry.arguments).length > 0
					? ` args=${JSON.stringify(entry.arguments).slice(0, 240)}`
					: "";
			const referenceText =
				entry.kind === "skill" && Object.keys(entry.reference).length > 0
					? ` ref=${JSON.stringify(entry.reference).slice(0, 240)}`
					: "";
			const progressText = consolidation && isProgressEntry(entry) ? "[progress] " : "";
			const usesText = consolidation ? ` uses=${usageCount(entry)}` : "";
			lines.push(
				`- ${progressText}[${entry.scope ?? "global"}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${usesText}${referenceText}${argumentsText}: ${content}`,
			);
		}
		if (entries.length > limit) {
			lines.push(`- +${entries.length - limit} more ${kind} entries`);
		}
	}
	return lines.join("\n");
}

function overviewForPrompt(state: HarnessState, options: { consolidation?: ConsolidationPolicy } = {}): string {
	return renderHarnessOverviewForPrompt(state, options);
}

function historyForPrompt(history: RefinementResult[]): string {
	if (history.length === 0) {
		return "No prior refinement history.";
	}
	return history
		.slice(-20)
		.map((item) => {
			const edits = [
				...item.appliedEdits.map(
					(edit) => `${edit.applied ? "applied" : "failed"} ${edit.action} ${edit.kind}:${edit.id}`,
				),
				...(item.skippedEdits ?? []).map((edit) => `skipped ${edit.kind}${edit.id ? `:${edit.id}` : ""}`),
			].join(", ");
			const rollback = item.rollbackOf ? ` rollbackOf=${item.rollbackOf}` : "";
			return `[${item.id}]${rollback} ${item.summary}\n${edits}\nExpected outcome: ${item.expectedOutcome}`;
		})
		.join("\n\n");
}

/**
 * Whether a JSON candidate ends mid-value: an unterminated string, or unclosed
 * objects/arrays. A reply cut off by an exhausted output budget is incomplete in
 * this sense, while a complete-but-malformed reply is balanced. Brace slicing can
 * also produce a balanced fragment, so callers treat "balanced" as malformed.
 */
function isIncompleteJson(candidate: string): boolean {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (const char of candidate) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{" || char === "[") depth++;
		else if (char === "}" || char === "]") depth--;
	}
	return inString || depth > 0;
}

function parseJsonCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch (error) {
		// A truncated reply and a malformed one both fail here, and JSON.parse
		// describes the fragment rather than the cause. Name the cause instead.
		if (isIncompleteJson(candidate)) {
			throw new Error(TRUNCATED_JSON_ERROR);
		}
		throw new Error(`the model did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		// A reply truncated after a nested closing brace still looks well-formed
		// here, so this path needs the same diagnosis as the slicing fallback.
		return parseJsonCandidate(trimmed);
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) {
		return parseJsonCandidate(fenced[1].trim());
	}
	// Brace slicing recovers JSON wrapped in prose. On a reply truncated inside the
	// edits array it slices to an earlier edit's closing brace, so a failure here
	// is diagnosed against the original text rather than the balanced fragment.
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(trimmed.slice(start, end + 1));
		} catch {
			return parseJsonCandidate(trimmed.slice(start));
		}
	}
	if (isIncompleteJson(trimmed)) {
		throw new Error(TRUNCATED_JSON_ERROR);
	}
	throw new Error("Refiner did not return a JSON object");
}

/**
 * Normalizes an untrusted refinement proposal while preserving invalid edit
 * fields for apply-time validation.
 */
export function normalizeRefinementProposal(value: unknown): RefinementProposal {
	const record =
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const edits = Array.isArray(record.edits) ? record.edits : [];
	return {
		summary: typeof record.summary === "string" ? record.summary : "Refined continual harness state",
		rationale: typeof record.rationale === "string" ? record.rationale : "",
		expectedOutcome: typeof record.expectedOutcome === "string" ? record.expectedOutcome : "",
		edits: edits
			.filter((edit): edit is Record<string, unknown> => typeof edit === "object" && edit !== null)
			.map((edit) => ({
				// B4: accept the paper's ADD/REMOVE/SKIP vocabulary (case-insensitive);
				// unknown values pass through so validateEdit still reports them.
				action: normalizeRefinementAction(edit.action) as RefinementAction,
				kind: edit.kind as RefinementKind,
				id: typeof edit.id === "string" ? edit.id : undefined,
				title: typeof edit.title === "string" ? edit.title : undefined,
				content: typeof edit.content === "string" ? edit.content : undefined,
				path: typeof edit.path === "string" ? edit.path : undefined,
				reference: objectRecord(edit.reference),
				arguments: objectRecord(edit.arguments),
				metadata:
					typeof edit.metadata === "object" && edit.metadata !== null && !Array.isArray(edit.metadata)
						? (edit.metadata as Record<string, unknown>)
						: undefined,
				reason: typeof edit.reason === "string" ? edit.reason : undefined,
			})),
	};
}

function parseProposal(text: string): RefinementProposal {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Refiner JSON must be an object");
	}
	return normalizeRefinementProposal(value);
}

function validateEdit(edit: RefinementEdit, computedId?: string): string | undefined {
	if (!["create", "update", "delete"].includes(edit.action)) {
		return `unsupported action ${String(edit.action)}`;
	}
	if (!["prompt", "memory", "skill", "subagent"].includes(edit.kind)) {
		return `unsupported kind ${String(edit.kind)}`;
	}
	if (edit.kind === "prompt" && (edit.id === "base_system_prompt" || computedId === "base_system_prompt")) {
		return "base system prompt is not editable";
	}
	if (edit.action !== "create" && !edit.id) {
		return `${edit.action} requires id`;
	}
	if (edit.action !== "delete" && (!edit.title || !edit.content)) {
		return `${edit.action} requires title and content`;
	}
	if (edit.action !== "delete" && edit.kind === "skill" && edit.arguments === undefined) {
		return `${edit.action} skill requires arguments`;
	}
	if (edit.action !== "delete" && edit.kind === "skill") {
		const reference = edit.reference;
		if (!reference) {
			return `${edit.action} skill requires python reference`;
		}
		if (reference.type !== "python") {
			return `${edit.action} skill reference.type must be python`;
		}
		const hasImport =
			(typeof reference.import === "string" && reference.import.length > 0) ||
			(typeof reference.python_import === "string" && reference.python_import.length > 0);
		const hasCallable =
			(typeof reference.callable === "string" && reference.callable.length > 0) ||
			(typeof reference.call_pattern === "string" && reference.call_pattern.length > 0);
		if (!hasImport) {
			return `${edit.action} skill requires python import`;
		}
		if (!hasCallable) {
			return `${edit.action} skill requires callable or call_pattern`;
		}
	}
	return undefined;
}

/**
 * Apply a proposal to a single store. `capPerKind` (B4) enforces the per-kind
 * capacity on that store: `skill`/`subagent` creates into a full kind are
 * rejected ("kind at capacity; REMOVE first"), and `prompt`/`memory` overflow
 * left after the edits is LFU-evicted (lowest `usage_count`, ties → oldest
 * `updated_at`), recorded as applied `delete` edits with `before` snapshots so
 * {@link rollbackProposal} restores them for free. Entries the proposal itself
 * created or updated are never evicted; progress-ledger entries are neither
 * counted nor evicted; rollbacks (`rollbackOf`) bypass the cap entirely.
 * Undefined `capPerKind` = no cap (prime behavior).
 */
export function applyRefinementProposal(
	state: HarnessState,
	proposal: RefinementProposal,
	options: {
		id: string;
		rollbackOf?: string;
		scope?: HarnessScope;
		baselineState?: HarnessState;
		capPerKind?: number;
	},
): RefinementResult {
	const appliedEdits: AppliedRefinementEdit[] = [];
	const skippedEdits: SkippedRefinementEdit[] = [];
	const proposalModifiedKeys = new Set<string>();
	const capPerKind = options.rollbackOf ? undefined : options.capPerKind;
	for (const edit of proposal.edits) {
		if (edit.action === "skip") {
			// Explicit SKIP verdict: recorded, never applied, never a failure.
			skippedEdits.push({ action: "skip", kind: edit.kind, id: edit.id, reason: edit.reason });
			continue;
		}
		const computedId = edit.id ?? (edit.action === "create" ? slug(edit.title ?? edit.kind, edit.kind) : undefined);
		const id = computedId ?? "";
		const validationError = validateEdit(edit, id);
		if (validationError) {
			appliedEdits.push({ ...edit, id, applied: false, error: validationError });
			continue;
		}

		const records = state.entries[edit.kind];
		const before = cloneEntry(records[id]);
		const entryKey = `${edit.kind}:${id}`;
		const baseline = cloneEntry(options.baselineState?.entries[edit.kind][id]);
		// Compare without `metadata.usage_count`: a kernel recall hit during planning
		// bumps only that counter and must not invalidate a planned UPDATE/REMOVE.
		if (
			options.baselineState &&
			!proposalModifiedKeys.has(entryKey) &&
			JSON.stringify(stripBookkeeping(before)) !== JSON.stringify(stripBookkeeping(baseline))
		) {
			appliedEdits.push({
				...edit,
				id,
				before,
				applied: false,
				error: "entry changed during refinement planning",
			});
			continue;
		}
		if (edit.action === "delete") {
			if (!before) {
				appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
				continue;
			}
			delete records[id];
			proposalModifiedKeys.add(entryKey);
			appliedEdits.push({ ...edit, id, before, applied: true });
			continue;
		}
		if (edit.action === "create" && before) {
			appliedEdits.push({ ...edit, id, before, applied: false, error: "entry already exists" });
			continue;
		}
		if (edit.action === "update" && !before) {
			appliedEdits.push({ ...edit, id, applied: false, error: "entry not found" });
			continue;
		}
		if (
			edit.action === "create" &&
			capPerKind !== undefined &&
			!isAutoEvictKind(edit.kind) &&
			!isProgressEdit(edit)
		) {
			// skill/subagent are never auto-evicted (their Python module or delegation
			// spec may still be referenced), so a full kind rejects the ADD instead.
			const count = Object.values(records).filter((entry) => !isProgressEntry(entry)).length;
			if (count >= capPerKind) {
				appliedEdits.push({ ...edit, id, applied: false, error: capacityError(edit.kind, count, capPerKind) });
				continue;
			}
		}

		const createdAt = before?.created_at ?? now();
		const version = before ? before.version + 1 : 1;
		const after: HarnessEntry = {
			id,
			kind: edit.kind,
			title: edit.title ?? before?.title ?? id,
			content: edit.content ?? before?.content ?? "",
			path: edit.path ?? before?.path ?? "general",
			scope: before?.scope ?? options.scope ?? "local",
			reference: edit.reference ?? before?.reference ?? {},
			arguments: edit.arguments ?? before?.arguments ?? {},
			metadata: edit.metadata ?? before?.metadata ?? {},
			source: "refine",
			created_at: createdAt,
			updated_at: now(),
			version,
		};
		records[id] = after;
		proposalModifiedKeys.add(entryKey);
		appliedEdits.push({ ...edit, id, before, after: cloneEntry(after), applied: true });
	}

	if (capPerKind !== undefined) {
		evictOverflow(state, capPerKind, proposalModifiedKeys, appliedEdits);
	}

	const changes = appliedEdits.filter((edit) => edit.applied).map((edit) => `${edit.action} ${edit.kind}:${edit.id}`);
	state.refinements.push({
		id: options.id,
		trigger: proposal.summary,
		changes,
		evidence: proposal.rationale,
		outcome: proposal.expectedOutcome,
		created_at: now(),
	});

	return {
		id: options.id,
		summary: proposal.summary,
		rationale: proposal.rationale,
		expectedOutcome: proposal.expectedOutcome,
		appliedEdits,
		...(skippedEdits.length > 0 ? { skippedEdits } : {}),
		harnessStatePath: "",
		rollbackOf: options.rollbackOf,
		scope: options.scope,
	};
}

/**
 * LFU-evict `prompt`/`memory` overflow above `capPerKind` after a proposal was
 * applied. Victims are recorded as applied `delete` edits (with `before`), so
 * they show up in `changes`, in the refinement history, and roll back normally.
 */
function evictOverflow(
	state: HarnessState,
	capPerKind: number,
	protectedKeys: ReadonlySet<string>,
	appliedEdits: AppliedRefinementEdit[],
): void {
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		if (!isAutoEvictKind(kind)) continue;
		const records = state.entries[kind];
		const keyByEntry = new Map<HarnessEntry, string>();
		const candidates: HarnessEntry[] = [];
		for (const [key, entry] of Object.entries(records)) {
			if (isProgressEntry(entry)) continue;
			keyByEntry.set(entry, key);
			candidates.push(entry);
		}
		const overflow = candidates.length - capPerKind;
		if (overflow <= 0) continue;
		const protectedIds = new Set<string>();
		for (const key of protectedKeys) {
			if (key.startsWith(`${kind}:`)) protectedIds.add(key.slice(kind.length + 1));
		}
		for (const victim of selectLfuEvictions(candidates, overflow, protectedIds)) {
			const key = keyByEntry.get(victim) ?? victim.id;
			const before = cloneEntry(records[key]);
			delete records[key];
			appliedEdits.push({
				action: "delete",
				kind,
				id: key,
				before,
				applied: true,
				reason: evictionReason(victim, capPerKind),
			});
		}
	}
}

function rollbackProposal(target: RefinementResult): RefinementProposal {
	const edits: RefinementEdit[] = [];
	for (const edit of [...target.appliedEdits].reverse()) {
		if (!edit.applied) continue;
		if (edit.before) {
			edits.push({
				action: edit.after ? "update" : "create",
				kind: edit.kind,
				id: edit.id,
				title: edit.before.title,
				content: edit.before.content,
				path: edit.before.path,
				reference: edit.before.reference,
				arguments: edit.before.arguments,
				metadata: edit.before.metadata,
				reason: `Rollback ${target.id}`,
			});
		} else if (edit.after) {
			edits.push({
				action: "delete",
				kind: edit.kind,
				id: edit.id,
				reason: `Rollback ${target.id}`,
			});
		}
	}
	return {
		summary: `Rollback refinement ${target.id}`,
		rationale: `Restores continual harness state snapshots from refinement ${target.id}.`,
		expectedOutcome: "Faulty refinement edits are reverted.",
		edits,
	};
}

export function getRefinementHistory(entries: readonly CustomEntry[]): RefinementResult[] {
	return entries
		.filter((entry) => entry.customType === REFINEMENT_CUSTOM_TYPE)
		.map((entry) => entry.data)
		.filter((data): data is RefinementResult => {
			return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
		});
}

export interface RefinementPlan {
	proposal: RefinementProposal;
	id: string;
	rollbackOf?: string;
	rollbackScope?: HarnessScope;
	/** Target-scope state captured before planning, used to reject conflicting edits at apply time. */
	baselineState?: HarnessState;
}

/**
 * Consolidation policy for one planning call (B4): undefined when no cap is
 * resolved (stock prompt), otherwise the cap plus the target store's current
 * non-progress counts (`global` → global entries, else local entries).
 */
export function resolveConsolidationPolicy(
	state: HarnessState,
	options: { capPerKind?: number; global?: boolean; scope?: HarnessScope },
): ConsolidationPolicy | undefined {
	if (options.capPerKind === undefined) return undefined;
	const scope: HarnessScope = options.scope ?? (options.global ? "global" : "local");
	return { capPerKind: options.capPerKind, counts: countConsolidationEntries(state, scope) };
}

/**
 * Produce a refinement proposal (the LLM pass, or a rollback proposal) without
 * mutating any harness state. Separated from {@link applyRefinementProposal} so
 * callers can re-read the harness file immediately before applying — the LLM call
 * here can take many seconds, during which the kernel or another session may write
 * the shared `harness_state.json`.
 */
/** Mint a refinement id in the canonical `refine_<timestamp>` format. */
export function generateRefinementId(): string {
	return `refine_${new Date()
		.toISOString()
		.replace(/[^0-9]/g, "")
		.slice(0, 17)}`;
}

export async function planRefinement(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RefinementPlan> {
	const id = generateRefinementId();
	if (options.rollbackId) {
		const target = history.find((item) => item.id === options.rollbackId);
		if (!target) {
			throw new Error(`Refinement ${options.rollbackId} not found`);
		}
		const fallbackScope: HarnessScope = options.global ? "global" : "local";
		return {
			proposal: rollbackProposal(target),
			id,
			rollbackOf: target.id,
			rollbackScope: inferRefinementResultScope(target) ?? fallbackScope,
		};
	}

	const conversationText = serializeConversation(convertToLlm(messages)).slice(-80_000);
	const scopeInstruction = options.global
		? "Requested refinement scope: global. Only propose stable cross-session continual harness edits, durable user preferences, reusable skills/subagents, or explicitly project-qualified facts that should affect future evopi sessions. Do not persist session-only progress, temporary blockers, or current-run coordination globally."
		: "Requested refinement scope: local. Prefer local continual harness edits for current task progress, temporary blockers, current-run coordination, and project facts that are not clearly reusable across evopi sessions. Global entries in the overview are read-only context: do not propose update or delete edits for them; create a local entry instead if an override is needed.";
	// B4: with a resolved cap the planner sees the consolidation addendum and an
	// LFU-ordered overview; counts are those of the target store only.
	const consolidation = resolveConsolidationPolicy(state, options);
	const userPrompt = [
		`<current_harness_state>\n${overviewForPrompt(state, { consolidation })}\n</current_harness_state>`,
		`<refinement_history>\n${historyForPrompt(history)}\n</refinement_history>`,
		`<conversation>\n${conversationText}\n</conversation>`,
		`<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
		options.instructions ? `<user_refine_instructions>\n${options.instructions}\n</user_refine_instructions>` : "",
		"Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
	]
		.filter(Boolean)
		.join("\n\n");

	// /refine requires a parseable JSON object in the final text. Some reasoning-capable
	// OpenAI-compatible models can spend the response on visible thinking and return no
	// final text, which makes otherwise successful daemon /refine calls fail parsing.
	// Keep the refinement request non-reasoning regardless of the interactive session
	// thinking level so the model uses its output budget for the JSON object.
	void thinkingLevel;
	const response = await completeSimple(
		model,
		{
			systemPrompt: buildRefinementSystemPrompt(consolidation),
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{ maxTokens: refinementMaxOutputTokens(model), signal, apiKey, headers },
	);

	if (response.stopReason === "error") {
		throw new Error(`Refinement failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(`Refinement failed: ${TRUNCATED_JSON_ERROR}`);
	}

	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return { proposal: parseProposal(text), id };
}

function parseAutoRefineReview(text: string): AutoRefineReview {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Auto-refine review JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	return {
		shouldRefine: record.shouldRefine === true,
		rationale: typeof record.rationale === "string" ? record.rationale : "No rationale provided.",
		instructions: typeof record.instructions === "string" ? record.instructions : undefined,
	};
}

export async function reviewAutoRefine(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	context: AutoRefineReviewContext,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<AutoRefineReview> {
	const conversationText = serializeConversation(convertToLlm(messages)).slice(-40_000);
	const userPrompt = [
		`<trigger>
${context.reason}; ${context.turnsSinceLastReview} assistant turns since last auto-refine review
</trigger>`,
		`<current_harness_state>
${overviewForPrompt(state)}
</current_harness_state>`,
		`<refinement_history>
${historyForPrompt(history)}
</refinement_history>`,
		`<conversation>
${conversationText}
</conversation>`,
		"Return shouldRefine=true when the trajectory contains evidence useful to this session's future turns. Prefer local harness edits for current task progress, temporary blockers, and current-run coordination. Ask for global refinement only for durable cross-session lessons or explicitly project-qualified facts likely to be reused in future sessions.",
	].join("\n\n");
	// Auto-refine review requires parseable JSON. Keep it non-reasoning so
	// reasoning-capable models use final text budget for the JSON object.
	void thinkingLevel;
	const response = await completeSimple(
		model,
		{
			systemPrompt: AUTO_REFINE_REVIEW_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		},
		{ maxTokens: autoRefineReviewMaxOutputTokens(model), signal, apiKey, headers },
	);
	if (response.stopReason === "error") {
		throw new Error(`Auto-refine review failed: ${response.errorMessage || "Unknown error"}`);
	}
	if (response.stopReason === "length") {
		throw new Error(`Auto-refine review failed: ${TRUNCATED_JSON_ERROR}`);
	}
	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return parseAutoRefineReview(text);
}

export async function refineHarness(
	messages: AgentMessage[],
	state: HarnessState,
	history: RefinementResult[],
	model: Model<any>,
	apiKey: string,
	options: RefineOptions = {},
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
): Promise<RefinementResult> {
	const plan = await planRefinement(messages, state, history, model, apiKey, options, headers, signal, thinkingLevel);
	return applyRefinementProposal(state, plan.proposal, {
		id: plan.id,
		rollbackOf: plan.rollbackOf,
		scope: plan.rollbackScope ?? (options.global ? "global" : "local"),
		capPerKind: options.capPerKind,
	});
}
