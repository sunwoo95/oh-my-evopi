/**
 * `@evopi/mnemopi` — the native-accelerated memory kernels backported from
 * oh-my-pi's mnemopi package (M7, 등급 B).
 *
 * Scope: the three N-API kernels (`mmrRerankIndices`, `vectorIndexTopK`,
 * `cosineSimilarityPairs`) and their in-memory store surface — MMR reranking,
 * the exact cosine vector index, and cosine connected-component clustering —
 * all routed through {@link module:@evopi/pi-natives-loader} with pure-TS
 * fallbacks. The SQLite-backed SHMR harmonize/beliefs surface depends on
 * `bun:sqlite` and is deferred (Q1: `bun:sqlite` → `node:sqlite`); the MCP
 * server is a v2 concern.
 */

export { hasNatives } from "@evopi/pi-natives-loader";
export { jaccardSimilarity, type MmrResult, mmrRerank, type SimilarityFn } from "./core/mmr.js";
export { clusterByCosineSimilarity } from "./core/similarity-clusters.js";
export {
	buildExactVectorIndex,
	type ExactVectorIndex,
	type ExactVectorSearchHit,
	searchExactVectorIndex,
	type VectorIndexRow,
} from "./core/vector-index.js";
export { cosineSimilarity } from "./core/vector-math.js";
