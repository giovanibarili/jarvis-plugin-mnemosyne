#!/usr/bin/env -S npx tsx
/**
 * scripts/check-stats.ts
 *
 * Print Mnemosyne storage statistics across all three layers and surface any
 * drift between them. The markdown store is the canonical source of truth;
 * Chroma and Neo4j are derived. Counts that diverge are flagged so an
 * operator knows to run scripts/rebuild-indexes.ts.
 *
 * Run with: `npx tsx scripts/check-stats.ts`
 *
 * Assumes Chroma + Neo4j are running. Prints zeros if the stores are empty.
 */
import { promises as fs } from "fs";
import { join } from "path";
import neo4j from "neo4j-driver";

import { MarkdownStore } from "../lib/markdown-store.js";
import { ChromaAdapter } from "../lib/chroma-adapter.js";

interface MnemosyneConfig {
  chroma: { host: string; port: number; embedding_model: "minilm" };
  neo4j: { bolt_uri: string };
}

const DATA_DIR = `${process.env.HOME}/.jarvis/mnemosyne`;
const CONFIG_PATH = join(DATA_DIR, "config.json");
const DEFAULT_CONFIG_PATH = new URL(
  "../config.default.json",
  import.meta.url
).pathname;

async function loadConfig(): Promise<MnemosyneConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as MnemosyneConfig;
  } catch {
    const raw = await fs.readFile(DEFAULT_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as MnemosyneConfig;
  }
}

interface MarkdownCounts {
  total: number;
  short: number;
  long: number;
}

async function markdownCounts(store: MarkdownStore): Promise<MarkdownCounts> {
  const all = await store.list({});
  return {
    total: all.length,
    short: all.filter((m) => !m.promoted_at).length,
    long: all.filter((m) => Boolean(m.promoted_at)).length,
  };
}

interface ChromaCounts {
  short: number | null;
  long: number | null;
  err?: string;
}

async function chromaCounts(adapter: ChromaAdapter): Promise<ChromaCounts> {
  try {
    const short = await adapter.count("short");
    const long = await adapter.count("long");
    return { short, long };
  } catch (e) {
    return { short: null, long: null, err: String(e) };
  }
}

interface Neo4jCounts {
  memory: number | null;
  workflow: number | null;
  step: number | null;
  err?: string;
}

async function neo4jCounts(uri: string): Promise<Neo4jCounts> {
  const driver = neo4j.driver(uri);
  try {
    await driver.verifyConnectivity();
    const session = driver.session();
    try {
      const m = await session.run("MATCH (n:Memory) RETURN count(n) AS c");
      const w = await session.run("MATCH (n:Workflow) RETURN count(n) AS c");
      const s = await session.run("MATCH (n:Step) RETURN count(n) AS c");
      return {
        memory: m.records[0].get("c").toNumber(),
        workflow: w.records[0].get("c").toNumber(),
        step: s.records[0].get("c").toNumber(),
      };
    } finally {
      await session.close();
    }
  } catch (e) {
    return { memory: null, workflow: null, step: null, err: String(e) };
  } finally {
    await driver.close();
  }
}

interface DataDirInfo {
  exists: boolean;
  size: string;
  recentLogs: Array<{ name: string; mtime: string; size: string }>;
}

async function dirSize(path: string): Promise<string> {
  // `du -sh` is portable enough across macOS / Linux for an admin script.
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const exec = promisify(execFile);
  try {
    const { stdout } = await exec("du", ["-sh", path]);
    return stdout.trim().split(/\s+/)[0] ?? "?";
  } catch {
    return "?";
  }
}

