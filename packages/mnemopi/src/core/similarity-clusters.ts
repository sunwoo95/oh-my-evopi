/**
 * Cosine-similarity connected-component clustering — the pure-compute core of
 * SHMR's `clusterBySimilarity`, decoupled from the embedding provider and the
 * SQLite store (those depend on `bun:sqlite` and are deferred to a later phase).
 * Callers pass already-resolved vectors; this module only routes the O(n^2)
 * pairwise pass through the native `cosineSimilarityPairs` kernel (with a
 * pure-TS pairwise fallback) and groups the resulting graph.
 */
import { cosineSimilarityPairs } from "../native.js";
import { cosineSimilarity } from "./vector-math.js";

/**
 * Group vector indices into clusters where an edge connects any pair whose
 * cosine similarity is at or above `threshold`. Returns clusters as arrays of
 * indices into `vectors`; every input index appears in exactly one cluster
 * (singletons included), so `clusters.flat()` is a permutation of `0..n-1`.
 *
 * Vectors are zero-padded to the widest dimension before the native crossing,
 * matching the TS `?? 0` missing-element semantics of {@link cosineSimilarity}.
 */
export function clusterByCosineSimilarity(vectors: readonly Float32Array[], threshold: number): number[][] {
	const n = vectors.length;
	if (n === 0) return [];

	let dim = 0;
	for (const vector of vectors) if (vector.length > dim) dim = vector.length;

	const adjacency: number[][] = Array.from({ length: n }, () => []);
	const flat = new Float64Array(n * dim);
	for (let i = 0; i < n; i += 1) {
		const vector = vectors[i];
		if (vector === undefined) continue;
		for (let col = 0; col < vector.length; col += 1) flat[i * dim + col] = vector[col] ?? 0;
	}

	const pairs = cosineSimilarityPairs(flat, n, dim, threshold);
	if (pairs !== null) {
		for (let p = 0; p < pairs.length; p += 2) {
			const i = pairs[p] ?? 0;
			const j = pairs[p + 1] ?? 0;
			adjacency[i]?.push(j);
			adjacency[j]?.push(i);
		}
	} else {
		// Pure-TS pairwise threshold pass (addon unavailable).
		for (let i = 0; i < n; i += 1) {
			const vi = vectors[i];
			if (vi === undefined) continue;
			for (let j = i + 1; j < n; j += 1) {
				const vj = vectors[j];
				if (vj === undefined) continue;
				if (cosineSimilarity(vi, vj) >= threshold) {
					adjacency[i]?.push(j);
					adjacency[j]?.push(i);
				}
			}
		}
	}

	const visited = new Set<number>();
	const clusters: number[][] = [];
	for (let i = 0; i < n; i += 1) {
		if (visited.has(i)) continue;
		const cluster: number[] = [];
		const stack = [i];
		while (stack.length > 0) {
			const node = stack.pop();
			if (node === undefined || visited.has(node)) continue;
			visited.add(node);
			cluster.push(node);
			for (const next of adjacency[node] ?? []) if (!visited.has(next)) stack.push(next);
		}
		clusters.push(cluster);
	}
	return clusters;
}
