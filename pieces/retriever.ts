import type { EventBus, AIRequestMessage } from "@jarvis/core";
import type { MnemosyneStore } from "../lib/store";
import type { Reranker } from "../lib/reranker";
import type { RetrievalHit, MemoryNeighborhood, WorkingMemoryEntry } from "../lib/types";
import type { SemanticRelationLinker } from "../lib/semantic-relation-linker";
import { computeMatchSnippet } from "../lib/match-snippet.js";
import { GraphNeighborhoodService } from "../lib/graph-neighborhood.js";
import { log } from "../lib/log.js";

/**
 * Render the parent/child neighborhood of a single memory as a short,
 * indented markdown fragment. Used inline under each memory in the
 * retrieval block. Returns "" when the neighborhood is empty (or absent),
 * so callers can unconditionally concatenate.
 *
 * Parents are rendered with ↑ (this memory was relation-pointed-AT-by them),
 * children with ↓ (this memory points OUT to them). Both formats are
 * intentionally identical otherwise so the model parses them uniformly.
 */
export function formatNeighborhood(n: MemoryNeighborhood): string {
  if (!n || (n.parents.length === 0 && n.children.length === 0)) return "";
  const lines: string[] = [];
  // Compact neighborhood — symbols ↑/↓ defined in system prompt legend.
  // Use 8-char id prefix (consistent with the id: field on the parent entry).
  // Reason is truncated to keep context scannable.
  for (const p of n.parents) {
    const why = p.reason ? `  // ${p.reason.slice(0, 80)}` : "";
    lines.push(`  ↑ ${p.title} — ${p.relation}  (id:${p.id})${why}`);
  }
  for (const c of n.children) {
    const why = c.reason ? `  // ${c.reason.slice(0, 80)}` : "";
    lines.push(`  ↓ ${c.title} — ${c.relation}  (id:${c.id})${why}`);
  }
  return lines.join("\n");
}

/**
 * Input shape for {@link formatWorkflowHit}. Decoupled from the Chroma
 * `WorkflowQueryHit` so the formatter is a pure function over a minimal
 * projection — easy to unit-test without touching the store.
 */
export interface WorkflowHitFormatInput {
  id: string;
  name: string;
  trigger: string;
  outcome: string;
  stepCount: number;
  similarity: number;
}

/**
 * Render a single workflow hit as a compact, model-friendly block.
 * Mirrors the memory hit rendering style (📋 prefix instead of ●/◦, no
 * confidence/reinforcement line). When `similarity` is 0 the sim chip is
 * dropped — used by callers that pass workflows without a vector score.
 *
 * Includes a `workflow_replay("<name>")` call-to-action so the model has
 * an obvious way to execute the procedure.
 */
export function formatWorkflowHit(hit: WorkflowHitFormatInput): string {
  const lines: string[] = [];
  const simStr = hit.similarity > 0 ? `  sim ${hit.similarity.toFixed(2)}` : "";
  lines.push(`📋 workflow  [workflow]  ${hit.name}${simStr}`);
  lines.push(`  trigger: ${hit.trigger}`);
  lines.push(`  outcome: ${hit.outcome}`);
  lines.push(`  ${hit.stepCount} steps  →  use \`workflow_replay("${hit.name}")\` to execute`);
  return lines.join("\n");
}

/**
 * Build the trailing hint that nudges the assistant towards `memory_fetch`
 * when at least one retrieved hit exposes related parents or children.
 * Returns "" when nothing in the block has relations — we don't want to
 * advertise a tool the user has no reason to call.
 */
export function buildHint(hits: RetrievalHit[], totalPool = 0): string {
  if (hits.length === 0) return "";

  // ── Iceberg summary ────────────────────────────────────────────────────────
  // Count unloaded graph nodes (↑/↓ relations) across all injected hits.
  // This tells the LLM that the injected block is a SAMPLE, not the full picture.
  const injectedIds = new Set(hits.map((h) => h.memory.id));
  let unloadedNodeCount = 0;
  let unloadedEdgeCount = 0;
  for (const h of hits) {
    if (!h.neighborhood) continue;
    const unloadedParents  = h.neighborhood.parents.filter((p) => !injectedIds.has(p.id));
    const unloadedChildren = h.neighborhood.children.filter((c) => !injectedIds.has(c.id));
    unloadedNodeCount += unloadedParents.length + unloadedChildren.length;
    unloadedEdgeCount += h.neighborhood.parents.length + h.neighborhood.children.length;
  }

  // Build the iceberg line: "showing N cards — X more in graph, Y total in pool"
  const parts: string[] = [];
  if (totalPool > hits.length) parts.push(`${totalPool - hits.length} more in the ranked pool`);
  if (unloadedNodeCount > 0)   parts.push(`${unloadedNodeCount} unloaded graph nodes (${unloadedEdgeCount} edges visible above)`);
  const icebergLine = parts.length > 0
    ? `_Showing ${hits.length} cards — ${parts.join(" · ")}. Use \`memory_search(query, k=20)\` or \`memory_fetch(id)\` to go deeper._`
    : `_Showing ${hits.length} cards from memory._`;

  // ── Graph navigation hint ──────────────────────────────────────────────────
  const graphHitsWithRelations = hits.filter(
    (h) => h.source === "graph" &&
           h.neighborhood &&
           (h.neighborhood.parents.length > 0 || h.neighborhood.children.length > 0)
  );

  let navHint = "";
  if (graphHitsWithRelations.length > 0) {
    const lines = graphHitsWithRelations.map((h) => {
      const unloadedParents  = h.neighborhood!.parents.filter((p) => !injectedIds.has(p.id));
      const unloadedChildren = h.neighborhood!.children.filter((c) => !injectedIds.has(c.id));
      const neighborTitles = [
        ...unloadedParents.slice(0, 2).map((p) => `"${p.title}"`),
        ...unloadedChildren.slice(0, 2).map((c) => `"${c.title}"`),
      ].join(", ");
      const reinf = h.memory.reinforcements ?? 0;
      const proven = reinf >= 5 ? ` ★reinf:${reinf}` : "";
      const total = unloadedParents.length + unloadedChildren.length;
      return `  • [${h.memory.id}] "${h.memory.title}"${proven} — ${total} unloaded neighbors: ${neighborTitles || "see ↑/↓"}`;
    });
    navHint =
      `\n\n**[Knowledge graph]** These ◦ graph cards are entry points — each has unloaded neighbors that may contain the detail your answer needs.\n` +
      `If going deeper would improve your response, call \`memory_fetch(id)\` before answering:\n` +
      lines.join("\n");
  } else if (hits.some((h) => h.neighborhood && (h.neighborhood.parents.length + h.neighborhood.children.length) > 0)) {
    navHint = "\n\n**[Knowledge graph]** The ↑/↓ entries above point to unloaded nodes. Call `memory_fetch(id)` if deeper context would improve your answer.";
  }

  // ── Feedback reminder ──────────────────────────────────────────────────────
  const feedbackReminder =
    "\n\n**[MUST after responding]** Call `memory_reinforce(id)` for every memory above that was directly useful. Pass the full `id:` at the bottom of each entry.";

  return `\n${icebergLine}` + navHint + feedbackReminder;
}

