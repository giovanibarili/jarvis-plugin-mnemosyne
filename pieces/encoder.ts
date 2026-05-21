import type { Piece, EventBus } from "@jarvis/core";
import { v4 as uuid } from "uuid";
import type {
  TurnContext,
  Memory,
  MemoryCandidate,
  Workflow,
} from "../lib/types";
import type { Extractor } from "../lib/extractor";
import type { MnemosyneStore } from "../lib/store";
import type { Logger } from "../lib/logger";
import type { SemanticRelationLinker } from "../lib/semantic-relation-linker";
import type { EncoderV12, EncodedMemory } from "../lib/v12/encoder-v12";
import type { RelatePiece } from "./relate";

/**
 * Optional v1.2 TRIPLET pipeline hook. When provided, `processTurn` delegates
 * to `encoderV12.process` instead of running the v1.1 Extractor path. Each
 * memory written by EncoderV12 is then handed off to `relatePiece` (if any)
 * as an async fire-and-forget cross-store relate pass.
 *
 * Both fields are optional: v12.encoder alone runs the new triage/classify/
 * gate pipeline; v12.relatePiece adds the cross-store judge step on top.
 */
export interface EncoderV12Hook {
  encoder: EncoderV12;
  relatePiece?: RelatePiece;
}

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

  // ── Session-scoped counters (zeroed on boot, exposed via getStats) ─────
  // We keep these locally instead of recomputing from the extraction.log
  // every time the panel polls — the log can grow to thousands of entries
  // and reading it on every 30s tick wastes IO. The log remains the source
  // of truth for historical aggregates (skip-reason buckets, cost / day);
  // these counters cover the "since boot" reading that the HUD shows live.
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
    private extractor: Extractor,
    private store: MnemosyneStore,
    private logger: Logger,
    private relationLinker?: SemanticRelationLinker,
    private v12?: EncoderV12Hook
  ) {}

  /**
   * Inject (or replace) the v1.2 pipeline hook after construction. Used by
   * the bootstrap when the feature flag is on but EncoderPiece was already
   * instantiated up the file. Calling with `undefined` falls back to v1.1.
   */
  setV12Hook(hook: EncoderV12Hook | undefined): void {
    this.v12 = hook;
  }

  /** True when the v1.2 TRIPLET path will run for incoming turns. */
  isV12Enabled(): boolean {
    return this.v12?.encoder !== undefined;
  }

  /** Snapshot of session-scoped encoder stats. Read-only — callers should
   *  treat the returned object as immutable. We expose categoriesCount as a
   *  shallow copy so consumers can iterate without races during increment. */
  getStats() {
    return {
      ...this._stats,
      queueDepth: this.queue.length,
      processing: this.processing,
      categoriesCount: { ...this._stats.categoriesCount },
    };
  }

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
    // v1.2 TRIPLET — delegate the full triage→classify→gate→relate pipeline
    // to EncoderV12. v12 owns its own logging (extraction.log with
    // pipeline_version=\"1.2\") and updates session-scoped counters via the
    // sink callback. The v1.1 stats fields are still bumped so the HUD keeps
    // working — they map cleanly onto v12's notion of \"turn processed\".
    if (this.v12?.encoder) {
      await this.processTurnV12(turn);
      return;
    }

    const turnId = `${turn.session_id}-${turn.timestamp}`;
    const result = await this.extractor.extract(turn);

    // ── stats: every completed extraction counts as one turn processed.
    // Skip vs success is determined by skip_reason presence, mirroring the
    // log's pass=2 semantics. We tally categories from the triage output
    // (not from emitted candidates) so the HUD reflects what the model SAW
    // even when dedup later drops the candidate.
    this._stats.turnsProcessed++;
    this._stats.costUsd += result.costUsd ?? 0;
    this._stats.candidatesEmitted += result.candidates.length;
    if (result.triage.skip_reason) this._stats.turnsSkipped++;
    for (const cat of result.triage.present ?? []) {
      this._stats.categoriesCount[cat] = (this._stats.categoriesCount[cat] ?? 0) + 1;
    }

    // Audit: a turn that birthed a brand-new category gets its own log line so
    // the operator can review what the model invented and prune if needed.
    if (result.newPromptsGenerated?.length) {
      await this.logger.logExtraction({
        turn_id: turnId,
        pass: 2,
        categories: result.newPromptsGenerated,
        candidates_emitted: 0,
        confidence_avg: 0,
        cost_usd: 0,
        skip_reason: `new categories authored: ${result.newPromptsGenerated.join(", ")}`,
      });
    }

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
      if (await this.exists(mem)) {
        this._stats.memoriesDeduped++;
        continue;
      }
      await this.store.write(mem);
      this._stats.memoriesWritten++;

      // Pass 3 — Semantic relation linking.
      // Runs after write so mem.id is stable and the Neo4j node exists.
      // Fire-and-forget: errors are swallowed so a linker failure never
      // blocks the encoder pipeline.
      if (this.relationLinker) {
        this.relationLinker.linkRelations(mem).catch((err) => {
          console.error("[mnemosyne] semantic-relation-linker failed:", err);
        });
      }
    }

    if (result.workflow) {
      const wf: Workflow = {
        id: uuid(),
        name: result.workflow.workflow.name,
        description: result.workflow.workflow.description ?? "",
        trigger: result.workflow.workflow.trigger,
        outcome: result.workflow.workflow.outcome,
        applies_to_project: result.workflow.workflow.applies_to_project,
        steps: result.workflow.workflow.steps.map((s) => ({
          ...s,
          id: uuid(),
        })),
        branches: result.workflow.workflow.branches ?? [],
        confidence: result.workflow.workflow.confidence,
        reinforcements: 0,
        created_at: Date.now(),
        last_used: Date.now(),
      };
      await this.store.neo4j.upsertWorkflow(wf);
      // Index in Chroma for semantic retrieval — best-effort, never blocks the save.
      // ChromaAdapter may not have the method yet in older installs — skip silently
      // when absent, but propagate genuine failures when the method exists.
      const chromaUpsertWorkflow = (this.store.chroma as any).upsertWorkflow;
      if (typeof chromaUpsertWorkflow === "function") {
        await chromaUpsertWorkflow.call(this.store.chroma, wf);
      }
    }
  }

  /**
   * v1.2 TRIPLET path. Builds a single \"turn\" string from the user/assistant
   * pair (matching how the v1.2 prompts are written — they expect a single
   * conversational blob, not a structured turn object), then delegates to
   * EncoderV12. After persistence, each materialised memory is forwarded to
   * RelatePiece (if present) as a fire-and-forget cross-store relate pass.
   *
   * Stats: we bump the v1.1 session-scoped counters (turnsProcessed,
   * memoriesWritten, ...) so the HUD shows live numbers regardless of which
   * pipeline ran. v12's own extraction.log entries carry pipeline_version=\"1.2\"
   * so historical reads remain unambiguous.
   */
  private async processTurnV12(turn: TurnContext): Promise<void> {
    const v12 = this.v12!;
    const turnId = `${turn.session_id}-${turn.timestamp}`;
    // Build the conversational blob the v12 prompts expect. We include the
    // assistant response because the triage prompt is trained on full
    // exchanges; user-only would systematically under-trigger.
    const turnText = [
      turn.user_message ? `User: ${turn.user_message}` : "",
      turn.assistant_response ? `Assistant: ${turn.assistant_response}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await v12.encoder.process(turnText, turnId);
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

    // Cross-store relate (Step 4). Fire-and-forget — failures inside the
    // judge must not block subsequent turns.
    if (v12.relatePiece) {
      const siblingIds = result.memories.map((m: EncodedMemory) => m.id);
      for (const m of result.memories) {
        v12.relatePiece
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
            console.error("[mnemosyne] v12 relate-piece failed:", err);
          });
      }
    }
  }

  /**
   * Detect where the evidence signal came from within the turn.
   *
   * Priority:
   *   1. tool  — evidence overlaps a tool result (file path, URL, bash output)
   *   2. user  — evidence overlaps the user message (explicit statement)
   *   3. assistant — fallback (inferred by the assistant)
   *
   * For tool origins we also extract the primary reference (path/URL) from args.
   */
  private detectOrigin(
    evidence: string,
    turn: TurnContext
  ): Pick<Memory, "origin_source" | "origin_tool" | "origin_ref"> {
    const ev = (evidence ?? "").toLowerCase();

    // 1. Check tool results
    for (const tc of turn.tool_calls ?? []) {
      const result = JSON.stringify(tc.result ?? "").toLowerCase();
      const args = tc.args ?? {};
      // Evidence text appears in tool result → tool origin
      const snippet = ev.slice(0, 80);
      if (snippet && result.includes(snippet.toLowerCase())) {
        const ref =
          args.path ?? args.url ?? args.command ?? args.file_path ?? args.query ?? undefined;
        return {
          origin_source: "tool",
          origin_tool: tc.tool,
          origin_ref: typeof ref === "string" ? ref : undefined,
        };
      }
    }

    // 2. Evidence overlaps user message → user (highest trust)
    const userMsg = (turn.user_message ?? "").toLowerCase();
    if (ev && userMsg.includes(ev.slice(0, 60).toLowerCase())) {
      return { origin_source: "user" };
    }

    // 3. Fallback — assistant inferred
    return { origin_source: "assistant" };
  }

  private candidateToMemory(cand: MemoryCandidate, turn: TurnContext): Memory {
    const origin = this.detectOrigin(cand.evidence ?? "", turn);
    // User-stated facts get a confidence boost (they are explicit, not inferred)
    const confidence =
      origin.origin_source === "user"
        ? Math.min(1.0, cand.confidence + 0.05)
        : cand.confidence;

    return {
      id: uuid(),
      category: cand.category,
      title: cand.title,
      content: cand.content,
      tags: cand.tags,
      project: cand.project,
      confidence,
      reinforcements: 0,
      visibility: cand.visibility,
      pinned: false,
      created_at: Date.now(),
      last_accessed: Date.now(),
      source_session: turn.session_id,
      promoted_at: null,
      evidence: cand.evidence,
      ...origin,
    };
  }

  private async exists(mem: Memory): Promise<boolean> {
    const all = await this.store.markdownStore.list({ category: mem.category });
    // Exact match (fast path)
    if (all.some((m) => m.title === mem.title && m.content === mem.content)) return true;
    // Title-similarity match: same category + title within 1 edit-distance word
    // (handles LLM paraphrasing the title slightly, e.g. bilingual separator differences)
    const normalise = (s: string) => s.toLowerCase().replace(/[\\\/|]/g, "").replace(/\s+/g, " ").trim();
    const newTitle = normalise(mem.title);
    if (all.some((m) => normalise(m.title) === newTitle)) return true;
    // Keyword overlap: if 3+ significant words from the new title appear in an existing
    // title of the same category, treat as duplicate.
    const keywords = newTitle.split(" ").filter((w) => w.length > 4);
    if (keywords.length >= 2) {
      const matches = all.filter((m) => {
        const existing = normalise(m.title);
        const hits = keywords.filter((k) => existing.includes(k)).length;
        return hits >= Math.min(3, keywords.length);
      });
      if (matches.length > 0) return true;
    }
    return false;
  }
}
