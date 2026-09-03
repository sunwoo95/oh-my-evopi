import {
	buildExactVectorIndex,
	clusterByCosineSimilarity,
	cosineSimilarity,
	hasNatives,
	jaccardSimilarity,
	mmrRerank,
	searchExactVectorIndex,
} from "@evopi/mnemopi";
import { describe, expect, it, test } from "vitest";
import { cosineSimilarityPairs, mmrRerankIndices, vectorIndexTopK } from "../src/native.js";

/** Deterministic LCG so parity failures reproduce exactly. */
function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

const REL_TOL = 1e-9;

function expectClose(actual: number, expected: number): void {
	if (expected === 0) {
		expect(actual).toBe(0);
		return;
	}
	expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThanOrEqual(REL_TOL);
}

describe("native addon is loaded on this host", () => {
	// M7 evidence: the three kernels take the native path here (not the fallback).
	it("reports natives available and each gateway returns a non-null result", () => {
		expect(hasNatives()).toBe(true);
		expect(mmrRerankIndices(["a b", "c d"], Float64Array.from([0.9, 0.8]), 0.7, 2)).not.toBeNull();
		expect(cosineSimilarityPairs(Float64Array.from([1, 0, 1, 0]), 2, 2, 0.5)).not.toBeNull();
		const built = buildExactVectorIndex([
			{ id: 0, vector: [1, 0] },
			{ id: 1, vector: [0, 1] },
		]);
		expect(vectorIndexTopK(built.matrix, built.dimensions, Float64Array.from([1, 0]), 2)).not.toBeNull();
	});
});

