import type { RetrievalHit } from "./types";

export interface RerankWeights {
  confidence: number;
  reinforcements: number;
  graph_distance: number;
}

/**
 * Reranker — combines relevance signals into a single score and sorts hits desc.
 *
 * Signals (all about intrinsic memory quality / retrieval source):
 *   confidence     = hit.memory.confidence          // 0..1, extractor confidence
 *   reinforcements = min(reinforcements/10, 1)      // saturates at 10, historical relevance
 *   graphDistance  = hit.source === "graph" ? 0.5 : 1.0  // vector hits rank higher
 *
 *   score = confidence*Wc + reinforcements*Wf + graphDistance*Wg
 *
 * NOTE: recency intentionally excluded. Recency is a decay signal for
 * promotion/consolidation — not a relevance signal for query matching.
 * Including it caused fresh-but-unrelated memories to pass score_threshold
 * (e.g. query "oi" injecting deposit-platform memories with sim -0.5).
 *
 * Weights come from config (see architecture.md).
 */
export class Reranker {
  constructor(private weights: RerankWeights) {}

  rerank(hits: RetrievalHit[]): RetrievalHit[] {
    const scored = hits.map((hit) => {
      const confidence = hit.memory.confidence;
      const reinforcements = Math.min(hit.memory.reinforcements / 10, 1);
      const graphDistance = hit.source === "graph" ? 0.5 : 1.0;
      const score =
        confidence * this.weights.confidence +
        reinforcements * this.weights.reinforcements +
        graphDistance * this.weights.graph_distance;
      return {
        ...hit,
        score,
        scoreBreakdown: {
          recency: 0,  // kept in shape for backward compat with HUD breakdown display
          confidence,
          reinforcements,
          graphDistance,
          total: score,
        },
      };
    });
    return scored.sort((a, b) => b.score - a.score);
  }
}
