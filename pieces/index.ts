import type { PluginContext, Piece } from "@jarvis/core";
import { EventBus } from "@jarvis/core";
import { log, setPluginLogger } from "../lib/log.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { promises as fs, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

import { preflight, MnemosyneBootError } from "../lib/preflight.js";
import { ChromaServer } from "../lib/chroma-server.js";
import { ChromaAdapter } from "../lib/chroma-adapter.js";
import { Neo4jServer } from "../lib/neo4j-server.js";
import { Neo4jAdapter } from "../lib/neo4j-adapter.js";
import { detectNeo4jStatus, type Neo4jStatus } from "../lib/neo4j-status.js";
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
import { BackgroundReviewPiece } from "./background-review.js";
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
  buildMemoryReinforce,
  buildMemoryAddEvidence,
  buildMemoryDownvote,
} from "../lib/tools/memory-feedback.js";
import {
  buildWorkflowListTool,
  buildWorkflowGetTool,
  buildWorkflowReplayTool,
} from "../lib/tools/workflow-tools.js";
import {
  buildMnemosyneConsolidateTool,
  buildMnemosyneStatsTool,
} from "../lib/tools/admin-tools.js";
import { buildMnemosyneStatusTool } from "../lib/tools/status-tool.js";
import { buildMemoryFetchTool } from "../lib/tools/memory-fetch.js";
import { buildMemoryRelateTool } from "../lib/tools/memory-relate-tool.js";
import { buildSessionAttentionTool } from "../lib/tools/session-attention-tool.js";
import { DomainCatalog, EntityCatalog } from "../lib/catalogs.js";
import {
  buildNewDomainTool,
  buildNewEntityTool,
  buildNewMemoryTool,
  makeWriterStats,
  type WriterStats,
} from "../lib/tools/memory-primitives.js";
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
  // Wire the core logger into the Mnemosyne singleton FIRST — before any
  // module uses `log`. ctx.log is a child of the core pino logger with
  // { plugin: "jarvis-plugin-mnemosyne" } bound, so entries land in jarvis.log.
  if (ctx.log) setPluginLogger(ctx.log);

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
    // Build SESSION_EXCLUDE from config.session_blacklist.patterns.
    // Defaults: ["mnemosyne-skip", "^slack-connector-"] — always included.
    // Operators can extend via config without touching code.
    const blacklistPatterns: string[] = [
      "mnemosyne-skip",           // ephemeral workers (always excluded)
      ...(((ctx.config as any)?.session_blacklist?.patterns as string[]) ?? [
        "^slack-connector-",       // high-volume, low-signal slack sessions
      ]),
    ];
    const SESSION_EXCLUDE = new RegExp(blacklistPatterns.join("|"));
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
      log.debug({ sessionId, ready: !!ready }, "mnemosyne: injector called");
      if (!ready) {
        log.warn({ sessionId }, "mnemosyne: injector — bootstrap not ready");
        return [];
      }

      // The ai.request subscriber (lastUserMsg.set) and this injector both run
      // from the same bus.publish("ai.request") call. Subscribers execute in
      // registration order — if JarvisCore registered before Mnemosyne, our
      // subscriber runs AFTER handlePrompt→sendAndStream→contextInjector.
      // A single setImmediate yields to the next I/O tick, giving the subscriber
      // time to fire and set lastUserMsg before we query it.
      await new Promise<void>((r) => setImmediate(r));

      const block = await ready.systemContext(sessionId);
      ready.recordInjection(!!block);
      log.info({ sessionId, blockLen: block?.length ?? 0 }, "mnemosyne: injector — systemContext done");
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
          payload: { count, query: undefined, sourceCounts, memories },
        });
      }

      // Wrap in <system-reminder> so the model treats this as background
      // context rather than user-authored content. Anthropic recognizes
      // this tag natively and adjusts tone accordingly — no risk of the
      // model citing memories verbatim or treating them as instructions.
      // The system prompt (via gatedRetrieverPiece.systemContext) already contains
      // the full Mnemosyne legend, format guide, and usage rules — permanently cached.
      // The ephemeral block here carries ONLY the per-turn retrieved memories.
      const wrapped = `<system-reminder>
The following memories were retrieved by Mnemosyne for this turn. Apply them as background context.

${block}
</system-reminder>`;

      return [wrapped];
    });
  }

  // Compile session blacklist once — shared by injector AND BackgroundReviewPiece.
  // This ensures both exclusion points are always in sync.
  const blacklistPatterns: string[] = [
    "mnemosyne-skip",
    ...(((ctx.config as any)?.session_blacklist?.patterns as string[]) ?? [
      "^slack-connector-",
    ]),
  ];
  const sessionBlacklist = new RegExp(blacklistPatterns.join("|"));

  // Each piece is wrapped in a gate that awaits bootstrap before delegating
  // to the real piece's start(). The wrapped piece exposes the same id/name
  // so the HUD and capability registry behave identically.
  // T-08: BackgroundReviewPiece — periodic cognitive curation via copy-on-write fork.
  // Reads enabled/cadence from plugin config (ctx.config.background_review).
  // Gated on bootstrap so it only starts after the store is ready.
  const brConfig = (ctx.config as any)?.background_review ?? {};
  const bgReviewRef: { current?: BackgroundReviewPiece } = {};
  const backgroundReview = gatedPiece(
    "mnemosyne-background-review",
    "Mnemosyne Background Review",
    bootstrap,
    (b) => {
      const br = new BackgroundReviewPiece(
        b.store,
        { bus: ctx.bus, sessionManager: ctx.sessionManager },
        {
          enabled: brConfig.enabled ?? false,
          reviewEveryNTurns: brConfig.reviewEveryNTurns ?? 5,
          idleTriggerMinutes: brConfig.idleTriggerMinutes ?? 5,
          timeoutSeconds: brConfig.timeoutSeconds ?? 60,
          sessionBlacklist,
        }
      );
      bgReviewRef.current = br;
      // Wire to panel for stats after bootstrap
      bootstrap.then((b) => {
        b.panel.setStatsSources(b.encoder, b.retriever, b.consolidator, br);
        b.panel.setSetupWarnings(b.setupWarnings);
      }).catch(() => {});
      return br;
    }
  );

  return [
    gatedPiece("mnemosyne-observer", "Mnemosyne Observer", bootstrap, (b) => b.observer),
    gatedPiece("mnemosyne-encoder", "Mnemosyne Encoder", bootstrap, (b) => b.encoder),
    gatedRetrieverPiece(bootstrap, retrieverHandle),
    gatedPiece("mnemosyne-consolidator", "Mnemosyne Consolidator", bootstrap, (b) => b.consolidator),
    gatedPiece("mnemosyne-panel", "Mnemosyne Panel", bootstrap, (b) => b.panel),
    backgroundReview,
  ];
}

