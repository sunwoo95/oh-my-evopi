import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { DEFAULT_KERNEL_CELL_TIMEOUT_MS, SettingsManager } from "../src/core/settings-manager.js";

const ORIGINAL_ENV = process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS;

afterEach(() => {
	if (ORIGINAL_ENV === undefined) delete process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS;
	else process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS = ORIGINAL_ENV;
});

describe("kernel cell timeout setting", () => {
	it("defaults to 30 minutes", () => {
		delete process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS;
		expect(SettingsManager.inMemory().getKernelCellTimeoutMs()).toBe(DEFAULT_KERNEL_CELL_TIMEOUT_MS);
		expect(DEFAULT_KERNEL_CELL_TIMEOUT_MS).toBe(30 * 60_000);
	});

	it("honours kernel.cellTimeoutMs from settings, including 0 to disable", () => {
		delete process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS;
		expect(SettingsManager.inMemory({ kernel: { cellTimeoutMs: 5_000 } }).getKernelCellTimeoutMs()).toBe(5_000);
		expect(SettingsManager.inMemory({ kernel: { cellTimeoutMs: 0 } }).getKernelCellTimeoutMs()).toBe(0);
		expect(SettingsManager.inMemory({ kernel: { cellTimeoutMs: -1 } }).getKernelCellTimeoutMs()).toBe(
			DEFAULT_KERNEL_CELL_TIMEOUT_MS,
		);
	});

	it("lets EVOPI_KERNEL_CELL_TIMEOUT_MS override settings", () => {
		process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS = "1500";
		expect(SettingsManager.inMemory({ kernel: { cellTimeoutMs: 5_000 } }).getKernelCellTimeoutMs()).toBe(1500);
		process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS = "off";
		expect(SettingsManager.inMemory({ kernel: { cellTimeoutMs: 5_000 } }).getKernelCellTimeoutMs()).toBe(0);
		process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS = "garbage";
		expect(SettingsManager.inMemory({ kernel: { cellTimeoutMs: 5_000 } }).getKernelCellTimeoutMs()).toBe(5_000);
	});
});

function resolveReplPython(): string | undefined {
	const candidates = [
		resolve(__dirname, "..", "..", "..", "evopi-runtime", ".venv", "bin", "python"),
		join(homedir(), ".evopi", "agent", "kernel-venv", "bin", "python"),
	];
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return undefined;
}

const python = resolveReplPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("repl kernel cell timeout (real runtime)", { tags: ["kernel-heavy"] }, () => {
	it("interrupts a cell that honours KeyboardInterrupt and keeps the kernel", async () => {
		const m = new ReplKernelManager({ python: python as string, cwd: process.cwd() });
		try {
			await m.execute("marker = 7");
			const slow = await m.execute("import time\nwhile True:\n    time.sleep(0.05)", { timeoutMs: 1_500 });
			expect(slow.status).toBe("error");
			expect(slow.error?.ename).toBe("KernelCellTimeout");
			expect(slow.stderr).toContain("exceeded 1500 ms");
			// Same kernel: the namespace survived because the interrupt landed.
			const after = await m.execute("marker");
			expect(after.status).toBe("ok");
			expect(after.result).toBe("7");
		} finally {
			await m.shutdown();
		}
	}, 60_000);

	it("discards a kernel whose cell ignores SIGINT, then boots a fresh one", async () => {
		const m = new ReplKernelManager({ python: python as string, cwd: process.cwd() });
		try {
			await m.execute("marker = 9");
			// Ignoring SIGINT defeats the runtime's interrupt entirely — the only way
			// out is for the host to discard the child.
			const stuck = await m.execute(
				"import signal\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nwhile True:\n    pass",
				{ timeoutMs: 1_500 },
			);
			expect(stuck.status).toBe("error");
			expect(stuck.error?.ename).toBe("KernelCellTimeout");
			expect(stuck.stderr).toContain("kernel restarted");
			// Fresh kernel, no snapshot configured: the stuck cell's namespace is gone,
			// but the manager is usable again without any manual restart.
			const after = await m.execute("'alive'");
			expect(after.status).toBe("ok");
			expect(after.result).toBe("'alive'");
		} finally {
			await m.shutdown();
		}
	}, 90_000);
});
