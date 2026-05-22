import type { LLMClient } from "../extractor";
import type { ClassifiedCandidate } from "../types";
import type { Logger } from "../logger";
import { CategoryCatalog } from "./category-catalog";
import { PendingCategoriesStore } from "./pending-categories-store";
import { TriageV12 } from "./triage";
import { ClassifyV12 } from "./classify";
import { CategoryGate, GateConfig } from "./category-gate";
import { RelateJudge } from "./relate-judge";
import { IntraTurnRelate, MemoryNode, IntraTurnEdge } from "./intra-turn-relate";

export interface EncodedMemory extends ClassifiedCandidate {
  id: string;
  session_id: string;
  created_at: string;
  origin_source: string;
}

export interface EncoderV12Sink {
  write(memory: EncodedMemory): Promise<{ id: string }>;
}

export interface PipelineSpend {
  triage: number;
  classify: number;
  relate: number;
  total: number;
}

export interface EncoderV12Result {
  skipped: boolean;
  skipReason?: string;
  memories: EncodedMemory[];
  intraTurnEdges: IntraTurnEdge[];
  spend: PipelineSpend;
}

export interface EncoderV12Opts {
  llm: LLMClient;
  catalog: CategoryCatalog;
  pending: PendingCategoriesStore;
  sink: EncoderV12Sink;
  promptPaths: { triage: string; classify: string; relate: string };
  classifyCfg: { model: string; maxCandidates: number };
  gateCfg: GateConfig;
  intraTurnCfg: { maxPairs: number };
  model: string;
  logger?: Logger;
}

export class EncoderV12 {
  private readonly triage: TriageV12;
  private readonly classify: ClassifyV12;
  private readonly gate: CategoryGate;
  private readonly intraTurn: IntraTurnRelate;

  constructor(private readonly opts: EncoderV12Opts) {
    this.triage = new TriageV12(opts.llm, opts.promptPaths.triage, opts.model);
    this.classify = new ClassifyV12(
      opts.llm,
      opts.promptPaths.classify,
      opts.catalog,
      opts.classifyCfg.model,
      opts.classifyCfg.maxCandidates,
    );
    this.gate = new CategoryGate(opts.catalog, opts.pending, this.classify, opts.gateCfg);
    const judge = new RelateJudge(opts.llm, opts.promptPaths.relate, opts.model);
    this.intraTurn = new IntraTurnRelate(judge, opts.intraTurnCfg);
  }

  async process(
    turn: string,
    sessionId: string,
    onStep?: (step: "triage" | "classify" | "relate") => void
  ): Promise<EncoderV12Result> {
    // Step 1: Triage
    onStep?.("triage");
    const triage = await this.triage.evaluate(turn);
    const triageCost = triage.costUsd ?? 0;

    if (!triage.worth_extracting) {
      await this.opts.logger?.logExtraction({
        turn_id: sessionId,
        pass: 2,
        pipeline_version: "1.2",
        categories: [],
        candidates_emitted: 0,
        classify_candidates: 0,
        new_categories_proposed: 0,
        materialized: [],
        intra_turn_edges: 0,
        confidence_avg: 0,
        cost_usd: triageCost,
        skip_reason: triage.reason,
      });
      return {
        skipped: true,
        skipReason: triage.reason,
        memories: [],
        intraTurnEdges: [],
        spend: { triage: triageCost, classify: 0, relate: 0, total: triageCost },
      };
    }

    // Step 2: Classify
    onStep?.("classify");
    const classified = await this.classify.run(turn, triage.reason);
    const classifyCost = classified.costUsd ?? 0;

    // Step 2b: Gate each candidate
    const finalCandidates: ClassifiedCandidate[] = [];
    const materializedSlugs: string[] = [];
    for (const cand of classified.candidates) {
      if (!cand.is_new_category) {
        finalCandidates.push(cand);
        continue;
      }
      const proposal =
        classified.new_categories.find((n) => n.id === cand.category) ?? {
          id: cand.category,
          description: "",
          hint: "",
          extractor_template: "",
        };
      const outcome = await this.gate.handle(proposal, cand, turn, triage.reason);
      if (outcome.materialized) materializedSlugs.push(proposal.id);
      if (outcome.finalCandidate) finalCandidates.push(outcome.finalCandidate);
    }

    if (finalCandidates.length === 0) {
      const totalCost = triageCost + classifyCost;
      await this.opts.logger?.logExtraction({
        turn_id: sessionId,
        pass: 2,
        pipeline_version: "1.2",
        categories: [],
        candidates_emitted: 0,
        classify_candidates: classified.candidates.length,
        new_categories_proposed: classified.new_categories.length,
        materialized: materializedSlugs,
        intra_turn_edges: 0,
        confidence_avg: 0,
        cost_usd: totalCost,
        skip_reason: "all_candidates_dropped",
      });
      return {
        skipped: true,
        skipReason: "all_candidates_dropped",
        memories: [],
        intraTurnEdges: [],
        spend: { triage: triageCost, classify: classifyCost, relate: 0, total: totalCost },
      };
    }

    // Step 3: Persist
    const now = new Date().toISOString();
    const memories: EncodedMemory[] = [];
    for (const c of finalCandidates) {
      const draft: EncodedMemory = {
        ...c,
        id: `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        session_id: sessionId,
        created_at: now,
        origin_source: "user",
      };
      const written = await this.opts.sink.write(draft);
      memories.push({ ...draft, id: written.id });
    }

    // Step 3b: Intra-turn relate
    onStep?.("relate");
    const nodes: MemoryNode[] = memories.map((m) => ({
      id: m.id,
      title: m.title,
      content: m.content,
      evidence: m.evidence,
      origin: m.origin_source,
      createdAt: m.created_at,
      category: m.category,
    }));
    const intraTurnEdges = await this.intraTurn.relate(nodes);
    const relateCost = (this.intraTurn as any).lastCostUsd ?? 0;

    const totalCost = triageCost + classifyCost + relateCost;
    const spend: PipelineSpend = { triage: triageCost, classify: classifyCost, relate: relateCost, total: totalCost };
    const result: EncoderV12Result = { skipped: false, memories, intraTurnEdges, spend };

    await this.opts.logger?.logExtraction({
      turn_id: sessionId,
      pass: 2,
      pipeline_version: "1.2",
      categories: result.memories.map((m) => m.category),
      candidates_emitted: result.memories.length,
      classify_candidates: classified.candidates.length,
      new_categories_proposed: classified.new_categories.length,
      materialized: materializedSlugs,
      intra_turn_edges: result.intraTurnEdges.length,
      confidence_avg:
        result.memories.length > 0
          ? result.memories.reduce((s, m) => s + m.confidence, 0) / result.memories.length
          : 0,
      cost_usd: totalCost,
      skip_reason: null,
    });

    return result;
  }
}
