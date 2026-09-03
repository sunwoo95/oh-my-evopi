/**
 * Node-only loader for the prebuilt `pi-natives` addon (R6 [자동확정]).
 *
 * The upstream `@oh-my-pi/pi-natives` wrapper is Bun-only: its `index.js` uses
 * `import.meta.dir` and `Bun.spawnSync`, which are undefined under Node. So we
 * bypass the wrapper entirely and `require()` the platform leaf `.node` directly
 * (`@oh-my-pi/pi-natives-<platform>-<arch>`), picking the AVX2 `modern` build when
 * the CPU supports it and falling back to `baseline` otherwise. On any platform
 * without a prebuilt leaf, or if the addon fails to load, we return `null` and let
 * callers fall back (mnemopi/hashline degrade to pure-TS or skip). This keeps the
 * product free of `Bun.*` (R7 policy).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** One coalesced run in a line diff (mirrors the native `DiffRun`). */
export interface DiffRun {
	/** Number of tokens in this run. */
	count: number;
	/** True when this run exists only in the new text. */
	added: boolean;
	/** True when this run exists only in the old text. */
	removed: boolean;
}

/** A tree-sitter node span (mirrors the native `NodeSpan`). */
export interface NodeSpan {
	/** 1-indexed inclusive first line of the node. */
	startLine: number;
	/** 1-indexed inclusive last content line of the node. */
	endLine: number;
	/** Tree-sitter grammar node kind (e.g. `function_declaration`). */
	kind: string;
}

/** 1-indexed inclusive visible line range. */
export interface LineRange {
	startLine: number;
	endLine: number;
}

/** Options for `nodeChainAt` (mirrors the native `BlockRangeOptions`). */
export interface BlockRangeOptions {
	code: string;
	lang?: string;
	path?: string;
	line: number;
}

/** Options for `enclosingBlockBoundaries` (mirrors `EnclosingBoundaryOptions`). */
export interface EnclosingBoundaryOptions {
	code: string;
	lang?: string;
	path?: string;
	ranges: LineRange[];
}

/** Result of `vectorIndexTopK` (mirrors the native `VectorTopK`). */
export interface VectorTopK {
	indices: Uint32Array;
	scores: Float64Array;
}

/**
 * The six native functions the evopi backports (mnemopi, hashline) rely on.
 * Signatures mirror the upstream `@oh-my-pi/pi-natives` declarations exactly, so
 * the backported call sites port over unchanged.
 */
export interface PiNatives {
	// mnemopi (등급 B)
	mmrRerankIndices(contents: string[], scores: Float64Array, lambdaParam: number, topK: number): Uint32Array;
	cosineSimilarityPairs(vectors: Float64Array, count: number, dim: number, threshold: number): Uint32Array;
	vectorIndexTopK(matrix: Float32Array, dimensions: number, query: Float64Array, limit: number): VectorTopK;
	// hashline (등급 C)
	diffLineRuns(oldText: string, newText: string): DiffRun[];
	nodeChainAt(options: BlockRangeOptions): NodeSpan[] | null;
	enclosingBlockBoundaries(options: EnclosingBoundaryOptions): number[] | null;
	// the leaf exports ~100 symbols; expose the rest opaquely.
	[key: string]: unknown;
}

/** Leaf package name for the running platform, or `null` if unsupported. */
function leafPackageName(): string | null {
	const key = `${process.platform}-${process.arch}`;
	switch (key) {
		case "linux-x64":
			return "@oh-my-pi/pi-natives-linux-x64";
		case "linux-arm64":
			return "@oh-my-pi/pi-natives-linux-arm64";
		case "darwin-x64":
			return "@oh-my-pi/pi-natives-darwin-x64";
		case "darwin-arm64":
			return "@oh-my-pi/pi-natives-darwin-arm64";
		case "win32-x64":
			return "@oh-my-pi/pi-natives-win32-x64";
		default:
			return null;
	}
}

/**
 * Whether this CPU advertises AVX2 (the `modern` build's requirement).
 * Only x64 has the modern/baseline split; other arches have a single build,
 * so we report `false` there and let candidate resolution fall through.
 */
export function detectAvx2(): boolean {
	if (process.arch !== "x64") {
		return false;
	}
	if (process.platform === "linux") {
		try {
			const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
			return /^flags\s*:.*\bavx2\b/m.test(cpuinfo);
		} catch {
			return false;
		}
	}
	// Non-linux x64 (darwin-x64, win32-x64): assume modern is safe on 64-bit
	// hardware from the last decade; baseline remains the fallback candidate.
	return true;
}

/** Candidate `.node` basenames for `<platform>-<arch>`, most-preferred first. */
function candidateFiles(): string[] {
	const key = `${process.platform}-${process.arch}`;
	const variants = detectAvx2() ? ["modern", "baseline"] : ["baseline", "modern"];
	const named = variants.map((v) => `pi_natives.${key}-${v}.node`);
	// Some leaves may ship a single unsuffixed addon; try it last.
	return [...named, `pi_natives.${key}.node`];
}

let cached: PiNatives | null | undefined;

/**
 * Load the native addon, or `null` if unavailable on this platform.
 * The result is memoized (including the `null` outcome).
 */
export function loadNatives(): PiNatives | null {
	if (cached !== undefined) {
		return cached;
	}
	cached = resolveNatives();
	return cached;
}

function resolveNatives(): PiNatives | null {
	const pkg = leafPackageName();
	if (!pkg) {
		return null;
	}
	let leafDir: string;
	try {
		// Resolve via the leaf's package.json so we get its install directory,
		// then join the specific addon file (the leaf `main` is baseline-only).
		const manifest = require.resolve(`${pkg}/package.json`);
		leafDir = manifest.slice(0, manifest.length - "package.json".length);
	} catch {
		return null;
	}
	for (const file of candidateFiles()) {
		try {
			const mod = require(leafDir + file) as PiNatives;
			if (mod && typeof mod.mmrRerankIndices === "function") {
				return mod;
			}
		} catch {
			// try next candidate
		}
	}
	return null;
}

/** True when the native addon loaded successfully on this platform. */
export function hasNatives(): boolean {
	return loadNatives() !== null;
}

/** Test seam: drop the memoized result so a later `loadNatives()` re-resolves. */
export function resetNativesCache(): void {
	cached = undefined;
}
