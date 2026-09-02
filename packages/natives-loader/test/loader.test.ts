import { describe, expect, it } from "vitest";
import { detectAvx2, hasNatives, loadNatives } from "../src/index.js";

// Reproduces the R6 6-function load+call smoke (DECISIONS.md R6). On linux-x64
// the prebuilt leaf is installed, so the addon must load and all six functions
// must return the semantics verified during the R6 decision. Signatures mirror
// the upstream omp call sites (mnemopi/src/core/{mmr,shmr,vector-index}.ts).
const onLinuxX64 = process.platform === "linux" && process.arch === "x64";

describe("natives-loader", () => {
	it("resolves a boolean AVX2 verdict without throwing", () => {
		expect(typeof detectAvx2()).toBe("boolean");
	});

	it("never throws on load (null fallback on unsupported platforms)", () => {
		expect(() => loadNatives()).not.toThrow();
	});
});

describe.skipIf(!onLinuxX64)("natives-loader / linux-x64 6-function smoke", () => {
	it("loads the prebuilt addon", () => {
		expect(hasNatives()).toBe(true);
	});

	it("mmrRerankIndices selects diverse top-k", () => {
		const n = loadNatives()!;
		const picked = n.mmrRerankIndices(
			["apple pie", "banana split", "apple tart"],
			Float64Array.from([0.9, 0.5, 0.8]),
			0.7,
			2,
		);
		expect(Array.from(picked)).toEqual([0, 2]);
	});

	it("cosineSimilarityPairs finds the near-duplicate pair", () => {
		const n = loadNatives()!;
		// [[1,0],[1,0.01],[0,1]] → count 3, dim 2. Rows 0 and 1 are near-parallel.
		const pairs = n.cosineSimilarityPairs(Float64Array.from([1, 0, 1, 0.01, 0, 1]), 3, 2, 0.9);
		expect(Array.from(pairs)).toEqual([0, 1]);
	});

	it("vectorIndexTopK ranks by cosine", () => {
		const n = loadNatives()!;
		const s = Math.SQRT1_2;
		// Normalized row-major matrix for [[1,0],[0,1],[1,1]].
		const matrix = Float32Array.from([1, 0, 0, 1, s, s]);
		const res = n.vectorIndexTopK(matrix, 2, Float64Array.from([1, 0]), 2);
		expect(Array.from(res.indices)).toEqual([0, 2]);
		expect(res.scores[0]).toBeCloseTo(1, 5);
		expect(res.scores[1]).toBeCloseTo(0.7071, 3);
	});

	it("diffLineRuns reports the changed run", () => {
		const n = loadNatives()!;
		const runs = n.diffLineRuns("a\nb\nc", "a\nX\nc") as { added: boolean; removed: boolean }[];
		expect(runs.some((r) => r.removed)).toBe(true);
		expect(runs.some((r) => r.added)).toBe(true);
	});

	it("nodeChainAt walks the tree-sitter chain", () => {
		const n = loadNatives()!;
		const chain = n.nodeChainAt({
			code: "function f(){\nreturn 1;\n}",
			lang: "javascript",
			line: 2,
		}) as { kind: string }[];
		expect(chain.map((c) => c.kind)).toContain("function_declaration");
	});

	it("enclosingBlockBoundaries accepts the ranges contract", () => {
		const n = loadNatives()!;
		expect(
			n.enclosingBlockBoundaries({ code: "const x = 1;", lang: "javascript", ranges: [] }),
		).toEqual([]);
	});
});