/**
 * Pick which retrieval hits are eligible to act as seeds for the Neo4j
 * `oneHopNeighbors` graph expansion.
 *
 * Spec (memory `kmp3qz`, code-pattern): graph hops MUST be anchored to a
 * positive-sim vector seed. A vector with `sim < 0` is more orthogonal than
 * aligned with the query — using it as a seed pulls topically related but
 * semantically irrelevant neighbors (the "orphan graph hit" failure mode
 * observed at 14:47:48 on 2026-05-29 in the Groq Whisper turn, where 7 of 8
 * vector candidates had negative sim and contributed 4 orphan graph hits).
 *
 * Returns: only `source === "vector"` hits with `vectorSim >= 0`.
 * Graph hits and missing-sim hits are excluded — a graph hit can't seed
 * further expansion (would explode the search), and a missing sim is treated
 * defensively as "no semantic match proof".
 */
export function pickGraphSeeds(memories: RetrievalHit[]): RetrievalHit[] {
  return memories.filter(
    (m) => m.source === "vector" && typeof m.vectorSim === "number" && m.vectorSim >= 0,
  );
}

/**
 * Slot allocation for the final injection. Implements the
 * "graph-complement" strategy from memory `kmp3qz`:
 *
 *   positiveVectorHits = 0  →  top = []  (nothing to inject)
 *   positiveVectorHits ≥ 1  →  fill MIN_VECTOR_SLOTS with best positive vectors,
 *                              then fill remaining slots with graph hits whose
 *                              `seedId` survived into topVector
 *
 * The seed-ancestry check is what makes this an "orphan suppression" fix.
 * Without it, graph hits whose seeding vector got cut off by `minVectorSlots`
 * still survive into the injection — producing the noise the user observed
 * (Image #2: 4 SAA/Deposit Platform hits with no relation to the surviving
 * `vjm8fn` vector).
 *
 * @param reranked  Reranker output, ALL hits with `.score` set.
 * @param opts.topK            Total slots in the final injection.
 * @param opts.minVectorSlots  Slots reserved for positive vectors (e.g. 2).
 */
export function selectTopHits(
  reranked: RetrievalHit[],
  opts: { topK: number; minVectorSlots: number },
): RetrievalHit[] {
  const positiveVectorHits = reranked.filter(
    (h) => h.source === "vector" && (h.vectorSim ?? -1) >= 0,
  );
  if (positiveVectorHits.length === 0) return [];

  const minVectorSlots = Math.min(opts.minVectorSlots, opts.topK);
  const topVector = positiveVectorHits.slice(0, minVectorSlots);
  const survivingSeedIds = new Set(topVector.map((h) => h.memory.id));

  const remainingSlots = opts.topK - topVector.length;
  if (remainingSlots <= 0) return topVector;

  // Graph hits keep their reranker order, but are dropped if their seed
  // got cut. Hits without a recorded `seedId` are also dropped — they
  // were pulled before the seedId tracking was added and can't be
  // validated against the surviving vectors.
  const validGraphHits = reranked.filter(
    (h) => h.source !== "vector" && h.seedId !== undefined && survivingSeedIds.has(h.seedId),
  );
  const topGraph = validGraphHits.slice(0, remainingSlots);

  return [...topVector, ...topGraph];
}

