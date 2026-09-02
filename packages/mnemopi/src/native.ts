/**
 * Native gateway for the mnemopi memory kernels (등급 B, R6).
 *
 * Routes the three vector/rerank kernels through `@evopi/pi-natives-loader`
 * instead of the Bun-only upstream `@oh-my-pi/pi-natives` wrapper. Each function
 * returns `null` when the prebuilt addon is unavailable (unsupported platform or
 * load failure), so callers fall back to their pure-TS implementations: the MMR
 * greedy loop, the exact cosine scan, and the pairwise threshold clustering. The
 * product therefore runs everywhere; the native addon only makes it faster.
 */

import { loadNatives, type VectorTopK } from "@evopi/pi-natives-loader";

export type { VectorTopK };

/**
 * Native MMR selection over pre-sorted candidates, or `null` when the addon is
 * unavailable (caller runs the greedy TS loop).
 */
export function mmrRerankIndices(
	contents: string[],
	scores: Float64Array,
	lambdaParam: number,
	topK: number,
): Uint32Array | null {
	const native = loadNatives();
	return native ? native.mmrRerankIndices(contents, scores, lambdaParam, topK) : null;
}

/**
 * Native pairwise cosine-similarity threshold pass over a flat row-major matrix,
 * returning `[i, j, ...]` index pairs at or above `threshold`, or `null` when the
 * addon is unavailable (caller runs the pairwise TS loop).
 */
export function cosineSimilarityPairs(
	vectors: Float64Array,
	count: number,
	dim: number,
	threshold: number,
): Uint32Array | null {
	const native = loadNatives();
	return native ? native.cosineSimilarityPairs(vectors, count, dim, threshold) : null;
}

/**
 * Native top-k cosine search over an L2-normalized row-major matrix (query is
 * normalized internally), or `null` when the addon is unavailable (caller runs
 * the exact cosine scan + stable sort).
 */
export function vectorIndexTopK(
	matrix: Float32Array,
	dimensions: number,
	query: Float64Array,
	limit: number,
): VectorTopK | null {
	const native = loadNatives();
	return native ? native.vectorIndexTopK(matrix, dimensions, query, limit) : null;
}
