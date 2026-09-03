/**
 * Subagent git-worktree isolation (NS-D1).
 *
 * An isolated RLM child runs inside a detached `git worktree` that mirrors the
 * parent checkout (HEAD plus the parent's uncommitted staged/unstaged/untracked
 * state). A baseline commit is recorded in the worktree right after seeding, so
 * the child's delta is simply `baseline..worktree` and the parent's WIP never
 * leaks into the captured patch. On completion the delta is written to
 * `<childSessionDir>/worktree.patch`, optionally applied to the parent working
 * tree (`git apply`, index untouched), and the worktree is removed.
 *
 * Layout: `<base>/<repoHash9>/<childId>` plus a sibling `<childId>.owner.json`
 * marker `{pid, startedAt, childId, parentSessionId, repoRoot, worktreePath}`
 * written before `git worktree add`, so a crashed run can be told apart from a
 * live one by {@link pruneStaleWorktrees}.
 *
 * Node-only: git is spawned through `child_process` with timeouts (no Bun APIs).
 * This module owns no session state; `AgentSession` wires it into the spawn flow.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, existsSync } from "node:fs";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rm,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { expandTildePath, getAgentDir } from "../config.js";
import { isProcessAlive } from "../utils/child-process.js";
import type { SubagentWorktreeMode } from "./settings-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubagentWorktreeStage =
	| "git"
	| "not-git"
	| "no-commits"
	| "add"
	| "seed"
	| "baseline"
	| "capture"
	| "apply"
	| "remove"
	| "prune";

/** Typed failure so the spawn flow can decide between fallback and hard failure. */
export class SubagentWorktreeError extends Error {
	readonly stage: SubagentWorktreeStage;
	/** Raw git stderr (or similar) when available. */
	readonly details?: string;

	constructor(stage: SubagentWorktreeStage, message: string, options?: { cause?: unknown; details?: string }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "SubagentWorktreeError";
		this.stage = stage;
		this.details = options?.details;
	}
}

/** Owner marker persisted next to the worktree directory (`<path>.owner.json`). */
export interface SubagentWorktreeOwner {
	version: 1;
	pid: number;
	startedAt: string;
	childId: string;
	parentSessionId?: string;
	repoRoot: string;
	worktreePath: string;
}

export interface SubagentWorktreeHandle {
	childId: string;
	/** Top-level directory of the parent checkout (`git rev-parse --show-toplevel`). */
	repoRoot: string;
	/** Absolute path of the detached worktree (child cwd). */
	path: string;
	/** Sibling owner marker file. */
	ownerFile: string;
	/** Parent HEAD at creation time. */
	headCommit: string;
	/** Commit recorded inside the worktree after seeding; the child delta is measured against it. */
	baselineCommit: string;
	/** Whether the parent's dirty state was copied in. */
	seeded: boolean;
	/** Human-readable notes from seeding (e.g. skipped nested repositories). */
	seedNotices: string[];
}

export interface SubagentWorktreeGitOptions {
	/** Per-git-command timeout; default 120s. */
	timeoutMs?: number;
	/** Git executable; default `git` from PATH. */
	gitBinary?: string;
}

export interface CreateSubagentWorktreeOptions extends SubagentWorktreeGitOptions {
	/** Parent working directory (anywhere inside the repository). */
	cwd: string;
	/** Child id (`sub-xxxxxxxx`); becomes the worktree directory name. */
	childId: string;
	/** Recorded in the owner marker for diagnostics. */
	parentSessionId?: string;
	/** Worktree base directory; default {@link subagentWorktreeBaseDir}. */
	baseDir?: string;
	/** Copy the parent's uncommitted changes into the worktree (default true). */
	seedDirty?: boolean;
	/** Refuse to seed above this many bytes (default 1 GiB). */
	maxSeedBytes?: number;
}

export interface SubagentWorktreeDelta {
	/** Binary-safe unified diff `baseline..worktree` (empty when nothing changed). */
	patch: Buffer;
	/** Repo-relative paths touched by the patch, sorted. */
	files: string[];
}

export type SubagentPatchApplyStatus = "applied" | "empty" | "already-applied" | "conflict";

