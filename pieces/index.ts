import type { PluginContext, Piece } from "@jarvis/core";
import { EventBus } from "@jarvis/core";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import { homedir } from "os";

import { preflight, MnemosyneBootError } from "../lib/preflight.js";
import { ChromaServer } from "../lib/chroma-server.js";
import { ChromaAdapter } from "../lib/chroma-adapter.js";
import { Neo4jServer } from "../lib/neo4j-server.js";
import { Neo4jAdapter } from "../lib/neo4j-adapter.js";
import { MarkdownStore } from "../lib/markdown-store.js";
import { MnemosyneStore } from "../lib/store.js";
import { Logger } from "../lib/logger.js";
import { Extractor, type LLMClient } from "../lib/extractor.js";
import { Reranker } from "../lib/reranker.js";
import { ConflictDetector } from "../lib/conflict-detector.js";
import { SemanticRelationLinker } from "../lib/semantic-relation-linker.js";
import { ReplayEngine } from "../lib/replay-engine.js";
import { ObserverPiece } from "./observer.js";
import { EncoderPiece } from "./encoder.js";
import { RetrieverPiece } from "./retriever.js";
import { ConsolidatorPiece } from "./consolidator.js";
import { PanelPiece } from "./panel.js";
import { RelatePiece } from "./relate.js";
import { EncoderV12, type EncodedMemory } from "../lib/v12/encoder-v12.js";
import { CategoryCatalog } from "../lib/v12/category-catalog.js";
import { PendingCategoriesStore } from "../lib/v12/pending-categories-store.js";
import { RelateJudge } from "../lib/v12/relate-judge.js";
import { v4 as uuidv4 } from "uuid";
import type { Memory } from "../lib/types.js";
import {
  buildMemorySearchTool,
  buildMemoryGetTool,
  buildMemoryListTool,
  buildMemoryExplainTool,
} from "../lib/tools/memory-search.js";
import {
  buildMemoryUpdateTool,
  buildMemoryPinTool,
  buildMemoryUnpinTool,
  buildMemoryDeleteTool,
  buildMemoryPromoteTool,
} from "../lib/tools/memory-management.js";
import {
  buildWorkflowListTool,
  buildWorkflowGetTool,
  buildWorkflowReplayTool,
} from "../lib/tools/workflow-tools.js";
import {
  buildMnemosyneConsolidateTool,
  buildMnemosyneStatsTool,
} from "../lib/tools/admin-tools.js";
import { buildMemoryFetchTool } from "../lib/tools/memory-fetch.js";
import { buildMnemosyneTriageTool } from "../lib/tools/triage-tool.js";
import { GraphNeighborhoodService } from "../lib/graph-neighborhood.js";

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = `${process.env.HOME}/.jarvis/mnemosyne`;

/**
 * Plugin entry point.
 *
 * The @jarvis/core PluginContext expects `createPieces` to return `Piece[]`
 * synchronously (the plugin loader does `for (const piece of pieces)` over
 * the return value — a Promise would break iteration). All async setup
 * (preflight, server boot, adapter connect, schema apply) is therefore
 * kicked off as a background bootstrap promise that each piece's `start()`
 * awaits before becoming functional.
 */
