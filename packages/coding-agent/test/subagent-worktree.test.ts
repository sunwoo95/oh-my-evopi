import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import {
	applySubagentWorktreePatch,
	captureSubagentWorktreeDelta,
	completeSubagentWorktree,
	createSubagentWorktree,
	formatSubagentWorktreeOutcome,
	listSubagentWorktrees,
	normalizeRequestedRlmSubagentIsolation,
	pruneStaleWorktrees,
	removeSubagentWorktree,
	resolveGitRepoRoot,
	resolveSubagentIsolation,
	SUBAGENT_WORKTREE_OWNER_SUFFIX,
	SUBAGENT_WORKTREE_PATCH_FILENAME,
	SubagentWorktreeError,
	type SubagentWorktreeHandle,
	subagentWorktreeBaseDir,
	subagentWorktreePath,
} from "../src/core/subagent-worktree.js";
import { findGitPaths } from "../src/utils/git.js";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`Command failed: git ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout.trim();
}

function initRepo(repoDir: string): void {
	git(["init", "-q", "--initial-branch=main"], repoDir);
	git(["config", "--local", "user.email", "test@test.com"], repoDir);
	git(["config", "--local", "user.name", "Test"], repoDir);
	git(["config", "--local", "commit.gpgsign", "false"], repoDir);
}

function write(dir: string, rel: string, content: string | Buffer): void {
	const path = join(dir, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

function read(dir: string, rel: string): string {
	return readFileSync(join(dir, rel), "utf8");
}

function worktreeList(repoDir: string): string[] {
	return git(["worktree", "list", "--porcelain"], repoDir)
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => realpathSync(line.slice("worktree ".length)));
}

/**
 * Committed: tracked.txt, remove-me.txt, dir/nested.txt, .gitignore (ignored.log).
 * Dirty: tracked.txt staged edit, dir/nested.txt unstaged edit, notes.md + tools/run.sh untracked, ignored.log ignored.
 */
function seedDirtyRepo(repoDir: string): void {
	initRepo(repoDir);
	write(repoDir, "tracked.txt", "base\n");
	write(repoDir, "remove-me.txt", "bye\n");
	write(repoDir, "dir/nested.txt", "nested\n");
	write(repoDir, ".gitignore", "ignored.log\n");
	git(["add", "-A"], repoDir);
	git(["commit", "-q", "-m", "base"], repoDir);
	write(repoDir, "tracked.txt", "base\nstaged\n");
	git(["add", "tracked.txt"], repoDir);
	write(repoDir, "dir/nested.txt", "nested\nunstaged\n");
	write(repoDir, "notes.md", "# notes\n");
	write(repoDir, "tools/run.sh", "#!/bin/sh\necho hi\n");
	chmodSync(join(repoDir, "tools/run.sh"), 0o755);
	write(repoDir, "ignored.log", "noise\n");
}

describe("subagent-worktree", () => {
	let tempDir: string;
	let repoDir: string;
	let baseDir: string;
	let patchDir: string;
	const handles: SubagentWorktreeHandle[] = [];

	beforeEach(() => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "evopi-subagent-worktree-")));
		repoDir = join(tempDir, "repo");
		baseDir = join(tempDir, "worktrees");
		patchDir = join(tempDir, "child-session");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(patchDir, { recursive: true });
	});

	afterEach(async () => {
		for (const handle of handles.splice(0)) {
			await removeSubagentWorktree(handle).catch(() => undefined);
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function create(options: Partial<Parameters<typeof createSubagentWorktree>[0]> = {}) {
		const handle = await createSubagentWorktree({
			cwd: repoDir,
			childId: options.childId ?? "sub-0badc0de",
			parentSessionId: "parent-session",
			baseDir,
			...options,
		});
		handles.push(handle);
		return handle;
	}

	describe("layout and configuration", () => {
		it("derives <base>/<repoHash9>/<childId> and a sibling owner marker", () => {
			const hash = createHash("sha1").update(repoDir).digest("hex").slice(0, 9);
			const path = subagentWorktreePath(baseDir, repoDir, "sub-1");
			expect(path).toBe(join(baseDir, hash, "sub-1"));
			expect(hash).toMatch(/^[0-9a-f]{9}$/);
		});

		it("defaults the base directory to <agentDir>/worktrees and expands ~ in overrides", () => {
			const previous = process.env[ENV_AGENT_DIR];
			process.env[ENV_AGENT_DIR] = join(tempDir, "agent");
			try {
				expect(subagentWorktreeBaseDir()).toBe(join(tempDir, "agent", "worktrees"));
				expect(subagentWorktreeBaseDir("  ")).toBe(join(tempDir, "agent", "worktrees"));
				expect(subagentWorktreeBaseDir("~/wt")).toBe(join(process.env.HOME ?? "", "wt"));
				expect(subagentWorktreeBaseDir(join(tempDir, "custom"))).toBe(join(tempDir, "custom"));
			} finally {
				if (previous === undefined) delete process.env[ENV_AGENT_DIR];
				else process.env[ENV_AGENT_DIR] = previous;
			}
		});

		it("resolves isolation requests per mode", () => {
			expect(resolveSubagentIsolation(undefined, "off")).toBe(false);
			expect(resolveSubagentIsolation(false, "off")).toBe(false);
			expect(() => resolveSubagentIsolation(true, "off")).toThrow(/isolated=True is disabled/);
			expect(resolveSubagentIsolation(undefined, "opt-in")).toBe(false);
			expect(resolveSubagentIsolation(true, "opt-in")).toBe(true);
			expect(resolveSubagentIsolation(false, "opt-in")).toBe(false);
			expect(resolveSubagentIsolation(undefined, "always")).toBe(true);
			expect(resolveSubagentIsolation(true, "always")).toBe(true);
			expect(resolveSubagentIsolation(false, "always")).toBe(false);
		});

		it("normalizes the isolated kwarg to a bool or undefined", () => {
			expect(normalizeRequestedRlmSubagentIsolation(undefined)).toBeUndefined();
			expect(normalizeRequestedRlmSubagentIsolation(null)).toBeUndefined();
			expect(normalizeRequestedRlmSubagentIsolation(true)).toBe(true);
			expect(normalizeRequestedRlmSubagentIsolation(false)).toBe(false);
			expect(() => normalizeRequestedRlmSubagentIsolation("yes")).toThrow(/isolated must be a bool/);
			expect(() => normalizeRequestedRlmSubagentIsolation(1)).toThrow(/isolated must be a bool/);
		});
	});

	describe("create + seed", () => {
		it("creates a detached linked worktree seeded with staged, unstaged and untracked changes", async () => {
			seedDirtyRepo(repoDir);
			const parentStatusBefore = git(["status", "--porcelain", "-z"], repoDir);
			const parentHead = git(["rev-parse", "HEAD"], repoDir);

			const handle = await create();

			expect(handle.repoRoot).toBe(repoDir);
			expect(handle.path).toBe(subagentWorktreePath(baseDir, repoDir, "sub-0badc0de"));
			expect(handle.headCommit).toBe(parentHead);
			expect(handle.seeded).toBe(true);
			expect(handle.seedNotices).toEqual([]);

			// Linked worktree sharing the parent's common git dir, detached HEAD.
			expect(statSync(join(handle.path, ".git")).isFile()).toBe(true);
			expect(realpathSync(findGitPaths(handle.path)!.commonGitDir)).toBe(join(repoDir, ".git"));
			expect(git(["rev-parse", "--abbrev-ref", "HEAD"], handle.path)).toBe("HEAD");
			expect(worktreeList(repoDir)).toContain(realpathSync(handle.path));

			// Dirty state mirrored; ignored files are not.
			expect(read(handle.path, "tracked.txt")).toBe("base\nstaged\n");
			expect(read(handle.path, "dir/nested.txt")).toBe("nested\nunstaged\n");
			expect(read(handle.path, "notes.md")).toBe("# notes\n");
			expect(existsSync(join(handle.path, "ignored.log"))).toBe(false);
			if (process.platform !== "win32") {
				expect(statSync(join(handle.path, "tools/run.sh")).mode & 0o111).not.toBe(0);
			}

			// Baseline commit swallowed the seed: worktree clean, baseline differs from parent HEAD.
			expect(git(["status", "--porcelain"], handle.path)).toBe("");
			expect(handle.baselineCommit).not.toBe(parentHead);
			expect(git(["rev-parse", "HEAD"], handle.path)).toBe(handle.baselineCommit);
			expect(git(["ls-tree", "-r", "--name-only", handle.baselineCommit], handle.path).split("\n")).toContain(
				"notes.md",
			);

			// Parent untouched: HEAD, branch, staged/unstaged state identical.
			expect(git(["rev-parse", "HEAD"], repoDir)).toBe(parentHead);
			expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir)).toBe("main");
			expect(git(["status", "--porcelain", "-z"], repoDir)).toBe(parentStatusBefore);

			// Owner marker written as a sibling file.
			expect(handle.ownerFile).toBe(`${handle.path}${SUBAGENT_WORKTREE_OWNER_SUFFIX}`);
			const owner = JSON.parse(readFileSync(handle.ownerFile, "utf8"));
			expect(owner).toMatchObject({
				version: 1,
				pid: process.pid,
				childId: "sub-0badc0de",
				parentSessionId: "parent-session",
				repoRoot: repoDir,
				worktreePath: handle.path,
			});
			expect(typeof owner.startedAt).toBe("string");
			expect(Number.isNaN(Date.parse(owner.startedAt))).toBe(false);
		});

		it("works from a subdirectory of the checkout", async () => {
			seedDirtyRepo(repoDir);
			const handle = await create({ cwd: join(repoDir, "dir") });
			expect(handle.repoRoot).toBe(repoDir);
			expect(read(handle.path, "dir/nested.txt")).toBe("nested\nunstaged\n");
		});

		it("skips seeding when seedDirty is false", async () => {
			seedDirtyRepo(repoDir);
			const handle = await create({ seedDirty: false });
			expect(handle.seeded).toBe(false);
			expect(read(handle.path, "tracked.txt")).toBe("base\n");
			expect(existsSync(join(handle.path, "notes.md"))).toBe(false);
			expect(git(["rev-parse", `${handle.baselineCommit}^{tree}`], handle.path)).toBe(
				git(["rev-parse", "HEAD^{tree}"], repoDir),
			);
		});

		it("skips nested repositories among untracked entries and reports them", async () => {
			seedDirtyRepo(repoDir);
			mkdirSync(join(repoDir, "vendor"), { recursive: true });
			initRepo(join(repoDir, "vendor"));
			write(repoDir, "vendor/lib.txt", "vendored\n");
			const handle = await create();
			expect(existsSync(join(handle.path, "vendor"))).toBe(false);
			expect(handle.seedNotices.some((notice) => notice.includes("vendor/"))).toBe(true);
			expect(read(handle.path, "notes.md")).toBe("# notes\n");
		});
	});

	describe("errors", () => {
		it("returns undefined / not-git for a directory outside any repository", async () => {
			const plain = join(tempDir, "plain");
			mkdirSync(plain);
			await expect(resolveGitRepoRoot(plain)).resolves.toBeUndefined();
			await expect(resolveGitRepoRoot(join(tempDir, "missing"))).resolves.toBeUndefined();
			const error = await createSubagentWorktree({ cwd: plain, childId: "sub-1", baseDir }).catch((e) => e);
			expect(error).toBeInstanceOf(SubagentWorktreeError);
			expect(error.stage).toBe("not-git");
			expect(error.message).toMatch(/not a git repository/);
			expect(existsSync(baseDir)).toBe(false);
		});

		it("rejects a repository without commits", async () => {
			initRepo(repoDir);
			write(repoDir, "a.txt", "a\n");
			const error = await createSubagentWorktree({ cwd: repoDir, childId: "sub-1", baseDir }).catch((e) => e);
			expect(error).toBeInstanceOf(SubagentWorktreeError);
			expect(error.stage).toBe("no-commits");
			expect(existsSync(baseDir)).toBe(false);
		});

		it("refuses to seed above maxSeedBytes and leaves nothing behind", async () => {
			seedDirtyRepo(repoDir);
			write(repoDir, "big.bin", Buffer.alloc(4096, 1));
			const error = await createSubagentWorktree({
				cwd: repoDir,
				childId: "sub-1",
				baseDir,
				maxSeedBytes: 1024,
			}).catch((e) => e);
			expect(error).toBeInstanceOf(SubagentWorktreeError);
			expect(error.stage).toBe("seed");
			expect(error.message).toMatch(/maxSeedBytes/);
			expect(error.message).toMatch(/1\.0 KiB seed limit/);
			expect(existsSync(baseDir)).toBe(false);
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir)]);
		});

		it("reports a git-stage error when the git binary cannot be executed", async () => {
			seedDirtyRepo(repoDir);
			const gitBinary = join(tempDir, "no-such-git");
			const error = await resolveGitRepoRoot(repoDir, { gitBinary }).catch((e) => e);
			expect(error).toBeInstanceOf(SubagentWorktreeError);
			expect(error.stage).toBe("git");
			const createError = await createSubagentWorktree({ cwd: repoDir, childId: "sub-1", baseDir, gitBinary }).catch(
				(e) => e,
			);
			expect(createError).toBeInstanceOf(SubagentWorktreeError);
			expect(createError.stage).toBe("git");
		});

		it("rejects a child id that would escape the bucket", async () => {
			seedDirtyRepo(repoDir);
			const error = await createSubagentWorktree({ cwd: repoDir, childId: "../evil", baseDir }).catch((e) => e);
			expect(error).toBeInstanceOf(SubagentWorktreeError);
			expect(error.stage).toBe("add");
		});
	});

	describe("delta capture and apply", () => {
		function editInWorktree(handle: SubagentWorktreeHandle): void {
			write(handle.path, "tracked.txt", "base\nstaged\nchild\n");
			write(handle.path, "new/child.txt", "hello from child\n");
			write(handle.path, "notes.md", "# notes\nchild appended\n");
			write(handle.path, "blob.bin", Buffer.from([0, 1, 2, 255, 254]));
			rmSync(join(handle.path, "remove-me.txt"));
			write(handle.path, "ignored.log", "child noise\n");
		}

		it("captures only the child's delta (parent WIP excluded) and applies it to the parent tree", async () => {
			seedDirtyRepo(repoDir);
			const handle = await create();
			editInWorktree(handle);

			const delta = await captureSubagentWorktreeDelta(handle);
			expect(delta.files).toEqual(["blob.bin", "new/child.txt", "notes.md", "remove-me.txt", "tracked.txt"]);
			const patchText = delta.patch.toString("utf8");
			expect(patchText).toContain("+child\n");
			expect(patchText).not.toContain("+staged\n");
			expect(patchText).not.toContain("+unstaged\n");
			expect(patchText).not.toContain("ignored.log");
			expect(patchText).toContain("GIT binary patch");

			const outcome = await completeSubagentWorktree(handle, { patchDir, merge: "patch-apply" });
			handles.splice(handles.indexOf(handle), 1);

			expect(outcome.captureError).toBeUndefined();
			expect(outcome.removeError).toBeUndefined();
			expect(outcome.files).toEqual(delta.files);
			expect(outcome.patchPath).toBe(join(patchDir, SUBAGENT_WORKTREE_PATCH_FILENAME));
			expect(readFileSync(outcome.patchPath!)).toEqual(delta.patch);
			expect(outcome.apply).toEqual({ status: "applied", files: delta.files });

			// Parent working tree now carries the child's changes on top of its own WIP.
			expect(read(repoDir, "tracked.txt")).toBe("base\nstaged\nchild\n");
			expect(read(repoDir, "new/child.txt")).toBe("hello from child\n");
			expect(read(repoDir, "notes.md")).toBe("# notes\nchild appended\n");
			expect(readFileSync(join(repoDir, "blob.bin"))).toEqual(Buffer.from([0, 1, 2, 255, 254]));
			expect(existsSync(join(repoDir, "remove-me.txt"))).toBe(false);
			expect(read(repoDir, "ignored.log")).toBe("noise\n");
			expect(read(repoDir, "dir/nested.txt")).toBe("nested\nunstaged\n");
			// Parent index untouched: only the pre-existing staged edit is in it.
			expect(git(["diff", "--cached", "--name-only"], repoDir)).toBe("tracked.txt");
			expect(git(["show", ":tracked.txt"], repoDir)).toBe("base\nstaged");
			expect(git(["rev-parse", "HEAD"], repoDir)).toBe(handle.headCommit);

			// Worktree and marker gone, git metadata pruned.
			expect(existsSync(handle.path)).toBe(false);
			expect(existsSync(handle.ownerFile)).toBe(false);
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir)]);
			expect(formatSubagentWorktreeOutcome(outcome)).toMatch(/^Isolated worktree: applied 5 files to /);
		});

		it("includes commits the child made inside the worktree", async () => {
			seedDirtyRepo(repoDir);
			const handle = await create();
			write(handle.path, "committed.txt", "child commit\n");
			git(["add", "committed.txt"], handle.path);
			git(["-c", "user.name=c", "-c", "user.email=c@c", "commit", "-q", "-m", "child work"], handle.path);
			write(handle.path, "after.txt", "after commit\n");
			const delta = await captureSubagentWorktreeDelta(handle);
			expect(delta.files).toEqual(["after.txt", "committed.txt"]);
			expect(git(["rev-parse", "HEAD"], repoDir)).toBe(handle.headCommit);
		});

		it("keeps the patch and leaves the parent untouched when git apply conflicts", async () => {
			seedDirtyRepo(repoDir);
			const handle = await create();
			write(handle.path, "tracked.txt", "base\nstaged\nchild\n");
			write(repoDir, "tracked.txt", "base\nstaged\nparent\n");
			const parentStatus = git(["status", "--porcelain", "-z"], repoDir);

			const outcome = await completeSubagentWorktree(handle, { patchDir, merge: "patch-apply" });
			handles.splice(handles.indexOf(handle), 1);

			expect(outcome.apply?.status).toBe("conflict");
			expect(outcome.apply?.error).toMatch(/tracked\.txt/);
			expect(outcome.files).toEqual(["tracked.txt"]);
			expect(existsSync(outcome.patchPath!)).toBe(true);
			expect(readFileSync(outcome.patchPath!, "utf8")).toContain("+child\n");
			expect(read(repoDir, "tracked.txt")).toBe("base\nstaged\nparent\n");
			expect(git(["status", "--porcelain", "-z"], repoDir)).toBe(parentStatus);
			expect(existsSync(handle.path)).toBe(false);
			const notice = formatSubagentWorktreeOutcome(outcome);
			expect(notice).toContain("NOT applied");
			expect(notice).toContain(outcome.patchPath!);
			expect(notice).toContain(`git apply ${outcome.patchPath}`);
		});

		it("treats a patch whose reverse applies as already applied", async () => {
			seedDirtyRepo(repoDir);
			const handle = await create();
			write(handle.path, "new/child.txt", "hello\n");
			write(handle.path, "tracked.txt", "base\nstaged\nchild\n");
			const delta = await captureSubagentWorktreeDelta(handle);
			await expect(applySubagentWorktreePatch(repoDir, delta.patch)).resolves.toEqual({
				status: "applied",
				files: ["new/child.txt", "tracked.txt"],
			});
			await expect(applySubagentWorktreePatch(repoDir, delta.patch)).resolves.toEqual({
				status: "already-applied",
				files: ["new/child.txt", "tracked.txt"],
			});
			expect(read(repoDir, "tracked.txt")).toBe("base\nstaged\nchild\n");
		});

		it("reports an empty delta and still writes the patch artifact", async () => {
			seedDirtyRepo(repoDir);
			const handle = await create();
			const outcome = await completeSubagentWorktree(handle, { patchDir, merge: "patch-apply" });
			handles.splice(handles.indexOf(handle), 1);
			expect(outcome.files).toEqual([]);
			expect(outcome.apply).toEqual({ status: "empty", files: [] });
			expect(statSync(outcome.patchPath!).size).toBe(0);
			expect(formatSubagentWorktreeOutcome(outcome)).toBe("Isolated worktree: no file changes.");
			expect(existsSync(handle.path)).toBe(false);
		});

		it("retains the patch without applying when merge is none or apply is disabled", async () => {
			seedDirtyRepo(repoDir);
			const first = await create({ childId: "sub-none" });
			write(first.path, "new/one.txt", "one\n");
			const none = await completeSubagentWorktree(first, { patchDir: join(patchDir, "none"), merge: "none" });
			handles.splice(handles.indexOf(first), 1);
			expect(none.apply).toBeUndefined();
			expect(none.files).toEqual(["new/one.txt"]);
			expect(existsSync(none.patchPath!)).toBe(true);
			expect(existsSync(join(repoDir, "new/one.txt"))).toBe(false);
			expect(formatSubagentWorktreeOutcome(none)).toMatch(/1 file changed; patch saved at .*\(not applied\)/);

			const second = await create({ childId: "sub-cancel" });
			write(second.path, "new/two.txt", "two\n");
			const cancelled = await completeSubagentWorktree(second, {
				patchDir: join(patchDir, "cancel"),
				merge: "patch-apply",
				apply: false,
			});
			handles.splice(handles.indexOf(second), 1);
			expect(cancelled.apply).toBeUndefined();
			expect(existsSync(cancelled.patchPath!)).toBe(true);
			expect(existsSync(join(repoDir, "new/two.txt"))).toBe(false);
			expect(existsSync(second.path)).toBe(false);
		});

		it("serializes concurrent applies for one repository", async () => {
			seedDirtyRepo(repoDir);
			const a = await create({ childId: "sub-a" });
			const b = await create({ childId: "sub-b" });
			write(a.path, "from-a.txt", "a\n");
			write(b.path, "from-b.txt", "b\n");
			const [deltaA, deltaB] = await Promise.all([captureSubagentWorktreeDelta(a), captureSubagentWorktreeDelta(b)]);
			const results = await Promise.all([
				applySubagentWorktreePatch(repoDir, deltaA.patch),
				applySubagentWorktreePatch(repoDir, deltaB.patch),
			]);
			expect(results.map((result) => result.status)).toEqual(["applied", "applied"]);
			expect(read(repoDir, "from-a.txt")).toBe("a\n");
			expect(read(repoDir, "from-b.txt")).toBe("b\n");
		});

		it("reports a capture failure when the worktree vanished", async () => {
			seedDirtyRepo(repoDir);
			const handle = await create();
			rmSync(handle.path, { recursive: true, force: true });
			const outcome = await completeSubagentWorktree(handle, { patchDir, merge: "patch-apply" });
			handles.splice(handles.indexOf(handle), 1);
			expect(outcome.captureError).toMatch(/worktree is missing/);
			expect(outcome.patchPath).toBeUndefined();
			expect(outcome.apply).toBeUndefined();
			expect(existsSync(handle.ownerFile)).toBe(false);
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir)]);
			expect(formatSubagentWorktreeOutcome(outcome)).toMatch(/failed to capture/);
		});
	});

	describe("remove and prune", () => {
		it("removes the worktree, marker and git metadata", async () => {
			seedDirtyRepo(repoDir);
			const handle = await create();
			await removeSubagentWorktree(handle);
			handles.splice(handles.indexOf(handle), 1);
			expect(existsSync(handle.path)).toBe(false);
			expect(existsSync(handle.ownerFile)).toBe(false);
			expect(existsSync(join(baseDir, createHash("sha1").update(repoDir).digest("hex").slice(0, 9)))).toBe(false);
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir)]);
			// Idempotent.
			await expect(removeSubagentWorktree(handle)).resolves.toBeUndefined();
		});

		it("prunes dead-pid markers, keeps live and marker-less entries unless --all", async () => {
			seedDirtyRepo(repoDir);
			const live = await create({ childId: "sub-live" });
			const dead = await create({ childId: "sub-dead" });
			const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid!;
			expect(deadPid).toBeGreaterThan(0);
			const marker = JSON.parse(readFileSync(dead.ownerFile, "utf8"));
			writeFileSync(dead.ownerFile, JSON.stringify({ ...marker, pid: deadPid }));
			const bucket = join(baseDir, createHash("sha1").update(repoDir).digest("hex").slice(0, 9));
			const orphan = join(bucket, "sub-orphan");
			mkdirSync(orphan);
			writeFileSync(join(bucket, `sub-gone${SUBAGENT_WORKTREE_OWNER_SUFFIX}`), JSON.stringify({ pid: deadPid }));
			writeFileSync(join(bucket, `sub-garbage${SUBAGENT_WORKTREE_OWNER_SUFFIX}`), "not json");

			const listed = await listSubagentWorktrees(baseDir);
			expect(listed.map((entry) => [entry.path.slice(bucket.length + 1), entry.state, entry.exists]).sort()).toEqual(
				[
					["sub-dead", "stale", true],
					["sub-garbage", "stale", false],
					["sub-gone", "stale", false],
					["sub-live", "live", true],
					["sub-orphan", "orphan", true],
				].sort(),
			);

			const dry = await pruneStaleWorktrees(baseDir, { dryRun: true });
			expect(dry.dryRun).toBe(true);
			expect(dry.removed.sort()).toEqual([
				join(bucket, "sub-dead"),
				join(bucket, "sub-garbage"),
				join(bucket, "sub-gone"),
			]);
			expect(dry.kept.sort()).toEqual([live.path, orphan]);
			expect(existsSync(dead.path)).toBe(true);

			const pruned = await pruneStaleWorktrees(baseDir);
			expect(pruned.failed).toEqual([]);
			expect(pruned.removed.sort()).toEqual(dry.removed.sort());
			expect(existsSync(dead.path)).toBe(false);
			expect(existsSync(dead.ownerFile)).toBe(false);
			expect(existsSync(join(bucket, `sub-gone${SUBAGENT_WORKTREE_OWNER_SUFFIX}`))).toBe(false);
			expect(existsSync(join(bucket, `sub-garbage${SUBAGENT_WORKTREE_OWNER_SUFFIX}`))).toBe(false);
			expect(existsSync(live.path)).toBe(true);
			expect(existsSync(live.ownerFile)).toBe(true);
			expect(existsSync(orphan)).toBe(true);
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir), realpathSync(live.path)]);
			handles.splice(handles.indexOf(dead), 1);

			const all = await pruneStaleWorktrees(baseDir, { all: true });
			expect(all.failed).toEqual([]);
			expect(all.removed.sort()).toEqual([live.path, orphan].sort());
			expect(existsSync(live.path)).toBe(false);
			expect(existsSync(orphan)).toBe(false);
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir)]);
			handles.splice(handles.indexOf(live), 1);
		});

		it("returns an empty result for a missing base directory", async () => {
			const result = await pruneStaleWorktrees(join(tempDir, "nope"));
			expect(result).toEqual({ dryRun: false, entries: [], removed: [], kept: [], failed: [] });
		});
	});
});
