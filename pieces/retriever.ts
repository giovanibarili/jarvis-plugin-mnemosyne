import type { EventBus, AIRequestMessage } from "@jarvis/core";
import type { MnemosyneStore } from "../lib/store";
import type { Reranker } from "../lib/reranker";
import type { RetrievalHit } from "../lib/types";
import type { SemanticRelationLinker } from "../lib/semantic-relation-linker";

export interface RetrieverOptions {
  topK: number;
  graphHops: number;
  workflowLookupEnabled: boolean;
}

/**
 * RetrieverPiece — hybrid retrieval (vector top-K seeds + 1-hop graph
 * expansion + rerank). Produces a markdown block injected into Block 1 of
 * the system prompt via systemContext().
 *
 * Per-session cache keyed by the last user message preserves prompt cache
 * hits across no-op turns (e.g. tool result loops where the user message
 * hasn't changed).
 *
 * Design constraint (D2): the Retriever PRODUCES the memory block but never
 * instructs the assistant on how to format references back to memories. The
 * block is read naturally by the model.
 *
 * Design constraint: reinforcements are bumped on retrieval (not on write),
 * so frequently-recalled memories slowly climb the ranking via the
 * reinforcements signal in Reranker.
 */
// NOTE: structurally compatible with @jarvis/core Piece, but we don't
// `implements Piece` because Piece declares `systemContext(): string` while
// our retrieval is async (returns Promise<string>). The plan + tests use
// the async signature; pieces/index.ts will adapt this at wire-up time
// (Task 12) via a sync wrapper that returns the cached block.
export class RetrieverPiece {
  readonly id = "mnemosyne-retriever";
  readonly name = "Mnemosyne Retriever";

  // Per-session caches. Both maps are keyed by sessionId.
  //   lastUserMsg:   most recent user prompt observed on ai.request
  //   cache:         formatted block keyed by the user message that produced it
  //   pendingFetch:  in-flight systemContext() Promise for the current turn —
  //                  the injector awaits this with a timeout so it always gets
  //                  fresh data on the same turn the ai.request arrived.
  private lastUserMsg = new Map<string, string>();
  private cache = new Map<string, { lastUserMsg: string; block: string }>();
  /** In-flight fetch per session — awaited by the injector with timeout. */
  pendingFetch = new Map<string, Promise<string>>();
  /** Last retrieval hits per session — read by the context injector for timeline payload. */
  lastHits = new Map<string, RetrievalHit[]>();


  // ── Session-scoped retrieval stats (zeroed on boot).
  // `retrievals` counts every distinct user-message lookup (cache miss).
  // `retrievalsWithHits` is the subset that produced ≥1 surviving hit
  // post-rerank — the rate of retrievals/with-hits is the "useful retrieval"
  // signal. `reinforcements` mirrors store.incrementReinforcements calls
  // because that's where retrieval converts into long-term salience. Hits
  // total feeds the avg-hits-per-retrieval gauge.
  private _stats = {
    retrievals: 0,
    retrievalsWithHits: 0,
    cacheHits: 0,
    hitsTotal: 0,
    reinforcements: 0,
    injections: 0,
    injectionsWithBlock: 0,
  };

  getStats() {
    return {
      ...this._stats,
      avgHits: this._stats.retrievals > 0
        ? this._stats.hitsTotal / this._stats.retrievals
        : 0,
      sessionsTracked: this.lastUserMsg.size,
    };
  }

  /** Called by the ContextInjector wrapper in pieces/index.ts on every
   *  injection attempt. We split "called at all" from "produced a non-empty
   *  block" so the HUD can show the injection success rate. */
  recordInjection(producedBlock: boolean): void {
    this._stats.injections++;
    if (producedBlock) this._stats.injectionsWithBlock++;
  }

  constructor(
    private store: MnemosyneStore,
    private reranker: Reranker,
    private opts: RetrieverOptions,
    private relationLinker?: SemanticRelationLinker,
  ) {}

