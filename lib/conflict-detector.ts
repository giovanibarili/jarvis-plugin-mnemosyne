import { promises as fs } from "fs";
import { join } from "path";
import type { Memory } from "./types";
import type { LLMClient } from "./extractor";
import type { ChromaAdapter } from "./chroma-adapter";
import type { Neo4jAdapter } from "./neo4j-adapter";

export interface ConflictDetectorConfig {
  similarityThreshold: number;
  promptsDir: string;
}

export type ConflictVerdict = "yes" | "context" | "no";

/**
 * D6 — Conflict detection with "keep both" strategy.
 *
 * For a given memory, finds semantically similar long-term candidates,
 * asks the LLM to judge each pair, and persists CONTRADICTS edges (in both
 * directions) when the verdict is "yes". Both memories stay in the graph —
 * no merge, no overwrite. The retriever surfaces the conflict at query time.
 */
export class ConflictDetector {
  private prompt?: string;

  constructor(
    private llm: LLMClient,
    private chroma: ChromaAdapter,
    private neo4j: Neo4jAdapter,
    private config: ConflictDetectorConfig
  ) {}

  private async loadPrompt(): Promise<string> {
    if (!this.prompt) {
      this.prompt = await fs.readFile(
        join(this.config.promptsDir, "conflict-judge.md"),
        "utf-8"
      );
    }
    return this.prompt;
  }

  /**
   * Find candidates similar to `memory` in the long-term collection, judge
   * each pair, and persist CONTRADICTS edges for true contradictions.
   * Returns the list of contradicting memory IDs.
   */
  async detectAndPersist(memory: Memory): Promise<{ contradicts: string[] }> {
    const hits = await this.chroma.query("long", memory.content, 5);
    const candidates = hits.filter(
      (h) =>
        h.id !== memory.id &&
        1 - h.distance > this.config.similarityThreshold
    );

    const contradicts: string[] = [];
    for (const cand of candidates) {
      const candMem = await this.neo4j.getMemory(cand.id);
      if (!candMem) continue;
      const verdict = await this.judge(memory, candMem);
      if (verdict === "yes") {
        await this.neo4j.createContradictsEdge(memory.id, candMem.id);
        contradicts.push(candMem.id);
      }
    }
    return { contradicts };
  }

  private async judge(a: Memory, b: Memory): Promise<ConflictVerdict> {
    const prompt = (await this.loadPrompt())
      .replace("{{A}}", `[${a.category}] ${a.title}: ${a.content}`)
      .replace("{{B}}", `[${b.category}] ${b.title}: ${b.content}`);
    const raw = await this.llm.call({
      system: prompt,
      user: "Judge.",
      maxTokens: 200,
    });
    const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed.verdict as ConflictVerdict;
  }
}
