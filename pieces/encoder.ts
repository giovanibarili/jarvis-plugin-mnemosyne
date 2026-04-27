import type { Piece, EventBus } from "@jarvis/core";
import { v4 as uuid } from "uuid";
import type { TurnContext, Memory, MemoryCandidate } from "../lib/types";
import type { Extractor } from "../lib/extractor";
import type { MnemosyneStore } from "../lib/store";
import type { Logger } from "../lib/logger";

/**
 * EncoderPiece — async sink for completed turns. Runs the two-pass extractor,
 * dedup-checks each candidate against the markdown canonical store, then
 * delegates atomic writes (markdown + chroma + neo4j) to MnemosyneStore.
 *
 * Concurrency: a single in-flight `processTurn` at a time per encoder
 * instance. Turns are FIFO-queued via `enqueue`; subsequent enqueues while a
 * turn is processing are picked up when the loop drains. This bounds LLM
 * spend and avoids racing on dedup reads/writes.
 *
 * Logging: one `extraction.log` entry per turn at pass=2 — captures triage
 * categories, candidates emitted, average confidence, llm cost, and any skip
 * reason from triage. Errors during processing emit a pass=1 entry with
 * `skip_reason: "error: <msg>"`.
 */
export class EncoderPiece implements Piece {
  id = "mnemosyne-encoder";
  name = "Mnemosyne Encoder";
  private queue: TurnContext[] = [];
  private processing = false;

  constructor(
    private extractor: Extractor,
    private store: MnemosyneStore,
    private logger: Logger
  ) {}

  async start(_bus: EventBus): Promise<void> {
    // Encoder receives turns via direct call (Observer.onTurnComplete -> this.enqueue)
  }

  async stop(): Promise<void> {
    while (this.queue.length || this.processing) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  enqueue(turn: TurnContext): void {
    this.queue.push(turn);
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const turn = this.queue.shift()!;
        try {
          await this.processTurn(turn);
        } catch (e) {
          await this.logger.logExtraction({
            turn_id: `${turn.session_id}-${turn.timestamp}`,
            pass: 1,
            skip_reason: `error: ${e}`,
          });
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async processTurn(turn: TurnContext): Promise<void> {
    const turnId = `${turn.session_id}-${turn.timestamp}`;
    const result = await this.extractor.extract(turn);

    await this.logger.logExtraction({
      turn_id: turnId,
      pass: 2,
      categories: result.triage.present,
      candidates_emitted: result.candidates.length,
      confidence_avg: result.candidates.length
        ? result.candidates.reduce((s, c) => s + c.confidence, 0) /
          result.candidates.length
        : 0,
      cost_usd: result.costUsd,
      skip_reason: result.triage.skip_reason,
    });

    for (const cand of result.candidates) {
      const mem = this.candidateToMemory(cand, turn);
      // Dedup: same category + title + content already stored → skip
      if (await this.exists(mem)) continue;
      await this.store.write(mem);
    }

    if (result.workflow) {
      // Workflow persistence handled in Task 8
    }
  }

  private candidateToMemory(cand: MemoryCandidate, turn: TurnContext): Memory {
    return {
      id: uuid(),
      category: cand.category,
      title: cand.title,
      content: cand.content,
      tags: cand.tags,
      project: cand.project,
      confidence: cand.confidence,
      reinforcements: 0,
      visibility: cand.visibility,
      pinned: false,
      created_at: Date.now(),
      last_accessed: Date.now(),
      source_session: turn.session_id,
      promoted_at: null,
      evidence: cand.evidence,
    };
  }

  private async exists(mem: Memory): Promise<boolean> {
    const all = await this.store.markdownStore.list({ category: mem.category });
    return all.some((m) => m.title === mem.title && m.content === mem.content);
  }
}
