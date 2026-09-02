/**
 * Boot-time sandbox capability probe.
 *
 * The OS-level enforcement layer (D3/D4) wraps bash in bubblewrap on Linux.
 * bubblewrap can be *installed* yet *non-functional*: inside an unprivileged
 * container the kernel commonly forbids unprivileged user namespaces, so
 * `bwrap` exits non-zero on every invocation ("No permissions to create new
 * namespace …"). A presence-only check (`which bwrap` / `bwrap --version`)
 * therefore over-reports availability.
 *
 * This probe runs a real, minimal `bwrap … true` and treats the sandbox as
 * available only when that succeeds — the "프로브가 현 환경에서 '불가' 감지"
 * requirement. The result gates the sandbox enforcement layer; when
 * unavailable, evopi falls back to the intent layer (permission-gate) plus
 * whatever container boundary the deployment already provides (D3 [폴백]).
 */
import { spawnSync } from "node:child_process";

export type SandboxKind = "bubblewrap" | "sandbox-exec" | "none";

export interface SandboxProbeResult {
	/** True only when the OS sandbox mechanism is present AND functionally usable here. */
	available: boolean;
	/** Which mechanism was probed for this platform. */
	kind: SandboxKind;
	/** Human-readable reason, suitable for a boot log / notification. */
	detail: string;
	/** Mechanism version string, when it could be read. */
	version?: string;
}

function probeBubblewrap(): SandboxProbeResult {
	// 1) Presence + version.
	const version = spawnSync("bwrap", ["--version"], { encoding: "utf-8", timeout: 5000 });
	if (version.error || version.status !== 0) {
		return {
			available: false,
			kind: "bubblewrap",
			detail: "bubblewrap (bwrap) not found on PATH",
		};
	}
	const versionText = (version.stdout || "").trim() || undefined;

	// 2) Functional test: a minimal namespace that runs `true`. This is what
	// fails inside a container without unprivileged-userns support.
	const functional = spawnSync(
		"bwrap",
		["--ro-bind", "/", "/", "--unshare-user", "--die-with-parent", "true"],
		{ encoding: "utf-8", timeout: 5000 },
	);
	if (functional.error || functional.status !== 0) {
		const stderr = (functional.stderr || "").trim();
		const noUserns = /non-privileged user namespaces|create new namespace/i.test(stderr);
		return {
			available: false,
			kind: "bubblewrap",
			version: versionText,
			detail: noUserns
				? "bubblewrap present but unprivileged user namespaces are disabled by the kernel; OS sandbox unavailable"
				: `bubblewrap present but a minimal sandbox failed to start${stderr ? `: ${stderr}` : ""}`,
		};
	}

	return {
		available: true,
		kind: "bubblewrap",
		version: versionText,
		detail: `bubblewrap ${versionText ?? ""} functional`.trim(),
	};
}

function probeSandboxExec(): SandboxProbeResult {
	// macOS: `sandbox-exec` ships with the OS. A no-op profile confirms usability.
	const result = spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "true"], {
		encoding: "utf-8",
		timeout: 5000,
	});
	if (result.error || result.status !== 0) {
		return {
			available: false,
			kind: "sandbox-exec",
			detail: "sandbox-exec not usable on this host",
		};
	}
	return { available: true, kind: "sandbox-exec", detail: "sandbox-exec functional" };
}

let cached: SandboxProbeResult | undefined;

/**
 * Probe (and memoize) OS sandbox availability for the current platform.
 * Linux → bubblewrap functional test; macOS → sandbox-exec; else unsupported.
 * Pass `force` to re-probe (tests).
 */
export function probeSandbox(force = false): SandboxProbeResult {
	if (cached !== undefined && !force) return cached;
	let result: SandboxProbeResult;
	const platform = process.platform;
	if (platform === "linux") {
		result = probeBubblewrap();
	} else if (platform === "darwin") {
		result = probeSandboxExec();
	} else {
		result = { available: false, kind: "none", detail: `OS sandbox not supported on ${platform}` };
	}
	cached = result;
	return result;
}

/** Reset the memoized probe result (tests). */
export function resetSandboxProbeCache(): void {
	cached = undefined;
}