describe("MMR reranking (mmrRerankIndices path)", () => {
	it("returns the highest-scoring result first and preserves requested length", () => {
		const results = [
			{ content: "database password is hunter2", score: 0.95 },
			{ content: "server runs on port 8080", score: 0.85 },
			{ content: "deploy script is in /opt/deploy", score: 0.8 },
		];
		const reranked = mmrRerank(results, 0.7, 3);
		expect(reranked).toHaveLength(3);
		expect(reranked[0]?.content).toBe("database password is hunter2");
	});

	it("diversifies similar high-scoring results", () => {
		const results = [
			{ content: "the database password is hunter2", score: 0.95 },
			{ content: "the database password was hunter2", score: 0.94 },
			{ content: "the database password should be hunter2", score: 0.93 },
			{ content: "unrelated topic about gardening", score: 0.5 },
		];
		const reranked = mmrRerank(results, 0.5, 3);
		expect(reranked.map((result) => result.content)).toContain("unrelated topic about gardening");
	});

	it("handles single and empty result sets", () => {
		expect(mmrRerank([{ content: "only one result", score: 0.5 }])).toHaveLength(1);
		expect(mmrRerank([])).toHaveLength(0);
	});

	it("returns no results for non-positive topK", () => {
		const results = [
			{ content: "first", score: 0.9 },
			{ content: "second", score: 0.8 },
		];
		expect(mmrRerank(results, 0.7, 0)).toEqual([]);
		expect(mmrRerank(results, 0.7, -3)).toEqual([]);
	});

	it("selects identical index sequences to the TS reference loop", () => {
		const rng = makeRng(0x33a11);
		const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
		const count = 60;
		const contents: string[] = [];
		const scores = new Float64Array(count);
		for (let i = 0; i < count; i += 1) {
			const n = 1 + Math.floor(rng() * 8);
			contents.push(Array.from({ length: n }, () => words[Math.floor(rng() * words.length)]).join(" "));
			scores[i] = rng();
		}
		scores[5] = scores[6] = 0.5; // exercise strict-> tie keeping the earlier candidate
		for (const lambda of [0.0, 0.3, 0.7, 1.0]) {
			for (const topK of [1, 10, count, count + 5]) {
				const order = contents.map((_, i) => i).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
				const sortedContents = order.map((i) => contents[i] ?? "");
				const sortedScores = order.map((i) => scores[i] ?? 0);
				const selected: number[] = [0];
				const remaining = sortedContents.map((_, i) => i).slice(1);
				while (remaining.length > 0 && selected.length < topK) {
					let bestIdx = 0;
					let bestScore = Number.NEGATIVE_INFINITY;
					for (let idx = 0; idx < remaining.length; idx += 1) {
						const candidate = remaining[idx] ?? 0;
						let maxSimilarity = 0;
						for (const picked of selected) {
							const sim = jaccardSimilarity(sortedContents[candidate] ?? "", sortedContents[picked] ?? "");
							if (sim > maxSimilarity) maxSimilarity = sim;
						}
						const mmrScore = lambda * (sortedScores[candidate] ?? 0) - (1 - lambda) * maxSimilarity;
						if (mmrScore > bestScore) {
							bestScore = mmrScore;
							bestIdx = idx;
						}
					}
					selected.push(remaining.splice(bestIdx, 1)[0] ?? 0);
				}
				if (selected.length < topK) selected.push(...remaining.slice(0, topK - selected.length));
				const native = mmrRerankIndices(sortedContents, Float64Array.from(sortedScores), lambda, topK);
				expect(native).not.toBeNull();
				expect(Array.from(native ?? new Uint32Array())).toEqual(selected.slice(0, topK));
			}
		}
	});

	it("preserves the pre-native limit contract at u32 boundaries", () => {
		const results = Array.from({ length: 8 }, (_v, i) => ({
			content: `item ${i} alpha beta`,
			score: (8 - i) / 10,
		}));
		const all = mmrRerank(results, 0.7, results.length);
		expect(mmrRerank(results, 0.7, Number.POSITIVE_INFINITY)).toEqual(all);
		expect(mmrRerank(results, 0.7, 2 ** 32)).toEqual(all);
		expect(mmrRerank(results, 0.7, 2 ** 32 + 1)).toEqual(all);
		expect(mmrRerank(results, 0.7, Number.NaN)).toEqual([results[0] as (typeof results)[number]]);
		expect(mmrRerank(results, 0.7, 0)).toEqual([]);
		expect(mmrRerank(results, 0.7, -3)).toEqual([]);
	});

	it("matches the TS path on contextual-lowercase and lone-surrogate content", () => {
		const tsJaccard = (a: string, b: string): number => jaccardSimilarity(a, b);
		const sigma = [
			{ content: "ΟΣ", score: 0.9 },
			{ content: "ος", score: 0.8 },
			{ content: "other words entirely", score: 0.7 },
		];
		for (const lambda of [0, 0.3, 0.7]) {
			expect(mmrRerank(sigma, lambda, 2)).toEqual(mmrRerank(sigma, lambda, 2, tsJaccard));
		}
		const surrogate = [
			{ content: "\ud800", score: 0.9 },
			{ content: "�", score: 0.8 },
			{ content: "other", score: 0.7 },
		];
		expect(mmrRerank(surrogate, 0, 2)).toEqual(mmrRerank(surrogate, 0, 2, tsJaccard));
	});
});

