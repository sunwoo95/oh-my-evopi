import { Container } from "@evopi/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { KernelCellTimeoutStatus, SetKernelCellTimeoutResult } from "../src/core/kernel-cell-timeout.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type Context = {
	agentConnection: {
		getKernelCellTimeoutStatus: () => Promise<KernelCellTimeoutStatus>;
		setKernelCellTimeoutMs: (
			timeoutMs: number,
			options?: { global?: boolean },
		) => Promise<SetKernelCellTimeoutResult>;
	};
	chatContainer: Container;
	ui: { requestRender: () => void };
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	addDimLine: (text: string) => void;
};

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { getText: () => string; setText: (text: string) => void };
	handleKernelCommand: (args: string) => Promise<void>;
	[key: string]: unknown;
};

type Prototype = {
	handleKernelCommand(this: Context, args: string): Promise<void>;
	addDimLine(this: Context, text: string): void;
	setupEditorSubmitHandler(this: SubmitContext): void;
};

const prototype = InteractiveMode.prototype as unknown as Prototype;
const USAGE = "Usage: /kernel [timeout <ms|Ns|Nm|Nh|off> [--global]]";

function renderAll(container: Container, width = 160): string {
	return container.children
		.flatMap((child) => child.render(width))
		.join("\n")
		.replace(/\[[0-9;]*m/g, "");
}

function makeContext(
	overrides: Partial<Context["agentConnection"]> = {},
	status: KernelCellTimeoutStatus = { timeoutMs: 30 * 60_000, source: "settings" },
): Context {
	return {
		agentConnection: {
			getKernelCellTimeoutStatus: vi.fn(async () => status),
			setKernelCellTimeoutMs: vi.fn(async (timeoutMs, options) => ({
				timeoutMs,
				source: "chat" as const,
				appliedToRunningCell: false,
				runningCellTooLate: false,
				globalSaved: options?.global === true,
			})),
			...overrides,
		},
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		showWarning: vi.fn(),
		showError: vi.fn(),
		addDimLine: prototype.addDimLine,
	};
}

describe("InteractiveMode /kernel", () => {
	beforeAll(() => initTheme("dark"));

	it("routes /kernel through the immediate handler and keeps later input intact", async () => {
		let editorText = "";
		let resolveCommand = () => {};
		const commandPending = new Promise<void>((resolve) => {
			resolveCommand = resolve;
		});
		const submitContext = {
			defaultEditor: {},
			editor: {
				getText: () => editorText,
				setText: (text: string) => {
					editorText = text;
				},
			},
			handleKernelCommand: vi.fn(() => commandPending),
			submittedInputBehavior: "steer",
			inputSubmissionGeneration: 0,
			inputSubmissionsPending: 0,
			pendingPromptStashReleases: [],
			promptStashState: {},
			clearShortcutGuide: vi.fn(),
		} as unknown as SubmitContext;
		prototype.setupEditorSubmitHandler.call(submitContext);

		const submission = submitContext.defaultEditor.onSubmit?.("/kernel timeout 5m");
		await vi.waitFor(() => expect(submitContext.handleKernelCommand).toHaveBeenCalledWith("timeout 5m"));
		editorText = "new draft";
		resolveCommand();
		await submission;

		expect(editorText).toBe("new draft");
	});

	it("shows the effective cap and its source for bare /kernel and /kernel timeout", async () => {
		const context = makeContext();
		await prototype.handleKernelCommand.call(context, "");
		await prototype.handleKernelCommand.call(context, "timeout");
		expect(context.agentConnection.getKernelCellTimeoutStatus).toHaveBeenCalledTimes(2);
		expect(context.agentConnection.setKernelCellTimeoutMs).not.toHaveBeenCalled();
		expect(renderAll(context.chatContainer)).toContain("Kernel cell timeout: 30m (settings)");
		expect(context.showWarning).not.toHaveBeenCalled();
	});

	it("includes the running cell's elapsed time in the status line", async () => {
		const context = makeContext(
			{},
			{
				timeoutMs: 30 * 60_000,
				source: "chat",
				activeCell: { elapsedMs: 120_000, timeoutMs: 30 * 60_000, timedOut: false },
			},
		);
		await prototype.handleKernelCommand.call(context, "");
		expect(renderAll(context.chatContainer)).toContain(
			"Kernel cell timeout: 30m (chat); running cell: 2m elapsed of 30m",
		);
	});

	it("warns when EVOPI_KERNEL_CELL_TIMEOUT_MS shadows the saved settings", async () => {
		const context = makeContext({}, { timeoutMs: 5_000, source: "chat", envTimeoutMs: 0 });
		await prototype.handleKernelCommand.call(context, "");
		expect(renderAll(context.chatContainer)).toContain("Kernel cell timeout: 5s (chat)");
		expect(context.showWarning).toHaveBeenCalledWith(
			"EVOPI_KERNEL_CELL_TIMEOUT_MS=off is set and shadows saved settings in new sessions",
		);
	});

	it("sets the cap with a duration suffix and --global, then echoes a dim one-liner", async () => {
		const context = makeContext();
		await prototype.handleKernelCommand.call(context, "timeout 2m --global");
		expect(context.agentConnection.setKernelCellTimeoutMs).toHaveBeenCalledWith(120_000, { global: true });
		expect(renderAll(context.chatContainer)).toContain("Kernel cell timeout set: 2m and saved as global default");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("tells the user when the running cell was re-armed or was already too late", async () => {
		const applied = makeContext({
			setKernelCellTimeoutMs: vi.fn(async () => ({
				timeoutMs: 0,
				source: "chat" as const,
				appliedToRunningCell: true,
				runningCellTooLate: false,
				globalSaved: false,
			})),
		});
		await prototype.handleKernelCommand.call(applied, "timeout off");
		expect(applied.agentConnection.setKernelCellTimeoutMs).toHaveBeenCalledWith(0, { global: false });
		expect(renderAll(applied.chatContainer)).toContain("Kernel cell timeout set: off (applied to the running cell)");

		const late = makeContext({
			setKernelCellTimeoutMs: vi.fn(async () => ({
				timeoutMs: 600_000,
				source: "chat" as const,
				appliedToRunningCell: false,
				runningCellTooLate: true,
				globalSaved: false,
			})),
		});
		await prototype.handleKernelCommand.call(late, "timeout 10m");
		expect(renderAll(late.chatContainer)).toContain(
			"Kernel cell timeout set: 10m (too late for the running cell — its cap already fired; applies to the next cell)",
		);
	});

	it("rejects unknown subcommands, bad durations and stray tokens with the usage line", async () => {
		const context = makeContext();
		await prototype.handleKernelCommand.call(context, "bogus");
		await prototype.handleKernelCommand.call(context, "timeout abc");
		await prototype.handleKernelCommand.call(context, "timeout 5m extra");
		await prototype.handleKernelCommand.call(context, "timeout -1");
		expect(context.showWarning).toHaveBeenCalledTimes(4);
		expect(context.showWarning).toHaveBeenCalledWith(USAGE);
		expect(context.agentConnection.setKernelCellTimeoutMs).not.toHaveBeenCalled();
		expect(context.agentConnection.getKernelCellTimeoutStatus).not.toHaveBeenCalled();
	});

	it("surfaces a global-save error without losing the successful chat update", async () => {
		const context = makeContext({
			setKernelCellTimeoutMs: vi.fn(async () => ({
				timeoutMs: 90_000,
				source: "chat" as const,
				appliedToRunningCell: false,
				runningCellTooLate: false,
				globalSaved: false,
				globalError: "disk full",
			})),
		});
		await prototype.handleKernelCommand.call(context, "timeout 90s --global");
		expect(renderAll(context.chatContainer)).toContain("Kernel cell timeout set: 1.5m");
		expect(context.showError).toHaveBeenCalledWith(
			"Kernel cell timeout set for this chat, but the global default was not saved: disk full",
		);
	});

	it("warns after a --global save that the env override will shadow it in new sessions", async () => {
		const context = makeContext({
			setKernelCellTimeoutMs: vi.fn(async () => ({
				timeoutMs: 90_000,
				source: "chat" as const,
				envTimeoutMs: 1_500,
				appliedToRunningCell: false,
				runningCellTooLate: false,
				globalSaved: true,
			})),
		});
		await prototype.handleKernelCommand.call(context, "timeout 90s --global");
		expect(context.showWarning).toHaveBeenCalledWith(
			"EVOPI_KERNEL_CELL_TIMEOUT_MS=1.5s is set and will shadow the saved default in new sessions",
		);
	});

	it("reports connection failures through showError", async () => {
		const context = makeContext({
			getKernelCellTimeoutStatus: vi.fn(async () => {
				throw new Error("daemon gone");
			}),
			setKernelCellTimeoutMs: vi.fn(async () => {
				throw new Error("daemon gone");
			}),
		});
		await prototype.handleKernelCommand.call(context, "");
		await prototype.handleKernelCommand.call(context, "timeout 1m");
		expect(context.showError).toHaveBeenCalledTimes(2);
		expect(context.showError).toHaveBeenCalledWith("daemon gone");
	});
});