/* ---- helpers needed by bootstrapAsync (must be defined before the call) ---- */

/**
 * Notify the main JARVIS session that the Neo4j/graph layer is degraded.
 */
function notifyDegraded(ctx: PluginContext, status: { code: string; userMessage?: string; remediation?: string; detail?: string }): void {
  const lines = [
    `[SYSTEM] **Mnemosyne — graph layer degraded** (${status.code})`,
    status.userMessage ?? "Neo4j não está disponível.",
    status.remediation ? `\n💡 ${status.remediation}` : "",
    status.detail ? `\nDetalhe: ${status.detail}` : "",
    "\nO plugin continua funcional com Chroma + Markdown (sem grafo).",
  ].filter(Boolean).join("\n");
  ctx.bus.publish({ channel: "ai.request", source: "mnemosyne", target: "main", text: lines } as any);
}

/** Module-level Neo4j status cache — read by mnemosyne_status tool. */
const _neo4jState = { lastNeo4jStatus: null as import("../lib/neo4j-status.js").Neo4jStatus | null, graphDegraded: false };

function setLastNeo4jStatus(status: import("../lib/neo4j-status.js").Neo4jStatus, graphDegraded: boolean): void {
  _neo4jState.lastNeo4jStatus = status;
  _neo4jState.graphDegraded = graphDegraded;
}

/* --------------------------------------------------------------------------- */

/** Bootstrap result: every long-lived component built during async init. */
interface Bootstrap {
  observer: ObserverPiece;
  encoder: EncoderPiece;
  retriever: RetrieverPiece;
  consolidator: ConsolidatorPiece;
  panel: PanelPiece;
  /** Cached most recent block per session for sync systemContext() */
  retrieverCache: Map<string, string>;
  /** MnemosyneStore — exposed so BackgroundReviewPiece can read AttentionState (T-08). */
  store: MnemosyneStore;
  /** Non-blocking setup warnings detected at boot — passed to panel for HUD display. */
  setupWarnings: SetupWarning[];
}

