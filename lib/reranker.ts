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
 *   base = confidence*Wc + reinforcements*Wf + graphDistance*Wg
 *
 * Semantic gate (sim penalty):
 *   When vectorSim is available and strongly negative (< -0.15), the score is
 *   penalised proportionally. This prevents high-confidence memories from being
 *   injected when the embedder itself signals no semantic overlap.
 *
 *   simFactor = clamp(1 + sim, 0, 1)   → sim=-0.30 → factor=0.70
 *                                        → sim=-1.0  → factor=0.0 (blocked)
 *                                        → sim≥0     → factor=1.0 (no penalty)
 *
 *   Only applied when sim < SIM_PENALTY_FLOOR (-0.15); above that, no penalty
 *   (avoids penalising short-query hits that legitimately score 0..0.15).
 *
 * NOTE: recency intentionally excluded. Recency is a decay signal for
 * promotion/consolidation — not a relevance signal for query matching.
 * Including it caused fresh-but-unrelated memories to pass score_threshold
 * (e.g. query "oi" injecting deposit-platform memories with sim -0.5).
 *
 * Weights come from config (see architecture.md).
 */

const SIM_PENALTY_FLOOR = -0.15;

export class Reranker {
  constructor(private weights: RerankWeights) {}

  rerank(hits: RetrievalHit[]): RetrievalHit[] {
    const scored = hits.map((hit) => {
      const confidence = hit.memory.confidence;
      const reinforcements = Math.min(hit.memory.reinforcements / 10, 1);
      const graphDistance = hit.source === "graph" ? 0.5 : 1.0;
      const base =
        confidence * this.weights.confidence +
        reinforcements * this.weights.reinforcements +
        graphDistance * this.weights.graph_distance;

      // Apply sim penalty only when sim is significantly negative.
      // Graph hits have no vectorSim — skip penalty for them.
      const sim = hit.vectorSim;
      const simFactor =
        sim != null && sim < SIM_PENALTY_FLOOR
          ? Math.max(0, 1 + sim)   // sim=-0.30 → 0.70; sim=-1.0 → 0.0
          : 1.0;

      const score = base * simFactor;

      return {
        ...hit,
        score,
        scoreBreakdown: {
          recency: 0,  // kept for backward compat with HUD breakdown display
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
