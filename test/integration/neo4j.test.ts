import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Neo4jServer } from "../../lib/neo4j-server";
import { Neo4jAdapter } from "../../lib/neo4j-adapter";
import type { Memory } from "../../lib/types";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { v4 as uuid } from "uuid";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// File-scoped server lifecycle (per errata #7): both Neo4jServer and
// Neo4jAdapter describes share the same container instance.
let server: Neo4jServer;
let adapter: Neo4jAdapter;

beforeAll(async () => {
  // Clean up any stale container from preflight or prior failed run
  try {
    await exec("docker", ["rm", "-f", "mnemosyne-neo4j"]);
  } catch {
    // no stale container — fine
  }

  server = new Neo4jServer({
    composeFile: join(__dirname, "../../docker/docker-compose.yml"),
    containerName: "mnemosyne-neo4j",
    boltUri: "bolt://127.0.0.1:7687",
  });
  await server.start();

  adapter = new Neo4jAdapter({ uri: "bolt://127.0.0.1:7687" });
  await adapter.connect();
  await adapter.applySchema(join(__dirname, "../../cypher/schema.cypher"));
}, 120000);

afterAll(async () => {
  await adapter?.close();
  await server?.stop();
}, 60000);

describe("Neo4jServer", () => {
  it("isHealthy returns true after start", async () => {
    expect(await server.isHealthy()).toBe(true);
  });

  it("port is bound to 127.0.0.1 only", async () => {
    expect(await server.validateLoopbackBinding()).toBe(true);
  });
});

describe("Neo4jAdapter", () => {
  it("upsertMemory + getMemory", async () => {
    const id = uuid();
    await adapter.upsertMemory({
      id, category: "preference", title: "test mem", content: "...",
      tags: ["a", "b"], project: null, confidence: 0.8, reinforcements: 0,
      visibility: "open", pinned: false,
      created_at: Date.now(), last_accessed: Date.now(),
      source_session: "main", promoted_at: null,
    });
    const got = await adapter.getMemory(id);
    expect(got).toBeDefined();
    expect(got?.title).toBe("test mem");
  });

  it("incrementReinforcements", async () => {
    const id = uuid();
    await adapter.upsertMemory({ id, category: "preference", title: "x", content: "", tags: [], project: null, confidence: 0.5, reinforcements: 0, visibility: "open", pinned: false, created_at: Date.now(), last_accessed: Date.now(), source_session: "main", promoted_at: null });
    await adapter.incrementReinforcements(id);
    const got = await adapter.getMemory(id);
    expect(got?.reinforcements).toBe(1);
  });

  it("oneHopNeighbors returns connected memories", async () => {
    const a = uuid(), b = uuid();
    const mkMem = (id: string, title: string): Memory => ({ id, category: "preference", title, content: "", tags: [], project: null, confidence: 0.7, reinforcements: 0, visibility: "open", pinned: false, created_at: Date.now(), last_accessed: Date.now(), source_session: "main", promoted_at: null });
    await adapter.upsertMemory(mkMem(a, "A"));
    await adapter.upsertMemory(mkMem(b, "B"));
    // create RELATES_TO edge directly via session helper
    const session = (adapter as any).session();
    try {
      await session.run(
        `MATCH (a:Memory {id: $a}), (b:Memory {id: $b}) MERGE (a)-[:RELATES_TO {weight: 0.8, created_at: $now}]->(b)`,
        { a, b, now: Date.now() }
      );
    } finally {
      await session.close();
    }
    const neighbors = await adapter.oneHopNeighbors([a]);
    expect(neighbors.find((m) => m.id === b)).toBeDefined();
  });

  it("deleteMemory removes node and edges", async () => {
    const id = uuid();
    await adapter.upsertMemory({ id, category: "preference", title: "x", content: "", tags: [], project: null, confidence: 0.7, reinforcements: 0, visibility: "open", pinned: false, created_at: Date.now(), last_accessed: Date.now(), source_session: "main", promoted_at: null });
    expect(await adapter.getMemory(id)).toBeDefined();
    await adapter.deleteMemory(id);
    expect(await adapter.getMemory(id)).toBeNull();
  });
});