export interface SubagentPatchApplyResult {
	status: SubagentPatchApplyStatus;
	files: string[];
	/** `git apply --check` stderr on conflict. */
	error?: string;
}

export interface CompleteSubagentWorktreeOptions extends SubagentWorktreeGitOptions {
	/** Directory receiving `worktree.patch` (the child session dir). */
	patchDir: string;
	/** patch-apply: apply the delta to the parent checkout; none: keep the patch file only. */
	merge: "patch-apply" | "none";
	/** When false (error/cancel paths) the patch is retained but never applied. Default true. */
	apply?: boolean;
}

export interface SubagentWorktreeOutcome {
	worktreePath: string;
	repoRoot: string;
	/** Absent when capture failed. */
	patchPath?: string;
	files: string[];
	/** Absent when merge is `none`, apply was disabled, or capture failed. */
	apply?: SubagentPatchApplyResult;
	captureError?: string;
	removeError?: string;
}

export type SubagentWorktreeState = "live" | "stale" | "orphan";

export interface SubagentWorktreeEntry {
	path: string;
	ownerFile?: string;
	owner?: SubagentWorktreeOwner;
	/** live: owner pid is running; stale: owner pid is dead or marker unreadable; orphan: no marker. */
	state: SubagentWorktreeState;
	/** False when only the marker survives. */
	exists: boolean;
}

export interface PruneStaleWorktreesOptions extends SubagentWorktreeGitOptions {
	/** Also remove live and marker-less entries. */
	all?: boolean;
	/** Report without deleting. */
	dryRun?: boolean;
}

export interface PruneStaleWorktreesResult {
	dryRun: boolean;
	entries: SubagentWorktreeEntry[];
	/** Paths removed (or that would be removed under dryRun). */
	removed: string[];
	kept: string[];
	failed: Array<{ path: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Constants and path helpers
// ---------------------------------------------------------------------------

export const SUBAGENT_WORKTREE_PATCH_FILENAME = "worktree.patch";
export const SUBAGENT_WORKTREE_OWNER_SUFFIX = ".owner.json";
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_SEED_BYTES = 1024 * 1024 * 1024;
const NO_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

/** `<agentDir>/worktrees` unless a base is configured (`~` expanded). */
export function subagentWorktreeBaseDir(base?: string): string {
	const trimmed = base?.trim();
	return trimmed ? resolve(expandTildePath(trimmed)) : join(getAgentDir(), "worktrees");
}

/** Nine-hex bucket for a repository, so unrelated repos never share a directory. */
export function subagentWorktreeRepoHash(repoRoot: string): string {
	return createHash("sha1").update(resolve(repoRoot)).digest("hex").slice(0, 9);
}

export function subagentWorktreePath(baseDir: string, repoRoot: string, childId: string): string {
	return join(baseDir, subagentWorktreeRepoHash(repoRoot), childId);
}

export function subagentWorktreeOwnerFile(worktreePath: string): string {
	return `${worktreePath}${SUBAGENT_WORKTREE_OWNER_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Isolation request resolution (pure helpers for the spawn flow)
// ---------------------------------------------------------------------------

/** `isolated` kwarg must be a bool (Python `None` arrives as null and means "unset"). */
export function normalizeRequestedRlmSubagentIsolation(value: unknown): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	throw new Error("rlm.run kwarg isolated must be a bool");
}

/**
 * Decide whether a child is isolated for the configured mode.
 * off + explicit True throws (isolation disabled); opt-in isolates only on explicit True;
 * always isolates unless explicit False.
 */
export function resolveSubagentIsolation(requested: boolean | undefined, mode: SubagentWorktreeMode): boolean {
	switch (mode) {
		case "always":
			return requested !== false;
		case "opt-in":
			return requested === true;
		default:
			if (requested === true) {
				throw new Error(
					'rlm.run isolated=True is disabled: set subagent.worktree.mode to "opt-in" or "always" ' +
						"(or EVOPI_SUBAGENT_WORKTREE=opt-in) to enable git-worktree isolation",
				);
			}
			return false;
	}
}

// ---------------------------------------------------------------------------
// git runner
// ---------------------------------------------------------------------------

interface GitRunResult {
	status: number | null;
	stdout: Buffer;
	stderr: string;
	timedOut: boolean;
}

interface GitRunOptions extends SubagentWorktreeGitOptions {
	cwd: string;
	input?: Buffer | string;
	stage: SubagentWorktreeStage;
}

function runGit(args: string[], options: GitRunOptions): Promise<GitRunResult> {
	const gitBinary = options.gitBinary ?? "git";
	const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	return new Promise((resolvePromise, rejectPromise) => {
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			rejectPromise(error);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(gitBinary, ["--no-optional-locks", ...args], {
				cwd: options.cwd,
				stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
				windowsHide: true,
			});
		} catch (error) {
			fail(
				new SubagentWorktreeError(
					options.stage,
					`failed to start git (${gitBinary}): ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				),
			);
			return;
		}
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			// ENOENT is ambiguous between a missing binary and a missing cwd; only the former is a `git` failure.
			if (error.code === "ENOENT" && !existsSync(options.cwd)) {
				fail(new SubagentWorktreeError(options.stage, `directory is missing: ${options.cwd}`, { cause: error }));
				return;
			}
			fail(
				new SubagentWorktreeError("git", `failed to start git (${gitBinary}): ${error.message}`, {
					cause: error,
				}),
			);
		});
		child.once("close", (status) => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;
			resolvePromise({
				status,
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr).toString("utf8"),
				timedOut,
			});
		});
		if (options.input !== undefined && child.stdin) {
			child.stdin.on("error", () => undefined);
			child.stdin.end(options.input);
		}
	});
}

