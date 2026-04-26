import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChromaServer } from "../../lib/chroma-server";
import { ChromaAdapter } from "../../lib/chroma-adapter";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// File-scoped server lifecycle: both ChromaServer and ChromaAdapter describes
// share the same server instance. Per-describe afterAll would tear down the
// server before adapter tests run, so lifecycle is hoisted here.
let server: ChromaServer;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "chroma-test-"));
  server = new ChromaServer({ dataDir: dir, port: 8766 });
  await server.start();
}, 30000);

afterAll(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("ChromaServer", () => {
  it("responds to heartbeat after start", async () => {
    const response = await fetch("http://127.0.0.1:8766/api/v2/heartbeat");
    expect(response.ok).toBe(true);
  });

  it("isHealthy returns true when running", async () => {
    expect(await server.isHealthy()).toBe(true);
  });
});

describe("ChromaAdapter", () => {
  let adapter: ChromaAdapter;

  beforeAll(async () => {
    adapter = new ChromaAdapter({
      host: "127.0.0.1",
      port: 8766,
      embeddingModel: "minilm",
    });
    await adapter.init();
  }, 60000);

  it("upserts and queries memory", async () => {
    await adapter.upsert("short", {
      id: "test-1",
      content: "Sir prefers Effect-TS for error handling",
      metadata: { category: "preference", confidence: 0.9, visibility: "open" },
    });
    const hits = await adapter.query("short", "how to handle errors", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe("test-1");
  });

  it("delete removes from collection", async () => {
    await adapter.delete("short", "test-1");
    const hits = await adapter.query("short", "Effect-TS", 3);
    expect(hits.find((h) => h.id === "test-1")).toBeUndefined();
  });
});
