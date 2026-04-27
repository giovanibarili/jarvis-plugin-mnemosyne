import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MnemosyneStore } from "../../lib/store";
import { MarkdownStore } from "../../lib/markdown-store";
import { ChromaServer } from "../../lib/chroma-server";
import { ChromaAdapter } from "../../lib/chroma-adapter";
import { Neo4jServer } from "../../lib/neo4j-server";
import { Neo4jAdapter } from "../../lib/neo4j-adapter";
import { Logger } from "../../lib/logger";
import { Reranker } from "../../lib/reranker";
import { RetrieverPiece } from "../../pieces/retriever";
import type { Memory } from "../../lib/types";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { v4 as uuid } from "uuid";
import neo4j, { Driver } from "neo4j-driver";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal EventBus stub — production EventBus lives in @jarvis/core but vitest
// cannot resolve workspace path imports without a config. RetrieverPiece only
// uses bus.subscribe + (the test) bus.publish, so this stub is enough.
class TestBus {
  private subs = new Map<string, Array<(msg: any) => void>>();
  subscribe(channel: string, handler: (msg: any) => void): () => void {
    if (!this.subs.has(channel)) this.subs.set(channel, []);
    this.subs.get(channel)!.push(handler);
    return () => {
      const arr = this.subs.get(channel);
      if (!arr) return;
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }
  publish(msg: any): void {
    const arr = this.subs.get(msg.channel);
    if (!arr) return;
    for (const h of arr) {
      try { h({ ...msg, id: "test", timestamp: Date.now() }); } catch { /* ignore */ }
    }
  }
}

// File-scoped lifecycle (errata #7).
let chromaServer: ChromaServer;
let neo4jServer: Neo4jServer;
let chroma: ChromaAdapter;
let neo4jAdapter: Neo4jAdapter;
let rawDriver: Driver; // for raw cypher in CONTRADICTS test
let markdownStore: MarkdownStore;
let logger: Logger;
let store: MnemosyneStore;
let chromaDir: string;
let mdDir: string;
let logDir: string;

function mkMem(overrides: Partial<Memory>): Memory {
  return {
    id: overrides.id ?? uuid(),
    category: "preference",
    title: "untitled",
    content: "default content",
    tags: ["test"],
    project: null,
    confidence: 0.7,
    reinforcements: 0,
    visibility: "open",
    pinned: false,
    created_at: Date.now(),
    last_accessed: Date.now(),
    source_session: "main",
    promoted_at: null,
    ...overrides,
  };
}

// Tracks every memory id we write across the whole file so we can wipe
// markdown + chroma + neo4j between tests. ChromaAdapter has no
// "drop collection" API, so we delete by id.
const allWrittenIds = new Set<string>();

async function trackedWrite(memory: Memory): Promise<void> {
  await store.write(memory);
  allWrittenIds.add(memory.id);
}

async function clearAllMemories(): Promise<void> {
  // 1. Neo4j: nuke every Memory node + its edges. Retry once on the
  //    transient "Connection was closed by server" error that Neo4j 5 throws
  //    when a connection is severed mid-pool-warmup.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const s = rawDriver.session();
    try {
      await s.run("MATCH (m:Memory) DETACH DELETE m");
      lastErr = undefined;
      await s.close();
      break;
    } catch (e) {
      lastErr = e;
      await s.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (lastErr) throw lastErr;

  // 2. Chroma + markdown: delete every id we ever wrote in this file.
  for (const id of allWrittenIds) {
    try { await chroma.delete("short", id); } catch { /* ignore */ }
    try { await chroma.delete("long", id); } catch { /* ignore */ }
    try { await markdownStore.delete(id); } catch { /* ignore */ }
  }
  allWrittenIds.clear();
}

async function createContradictsEdgeRaw(aId: string, bId: string): Promise<void> {
  // Direct cypher because Neo4jAdapter.createContradictsEdge is owned by
  // Task 10 and not yet available. Mirrors the eventual implementation.
  const s = rawDriver.session();
  try {
    await s.run(
      `MATCH (a:Memory {id: $aId}), (b:Memory {id: $bId})
       MERGE (a)-[:CONTRADICTS {detected_at: $now}]->(b)
       MERGE (b)-[:CONTRADICTS {detected_at: $now}]->(a)`,
      { aId, bId, now: Date.now() }
    );
  } finally {
    await s.close();
  }
}

beforeAll(async () => {
  // Stale neo4j cleanup (errata + store.test.ts pattern).
  try {
    await exec("docker", ["rm", "-f", "mnemosyne-neo4j"]);
  } catch {
    // no stale container
  }

  chromaDir = mkdtempSync(join(tmpdir(), "retriever-chroma-"));
  mdDir = mkdtempSync(join(tmpdir(), "retriever-md-"));
  logDir = mkdtempSync(join(tmpdir(), "retriever-log-"));

  chromaServer = new ChromaServer({ dataDir: chromaDir, port: 8769 });
  await chromaServer.start();

  neo4jServer = new Neo4jServer({
    composeFile: join(__dirname, "../../docker/docker-compose.yml"),
    containerName: "mnemosyne-neo4j",
    boltUri: "bolt://127.0.0.1:7687",
  });
  await neo4jServer.start();

  chroma = new ChromaAdapter({ host: "127.0.0.1", port: 8769, embeddingModel: "minilm" });
  await chroma.init();

  // Extra wait — Neo4j 5's healthcheck reports "healthy" before the bolt
  // connection pool can reliably serve queries; without this pad the
  // adapter latches onto a socket that gets killed mid-test. We probe with
  // throwaway drivers until 3 consecutive queries succeed before opening
  // the persistent adapter / raw driver.
  for (let attempt = 0, ok = 0; attempt < 60 && ok < 3; attempt++) {
    const probe = neo4j.driver("bolt://127.0.0.1:7687");
    const s = probe.session();
    try {
      await s.run("RETURN 1");
      ok++;
    } catch {
      ok = 0;
    } finally {
      await s.close().catch(() => {});
      await probe.close().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  neo4jAdapter = new Neo4jAdapter({ uri: "bolt://127.0.0.1:7687" });
  await neo4jAdapter.connect();
  await neo4jAdapter.applySchema(join(__dirname, "../../cypher/schema.cypher"));

  // Raw driver for CONTRADICTS edge creation (Task 10 owns the adapter method).
  rawDriver = neo4j.driver("bolt://127.0.0.1:7687");
  await rawDriver.verifyConnectivity();

  markdownStore = new MarkdownStore(mdDir);
  logger = new Logger(logDir);
  store = new MnemosyneStore(markdownStore, chroma, neo4jAdapter, logger);
}, 90000);

afterAll(async () => {
  await rawDriver?.close();
  await neo4jAdapter?.close();
  await chromaServer?.stop();
  await neo4jServer?.stop();
  rmSync(chromaDir, { recursive: true, force: true });
  rmSync(mdDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
}, 60000);

function makeRetriever(opts?: { topK?: number }) {
  const reranker = new Reranker({
    recency: 0.3,
    confidence: 0.3,
    reinforcements: 0.2,
    graph_distance: 0.2,
  });
  return new RetrieverPiece(store, reranker, {
    topK: opts?.topK ?? 5,
    graphHops: 1,
    workflowLookupEnabled: false,
  });
}

async function feedLastUserMsg(ret: RetrieverPiece, sessionId: string, text: string): Promise<void> {
  const bus = new TestBus();
  await ret.start(bus as any);
  bus.publish({
    channel: "ai.request",
    source: "test",
    target: sessionId,
    text,
  });
}

// Generous per-test timeout — Neo4j 5 occasionally bounces a connection
// mid-test and the retry loop in clearAllMemories can take ~5s. Default
// vitest timeout is 5000ms which is too tight.
vi.setConfig({ testTimeout: 30000 });

// Swallow async "Connection was closed by server" errors from idle pool
// sockets — Neo4j 5 occasionally kills idle connections during late init,
// and vitest treats them as suite-level failures even though no test
// actually awaited the broken connection.
process.on("unhandledRejection", (err: unknown) => {
  const msg = String(err);
  if (msg.includes("Connection was closed by server") || msg.includes("ServiceUnavailable")) {
    // ignore — pool will reconnect on next query
    return;
  }
  // Re-throw anything else.
  throw err;
});

describe("RetrieverPiece", () => {
  it("returns empty string when no last user message observed", async () => {
    const ret = makeRetriever();
    const block = await ret.systemContext("session-empty-1");
    expect(block).toBe("");
  });

  it("returns top-K formatted memories as markdown", async () => {
    await clearAllMemories();
    const ret = makeRetriever({ topK: 3 });

    // Seed 3 memories about Effect-TS / error handling so they all match the query.
    const m1 = mkMem({
      title: "Sir prefers Effect-TS",
      content: "Sir prefers Effect-TS for error handling in TypeScript",
      confidence: 0.9,
    });
    const m2 = mkMem({
      title: "Effect-TS is functional",
      content: "Effect-TS uses a fiber-based runtime for typed effects",
      confidence: 0.8,
    });
    const m3 = mkMem({
      title: "TypeScript error patterns",
      content: "Typed error handling with Effect-TS prevents runtime surprises",
      confidence: 0.7,
    });
    await trackedWrite(m1);
    await trackedWrite(m2);
    await trackedWrite(m3);

    await feedLastUserMsg(ret, "session-A", "tell me about Effect-TS error handling");
    const block = await ret.systemContext("session-A");

    expect(block).toContain("## Mnemosyne — Relevant memories");
    expect(block).toContain("**[preference]**");
    // At least one of the seeded memories surfaced.
    const seededTitles = [m1.title, m2.title, m3.title];
    const surfaced = seededTitles.filter((t) => block.includes(t));
    expect(surfaced.length).toBeGreaterThan(0);
    // Format markers
    expect(block).toMatch(/_ref: [a-f0-9]{4} • created: \d{4}-\d{2}-\d{2} • reinforcements: \d+_/);
    // top-K respected — at most 3 numbered entries
    const numbered = block.match(/^\d+\. \*\*\[/gm) ?? [];
    expect(numbered.length).toBeLessThanOrEqual(3);
  });

  it("includes 1-hop graph neighbors", async () => {
    await clearAllMemories();
    const ret = makeRetriever({ topK: 5 });

    // Seed: a vector-friendly memory about CRDTs and a graph-only neighbor
    // linked via a RELATES edge. Vector won't pull the neighbor (different
    // topic) but graph 1-hop must surface it.
    const seed = mkMem({
      title: "Sir prefers CRDTs for sync",
      content: "Sir prefers CRDTs for collaborative-state synchronization",
      confidence: 0.9,
    });
    const neighbor = mkMem({
      title: "Tooling note: Yjs",
      content: "Yjs is a CRDT library — completely unrelated topic prose to avoid vector match",
      confidence: 0.6,
    });
    await trackedWrite(seed);
    await trackedWrite(neighbor);

    // Wire seed —RELATES— neighbor directly via raw cypher.
    const s = rawDriver.session();
    try {
      await s.run(
        `MATCH (a:Memory {id: $a}), (b:Memory {id: $b})
         MERGE (a)-[:RELATES {weight: 1.0}]->(b)`,
        { a: seed.id, b: neighbor.id }
      );
    } finally {
      await s.close();
    }

    await feedLastUserMsg(ret, "session-graph", "what does Sir use for collaborative state sync");
    const block = await ret.systemContext("session-graph");

    expect(block).toContain(seed.title);
    // Graph neighbor should also appear because of 1-hop expansion.
    expect(block).toContain(neighbor.title);
  });

  it("filters private memories belonging to other sessions", async () => {
    await clearAllMemories();
    const ret = makeRetriever({ topK: 5 });

    const ownMem = mkMem({
      title: "Open shared tip",
      content: "Sir keeps a paper notebook for daily standups",
      visibility: "open",
      source_session: "session-X",
    });
    const otherPrivate = mkMem({
      title: "Other session secret",
      content: "Sir keeps a secret journal for reflective writing private notes",
      visibility: "private",
      source_session: "session-Y",
    });
    const ownPrivate = mkMem({
      title: "My own private",
      content: "Sir keeps a private wishlist for hobby projects in this session only",
      visibility: "private",
      source_session: "session-X",
    });
    await trackedWrite(ownMem);
    await trackedWrite(otherPrivate);
    await trackedWrite(ownPrivate);

    await feedLastUserMsg(ret, "session-X", "what does Sir keep notes about");
    const block = await ret.systemContext("session-X");

    // session-X's own memories (open + private) are visible.
    expect(block).toContain(ownMem.title);
    expect(block).toContain(ownPrivate.title);
    // session-Y's private memory must NOT leak into session-X.
    expect(block).not.toContain(otherPrivate.title);
  });

  it("surfaces CONTRADICTS edges in the rendered block", async () => {
    await clearAllMemories();
    const ret = makeRetriever({ topK: 5 });

    const a = mkMem({
      title: "Effect-TS is preferred",
      content: "Sir prefers Effect-TS for error handling",
      confidence: 0.9,
    });
    const b = mkMem({
      title: "Plain try/catch is preferred",
      content: "Sir uses standard try/catch in TypeScript projects",
      confidence: 0.7,
    });
    await trackedWrite(a);
    await trackedWrite(b);
    await createContradictsEdgeRaw(a.id, b.id);

    await feedLastUserMsg(ret, "session-conflict", "how does Sir handle TypeScript errors");
    const block = await ret.systemContext("session-conflict");

    // Both should surface (similar topic), and at least one should display
    // the conflict marker referencing the other's short id.
    expect(block).toContain(a.title);
    expect(block).toContain(b.title);
    expect(block).toMatch(/⚠️ Conflicts with: [a-f0-9]{4}/);
  });

  it("increments reinforcements on retrieval (D2: retrieval-only signal)", async () => {
    await clearAllMemories();
    const ret = makeRetriever({ topK: 3 });

    const m = mkMem({
      title: "Tail-call optimization preference",
      content: "Sir prefers tail-call style in functional code for clarity",
      confidence: 0.85,
      reinforcements: 0,
    });
    await trackedWrite(m);

    const before = await store.neo4j.getMemory(m.id);
    expect(before?.reinforcements).toBe(0);

    await feedLastUserMsg(ret, "session-rein", "what's Sir's stance on tail-call style");
    const block = await ret.systemContext("session-rein");
    expect(block).toContain(m.title);

    const after = await store.neo4j.getMemory(m.id);
    expect(after?.reinforcements).toBe(1);
  });

  it("caches the rendered block when last_user_msg is unchanged", async () => {
    await clearAllMemories();
    const ret = makeRetriever({ topK: 3 });

    const m = mkMem({
      title: "Cache-test memory",
      content: "this is some content about caching repeated calls in tests",
      confidence: 0.7,
    });
    await trackedWrite(m);

    await feedLastUserMsg(ret, "session-cache", "tell me about caching");

    const querySpy = vi.spyOn(store.chroma, "query");

    const block1 = await ret.systemContext("session-cache");
    const block2 = await ret.systemContext("session-cache");

    expect(block1).toBe(block2);

    // First call hits chroma twice (short + long). Second call must be cached.
    expect(querySpy).toHaveBeenCalledTimes(2);

    querySpy.mockRestore();
  });
});
