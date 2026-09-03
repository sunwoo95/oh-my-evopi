import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CellTimeoutWarning, ReplKernelManager } from "../src/core/kernel/index.js";
import {
	formatKernelTimeout,
	parseKernelCellTimeoutEnv,
	parseKernelTimeoutArg,
} from "../src/core/kernel-cell-timeout.js";
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

	it("persists kernel.cellTimeoutMs through the global setter without touching sibling keys", async () => {
		delete process.env.EVOPI_KERNEL_CELL_TIMEOUT_MS;
		const settings = SettingsManager.inMemory({ kernel: { envPolicy: "denylist" } });
		settings.setKernelCellTimeoutMs(90_000);
		await settings.flush();
		expect(settings.drainErrors("global")).toEqual([]);
		expect(settings.getGlobalSettings().kernel).toEqual({ envPolicy: "denylist", cellTimeoutMs: 90_000 });

		settings.setKernelCellTimeoutMs(0);
		await settings.flush();
		expect(settings.getGlobalSettings().kernel?.cellTimeoutMs).toBe(0);
	});

	it("rejects negative or fractional caps in the global setter", () => {
		const settings = SettingsManager.inMemory();
		expect(() => settings.setKernelCellTimeoutMs(-1)).toThrow("non-negative integer");
		expect(() => settings.setKernelCellTimeoutMs(1.5)).toThrow("non-negative integer");
		expect(settings.getGlobalSettings().kernel).toBeUndefined();
	});
});

