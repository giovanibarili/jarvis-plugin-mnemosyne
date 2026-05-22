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
  };

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
      categoriesCount: { ...this._stats.categoriesCount },
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

    // ── Force-store fast path ─────────────────────────────────────────────
    // Bypasses triage/classify/gate. The caller has already decided this is
    // worth remembering (e.g. mnemosyne_triage tool). confidence=1.0.
    if (turn.force_store) {
      const { force_store: fs } = turn;
      const content = fs.content.trim();
      const title = (fs.title?.trim() || content.slice(0, 80)).trim();
      const category = fs.category?.trim() || "preference";
      const now = new Date().toISOString();

      const draft = {
        id: `${turnId}-${Math.random().toString(36).slice(2, 8)}`,
        session_id: turn.session_id,
        category,
        title,
        content,
        tags: [],
        project: null,
        confidence: 1.0,
        reinforcements: 0,
        visibility: "open" as const,
        pinned: false,
        created_at: Date.now(),
        last_accessed: Date.now(),
        source_session: turn.session_id,
        promoted_at: null,
        evidence: content,
        origin_source: "user" as const,
      };

      const written = await (this.v12.encoder as any)["opts"].sink.write(draft);
      this._stats.turnsProcessed++;
      this._stats.memoriesWritten++;
      this._stats.candidatesEmitted++;
      this._stats.categoriesCount[category] =
        (this._stats.categoriesCount[category] ?? 0) + 1;

      await this.logger.logExtraction({
        turn_id: turnId,
        pass: 2,
        categories: [category],
        candidates_emitted: 1,
        classify_candidates: 0,
        new_categories_proposed: 0,
        materialized: [category],
        intra_turn_edges: 0,
        confidence_avg: 1.0,
        cost_usd: 0,
        skip_reason: null,
      });

      if (this.v12.relatePiece) {
        this.v12.relatePiece
          .handleNewMemory({
            id: written.id,
            title,
            content,
            evidence: content,
            origin: "user",
            createdAt: now,
            category,
            siblingIds: [],
          })
          .catch((err: unknown) => {
            console.error("[mnemosyne] force-store relate failed:", err);
          });
      }
      return;
    }

    // ── Normal path: triage → classify → gate → store → relate ───────────
    const turnText = [
      turn.user_message ? `User: ${turn.user_message}` : "",
      turn.assistant_response ? `Assistant: ${turn.assistant_response}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await this.v12.encoder.process(turnText, turnId);
    this._stats.turnsProcessed++;

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
