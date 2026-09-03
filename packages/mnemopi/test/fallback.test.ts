import { describe, expect, it, vi } from "vitest";

// Force the native gateway to report the addon as unavailable so every kernel
// takes its pure-TS fallback branch. This is the path that runs on platforms
// without a prebuilt pi-natives leaf.
vi.mock("@evopi/pi-natives-loader", () => ({
	loadNatives: () => null,
	hasNatives: () => false,
}));

import {
	buildExactVectorIndex,
	clusterByCosineSimilarity,
	cosineSimilarity,
	hasNatives,
	jaccardSimilarity,
	mmrRerank,
	searchExactVectorIndex,
} from "@evopi/mnemopi";

function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

describe("pure-TS fallbacks (native addon unavailable)", () => {
	it("confirms the mocked loader reports no natives", () => {
		expect(hasNatives()).toBe(false);
	});

	it("mmrRerank falls back to the greedy TS loop and matches the custom-fn TS path", () => {
		const rng = makeRng(0x1234);
		const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
		const results = Array.from({ length: 30 }, (_v, _i) => ({
			content: Array.from({ length: 1 + Math.floor(rng() * 5) }, () => words[Math.floor(rng() * words.length)]).join(
				" ",
			),
			score: rng(),
		}));
		// A custom similarity function always uses the TS loop; the default
		// (jaccard) path with natives mocked null must produce the same ordering.
		const tsJaccard = (a: string, b: string): number => jaccardSimilarity(a, b);
		for (const lambda of [0, 0.3, 0.7, 1]) {
			for (const topK of [1, 5, 30, 40]) {
				expect(mmrRerank(results, lambda, topK)).toEqual(mmrRerank(results, lambda, topK, tsJaccard));
			}
		}
		expect(mmrRerank(results, 0.7, 0)).toEqual([]);
		expect(mmrRerank(results.slice(0, 1), 0.7, 3)).toHaveLength(1);
	});

	it("searchExactVectorIndex falls back to the exact cosine scan", () => {
		const rng = makeRng(0x99aa);
		const dim = 32;
		const rows = Array.from({ length: 50 }, (_v, i) => ({
			id: i,
			vector: Array.from({ length: dim }, () => rng() * 2 - 1),
		}));
		const index = buildExactVectorIndex(rows);
		const query = Array.from({ length: dim }, () => rng() * 2 - 1);

		let normSq = 0;
		for (const v of query) normSq += v * v;
		const norm = Math.sqrt(normSq);
		const expected: Array<{ row: number; score: number }> = [];
		for (let row = 0; row < index.count; row += 1) {
			let score = 0;
			for (let col = 0; col < index.dimensions; col += 1) {
				score += (index.matrix[row * index.dimensions + col] ?? 0) * ((query[col] ?? 0) / norm);
			}
			expected.push({ row, score });
		}
		expected.sort((a, b) => b.score - a.score);

		const limit = 10;
		const hits = searchExactVectorIndex(index, query, limit);
		expect(hits.map((h) => h.id)).toEqual(expected.slice(0, limit).map((e) => index.ids[e.row]));
		for (let i = 0; i < limit; i += 1) {
			expect(hits[i]?.score).toBeCloseTo(expected[i]?.score ?? Number.NaN, 6);
		}
		// Guards still short-circuit before the fallback.
		expect(searchExactVectorIndex(index, [], 5)).toEqual([]);
		expect(searchExactVectorIndex(index, query, 0)).toEqual([]);
	});

	it("clusterByCosineSimilarity falls back to the pairwise TS loop", () => {
		const rng = makeRng(0x424242);
		const dim = 48;
		const count = 35;
		const vectors: Float32Array[] = [];
		for (let i = 0; i < count; i += 1) {
			const v = new Float32Array(dim);
			for (let c = 0; c < dim; c += 1) v[c] = rng() * 2 - 1;
			vectors.push(v);
		}
		const threshold = 0.12;

		const parent = Array.from({ length: count }, (_v, i) => i);
		const find = (x: number): number => {
			while (parent[x] !== x) {
				parent[x] = parent[parent[x] as number] as number;
				x = parent[x] as number;
			}
			return x;
		};
		for (let i = 0; i < count; i += 1) {
			for (let j = i + 1; j < count; j += 1) {
				if (cosineSimilarity(vectors[i] as Float32Array, vectors[j] as Float32Array) >= threshold) {
					const ra = find(i);
					const rb = find(j);
					if (ra !== rb) parent[ra] = rb;
				}
			}
		}
		const refGroups = new Map<number, number[]>();
		for (let i = 0; i < count; i += 1) (refGroups.get(find(i)) ?? refGroups.set(find(i), []).get(find(i))!).push(i);
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
