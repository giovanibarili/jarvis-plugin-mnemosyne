import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { MnemosyneStore } from "../../lib/store";
import { MarkdownStore } from "../../lib/markdown-store";
import { ChromaServer } from "../../lib/chroma-server";
import { ChromaAdapter } from "../../lib/chroma-adapter";
import { Neo4jServer } from "../../lib/neo4j-server";
import { Neo4jAdapter } from "../../lib/neo4j-adapter";
import { Logger } from "../../lib/logger";
import { Extractor } from "../../lib/extractor";
import type { LLMClient } from "../../lib/extractor";
import { EncoderPiece } from "../../pieces/encoder";
import type { TurnContext } from "../../lib/types";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// File-scoped lifecycle (errata #7)
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

beforeAll(async () => {
  // Stale neo4j cleanup (Task 4 / errata #12). We use the shared container
  // name `mnemosyne-neo4j` because the docker-compose.yml file pins it. To
  // avoid racing with sibling integration test files (store.test.ts,
  // neo4j.test.ts, etc. that also reuse the same container) we rely on
  // vitest's default file-level lifecycle: `docker compose up -d` is
  // idempotent, so each beforeAll either reuses a running container or
  // brings it up. The `docker rm -f` is best-effort: if another file is
  // mid-test we tolerate the failure instead of wiping its container.
  try {
    await exec("docker", ["rm", "-f", "mnemosyne-neo4j"]);
  } catch {
    // no stale container — fine
  }

  chromaDir = mkdtempSync(join(tmpdir(), "wf-chroma-"));
  mdDir = mkdtempSync(join(tmpdir(), "wf-md-"));
  logDir = mkdtempSync(join(tmpdir(), "wf-log-"));

  chromaServer = new ChromaServer({ dataDir: chromaDir, port: 8768 });
  await chromaServer.start();

  neo4jServer = new Neo4jServer({
    composeFile: join(__dirname, "../../docker/docker-compose.yml"),
    containerName: "mnemosyne-neo4j",
    boltUri: "bolt://127.0.0.1:7687",
  });
  await neo4jServer.start();

  chroma = new ChromaAdapter({
    host: "127.0.0.1",
    port: 8768,
    embeddingModel: "minilm",
  });
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
}, 120000);

function makeWorkflowLLM(): LLMClient {
  // Triage → workflow only; then extractWorkflow returns 3-step workflow.
  return {
    call: vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ present: ["workflow"], skip_reason: null })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          is_workflow: true,
          workflow: {
            name: "deploy-clojure-service",
            description: "Standard deploy pipeline for Clojure microservices.",
            trigger: "user wants to ship a service",
            outcome: "service deployed to production",
            applies_to_project: "saa",
            steps: [
              {
                order: 1,
                action: "run lein lint-fix",
                tool: "bash",
                guard: null,
                required: true,
                confirms_required: false,
              },
              {
                order: 2,
                action: "run lein test",
                tool: "bash",
                guard: "lint-fix passed",
                required: true,
                confirms_required: false,
              },
              {
                order: 3,
                action: "open PR",
                tool: "gh",
                guard: "tests passed",
                required: true,
                confirms_required: true,
              },
            ],
            branches: [],
            confidence: 0.9,
          },
        })
      ),
  };
}

async function flushEncoder(piece: EncoderPiece) {
  await piece.stop();
}

describe("Workflow persistence (Encoder → Neo4jAdapter)", () => {
  it("encoder writes Workflow + 3 Step nodes connected via NEXT edges", async () => {
    // Clean any leftover Workflow/Step/Project state from prior runs (the
    // neo4j-data volume persists across `docker rm -f`).
    {
      const ses = (neo4j as any).session();
      try {
        await ses.run("MATCH (w:Workflow) DETACH DELETE w");
        await ses.run("MATCH (s:Step) DETACH DELETE s");
        await ses.run("MATCH (p:Project) DETACH DELETE p");
      } finally {
        await ses.close();
      }
    }
    const promptsDir = join(__dirname, "../../prompts");
    const llm = makeWorkflowLLM();
    const extractor = new Extractor(llm, promptsDir);
    const encoder = new EncoderPiece(extractor, store, logger);

    const turn: TurnContext = {
      session_id: "main",
      user_message:
        "ok let's ship this clojure service: lint-fix, then tests, then open the PR",
      assistant_response:
        "Sure. Step 1 lein lint-fix. Step 2 lein test. Step 3 open the PR with gh.",
      tool_calls: [],
      timestamp: Date.now(),
    };

    encoder.enqueue(turn);
    await flushEncoder(encoder);

    // 1. Workflow node exists with the expected name
    const got = await store.neo4j.getWorkflow("deploy-clojure-service");
    expect(got).not.toBeNull();
    expect(got!.name).toBe("deploy-clojure-service");
    expect(got!.trigger).toBe("user wants to ship a service");
    expect(got!.outcome).toBe("service deployed to production");
    expect(got!.applies_to_project).toBe("saa");
    expect(got!.confidence).toBe(0.9);

    // 2. 3 Step nodes returned, in NEXT order
    expect(got!.steps).toHaveLength(3);
    expect(got!.steps.map((s) => s.action)).toEqual([
      "run lein lint-fix",
      "run lein test",
      "open PR",
    ]);
    expect(got!.steps.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(got!.steps[2].confirms_required).toBe(true);

    // 3. NEXT edges connect them in order — verify directly via Cypher
    const session = (store.neo4j as any).session();
    try {
      const r = await session.run(
        `MATCH (w:Workflow {name: $n})-[:STARTS_AT]->(s1:Step)-[:NEXT]->(s2:Step)-[:NEXT]->(s3:Step)
         OPTIONAL MATCH (w)-[:ENDS_AT]->(end:Step)
         RETURN s1.action AS a1, s2.action AS a2, s3.action AS a3, end.action AS endAction`,
        { n: "deploy-clojure-service" }
      );
      expect(r.records.length).toBe(1);
      const rec = r.records[0];
      expect(rec.get("a1")).toBe("run lein lint-fix");
      expect(rec.get("a2")).toBe("run lein test");
      expect(rec.get("a3")).toBe("open PR");
      expect(rec.get("endAction")).toBe("open PR");

      // APPLIES_TO project edge
      const proj = await session.run(
        `MATCH (w:Workflow {name: $n})-[:APPLIES_TO]->(p:Project) RETURN p.name AS name`,
        { n: "deploy-clojure-service" }
      );
      expect(proj.records[0].get("name")).toBe("saa");

      // Step count
      const cnt = await session.run(
        `MATCH (w:Workflow {name: $n})-[:STARTS_AT]->()-[:NEXT*0..]->(s:Step) RETURN count(DISTINCT s) AS c`,
        { n: "deploy-clojure-service" }
      );
      expect(cnt.records[0].get("c").toNumber()).toBe(3);
    } finally {
      await session.close();
    }

    // 4. listWorkflows returns it
    const all = await store.neo4j.listWorkflows();
    expect(all.find((w) => w.name === "deploy-clojure-service")).toBeDefined();

    // 5. listWorkflows with project filter
    const filtered = await store.neo4j.listWorkflows({ project: "saa" });
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(filtered.find((w) => w.name === "deploy-clojure-service")).toBeDefined();

    const filteredOther = await store.neo4j.listWorkflows({
      project: "nonexistent-project",
    });
    expect(filteredOther.length).toBe(0);
  }, 90000);
});
