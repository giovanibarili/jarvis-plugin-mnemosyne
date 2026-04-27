import type { Piece } from "@jarvis/core";
import { EventBus } from "@jarvis/core";
import type { MnemosyneStore } from "../lib/store";
import type { Neo4jAdapter } from "../lib/neo4j-adapter";
import type { Logger } from "../lib/logger";

/**
 * STUB — full HUD panel implementation lands in Task 14.
 *
 * For Task 12, this just publishes a basic hud.update with stats so the
 * piece can be registered and the wiring exercised end-to-end. The real
 * renderer + interactive panel are deferred.
 */
export class PanelPiece implements Piece {
  readonly id = "mnemosyne-panel";
  readonly name = "Mnemosyne Panel";
  private bus?: EventBus;
  private timer?: NodeJS.Timeout;

  constructor(
    private store: MnemosyneStore,
    private neo4j: Neo4jAdapter,
    private logger: Logger
  ) {}

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    await this.publishState("add");
    // Refresh every 5s — replaced with event-driven push in Task 14
    this.timer = setInterval(() => {
      void this.publishState("update");
    }, 5000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async publishState(action: "add" | "update"): Promise<void> {
    if (!this.bus) return;
    let memories: Awaited<ReturnType<MnemosyneStore["markdownStore"]["list"]>> = [];
    try {
      memories = await this.store.markdownStore.list({});
    } catch (e) {
      // Bootstrap may not have completed — publish a degraded state
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
          data: { error: String(e), memories: [], stats: { total: 0, short: 0, long: 0 } },
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
        size: { width: 900, height: 600 },
        renderer: { plugin: "jarvis-plugin-mnemosyne", file: "MnemosynePanel" },
      },
    });
  }
}