/** Run git and throw a typed error on non-zero exit or timeout. */
async function git(args: string[], options: GitRunOptions): Promise<GitRunResult> {
	const result = await runGit(args, options);
	if (result.timedOut) {
		throw new SubagentWorktreeError(
			options.stage,
			`git ${args[0]} timed out after ${options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS}ms`,
			{
				details: result.stderr,
			},
		);
	}
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.toString("utf8").trim();
		throw new SubagentWorktreeError(options.stage, `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`, {
			details: detail,
		});
	}
	return result;
}

function splitNul(buffer: Buffer): string[] {
	return buffer
		.toString("utf8")
		.split("\0")
		.filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------
// Repository discovery
// ---------------------------------------------------------------------------

/**
 * Top-level directory of the checkout containing `cwd`, or undefined when `cwd`
 * is not inside a git working tree (bare repos and `.git` internals count as not-git).
 * Throws a `git`-stage error only when git itself cannot be executed.
 */
export async function resolveGitRepoRoot(
	cwd: string,
	options: SubagentWorktreeGitOptions = {},
): Promise<string | undefined> {
	if (!existsSync(cwd)) return undefined;
	const result = await runGit(["rev-parse", "--show-toplevel"], { ...options, cwd, stage: "not-git" });
	if (result.timedOut || result.status !== 0) return undefined;
	const root = result.stdout.toString("utf8").trim();
	return root ? resolve(root) : undefined;
}

// ---------------------------------------------------------------------------
// Creation and seeding
// ---------------------------------------------------------------------------

interface DirtyState {
	/** `git diff --binary HEAD` of tracked files (working tree vs HEAD). */
	trackedDiff: Buffer;
	/** Untracked, non-ignored files (repo-relative). */
	untrackedFiles: string[];
	/** Untracked entries that were skipped (nested repositories show up as `dir/`). */
	skipped: string[];
	/** Diff bytes plus untracked file bytes. */
	totalBytes: number;
}

async function captureDirtyState(repoRoot: string, options: SubagentWorktreeGitOptions): Promise<DirtyState> {
	const diff = await git(
		["diff", "--binary", "--no-color", "--no-ext-diff", "--no-renames", "--ignore-submodules=all", "HEAD", "--"],
		{ ...options, cwd: repoRoot, stage: "seed" },
	);
	const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], {
		...options,
		cwd: repoRoot,
		stage: "seed",
	});
	const untrackedFiles: string[] = [];
	const skipped: string[] = [];
	let totalBytes = diff.stdout.length;
	for (const entry of splitNul(untracked.stdout)) {
		if (entry.endsWith("/")) {
			skipped.push(entry);
			continue;
		}
		const absolute = resolve(repoRoot, entry);
		const rel = relative(repoRoot, absolute);
		if (rel.startsWith("..") || rel.split(sep).includes(".git")) {
			skipped.push(entry);
			continue;
		}
		try {
			const stat = await lstat(absolute);
			if (stat.isDirectory()) {
				skipped.push(entry);
				continue;
			}
			totalBytes += stat.size;
			untrackedFiles.push(entry);
		} catch {
			// Vanished between listing and stat; nothing to seed.
		}
	}
	return { trackedDiff: diff.stdout, untrackedFiles, skipped, totalBytes };
}