interface SetupWarning {
  code: string;
  message: string;
  action: string;
}

/**
 * Non-blocking config checks run after bootstrap. Returns warnings that are:
 *   1. Shown as banners in the HUD panel (yellow, dismissible)
 *   2. Published as a prompt to the `main` session so JARVIS surfaces them
 *      interactively and asks the user to configure the missing settings.
 *
 * These NEVER block boot — they surface missing config that would leave the
 * plugin silently inert (e.g. background_review.enabled: false by default).
 */
function checkSetupWarnings(config: Record<string, unknown>): SetupWarning[] {
  const warnings: SetupWarning[] = [];

  const br = config.background_review as Record<string, unknown> | undefined;

  if (!br) {
    warnings.push({
      code: "background_review_missing",
      message: "background_review not configured — Mnemosyne will NEVER extract memories from conversations.",
      action: "Add background_review to ~/.jarvis/mnemosyne/config.json with enabled:true and reviewEveryNTurns.",
    });
  } else if (br.enabled !== true) {
    warnings.push({
      code: "background_review_disabled",
      message: "background_review.enabled is false — Mnemosyne is running but NOT extracting memories.",
      action: "Set background_review.enabled = true and configure reviewEveryNTurns / idleTriggerMinutes.",
    });
  } else if (!br.reviewEveryNTurns && !br.idleTriggerMinutes) {
    warnings.push({
      code: "background_review_no_trigger",
      message: "background_review is enabled but no trigger is configured (reviewEveryNTurns and idleTriggerMinutes are both missing).",
      action: "Set reviewEveryNTurns (e.g. 5) or idleTriggerMinutes (e.g. 10) in background_review config.",
    });
  }

  return warnings;
}

/**
 * Write setup warnings to ~/.jarvis/startup-prompt.txt so JarvisCore injects
 * them into the main session on the NEXT user turn — after the session is fully
 * ready to receive messages. This avoids the race condition where bus.publish
 * fires before main is listening (bootstrap runs before the first user turn).
 *
 * The file is consumed+deleted by consumeStartupPrompt() in conversation-store.ts.
 * Writing here is safe: if a prompt already exists (e.g. from jarvis_reset) we
 * APPEND so neither message is lost.
 */
