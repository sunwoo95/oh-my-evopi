/**
 * NS-D1 host wiring: `rlm.run(..., isolated=...)` through AgentSession.
 *
 * Uses a real git repository as the parent cwd (like git-update.test.ts) and a
 * stub runtime host that honors the requested child cwd, so the child's file
 * edits land inside the worktree and come back to the parent as a patch.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type AgentMessage, type StreamFn } from "@evopi/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, getModel } from "@evopi/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type RlmSubagentRuntimeCwdOptions } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager, type SubagentWorktreeSettings } from "../src/core/settings-manager.js";
import {
	SUBAGENT_WORKTREE_OWNER_SUFFIX,
	SUBAGENT_WORKTREE_PATCH_FILENAME,
	subagentWorktreeRepoHash,
} from "../src/core/subagent-worktree.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function initRepo(repoDir: string): void {
	mkdirSync(repoDir, { recursive: true });
	git(["init", "-q", "--initial-branch=main"], repoDir);
	git(["config", "--local", "user.email", "test@test.com"], repoDir);
	git(["config", "--local", "user.name", "Test"], repoDir);
	git(["config", "--local", "commit.gpgsign", "false"], repoDir);
	writeFileSync(join(repoDir, "tracked.txt"), "base\n");
	writeFileSync(join(repoDir, "remove-me.txt"), "bye\n");
	git(["add", "-A"], repoDir);
	git(["commit", "-q", "-m", "base"], repoDir);
	// Parent WIP that must be visible to the child but never in the captured patch.
	writeFileSync(join(repoDir, "tracked.txt"), "base\nparent wip\n");
}

function worktreeList(repoDir: string): string[] {
	return git(["worktree", "list", "--porcelain"], repoDir)
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => realpathSync(line.slice("worktree ".length)));
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 7,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function answer(text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage(text) }));
	return stream;
}

interface InspectableRun {
	id: string;
	status: string;
	settlement: { promise: Promise<void> };
	session?: AgentSession;
	worktree?: { path: string; repoRoot: string };
}

interface Inspectable {
	_activeRlmChildRuns: Map<string, InspectableRun>;
	_rlmChildSessions: Map<string, unknown>;
	_runWorktreeSlashCommand(
		options: { kind: "list" } | { kind: "prune"; all: boolean; dryRun: boolean },
	): Promise<string>;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await sleep(10);
	}
}

describe("subagent worktree wiring (NS-D1)", () => {
	let tempDir: string;
	let repoDir: string;
	let baseDir: string;
	let agentDir: string;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "evopi-worktree-wiring-")));
		repoDir = join(tempDir, "repo");
		baseDir = join(tempDir, "worktrees");
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		initRepo(repoDir);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.disposeAsync().catch(() => undefined);
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function buildSession(options: {
		cwd: string;
		sessionDir?: string;
		depth?: number;
		streamFn?: StreamFn;
		worktree?: SubagentWorktreeSettings;
		subagentRuntimeHost?: SubagentRuntimeHost;
	}): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, `auth-${sessions.length}.json`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settingsManager = SettingsManager.create(options.cwd, agentDir);
		if (options.worktree) {
			settingsManager.applyOverrides({ subagent: { worktree: { base: baseDir, ...options.worktree } } });
		}
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: options.streamFn ?? (() => answer("done")),
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(options.cwd, options.sessionDir ?? join(tempDir, "sessions")),
			settingsManager,
			cwd: options.cwd,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, `models-${sessions.length}.json`)),
			resourceLoader: createTestResourceLoader(),
			subagentRuntimeHost: options.subagentRuntimeHost,
			rlmDepth: options.depth,
			rlmSessionDir: options.sessionDir,
		});
		sessions.push(session);
		return session;
	}

	/** Stub host that creates the child where the parent asked (or the parent's cwd). */
	function honoringHost(
		record: { options?: RlmSubagentRuntimeCwdOptions },
		childStream: (cwd: string) => StreamFn,
		behavior: { ignoreCwd?: boolean } = {},
	): SubagentRuntimeHost {
		return {
			createRlmSubagentRuntime: async (options) => {
				record.options = options as RlmSubagentRuntimeCwdOptions;
				const parentCwd = options.parentSession.sessionManager.getCwd();
				const cwd = behavior.ignoreCwd ? parentCwd : ((options as RlmSubagentRuntimeCwdOptions).cwd ?? parentCwd);
				const child = buildSession({
					cwd,
					sessionDir: options.sessionDir,
					depth: options.rlmDepth,
					streamFn: childStream(cwd),
				});
				options.onSessionPublished?.(child);
				return { session: child };
			},
			deleteRlmSubagentRuntime: async (_childId, session) => {
				await session?.disposeAsync();
			},
		};
	}

	function terminalNotices(session: AgentSession): AgentMessage[] {
		return session.messages.filter(
			(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
		);
	}

	const editingChild =
		(cwd: string): StreamFn =>
		() => {
			mkdirSync(join(cwd, "new"), { recursive: true });
			writeFileSync(join(cwd, "new", "child.txt"), "hello from child\n");
			writeFileSync(join(cwd, "tracked.txt"), `${readFileSync(join(cwd, "tracked.txt"), "utf8")}child\n`);
			rmSync(join(cwd, "remove-me.txt"));
			return answer("edited");
		};

	describe("mode off (default)", () => {
		it("rejects isolated=True with a hint, rejects non-bool, and keeps the default spawn byte-identical", async () => {
			const record: { options?: RlmSubagentRuntimeCwdOptions } = {};
			const root = buildSession({
				cwd: repoDir,
				subagentRuntimeHost: honoringHost(record, () => () => answer("ok")),
			});
			await expect(root.runRlmChild("task", { isolated: true })).rejects.toThrow(
				/isolated=True is disabled: set subagent\.worktree\.mode to "opt-in" or "always"/,
			);
			await expect(root.runRlmChild("task", { isolated: "yes" })).rejects.toThrow(/isolated must be a bool/);
			await expect(root.runRlmChild("task", { temperature: 1 })).rejects.toThrow(
				"Unsupported rlm.run kwargs: temperature",
			);

			const handle = await root.runRlmChild("task", { isolated: false });
			expect(handle).not.toHaveProperty("worktree");
			expect(Object.keys(handle).sort()).toEqual(["model", "name", "rlm_child_id", "session_dir"]);
			const run = (root as unknown as Inspectable)._activeRlmChildRuns.get(handle.rlm_child_id)!;
			await run.settlement.promise;
			expect(record.options).toBeDefined();
			expect(record.options).not.toHaveProperty("cwd");
			expect(record.options).not.toHaveProperty("worktree");
			expect(root.startupSubagentWorktreePrune).toBeUndefined();
			expect(existsSync(baseDir)).toBe(false);
			// Shared-cwd children are retained as before.
			expect(root.getRlmChildSession(handle.rlm_child_id)).toBeDefined();
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir)]);
		});
	});

	describe("mode opt-in", () => {
		it("runs the child in a seeded worktree, applies its patch to the parent, removes the worktree and notifies", async () => {
			const record: { options?: RlmSubagentRuntimeCwdOptions } = {};
			const root = buildSession({
				cwd: repoDir,
				worktree: { mode: "opt-in" },
				subagentRuntimeHost: honoringHost(record, editingChild),
			});
			const parentStatusBefore = git(["status", "--porcelain", "-z"], repoDir);

			const handle = await root.runRlmChild("edit files", { isolated: true, name: "isolated-worker" });
			const expectedPath = join(baseDir, subagentWorktreeRepoHash(repoDir), handle.rlm_child_id);
			expect(handle.worktree).toBe(expectedPath);
			const run = (root as unknown as Inspectable)._activeRlmChildRuns.get(handle.rlm_child_id)!;
			expect(run.worktree?.path).toBe(expectedPath);
			await run.settlement.promise;

			// Host received the worktree cwd and the child was created there.
			expect(record.options?.cwd).toBe(expectedPath);
			expect(record.options?.worktree).toEqual({ path: expectedPath, repoRoot: repoDir });
			expect(record.options?.cwd).not.toBe(repoDir);

			// Parent tree carries the child's delta on top of its own WIP; index untouched.
			expect(readFileSync(join(repoDir, "new", "child.txt"), "utf8")).toBe("hello from child\n");
			expect(readFileSync(join(repoDir, "tracked.txt"), "utf8")).toBe("base\nparent wip\nchild\n");
			expect(existsSync(join(repoDir, "remove-me.txt"))).toBe(false);
			expect(git(["diff", "--cached", "--name-only"], repoDir)).toBe("");
			expect(git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir)).toBe("main");
			expect(git(["status", "--porcelain", "-z"], repoDir)).not.toBe(parentStatusBefore);

			// Patch artifact in the child session dir; worktree, marker and git metadata gone.
			const patchPath = join(handle.session_dir, SUBAGENT_WORKTREE_PATCH_FILENAME);
			expect(readFileSync(patchPath, "utf8")).toContain("+child\n");
			expect(readFileSync(patchPath, "utf8")).not.toContain("+parent wip\n");
			expect(existsSync(expectedPath)).toBe(false);
			expect(existsSync(`${expectedPath}${SUBAGENT_WORKTREE_OWNER_SUFFIX}`)).toBe(false);
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir)]);

			// Isolated children are closed, not retained, and disappear from tracking.
			expect(root.getRlmChildSession(handle.rlm_child_id)).toBeUndefined();
			expect((root as unknown as Inspectable)._rlmChildSessions.size).toBe(0);
			expect((root as unknown as Inspectable)._activeRlmChildRuns.has(handle.rlm_child_id)).toBe(false);

			await vi.waitFor(() => {
				const notices = terminalNotices(root);
				expect(notices.map((message) => (message as { details: { kind: string } }).details.kind)).toEqual([
					"completed_without_reply",
					"worktree",
				]);
				expect(notices[1]).toMatchObject({
					content: expect.stringContaining(
						`RLM child isolated-worker (${handle.rlm_child_id}) ran in an isolated worktree and was closed`,
					),
					details: {
						kind: "worktree",
						worktreePath: expectedPath,
						repoRoot: repoDir,
						patchPath,
						files: ["new/child.txt", "remove-me.txt", "tracked.txt"],
						applyStatus: "applied",
					},
				});
				expect((notices[1] as { content: string }).content).toContain("applied 3 files to");
				expect((notices[1] as { content: string }).content).toContain("not resumable");
			});
		});

		it("tells the child where it runs and that the session closes afterwards", async () => {
			const seen: string[] = [];
			const root = buildSession({
				cwd: repoDir,
				worktree: { mode: "opt-in" },
				subagentRuntimeHost: honoringHost({}, () => (_model, context) => {
					const last = context.messages[context.messages.length - 1] as
						| { content: string | Array<{ type: string; text?: string }> }
						| undefined;
					if (typeof last?.content === "string") seen.push(last.content);
					else if (Array.isArray(last?.content)) {
						seen.push(last.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join(""));
					}
					return answer("ok");
				}),
			});
			const handle = await root.runRlmChild("do the thing", { isolated: true });
			await (root as unknown as Inspectable)._activeRlmChildRuns.get(handle.rlm_child_id)!.settlement.promise;
			expect(seen).toHaveLength(1);
			expect(seen[0]).toMatch(
				/^\[task from parent\]\n\ndo the thing\n\n\[isolation\] You are working in an isolated git worktree at /,
			);
			expect(seen[0]).toContain(handle.worktree!);
			expect(seen[0]).toContain(`detached checkout of ${repoDir}`);
			expect(seen[0]).toContain("cannot be resumed");
		});

		it("uses the inline host: the child session's cwd is the worktree and the parent cwd is untouched", async () => {
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let started = false;
			const root = buildSession({
				cwd: repoDir,
				worktree: { mode: "opt-in" },
				streamFn: () => {
					const stream = createAssistantMessageEventStream();
					started = true;
					void gate.then(() => stream.push({ type: "done", reason: "stop", message: assistantMessage("late") }));
					return stream;
				},
			});
			const handle = await root.runRlmChild("inline", { isolated: true });
			await waitFor(() => started);
			const run = (root as unknown as Inspectable)._activeRlmChildRuns.get(handle.rlm_child_id)!;
			expect(run.session?.sessionManager.getCwd()).toBe(handle.worktree);
			expect(existsSync(join(handle.worktree!, "tracked.txt"))).toBe(true);
			expect(readFileSync(join(handle.worktree!, "tracked.txt"), "utf8")).toBe("base\nparent wip\n");
			expect(root.sessionManager.getCwd()).toBe(repoDir);
			release();
			await run.settlement.promise;
			expect(existsSync(handle.worktree!)).toBe(false);
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir)]);
		});

		it("does not isolate without the kwarg and rejects isolated=True outside a git checkout", async () => {
			const record: { options?: RlmSubagentRuntimeCwdOptions } = {};
			const root = buildSession({
				cwd: repoDir,
				worktree: { mode: "opt-in" },
				subagentRuntimeHost: honoringHost(record, () => () => answer("ok")),
			});
			const handle = await root.runRlmChild("plain");
			expect(handle).not.toHaveProperty("worktree");
			await (root as unknown as Inspectable)._activeRlmChildRuns.get(handle.rlm_child_id)!.settlement.promise;
			expect(record.options).not.toHaveProperty("cwd");

			const plain = join(tempDir, "plain");
			mkdirSync(plain);
			const outside = buildSession({ cwd: plain, worktree: { mode: "opt-in" } });
			await expect(outside.runRlmChild("task", { isolated: true })).rejects.toThrow(
				/isolated=True cannot isolate the child: cwd is not inside a git repository/,
			);
		});

		it("keeps the patch without applying it when merge is none", async () => {
			const root = buildSession({
				cwd: repoDir,
				worktree: { mode: "opt-in", merge: "none" },
				subagentRuntimeHost: honoringHost({}, editingChild),
			});
			const handle = await root.runRlmChild("edit", { isolated: true, name: "keep-only" });
			await (root as unknown as Inspectable)._activeRlmChildRuns.get(handle.rlm_child_id)!.settlement.promise;
			expect(existsSync(join(repoDir, "new", "child.txt"))).toBe(false);
			expect(existsSync(join(repoDir, "remove-me.txt"))).toBe(true);
			expect(readFileSync(join(handle.session_dir, SUBAGENT_WORKTREE_PATCH_FILENAME), "utf8")).toContain(
				"hello from child",
			);
			expect(existsSync(handle.worktree!)).toBe(false);
			await vi.waitFor(() => {
				const notice = terminalNotices(root).find(
					(message) => (message as { details: { kind: string } }).details.kind === "worktree",
				) as { content: string; details: Record<string, unknown> } | undefined;
				expect(notice?.content).toMatch(/3 files changed; patch saved at .*\(not applied\)/);
				expect(notice?.details).not.toHaveProperty("applyStatus");
			});
		});

		it("retains the patch and leaves the parent untouched when the child is cancelled", async () => {
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let started = false;
			const root = buildSession({
				cwd: repoDir,
				worktree: { mode: "opt-in" },
				subagentRuntimeHost: honoringHost({}, (cwd) => () => {
					writeFileSync(join(cwd, "partial.txt"), "half done\n");
					started = true;
					const stream = createAssistantMessageEventStream();
					void gate.then(() => stream.push({ type: "done", reason: "stop", message: assistantMessage("late") }));
					return stream;
				}),
			});
			const parentStatus = git(["status", "--porcelain", "-z"], repoDir);
			const handle = await root.runRlmChild("slow", { isolated: true, name: "cancel-me" });
			await waitFor(() => started);
			const run = (root as unknown as Inspectable)._activeRlmChildRuns.get(handle.rlm_child_id)!;
			expect(root.cancelRlmChildRun(handle.rlm_child_id)).toBe(true);
			release();
			await run.settlement.promise;

			expect(existsSync(join(repoDir, "partial.txt"))).toBe(false);
			expect(git(["status", "--porcelain", "-z"], repoDir)).toBe(parentStatus);
			expect(readFileSync(join(handle.session_dir, SUBAGENT_WORKTREE_PATCH_FILENAME), "utf8")).toContain(
				"+half done",
			);
			expect(existsSync(handle.worktree!)).toBe(false);
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir)]);
			await vi.waitFor(() => {
				const kinds = terminalNotices(root).map(
					(message) => (message as { details: { kind: string } }).details.kind,
				);
				expect(kinds).toEqual(["cancelled", "worktree"]);
			});
			const worktreeNotice = terminalNotices(root)[1] as { content: string };
			expect(worktreeNotice.content).toMatch(/1 file changed; patch saved at .*\(not applied\)/);
		});

		it("removes the worktree without notices when the child is explicitly deleted mid-run", async () => {
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let started = false;
			const root = buildSession({
				cwd: repoDir,
				worktree: { mode: "opt-in" },
				subagentRuntimeHost: honoringHost({}, () => () => {
					started = true;
					const stream = createAssistantMessageEventStream();
					void gate.then(() => stream.push({ type: "done", reason: "stop", message: assistantMessage("late") }));
					return stream;
				}),
			});
			const handle = await root.runRlmChild("slow", { isolated: true, name: "delete-me" });
			await waitFor(() => started);
			const run = (root as unknown as Inspectable)._activeRlmChildRuns.get(handle.rlm_child_id)!;
			await expect(root.deleteRlmSubagent("delete-me")).resolves.toMatchObject({
				subagent: { rlm_child_id: handle.rlm_child_id, session_name: "delete-me" },
			});
			release();
			await run.settlement.promise;
			expect(existsSync(handle.worktree!)).toBe(false);
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir)]);
			expect(existsSync(join(handle.session_dir, SUBAGENT_WORKTREE_PATCH_FILENAME))).toBe(true);
			await sleep(20);
			expect(
				terminalNotices(root).filter((m) => (m as { details: { kind: string } }).details.kind === "worktree"),
			).toEqual([]);
		});

		it("fails the run and removes the worktree when the host ignores the requested cwd", async () => {
			const root = buildSession({
				cwd: repoDir,
				worktree: { mode: "opt-in" },
				subagentRuntimeHost: honoringHost({}, () => () => answer("ok"), { ignoreCwd: true }),
			});
			const handle = await root.runRlmChild("task", { isolated: true, name: "misplaced" });
			const run = (root as unknown as Inspectable)._activeRlmChildRuns.get(handle.rlm_child_id)!;
			await run.settlement.promise;
			expect(run.status).toBe("error");
			expect(existsSync(handle.worktree!)).toBe(false);
			expect(worktreeList(repoDir)).toEqual([realpathSync(repoDir)]);
			await vi.waitFor(() => {
				const failure = root.messages.find(
					(message) => message.role === "custom" && message.customType === "rlm_child_failure",
				) as { content: string } | undefined;
				expect(failure?.content).toContain("the subagent runtime host must honor the requested cwd");
			});
		});
	});

	describe("mode always", () => {
		it("isolates by default, honors isolated=False, and falls back with a notice outside git", async () => {
			const record: { options?: RlmSubagentRuntimeCwdOptions } = {};
			const root = buildSession({
				cwd: repoDir,
				worktree: { mode: "always" },
				subagentRuntimeHost: honoringHost(record, () => () => answer("ok")),
			});
			const isolated = await root.runRlmChild("implicit");
			expect(isolated.worktree).toBe(join(baseDir, subagentWorktreeRepoHash(repoDir), isolated.rlm_child_id));
			await (root as unknown as Inspectable)._activeRlmChildRuns.get(isolated.rlm_child_id)!.settlement.promise;
			expect(record.options?.cwd).toBe(isolated.worktree);

			const shared = await root.runRlmChild("explicit opt-out", { isolated: false });
			expect(shared).not.toHaveProperty("worktree");
			await (root as unknown as Inspectable)._activeRlmChildRuns.get(shared.rlm_child_id)!.settlement.promise;
			expect(record.options).not.toHaveProperty("cwd");

			const plain = join(tempDir, "plain");
			mkdirSync(plain);
			const fallbackRecord: { options?: RlmSubagentRuntimeCwdOptions } = {};
			const outside = buildSession({
				cwd: plain,
				worktree: { mode: "always" },
				subagentRuntimeHost: honoringHost(fallbackRecord, () => () => answer("ok")),
			});
			const fallback = await outside.runRlmChild("no git here", { name: "fallback-worker" });
			expect(fallback).not.toHaveProperty("worktree");
			await (outside as unknown as Inspectable)._activeRlmChildRuns.get(fallback.rlm_child_id)!.settlement.promise;
			expect(fallbackRecord.options).not.toHaveProperty("cwd");
			await vi.waitFor(() => {
				const notice = terminalNotices(outside).find(
					(message) => (message as { details: { kind: string } }).details.kind === "isolation_fallback",
				) as { content: string; details: Record<string, unknown> } | undefined;
				expect(notice?.content).toContain(
					`RLM child fallback-worker (${fallback.rlm_child_id}) could not be isolated (cwd is not inside a git repository: ${plain})`,
				);
				expect(notice?.details).toMatchObject({ childId: fallback.rlm_child_id, sessionName: "fallback-worker" });
			});
		});
	});

	describe("startup prune and /worktree", () => {
		function plantStaleWorktree(childId: string): { path: string; ownerFile: string } {
			const bucket = join(baseDir, subagentWorktreeRepoHash(repoDir));
			const path = join(bucket, childId);
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "leftover.txt"), "x\n");
			const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid!;
			const ownerFile = `${path}${SUBAGENT_WORKTREE_OWNER_SUFFIX}`;
			writeFileSync(
				ownerFile,
				JSON.stringify({
					version: 1,
					pid: deadPid,
					startedAt: new Date().toISOString(),
					childId,
					repoRoot: repoDir,
					worktreePath: path,
				}),
			);
			return { path, ownerFile };
		}

		it("prunes dead-pid worktrees when a depth-0 session starts with isolation enabled, not for children or mode off", async () => {
			const stale = plantStaleWorktree("sub-stale0001");
			const off = buildSession({ cwd: repoDir });
			expect(off.startupSubagentWorktreePrune).toBeUndefined();
			expect(existsSync(stale.path)).toBe(true);

			const child = buildSession({ cwd: repoDir, depth: 1, worktree: { mode: "opt-in" } });
			expect(child.startupSubagentWorktreePrune).toBeUndefined();

			const root = buildSession({ cwd: repoDir, worktree: { mode: "opt-in" } });
			const result = await root.startupSubagentWorktreePrune;
			expect(result?.removed).toEqual([stale.path]);
			expect(existsSync(stale.path)).toBe(false);
			expect(existsSync(stale.ownerFile)).toBe(false);
		});

		it("lists and prunes through the /worktree session command", async () => {
			const root = buildSession({ cwd: repoDir, worktree: { mode: "opt-in" } });
			await root.startupSubagentWorktreePrune;
			const internals = root as unknown as Inspectable;
			expect(await internals._runWorktreeSlashCommand({ kind: "list" })).toBe(
				`No subagent worktrees under ${baseDir} (subagent.worktree.mode: opt-in).`,
			);

			const stale = plantStaleWorktree("sub-stale0002");
			const listing = await internals._runWorktreeSlashCommand({ kind: "list" });
			expect(listing).toContain("1 total: 0 live, 1 stale, 0 orphan");
			expect(listing).toContain(`stale  ${stale.path} (pid `);
			expect(listing).toContain(`repo ${repoDir}`);

			const dry = await internals._runWorktreeSlashCommand({ kind: "prune", all: false, dryRun: true });
			expect(dry).toContain(`Would remove 1 worktree under ${baseDir}; kept 0.`);
			expect(dry).toContain(`would remove ${stale.path}`);
			expect(existsSync(stale.path)).toBe(true);

			const pruned = await internals._runWorktreeSlashCommand({ kind: "prune", all: false, dryRun: false });
			expect(pruned).toContain(`Removed 1 worktree under ${baseDir}; kept 0.`);
			expect(existsSync(stale.path)).toBe(false);

			// The command is queued like /compact and records a durable result row.
			await root.promptAndWait("/worktree list");
			const result = root.messages.find(
				(message) => message.role === "custom" && message.customType === "session_slash_command_result",
			) as { content: string; details: { command: { name: string }; success: boolean } } | undefined;
			expect(result?.details.command.name).toBe("worktree");
			expect(result?.details.success).toBe(true);
			expect(result?.content).toBe(`No subagent worktrees under ${baseDir} (subagent.worktree.mode: opt-in).`);
		});
	});
});