async function dataDirInfo(): Promise<DataDirInfo> {
  try {
    await fs.access(DATA_DIR);
  } catch {
    return { exists: false, size: "0", recentLogs: [] };
  }
  const size = await dirSize(DATA_DIR);
  const entries = await fs.readdir(DATA_DIR);
  const recentLogs: Array<{ name: string; mtime: string; size: string }> = [];
  for (const name of entries) {
    if (!name.endsWith(".log")) continue;
    const full = join(DATA_DIR, name);
    const stat = await fs.stat(full);
    recentLogs.push({
      name,
      mtime: stat.mtime.toISOString(),
      size: humanBytes(stat.size),
    });
  }
  recentLogs.sort((a, b) => (a.mtime > b.mtime ? -1 : 1));
  return { exists: true, size, recentLogs };
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

async function main(): Promise<void> {
  console.log("Mnemosyne storage stats");
  console.log("=======================\n");

  console.log(`DATA_DIR: ${DATA_DIR}`);
  const dd = await dataDirInfo();
  if (!dd.exists) {
    console.log("  (not present)\n");
  } else {
    console.log(`  total size: ${dd.size}`);
    if (dd.recentLogs.length > 0) {
      console.log("  recent logs:");
      for (const l of dd.recentLogs.slice(0, 5)) {
        console.log(`    - ${pad(l.name, 24)} ${pad(l.size, 8)} ${l.mtime}`);
      }
    } else {
      console.log("  (no log files)");
    }
    console.log("");
  }

  const config = await loadConfig();
  const md = await markdownCounts(new MarkdownStore(DATA_DIR));
  const chroma = new ChromaAdapter({
    host: config.chroma.host,
    port: config.chroma.port,
    embeddingModel: config.chroma.embedding_model,
  });
  let cc: ChromaCounts;
  try {
    await chroma.init();
    cc = await chromaCounts(chroma);
  } catch (e) {
    cc = { short: null, long: null, err: String(e) };
  }
  const nc = await neo4jCounts(config.neo4j.bolt_uri);

  // --- table ---------------------------------------------------------------
  const headerL = pad("layer", 10);
  const headerM = pad("markdown", 12);
  const headerC = pad("chroma", 12);
  const headerN = pad("neo4j", 12);
  const headerD = "drift";
  console.log(`${headerL}${headerM}${headerC}${headerN}${headerD}`);
  console.log("-".repeat(48));

  const fmt = (v: number | null): string =>
    v === null ? "(err)" : String(v);

  // short row
  const driftShort =
    cc.short !== null && cc.short !== md.short ? "⚠ chroma" : "";
  console.log(
    `${pad("short", 10)}${pad(String(md.short), 12)}${pad(fmt(cc.short), 12)}${pad("—", 12)}${driftShort}`
  );

  // long row
  const driftLong =
    cc.long !== null && cc.long !== md.long ? "⚠ chroma" : "";
  console.log(
    `${pad("long", 10)}${pad(String(md.long), 12)}${pad(fmt(cc.long), 12)}${pad("—", 12)}${driftLong}`
  );

  // total memory row
  const chromaTotal =
    cc.short !== null && cc.long !== null ? cc.short + cc.long : null;
  let driftTotal = "";
  if (chromaTotal !== null && chromaTotal !== md.total) driftTotal += "⚠ chroma ";
  if (nc.memory !== null && nc.memory !== md.total) driftTotal += "⚠ neo4j";
  console.log(
    `${pad("total", 10)}${pad(String(md.total), 12)}${pad(fmt(chromaTotal), 12)}${pad(fmt(nc.memory), 12)}${driftTotal}`
  );

  console.log("");
  console.log("graph (neo4j only)");
  console.log("-".repeat(48));
  console.log(`  Workflow nodes: ${fmt(nc.workflow)}`);
  console.log(`  Step nodes:     ${fmt(nc.step)}`);

  if (cc.err) console.log(`\nchroma error: ${cc.err}`);
  if (nc.err) console.log(`\nneo4j error: ${nc.err}`);

  // --- exit status ---------------------------------------------------------
  const drift =
    (cc.short !== null && cc.short !== md.short) ||
    (cc.long !== null && cc.long !== md.long) ||
    (nc.memory !== null && nc.memory !== md.total) ||
    cc.err ||
    nc.err;

  console.log("");
  if (drift) {
    console.log("Drift detected. Run: npx tsx scripts/rebuild-indexes.ts");
    process.exitCode = 2;
  } else {
    console.log("All layers consistent.");
  }
}

main().catch((e) => {
  console.error("[check-stats] fatal:", e);
  process.exit(1);
});
