import type { RelateRelation } from "../types";
import type { RelateJudge, RelatePayload } from "./relate-judge";

export interface MemoryNode extends RelatePayload {
  id: string;
}

export interface IntraTurnEdge {
  from: string;
  to: string;
  relation: RelateRelation;
  confidence: number;
  reason: string;
}

export interface IntraTurnConfig {
  maxPairs: number;
}

export class IntraTurnRelate {
  constructor(
    private readonly judge: RelateJudge,
    private readonly cfg: IntraTurnConfig,
  ) {}

  async relate(memories: MemoryNode[]): Promise<IntraTurnEdge[]> {
    if (memories.length < 2) return [];
    const edges: IntraTurnEdge[] = [];
    let pairs = 0;
    outer: for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        if (pairs >= this.cfg.maxPairs) break outer;
        const a = memories[i];
        const b = memories[j];
        const verdict = await this.judge.judge(a, b);
        pairs++;
        if (verdict.relation === "unrelated") continue;
        edges.push({
          from: a.id,
          to: b.id,
          relation: verdict.relation,
          confidence: verdict.confidence,
          reason: verdict.reason,
        });
      }
    }
    return edges;
  }
}
