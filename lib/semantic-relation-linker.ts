import { promises as fs } from "fs";
import { join } from "path";
import type { Memory } from "./types";
import type { LLMClient } from "./extractor";
import type { ChromaAdapter } from "./chroma-adapter";
import type { Neo4jAdapter } from "./neo4j-adapter";

export type RelationVerdict =
  | "reinforces"
  | "extends"
  | "example-of"
  | "depends-on"
  | "unrelated";

export interface SemanticRelationLinkerConfig {
  /** Cosine similarity threshold (1 - distance) to consider a candidate */
  similarityThreshold: number;
  /** How many Chroma neighbours to inspect per memory */
  topK: number;
  /** Directory containing relate-judge.md */
  promptsDir: string;
}

/**
 * Pass 3 — Semantic Relation Linking.
 *
 * After a new memory is written (markdown + chroma + neo4j), this linker
 * queries both short- and long-term Chroma collections for similar memories,
 * asks the LLM to classify the semantic relation for each candidate, and
 * persists non-trivial relations as directed RELATES_TO edges in Neo4j.
 *
 * Design mirrors ConflictDetector: same constructor shape (llm + chroma +
 * neo4j + config), same query-filter-judge-persist loop. Only the edge type
 * and prompt differ.
 */
export class SemanticRelationLinker {
  private prompt?: string;

  constructor(
    private llm: LLMClient,
    private chroma: ChromaAdapter,
    private neo4j: Neo4jAdapter,
    private config: SemanticRelationLinkerConfig
  ) {}

  private async loadPrompt(): Promise<string> {
    if (!this.prompt) {
      this.prompt = await fs.readFile(
        join(this.config.promptsDir, "relate-judge.md"),
        "utf-8"
      );
    }
    return this.prompt;
  }

  /**
   * Find semantically similar memories (short + long), classify each relation,
   * and persist RELATES_TO edges for non-trivial verdicts.
   * Returns the list of (targetId, relation) pairs that were linked.
   */
  async linkRelations(
    memory: Memory
  ): Promise<Array<{ targetId: string; relation: RelationVerdict }>> {
    const linked: Array<{ targetId: string; relation: RelationVerdict }> = [];

    // Query both layers — new memory may be short-term, but we want to link
    // to existing long-term knowledge too.
    const [shortHits, longHits] = await Promise.all([
      this.chroma.query("short", memory.content, this.config.topK),
      this.chroma.query("long", memory.content, this.config.topK),
    ]);

    // Deduplicate hits across layers, exclude self
    const seen = new Set<string>();
    const candidates = [...shortHits, ...longHits].filter((h) => {
      if (h.id === memory.id) return false;
      if (1 - h.distance < this.config.similarityThreshold) return false;
      if (seen.has(h.id)) return false;
      seen.add(h.id);
      return true;
    });

    for (const cand of candidates) {
      const candMem = await this.neo4j.getMemory(cand.id);
      if (!candMem) continue;

      const verdict = await this.judge(memory, candMem);
      if (verdict === "unrelated") continue;

      await this.neo4j.createRelatesToEdge(
        memory.id,
        candMem.id,
        verdict,
        1 - cand.distance
      );
      linked.push({ targetId: candMem.id, relation: verdict });
    }

    return linked;
  }

  private async judge(a: Memory, b: Memory): Promise<RelationVerdict> {
    const prompt = (await this.loadPrompt())
      .replace("{{A}}", `[${a.category}] ${a.title}: ${a.content}`)
      .replace("{{B}}", `[${b.category}] ${b.title}: ${b.content}`);

    const raw = await this.llm.call({
      system: prompt,
      user: "Judge.",
      maxTokens: 200,
    });

    try {
      const cleaned = raw
        .replace(/^```json\n?/, "")
        .replace(/\n?```$/, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      return parsed.relation as RelationVerdict;
    } catch {
      // If LLM output is malformed, treat as unrelated — safe default
      return "unrelated";
    }
  }
}
