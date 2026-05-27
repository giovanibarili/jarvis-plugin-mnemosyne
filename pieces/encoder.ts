import type { Piece, EventBus } from "@jarvis/core";
import type { TurnContext } from "../lib/types";
import type { MnemosyneStore } from "../lib/store";
import type { Logger } from "../lib/logger";
import type { EncoderV12, EncodedMemory } from "../lib/v12/encoder-v12";
import type { RelatePiece } from "./relate";

export interface EncoderV12Hook {
  encoder: EncoderV12;
  relatePiece?: RelatePiece;
}

/**
 * EncoderPiece — async sink for completed turns.
 *
 * Pipeline: triage → classify → gate → store → relate (cross-store).
 * For force-encoded turns (force_store set): bypasses triage/classify/gate,
 * writes directly with confidence=1.0, then relate as usual.
 *
 * Concurrency: single in-flight turn at a time per instance (FIFO queue).
 */
export class EncoderPiece implements Piece {
  id = "mnemosyne-encoder";
  name = "Mnemosyne Encoder";
  private queue: TurnContext[] = [];
  private processing = false;

  private _stats = {
    turnsProcessed: 0,
    turnsSkipped: 0,
    turnsErrored: 0,
    candidatesEmitted: 0,
    memoriesWritten: 0,
    memoriesDeduped: 0,
    costUsd: 0,
    categoriesCount: {} as Record<string, number>,
    pipeline: {
      triage:   { calls: 0, costUsd: 0 },
      classify: { calls: 0, costUsd: 0 },
      enrich:   { calls: 0, costUsd: 0 },
      relate:   { calls: 0, costUsd: 0 },
    },
  };
  private _activeStep: "triage" | "classify" | "enrich" | "relate" | null = null;

  constructor(
    private store: MnemosyneStore,
    private logger: Logger,
    private v12: EncoderV12Hook
  ) {}

  setV12Hook(hook: EncoderV12Hook): void {
    this.v12 = hook;
  }

  getStats() {
    return {
      ...this._stats,
      queueDepth: this.queue.length,
      processing: this.processing,
      activeStep: this._activeStep,
      categoriesCount: { ...this._stats.categoriesCount },
      pipeline: {
        triage:   { ...this._stats.pipeline.triage },
        classify: { ...this._stats.pipeline.classify },
        enrich:   { ...this._stats.pipeline.enrich },
        relate:   { ...this._stats.pipeline.relate },
      },
    };
  }

  async start(_bus: EventBus): Promise<void> {}

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
          this._stats.turnsErrored++;
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

    // ── Normal path: triage (optional) → classify → gate → store → relate ─
    const turnText = [
      turn.user_message ? `User: ${turn.user_message}` : "",
      turn.assistant_response ? `Assistant: ${turn.assistant_response}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await this.v12.encoder.process(
      turnText,
      turnId,
      (step) => { this._activeStep = step; },
      turn.skip_triage === true
    );
    this._activeStep = null;
    this._stats.turnsProcessed++;

    // Accumulate per-step spend
    const spend = result.spend;
    if (spend) {
      this._stats.costUsd += spend.total;
      this._stats.pipeline.triage.calls++;
      this._stats.pipeline.triage.costUsd += spend.triage;
      if (spend.classify > 0 || !result.skipped) {
        this._stats.pipeline.classify.calls++;
        this._stats.pipeline.classify.costUsd += spend.classify;
      }
      if (spend.enrich != null && spend.enrich > 0) {
        this._stats.pipeline.enrich.calls++;
        this._stats.pipeline.enrich.costUsd += spend.enrich;
      }
      if (spend.relate > 0) {
        this._stats.pipeline.relate.calls++;
        this._stats.pipeline.relate.costUsd += spend.relate;
      }
    }

    if (result.skipped) {
      this._stats.turnsSkipped++;
      return;
    }

    this._stats.memoriesWritten += result.memories.length;
    this._stats.candidatesEmitted += result.memories.length;
    for (const m of result.memories) {
      this._stats.categoriesCount[m.category] =
        (this._stats.categoriesCount[m.category] ?? 0) + 1;
    }

    if (this.v12.relatePiece) {
      const siblingIds = result.memories.map((m: EncodedMemory) => m.id);
      for (const m of result.memories) {
        this.v12.relatePiece
          .handleNewMemory({
            id: m.id,
            title: m.title,
            content: m.content,
            evidence: m.evidence,
            origin: m.origin_source,
            createdAt: m.created_at,
            category: m.category,
            siblingIds,
          })
          .catch((err: unknown) => {
            console.error("[mnemosyne] relate failed:", err);
          });
      }
    }
  }
}
