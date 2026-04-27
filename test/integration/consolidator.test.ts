import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { v4 as uuid } from "uuid";

import { MnemosyneStore } from "../../lib/store";
import { MarkdownStore } from "../../lib/markdown-store";
import { ChromaServer } from "../../lib/chroma-server";
import { ChromaAdapter } from "../../lib/chroma-adapter";
import { Neo4jServer } from "../../lib/neo4j-server";
import { Neo4jAdapter } from "../../lib/neo4j-adapter";
import { Logger } from "../../lib/logger";
import { ConflictDetector } from "../../lib/conflict-detector";
import {
  ConsolidatorPiece,
  type ConsolidatorConfig,
} from "../../pieces/consolidator";
import type { Memory, Category } from "../../lib/types";
import type { LLMClient } from "../../lib/extractor";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = resolve(__dirname, "../../prompts");

// Dedicated chroma port (8770) per task brief, separate from store.test.ts (8767).
const CHROMA_PORT = 8770;

// Minimal EventBus stub — production EventBus lives in @jarvis/core but vitest
// cannot resolve workspace path imports without a config. The consolidator only
// uses bus.subscribe, so this stub is enough.
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
  publish(_msg: any): void {
    // unused
  }
  get stats() {
    return { subscriptions: 0, events: 0 };
  }
}

let chromaServer: ChromaServer;
let neo4jServer: Neo4jServer;
let chroma: ChromaAdapter;
let neo4j: Neo4jAdapter;
let markdownStore: MarkdownStore;
let logger: Logger;
let store: MnemosyneStore;
let chromaDir: string;
let mdDir: string;
let logDir: string;
let llmCallMock: LLMClient["call"];
let llm: LLMClient;

const DAY = 24 * 60 * 60 * 1000;

