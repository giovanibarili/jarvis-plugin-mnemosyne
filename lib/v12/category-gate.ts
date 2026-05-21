import type { ClassifiedCandidate, NewCategoryProposal } from "../types";
import { CategoryCatalog } from "./category-catalog";
import { PendingCategoriesStore } from "./pending-categories-store";
import { ClassifyV12 } from "./classify";

export interface GateConfig {
  minConfidence: number;
  windowDays: number;
  minOccurrences: number;
}

export interface GateOutcome {
  materialized: boolean;
  fallbackInvoked: boolean;
  finalCandidate: ClassifiedCandidate | null;
}

export class CategoryGate {
  constructor(
    private readonly catalog: CategoryCatalog,
    private readonly pending: PendingCategoriesStore,
    private readonly classify: ClassifyV12,
    private readonly cfg: GateConfig,
  ) {}

  async handle(
    proposal: NewCategoryProposal,
    candidate: ClassifiedCandidate,
    turn: string,
    triageReason: string,
  ): Promise<GateOutcome> {
    // Low confidence: skip pending, run fallback immediately
    if (candidate.confidence < this.cfg.minConfidence) {
      return this.fallback(turn, triageReason);
    }

    // High confidence: check/increment pending
    this.pending.register(proposal);
    await this.pending.save();

    const entry = this.pending.get(proposal.id)!;
    if (entry.occurrences >= this.cfg.minOccurrences) {
      // Two-gate passed — materialize
      await this.catalog.materialize(proposal);
      this.pending.remove(proposal.id);
      await this.pending.save();
      return { materialized: true, fallbackInvoked: false, finalCandidate: candidate };
    }

    // First occurrence — fallback for this turn
    const fb = await this.fallback(turn, triageReason);
    return { materialized: false, fallbackInvoked: true, finalCandidate: fb.finalCandidate };
  }

  private async fallback(turn: string, triageReason: string): Promise<GateOutcome> {
    const reclassified = await this.classify.run(
      turn,
      `${triageReason} | constraint: choose ONLY from existing categories`,
    );
    const best = reclassified.candidates
      .filter((c) => !c.is_new_category && this.catalog.has(c.category))
      .sort((a, b) => b.confidence - a.confidence)[0] ?? null;
    return { materialized: false, fallbackInvoked: true, finalCandidate: best };
  }
}