async function copyUntrackedFile(repoRoot: string, worktreePath: string, rel: string): Promise<void> {
	const src = join(repoRoot, rel);
	const dst = join(worktreePath, rel);
	await mkdir(dirname(dst), { recursive: true });
	const stat = await lstat(src);
	if (stat.isSymbolicLink()) {
		const target = await readlink(src);
		await rm(dst, { force: true });
		await symlink(target, dst);
		return;
	}
	if (!stat.isFile()) return;
	await copyFile(src, dst);
	if (process.platform !== "win32") {
		await chmod(dst, stat.mode & 0o777).catch(() => undefined);
	}
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}

async function writeOwnerMarker(ownerFile: string, owner: SubagentWorktreeOwner): Promise<void> {
	await mkdir(dirname(ownerFile), { recursive: true });
	await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, "utf8");
}

/**
 * Create a detached worktree for `childId`, seed it with the parent's dirty state,
 * and record a baseline commit. Throws {@link SubagentWorktreeError}; nothing is
 * left behind on failure.
 */
export async function createSubagentWorktree(options: CreateSubagentWorktreeOptions): Promise<SubagentWorktreeHandle> {
	const gitOptions: SubagentWorktreeGitOptions = { timeoutMs: options.timeoutMs, gitBinary: options.gitBinary };
	const cwd = resolve(options.cwd);
	const childId = options.childId.trim();
	if (!childId || childId.includes("/") || childId.includes("\\") || childId === "." || childId === "..") {
		throw new SubagentWorktreeError("add", `invalid worktree child id: ${JSON.stringify(options.childId)}`);
	}
	const repoRoot = await resolveGitRepoRoot(cwd, gitOptions);
	if (!repoRoot) {
		throw new SubagentWorktreeError(
			"not-git",
			`cwd is not a git repository: ${cwd}; rlm.run isolated=True requires a git checkout`,
		);
	}
	const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], {
		...gitOptions,
		cwd: repoRoot,
		stage: "no-commits",
	});
	if (head.timedOut || head.status !== 0) {
		throw new SubagentWorktreeError(
			"no-commits",
			`repository has no commits: ${repoRoot}; worktree isolation needs at least one commit`,
		);
	}
	const headCommit = head.stdout.toString("utf8").trim();

	const seedDirty = options.seedDirty !== false;
	const maxSeedBytes = options.maxSeedBytes ?? DEFAULT_MAX_SEED_BYTES;
	let dirty: DirtyState | undefined;
	if (seedDirty) {
		dirty = await captureDirtyState(repoRoot, gitOptions);
		if (dirty.totalBytes > maxSeedBytes) {
			throw new SubagentWorktreeError(
				"seed",
				`uncommitted changes in ${repoRoot} are ${formatBytes(dirty.totalBytes)}, above the ` +
					`${formatBytes(maxSeedBytes)} seed limit (subagent.worktree.maxSeedBytes); commit, stash or ignore ` +
					"large untracked files, raise the limit, or spawn with seedDirty disabled",
			);
		}
	}

	const baseDir = options.baseDir ? resolve(options.baseDir) : subagentWorktreeBaseDir();
	const worktreePath = subagentWorktreePath(baseDir, repoRoot, childId);
	if (existsSync(worktreePath)) {
		throw new SubagentWorktreeError("add", `worktree path already exists: ${worktreePath}`);
	}
	const ownerFile = subagentWorktreeOwnerFile(worktreePath);
	const owner: SubagentWorktreeOwner = {
		version: 1,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		childId,
		...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
		repoRoot,
		worktreePath,
	};
	// Marker first: a concurrent prune must never see an owner-less directory mid-creation.
	await writeOwnerMarker(ownerFile, owner);

	const cleanup = async () => {
		await removeSubagentWorktree({ repoRoot, path: worktreePath, ownerFile }, gitOptions).catch(() => undefined);
	};

	const seedNotices: string[] = [];
	try {
		await git(["worktree", "add", "--detach", worktreePath, "HEAD"], {
			...gitOptions,
			cwd: repoRoot,
			stage: "add",
		});
		if (dirty) {
			if (dirty.trackedDiff.length > 0) {
				await git(["apply", "--whitespace=nowarn"], {
					...gitOptions,
					cwd: worktreePath,
					input: dirty.trackedDiff,
					stage: "seed",
				});
			}
			for (const rel of dirty.untrackedFiles) {
				try {
					await copyUntrackedFile(repoRoot, worktreePath, rel);
				} catch (error) {
					throw new SubagentWorktreeError(
						"seed",
						`failed to copy untracked file ${rel}: ${error instanceof Error ? error.message : String(error)}`,
						{ cause: error },
					);
				}
			}
			for (const entry of dirty.skipped) {
				seedNotices.push(`skipped untracked entry ${entry} (nested repository or directory; not seeded)`);
			}
		}

		// Baseline: everything the child starts from, so the captured delta excludes parent WIP.
		await git(["add", "-A", "--"], { ...gitOptions, cwd: worktreePath, stage: "baseline" });
		await git(
			[
				"-c",
				"user.name=evopi",
				"-c",
				"user.email=evopi@localhost",
				"-c",
				"commit.gpgsign=false",
				"-c",
				`core.hooksPath=${NO_HOOKS_PATH}`,
				"commit",
				"--quiet",
				"--no-verify",
				"--allow-empty",
				"-m",
				`evopi worktree baseline ${childId}`,
			],
			{ ...gitOptions, cwd: worktreePath, stage: "baseline" },
		);
		const baseline = await git(["rev-parse", "--verify", "HEAD"], {
			...gitOptions,
			cwd: worktreePath,
			stage: "baseline",
		});
		return {
			childId,
			repoRoot,
			path: worktreePath,
			ownerFile,
			headCommit,
			baselineCommit: baseline.stdout.toString("utf8").trim(),
			seeded: Boolean(dirty),
			seedNotices,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Delta capture
// ---------------------------------------------------------------------------

/**
 * Stage everything in the worktree's private index and diff it against the
 * baseline commit. Covers edits, additions, deletions, mode changes and binaries;
 * commits made by the child inside the worktree are included because the diff is
 * anchored on the baseline, not on HEAD. Nested repositories are excluded.
 */
export async function captureSubagentWorktreeDelta(
	handle: Pick<SubagentWorktreeHandle, "path" | "baselineCommit">,
	options: SubagentWorktreeGitOptions = {},
): Promise<SubagentWorktreeDelta> {
	if (!existsSync(handle.path)) {
		throw new SubagentWorktreeError("capture", `worktree is missing: ${handle.path}`);
	}
	await git(["add", "-A", "--"], { ...options, cwd: handle.path, stage: "capture" });
	const diffArgs = ["--cached", "--no-color", "--no-ext-diff", "--no-renames", "--ignore-submodules=all"];
	const patch = await git(["diff", "--binary", ...diffArgs, handle.baselineCommit, "--"], {
		...options,
		cwd: handle.path,
		stage: "capture",
	});
	const names = await git(["diff", "--name-only", "-z", ...diffArgs, handle.baselineCommit, "--"], {
		...options,
		cwd: handle.path,
		stage: "capture",
	});
	return { patch: patch.stdout, files: splitNul(names.stdout).sort() };
}

/** Write the delta to `<dir>/worktree.patch` (written even when empty so the artifact always exists). */
export async function writeSubagentWorktreePatch(dir: string, patch: Buffer | string): Promise<string> {
	await mkdir(dir, { recursive: true });
	const patchPath = join(dir, SUBAGENT_WORKTREE_PATCH_FILENAME);
	await writeFile(patchPath, patch);
	return patchPath;
}

// ---------------------------------------------------------------------------
// Apply to the parent checkout
// ---------------------------------------------------------------------------

const repoApplyLocks = new Map<string, Promise<void>>();

/** Serialize patch application per repository within this process. */
async function withRepoApplyLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
	const key = resolve(repoRoot);
	const previous = repoApplyLocks.get(key) ?? Promise.resolve();
	let release: () => void = () => undefined;
	const current = new Promise<void>((resolveLock) => {
		release = resolveLock;
	});
	const chained = previous.then(() => current);
	repoApplyLocks.set(key, chained);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (repoApplyLocks.get(key) === chained) repoApplyLocks.delete(key);
	}
}