export interface RetrieverOptions {
  topK: number;
  graphHops: number;
  workflowLookupEnabled: boolean;
  /**
   * Minimum cosine similarity (1 − distance) for a vector hit to enter the
   * pipeline. Anything below is dropped before rerank/graph expansion. With
   * MiniLM the observed range is roughly +0.3 (strong) to −0.8 (opposite),
   * so a cutoff at 0.0 eliminates "more orthogonal than aligned" matches —
   * which is the right semantic for "do not inject this".
   *
   * Default 0.0 (parity with old behaviour minus the most obvious noise).
   */
  minVectorSim?: number;
  /**
   * v1.3 — graph retrieval enrichment. When enabled, each surviving
   * retrieval hit gets a `neighborhood` payload (parents + children)
   * attached via {@link GraphNeighborhoodService}. The block renders an
   * inline list of related memories under each hit so the model can decide
   * whether to call `memory_fetch(id)` for more depth.
   */
  graphRetrieval?: {
    enabled: boolean;
    maxParents?: number;
    maxChildren?: number;
  };
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
  //   recentTurns:   ring buffer of last N {user, assistant} pairs for query enrichment
  //   cache:         formatted block keyed by the user message that produced it
  //
  //                  the injector awaits this with a timeout so it always gets
  //                  fresh data on the same turn the ai.request arrived.
  private lastUserMsg = new Map<string, string>();
  private recentTurns = new Map<string, Array<{ user: string; assistant: string }>>();
  private readonly QUERY_CONTEXT_TURNS = 5;
  private cache = new Map<string, { lastUserMsg: string; block: string }>();
  /** In-flight fetch per session — awaited by the injector with timeout. */

  /** Last retrieval hits per session — read by the context injector for timeline payload. */
  lastHits = new Map<string, RetrievalHit[]>();

  // ── Working memory (T2 — amnesia) ─────────────────────────────────────────
  // Per-session map of memory-id → WorkingMemoryEntry. Tracks injection
  // lifecycle so forgotten memories (> AMNESIA_THRESHOLD turns since last
  // seen) are suppressed until they re-emerge via a strong vector match.
  private workingMemory: Map<string, Map<string, WorkingMemoryEntry>> = new Map();
  private sessionTurnCounters: Map<string, number> = new Map();
  private readonly AMNESIA_THRESHOLD = 10;

  /**
   * Lazily initialise and return the working-memory map for a session.
   * Never returns undefined — creates an empty map on first access.
   */
  private getWorkingMemory(sessionId: string): Map<string, WorkingMemoryEntry> {
    if (!this.workingMemory.has(sessionId)) {
      this.workingMemory.set(sessionId, new Map());
    }
    return this.workingMemory.get(sessionId)!;
  }

  /** Advance the per-session turn counter and return the new value. */
  private incrementTurn(sessionId: string): number {
    const n = (this.sessionTurnCounters.get(sessionId) ?? 0) + 1;
    this.sessionTurnCounters.set(sessionId, n);
    return n;
  }

  /**
   * Mark entries as forgotten when they haven't been seen for
   * AMNESIA_THRESHOLD turns. Forgotten memories are excluded from the
   * next injection but can re-emerge naturally via a high-scoring
   * vector match.
   */
  private applyAmnesia(sessionId: string): void {
    const currentTurn = this.sessionTurnCounters.get(sessionId) ?? 0;
    const wm = this.getWorkingMemory(sessionId);
    for (const [, entry] of wm) {
      if (!entry.forgotten && (currentTurn - entry.lastSeenAt) > this.AMNESIA_THRESHOLD) {
        entry.forgotten = true;
      }
    }
  }

  /**
   * Called when memory_reinforce fires — resets the amnesia counter for
   * that memory, ensuring it stays visible while the user is actively
   * referencing it.
   */
  reinforceMemory(sessionId: string, memId: string): void {
    const wm = this.getWorkingMemory(sessionId);
    const entry = wm.get(memId);
    if (entry) {
      entry.lastSeenAt = this.sessionTurnCounters.get(sessionId) ?? entry.lastSeenAt;
      entry.forgotten = false;
    }
  }

  /**
   * Upsert the working-memory entry for a retrieved memory.
   * If the entry is already forgotten, re-emerging resets the forgotten flag.
   */
  private updateWorkingMemory(sessionId: string, memId: string, score: number): void {
    const currentTurn = this.sessionTurnCounters.get(sessionId) ?? 0;
    const wm = this.getWorkingMemory(sessionId);
    const existing = wm.get(memId);
    if (existing) {
      existing.lastSeenAt = currentTurn;
      existing.score = score;
      existing.forgotten = false; // re-emergence clears amnesia
    } else {
      wm.set(memId, { injectedAt: currentTurn, lastSeenAt: currentTurn, score, forgotten: false });
    }
  }


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

  /**
   * v1.3 — graph enrichment service. Constructed lazily in the ctor when
   * `opts.graphRetrieval?.enabled === true`. When absent, `enrichHits` is a
   * no-op and `format()` skips the neighborhood/hint blocks entirely
   * (parity with v1.2 output).
   */
  private graphNeighborhood?: GraphNeighborhoodService;

  constructor(
    private store: MnemosyneStore,
    private reranker: Reranker,
    private opts: RetrieverOptions,
    private relationLinker?: SemanticRelationLinker,
  ) {
    if (opts.graphRetrieval?.enabled) {
      this.graphNeighborhood = new GraphNeighborhoodService(store.neo4j, {
        maxParents: opts.graphRetrieval.maxParents ?? 10,
        maxChildren: opts.graphRetrieval.maxChildren ?? 20,
      });
    }
  }

