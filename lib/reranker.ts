import type { RetrievalHit } from "./types";

export interface RerankWeights {
  recency: number;
  confidence: number;
  reinforcements: number;
  graph_distance: number;
}

/**
 * Reranker — combines four signals into a single score and sorts hits desc.
 *
 *   recency        = exp(-ageDays / 30)        // ageDays from last_accessed
 *   confidence     = hit.memory.confidence     // 0..1
 *   reinforcements = min(reinforcements/10, 1) // saturates at 10 reinforcements
 *   graphDistance  = hit.source === "graph" ? 0.5 : 1.0
 *
 *   score = recency*Wr + confidence*Wc + reinforcements*Wf + graphDistance*Wg
 *
 * Weights come from config (see architecture.md). Tuning these is the
 * primary lever for retrieval quality without re-architecting the pipeline.
 */
export class Reranker {
  constructor(private weights: RerankWeights) {}

  rerank(hits: RetrievalHit[]): RetrievalHit[] {
    const now = Date.now();
    const scored = hits.map((hit) => {
      const ageDays = (now - hit.memory.last_accessed) / (1000 * 60 * 60 * 24);
      const recency = Math.exp(-ageDays / 30);
      const confidence = hit.memory.confidence;
      const reinforcements = Math.min(hit.memory.reinforcements / 10, 1);
      const graphDistance = hit.source === "graph" ? 0.5 : 1.0;
      const score =
        recency * this.weights.recency +
        confidence * this.weights.confidence +
        reinforcements * this.weights.reinforcements +
        graphDistance * this.weights.graph_distance;
      return { ...hit, score };
    });
    return scored.sort((a, b) => b.score - a.score);
  }
}
