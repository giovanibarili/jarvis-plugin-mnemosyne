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
  constructor(
    public markdownStore: MarkdownStore,
    public chroma: ChromaAdapter,
    public neo4j: Neo4jAdapter,
    public logger: Logger
  ) {}

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

    // 3. Neo4j
    try {
      await this.neo4j.upsertMemory(memory);
    } catch (e) {
      await this.chroma.delete(layer, memory.id);
      await this.markdownStore.delete(memory.id);
      throw new Error(`Neo4j upsert failed; rolled back markdown + chroma: ${e}`);
    }
  }

  async delete(id: string): Promise<void> {
    const mem = await this.markdownStore.read(id);
    if (!mem) return;
    const layer = mem.promoted_at ? "long" : "short";

    await this.neo4j.deleteMemory(id);
    await this.chroma.delete(layer, id);
    await this.markdownStore.delete(id);
  }

  async incrementReinforcements(id: string): Promise<void> {
    await this.neo4j.incrementReinforcements(id);
    // Markdown is updated lazily on next consolidator run (Neo4j is the
    // source of truth for counters).
  }

  async promote(id: string): Promise<void> {
    const mem = await this.markdownStore.read(id);
    if (!mem || mem.promoted_at) return;

    await this.markdownStore.promote(id);
    await this.chroma.move("short", "long", id);
    await this.neo4j.markPromoted(id, Date.now());
  }
}
