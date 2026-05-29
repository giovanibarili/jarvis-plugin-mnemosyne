import type { Memory } from "./types";
import { MarkdownStore } from "./markdown-store";
import { ChromaAdapter } from "./chroma-adapter";
import { Neo4jAdapter } from "./neo4j-adapter";
import { Logger } from "./logger";

/**
 * MnemosyneStore — facade orchestrating atomic writes across the three storage
 * layers (Markdown canonical store, Chroma vector store, Neo4j graph store).
 *
 * Adapters are exposed publicly so consumers (retriever, replay engine, tests)
 * can call layer-specific operations directly when the facade's API would be
 * over-abstracted (e.g. raw vector queries, one-hop graph traversal).
 */
export class MnemosyneStore {
  /**
   * Runtime degradation flag. When true, Neo4j is unreachable and any
   * Neo4j-side operation is skipped instead of throwing. Set by the
   * bootstrap when the Neo4j probe fails — see `pieces/index.ts`.
   *
   * The graph layer is REBUILDABLE from markdown via `scripts/rebuild-indexes.ts`,
   * so skipping writes here is safe: the canonical store stays correct and
   * the graph re-syncs once Neo4j comes back.
   */
  private graphDegraded = false;

  constructor(
    public markdownStore: MarkdownStore,
    public chroma: ChromaAdapter,
    public neo4j: Neo4jAdapter,
    public logger: Logger
  ) {}

  /** Toggle runtime graph degradation. Idempotent. */
  setGraphDegraded(value: boolean): void {
    this.graphDegraded = value;
  }

  isGraphDegraded(): boolean {
    return this.graphDegraded;
  }

  /** Atomic write: markdown first (canonical), then Chroma, then Neo4j. Rollback on failure. */
  async write(memory: Memory): Promise<void> {
    const layer = memory.promoted_at ? "long" : "short";

    // 1. Markdown (canonical)
    await this.markdownStore.write(memory);

    // 2. Chroma
    try {
      await this.chroma.upsert(layer, {
        id: memory.id,
        content: memory.content,
        metadata: {
          category: memory.category,
          project: memory.project ?? "",
          confidence: memory.confidence,
          reinforcements: memory.reinforcements,
          created_at: memory.created_at,
          visibility: memory.visibility,
          source_session: memory.source_session,
        },
      });
    } catch (e) {
      await this.markdownStore.delete(memory.id);
      throw new Error(`Chroma upsert failed; rolled back markdown: ${e}`);
    }

    // 3. Neo4j — skipped (and no rollback) when graph is degraded. The
    // markdown + chroma pair remains the canonical record; the graph node
    // is recreated by scripts/rebuild-indexes.ts once Neo4j is back.
    if (this.graphDegraded) return;
    try {
      await this.neo4j.upsertMemory(memory);
    } catch (e) {
      // Degrade-on-fail: mark the store so subsequent writes don't keep
      // retrying, and DO NOT roll back markdown+chroma — they're the source
      // of truth. The user already has a notification from bootstrap.
      this.graphDegraded = true;
      console.error("[mnemosyne-store] " + `neo4j upsert failed mid-flight, marking graphDegraded: ${e}`);
    }
  }

  async delete(id: string): Promise<void> {
    const mem = await this.markdownStore.read(id);
    if (!mem) return;
    const layer = mem.promoted_at ? "long" : "short";

    if (!this.graphDegraded) {
      try {
        await this.neo4j.deleteMemory(id);
      } catch (e) {
        this.graphDegraded = true;
        console.error("[mnemosyne-store] " + `neo4j delete failed, marking graphDegraded: ${e}`);
      }
    }
    await this.chroma.delete(layer, id);
    await this.markdownStore.delete(id);
  }

  async incrementReinforcements(id: string): Promise<void> {
    if (this.graphDegraded) return;
    try {
      await this.neo4j.incrementReinforcements(id);
    } catch (e) {
      this.graphDegraded = true;
      console.error("[mnemosyne-store] " + `neo4j incrementReinforcements failed: ${e}`);
    }
    // Markdown is updated lazily on next consolidator run (Neo4j is the
    // source of truth for counters).
  }

  async decrementReinforcements(id: string): Promise<void> {
    if (this.graphDegraded) return;
    try {
      await this.neo4j.decrementReinforcements(id);
    } catch (e) {
      this.graphDegraded = true;
      console.error("[mnemosyne-store] " + `neo4j decrementReinforcements failed: ${e}`);
    }
  }

  async promote(id: string): Promise<void> {
    const mem = await this.markdownStore.read(id);
    if (!mem || mem.promoted_at) return;

    await this.markdownStore.promote(id);

    // Move from short → long. If the memory was never indexed in short
    // (e.g. created via manual triage before Chroma wiring), fall back to
    // a direct upsert in long so it's always searchable after promotion.
    const inShort = await this.chroma.exists("short", id);
    if (inShort) {
      await this.chroma.move("short", "long", id);
    } else {
      await this.ensureChromaLong(mem);
    }

    if (this.graphDegraded) return;
    try {
      await this.neo4j.markPromoted(id, Date.now());
    } catch (e) {
      this.graphDegraded = true;
      console.error("[mnemosyne-store] " + `neo4j markPromoted failed: ${e}`);
    }
  }

  /** Upsert a memory directly into the long Chroma layer. Safe to call multiple times. */
  async ensureChromaLong(mem: Memory): Promise<void> {
    await this.chroma.upsert("long", {
      id: mem.id,
      content: mem.content,
      metadata: {
        title: mem.title ?? "",
        category: mem.category ?? "",
        confidence: mem.confidence ?? 0.8,
        created_at: mem.created_at ?? Date.now(),
        origin_source: mem.origin_source ?? "user",
        evidence: mem.evidence ?? "",
      },
    });
  }
}
