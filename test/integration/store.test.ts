import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MnemosyneStore } from "../../lib/store";
import { MarkdownStore } from "../../lib/markdown-store";
import { ChromaServer } from "../../lib/chroma-server";
import { ChromaAdapter } from "../../lib/chroma-adapter";
import { Neo4jServer } from "../../lib/neo4j-server";
import { Neo4jAdapter } from "../../lib/neo4j-adapter";
import { Logger } from "../../lib/logger";
import type { Memory } from "../../lib/types";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { v4 as uuid } from "uuid";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// File-scoped lifecycle per errata #7
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

function mkMem(id: string, title: string, content = "default content"): Memory {
  return {
    id,
    category: "preference",
    title,
    content,
    tags: ["test"],
    project: null,
    confidence: 0.8,
    reinforcements: 0,
    visibility: "open",
    pinned: false,
    created_at: Date.now(),
    last_accessed: Date.now(),
    source_session: "main",
    promoted_at: null,
  };
}

beforeAll(async () => {
  // Stale neo4j cleanup (Task 4 pattern)
  try {
    await exec("docker", ["rm", "-f", "mnemosyne-neo4j"]);
  } catch {
    // no stale container
  }

  chromaDir = mkdtempSync(join(tmpdir(), "store-chroma-"));
  mdDir = mkdtempSync(join(tmpdir(), "store-md-"));
  logDir = mkdtempSync(join(tmpdir(), "store-log-"));

  chromaServer = new ChromaServer({ dataDir: chromaDir, port: 8767 });
  await chromaServer.start();

  neo4jServer = new Neo4jServer({
    composeFile: join(__dirname, "../../docker/docker-compose.yml"),
    containerName: "mnemosyne-neo4j",
    boltUri: "bolt://127.0.0.1:7687",
  });
  await neo4jServer.start();

  chroma = new ChromaAdapter({ host: "127.0.0.1", port: 8767, embeddingModel: "minilm" });
  await chroma.init();

  neo4j = new Neo4jAdapter({ uri: "bolt://127.0.0.1:7687" });
  await neo4j.connect();
  await neo4j.applySchema(join(__dirname, "../../cypher/schema.cypher"));

  markdownStore = new MarkdownStore(mdDir);
  logger = new Logger(logDir);
  store = new MnemosyneStore(markdownStore, chroma, neo4j, logger);
}, 180000);

afterAll(async () => {
  await neo4j?.close();
  await chromaServer?.stop();
  await neo4jServer?.stop();
  rmSync(chromaDir, { recursive: true, force: true });
  rmSync(mdDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
}, 60000);

describe("MnemosyneStore", () => {
  it("write persists to all 3 layers atomically", async () => {
    const id = uuid();
    const mem = mkMem(id, "Sir prefers Effect-TS", "Sir prefers Effect-TS for error handling");
    await store.write(mem);

    expect(await store.markdownStore.read(id)).toBeDefined();

    const hits = await store.chroma.query("short", "Effect-TS error handling", 3);
    expect(hits.find((h) => h.id === id)).toBeDefined();

    const fromGraph = await store.neo4j.getMemory(id);
    expect(fromGraph).toBeDefined();
    expect(fromGraph?.title).toBe("Sir prefers Effect-TS");
  });

  it("delete removes from all 3 layers", async () => {
    const id = uuid();
    const mem = mkMem(id, "Temp memory", "temporary");
    await store.write(mem);
    expect(await store.markdownStore.read(id)).toBeDefined();

    await store.delete(id);

    expect(await store.markdownStore.read(id)).toBeNull();
    const hits = await store.chroma.query("short", "temporary", 5);
    expect(hits.find((h) => h.id === id)).toBeUndefined();
    expect(await store.neo4j.getMemory(id)).toBeNull();
  });

  it("rollback on chroma failure preserves nothing (markdown rolled back too)", async () => {
    const id = uuid();
    const mem = mkMem(id, "Should rollback", "this write should fully rollback");

    const spy = vi.spyOn(store.chroma, "upsert").mockRejectedValueOnce(
      new Error("simulated chroma failure")
    );

    await expect(store.write(mem)).rejects.toThrow(/Chroma upsert failed/);

    // After rollback: markdown must be empty, neo4j never touched
    expect(await store.markdownStore.read(id)).toBeNull();
    expect(await store.neo4j.getMemory(id)).toBeNull();

    spy.mockRestore();
  });

  it("rollback on neo4j failure removes markdown + chroma", async () => {
    const id = uuid();
    const mem = mkMem(id, "Neo4j rollback", "fail at neo4j stage");

    const spy = vi.spyOn(store.neo4j, "upsertMemory").mockRejectedValueOnce(
      new Error("simulated neo4j failure")
    );

    await expect(store.write(mem)).rejects.toThrow(/Neo4j upsert failed/);

    expect(await store.markdownStore.read(id)).toBeNull();
    const hits = await store.chroma.query("short", "fail at neo4j stage", 5);
    expect(hits.find((h) => h.id === id)).toBeUndefined();
    expect(await store.neo4j.getMemory(id)).toBeNull();

    spy.mockRestore();
  });
});