function mkMem(overrides: Partial<Memory> = {}): Memory {
  return {
    id: uuid(),
    category: "preference" as Category,
    title: "default",
    content: "default content",
    tags: [],
    project: null,
    confidence: 0.8,
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

function defaultConfig(
  overrides: Partial<ConsolidatorConfig> = {}
): ConsolidatorConfig {
  return {
    cron: "0 3 * * *",
    skipIfActiveWithinMinutes: 15,
    promotionReinforcementsThreshold: 3,
    promotionConfidenceThreshold: 0.95,
    mergeSimilarityThreshold: 0.9,
    decay: { threshold: 60, categoryMultipliers: {} },
    ...overrides,
  };
}

async function clearAllMemories() {
  // Wipe Neo4j memory nodes
  const drv = (neo4j as any).driver;
  const s = drv.session();
  try {
    await s.run("MATCH (m:Memory) DETACH DELETE m");
  } finally {
    await s.close();
  }
  // Wipe markdown
  rmSync(mdDir, { recursive: true, force: true });
  mkdirSync(mdDir, { recursive: true });
  // Wipe chroma collections by recreating them (delete-by-id of unknown set is awkward)
  const { ChromaClient } = await import("chromadb");
  const client = new ChromaClient({ path: `http://127.0.0.1:${CHROMA_PORT}` });
  try {
    await client.deleteCollection({ name: "mnemosyne_short" });
  } catch {}
  try {
    await client.deleteCollection({ name: "mnemosyne_long" });
  } catch {}
  await chroma.init();
}

beforeAll(async () => {
  // Stale neo4j cleanup
  try {
    await exec("docker", ["rm", "-f", "mnemosyne-neo4j"]);
  } catch {
    // no stale container — fine
  }

  chromaDir = mkdtempSync(join(tmpdir(), "consolidator-chroma-"));
  mdDir = mkdtempSync(join(tmpdir(), "consolidator-md-"));
  logDir = mkdtempSync(join(tmpdir(), "consolidator-log-"));

  chromaServer = new ChromaServer({ dataDir: chromaDir, port: CHROMA_PORT });
  await chromaServer.start();

  neo4jServer = new Neo4jServer({
    composeFile: join(__dirname, "../../docker/docker-compose.yml"),
    containerName: "mnemosyne-neo4j",
    boltUri: "bolt://127.0.0.1:7687",
  });
  await neo4jServer.start();

  chroma = new ChromaAdapter({
    host: "127.0.0.1",
    port: CHROMA_PORT,
    embeddingModel: "minilm",
  });
  await chroma.init();

  neo4j = new Neo4jAdapter({ uri: "bolt://127.0.0.1:7687" });
  await neo4j.connect();
  await neo4j.applySchema(join(__dirname, "../../cypher/schema.cypher"));

  markdownStore = new MarkdownStore(mdDir);
  logger = new Logger(logDir);
  store = new MnemosyneStore(markdownStore, chroma, neo4j, logger);

  llmCallMock = vi.fn(async () => "{}") as unknown as LLMClient["call"];
  llm = { call: llmCallMock };
}, 90000);

afterAll(async () => {
  await neo4j?.close();
  await chromaServer?.stop();
  await neo4jServer?.stop();
  rmSync(chromaDir, { recursive: true, force: true });
  rmSync(mdDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
}, 90000);

describe("ConsolidatorPiece", () => {
  it("promotes a short-term memory once reinforcements >= threshold", async () => {
    await clearAllMemories();
    const detector = new ConflictDetector(llm, chroma, neo4j, {
      similarityThreshold: 0.85,
      promptsDir,
    });
    const consolidator = new ConsolidatorPiece(
      store,
      detector,
      logger,
      defaultConfig()
    );
    const bus = new TestBus() as any;
    await consolidator.start(bus);

    const mem = mkMem({
      title: "Sir prefers Effect-TS strongly",
      content: "Sir prefers Effect-TS for error handling",
    });
    await store.write(mem);

    // Reinforce 3 times to cross the threshold of 3
    await store.neo4j.incrementReinforcements(mem.id);
    await store.neo4j.incrementReinforcements(mem.id);
    await store.neo4j.incrementReinforcements(mem.id);

    // Make idle
    consolidator.setLastActivityTs(Date.now() - 60 * 60 * 1000);

    const stats = await consolidator.run();

    expect(stats.promoted).toBe(1);
    const fresh = await neo4j.getMemory(mem.id);
    expect(fresh?.promoted_at).not.toBeNull();
    expect(typeof fresh?.promoted_at).toBe("number");

    await consolidator.stop();
  });

  it("decays a short-term memory whose forget_score exceeds threshold", async () => {
    await clearAllMemories();
    const detector = new ConflictDetector(llm, chroma, neo4j, {
      similarityThreshold: 0.85,
      promptsDir,
    });
    const consolidator = new ConsolidatorPiece(
      store,
      detector,
      logger,
      defaultConfig()
    );
    const bus = new TestBus() as any;
    await consolidator.start(bus);

    // last_accessed 100 days ago, conf 0.5, reinforcements 0
    // forgetScore = 100 / (0.5 * 1) = 200, well above threshold 60
    const stale = mkMem({
      title: "Stale memory destined to decay",
      content: "should be forgotten",
      confidence: 0.5,
      reinforcements: 0,
      last_accessed: Date.now() - 100 * DAY,
      created_at: Date.now() - 100 * DAY,
    });
    await store.write(stale);

    consolidator.setLastActivityTs(Date.now() - 60 * 60 * 1000);

    const stats = await consolidator.run();

    expect(stats.decayed).toBeGreaterThanOrEqual(1);
    expect(await markdownStore.read(stale.id)).toBeNull();
    expect(await neo4j.getMemory(stale.id)).toBeNull();

    await consolidator.stop();
  });

  it("skips run when active within skipIfActiveWithinMinutes window", async () => {
    await clearAllMemories();
    const detector = new ConflictDetector(llm, chroma, neo4j, {
      similarityThreshold: 0.85,
      promptsDir,
    });
    const consolidator = new ConsolidatorPiece(
      store,
      detector,
      logger,
      defaultConfig()
    );
    const bus = new TestBus() as any;
    await consolidator.start(bus);

    // Pretend the user typed 5 minutes ago — well within the 15-minute window
    consolidator.setLastActivityTs(Date.now() - 5 * 60 * 1000);

    const stats = await consolidator.run();
    expect(stats).toEqual({ promoted: 0, decayed: 0, conflicts: 0, merged: 0 });

    await consolidator.stop();
  });

  it("merges semantic duplicates: increments older, deletes newer", async () => {
    await clearAllMemories();
    const detector = new ConflictDetector(llm, chroma, neo4j, {
      similarityThreshold: 0.85,
      promptsDir,
    });
    // Use a relaxed merge threshold so the MiniLM embeddings of two near-identical
    // sentences land safely above it.
    const consolidator = new ConsolidatorPiece(
      store,
      detector,
      logger,
      defaultConfig({
        mergeSimilarityThreshold: 0.7,
        // Prevent these merged memories from also promoting and getting picked
        // up by conflict detection — keep this test isolated to dedup behaviour.
        promotionConfidenceThreshold: 1.1,
        promotionReinforcementsThreshold: 999,
      })
    );
    const bus = new TestBus() as any;
    await consolidator.start(bus);

    const olderTs = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    const newerTs = Date.now() - 1 * 60 * 60 * 1000; // 1h ago

    const older = mkMem({
      title: "Sir prefers Effect-TS for error handling",
      content: "Sir prefers Effect-TS for error handling in TypeScript",
      created_at: olderTs,
      last_accessed: olderTs,
    });
    const newer = mkMem({
      title: "Sir likes Effect-TS for errors",
      content: "Sir prefers Effect-TS for error handling in TypeScript",
      created_at: newerTs,
      last_accessed: newerTs,
    });
    await store.write(older);
    await store.write(newer);

    consolidator.setLastActivityTs(Date.now() - 60 * 60 * 1000);

    const stats = await consolidator.run();
    expect(stats.merged).toBeGreaterThanOrEqual(1);

    // Exactly one of the two should survive; the survivor must be `older`
    // (the older created_at wins), with reinforcements bumped.
    const olderFresh = await neo4j.getMemory(older.id);
    const newerFresh = await neo4j.getMemory(newer.id);
    const survivors = [olderFresh, newerFresh].filter((m) => m !== null).length;
    expect(survivors).toBe(1);
    expect(olderFresh).not.toBeNull();
    expect(olderFresh?.reinforcements).toBeGreaterThanOrEqual(1);
    expect(newerFresh).toBeNull();
    expect(await markdownStore.read(newer.id)).toBeNull();

    await consolidator.stop();
  });

  it("createContradictsEdge creates a bidirectional CONTRADICTS edge", async () => {
    await clearAllMemories();
    const a = mkMem({ title: "A", content: "uses Effect-TS" });
    const b = mkMem({ title: "B", content: "never uses Effect-TS" });
    await store.write(a);
    await store.write(b);

    await neo4j.createContradictsEdge(a.id, b.id);

    const fromA = await neo4j.getContradictions(a.id);
    const fromB = await neo4j.getContradictions(b.id);
    expect(fromA).toContain(b.id);
    expect(fromB).toContain(a.id);
  });
});