export function createPieces(ctx: PluginContext): Piece[] {
  // Shared handle so `createPieces` can register the context injector before
  // bootstrap resolves, while still letting `gatedRetrieverPiece` populate
  // `real` once bootstrap completes. The injector is registered eagerly with
  // the core; until `real` is set, it contributes nothing (returns []).
  const retrieverHandle: { real: RetrieverPiece | undefined } = { real: undefined };

  const bootstrap = bootstrapAsync(ctx);
  // Guard against unhandled rejection while the pieces still wait for it
  bootstrap.catch((err) => {
    console.error("[mnemosyne] bootstrap failed:", err);
  });
  bootstrap.then((b) => { retrieverHandle.real = b.retriever; }).catch(() => { /* logged */ });

  // Cache-friendly memory injection (since 0.4.0):
  // Instead of injecting via Piece.systemContext (which goes into the system
  // prompt array and INVALIDATES PROMPT CACHE every turn since the block
  // mutates), we register a ContextInjector with the core. The core inserts
  // our block as an ephemeral user message right BEFORE the user's actual
  // prompt — preserving cache for the (large, stable) system prompt.
  //
  // Reinforcement-on-retrieval (D2) still happens here: the injector calls
  // retriever.systemContext(sessionId) which bumps `reinforcements` for every
  // hit that lands in the block.
  if (typeof ctx.registerContextInjector === "function") {
    const SESSION_EXCLUDE = /mnemosyne-skip/;
    // Per-session tracking:
    //   lastInjectedBlock     — full block string dedup (same block → skip)
    //   lastNotifiedBlock     — same dedup for timeline notification
    //   recentlyInjectedIds   — ring buffer (INJECTION_HISTORY_TURNS deep) of
    //                           Sets of memory IDs injected on each turn.
    //                           Memories already in this window are suppressed
    //                           from re-injection — the model already has them
    //                           in its context window from recent turns.
    const INJECTION_HISTORY_TURNS = 15;
    const lastInjectedBlock = new Map<string, string>();
    const lastNotifiedBlock = new Map<string, string>();
    const recentlyInjectedIds = new Map<string, string[][]>();

    function recordInjectedIds(sid: string, ids: string[]): void {
      const hist = recentlyInjectedIds.get(sid) ?? [];
      hist.push(ids);
      if (hist.length > INJECTION_HISTORY_TURNS) hist.shift();
      recentlyInjectedIds.set(sid, hist);
    }

    function seenIds(sid: string): Set<string> {
      const hist = recentlyInjectedIds.get(sid) ?? [];
      return new Set(hist.flat());
    }

    // When the context is compacted (Engine A or B), the conversation history is
    // replaced and the previous memory block is gone — reset so we reinject on the
    // next turn.
    ctx.bus.subscribe("ai.stream", (msg: any) => {
      if (msg.event === "compaction" || msg.event === "compaction_start") {
        const sid = msg.target ?? "main";
        lastInjectedBlock.delete(sid);
        lastNotifiedBlock.delete(sid);
        recentlyInjectedIds.delete(sid); // model lost context — start fresh
      }
    });
    ctx.registerContextInjector(async (sessionId: string): Promise<string[]> => {
      if (SESSION_EXCLUDE.test(sessionId)) return []; // skip ephemeral workers
      const ready = retrieverHandle.real;
      if (!ready) return []; // bootstrap not done yet — opt out

      type Cache = Map<string, { lastUserMsg: string; block: string }>;
      type LastMsg = Map<string, string>;
      type PendingMap = Map<string, Promise<string>>;
      const cache = (ready as unknown as { cache: Cache }).cache;
      const lastMsgMap = (ready as unknown as { lastUserMsg: LastMsg }).lastUserMsg;
      const pendingMap = (ready as unknown as { pendingFetch: PendingMap }).pendingFetch;
      const lastMsg = lastMsgMap.get(sessionId);

      // No user message observed yet on this session — nothing to retrieve.
      if (!lastMsg) return [];

      const cached = cache.get(sessionId);

      // If there's an in-flight fetch for this session (kicked off by the
      // ai.request subscriber), await it with a 800ms safety timeout so
      // we inject fresh data on the SAME turn rather than always lagging.
      if (cached?.lastUserMsg !== lastMsg) {
        const pending = pendingMap.get(sessionId);
        if (pending) {
          try {
            await Promise.race([
              pending,
              new Promise<void>((_, rej) => setTimeout(() => rej(new Error("timeout")), 800)),
            ]);
          } catch {
            // Timeout or error — fall through to whatever cache has now
          }
        }
      }

      // Re-read cache after potential await
      const freshCached = cache.get(sessionId);
      const block = freshCached?.block ?? "";
      // Record every injection attempt so the HUD can show success rate.
      // We count both empty (no block) and successful injections, so the
      // ratio injectionsWithBlock/injections gives the "useful injection"
      // gauge directly.
      ready.recordInjection(!!block);
      if (!block) return [];

      // Skip injection if the block is identical to what was last injected for
      // this session — the model already has it in its context window from the
      // previous turn's ephemeral block, so re-sending is pure noise and wastes
      // a cache breakpoint.
      if (block === lastInjectedBlock.get(sessionId)) return [];

      // ── Per-memory dedup across recent turns ──────────────────────────────
      // Filter out memories the model already received in the last
      // INJECTION_HISTORY_TURNS turns. Only inject what's genuinely new.
      // If ALL memories in the block are already known, skip entirely.
      const lastHitsMap2 = (ready as unknown as { lastHits: Map<string, unknown[]> }).lastHits;
      const currentHits = (lastHitsMap2?.get(sessionId) ?? []) as Array<{ memory: { id: string } }>;
      const currentIds = currentHits.map((h) => h.memory.id);
      const seen = seenIds(sessionId);
      const newIds = currentIds.filter((id) => !seen.has(id));

      if (currentIds.length > 0 && newIds.length === 0) {
        // All memories in this block were already injected recently — suppress.
        // Still record for the ring buffer so the window stays accurate.
        recordInjectedIds(sessionId, currentIds);
        return [];
      }

      // Record the full set injected this turn (new + carried) for future dedup.
      recordInjectedIds(sessionId, currentIds);
      lastInjectedBlock.set(sessionId, block);

      // Surface the injection in the chat timeline only when the injected
      // block actually changed — same memories on consecutive turns stay silent.
      if (ctx.addChatTimelineEntry && block !== lastNotifiedBlock.get(sessionId)) {
        lastNotifiedBlock.set(sessionId, block);
        const lastHitsMap = (ready as unknown as { lastHits: Map<string, unknown[]> }).lastHits;
        // Full RetrievalHit shape — score, source, scoreBreakdown,
        // conflicts_with already populated by retrieve()/rerank().
        const lastHits = lastHitsMap?.get(sessionId) as Array<{
          memory: { id: string; category: string; title: string; confidence: number; reinforcements: number };
          score: number;
          source: "vector" | "graph" | "workflow_lookup";
          scoreBreakdown?: { recency: number; confidence: number; reinforcements: number; graphDistance: number; total: number };
          conflicts_with?: string[];
          vectorSim?: number;
          matchSnippet?: { text: string; matchedTerms: string[]; source: "content" | "title" };
        }> | undefined;
        // Build the per-memory payload, then sort by vectorSim desc so the
        // chat card shows the strongest semantic match at the top. Graph hits
        // (no vectorSim) sink to the bottom — they were pulled by relation,
        // not by direct query match, and that's the right reading order.
        const memories = (lastHits ?? [])
          .map((h) => ({
            id: h.memory.id,
            category: h.memory.category,
            title: h.memory.title,
            confidence: h.memory.confidence,
            reinforcements: h.memory.reinforcements,
            source: h.source,
            score: h.score,
            scoreBreakdown: h.scoreBreakdown,
            conflicts: h.conflicts_with ?? [],
            vectorSim: h.vectorSim,
            matchSnippet: h.matchSnippet,
          }))
          .sort((a, b) => {
            const av = a.vectorSim ?? -1;
            const bv = b.vectorSim ?? -1;
            return bv - av;
          });
        const count = memories.length || block.split("\n").filter((l) => l.startsWith("**[")).length;
        const label = count === 1 ? "1 memory" : `${count} memories`;
        // Aggregate source breakdown for the header (◆ vector:N · ◇ graph:N).
        const sourceCounts = memories.reduce(
          (acc, m) => {
            if (m.source === "graph") acc.graph++;
            else if (m.source === "workflow_lookup") acc.workflow++;
            else acc.vector++;
            return acc;
          },
          { vector: 0, graph: 0, workflow: 0 },
        );
        ctx.addChatTimelineEntry(sessionId, {
          text: `🧠 Mnemosyne — injected ${label}`,
          rendererKind: "mnemosyne-memory-injection",
          renderer: { plugin: "jarvis-plugin-mnemosyne", file: "MemoryInjectionEntry" },
          payload: { count, query: lastMsg, sourceCounts, memories },
        });
      }

      // Wrap in <system-reminder> so the model treats this as background
      // context rather than user-authored content. Anthropic recognizes
      // this tag natively and adjusts tone accordingly — no risk of the
      // model citing memories verbatim or treating them as instructions.
      const wrapped = `<system-reminder>
The following memories were retrieved by Mnemosyne based on the current conversation context. Use them as background knowledge — past decisions, preferences, and patterns from previous sessions. Do not cite them verbatim unless directly relevant to the current task.

${block}
</system-reminder>`;

      return [wrapped];
    });
  }

  // Each piece is wrapped in a gate that awaits bootstrap before delegating
  // to the real piece's start(). The wrapped piece exposes the same id/name
  // so the HUD and capability registry behave identically.
  return [
    gatedPiece("mnemosyne-observer", "Mnemosyne Observer", bootstrap, (b) => b.observer),
    gatedPiece("mnemosyne-encoder", "Mnemosyne Encoder", bootstrap, (b) => b.encoder),
    gatedRetrieverPiece(bootstrap, retrieverHandle),
    gatedPiece("mnemosyne-consolidator", "Mnemosyne Consolidator", bootstrap, (b) => b.consolidator),
    gatedPiece("mnemosyne-panel", "Mnemosyne Panel", bootstrap, (b) => b.panel),
  ];
}