describe("/kernel timeout argument grammar", () => {
	it("parses milliseconds, s/m/h suffixes and off", () => {
		expect(parseKernelTimeoutArg("1500")).toBe(1500);
		expect(parseKernelTimeoutArg("250ms")).toBe(250);
		expect(parseKernelTimeoutArg("90s")).toBe(90_000);
		expect(parseKernelTimeoutArg("2m")).toBe(120_000);
		expect(parseKernelTimeoutArg("1.5h")).toBe(5_400_000);
		expect(parseKernelTimeoutArg(" OFF ")).toBe(0);
		expect(parseKernelTimeoutArg("none")).toBe(0);
		expect(parseKernelTimeoutArg("0")).toBe(0);
	});

	it("rejects anything else", () => {
		expect(parseKernelTimeoutArg("abc")).toBeUndefined();
		expect(parseKernelTimeoutArg("-5m")).toBeUndefined();
		expect(parseKernelTimeoutArg("5 m")).toBeUndefined();
		expect(parseKernelTimeoutArg("")).toBeUndefined();
		expect(parseKernelTimeoutArg("1e3")).toBeUndefined();
	});

	it("formats caps for humans", () => {
		expect(formatKernelTimeout(0)).toBe("off");
		expect(formatKernelTimeout(750)).toBe("750ms");
		expect(formatKernelTimeout(1500)).toBe("1.5s");
		expect(formatKernelTimeout(90_000)).toBe("1.5m");
		expect(formatKernelTimeout(DEFAULT_KERNEL_CELL_TIMEOUT_MS)).toBe("30m");
		expect(formatKernelTimeout(2 * 3_600_000)).toBe("2h");
	});

	it("mirrors the env parsing of SettingsManager", () => {
		expect(parseKernelCellTimeoutEnv(undefined)).toBeUndefined();
		expect(parseKernelCellTimeoutEnv("")).toBeUndefined();
		expect(parseKernelCellTimeoutEnv("off")).toBe(0);
		expect(parseKernelCellTimeoutEnv(" 1500 ")).toBe(1500);
		expect(parseKernelCellTimeoutEnv("garbage")).toBeUndefined();
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
			expect(slow.timedOut).toEqual({ timeoutMs: 1_500, kernelRestarted: false });
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
			expect(stuck.timedOut).toEqual({ timeoutMs: 1_500, kernelRestarted: true });
			// Fresh kernel, no snapshot configured: the stuck cell's namespace is gone,
			// but the manager is usable again without any manual restart.
			const after = await m.execute("'alive'");
			expect(after.status).toBe("ok");
			expect(after.result).toBe("'alive'");
		} finally {
			await m.shutdown();
		}
	}, 90_000);

	it("warns once at 80% of the cap and lets the cell finish untouched", async () => {
		const m = new ReplKernelManager({ python: python as string, cwd: process.cwd() });
		try {
			await m.execute("marker = 1");
			const warnings: CellTimeoutWarning[] = [];
			const r = await m.execute("import time\ntime.sleep(1.3)", {
				timeoutMs: 1_500,
				onTimeoutWarning: (info) => warnings.push(info),
			});
			expect(r.status).toBe("ok");
			expect(r.error).toBeUndefined();
			expect(r.timedOut).toBeUndefined();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.timeoutMs).toBe(1_500);
			expect(warnings[0]?.elapsedMs).toBeGreaterThanOrEqual(1_100);
			expect(warnings[0]?.elapsedMs).toBeLessThan(1_450);
			expect(warnings[0]?.remainingMs).toBeGreaterThan(0);
			expect(m.getActiveCellInfo()).toBeUndefined();
		} finally {
			await m.shutdown();
		}
	}, 60_000);

	it("never warns for a fast cell or an uncapped cell", async () => {
		const m = new ReplKernelManager({ python: python as string, cwd: process.cwd() });
		try {
			const onTimeoutWarning = vi.fn();
			const fast = await m.execute("1 + 1", { timeoutMs: 5_000, onTimeoutWarning });
			expect(fast.result).toBe("2");
			const uncapped = await m.execute("import time\ntime.sleep(0.3)\n'done'", { onTimeoutWarning });
			expect(uncapped.result).toBe("'done'");
			expect(onTimeoutWarning).not.toHaveBeenCalled();
		} finally {
			await m.shutdown();
		}
	}, 60_000);

	it("re-arms the running cell's cap through setActiveCellTimeout", async () => {
		const m = new ReplKernelManager({ python: python as string, cwd: process.cwd() });
		try {
			await m.execute("marker = 2");
			// Nothing is running: the new value can only reach the next cell.
			expect(m.setActiveCellTimeout(10_000)).toBe(false);
			expect(m.getActiveCellInfo()).toBeUndefined();

			const pending = m.execute("import time\ntime.sleep(2.5)\n'slept'", { timeoutMs: 1_000 });
			await sleep(300);
			const before = m.getActiveCellInfo();
			expect(before?.timeoutMs).toBe(1_000);
			expect(before?.timedOut).toBe(false);
			expect(before?.elapsedMs).toBeGreaterThanOrEqual(200);
			expect(m.setActiveCellTimeout(10_000)).toBe(true);
			expect(m.getActiveCellInfo()?.timeoutMs).toBe(10_000);

			const r = await pending;
			expect(r.status).toBe("ok");
			expect(r.result).toBe("'slept'");
			expect(r.timedOut).toBeUndefined();
			expect(m.getActiveCellInfo()).toBeUndefined();
		} finally {
			await m.shutdown();
		}
	}, 60_000);

	it("removes the cap of the running cell with 0 and caps a cell that started uncapped", async () => {
		const m = new ReplKernelManager({ python: python as string, cwd: process.cwd() });
		try {
			await m.execute("marker = 3");
			const disarmed = m.execute("import time\ntime.sleep(1.5)\n'free'", { timeoutMs: 800 });
			await sleep(200);
			expect(m.setActiveCellTimeout(0)).toBe(true);
			expect(m.getActiveCellInfo()?.timeoutMs).toBe(0);
			const r1 = await disarmed;
			expect(r1.status).toBe("ok");
			expect(r1.result).toBe("'free'");

			const capped = m.execute("import time\nwhile True:\n    time.sleep(0.05)");
			await sleep(200);
			expect(m.getActiveCellInfo()?.timeoutMs).toBe(0);
			expect(m.setActiveCellTimeout(500)).toBe(true);
			const r2 = await capped;
			expect(r2.status).toBe("error");
			expect(r2.error?.ename).toBe("KernelCellTimeout");
			expect(r2.timedOut).toEqual({ timeoutMs: 500, kernelRestarted: false });
		} finally {
			await m.shutdown();
		}
	}, 60_000);

	it("reports too late once the cap has fired", async () => {
		const m = new ReplKernelManager({ python: python as string, cwd: process.cwd() });
		try {
			await m.execute("marker = 4");
			const pending = m.execute("import time\nwhile True:\n    time.sleep(0.05)", { timeoutMs: 400 });
			await sleep(600);
			expect(m.setActiveCellTimeout(10_000)).toBe(false);
			const r = await pending;
			expect(r.error?.ename).toBe("KernelCellTimeout");
			expect(r.timedOut?.timeoutMs).toBe(400);
		} finally {
			await m.shutdown();
		}
	}, 60_000);
});
