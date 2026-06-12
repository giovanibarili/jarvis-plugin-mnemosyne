import type { Piece } from "@jarvis/core";
import { EventBus } from "@jarvis/core";
import type { MnemosyneStore } from "../lib/store";
import type { Neo4jAdapter } from "../lib/neo4j-adapter";
import type { Logger } from "../lib/logger";
import type { EncoderPiece } from "./encoder";
import type { RetrieverPiece } from "./retriever";
import type { ConsolidatorPiece } from "./consolidator";
import type { BackgroundReviewPiece } from "./background-review";
import type { WriterStats } from "../lib/tools/memory-primitives";
import type { DomainCatalog, EntityCatalog } from "../lib/catalogs";
import { buildStats } from "../lib/stats";

/**
 * HUD panel piece for Mnemosyne.
 *
 * Publishes a `hud.update` payload consumed by the React renderers under
 * `renderers/`. The payload's shape is mirrored in `renderers/types.ts`
 * (`PanelData`).
 *
 * ## Design note — polling vs. event-driven
 *
 * The plan (Task 14) called for an event-driven push model: the panel
 * subscribes to writes from `MnemosyneStore` and republishes the
 * `hud.update` only when something actually changed.
 *
 * `MnemosyneStore` (and its underlying `MarkdownStore`) does NOT emit
 * write events as of v1.0. Refactoring it to be an EventEmitter is out
 * of scope for Task 14 — that's a Task 17+ concern. The trade-off here:
 *
 * - We **keep polling** so the panel still picks up new memories created
 *   by the encoder, the consolidator, and external scripts (rebuild, etc.).
 * - We **reduce the interval to 30s** (down from the 5s stub) — the
 *   panel is informational, not real-time. Saves ~84% of redundant disk
 *   reads and bus publishes per minute.
 * - When `MnemosyneStore` gains a `.on("write", ...)` (or similar) hook,
 *   replace `setInterval` with a subscription and drop the timer entirely.
 *
 * Errata note: `HudUpdateMessage.source` is required (errata #23) — every
 * publish carries `source: this.id`.
 */

const POLL_INTERVAL_MS = 30_000;