/** Bootstrap result: every long-lived component built during async init. */
interface Bootstrap {
  observer: ObserverPiece;
  encoder: EncoderPiece;
  retriever: RetrieverPiece;
  consolidator: ConsolidatorPiece;
  panel: PanelPiece;
  /** Cached most recent block per session for sync systemContext() */
  retrieverCache: Map<string, string>;
}

async function bootstrapAsync(ctx: PluginContext): Promise<Bootstrap> {
  // 1. Preflight — fail loud (D13)
  try {
    await preflight();
  } catch (e) {
    if (e instanceof MnemosyneBootError) {
      ctx.bus.publish({
        channel: "hud.update",
        source: "mnemosyne",
        action: "add",
        pieceId: "mnemosyne-preflight-error",
        piece: {
          pieceId: "mnemosyne-preflight-error",
          type: "panel",
          name: "Mnemosyne — boot failed",
          status: "error",
          data: { failures: e.failures },
          ephemeral: true,
          renderer: { plugin: "jarvis-plugin-mnemosyne", file: "PreflightErrorPanel" },
        },
      });
    }
    throw e;
  }

  // 2. Load (or seed) config
  const configPath = join(DATA_DIR, "config.json");
  const config = await loadOrCreateConfig(configPath);

  // 3. Start Chroma server
  const chromaServer = new ChromaServer({
    dataDir: join(DATA_DIR, "chroma-data"),
    port: config.chroma.port,
  });
  await chromaServer.start();

  // 4. Start Neo4j container, validate loopback binding (D10)
  const neo4jServer = new Neo4jServer({
    composeFile: join(__dirname, "../docker/docker-compose.yml"),
    containerName: config.neo4j.container_name,
    boltUri: config.neo4j.bolt_uri,
  });
  await neo4jServer.start();

  if (!(await neo4jServer.validateLoopbackBinding())) {
    throw new Error(
      "Neo4j ports not bound to 127.0.0.1 — refusing to start (security)"
    );
  }

  // 5. Connect adapters
  const chroma = new ChromaAdapter({
    host: config.chroma.host,
    port: config.chroma.port,
    embeddingModel: config.chroma.embedding_model,
  });
  await chroma.init();

  const neo4j = new Neo4jAdapter({ uri: config.neo4j.bolt_uri });
  await neo4j.connect();
  await neo4j.applySchema(join(__dirname, "../cypher/schema.cypher"));

  const markdownStore = new MarkdownStore(DATA_DIR);
  const logger = new Logger(DATA_DIR);
  const store = new MnemosyneStore(markdownStore, chroma, neo4j, logger);

  // 6. Build pipelines
  const llm = makeLLMClient(ctx);
  const conflictDetector = new ConflictDetector(llm, chroma, neo4j, {
    similarityThreshold: config.consolidator.conflict_similarity_threshold,
    promptsDir: join(__dirname, "../prompts"),
  });
  const reranker = new Reranker(config.retriever.rerank_weights);
  // ReplayEngine constructed for Task 13 tools to consume
  const replayEngine = new ReplayEngine({ logger });

  // 7. Construct pieces — v12 pipeline is the only path
  // EncoderPiece is constructed with a placeholder hook; wireV12Pipeline
  // replaces it with the real EncoderV12 + RelatePiece after building them.
  const encoder = new EncoderPiece(store, logger, { encoder: null as any });
  const observer = new ObserverPiece(
    (turn) => encoder.enqueue(turn),
    config.encoder.context_window_size ?? 10
  );
  const retriever = new RetrieverPiece(store, reranker, {
    topK: config.retriever.top_k_vector,
    graphHops: config.retriever.graph_hops,
    workflowLookupEnabled: config.retriever.workflow_lookup_enabled,
    // New since 0.5.x — drops "more-orthogonal-than-aligned" hits before
    // they pollute context. Default 0.0; tune via config to be stricter.
    minVectorSim: config.retriever.min_vector_sim ?? 0.0,
    // v1.3 — graph neighborhood injection. Disabled by default; enable via config.
    graphRetrieval: config.graph_retrieval?.enabled
      ? {
          enabled: true,
          maxParents: config.graph_retrieval.max_parents,
          maxChildren: config.graph_retrieval.max_children,
        }
      : undefined,
  });
  const consolidator = new ConsolidatorPiece(store, conflictDetector, logger, {
    cron: config.consolidator.cron,
    skipIfActiveWithinMinutes: config.consolidator.skip_if_active_within_minutes,
    promotionReinforcementsThreshold: config.consolidator.promotion_threshold_reinforcements,
    promotionConfidenceThreshold: config.consolidator.promotion_threshold_confidence,
    mergeSimilarityThreshold: config.consolidator.merge_similarity_threshold,
    decay: config.decay,
  });
  const panel = new PanelPiece(store, neo4j, logger);
  // Late binding: the panel needs encoder + retriever for live stats. Both
  // were created above in this same bootstrap function; safe to wire now.
  panel.setStatsSources(encoder, retriever);

  // 7b. Wire the pipeline (always — no feature flag)
  // relatePieceRef is passed to registerTools so memory_promote can trigger
  // relate after promotion. wireV12Pipeline populates relatePieceRef.current.
  const relatePieceRef: { current?: RelatePiece } = {};
  await wireV12Pipeline({ encoder, store, chroma, neo4j, llm, logger, config, relatePieceRef });

  // 8. Cron registration (D12: 3am daily consolidation)
  registerCron(ctx, config.consolidator.cron);

  // 9. Tool registration (Task 13)
  registerTools(ctx, store, neo4j, consolidator, replayEngine, encoder, config.retriever.rerank_weights, config, relatePieceRef);

  // 10. HTTP routes used by the HUD renderer (MemoryCard / MnemosynePanel).
  // The renderer fetches POST /plugins/jarvis-plugin-mnemosyne/{forget,pin,consolidate}.
  // Without these the trash / pin buttons silently 404. We register thin
  // wrappers that share the same handlers as the assistant-facing tools.
  registerHttpRoutes(ctx, store, consolidator, panel);

  return {
    observer,
    encoder,
    retriever,
    consolidator,
    panel,
    retrieverCache: new Map(),
  };
}

