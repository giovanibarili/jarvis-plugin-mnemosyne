import type { LLMClient } from "../extractor";
import type { ClassifiedCandidate } from "../types";
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

export interface EncoderV12Result {
  skipped: boolean;
  skipReason?: string;
  memories: EncodedMemory[];
  intraTurnEdges: IntraTurnEdge[];
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

  async process(turn: string, sessionId: string): Promise<EncoderV12Result> {
    // Step 1: Triage
    const triage = await this.triage.evaluate(turn);
    if (!triage.worth_extracting) {
      return {
        skipped: true,
        skipReason: triage.reason,
        memories: [],
        intraTurnEdges: [],
      };
    }

    // Step 2: Classify
    const classified = await this.classify.run(turn, triage.reason);

    // Step 2b: Gate each candidate
    const finalCandidates: ClassifiedCandidate[] = [];
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
      if (outcome.finalCandidate) finalCandidates.push(outcome.finalCandidate);
    }

    if (finalCandidates.length === 0) {
      return {
        skipped: true,
        skipReason: "all_candidates_dropped",
        memories: [],
        intraTurnEdges: [],
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

    return { skipped: false, memories, intraTurnEdges };
  }
}
