import type { RelateJudge, RelatePayload } from "../lib/v12/relate-judge";
import type { RelateRelation } from "../lib/types";

export interface RelatePieceCfg {
  topK: number;
  similarityThreshold: number;
  judgeCap: number;
}

export interface NewMemoryEvent extends RelatePayload {
  id: string;
  siblingIds: string[];
}

export interface CrossStoreEdge {
  from: string;
  to: string;
  relation: RelateRelation;
  confidence: number;
  reason: string;
}

export type ChromaQueryFn = (
  m: NewMemoryEvent,
  topK: number,
  threshold: number,
) => Promise<Array<RelatePayload & { id: string }>>;

export type Neo4jWriteEdgeFn = (edge: CrossStoreEdge) => Promise<void>;

export class RelatePiece {
  constructor(
    private readonly deps: {
      judge: RelateJudge;
      chromaQuery: ChromaQueryFn;
      neo4jWriteEdge: Neo4jWriteEdgeFn;
      cfg: RelatePieceCfg;
    },
  ) {}

  async handleNewMemory(m: NewMemoryEvent): Promise<CrossStoreEdge[]> {
    const all = await this.deps.chromaQuery(m, this.deps.cfg.topK, this.deps.cfg.similarityThreshold);
    const sibSet = new Set([m.id, ...m.siblingIds]);
    const candidates = all.filter((c) => !sibSet.has(c.id)).slice(0, this.deps.cfg.judgeCap);
    const edges: CrossStoreEdge[] = [];
    for (const c of candidates) {
      const verdict = await this.deps.judge.judge(m, c);
      if (verdict.relation === "unrelated") continue;
      const edge: CrossStoreEdge = {
        from: m.id,
        to: c.id,
        relation: verdict.relation,
        confidence: verdict.confidence,
        reason: verdict.reason,
      };
      await this.deps.neo4jWriteEdge(edge);
      edges.push(edge);
    }
    return edges;
  }
}