/**
 * Tiny helper to read a JSON body off the incoming request. Returns `null`
 * if the body is empty or not parseable — callers must handle that.
 */
function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function jsonResponse(res: any, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Wire up the HUD-facing HTTP routes. These are intentionally one-liners that
 * delegate to the same store/consolidator surface the assistant-facing tools
 * use, so behaviour stays consistent across both entry points.
 *
 * Routes (all POST):
 *   /plugins/jarvis-plugin-mnemosyne/forget         { id }
 *   /plugins/jarvis-plugin-mnemosyne/pin            { id, pinned }
 *   /plugins/jarvis-plugin-mnemosyne/consolidate    (no body)
 *   /plugins/jarvis-plugin-mnemosyne/rebuild-indexes (no body — currently 501)
 */
function registerHttpRoutes(
  ctx: PluginContext,
  store: MnemosyneStore,
  consolidator: ConsolidatorPiece,
  panel: PanelPiece
): void {
  const base = "/plugins/jarvis-plugin-mnemosyne";

  ctx.registerRoute("POST", `${base}/forget`, async (req: any, res: any) => {
    try {
      const body = await readJsonBody(req);
      const id = typeof body?.id === "string" ? body.id : null;
      if (!id) return jsonResponse(res, 400, { ok: false, error: "missing 'id'" });
      const mem = await store.markdownStore.read(id).catch(() => null);
      if (!mem) return jsonResponse(res, 404, { ok: false, error: "not found" });
      await store.delete(id);
      // Force the panel to refresh so the UI reflects the deletion immediately.
      void panel.refreshNow().catch(() => {});
      jsonResponse(res, 200, { ok: true, id });
    } catch (e: any) {
      jsonResponse(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.registerRoute("POST", `${base}/pin`, async (req: any, res: any) => {
    try {
      const body = await readJsonBody(req);
      const id = typeof body?.id === "string" ? body.id : null;
      const pinned = body?.pinned === true;
      if (!id) return jsonResponse(res, 400, { ok: false, error: "missing 'id'" });
      const mem = await store.markdownStore.read(id).catch(() => null);
      if (!mem) return jsonResponse(res, 404, { ok: false, error: "not found" });
      if (Boolean(mem.pinned) === pinned) {
        return jsonResponse(res, 200, { ok: true, id, no_op: true });
      }
      await store.write({ ...mem, pinned });
      void panel.refreshNow().catch(() => {});
      jsonResponse(res, 200, { ok: true, id, pinned });
    } catch (e: any) {
      jsonResponse(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  });

  ctx.registerRoute("POST", `${base}/consolidate`, async (_req: any, res: any) => {
    try {
      const stats = await consolidator.run();
      void panel.refreshNow().catch(() => {});
      jsonResponse(res, 200, { ok: true, stats });
    } catch (e: any) {
      jsonResponse(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  });

  // POST /refresh — force an immediate panel refresh (stats + memories)
  ctx.registerRoute("POST", `${base}/refresh`, async (_req: any, res: any) => {
    try {
      await panel.refreshNow();
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: String(e) });
    }
  });

  // GET /prompts — list all extract-*.md and triage.md files with content
  ctx.registerRoute("GET", `${base}/prompts`, async (_req: any, res: any) => {
    try {
      const promptsDir = join(ctx.pluginDir, "prompts");
      const files = await fs.readdir(promptsDir);
      const extractFiles = files.filter((f) => f.endsWith(".md") && f.startsWith("extract-"));
      const prompts = await Promise.all(
        extractFiles.sort().map(async (name) => {
          const content = await fs.readFile(join(promptsDir, name), "utf-8");
          const category = name.replace(/^extract-/, "").replace(/\.md$/, "");
          return { name, category, content };
        })
      );
      jsonResponse(res, 200, { prompts });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: String(e) });
    }
  });

  // PUT /prompts/<name> — save a prompt file (name extracted from URL suffix)
  ctx.registerRoute("PUT", `${base}/prompts/`, async (req: any, res: any) => {
    try {
      const url: string = req.url ?? "";
      const prefix = `${base}/prompts/`;
      const name = decodeURIComponent(url.slice(url.indexOf(prefix) + prefix.length).split("?")[0]);
      if (!name.endsWith(".md") || !name.startsWith("extract-") || name.includes("/") || name.includes("..")) {
        return jsonResponse(res, 400, { ok: false, error: "invalid prompt name" });
      }
      const body = await readJsonBody(req);
      const content = typeof body?.content === "string" ? body.content : null;
      if (content === null) return jsonResponse(res, 400, { ok: false, error: "missing content" });
      const promptsDir = join(ctx.pluginDir, "prompts");
      await fs.writeFile(join(promptsDir, name), content, "utf-8");
      jsonResponse(res, 200, { ok: true });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: String(e) });
    }
  });

  ctx.registerRoute("POST", `${base}/rebuild-indexes`, (_req: any, res: any) => {
    // Index rebuild is a long-running script (scripts/rebuild-indexes.ts).
    // Surfacing it through the HUD requires a job-runner we don't have yet,
    // so we return a clear 501 instead of pretending to start the work.
    jsonResponse(res, 501, {
      ok: false,
      error: "rebuild-indexes is not available via HUD. Run scripts/rebuild-indexes.ts manually.",
    });
  });
}

/**
 * Generic gated wrapper: presents a stable Piece identity to the loader and
 * defers start() to bootstrap completion + the real piece's start(). The
 * underlying piece's systemContext (sync, no args) is delegated when present.
 */
function gatedPiece<P extends Piece>(
  id: string,
  name: string,
  bootstrap: Promise<Bootstrap>,
  pick: (b: Bootstrap) => P
): Piece {
  let real: P | undefined;
  return {
    id,
    name,
    async start(bus) {
      const b = await bootstrap;
      real = pick(b);
      await real.start(bus);
    },
    async stop() {
      if (real) await real.stop();
    },
    systemContext: () => real?.systemContext?.() ?? "",
  };
}

/**
 * Retriever needs its own gated wrapper because its real `systemContext`
 * is async (Promise<string>) and takes a sessionId — the @jarvis/core
 * `Piece.systemContext` is sync and takes no args. Per errata #18 we cache
 * the last computed block per session and refresh asynchronously on cache
 * miss. First call returns "" (no cached block); subsequent calls return
 * fresh data.
 *
 * The retriever's own internal cache (keyed by lastUserMsg) handles the
 * inner correctness; this wrapper just bridges the sync signature.
 */
/**
 * Retriever piece wrapper. As of 0.4.0 the retriever no longer contributes
 * to the system prompt via `systemContext` — that path invalidated prompt
 * cache because the memory block mutates between turns. Memory injection
 * now happens through `ctx.registerContextInjector` (registered up in
 * `createPieces`), which inserts the block as an ephemeral user message
 * with `cache_control: ephemeral` — preserving cache for the system prompt.
 *
 * This wrapper just gates start()/stop() on bootstrap and keeps the shared
 * `handle.real` populated so the injector closure can reach the live retriever.
 */
function gatedRetrieverPiece(
  bootstrap: Promise<Bootstrap>,
  handle: { real: RetrieverPiece | undefined }
): Piece {
  return {
    id: "mnemosyne-retriever",
    name: "Mnemosyne Retriever",
    async start(bus) {
      const b = await bootstrap;
      handle.real = b.retriever;
      await b.retriever.start(bus);
    },
    async stop() {
      if (handle.real) await handle.real.stop();
    },
    // Intentionally NO systemContext: memory injection moved to context injector.
  };
}

/* ------------------------------------------------------------------ helpers */

async function loadOrCreateConfig(configPath: string): Promise<any> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    const defaultsPath = join(__dirname, "../config.default.json");
    const defaults = JSON.parse(await fs.readFile(defaultsPath, "utf-8"));
    await fs.mkdir(dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(defaults, null, 2));
    return defaults;
  }
}

/**
 * LLMClient bridge.
 *
 * The plan referenced a `ctx.bus.request` API for synchronous-style
 * request/reply against the providerRouter, but @jarvis/core's EventBus
 * exposes only `publish`/`subscribe`. Until a proper request/reply helper
 * exists (or until Mnemosyne grows a dedicated `ai.invoke` channel with a
 * reply listener), we use a publish-with-replyTo + subscribe-once pattern.
 *
 * For Task 12 the client is wired but never exercised — the Encoder runs
 * the LLM lazily on incoming turns, and no turns flow until the plugin is
 * actually loaded into a JARVIS runtime. Tasks 13-16 will exercise this.
 */
/**
 * LLM bridge for the Extractor / ConflictDetector.
 *
 * Uses ctx.sessionFactory directly — bypasses the bus entirely. Each call
 * creates an ephemeral AISession, streams its response, accumulates the
 * text, and closes the session. No phantom session pollution, no stream
 * filtering, no replyTo correlation — the SDK handles it natively.
 *
 * Failure modes:
 *   - 60s hard timeout (model load + extraction can be ~5-30s for Haiku;
 *     headroom of 60s is generous and prevents unbounded hangs).
 *   - Stream emits an `error` event → throws with that message.
 *   - Empty response → returns "" (caller validates).
 */
function makeLLMClient(ctx: PluginContext): LLMClient {
  return {
    async call({ system, user }) {
      const factory = ctx.sessionFactory;
      const label = `mnemosyne-llm-${crypto.randomUUID().slice(0, 8)}`;
      const session = factory.createWithPrompt({
        label,
        basePromptOverride: system,
      });

      try {
        const ac = new AbortController();
        const timeoutId = setTimeout(() => ac.abort(), 60_000);

        let text = "";
        let errored: string | undefined;
        let inputTokens = 0;
        let outputTokens = 0;

        try {
          for await (const event of session.sendAndStream(user)) {
            if (ac.signal.aborted) {
              throw new Error("LLM call timed out after 60s");
            }
            if (event.type === "text_delta" && event.text) {
              text += event.text;
            } else if (event.type === "error") {
              errored = event.error ?? "Unknown LLM error";
              break;
            } else if (event.type === "message_complete") {
              inputTokens = event.usage?.input_tokens ?? 0;
              outputTokens = event.usage?.output_tokens ?? 0;
              break;
            }
          }
        } finally {
          clearTimeout(timeoutId);
        }

        if (errored) throw new Error(errored);

        // claude-haiku-3-5: $0.80/MTok input, $4.00/MTok output
        const costUsd = (inputTokens / 1_000_000) * 0.80 + (outputTokens / 1_000_000) * 4.00;
        return { text, costUsd };
      } finally {
        session.close();
        // Notify metrics-hud (and any other subscriber) that this ephemeral
        // session is gone — otherwise its bucket lingers forever in the
        // scope dropdown. AnthropicMetrics keys buckets by the human-readable
        // `label` (see AnthropicSession.streamFromAPI emitting
        // `system.event api.anthropic.usage` with `sessionId: this.label`).
        // We must echo the SAME label here for the eviction to match.
        ctx.bus.publish({
          channel: "system.event",
          source: "mnemosyne-llm",
          event: "session.closed",
          data: { sessionId: label },
        });
      }
    },
  };
}

/**
 * Cron registration via the capability bus.
 *
 * The capability.request channel uses `{ calls: CapabilityCall[] }` shape
 * (see @jarvis/core/types.ts), not the `{ capability, args }` shape the
 * plan sketched. We construct a CapabilityCall envelope.
 */
function registerCron(ctx: PluginContext, cron: string): void {
  ctx.bus.publish({
    channel: "capability.request",
    source: "mnemosyne",
    calls: [
      {
        id: `mnemosyne-consolidator-cron-${Date.now()}`,
        name: "cron_create",
        input: {
          cron,
          target: "main",
          prompt: "[mnemosyne-internal] consolidate",
          recurring: true,
        },
      },
    ],
  });
}

/**
 * Tool registration — 14 capabilities exposed to the assistant per
 * architecture.md "Tools expostos ao assistant".
 *
 * Groups (mirroring lib/tools/* modules):
 *   - memory-search:     memory_search, memory_get, memory_list, memory_explain
 *   - memory-management: memory_update, memory_pin, memory_unpin,
 *                        memory_delete, memory_promote
 *   - workflow-tools:    workflow_list, workflow_get, workflow_replay
 *   - admin-tools:       mnemosyne_consolidate, mnemosyne_stats
 *
 * Each builder returns a `CapabilityDefinition` (per @jarvis/core/types.ts):
 * `{ name, description, input_schema, handler }`. The CapabilityExecutor
 * picks them up off the `capability.request` channel using the
 * `{ source, calls: [{id, name, input}] }` envelope shape (errata #22).
 */
interface RerankWeights {
  recency: number;
  confidence: number;
  reinforcements: number;
  graph_distance: number;
}

function registerTools(
  ctx: PluginContext,
  store: MnemosyneStore,
  neo4j: Neo4jAdapter,
  consolidator: ConsolidatorPiece,
  replay: ReplayEngine,
  encoder: EncoderPiece,
  rerankWeights: RerankWeights,
  config: any,
  relatePieceRef?: { current?: import("./relate.js").RelatePiece }
): void {
  const reg = ctx.capabilityRegistry;

  // Memory — search & inspection
  reg.register(buildMemorySearchTool(store));
  reg.register(buildMemoryGetTool(store));
  reg.register(buildMemoryListTool(store));
  reg.register(buildMemoryExplainTool(store, rerankWeights));

  // Memory — management
  reg.register(buildMemoryUpdateTool(store));
  reg.register(buildMemoryPinTool(store));
  reg.register(buildMemoryUnpinTool(store));
  reg.register(buildMemoryDeleteTool(store));
  reg.register(buildMemoryPromoteTool(store, relatePieceRef?.current));

  // Workflows
  reg.register(buildWorkflowListTool(neo4j));
  reg.register(buildWorkflowGetTool(neo4j));
  reg.register(buildWorkflowReplayTool(neo4j, replay));

  // Admin
  reg.register(buildMnemosyneConsolidateTool(consolidator));
  reg.register(buildMnemosyneStatsTool(store));
  reg.register(buildMnemosyneTriageTool(encoder));

  // v1.3 Graph Retrieval — memory_fetch tool (gated by config)
  // t-4 wires graphNeighborhood at bootstrap level; until that lands, we
  // instantiate a local service here so the tool stays self-contained.
  // The adapter to MnemosyneStore exposes the minimal `get(id)` shape the
  // tool expects (delegating to markdownStore.read).
  if (config?.graph_retrieval?.enabled === true) {
    const graphNeighborhood = new GraphNeighborhoodService(neo4j, {
      maxParents: config?.graph_retrieval?.max_parents,
      maxChildren: config?.graph_retrieval?.max_children,
    });
    const storeAdapter = {
      get: (id: string) => store.markdownStore.read(id),
    };
    reg.register(buildMemoryFetchTool(storeAdapter, graphNeighborhood));
  }
}

/* ---------------------------------------------------------------- v1.2 wiring */

interface V12WireOpts {
  encoder: EncoderPiece;
  store: MnemosyneStore;
  chroma: ChromaAdapter;
  neo4j: Neo4jAdapter;
  llm: LLMClient;
  logger: Logger;
  config: any;
  relatePieceRef?: { current?: RelatePiece };
}

/**
 * Builds the v1.2 TRIPLET pipeline and wires it into the existing
 * EncoderPiece. Side-effects only; no return value. Called from
 * bootstrapAsync when `pipeline.v12_enabled === true`.
 *
 * Wiring:
 *   - CategoryCatalog          ← seed prompts + dynamic categories dir
 *   - PendingCategoriesStore   ← persists between-turn proposals
 *   - EncoderV12               ← orchestrates triage/classify/gate/intra-turn
 *   - EncoderV12 sink          ← maps EncodedMemory → Memory and calls
 *                                MnemosyneStore.write (atomic md+chroma+neo4j)
 *   - RelatePiece              ← cross-store judge step (chroma top-k → neo4j edge)
 *   - encoder.setV12Hook       ← swaps EncoderPiece's processing path
 */
async function wireV12Pipeline(opts: V12WireOpts): Promise<void> {
  const { encoder, store, chroma, neo4j, llm, logger, config, relatePieceRef } = opts;

  // Resolve filesystem paths. Defaults mirror config.default.json but allow
  // override via config + tilde-expansion. We expand ~/  only — anything more
  // exotic is the operator's problem.
  const expand = (p: string): string =>
    p.startsWith("~") ? join(homedir(), p.slice(1)) : p;

  const categoriesDir = expand(
    config?.categories_v12?.categories_dir ?? `${DATA_DIR}/categories/`
  );
  const pendingPath = expand(
    config?.categories_v12?.pending_path ?? `${DATA_DIR}/pending-categories.json`
  );
  const promptsDir = join(__dirname, "../prompts");

  // Ensure the categories dir exists before CategoryCatalog scans it —
  // CategoryCatalog.load() will fail loud if the dir is missing entirely.
  await fs.mkdir(categoriesDir, { recursive: true });

  const catalog = new CategoryCatalog(promptsDir, categoriesDir);
  await catalog.load();
  const pending = new PendingCategoriesStore(pendingPath);
  await pending.load();

  // Sink: maps EncoderV12's EncodedMemory shape onto the canonical Memory
  // shape and routes through MnemosyneStore for the atomic 3-layer write.
  // We preserve the v12-assigned id so the cross-store relate step (which
  // runs immediately after) can refer to the same memory.
  const sink = {
    async write(m: EncodedMemory): Promise<{ id: string }> {
      const memory: Memory = {
        id: m.id || uuidv4(),
        category: m.category,
        title: m.title,
        content: m.content,
        tags: m.tags ?? [],
        project: null,
        confidence: m.confidence,
        reinforcements: 0,
        visibility: "open",
        pinned: false,
        created_at: Date.parse(m.created_at) || Date.now(),
        last_accessed: Date.now(),
        source_session: m.session_id,
        promoted_at: null,
        evidence: m.evidence,
        origin_source:
          m.origin_source === "tool" || m.origin_source === "assistant"
            ? m.origin_source
            : "user",
      };
      await store.write(memory);
      return { id: memory.id };
    },
  };

  const encoderV12 = new EncoderV12({
    llm,
    catalog,
    pending,
    sink,
    promptPaths: {
      triage: join(promptsDir, "triage-v12.md"),
      classify: join(promptsDir, "classify-v12.md"),
      relate: join(promptsDir, "relate-judge-v12.md"),
    },
    classifyCfg: {
      model: config?.classify_v12?.model ?? "haiku",
      maxCandidates: config?.classify_v12?.max_candidates_per_turn ?? 5,
    },
    gateCfg: {
      minConfidence: config?.categories_v12?.new_category_min_confidence ?? 0.7,
      windowDays: config?.categories_v12?.new_category_recurrence_window_days ?? 7,
      minOccurrences:
        config?.categories_v12?.new_category_recurrence_min_occurrences ?? 2,
    },
    intraTurnCfg: {
      maxPairs: config?.relate_v12?.intra_turn_max_pairs ?? 3,
    },
    model: config?.triage_v12?.model ?? "haiku",
    logger,
  });

  // RelatePiece — optional. Only wired when relate_v12.enabled !== false to
  // give operators an escape hatch (e.g. disable cross-store edges while
  // tuning the judge prompt).
  let relatePiece: RelatePiece | undefined;
  if (config?.relate_v12?.enabled !== false) {
    const judge = new RelateJudge(
      llm,
      join(promptsDir, "relate-judge-v12.md"),
      config?.relate_v12?.model ?? "haiku"
    );

    relatePiece = new RelatePiece({
      judge,
      // Chroma adapter exposes per-layer query; v12 cares about the "short"
      // layer (newly-written memories live there until consolidation
      // promotes them). We map QueryHit → RelatePayload+id.
      chromaQuery: async (m, topK, _threshold) => {
        // Query both layers — memories may live in "short" (new) or "long"
        // (promoted). Dedup by id, keeping the first occurrence.
        const [shortHits, longHits] = await Promise.all([
          chroma.query("short", m.content, topK),
          chroma.query("long", m.content, topK),
        ]);
        const seen = new Set<string>();
        const allHits = [...shortHits, ...longHits].filter((h) => {
          if (seen.has(h.id)) return false;
          seen.add(h.id);
          return true;
        }).slice(0, topK);
        return allHits.map((h) => ({
          id: h.id,
          title: (h.metadata?.title as string) ?? "",
          content: h.content,
          evidence: (h.metadata?.evidence as string) ?? "",
          origin: (h.metadata?.origin_source as string) ?? "assistant",
          createdAt:
            typeof h.metadata?.created_at === "number"
              ? new Date(h.metadata.created_at as number).toISOString()
              : ((h.metadata?.created_at as string) ?? new Date().toISOString()),
          category: (h.metadata?.category as string) ?? "preference",
        }));
      },
      neo4jWriteEdge: async (edge) => {
        await neo4j.createRelatesToEdge(
          edge.from,
          edge.to,
          edge.relation,
          edge.confidence
        );
      },
      cfg: {
        topK: config?.relate_v12?.top_k ?? 20,
        similarityThreshold: config?.relate_v12?.similarity_threshold ?? 0.55,
        judgeCap: config?.relate_v12?.judge_cap_per_memory ?? 20,
      },
    });
  }

  encoder.setV12Hook({ encoder: encoderV12, relatePiece });
  if (relatePieceRef && relatePiece) {
    relatePieceRef.current = relatePiece;
  }
}
