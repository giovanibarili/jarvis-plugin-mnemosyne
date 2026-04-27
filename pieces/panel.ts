import type { Piece } from "@jarvis/core";
import { EventBus } from "@jarvis/core";
import type { MnemosyneStore } from "../lib/store";
import type { Neo4jAdapter } from "../lib/neo4j-adapter";
import type { Logger } from "../lib/logger";

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
  ) {}

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
        data: {
          memories: memories.slice(0, 100),
          stats: {
            total: memories.length,
            short: memories.filter((m) => !m.promoted_at).length,
            long: memories.filter((m) => m.promoted_at).length,
          },
        },
        position: { x: 100, y: 100 },
        size: { width: 1100, height: 640 },
        renderer: { plugin: "jarvis-plugin-mnemosyne", file: "MnemosynePanel" },
      },
    });
  }
}
