// lib/stats.ts
//
// Aggregates Mnemosyne runtime metrics for the HUD panel.
//
// Two sources are blended:
//   1. Live counters from EncoderPiece + RetrieverPiece (session-scoped,
//      reset on JARVIS boot). Cheap — just object reads.
//   2. Skip-reason buckets from `~/.jarvis/mnemosyne/skip-buckets.json`,
//      maintained by an hourly Haiku cron (see roles/mnemosyne-skip-classifier).
//      The cron reads extraction.log, classifies unique skip_reason strings
//      into canonical buckets (casual / no-signal / error / timeout / other),
//      and writes the mapping to disk. The HUD just looks up.
//
// Why not read extraction.log directly here? Two reasons:
//   - The log appends forever; a 30s poll re-parsing 10k+ lines per tick is
//     wasteful. The Haiku cron amortises classification once per hour.
//   - The HUD asked for "since boot" stats, not all-time — so the live
//     counters are authoritative for the displayed numbers anyway. The
//     bucket map is purely for label aggregation of recently-observed skips.

import { promises as fs } from "fs";
import { join } from "path";

export interface SkipBucketMap {
  // Maps each raw skip_reason observed in the log to a canonical bucket.
  // Unknown strings fall back to "other" at lookup time.
  [rawReason: string]: string;
}

const CANONICAL_BUCKETS = [
  "casual",       // small talk, off-topic chitchat
  "no-signal",    // turn analysed but produced no extractable info
  "error",        // exception during extraction
  "timeout",      // LLM call exceeded budget
  "other",        // fallback for unclassified reasons
] as const;

export type Bucket = (typeof CANONICAL_BUCKETS)[number];

export interface MnemosyneStats {
  // Encoder counters (live, session-scoped)
  encoder: {
    turnsProcessed: number;
    turnsSkipped: number;
    turnsErrored: number;
    candidatesEmitted: number;
    memoriesWritten: number;
    memoriesDeduped: number;
    costUsd: number;
    queueDepth: number;
    processing: boolean;
    categoriesCount: Record<string, number>;
  };
  // Retriever counters (live, session-scoped)
  retriever: {
    retrievals: number;
    retrievalsWithHits: number;
    cacheHits: number;
    hitsTotal: number;
    avgHits: number;
    reinforcements: number;
    injections: number;
    injectionsWithBlock: number;
    sessionsTracked: number;
  };
  // Skip-reason buckets — counts the live encoder's session skips against
  // the Haiku-maintained bucket map. This is computed from the log because
  // the encoder doesn't track which raw reason mapped to which bucket; the
  // log is the only place that has the raw strings.
  skipBuckets: Record<Bucket, number>;
  // Total memories in the canonical store (markdown). Reflects the disk,
  // not the encoder counters — useful as the "library size" gauge.
  totalMemories: number;
  // Last time skip buckets were refreshed by the Haiku cron, ISO 8601.
  // null when the file doesn't exist yet (first install).
  bucketMapUpdatedAt: string | null;
}

interface BucketFile {
  updated_at: string;
  buckets: SkipBucketMap;
}

/** Lazily-cached bucket map. Refreshed when the file mtime changes —
 *  cheaper than re-parsing JSON on every poll while still picking up the
 *  hourly cron's writes within one HUD tick. */
let bucketCache: { mtimeMs: number; data: BucketFile } | null = null;

async function loadBucketMap(rootDir: string): Promise<BucketFile | null> {
  const path = join(rootDir, "skip-buckets.json");
  try {
    const stat = await fs.stat(path);
    if (bucketCache && bucketCache.mtimeMs === stat.mtimeMs) {
      return bucketCache.data;
    }
    const raw = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as BucketFile;
    bucketCache = { mtimeMs: stat.mtimeMs, data: parsed };
    return parsed;
  } catch {
    // File doesn't exist yet (first install / cron hasn't run). The HUD
    // will show all skips under "other" until the cron writes.
    return null;
  }
}

/** Tail-read extraction.log to count skip reasons in the last N entries.
 *  We only need the live skips (since boot would be ideal but the encoder
 *  doesn't keep per-skip detail). N=200 is a compromise: enough to show a
 *  recent distribution, small enough to be ~50KB and parse in <5ms. */
async function tailRecentSkipReasons(
  rootDir: string,
  limit = 200
): Promise<string[]> {
  const path = join(rootDir, "extraction.log");
  try {
    const raw = await fs.readFile(path, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const recent = lines.slice(-limit);
    const reasons: string[] = [];
    for (const line of recent) {
      try {
        const entry = JSON.parse(line);
        if (entry.skip_reason) reasons.push(String(entry.skip_reason));
      } catch {
        // skip malformed line
      }
    }
    return reasons;
  } catch {
    return [];
  }
}

/** Classify a raw skip_reason into a canonical bucket.
 *  Falls back to "other" if no mapping exists yet. The Haiku cron's
 *  classification is authoritative; the static fallbacks below catch
 *  obvious cases the cron hasn't seen yet (so the first hour after boot
 *  isn't entirely "other"). */
function classify(reason: string, map: SkipBucketMap | null): Bucket {
  if (map && map[reason]) {
    const v = map[reason];
    if ((CANONICAL_BUCKETS as readonly string[]).includes(v)) return v as Bucket;
  }
  // Static fallback heuristics — keep tight, the cron does the real work.
  const r = reason.toLowerCase();
  if (r.startsWith("error:") || r.includes("exception")) return "error";
  if (r.includes("timeout") || r.includes("timed out")) return "timeout";
  if (r.includes("casual") || r.includes("chitchat") || r.includes("small talk")) return "casual";
  if (r.includes("no extractable") || r.includes("no signal") || r.includes("trivial")) return "no-signal";
  return "other";
}

export interface BuildStatsArgs {
  rootDir: string;            // ~/.jarvis/mnemosyne
  encoderStats: MnemosyneStats["encoder"];
  retrieverStats: MnemosyneStats["retriever"];
  totalMemories: number;
}

export async function buildStats(args: BuildStatsArgs): Promise<MnemosyneStats> {
  const [bucketFile, recentSkips] = await Promise.all([
    loadBucketMap(args.rootDir),
    tailRecentSkipReasons(args.rootDir),
  ]);

  const buckets: Record<Bucket, number> = {
    casual: 0,
    "no-signal": 0,
    error: 0,
    timeout: 0,
    other: 0,
  };
  for (const reason of recentSkips) {
    const bucket = classify(reason, bucketFile?.buckets ?? null);
    buckets[bucket]++;
  }

  return {
    encoder: args.encoderStats,
    retriever: args.retrieverStats,
    skipBuckets: buckets,
    totalMemories: args.totalMemories,
    bucketMapUpdatedAt: bucketFile?.updated_at ?? null,
  };
}
