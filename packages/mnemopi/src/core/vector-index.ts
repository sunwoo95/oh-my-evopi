import { vectorIndexTopK } from "../native.js";

export interface ExactVectorSearchHit<TId> {
	id: TId;
	score: number;
}

export interface ExactVectorIndex<TId> {
	readonly ids: readonly TId[];
	readonly matrix: Float32Array;
	readonly dimensions: number;
	readonly count: number;
}

export interface VectorIndexRow<TId> {
	id: TId;
	vector: readonly number[] | null | undefined;
}

export function buildExactVectorIndex<TId>(rows: readonly VectorIndexRow<TId>[]): ExactVectorIndex<TId> {
	const valid: Array<{ id: TId; vector: readonly number[]; norm: number }> = [];
	let dimensions = 0;
	for (const row of rows) {
		const vector = row.vector;
		if (!vector || vector.length === 0) continue;
		let normSq = 0;
		for (let i = 0; i < vector.length; i += 1) {
			const value = vector[i] ?? 0;
			if (!Number.isFinite(value)) {
				normSq = 0;
				break;
			}
			normSq += value * value;
		}
		if (normSq <= 0) continue;
		valid.push({ id: row.id, vector, norm: Math.sqrt(normSq) });
		if (vector.length > dimensions) dimensions = vector.length;
	}

	// Float32Array keeps a compact contiguous matrix that matches the shape we'd
	// feed into future ANN/quantized backends. Exact cosine ranking remains sound
	// here because we store normalized vectors and only compare normalized dots.
	const matrix = new Float32Array(valid.length * dimensions);
	const ids: TId[] = [];
	for (let row = 0; row < valid.length; row += 1) {
		const item = valid[row];
		ids.push(item.id);
		const offset = row * dimensions;
		for (let col = 0; col < item.vector.length; col += 1) {
			matrix[offset + col] = (item.vector[col] ?? 0) / item.norm;
		}
	}

	return { ids, matrix, dimensions, count: ids.length };
}

/**
 * Exact cosine scan + stable descending sort, used only when the native addon
 * is absent. Matrix rows are already L2-normalized; the query is normalized here
 * so scores match the native kernel (which normalizes the query internally).
 */
function searchFallback<TId>(
	index: ExactVectorIndex<TId>,
	query: readonly number[],
	queryNormSq: number,
	k: number,
): ExactVectorSearchHit<TId>[] {
	const norm = Math.sqrt(queryNormSq);
	const scored: Array<{ row: number; score: number }> = [];
	for (let row = 0; row < index.count; row += 1) {
		const offset = row * index.dimensions;
		let score = 0;
		for (let col = 0; col < index.dimensions; col += 1) {
			score += (index.matrix[offset + col] ?? 0) * ((query[col] ?? 0) / norm);
		}
		scored.push({ row, score });
	}
	// Array.prototype.sort is stable (ES2019+), matching the native kernel's
	// stable ordering on ties.
	scored.sort((a, b) => b.score - a.score);
	const hits: ExactVectorSearchHit<TId>[] = [];
	const take = Math.min(k, index.count);
	for (let i = 0; i < take; i += 1) {
		const entry = scored[i];
		if (entry === undefined) continue;
		hits.push({ id: index.ids[entry.row] as TId, score: entry.score });
	}
	return hits;
}

export function searchExactVectorIndex<TId>(
	index: ExactVectorIndex<TId>,
	query: readonly number[],
	limit: number,
): ExactVectorSearchHit<TId>[] {
	const k = Math.max(0, Math.trunc(limit));
	if (k === 0 || index.count === 0 || index.dimensions === 0 || query.length === 0) return [];

	let queryNormSq = 0;
	for (const value of query) {
		if (!Number.isFinite(value)) return [];
		queryNormSq += value * value;
	}
	if (queryNormSq <= 0) return [];
	// Native batch kernel: one N-API crossing scores every row and ranks the
	// top k with the same stable ordering as the TS sort. TS guards above
	// (finite query, positive norm, non-empty index) are preserved. Clamp k to
	// the row count before the u32 boundary: Infinity or >= 2**32 would
	// otherwise wrap (ToUint32) and return no hits. A `null` native result
	// (addon unavailable) falls back to the exact cosine scan.
	const topK = vectorIndexTopK(index.matrix, index.dimensions, Float64Array.from(query), Math.min(k, index.count));
	if (topK === null) {
		return searchFallback(index, query, queryNormSq, k);
	}
	const hits: ExactVectorSearchHit<TId>[] = [];
	for (let i = 0; i < topK.indices.length; i += 1) {
		const row = topK.indices[i] ?? 0;
		hits.push({ id: index.ids[row] as TId, score: topK.scores[i] ?? 0 });
	}
	return hits;
}