export class PanelPiece implements Piece {
  readonly id = "mnemosyne-panel";
  readonly name = "Mnemosyne Panel";
  private bus?: EventBus;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private store: MnemosyneStore,
    private neo4j: Neo4jAdapter,
    private logger: Logger,
    // Encoder + retriever are wired in after construction (the panel is
    // built before them in pieces/index.ts to keep the Bootstrap interface
    // simple). The setters below let bootstrap inject the references when
    // ready; until then, stats default to zeros.
    private encoder?: EncoderPiece,
    private retriever?: RetrieverPiece,
    // Mnemosyne root dir (defaults to ~/.jarvis/mnemosyne) — used to read
    // the Haiku-maintained skip-buckets.json. Injected so tests can point
    // at a temp dir.
    private rootDir: string = `${process.env.HOME}/.jarvis/mnemosyne`,
    private consolidator?: ConsolidatorPiece,
    private backgroundReview?: BackgroundReviewPiece,
  ) {}

  /** Late binding for stats sources. Called by pieces/index.ts after both
   *  the encoder and retriever instances exist. Safe to call multiple times
   *  (last write wins) — bootstrap is single-threaded. */
  setStatsSources(
    encoder: EncoderPiece,
    retriever: RetrieverPiece,
    consolidator?: ConsolidatorPiece,
    backgroundReview?: BackgroundReviewPiece,
  ): void {
    this.encoder = encoder;
    this.retriever = retriever;
    if (consolidator) this.consolidator = consolidator;
    if (backgroundReview) this.backgroundReview = backgroundReview;
  }

  /** Hermes-first WRITER sources — live counters + taxonomy catalogs. */
  private writerStats?: WriterStats;
  private domainCatalog?: DomainCatalog;
  private entityCatalog?: EntityCatalog;
  setWriterSources(stats: WriterStats, domains: DomainCatalog, entities: EntityCatalog): void {
    this.writerStats = stats;
    this.domainCatalog = domains;
    this.entityCatalog = entities;
  }

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.stopped = false;
    await this.publishState("add");
    // Periodic refresh — the store doesn't emit write events yet, so we
    // poll. Interval is 30s: long enough to be cheap, short enough that
    // a freshly encoded memory shows up in the HUD within one cycle.
    this.timer = setInterval(() => {
      if (this.stopped) return;
      void this.publishState("update");
    }, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Force an immediate refresh. Useful for tools that mutate the store
   * (memory_forget, memory_pin, consolidate) and want the panel to
   * reflect the change before the next polling tick.
   */
  async refreshNow(): Promise<void> {
    if (this.stopped) return;
    await this.publishState("update");
  }

  private async publishState(action: "add" | "update"): Promise<void> {
    if (!this.bus) return;
    let memories: Awaited<ReturnType<MnemosyneStore["markdownStore"]["list"]>> = [];
    try {
      memories = await this.store.markdownStore.list({});
    } catch (e) {
      // Bootstrap may not have completed — publish a degraded state.
      // The Logger class doesn't surface a generic warn method (it's
      // append-only per category); console is acceptable here as this
      // is a non-fatal HUD-only path.
      console.warn(`[mnemosyne-panel] store list failed: ${String(e)}`);
      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action,
        pieceId: this.id,
        piece: {
          pieceId: this.id,
          type: "panel",
          name: "Mnemosyne",
          status: "starting",
          data: {
            error: String(e),
            memories: [],
            stats: { total: 0, short: 0, long: 0 },
          },
          renderer: { plugin: "jarvis-plugin-mnemosyne", file: "MnemosynePanel" },
        },
      });
      return;
    }

    // Build the runtime stats block. Encoder/retriever may not be wired
    // yet (bootstrap order); buildStats falls back to zeros gracefully.
    // We try/catch because skip-buckets.json read is best-effort — we do
    // NOT want a stat-loading hiccup to drop the memories payload.
    let runtimeStats = null;
    try {
      runtimeStats = await buildStats({
        rootDir: this.rootDir,
        encoderStats: this.encoder?.getStats() ?? {
          turnsProcessed: 0, turnsSkipped: 0, turnsErrored: 0,
          candidatesEmitted: 0, memoriesWritten: 0, memoriesDeduped: 0,
          costUsd: 0, queueDepth: 0, processing: false, categoriesCount: {},
        },
        retrieverStats: this.retriever?.getStats() ?? {
          retrievals: 0, retrievalsWithHits: 0, cacheHits: 0,
          hitsTotal: 0, avgHits: 0, reinforcements: 0,
          injections: 0, injectionsWithBlock: 0, sessionsTracked: 0,
        },
        totalMemories: memories.length,
      });
    } catch (e) {
      console.warn(`[mnemosyne-panel] buildStats failed: ${String(e)}`);
    }

    // Hermes v2: build retriever tier stats (per-session WM + attention)
    let retrieverTiers = null;
    try {
      if (this.retriever) {
        const sessions: Record<string, any> = {};
        const wm = (this.retriever as any).workingMemory as Map<string, Map<string, any>> | undefined;
        const counters = (this.retriever as any).sessionTurnCounters as Map<string, number> | undefined;
        const store = this.store;
        for (const [sid, wmMap] of (wm ?? [])) {
          const entries = [...wmMap.values()];
          const attn = store.getAttentionState?.(sid);
          sessions[sid] = {
            turnCounter: counters?.get(sid) ?? 0,
            wmInjected: entries.filter(e => !e.forgotten).length,
            wmForgotten: entries.filter(e => e.forgotten).length,
            tier1Domains: attn?.active_domains ?? [],
            tier1Categories: attn?.active_categories ?? [],
            tier1UpdatedAt: attn?.updated_at ?? null,
          };
        }
        retrieverTiers = { sessions };
      }
    } catch { /* best-effort */ }

    // Hermes v2: build background review stats
    let backgroundReview = null;
    try {
      if (this.backgroundReview) {
        const br = this.backgroundReview as any;
        const sessionEntries: Record<string, any> = {};
        for (const [sid, count] of (br.turnCount ?? new Map())) {
          sessionEntries[sid] = {
            turnCount: count,
            reviewEveryNTurns: br.config?.reviewEveryNTurns ?? 5,
            hasIdleTimer: br.idleTimers?.has(sid) ?? false,
          };
        }
        backgroundReview = {
          sessions: sessionEntries,
          activeReviews: br.activeReviews?.size ?? 0,
          config: {
            enabled: br.config?.enabled ?? false,
            reviewEveryNTurns: br.config?.reviewEveryNTurns ?? 5,
            idleTriggerMinutes: br.config?.idleTriggerMinutes ?? 5,
          },
          history: br._reviewHistory ?? [],
        };
      }
    } catch { /* best-effort */ }

    // Hermes v2: consolidator last run
    let consolidatorLastRun = null;
    try {
      if (this.consolidator) {
        const c = this.consolidator as any;
        consolidatorLastRun = c._lastRunStats ?? null;
      }
    } catch { /* best-effort */ }

    // Hermes-first WRITER stats — merge live in-memory counters with
    // disk-derived historical totals.
    let writer = null;
    try {
      const s = this.writerStats;
      // Historical: memories written via the new_memory tool + taxonomy size.
      const newMemoryCount = memories.filter((m) => (m as any).origin_tool === "new_memory").length;
      const domainsTotal = this.domainCatalog?.list?.().length ?? 0;
      const entitiesTotal = this.entityCatalog?.list?.().length ?? 0;
      writer = {
        // live (this process)
        session: s ? {
          domainCalls: s.domainCalls,
          domainsCreated: s.domainsCreated,
          entityCalls: s.entityCalls,
          entitiesCreated: s.entitiesCreated,
          memoryWrites: s.memoryWrites,
          memoryRejected: s.memoryRejected,
          edgesCreated: s.edgesCreated,
          edgesFailed: s.edgesFailed,
          lastWriteAt: s.lastWriteAt,
        } : null,
        // historical (disk)
        total: {
          memoriesViaTool: newMemoryCount,
          domains: domainsTotal,
          entities: entitiesTotal,
        },
      };
    } catch { /* best-effort */ }

    const data = {
      memories: memories.slice(0, 100),
      stats: {
        total: memories.length,
        short: memories.filter((m) => !m.promoted_at).length,
        long: memories.filter((m) => m.promoted_at).length,
      },
      runtime: runtimeStats,
      retrieverTiers,
      backgroundReview,
      consolidatorLastRun,
      writer,
    };

    if (action === "add") {
      // Initial registration — HudState reads `msg.piece` here.
      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action,
        pieceId: this.id,
        piece: {
          pieceId: this.id,
          type: "panel",
          name: "Mnemosyne",
          status: "running",
          data,
          position: { x: 100, y: 100 },
          size: { width: 1100, height: 640 },
          renderer: { plugin: "jarvis-plugin-mnemosyne", file: "MnemosynePanel" },
        },
      });
    } else {
      // Update — HudState's `case "update"` reads `msg.data` (top-level), not
      // `msg.piece.data`. Sending the full piece envelope here would silently
      // be a no-op, leaving the HUD with stale memories after delete/pin.
      this.bus.publish({
        channel: "hud.update",
        source: this.id,
        action,
        pieceId: this.id,
        data,
      });
    }
  }
}
