import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import type { ExecuteResult, KernelClient } from "../src/core/kernel/index.js";
import { createIpythonToolDefinition, type IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

/** Tool-call context is only consulted for UI notifications; these cases run without one. */
const NO_CTX = undefined as unknown as ExtensionContext;

const WARNING_NOTE =
	"[note: this cell used 87% of its 1.5s wall-clock cap (kernel.cellTimeoutMs). Split long work into smaller cells or run it in the background before the cap is hit.]";

function okResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
	return { stdout: "ok", stderr: "", status: "ok", durationMs: 1, ...overrides };
}

function fakeProvisioner(execute: KernelClient["execute"]): {
	provisioner: IpythonKernelProvisioner;
	execute: typeof execute;
} {
	const manager = { execute } as unknown as KernelClient;
	const provisioner = {
		ensure: vi.fn(async () => manager),
		kill: vi.fn(async () => {}),
	} as unknown as IpythonKernelProvisioner;
	return { provisioner, execute };
}

function uiContext(options: { throwOnNotify?: boolean } = {}): {
	ctx: ExtensionContext;
	notify: ReturnType<typeof vi.fn>;
} {
	const notify = vi.fn(() => {
		if (options.throwOnNotify) throw new Error("stale UI");
	});
	const ctx = {
		hasUI: true,
		ui: { notify, setWorkingMessage: vi.fn(), select: vi.fn() },
	} as unknown as ExtensionContext;
	return { ctx, notify };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

/** A kernel whose cell crosses the 80% point (1.2s of 1.5s) and then finishes fine. */
function warningExecute(): KernelClient["execute"] {
	return vi.fn<KernelClient["execute"]>(async (_code, opts) => {
		opts?.onTimeoutWarning?.({ elapsedMs: 1_200, timeoutMs: 1_500, remainingMs: 300 });
		return okResult({ durationMs: 1_300 });
	});
}

describe("ipython tool cell timeout UX (A4)", () => {
	it("passes the per-cell cap and a warning hook to the kernel", async () => {
		const { provisioner, execute } = fakeProvisioner(vi.fn<KernelClient["execute"]>(async () => okResult()));
		const tool = createIpythonToolDefinition("/tmp", { provisioner, cellTimeoutMs: () => 1_500 });

		await tool.execute("call-1", { code: "x = 1" }, undefined, undefined, NO_CTX);

		expect(execute).toHaveBeenCalledWith(
			"x = 1",
			expect.objectContaining({ timeoutMs: 1_500, onTimeoutWarning: expect.any(Function) }),
		);
	});

	it("passes no cap when the configured value is 0 or absent", async () => {
		const { provisioner, execute } = fakeProvisioner(vi.fn<KernelClient["execute"]>(async () => okResult()));
		const off = createIpythonToolDefinition("/tmp", { provisioner, cellTimeoutMs: 0 });
		await off.execute("call-1", { code: "x = 1" }, undefined, undefined, NO_CTX);
		const unset = createIpythonToolDefinition("/tmp", { provisioner });
		await unset.execute("call-2", { code: "x = 2" }, undefined, undefined, NO_CTX);

		expect(execute).toHaveBeenNthCalledWith(1, "x = 1", expect.objectContaining({ timeoutMs: undefined }));
		expect(execute).toHaveBeenNthCalledWith(2, "x = 2", expect.objectContaining({ timeoutMs: undefined }));
	});

	it("re-reads a function cap for every cell so /kernel timeout reaches the next cell", async () => {
		const { provisioner, execute } = fakeProvisioner(vi.fn<KernelClient["execute"]>(async () => okResult()));
		let cap = 1_000;
		const tool = createIpythonToolDefinition("/tmp", { provisioner, cellTimeoutMs: () => cap });

		await tool.execute("call-1", { code: "a" }, undefined, undefined, NO_CTX);
		cap = 0;
		await tool.execute("call-2", { code: "b" }, undefined, undefined, NO_CTX);
		cap = 2_000;
		await tool.execute("call-3", { code: "c" }, undefined, undefined, NO_CTX);

		expect(execute).toHaveBeenNthCalledWith(1, "a", expect.objectContaining({ timeoutMs: 1_000 }));
		expect(execute).toHaveBeenNthCalledWith(2, "b", expect.objectContaining({ timeoutMs: undefined }));
		expect(execute).toHaveBeenNthCalledWith(3, "c", expect.objectContaining({ timeoutMs: 2_000 }));
	});

	it("streams the 80% warning, notifies the UI once and appends the model-facing note", async () => {
		const { provisioner } = fakeProvisioner(warningExecute());
		const { ctx, notify } = uiContext();
		const onUpdate = vi.fn();
		const tool = createIpythonToolDefinition("/tmp", { provisioner, cellTimeoutMs: 1_500 });

		const result = await tool.execute("call-1", { code: "slow()" }, undefined, onUpdate, ctx);

		expect(onUpdate).toHaveBeenCalledWith({
			content: [{ type: "text", text: "[cell has used 80% of its 1.5s cap — 300ms left]" }],
			details: { status: "ok", timeoutMs: 1_500, timeoutWarned: true },
		});
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			"Python cell at 80% of its 1.5s cap (300ms left). /kernel timeout <ms|Nm|off> extends it",
			"warning",
		);
		expect(textOf(result)).toBe(`ok\n${WARNING_NOTE}`);
		expect(result.details.status).toBe("ok");
		expect(result.details).toMatchObject({ status: "ok", timeoutMs: 1_500, timeoutWarned: true });
		expect(result.details.timedOut).toBeUndefined();
	});

	it("keeps output and details byte-identical when the cell never crosses the warning point", async () => {
		const { provisioner } = fakeProvisioner(vi.fn<KernelClient["execute"]>(async () => okResult()));
		const { ctx, notify } = uiContext();
		const onUpdate = vi.fn();
		const tool = createIpythonToolDefinition("/tmp", { provisioner, cellTimeoutMs: 1_500 });

		const result = await tool.execute("call-1", { code: "x = 1" }, undefined, onUpdate, ctx);

		expect(textOf(result)).toBe("ok");
		expect(onUpdate).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect("timeoutMs" in result.details).toBe(false);
		expect("timeoutWarned" in result.details).toBe(false);
		expect("timedOut" in result.details).toBe(false);
	});

	it("notifies a clean timeout interrupt as a warning without adding a second note", async () => {
		const stderr = "[cell exceeded 1500 ms and was interrupted]";
		const { provisioner } = fakeProvisioner(
			vi.fn<KernelClient["execute"]>(async (_code, opts) => {
				opts?.onTimeoutWarning?.({ elapsedMs: 1_200, timeoutMs: 1_500, remainingMs: 300 });
				return okResult({
					stdout: "",
					stderr,
					status: "error",
					durationMs: 1_500,
					error: { ename: "KernelCellTimeout", evalue: "cell exceeded 1500 ms", traceback: [] },
					timedOut: { timeoutMs: 1_500, kernelRestarted: false },
				});
			}),
		);
		const { ctx, notify } = uiContext();
		const tool = createIpythonToolDefinition("/tmp", { provisioner, cellTimeoutMs: 1_500 });

		const result = await tool.execute("call-1", { code: "loop()" }, undefined, undefined, ctx);

		// Pre-existing shape: stderr plus the (empty) traceback join; no A4 note is added.
		expect(textOf(result)).toBe(`${stderr}\n`);
		expect(result.details.status).toBe("error");
		expect(result.details).toMatchObject({
			errorEname: "KernelCellTimeout",
			timeoutMs: 1_500,
			timeoutWarned: true,
			timedOut: { timeoutMs: 1_500, kernelRestarted: false },
		});
		// One warning at 80%, then the timeout itself.
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenLastCalledWith("Python cell exceeded its 1.5s cap and was interrupted", "warning");
	});

	it("notifies a timeout that had to restart the kernel as an error", async () => {
		const { provisioner } = fakeProvisioner(
			vi.fn<KernelClient["execute"]>(async () =>
				okResult({
					stdout: "",
					stderr:
						"[cell exceeded 1500 ms and did not stop on interrupt; kernel restarted — variables revert to the last snapshot]",
					status: "error",
					durationMs: 2_500,
					error: { ename: "KernelCellTimeout", evalue: "cell exceeded 1500 ms", traceback: [] },
					timedOut: { timeoutMs: 1_500, kernelRestarted: true },
				}),
			),
		);
		const { ctx, notify } = uiContext();
		const tool = createIpythonToolDefinition("/tmp", { provisioner, cellTimeoutMs: 1_500 });

		const result = await tool.execute("call-1", { code: "spin()" }, undefined, undefined, ctx);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			"Python cell exceeded its 1.5s cap and ignored the interrupt; kernel restarted (variables reverted to the last snapshot)",
			"error",
		);
		expect(result.details.timedOut).toEqual({ timeoutMs: 1_500, kernelRestarted: true });
		expect("timeoutWarned" in result.details).toBe(false);
	});

	it("survives a UI whose notify throws and works without any UI context", async () => {
		const { provisioner } = fakeProvisioner(warningExecute());
		const tool = createIpythonToolDefinition("/tmp", { provisioner, cellTimeoutMs: 1_500 });

		const throwing = uiContext({ throwOnNotify: true });
		const withThrowingUi = await tool.execute("call-1", { code: "slow()" }, undefined, undefined, throwing.ctx);
		expect(throwing.notify).toHaveBeenCalledTimes(1);
		expect(textOf(withThrowingUi)).toBe(`ok\n${WARNING_NOTE}`);

		const onUpdate = vi.fn();
		const headless = await tool.execute("call-2", { code: "slow()" }, undefined, onUpdate, NO_CTX);
		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(textOf(headless)).toBe(`ok\n${WARNING_NOTE}`);
	});
});