function parseNumstat(buffer: Buffer): string[] {
	const files: string[] = [];
	for (const entry of splitNul(buffer)) {
		const secondTab = entry.indexOf("\t", entry.indexOf("\t") + 1);
		const path = secondTab >= 0 ? entry.slice(secondTab + 1) : entry;
		if (path) files.push(path);
	}
	return files.sort();
}

/**
 * Apply a captured patch to the parent working tree. `git apply --check` first,
 * then a plain `git apply` (the parent's index is never touched; new files show
 * up untracked). A patch whose reverse applies cleanly is reported as already
 * applied. Any failure leaves the working tree untouched and returns `conflict`.
 */
export async function applySubagentWorktreePatch(
	repoRoot: string,
	patch: Buffer | string,
	options: SubagentWorktreeGitOptions = {},
): Promise<SubagentPatchApplyResult> {
	const input = Buffer.isBuffer(patch) ? patch : Buffer.from(patch, "utf8");
	if (input.toString("utf8").trim().length === 0) {
		return { status: "empty", files: [] };
	}
	if (!existsSync(repoRoot)) {
		throw new SubagentWorktreeError("apply", `parent checkout is missing: ${repoRoot}`);
	}
	return await withRepoApplyLock(repoRoot, async () => {
		const numstat = await runGit(["apply", "--numstat", "-z"], { ...options, cwd: repoRoot, input, stage: "apply" });
		const files = numstat.status === 0 ? parseNumstat(numstat.stdout) : [];
		const check = await runGit(["apply", "--check", "--whitespace=nowarn"], {
			...options,
			cwd: repoRoot,
			input,
			stage: "apply",
		});
		if (check.status !== 0 || check.timedOut) {
			const reverse = await runGit(["apply", "--check", "--reverse", "--whitespace=nowarn"], {
				...options,
				cwd: repoRoot,
				input,
				stage: "apply",
			});
			if (reverse.status === 0 && !reverse.timedOut) {
				return { status: "already-applied", files };
			}
			const error = check.timedOut
				? "git apply --check timed out"
				: check.stderr.trim() || "git apply --check failed";
			return { status: "conflict", files, error };
		}
		const apply = await runGit(["apply", "--whitespace=nowarn"], {
			...options,
			cwd: repoRoot,
			input,
			stage: "apply",
		});
		if (apply.status !== 0 || apply.timedOut) {
			const error = apply.timedOut ? "git apply timed out" : apply.stderr.trim() || "git apply failed";
			return { status: "conflict", files, error };
		}
		return { status: "applied", files };
	});
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * Remove the worktree (`git worktree remove --force`, then `rm -rf` fallback),
 * its owner marker, and prune stale worktree metadata in the parent repository.
 * Best-effort at every step; throws only when the directory still exists afterwards.
 */
export async function removeSubagentWorktree(
	target: { repoRoot: string; path: string; ownerFile?: string },
	options: SubagentWorktreeGitOptions = {},
): Promise<void> {
	const worktreePath = resolve(target.path);
	const ownerFile = target.ownerFile ?? subagentWorktreeOwnerFile(worktreePath);
	const repoExists = existsSync(target.repoRoot);
	if (repoExists && existsSync(worktreePath)) {
		await runGit(["worktree", "remove", "--force", "--force", worktreePath], {
			...options,
			cwd: target.repoRoot,
			stage: "remove",
		}).catch(() => undefined);
	}
	if (existsSync(worktreePath)) {
		await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
	}
	await unlink(ownerFile).catch(() => undefined);
	if (repoExists) {
		await runGit(["worktree", "prune"], { ...options, cwd: target.repoRoot, stage: "remove" }).catch(() => undefined);
	}
	// Drop the per-repo bucket when it is empty; ignore ENOTEMPTY/ENOENT.
	await rmdir(dirname(worktreePath)).catch(() => undefined);
	if (existsSync(worktreePath)) {
		throw new SubagentWorktreeError("remove", `failed to remove worktree: ${worktreePath}`);
	}
}

// ---------------------------------------------------------------------------
// Completion (capture -> patch file -> apply -> remove)
// ---------------------------------------------------------------------------

/**
 * Finish an isolated child: capture the delta, always write `worktree.patch`,
 * apply it to the parent checkout when `merge` is `patch-apply` (and `apply` is
 * not false), then remove the worktree. Never throws; problems are reported in
 * the outcome so the spawn flow can surface them to the parent.
 */
export async function completeSubagentWorktree(
	handle: SubagentWorktreeHandle,
	options: CompleteSubagentWorktreeOptions,
): Promise<SubagentWorktreeOutcome> {
	const gitOptions: SubagentWorktreeGitOptions = { timeoutMs: options.timeoutMs, gitBinary: options.gitBinary };
	const outcome: SubagentWorktreeOutcome = { worktreePath: handle.path, repoRoot: handle.repoRoot, files: [] };
	let delta: SubagentWorktreeDelta | undefined;
	try {
		delta = await captureSubagentWorktreeDelta(handle, gitOptions);
		outcome.files = delta.files;
		outcome.patchPath = await writeSubagentWorktreePatch(options.patchDir, delta.patch);
	} catch (error) {
		outcome.captureError = error instanceof Error ? error.message : String(error);
	}
	if (delta && options.merge === "patch-apply" && options.apply !== false) {
		try {
			outcome.apply = await applySubagentWorktreePatch(handle.repoRoot, delta.patch, gitOptions);
		} catch (error) {
			outcome.apply = {
				status: "conflict",
				files: delta.files,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	try {
		await removeSubagentWorktree(handle, gitOptions);
	} catch (error) {
		outcome.removeError = error instanceof Error ? error.message : String(error);
	}
	return outcome;
}

function formatFileList(files: string[], max = 8): string {
	if (files.length <= max) return files.join(", ");
	return `${files.slice(0, max).join(", ")}, +${files.length - max} more`;
}

/** One-line, parent-facing summary of an isolated child's outcome. */
export function formatSubagentWorktreeOutcome(outcome: SubagentWorktreeOutcome): string {
	const count = outcome.files.length;
	const fileWord = `${count} file${count === 1 ? "" : "s"}`;
	let text: string;
	if (outcome.captureError) {
		text = `Isolated worktree: failed to capture the child's changes (${outcome.captureError}).`;
	} else if (count === 0) {
		text = "Isolated worktree: no file changes.";
	} else if (!outcome.apply) {
		text = `Isolated worktree: ${fileWord} changed; patch saved at ${outcome.patchPath} (not applied).`;
	} else {
		switch (outcome.apply.status) {
			case "applied":
				text = `Isolated worktree: applied ${fileWord} to ${outcome.repoRoot} (${formatFileList(outcome.files)}); patch saved at ${outcome.patchPath}.`;
				break;
			case "already-applied":
				text = `Isolated worktree: ${fileWord} already present in ${outcome.repoRoot}; patch saved at ${outcome.patchPath}.`;
				break;
			case "empty":
				text = "Isolated worktree: no file changes.";
				break;
			default:
				text =
					`Isolated worktree: patch NOT applied to ${outcome.repoRoot} (${outcome.apply.error ?? "conflict"}); ` +
					`${fileWord} saved at ${outcome.patchPath}. Apply manually with: git apply ${outcome.patchPath}`;
				break;
		}
	}
	if (outcome.removeError) {
		text += ` Worktree cleanup failed: ${outcome.removeError}`;
	}
	return text;
}

// ---------------------------------------------------------------------------
// Listing and pruning
// ---------------------------------------------------------------------------

function parseOwner(raw: string): SubagentWorktreeOwner | undefined {
	try {
		const decoded: unknown = JSON.parse(raw);
		if (typeof decoded !== "object" || decoded === null) return undefined;
		const record = decoded as Record<string, unknown>;
		if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0) return undefined;
		return {
			version: 1,
			pid: record.pid,
			startedAt: typeof record.startedAt === "string" ? record.startedAt : "",
			childId: typeof record.childId === "string" ? record.childId : "",
			...(typeof record.parentSessionId === "string" ? { parentSessionId: record.parentSessionId } : {}),
			repoRoot: typeof record.repoRoot === "string" ? record.repoRoot : "",
			worktreePath: typeof record.worktreePath === "string" ? record.worktreePath : "",
		};
	} catch {
		return undefined;
	}
}

/** Scan `<baseDir>/<repoHash>/*` and classify each worktree by its owner marker. */
export async function listSubagentWorktrees(baseDir: string): Promise<SubagentWorktreeEntry[]> {
	const entries: SubagentWorktreeEntry[] = [];
	let buckets: string[];
	try {
		buckets = (await readdir(baseDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(baseDir, entry.name));
	} catch {
		return entries;
	}
	for (const bucket of buckets) {
		let children: Dirent[];
		try {
			children = await readdir(bucket, { withFileTypes: true });
		} catch {
			continue;
		}
		const markers = new Map<string, string>();
		const dirs = new Set<string>();
		for (const child of children) {
			if (child.isFile() && child.name.endsWith(SUBAGENT_WORKTREE_OWNER_SUFFIX)) {
				const worktreeName = child.name.slice(0, -SUBAGENT_WORKTREE_OWNER_SUFFIX.length);
				markers.set(worktreeName, join(bucket, child.name));
			} else if (child.isDirectory()) {
				dirs.add(child.name);
			}
		}
		for (const [name, ownerFile] of markers) {
			const worktreePath = join(bucket, name);
			let owner: SubagentWorktreeOwner | undefined;
			try {
				owner = parseOwner(await readFile(ownerFile, "utf8"));
			} catch {
				owner = undefined;
			}
			const live = owner ? isProcessAlive(owner.pid) : false;
			entries.push({ path: worktreePath, ownerFile, owner, state: live ? "live" : "stale", exists: dirs.has(name) });
			dirs.delete(name);
		}
		for (const name of dirs) {
			entries.push({ path: join(bucket, name), state: "orphan", exists: true });
		}
	}
	return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Remove worktrees whose owner process is gone (dead pid or unreadable marker).
 * `all` also removes live and marker-less entries; `dryRun` only reports.
 * Intended for startup (best-effort, async) and `/worktree prune [--all] [--dry-run]`.
 */
export async function pruneStaleWorktrees(
	baseDir: string,
	options: PruneStaleWorktreesOptions = {},
): Promise<PruneStaleWorktreesResult> {
	const gitOptions: SubagentWorktreeGitOptions = { timeoutMs: options.timeoutMs, gitBinary: options.gitBinary };
	const entries = await listSubagentWorktrees(baseDir);
	const result: PruneStaleWorktreesResult = {
		dryRun: options.dryRun === true,
		entries,
		removed: [],
		kept: [],
		failed: [],
	};
	for (const entry of entries) {
		const target = options.all ? true : entry.state === "stale";
		if (!target) {
			result.kept.push(entry.path);
			continue;
		}
		if (options.dryRun) {
			result.removed.push(entry.path);
			continue;
		}
		try {
			const repoRoot = entry.owner?.repoRoot && existsSync(entry.owner.repoRoot) ? entry.owner.repoRoot : "";
			await removeSubagentWorktree({ repoRoot, path: entry.path, ownerFile: entry.ownerFile }, gitOptions);
			result.removed.push(entry.path);
		} catch (error) {
			result.failed.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return result;
}
