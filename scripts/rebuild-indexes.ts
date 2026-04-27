#!/usr/bin/env -S npx tsx
/**
 * scripts/rebuild-indexes.ts
 *
 * Rebuild Chroma + Neo4j indexes from the canonical markdown source of truth.
 *
 * Run with: `npx tsx scripts/rebuild-indexes.ts`
 *           (or `node --import tsx scripts/rebuild-indexes.ts`)
 *
 * Use cases:
 *   - Embedding model changed (vectors from different models are not comparable)
 *   - Chroma or Neo4j data corrupted / wiped
 *   - Disaster recovery from a markdown-only backup
 *
 * Behavior:
 *   - Reads ALL memories from MarkdownStore
 *   - For each: re-upserts into Chroma (regenerates embeddings) and Neo4j
 *   - Continues past per-memory errors (logged), summary at the end
 *   - Does NOT touch the markdown files themselves
 *
 * Assumes Chroma + Neo4j are already running. Use scripts/preflight-check.sh
 * or `make` targets to verify.
 */
import { promises as fs } from "fs";
import { join } from "path";

import { MarkdownStore } from "../lib/markdown-store.js";
import { ChromaAdapter } from "../lib/chroma-adapter.js";
import { Neo4jAdapter } from "../lib/neo4j-adapter.js";

interface MnemosyneConfig {
  chroma: { host: string; port: number; embedding_model: "minilm" };
  neo4j: { bolt_uri: string };
}

const DATA_DIR = `${process.env.HOME}/.jarvis/mnemosyne`;
const CONFIG_PATH = join(DATA_DIR, "config.json");
const DEFAULT_CONFIG_PATH = join(
  new URL("../config.default.json", import.meta.url).pathname
);

async function loadConfig(): Promise<MnemosyneConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as MnemosyneConfig;
  } catch {
    const raw = await fs.readFile(DEFAULT_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as MnemosyneConfig;
  }
}

async function main(): Promise<void> {
  console.log("[rebuild-indexes] starting…");
  console.log(`[rebuild-indexes] DATA_DIR=${DATA_DIR}`);

  const config = await loadConfig();

  const markdown = new MarkdownStore(DATA_DIR);
  const chroma = new ChromaAdapter({
    host: config.chroma.host,
    port: config.chroma.port,
    embeddingModel: config.chroma.embedding_model,
  });
  const neo4j = new Neo4jAdapter({ uri: config.neo4j.bolt_uri });

  // Connect both stores. If either fails the user gets a clear error.
  console.log("[rebuild-indexes] connecting Chroma…");
  await chroma.init();
  console.log("[rebuild-indexes] connecting Neo4j…");
  await neo4j.connect();

  // Read every memory. MarkdownStore is the canonical source.
  const memories = await markdown.list({});
  const total = memories.length;
  console.log(`[rebuild-indexes] found ${total} memories in markdown`);

  if (total === 0) {
    console.log("[rebuild-indexes] nothing to rebuild");
    await neo4j.close();
    return;
  }

  let chromaOk = 0;
  let chromaErr = 0;
  let neo4jOk = 0;
  let neo4jErr = 0;
  const errors: Array<{ id: string; layer: string; reason: string }> = [];

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    const layer = m.promoted_at ? "long" : "short";

    // --- Chroma upsert -------------------------------------------------------
    try {
      await chroma.upsert(layer, {
        id: m.id,
        content: m.content,
        metadata: {
          category: m.category,
          project: m.project ?? "",
          confidence: m.confidence,
          reinforcements: m.reinforcements,
          created_at: m.created_at,
          visibility: m.visibility,
          source_session: m.source_session,
        },
      });
      chromaOk++;
    } catch (e) {
      chromaErr++;
      errors.push({ id: m.id, layer: "chroma", reason: String(e) });
      process.stderr.write(
        `[rebuild-indexes] chroma upsert failed for ${m.id}: ${e}\n`
      );
    }

    // --- Neo4j upsert --------------------------------------------------------
    try {
      await neo4j.upsertMemory(m);
      if (m.promoted_at) {
        await neo4j.markPromoted(m.id, m.promoted_at);
      }
      neo4jOk++;
    } catch (e) {
      neo4jErr++;
      errors.push({ id: m.id, layer: "neo4j", reason: String(e) });
      process.stderr.write(
        `[rebuild-indexes] neo4j upsert failed for ${m.id}: ${e}\n`
      );
    }

    // Progress every 10
    if ((i + 1) % 10 === 0 || i + 1 === total) {
      console.log(`[rebuild-indexes] rebuilt ${i + 1}/${total}`);
    }
  }

  await neo4j.close();

  console.log("");
  console.log("[rebuild-indexes] summary:");
  console.log(`  chroma:  ${chromaOk} ok / ${chromaErr} err`);
  console.log(`  neo4j:   ${neo4jOk} ok / ${neo4jErr} err`);
  if (errors.length > 0) {
    console.log(`  total errors: ${errors.length}`);
    process.exitCode = 1;
  } else {
    console.log("  all good");
  }
}

main().catch((e) => {
  console.error("[rebuild-indexes] fatal:", e);
  process.exit(1);
});