function notifySetupWarnings(_ctx: PluginContext, warnings: SetupWarning[]): void {
  if (warnings.length === 0) return;

  const lines = [
    "[MNEMOSYNE SETUP] The following configuration issues were detected at boot:",
    "",
    ...warnings.map((w, i) => [
      `${i + 1}. **${w.code}**`,
      `   ${w.message}`,
      `   → ${w.action}`,
    ].join("\n")),
    "",
    "Please configure Mnemosyne now so memory extraction works correctly.",
    "Ask me to enable `background_review` and I will write the config for you.",
  ];

  const promptPath = join(process.env.HOME ?? "~", ".jarvis", "startup-prompt.txt");
  try {
    const text = lines.join("\n") + "\n";
    // Append if file already exists (e.g. jarvis_reset wrote something first)
    const existing = (() => { try { return readFileSync(promptPath, "utf-8"); } catch { return ""; } })();
    writeFileSync(promptPath, existing ? existing + "\n---\n" + text : text, "utf-8");
  } catch (e) {
    console.error("[mnemosyne] notifySetupWarnings: failed to write startup-prompt.txt:", e);
  }
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

  // 2b. Non-blocking setup warnings — detect silently-inert config.
  // Runs immediately after config load so warnings are ready before the
  // panel first renders. Also notifies the main session interactively.
  const setupWarnings = checkSetupWarnings(config as Record<string, unknown>);
  notifySetupWarnings(ctx, setupWarnings);

  // 3. Start Chroma server
  const chromaServer = new ChromaServer({
    dataDir: join(DATA_DIR, "chroma-data"),
    port: config.chroma.port,
  });
  await chromaServer.start();

  // 4. Neo4j — OPTIONAL fail-soft path.
  //
  // The plugin must never block JARVIS boot on the graph layer being
  // available. Three things can go wrong before we even attempt to
  // connect: (a) Docker daemon is down, (b) the mnemosyne-neo4j container
  // doesn't exist yet, (c) the container exists but isn't running.
  //
  // detectNeo4jStatus() probes all three states and, when the container is
  // merely stopped, tries `docker start mnemosyne-neo4j` once. Anything
  // else degrades the plugin: Chroma+Markdown stay functional, workflow
  // tools disable, retriever falls back to vector-only.
  const status = await detectNeo4jStatus({ autoStartStopped: true });
  if (status.code !== "ok") {
    notifyDegraded(ctx, status);
  }

  // 5. Connect adapters. Chroma is mandatory — we need a vector store for
  // any useful retrieval. Neo4j is best-effort: if the probe was ok, try
  // to connect with a tight timeout; if it fails (or the probe already
  // said degraded), keep going with `graphDegraded = true`.
  const chroma = new ChromaAdapter({
    host: config.chroma.host,
    port: config.chroma.port,
    embeddingModel: config.chroma.embedding_model,
  });
  await chroma.init();

  const neo4j = new Neo4jAdapter({ uri: config.neo4j.bolt_uri });
  let graphDegraded = status.code !== "ok";
  if (!graphDegraded) {
    try {
      await neo4j.connect(2000);
      await neo4j.applySchema(join(__dirname, "../cypher/schema.cypher"));
    } catch (e) {
      console.error("[mnemosyne] Neo4j connect failed after ok probe — degrading:", e);
      graphDegraded = true;
      // Synthesize a status so the user still gets a notification when the
      // probe passed but Bolt itself is unhappy (e.g. mid-startup, auth changed).
      notifyDegraded(ctx, {
        code: "unknown-error",
        userMessage:
          "Mnemosyne: Neo4j respondeu ao Docker mas a conexão Bolt falhou — grafo desativado.",
        remediation:
          "Verifique `docker logs mnemosyne-neo4j` e rode `jarvis_reset` quando o Neo4j estiver pronto.",
        detail: String((e as Error)?.message ?? e),
      });
    }
  }

  const markdownStore = new MarkdownStore(DATA_DIR);
  const logger = new Logger(DATA_DIR);
  const store = new MnemosyneStore(markdownStore, chroma, neo4j, logger);
  store.setGraphDegraded(graphDegraded);
  setLastNeo4jStatus(status, graphDegraded);

  // 6. Build pipelines
  const llm = makeLLMClient(ctx);
  const conflictDetector = new ConflictDetector(llm, chroma, neo4j, {
    similarityThreshold: config.consolidator.conflict_similarity_threshold,
    promptsDir: join(__dirname, "../prompts"),
  });
  const reranker = new Reranker(config.retriever.rerank_weights);
  // ReplayEngine constructed for Task 13 tools to consume
  const replayEngine = new ReplayEngine({ logger });

  // 7. Construct pieces — Hermes-first model.
  //
  // The EncoderPiece is kept ALIVE only as a structural placeholder (so the
  // Bootstrap interface and HUD stats don't break), but eager extraction is
  // DISABLED: the observer's turn callback is a no-op. All memory writes now
  // flow through the new_memory tool (hermes-reviewer → new_memory → store.write).
  // The TRIPLET (EncoderV12/triage/classify/enrich) is no longer wired.
  const encoder = new EncoderPiece(store, logger, { encoder: null as any });
  const observer = new ObserverPiece(
    // Hermes-first: eager auto-enqueue removed. Observer still maintains the
    // prior-turns ring buffer (used by BackgroundReview context), but never
    // feeds the encoder.
    (_turn) => {},
    config.encoder.context_window_size ?? 10
  );
  const retriever = new RetrieverPiece(store, reranker, {
    topK: config.retriever.top_k_vector,
    graphHops: config.retriever.graph_hops,
    workflowLookupEnabled: config.retriever.workflow_lookup_enabled,
    // New since 0.5.x — drops "more-orthogonal-than-aligned" hits before
    // they pollute context. Default 0.0; tune via config to be stricter.
    // Default -1.0 (floor of cosine space) — chromadb with MiniLM can return
    // distance > 1.0 for very short queries (2-3 words), producing vectorSim < 0.
    // Setting 0.0 would silently drop all hits for short queries. The reranker
    // handles quality filtering; we keep sim threshold as a last-resort noise gate.
    minVectorSim: config.retriever.min_vector_sim ?? -1.0,
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
  panel.setStatsSources(encoder, retriever, consolidator);

  // 7b. Hermes-first taxonomy catalogs.
  //
  // The TRIPLET pipeline (wireV12Pipeline) is RETIRED. Memory extraction is now
  // fully LLM-orchestrated via the new_domain/new_entity/new_memory primitives.
  // relatePieceRef stays defined (memory_promote still wants it) but is left
  // empty — promotion-time relate is no longer auto-fired.
  const relatePieceRef: { current?: RelatePiece } = {};

  const domainsDir = `${DATA_DIR}/domains`;
  const entitiesDir = `${DATA_DIR}/entities`;
  const domainCatalog = new DomainCatalog(domainsDir);
  const entityCatalog = new EntityCatalog(entitiesDir);
  await domainCatalog.load();
  await entityCatalog.load();

  // Hermes-first WRITER stats — shared in-memory counters for the HUD.
  const writerStats = makeWriterStats();
  // Wire to panel so the Runtime Stats WRITER section reads live counters +
  // disk-derived historical totals (domains/entities dirs, new_memory files).
  panel.setWriterSources(writerStats, domainCatalog, entityCatalog);

  // 8. Cron registration (D12: 3am daily consolidation)
  registerCron(ctx, config.consolidator.cron);

  // 9. Tool registration (Task 13). When the graph is degraded, workflow_*
  // tools are skipped (they're pure Neo4j) and mnemosyne_status always
  // reflects the live state.
  registerTools(
    ctx,
    store,
    neo4j,
    consolidator,
    replayEngine,
    encoder,
    reranker,
    config.retriever.rerank_weights,
    config,
    relatePieceRef,
    { graphDegraded },
    retriever,  // T-11: passed so memory_reinforce can reset amnesia counter
    domainCatalog,
    entityCatalog,
    writerStats,
  );

  // 10. HTTP routes used by the HUD renderer (MemoryCard / MnemosynePanel).
  // The renderer fetches POST /plugins/jarvis-plugin-mnemosyne/{forget,pin,consolidate}.
  // Without these the trash / pin buttons silently 404. We register thin
  // wrappers that share the same handlers as the assistant-facing tools.
  registerHttpRoutes(ctx, store, consolidator, panel, config);

  return {
    observer,
    encoder,
    retriever,
    consolidator,
    panel,
    retrieverCache: new Map(),
    store,
    setupWarnings,
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
  panel: PanelPiece,
  config: any,
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

  /**
   * GET /memory/:id
   *
   * Fetch a single memory by ID. Used by the Graph tab when clicking a node
   * that is a graph neighbor (not present in the panel's preloaded list).
   */
  ctx.registerRoute("GET", `${base}/memory`, async (req: any, res: any) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const id = url.searchParams.get("id") ?? "";
      if (!id) return jsonResponse(res, 400, { ok: false, error: "missing 'id'" });
      const mem = await store.markdownStore.read(id).catch(() => null);
      if (!mem) return jsonResponse(res, 404, { ok: false, error: "not found" });
      jsonResponse(res, 200, { memory: mem });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: String(e) });
    }
  });

  /**
   * GET /node-by-neo4j-id?neo4jId=<integer>
   *
   * Resolve a Neo4j internal integer ID to the memory UUID (n.id).
   * Used by the Graph tab when vis.js click only provides the internal node ID.
   */
  ctx.registerRoute("GET", `${base}/node-by-neo4j-id`, async (req: any, res: any) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const neo4jIdStr = url.searchParams.get("neo4jId") ?? "";
      const neo4jId = parseInt(neo4jIdStr, 10);
      if (isNaN(neo4jId)) return jsonResponse(res, 400, { ok: false, error: "missing or invalid neo4jId" });
      // Use HTTP API directly (no driver dependency on integer IDs)
      const httpResp = await fetch("http://127.0.0.1:7474/db/neo4j/tx/commit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic " + Buffer.from("neo4j:neo4j").toString("base64"),
        },
        body: JSON.stringify({ statements: [{ statement: `MATCH (n) WHERE id(n)=${neo4jId} RETURN n.id AS memoryId LIMIT 1` }] }),
      });
      const data = await httpResp.json() as any;
      const memoryId = data?.results?.[0]?.data?.[0]?.row?.[0] ?? null;
      if (!memoryId) return jsonResponse(res, 404, { ok: false, error: "not found" });
      jsonResponse(res, 200, { memoryId: String(memoryId) });
    } catch (e) {
      jsonResponse(res, 500, { ok: false, error: String(e) });
    }
  });

    /**
   * GET /search?q=<query>[&k=<topK>]
   *
   * Unified semantic search endpoint used by both List and Graph tabs.
   * Pipeline mirrors the retriever: vector top-K seeds → 1-hop graph
   * expansion → returns all matching memory IDs + neighbor IDs.
   *
   * Response: { memories: Memory[], neighborIds: string[] }
   *   - memories: reranked vector hits (seed nodes)
   *   - neighborIds: 1-hop graph neighbors not in seeds
   *
   * Both tabs show seeds + neighbors, identical to what gets injected
   * into the system prompt.
   */
  // Capture weights at registration time — avoids closure dependency on `config`
  // which may not survive module cache invalidation on hot-reload.
  const _searchRerankWeights = { ...config.retriever.rerank_weights };
  ctx.registerRoute("GET", `${base}/search`, async (req: any, res: any) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const q = url.searchParams.get("q") ?? "";
      const k = Math.min(parseInt(url.searchParams.get("k") ?? "20", 10), 50);
      if (!q.trim()) return jsonResponse(res, 200, { memories: [], neighborIds: [] });

      // 1. Vector search — short + long layers
      const [shortHits, longHits] = await Promise.all([
        store.chroma.query("short", q, k),
        store.chroma.query("long", q, k),
      ]);
      const allHits = [...shortHits, ...longHits];

      // 2. Hydrate + dedup
      const seen = new Set<string>();
      const hydrated: Array<{ mem: any; vectorSim: number }> = [];
      for (const hit of allHits) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        const mem = await store.markdownStore.read(hit.id).catch(() => null);
        if (!mem) continue;
        hydrated.push({ mem, vectorSim: 1 - hit.distance });
      }

      // 3. Rerank — same weights captured at route registration time.
      const _reranker = new Reranker(_searchRerankWeights);
      let memories: any[];
      if (hydrated.length > 0) {
        const rerankHits = hydrated.map(({ mem, vectorSim }) => ({
          memory: mem,
          score: vectorSim,
          source: "vector" as const,
          vectorSim,
        }));
        const sorted = _reranker.rerank(rerankHits);
        memories = sorted.map((h) => {
          const bd = h.scoreBreakdown;
          return {
            ...h.memory,
            _vectorSim: parseFloat((h.vectorSim ?? 0).toFixed(3)),
            _score: parseFloat(h.score.toFixed(3)),
            _scoreBreakdown: bd ? {
              recency: parseFloat(bd.recency.toFixed(3)),
              confidence: parseFloat(bd.confidence.toFixed(3)),
              reinforcements: parseFloat(bd.reinforcements.toFixed(3)),
              graph_distance: parseFloat(bd.graphDistance.toFixed(3)),
            } : undefined,
          };
        });
      } else {
        memories = [];
      }

      // 4. 1-hop graph expansion
      const seedIds = memories.map((m) => m.id);
      let neighborIds: string[] = [];
      if (seedIds.length > 0) {
        const neighbors = await store.neo4j.oneHopNeighbors(seedIds).catch(() => []);
        neighborIds = neighbors
          .filter((n: any) => !seen.has(n.id))
          .map((n: any) => n.id);
        neighborIds.forEach((id: string) => seen.add(id));
      }

      jsonResponse(res, 200, { memories, neighborIds });
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
      let b: Bootstrap;
      try {
        b = await bootstrap;
      } catch (err) {
        // Bootstrap failed (e.g. Docker not running). Degrade silently —
        // PieceManager will catch this and notify the user via ai.request.
        throw err;
      }
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
      let b: Bootstrap;
      try {
        b = await bootstrap;
      } catch (err) {
        throw err; // propagate — PieceManager isolates and notifies
      }
      handle.real = b.retriever;
      await b.retriever.start(bus);
    },
    async stop() {
      if (handle.real) await handle.real.stop();
    },
    // Static system prompt contribution — permanent, cached, never changes per turn.
    // The per-turn memory block is injected separately via registerContextInjector
    // (cache_control: ephemeral in the user message). This static block teaches the
    // LLM how the Mnemosyne system works so it can use it correctly without relying
    // on the per-turn legend (which adds tokens every turn).
    systemContext: () => `## Mnemosyne — Long-term memory system

You have access to a long-term memory system (Mnemosyne) that stores past decisions,
preferences, patterns, and domain knowledge extracted from previous conversations.

### How memory retrieval works

On every turn, relevant memories are automatically retrieved and injected into your context
as a \`<system-reminder>\` block prepended to the user message. You do NOT need to search
for them — they arrive automatically. However, you can always call \`memory_search\` to
find additional memories not surfaced automatically.

### Memory block format

Each injected memory entry is a **knowledge node** you can navigate with tools:

\`\`\`
[●|◦] [vector|graph]  [HIGH|MEDIUM|WEAK]  [category]  <title>
  sim <cosine>  rerank <score>  ·  conf <confidence>  ·  reinf <reinforcements>
> <full memory content>
  ↑ <parent title> — <relation>  (id:...)   ← broader knowledge — fetch to explore
  ↓ <child title>  — <relation>  (id:...)   ← specific detail — fetch to explore
  id:<full-memory-id>            ← memory_fetch / memory_reinforce / memory_add_evidence
\`\`\`

Navigation guide:
- **● vector** — directly matched by your query. The ↑/↓ relations are **linked knowledge nodes you have not seen** — call \`memory_fetch(id)\` to load them.
- **◦ graph** — pulled by graph relation from a matched node. Weaker direct match but topically connected — follow ↑ parents for context, ↓ children for detail.
- **sim** = cosine similarity · **rerank** = final score · **conf** = extractor confidence (0–1)
- **reinf** = past reinforcements — higher means the system has trusted this memory more over time
- **↑ parent** = broader/more general node — fetch when you need the wider picture
- **↓ child** = more specific sub-fact — fetch when you need implementation detail or evidence
- **id:...** = full memory ID — required for \`memory_fetch(id)\`, \`memory_reinforce(id)\`, \`memory_add_evidence(id, ...)\`

### Rules for using memory

1. **Apply automatically** — when injected memories are relevant, use them without being asked.
2. **Follow leads** — call \`memory_fetch(id)\` on any ↑/↓ relation that seems relevant. The ID is the \`id:\` at the bottom of each entry.
3. **Search when uncertain** — call \`memory_search\` before assuming anything about the user's preferences, stack, or past decisions.
4. **[MUST] Give feedback via tools after responding** — MANDATORY, call for every useful memory:\n   - \`memory_reinforce(id)\` — MUST call for every memory that was directly useful\n   - \`memory_add_evidence(id, evidence)\` — if you discovered new evidence worth adding to a memory\n   - Pass the **full id** shown as \`id:\` at the bottom of each memory entry.
`,
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
  // Background extraction/triage/conflict work is mechanical — pin the cheap
  // utility model. WITHOUT this pin, sessions inherit config.model (the user's
  // chat model). Audited 2026-06-10: 71k requests over 28 days inherited
  // Opus/Sonnet/Fable — ~$7,282 real cost vs ~$718 if Haiku (~$6.5k waste).
  const utilityModel =
    (ctx.config as any)?.llm_bridge?.model ?? "claude-haiku-4-5";
  return {
    async call({ system, user }) {
      const factory = ctx.sessionFactory;
      const label = `mnemosyne-llm-${crypto.randomUUID().slice(0, 8)}`;
      const session = factory.createWithPrompt({
        label,
        basePromptOverride: system,
      });
      // Pin BEFORE the first request — sticky survives the whole session life.
      (session as any).setStickyModelOverride?.(utilityModel);

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

        // claude-haiku-4-5: $1.00/MTok input, $5.00/MTok output.
        // NOTE: approximation — assumes the pinned utility model. Before the
        // 2026-06-10 fix this calc assumed Haiku while sessions actually ran
        // on Opus/Fable, under-reporting cost ~15-19x and masking the leak.
        const costUsd = (inputTokens / 1_000_000) * 1.00 + (outputTokens / 1_000_000) * 5.00;
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
  reranker: Reranker,
  rerankWeights: RerankWeights,
  config: any,
  relatePieceRef?: { current?: import("./relate.js").RelatePiece },
  state: { graphDegraded: boolean } = { graphDegraded: false },
  retriever?: RetrieverPiece,
  domainCatalog?: DomainCatalog,
  entityCatalog?: EntityCatalog,
  writerStats?: WriterStats,
): void {
  const reg = ctx.capabilityRegistry;

  // Memory — search & inspection (vector-backed, work without graph)
  reg.register(buildMemorySearchTool(store, reranker));
  reg.register(buildMemoryGetTool(store));
  reg.register(buildMemoryListTool(store));
  reg.register(buildMemoryExplainTool(store, rerankWeights));

  // Memory — management (markdown + chroma; graph writes inside store are
  // already guarded by store.graphDegraded)
  reg.register(buildMemoryUpdateTool(store));
  reg.register(buildMemoryPinTool(store));
  reg.register(buildMemoryUnpinTool(store));
  reg.register(buildMemoryDeleteTool(store));
  reg.register(buildMemoryPromoteTool(store, relatePieceRef?.current));

  // Workflows — pure Neo4j. Skip entirely when graph is degraded; the
  // tools would just throw Neo4jNotReadyError on every call otherwise.
  if (!state.graphDegraded) {
    reg.register(buildWorkflowListTool(neo4j));
    reg.register(buildWorkflowGetTool(neo4j));
    reg.register(buildWorkflowReplayTool(neo4j, replay));
    // Explicit edge creation — lets the reviewer wire semantic connections
    // intentionally (source='explicit') rather than relying on the opaque
    // relate-judge (source='semantic'). Gated here so it's unavailable when
    // graph is down and would just throw on every call.
    reg.register(buildMemoryRelateTool(neo4j));
  } else {
    console.warn("[mnemosyne] graph degraded — skipping workflow_* and memory_relate tools");
  }

  // Admin — status tool always registered so the user can introspect.
  reg.register(buildMnemosyneStatusTool(store, _neo4jState));
  reg.register(buildMnemosyneConsolidateTool(consolidator));
  reg.register(buildMnemosyneStatsTool(store));

  // Hermes-first atomic primitives — replace mnemosyne_triage.
  // new_domain / new_entity register taxonomy; new_memory writes directly to
  // the store with STRICT domain/entity validation. The graph surface is only
  // passed when the graph is healthy (inline relations need Neo4j).
  if (domainCatalog && entityCatalog) {
    // Pass neo4j as PrimitiveGraph so new_domain/new_entity/new_memory mirror
    // taxonomy into the graph (Domain/Entity nodes + BELONGS_TO/ABOUT edges).
    const graph = state.graphDegraded ? undefined : neo4j;
    reg.register(buildNewDomainTool(domainCatalog, writerStats, graph));
    reg.register(buildNewEntityTool(domainCatalog, entityCatalog, writerStats, graph));
    reg.register(buildNewMemoryTool(store, domainCatalog, entityCatalog, graph, writerStats));
  }

  // Feedback tools — explicit tool-based replacement for fragile text signals.
  // These replace [mnemo:used:ID] and [mnemo:update:ID:...] inline text signals.
  //
  // T-11: memory_reinforce also resets the amnesia counter in the retriever's
  // working memory. We wrap the base capability so the retriever learns about
  // the reinforcement without the tool needing a direct RetrieverPiece dep.
  {
    const baseDef = buildMemoryReinforce(store);
    const baseHandler = baseDef.handler!;
    reg.register({
      ...baseDef,
      handler: async (args: Record<string, unknown>, meta?: { sessionId?: string }) => {
        const result = await (baseHandler as (a: Record<string, unknown>, m?: { sessionId?: string }) => Promise<unknown>)(args, meta);
        // Reset amnesia for this memory in the active session so the retriever
        // keeps injecting it while the user is actively referencing it.
        if (retriever && typeof args.id === "string") {
          const sessionId = meta?.sessionId ?? "main";
          retriever.reinforceMemory(sessionId, args.id);
        }
        return result;
      },
    });
  }
  reg.register(buildMemoryAddEvidence(store));
  reg.register(buildMemoryDownvote(store));

  // T-11: session_attention_update — lets BackgroundReviewPiece declare the
  // active cognitive context after a review pass. Retriever reads this on the
  // next turn to prioritise Tier 1 domains/categories. Store methods are bound
  // so the tool has no direct dependency on MnemosyneStore internals.
  reg.register(buildSessionAttentionTool(
    store.getAttentionState.bind(store),
    store.setAttentionState.bind(store),
  ));

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