describe("exact vector index (vectorIndexTopK path)", () => {
	it("normalizes vectors and returns nearest ids by cosine score", () => {
		const index = buildExactVectorIndex([
			{ id: "x", vector: [1, 0] },
			{ id: "y", vector: [0, 2] },
			{ id: "z", vector: [0, 0] },
		]);
		expect(index.count).toBe(2);
		expect(searchExactVectorIndex(index, [0, 3], 2)).toEqual([
			{ id: "y", score: 1 },
			{ id: "x", score: 0 },
		]);
	});

	it("returns no hits for invalid or empty queries", () => {
		const index = buildExactVectorIndex([{ id: 1, vector: [1, 0] }]);
		expect(searchExactVectorIndex(index, [], 10)).toEqual([]);
		expect(searchExactVectorIndex(index, [Number.NaN], 10)).toEqual([]);
		expect(searchExactVectorIndex(index, [1, 0], 0)).toEqual([]);
	});

	test("matches the TS scoring loop and stable sort", () => {
		const rng = makeRng(0x70b1);
		const dims = 384;
		const count = 300;
		const matrix = new Float32Array(count * dims);
		for (let i = 0; i < matrix.length; i += 1) matrix[i] = rng() * 2 - 1;
		const query = Float64Array.from({ length: dims }, () => rng() * 2 - 1);
		let normSq = 0;
		for (const v of query) normSq += v * v;
		const norm = Math.sqrt(normSq);
		const hits: Array<{ row: number; score: number }> = [];
		for (let row = 0; row < count; row += 1) {
			let score = 0;
			for (let col = 0; col < dims; col += 1) {
				score += (matrix[row * dims + col] ?? 0) * ((query[col] ?? 0) / norm);
			}
			hits.push({ row, score });
		}
		hits.sort((a, b) => b.score - a.score);
		const limit = 25;
		const result = vectorIndexTopK(matrix, dims, query, limit);
		expect(result).not.toBeNull();
		expect(Array.from(result?.indices ?? new Uint32Array())).toEqual(hits.slice(0, limit).map((h) => h.row));
		for (let i = 0; i < limit; i += 1) {
			expectClose(result?.scores[i] ?? Number.NaN, hits[i]?.score ?? Number.NaN);
		}
	});

	it("preserves the pre-native limit contract at u32 boundaries", () => {
		const rows = Array.from({ length: 6 }, (_v, i) => ({
			id: i,
			vector: Array.from({ length: 8 }, (_x, j) => Math.sin(i * 8 + j)),
		}));
		const index = buildExactVectorIndex(rows);
		const query = Array.from({ length: 8 }, (_x, j) => Math.cos(j));
		const all = searchExactVectorIndex(index, query, index.count);
		expect(all.length).toBe(index.count);
		expect(searchExactVectorIndex(index, query, Number.POSITIVE_INFINITY)).toEqual(all);
		expect(searchExactVectorIndex(index, query, 2 ** 32)).toEqual(all);
		expect(searchExactVectorIndex(index, query, Number.NaN)).toEqual([]);
		expect(searchExactVectorIndex(index, query, 0)).toEqual([]);
	});
});

describe("cosine clustering (cosineSimilarityPairs path)", () => {
	it("groups near-duplicate vectors and isolates unrelated ones", () => {
		const clusters = clusterByCosineSimilarity(
			[new Float32Array([1, 0, 0]), new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0])],
			0.9,
		);
		expect(clusters.map((c) => c.length).sort()).toEqual([1, 2]);
	});

	it("matches an independent TS connected-components reference", () => {
		const rng = makeRng(0x515c);
		const dim = 64;
		const count = 40;
		const vectors: Float32Array[] = [];
		for (let i = 0; i < count; i += 1) {
			const v = new Float32Array(dim);
			for (let c = 0; c < dim; c += 1) v[c] = rng() * 2 - 1;
			vectors.push(v);
		}
		const threshold = 0.15;

		// Independent reference: pairwise cosine + union-find components.
		const parent = Array.from({ length: count }, (_v, i) => i);
		const find = (x: number): number => {
			while (parent[x] !== x) {
				parent[x] = parent[parent[x] as number] as number;
				x = parent[x] as number;
			}
			return x;
		};
		const union = (a: number, b: number): void => {
			const ra = find(a);
			const rb = find(b);
			if (ra !== rb) parent[ra] = rb;
		};
		for (let i = 0; i < count; i += 1) {
			for (let j = i + 1; j < count; j += 1) {
				if (cosineSimilarity(vectors[i] as Float32Array, vectors[j] as Float32Array) >= threshold) union(i, j);
			}
		}
		const refGroups = new Map<number, number[]>();
		for (let i = 0; i < count; i += 1) {
			const root = find(i);
			(refGroups.get(root) ?? refGroups.set(root, []).get(root)!).push(i);
		}
		const normalize = (groups: number[][]): string =>
			groups
				.map((g) => [...g].sort((a, b) => a - b).join(","))
				.sort()
				.join("|");

		const clusters = clusterByCosineSimilarity(vectors, threshold);
		expect(clusters.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_v, i) => i));
		expect(normalize(clusters)).toEqual(normalize([...refGroups.values()]));
	});
});
