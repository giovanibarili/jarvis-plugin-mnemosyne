import type { PluginContext, Piece } from "@jarvis/core";
import { EventBus } from "@jarvis/core";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";

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
import { ReplayEngine } from "../lib/replay-engine.js";
import { ObserverPiece } from "./observer.js";
import { EncoderPiece } from "./encoder.js";
import { RetrieverPiece } from "./retriever.js";
import { ConsolidatorPiece } from "./consolidator.js";
import { PanelPiece } from "./panel.js";
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
    const SESSION_FILTER = /^actor-mnemo/;
    ctx.registerContextInjector((sessionId: string): string[] => {
      if (!SESSION_FILTER.test(sessionId)) return []; // only inject into actor-mnemo* sessions
      const ready = retrieverHandle.real;
      if (!ready) return []; // bootstrap not done yet — opt out

      // Synchronous cache lookup — never await on the hot path.
      // The retriever maintains per-session caches (cache, lastUserMsg)
      // that we read directly. Type assertion bridges the private fields.
      type Cache = Map<string, { lastUserMsg: string; block: string }>;
      type LastMsg = Map<string, string>;
      const cache = (ready as unknown as { cache: Cache }).cache;
      const lastMsgMap = (ready as unknown as { lastUserMsg: LastMsg }).lastUserMsg;
      const cached = cache.get(sessionId);
      const lastMsg = lastMsgMap.get(sessionId);

      // No user message observed yet on this session — nothing to retrieve.
      if (!lastMsg) return [];

      // Cache miss (first or stale): fire-and-forget refresh.
      // We return the CURRENT cached block this turn; next turn picks up fresh.
      if (cached?.lastUserMsg !== lastMsg) {
        ready.systemContext(sessionId).catch(() => { /* logged inside */ });
      }

      const block = cached?.block ?? "";
      if (!block) return [];

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
  const extractor = new Extractor(
    llm,
    join(__dirname, "../prompts"),
    config.encoder.min_confidence
  );
  const conflictDetector = new ConflictDetector(llm, chroma, neo4j, {
    similarityThreshold: config.consolidator.conflict_similarity_threshold,
    promptsDir: join(__dirname, "../prompts"),
  });
  const reranker = new Reranker(config.retriever.rerank_weights);
  // ReplayEngine constructed for Task 13 tools to consume; not run in Task 12
  const replayEngine = new ReplayEngine({ logger });

  // 7. Construct pieces
  const encoder = new EncoderPiece(extractor, store, logger);
  const observer = new ObserverPiece((turn) => encoder.enqueue(turn));
  const retriever = new RetrieverPiece(store, reranker, {
    topK: config.retriever.top_k_vector,
    graphHops: config.retriever.graph_hops,
    workflowLookupEnabled: config.retriever.workflow_lookup_enabled,
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

  // 8. Cron registration (D12: 3am daily consolidation)
  registerCron(ctx, config.consolidator.cron);

  // 9. Tool registration (Task 13)
  registerTools(ctx, store, neo4j, consolidator, replayEngine, config.retriever.rerank_weights);

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
              break;
            }
          }
        } finally {
          clearTimeout(timeoutId);
        }

        if (errored) throw new Error(errored);
        return text;
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
  rerankWeights: RerankWeights
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
  reg.register(buildMemoryPromoteTool(store));

  // Workflows
  reg.register(buildWorkflowListTool(neo4j));
  reg.register(buildWorkflowGetTool(neo4j));
  reg.register(buildWorkflowReplayTool(neo4j, replay));

  // Admin
  reg.register(buildMnemosyneConsolidateTool(consolidator));
  reg.register(buildMnemosyneStatsTool(store));
}