  private _started = false;
  async start(bus: EventBus): Promise<void> {
    if (this._started) return; // guard against double-start (hot reload, etc.)
    this._started = true;
    bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
      const sid = msg.target ?? "main";
      const text = msg.text ?? "";
      this.lastUserMsg.set(sid, text);

      // Kick off retrieval immediately on ai.request so the cache is warm
      // by the time sendAndStream calls contextInjector. The injector reads
      // pendingFetch[sid] and awaits it (with timeout) — no more turn-1 miss.
      const cached = this.cache.get(sid);
      if (cached?.lastUserMsg !== text) {
        const p = this.systemContext(sid);
        this.pendingFetch.set(sid, p);
        p.finally(() => {
          // Only clear if this is still the active pending fetch for this sid.
          if (this.pendingFetch.get(sid) === p) this.pendingFetch.delete(sid);
        });
      }
    });
  }

  async stop(): Promise<void> {}

  /**
   * Build (or return cached) memory block for `sessionId`.
   *
   * Returns "" when:
   *   - no last user message observed for the session
   *   - retrieval yielded no hits
   *
   * Cache key is the last user message string. When it matches the previous
   * lookup we return the cached block verbatim — no DB hits, no
   * reinforcements bumped (D2: reinforce once per distinct user prompt).
   */
  async systemContext(sessionId?: string): Promise<string> {
    const sid = sessionId ?? "main";
    const lastMsg = this.lastUserMsg.get(sid);
    if (!lastMsg) return "";

    const cached = this.cache.get(sid);
    if (cached?.lastUserMsg === lastMsg) {
      this._stats.cacheHits++;
      return cached.block;
    }

    this._stats.retrievals++;
    const hits = await this.retrieve(lastMsg, sid);
    this._stats.hitsTotal += hits.length;
    if (hits.length > 0) this._stats.retrievalsWithHits++;

    const block = this.format(hits);
    this.cache.set(sid, { lastUserMsg: lastMsg, block });
    this.lastHits.set(sid, hits); // expose for injector timeline payload

    // Increment reinforcements on retrieved memories (D2: retrieval-only signal).
    // Best-effort — we do not want a Neo4j hiccup to break prompt construction.
    for (const hit of hits) {
      try {
        await this.store.incrementReinforcements(hit.memory.id);
        this._stats.reinforcements++;
      } catch {
        // swallow — reinforcement is observability, not correctness
      }
    }

    // Pass 3 — Semantic relation linking at retrieval time.
    // When 2+ memories co-appear in the same retrieval context they share
    // implicit semantic proximity. Link them pairwise so the graph captures
    // this co-retrieval signal. Fire-and-forget: never blocks the injector.
    if (this.relationLinker && hits.length >= 2) {
      this.linkCoRetrievedMemories(hits).catch((err) => {
        console.error("[mnemosyne] co-retrieval relation linking failed:", err);
      });
    }

    return block;
  }

  /**
   * Link co-retrieved memories pairwise via RELATES_TO edges.
   * Only links pairs where the linker's judge returns a non-"unrelated" verdict.
   * Pairs already linked (MERGE semantics in Neo4j) are silently skipped.
   */
  private async linkCoRetrievedMemories(hits: RetrievalHit[]): Promise<void> {
    if (!this.relationLinker) return;
    // For each hit, run linkRelations — the linker queries Chroma for
    // neighbours and will naturally find the other co-retrieved memories
    // since they are all in the store with embeddings.
    // We only trigger for vector-sourced hits (graph hops already have edges).
    const vectorHits = hits.filter((h) => h.source === "vector");
    for (const hit of vectorHits) {
      await this.relationLinker.linkRelations(hit.memory);
    }
  }

  private async retrieve(query: string, sessionId: string): Promise<RetrievalHit[]> {
    // 1. Vector top-K from short + long
    const shortHits = await this.store.chroma.query("short", query, this.opts.topK);
    const longHits = await this.store.chroma.query("long", query, this.opts.topK);
    const allChromaHits = [...shortHits, ...longHits];

    // 2. Hydrate Memory objects from canonical markdown store, applying
    //    privacy filter: visibility="open" OR same session.
    //    Dedup by id (a memory could theoretically appear in both layers
    //    during the brief promotion window).
    const seen = new Set<string>();
    const memories: RetrievalHit[] = [];
    for (const ch of allChromaHits) {
      if (seen.has(ch.id)) continue;
      const mem = await this.store.markdownStore.read(ch.id);
      if (!mem) continue;
      if (mem.visibility === "private" && mem.source_session !== sessionId) continue;
      seen.add(mem.id);
      memories.push({ memory: mem, score: 1 - ch.distance, source: "vector" });
    }

    // 3. Graph 1-hop expansion. Seeds are the surviving vector hits.
    const seedIds = memories.map((m) => m.memory.id);
    if (seedIds.length > 0) {
      const neighbors = await this.store.neo4j.oneHopNeighbors(seedIds);
      for (const n of neighbors) {
        if (seen.has(n.id)) continue;
        if (n.visibility === "private" && n.source_session !== sessionId) continue;
        seen.add(n.id);
        memories.push({ memory: n, score: 0.5, source: "graph" });
      }
    }

    // 4. Detect contradictions for every surviving hit. Drives the
    //    ⚠️ Conflicts with: ... line in the rendered block.
    for (const hit of memories) {
      const contradictions = await this.store.neo4j.getContradictions(hit.memory.id);
      if (contradictions.length) hit.conflicts_with = contradictions;
    }

    // 5. Rerank and slice top-K.
    const reranked = this.reranker.rerank(memories);
    return reranked.slice(0, this.opts.topK);
  }

  private format(hits: RetrievalHit[]): string {
    if (!hits.length) return "";
    const lines = ["## Mnemosyne — Relevant memories", ""];
    hits.forEach((hit, i) => {
      const m = hit.memory;
      lines.push(`${i + 1}. **[${m.category}]** ${m.title}`);
      lines.push(`   ${m.content}`);
      const created = new Date(m.created_at).toISOString().slice(0, 10);
      const meta = `_ref: ${m.id.slice(0, 4)} • created: ${created} • reinforcements: ${m.reinforcements}_`;
      lines.push(`   ${meta}`);
      if (hit.conflicts_with?.length) {
        const refs = hit.conflicts_with.map((c) => c.slice(0, 4)).join(", ");
        lines.push(`   ⚠️ Conflicts with: ${refs}`);
      }
      lines.push("");
    });
    return lines.join("\n");
  }
}