  private _started = false;
  async start(bus: EventBus): Promise<void> {
    if (this._started) return; // guard against double-start (hot reload, etc.)
    this._started = true;

    // Track assistant responses to enrich future queries with conversation context.
    // We accumulate chunks and commit the full response on stream end.
    const assistantChunks = new Map<string, string>();
    bus.subscribe("ai.stream", (msg: any) => {
      const sid = (msg.target ?? msg.session_id ?? "main") as string;
      if (msg.event === "chunk" && msg.text) {
        assistantChunks.set(sid, (assistantChunks.get(sid) ?? "") + msg.text);
      } else if (msg.event === "end" || msg.event === "done") {
        const assistant = assistantChunks.get(sid) ?? "";
        assistantChunks.delete(sid);
        if (!assistant) return;
        // Commit the completed turn into the ring buffer
        const user = this.lastUserMsg.get(sid) ?? "";
        const hist = this.recentTurns.get(sid) ?? [];
        hist.push({ user, assistant });
        if (hist.length > this.QUERY_CONTEXT_TURNS) hist.shift();
        this.recentTurns.set(sid, hist);
        // Parse memory feedback signals emitted by the LLM.
        // Signals are stripped from the final response by the Chat renderer
        // so they are never shown to the user.
        void this._parseFeedback(assistant).catch(() => {});
      }
    });

    bus.subscribe<AIRequestMessage>("ai.request", (msg) => {
      const sid = msg.target ?? "main";
      const text = msg.text ?? "";
      // Skip system-generated messages (plugin notifications, cron triggers,
      // etc.) — they are not user queries and produce misleading retrieval.
      if (text.startsWith("[SYSTEM]") || text.startsWith("<system")) return;
      this.lastUserMsg.set(sid, text);
      log.debug({ sid, textPreview: text.slice(0, 60) }, "mnemosyne: retriever — lastUserMsg set");
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
  /**
   * Build a retrieval query from the current user message enriched with
   * the last N turns of conversation (user + assistant). This ensures that
   * topics mentioned a few turns ago still surface relevant memories even
   * when the current message is short or contextually sparse.
   *
   * Strategy: current message first (highest weight for MiniLM), then
   * append key terms from prior turns (first 120 chars each, user + assistant).
   */
  private buildQuery(sid: string): string {
    const lastMsg = this.lastUserMsg.get(sid) ?? "";
    const hist = this.recentTurns.get(sid) ?? [];
    if (!hist.length) return lastMsg;
    const contextSnippets = hist
      .slice(-this.QUERY_CONTEXT_TURNS)
      .flatMap((t) => [t.user.slice(0, 120), t.assistant.slice(0, 120)])
      .filter(Boolean)
      .join(" ");
    return `${lastMsg} ${contextSnippets}`.trim();
  }

  async systemContext(sessionId?: string): Promise<string> {
    const sid = sessionId ?? "main";

    // E2 — Tier 1: read declared attention state for this session.
    // Optional chaining guards against store versions that pre-date T-05.
    const attentionState = this.store.getAttentionState?.(sid);
    const tier1Domains = attentionState?.active_domains ?? [];
    const tier1Categories = attentionState?.active_categories ?? [];

    const lastMsg = this.lastUserMsg.get(sid);
    log.debug({ sid, hasLastMsg: !!lastMsg }, "mnemosyne: retriever.systemContext called");
    if (!lastMsg) return "";

    const cached = this.cache.get(sid);
    if (cached?.lastUserMsg === lastMsg) {
      this._stats.cacheHits++;
      log.debug({ sid }, "mnemosyne: retriever — cache hit");
      return cached.block;
    }

    this._stats.retrievals++;
    const query = this.buildQuery(sid);
    log.debug({ sid, queryLen: query.length, queryPreview: query.slice(0, 80) }, "mnemosyne: retriever — querying");
    const { hits: rawHits, workflowHits, totalPool } = await this.retrieve(query, sid);
    this._stats.hitsTotal += rawHits.length;
    if (rawHits.length > 0) this._stats.retrievalsWithHits++;
    log.info({ sid, hits: rawHits.length, workflowHits: workflowHits.length, totalPool }, "mnemosyne: retriever — retrieved");

    // E3 — Advance turn counter + apply amnesia BEFORE deciding what to inject.
    this.incrementTurn(sid);
    this.applyAmnesia(sid);

    // E3 — Lightweight domain detection from hit tags (no extra I/O).
    const domainFreq = new Map<string, number>();
    for (const hit of rawHits) {
      const tags: string[] = hit.memory.tags ?? [];
      for (const tag of tags) {
        if (typeof tag === "string" && tag.startsWith("domain:")) {
          const d = tag.slice(7);
          domainFreq.set(d, (domainFreq.get(d) ?? 0) + 1);
        }
      }
    }
    const detectedDomains = [...domainFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([d]) => d);
    const activeDomains = [...new Set([...tier1Domains, ...detectedDomains])];
    log.debug({ sid, tier1Domains, detectedDomains, activeDomains, tier1Categories }, "mnemosyne: retriever — active attention");

    // #1 — Filter UNRELATED hits before formatting.
    // Filter UNRELATED vector hits: negative sim = no semantic relevance.
    // Graph hits are never filtered (pulled by explicit relation, not by sim).
    // Consistent with retrieve() slot logic: sim < 0 → not a semantic match.
    const filteredHits = rawHits.filter((h) => {
      if (h.source === "graph" || h.vectorSim == null) return true;
      return h.vectorSim >= 0; // drop any vector with negative cosine similarity
    });
    // Sort injected hits: vector hits by sim desc, then graph hits (sim=null) at bottom.
    // This ensures the LLM sees the strongest semantic match first.
    const sortedHits = [...filteredHits].sort((a, b) => {
      const av = a.vectorSim ?? -2;
      const bv = b.vectorSim ?? -2;
      return bv - av;
    });

    // E4 — Separate cognitive L2 from fact hits.
    const COGNITIVE_CATEGORIES = new Set(["reasoning-pattern", "decision-heuristic", "value-priority"]);
    const cognitiveHits = sortedHits.filter((h) => COGNITIVE_CATEGORIES.has(h.memory.category));
    const factHits = sortedHits.filter((h) => !COGNITIVE_CATEGORIES.has(h.memory.category));

    // Working memory: update entries for every retrieved hit BEFORE amnesia filter.
    // A high-scoring re-emerging memory clears its own forgotten flag inside
    // updateWorkingMemory — so the amnesia filter below will immediately let it through.
    for (const hit of sortedHits) {
      this.updateWorkingMemory(sid, hit.memory.id, hit.score);
    }

    // E6 — Amnesia filter: skip memories already resident in working memory
    // that have been forgotten (not seen for > AMNESIA_THRESHOLD turns).
    // updateWorkingMemory already cleared `forgotten` for re-emerging hits
    // (score update = fresh retrieval = re-emergence), so this filter only
    // suppresses entries that were NOT in the current retrieval.
    // NOTE: Since we call updateWorkingMemory above for all current hits,
    // only hits that were in WM from a PREVIOUS turn and NOT retrieved this
    // turn could still be forgotten. This means the amnesia filter mainly
    // prevents ghost re-injection from the block cache — correct behaviour.
    const amnesiaFilteredFacts = factHits.filter((hit) => {
      const entry = this.getWorkingMemory(sid).get(hit.memory.id);
      return !entry?.forgotten;
    });
    const amnesiaFilteredCognitive = cognitiveHits.filter((hit) => {
      const entry = this.getWorkingMemory(sid).get(hit.memory.id);
      return !entry?.forgotten;
    });

    const hits = [...amnesiaFilteredCognitive, ...amnesiaFilteredFacts];
    const block = this.format(amnesiaFilteredFacts, workflowHits, totalPool, amnesiaFilteredCognitive, activeDomains);
    this.cache.set(sid, { lastUserMsg: lastMsg, block });
    this.lastHits.set(sid, rawHits); // expose for injector timeline payload

    // Increment reinforcements on retrieved memories (D2: retrieval-only signal).
    // Best-effort — we do not want a Neo4j hiccup to break prompt construction.
    // Only reinforce memories that survived the amnesia filter (injected hits).
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
        log.error({ err: String(err) }, "mnemosyne: co-retrieval relation linking failed");
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

  private async retrieve(
    query: string,
    sessionId: string,
  ): Promise<{ hits: RetrievalHit[]; workflowHits: string[]; totalPool: number }> {
    log.debug({ sessionId, step: "vector-query", topK: this.opts.topK }, "mnemosyne: retrieve start");
    // 1. Vector top-K from short + long
    const shortHits = await this.store.chroma.query("short", query, this.opts.topK);
    const longHits = await this.store.chroma.query("long", query, this.opts.topK);
    const allChromaHits = [...shortHits, ...longHits];
    log.debug({ sessionId, shortHits: shortHits.length, longHits: longHits.length }, "mnemosyne: retrieve — chroma done");

    // 2. Hydrate Memory objects from canonical markdown store, applying
    //    privacy filter: visibility="open" OR same session.
    //    Dedup by id (a memory could theoretically appear in both layers
    //    during the brief promotion window).
    const seen = new Set<string>();
    const memories: RetrievalHit[] = [];
    // Cutoff in cosine-similarity space (range −1..+1). Default 0.0 means
    // "drop any match that's more orthogonal than aligned with the query".
    // Tunable via config so we can A/B different thresholds without code changes.
    const minSim = this.opts.minVectorSim ?? 0.0;
    let droppedSim = 0, droppedMem = 0, droppedPrivacy = 0;
    for (const ch of allChromaHits) {
      if (seen.has(ch.id)) continue;
      const vectorSim = 1 - ch.distance;
      // Apply the threshold BEFORE hydrating from markdown — saves I/O on
      // hits we'll discard anyway.
      // NOTE: chromadb with MiniLM can return distance > 1.0 for very short
      // queries (2-3 words), producing vectorSim < 0. We log but do NOT drop —
      // the reranker will still rank these hits by recency/reinforcements.
      if (vectorSim < minSim) {
        log.debug({ sessionId, id: ch.id, distance: ch.distance, vectorSim, minSim }, "mnemosyne: retrieve — drop by sim");
        droppedSim++;
        continue;
      }
      const mem = await this.store.markdownStore.read(ch.id);
      if (!mem) { droppedMem++; continue; }
      if (mem.visibility === "private" && mem.source_session !== sessionId) { droppedPrivacy++; continue; }
      seen.add(mem.id);
      // Preserve the raw vector similarity (1 - distance) BEFORE the reranker
      // overwrites .score with the weighted total. This is what the chat UI
      // surfaces as "did this memory match the prompt semantically?".
      memories.push({
        memory: mem,
        score: vectorSim,
        source: "vector",
        vectorSim,
        matchSnippet: computeMatchSnippet(query, mem),
      });
    }

    // 3. Graph 1-hop expansion. Seeds are the surviving vector hits.
    //    Graph hits don't have a vectorSim — they were pulled in by their
    //    relation to a seed, not by direct semantic match. We still compute
    //    the snippet though: even a graph-pulled memory may have lexical
    //    overlap that explains why it's contextually relevant.
    // 3. Graph 1-hop expansion — best-effort. When the graph layer is
    //    degraded (Neo4j down / unhealthy), we silently fall back to
    //    vector-only retrieval. The conversation still works, just without
    //    relation-based context expansion.
    // v1.3.1 — only positive-sim vectors are eligible to seed graph expansion.
    // See pickGraphSeeds() docstring and memory `kmp3qz` for the spec.
    // Without this guard, negative-sim vectors that survive the soft sim
    // threshold (minSim=-1.0 to support short queries) pull in unrelated
    // neighbors, producing orphan graph hits in the final injection.
    const graphSeeds = pickGraphSeeds(memories);
    const seedIds = graphSeeds.map((m) => m.memory.id);
    // For ancestry tracking: which positive-sim vector each graph hit came from.
    // Built by querying Neo4j seed-by-seed so we can stamp `seedId` on hits.
    log.debug({ sessionId, hydrated: memories.length, droppedSim, droppedMem, droppedPrivacy }, "mnemosyne: retrieve — hydration done");
    log.debug({ sessionId, seedIds: seedIds.length, graphDegraded: this.store.isGraphDegraded() }, "mnemosyne: retrieve — graph expand");
    if (seedIds.length > 0 && !this.store.isGraphDegraded()) {
      try {
        // Per-seed expansion so we know which seed brought each neighbor.
        // The batch oneHopNeighbors call would merge them and lose ancestry.
        for (const seed of graphSeeds) {
          const neighbors = await this.store.neo4j.oneHopNeighbors([seed.memory.id]);
          for (const n of neighbors) {
            if (seen.has(n.id)) continue;
            if (n.visibility === "private" && n.source_session !== sessionId) continue;
            seen.add(n.id);
            memories.push({
              memory: n,
              score: 0.5,
              source: "graph",
              seedId: seed.memory.id, // ← v1.3.1: track ancestry
              matchSnippet: computeMatchSnippet(query, n),
            });
          }
        }
        const graphCount = memories.filter((m) => m.source === "graph").length;
        log.debug({ sessionId, neighbors: graphCount }, "mnemosyne: retrieve — graph neighbors done");
      } catch (err) {
        log.error({ sessionId, err: String(err) }, "mnemosyne: oneHopNeighbors failed — vector-only");
      }
    }

    // 4. Detect contradictions for every surviving hit. Drives the
    //    ⚠️ Conflicts with: ... line in the rendered block. Skipped under
    //    graph degradation — no graph, no conflicts to read.
    if (!this.store.isGraphDegraded()) {
      for (const hit of memories) {
        try {
          const contradictions = await this.store.neo4j.getContradictions(hit.memory.id);
          if (contradictions.length) hit.conflicts_with = contradictions;
        } catch {
          // Per-hit failure — skip just this one.
        }
      }
    }

    // 5. Rerank and slice top-K.
    //    Reranker overwrites .score with the weighted total but preserves
    //    .vectorSim (we passed it through above). The UI uses vectorSim for
    //    sorting/display so the user sees "best semantic match first" rather
    //    than "most-reinforced first".
    //
    //    Graph-complement strategy: graph hits should AUGMENT vector results,
    //    not replace them. We reserve up to MIN_VECTOR_SLOTS slots for the
    //    best vector hits, then fill remaining slots with the best graph hits.
    //    This ensures the LLM always sees direct semantic matches first.
    const reranked = this.reranker.rerank(memories);

    // v1.3.1 — slot allocation extracted to pure function `selectTopHits`.
    // Strategy (spec memory `kmp3qz`):
    //   • Reserve up to MIN_VECTOR_SLOTS=2 slots for positive-sim vector hits.
    //   • Fill remaining slots with graph hits whose `seedId` survived into topVector.
    //   • No positive-sim vector → empty injection (no anchor, no relevance).
    //   • Graph hits without seed ancestry or with cut seeds are dropped.
    const MIN_VECTOR_SLOTS = Math.min(2, this.opts.topK);
    const top = selectTopHits(reranked, { topK: this.opts.topK, minVectorSlots: MIN_VECTOR_SLOTS });

    // Observability counters for the rerank step.
    const vectorPositive = reranked.filter((h) => h.source === "vector" && (h.vectorSim ?? -1) >= 0).length;
    const vectorNegative = reranked.filter((h) => h.source === "vector" && (h.vectorSim ?? -1) < 0).length;
    const graphInTop     = top.filter((h) => h.source !== "vector").length;
    const graphOrphansDropped = reranked.filter((h) => h.source !== "vector").length - graphInTop;

    if (top.length === 0 && vectorPositive === 0) {
      log.info({ sessionId, beforeRerank: memories.length, afterRerank: 0, reason: "no-vector-anchor" }, "mnemosyne: retrieve — no positive vector hits, suppressing graph");
    } else {
      log.info({
        sessionId,
        beforeRerank: memories.length,
        afterRerank: top.length,
        vectorPositive,
        vectorNegative,
        graphInTop,
        graphOrphansDropped,
      }, "mnemosyne: retrieve — rerank done");
    }

    // 6. v1.3 — attach graph neighborhood (parents + children) to each
    //    surviving hit. Best-effort: a Neo4j hiccup must not break retrieval.
    if (this.graphNeighborhood) {
      try {
        await this.enrichHits(top);
      } catch (err) {
        log.error({ err: String(err) }, "mnemosyne: graph enrichment failed");
      }
    }

    // 7. Workflow retrieval. Query the dedicated mnemosyne_workflows
    //    collection for procedures relevant to the current prompt and
    //    pre-render them as strings. We threshold at sim ≥ 0.6 because
    //    workflows are large, prescriptive blocks — false positives are
    //    expensive in token budget. Best-effort: the collection may not
    //    exist yet (fresh install) or the embed call may fail; either way
    //    we degrade silently to "no workflows injected".
    const workflowHits: string[] = [];
    try {
      const wfResults = await this.store.chroma.queryWorkflows(query, 3);
      for (const w of wfResults) {
        const similarity = 1 - w.distance;
        if (similarity < 0.6) continue;
        workflowHits.push(
          formatWorkflowHit({
            id: w.id,
            name: (w.metadata.name as string) ?? w.id,
            trigger: (w.metadata.trigger as string) ?? "",
            outcome: (w.metadata.outcome as string) ?? "",
            stepCount: (w.metadata.step_count as number) ?? 0,
            similarity,
          }),
        );
      }
    } catch {
      // mnemosyne_workflows collection may not exist yet — skip silently
    }

    return { hits: top, workflowHits, totalPool: memories.length };
  }

  /**
   * v1.3 — attach a {@link MemoryNeighborhood} to every hit in-place.
   * No-op when graph retrieval is disabled. Batched via `enrichBatch`
   * so we issue a single Neo4j round-trip for the whole hit list.
   */
  private async enrichHits(hits: RetrievalHit[]): Promise<void> {
    if (!this.graphNeighborhood) return;
    const ids = hits.map((h) => h.memory.id);
    const map = await this.graphNeighborhood.enrichBatch(ids);
    for (const hit of hits) {
      const n = map.get(hit.memory.id);
      if (n) hit.neighborhood = n;
    }
  }

  /**
   * Parse memory feedback signals emitted inline by the LLM in its response.
   *
   * Supported signals (invisible to the user — stripped by the renderer):
   *   [mnemo:used:ID]                 — LLM explicitly used this memory;
   *                                     bumps reinforcements beyond the
   *                                     retrieval-time increment.
   *   [mnemo:update:ID:new evidence]  — LLM adds new evidence/context that
   *                                     enriches the memory.
   *
   * Both signals are best-effort: failures are silently swallowed.
   */
  private async _parseFeedback(text: string): Promise<void> {
    // Resolve a short ID (8 chars) to a full UUID using recent hits across sessions.
    // The rendered id: field uses the LAST 8 chars (unique suffix) — match by endsWith.
    // Also try startsWith for backward compat with any old format still in circulation.
    const resolve = (shortId: string): string | null => {
      if (shortId.length > 16) return shortId; // already a full UUID
      for (const hits of this.lastHits.values()) {
        for (const h of hits) {
          if (h.memory.id.endsWith(shortId) || h.memory.id.startsWith(shortId)) {
            return h.memory.id;
          }
        }
      }
      return shortId.length >= 32 ? shortId : null; // reject very short IDs
    };

    // Match [mnemo:used:ID]
    const usedRe = /\[mnemo:used:([a-zA-Z0-9_\-]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = usedRe.exec(text)) !== null) {
      const id = resolve(m[1]);
      if (!id) continue;
      try {
        await this.store.incrementReinforcements(id);
        log.debug({ id }, "mnemosyne: feedback:used reinforced");
      } catch { /* swallow */ }
    }

    // Match [mnemo:update:ID:new evidence text]
    const updateRe = /\[mnemo:update:([a-zA-Z0-9_\-]+):([^\]]+)\]/g;
    while ((m = updateRe.exec(text)) !== null) {
      const id = resolve(m[1]);
      const newEvidence = m[2].trim();
      if (!id || !newEvidence) continue;
      try {
        const mem = await this.store.markdownStore.read(id).catch(() => null);
        if (!mem) continue;
        const existing = mem.evidence ?? "";
        if (existing.includes(newEvidence)) continue;
        const updated = { ...mem, evidence: existing ? `${existing}\n${newEvidence}` : newEvidence };
        await this.store.write(updated);
        log.debug({ id }, "mnemosyne: feedback:update enriched");
      } catch { /* swallow */ }
    }
  }

  /**
   * Build a grouped cognitive block from hits categorised as
   * reasoning-pattern, decision-heuristic, or value-priority.
   *
   * Groups entries by domain (from tags) and renders three subsections:
   * Values, Patterns, Heuristics. Prepended before the flat memory list
   * so the LLM applies the cognitive frame before reading individual facts.
   * Returns "" when there are no cognitive hits (no overhead for fact-only turns).
   */
  private buildCognitiveBlock(hits: RetrievalHit[], activeDomains: string[] = []): string {
    if (hits.length === 0) return "";

    const byDomain = new Map<string, { values: string[]; patterns: string[]; heuristics: string[] }>();
    for (const h of hits) {
      const tags: string[] = h.memory.tags ?? [];
      const domainTag = tags.find((t: string) => t.startsWith("domain:"));
      const domain = domainTag ? domainTag.slice(7) : (activeDomains[0] ?? "general");
      if (!byDomain.has(domain)) byDomain.set(domain, { values: [], patterns: [], heuristics: [] });
      const bucket = byDomain.get(domain)!;
      const entry = `- **${h.memory.title}**: ${h.memory.content ?? ""}`;
      if (h.memory.category === "value-priority")    bucket.values.push(entry);
      else if (h.memory.category === "reasoning-pattern") bucket.patterns.push(entry);
      else if (h.memory.category === "decision-heuristic") bucket.heuristics.push(entry);
    }

    const lines: string[] = [];
    for (const [domain, sections] of byDomain) {
      lines.push(`\n## How Sir thinks in [${domain}] (active cognitive context)`);
      if (sections.values.length > 0) {
        lines.push("**Values**:");
        lines.push(...sections.values);
      }
      if (sections.patterns.length > 0) {
        lines.push("**Patterns**:");
        lines.push(...sections.patterns);
      }
      if (sections.heuristics.length > 0) {
        lines.push("**Heuristics**:");
        lines.push(...sections.heuristics);
      }
    }
    return lines.join("\n");
  }

  private format(
    hits: RetrievalHit[],
    workflowHits: string[] = [],
    totalPool = 0,
    cognitiveHits: RetrievalHit[] = [],
    activeDomains: string[] = [],
  ): string {
    if (!hits.length && !workflowHits.length && !cognitiveHits.length) return "";
    const lines: string[] = [];

    // E5 — Cognitive block first so the LLM applies the thinking frame
    // before reading individual fact memories.
    const cognitiveBlock = this.buildCognitiveBlock(cognitiveHits, activeDomains);
    if (cognitiveBlock) {
      lines.push(cognitiveBlock);
      if (hits.length || workflowHits.length) lines.push(""); // blank separator
    }

    // Compact format — legend and signal guide live in the static system prompt
    // (gatedRetrieverPiece.systemContext). The ephemeral block uses the same
    // symbols/notations defined there without re-explaining them.
    hits.forEach((hit) => {
      const m = hit.memory;

      // ● vector / ◦ graph  HIGH|MEDIUM|WEAK  [category]  title
      const strength = hit.score >= 0.7 ? "HIGH" : hit.score >= 0.4 ? "MEDIUM" : "WEAK";
      const sourceTag = hit.source === "graph" ? "◦ graph" : "● vector";
      lines.push(`${sourceTag}  ${strength}  [${m.category}]  ${m.title}`);

      // Scores: sim (when available) + rerank + conf + reinf
      const simStr = hit.vectorSim != null ? `sim ${hit.vectorSim.toFixed(2)}` : null;
      const scores = [simStr, `rerank ${hit.score.toFixed(2)}`].filter(Boolean).join("  ");
      lines.push(`  ${scores}  ·  conf ${m.confidence?.toFixed(2) ?? "—"}  ·  reinf ${m.reinforcements}`);

      // why: score breakdown — debug signal kept for retrieval transparency
      const bd = hit.scoreBreakdown;
      if (bd) {
        lines.push(`  why: recency ${bd.recency.toFixed(2)}  conf ${bd.confidence.toFixed(2)}  reinf ${bd.reinforcements.toFixed(2)}  graph ${bd.graphDistance.toFixed(1)}`);
      }

      // matched on `terms`: snippet — explains why this memory was retrieved
      if (hit.matchSnippet?.matchedTerms?.length) {
        lines.push(`  matched on \`${hit.matchSnippet.matchedTerms.join(", ")}\`: ${hit.matchSnippet.text.slice(0, 120)}`);
      }

      // Memory content
      lines.push(`> ${m.content}`);

      // Evidence — compact snippet when present (truncated to keep block lean)
      if (m.evidence) {
        const snippet = m.evidence.length > 200 ? m.evidence.slice(0, 200) + "…" : m.evidence;
        lines.push(`  evidence: ${snippet}`);
      }

      // ⚠️ conflict marker (rare — only when detected)
      if (hit.conflicts_with?.length) {
        const refs = hit.conflicts_with.map((c) => c.slice(0, 4)).join(", ");
        lines.push(`⚠️ Conflicts with: ${refs}`);
      }

      // ↑/↓ graph neighborhood (defined in system prompt legend)
      const neighborhood = hit.neighborhood ? formatNeighborhood(hit.neighborhood) : "";
      if (neighborhood) lines.push(neighborhood);

      // id — use with memory_fetch(id), [mnemo:used:ID], [mnemo:update:ID:...]
      // Use the last 8 chars of the UUID: the suffix is unique across all memories
      // while the prefix (actor-mn, manual-t) is shared and causes collisions.
      lines.push(`  id:${m.id}`);

      lines.push("");
    });

    // Workflow section — appended after memories. Rendered with a divider
    // so the model treats memories and procedures as distinct blocks.
    if (workflowHits.length > 0) {
      if (hits.length) lines.push("---");
      lines.push("## Relevant workflows");
      lines.push("");
      for (const wh of workflowHits) {
        lines.push(wh);
        lines.push("");
      }
    }

    // v1.3 — hint when any hit has relations
    const hint = buildHint(hits, totalPool);
    if (hint) lines.push(hint);

    // Pool hint is now included in buildHint.

    return lines.join("\n");
  }
}
