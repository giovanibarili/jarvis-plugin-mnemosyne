import type { Piece, EventBus } from "@jarvis/core";
import type { MnemosyneStore } from "../lib/store";
import type { ConflictDetector } from "../lib/conflict-detector";
import type { Logger } from "../lib/logger";
import { shouldDecay, type DecayConfig } from "../lib/decay";

export interface ConsolidatorConfig {
  /** Cron expression — registered in pieces/index.ts (Task 12), not here */
  cron: string;
  /** Skip the run if the user was active within the last N minutes */
  skipIfActiveWithinMinutes: number;
  /** Promote a short-term memory once it has been reinforced this many times */
  promotionReinforcementsThreshold: number;
  /** Promote a short-term memory whose confidence reaches this floor */
  promotionConfidenceThreshold: number;
  /** Cosine similarity above which two short memories are considered duplicates */
  mergeSimilarityThreshold: number;
  decay: DecayConfig;
}

export interface ConsolidationStats {
  promoted: number;
  decayed: number;
  conflicts: number;
  merged: number;
}

/**
 * Consolidator (D12) — runs nightly (3am) to:
 *   1. Dedup short-term memories (semantic merge: increment older, delete newer)
 *   2. Promote short → long when reinforced or high-confidence
 *   3. Detect conflicts between newly-promoted memories and existing long-term
 *   4. Decay short-term memories whose forgetScore exceeds the threshold
 *
 * Subscribes to ai.request / ai.stream solely to track the last-activity
 * timestamp; the consolidator skips its run if the user was active recently
 * (avoids interrupting interactive sessions). Cron registration lives in
 * pieces/index.ts (Task 12).
 */
export class ConsolidatorPiece implements Piece {
  readonly id = "mnemosyne-consolidator";
  readonly name = "Mnemosyne Consolidator";
  private bus?: EventBus;
  private unsubs: Array<() => void> = [];
  private lastActivityTs = Date.now();

  constructor(
    private store: MnemosyneStore,
    private conflictDetector: ConflictDetector,
    private logger: Logger,
    private config: ConsolidatorConfig
  ) {}

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;
    this.unsubs.push(
      bus.subscribe("ai.request", () => {
        this.lastActivityTs = Date.now();
      })
    );
    this.unsubs.push(
      bus.subscribe("ai.stream", () => {
        this.lastActivityTs = Date.now();
      })
    );
  }

  async stop(): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  /** Public entrypoint — invoked by cron or by the memory_consolidate tool. */
  async run(): Promise<ConsolidationStats> {
    const sinceActivityMin = (Date.now() - this.lastActivityTs) / 60000;
    if (sinceActivityMin < this.config.skipIfActiveWithinMinutes) {
      await this.logger.logConsolidation({
        outcome: "skipped",
        reason: "active_recent",
        since_activity_min: sinceActivityMin,
      });
      return { promoted: 0, decayed: 0, conflicts: 0, merged: 0 };
    }

    const startSnapshot = await this.snapshot();

    // 1. Dedup short-term (must run first so promotion sees the merged counts)
    const merged = await this.dedupShort();

    // 2. Promotion (short → long)
    const promoted = await this.promote();

    // 3. Conflict detection (only over freshly-promoted memories)
    const conflicts = await this.detectConflicts(promoted);

    // 4. Decay (operates on remaining short-term)
    const decayed = await this.runDecay();

    const endSnapshot = await this.snapshot();
    const stats: ConsolidationStats = {
      promoted: promoted.length,
      decayed,
      conflicts,
      merged,
    };
    await this.logger.logConsolidation({
      outcome: "complete",
      start: startSnapshot,
      end: endSnapshot,
      stats,
    });

    return stats;
  }

  /** Test/inspection hook — pretend the user has been idle for `min` minutes. */
  setLastActivityTs(ts: number): void {
    this.lastActivityTs = ts;
  }

  private async snapshot(): Promise<{ short: number; long: number }> {
    return {
      short: await this.store.chroma.count("short"),
      long: await this.store.chroma.count("long"),
    };
  }

  private async dedupShort(): Promise<number> {
    const short = await this.store.markdownStore.list({ layer: "short" });
    let merged = 0;
    // Track ids already deleted in this pass so we don't visit them again.
    const deleted = new Set<string>();
    for (const mem of short) {
      if (deleted.has(mem.id)) continue;
      const hits = await this.store.chroma.query("short", mem.content, 5);
      const dup = hits.find(
        (h) =>
          h.id !== mem.id &&
          !deleted.has(h.id) &&
          1 - h.distance > this.config.mergeSimilarityThreshold
      );
      if (!dup) continue;

      const dupMem = await this.store.markdownStore.read(dup.id);
      if (!dupMem) continue;

      // Reinforce the older memory (lower created_at); drop the newer.
      // Tie-breaker: when timestamps match, keep the one whose id is
      // lexicographically smaller — deterministic and avoids both being
      // treated as "the newer" in adversarial orderings.
      const dupIsOlder =
        dupMem.created_at < mem.created_at ||
        (dupMem.created_at === mem.created_at && dupMem.id < mem.id);
      if (dupIsOlder) {
        await this.store.neo4j.incrementReinforcements(dupMem.id);
        await this.store.delete(mem.id);
        deleted.add(mem.id);
      } else {
        await this.store.neo4j.incrementReinforcements(mem.id);
        await this.store.delete(dupMem.id);
        deleted.add(dupMem.id);
      }
      merged++;
    }
    return merged;
  }

  private async promote(): Promise<string[]> {
    const short = await this.store.markdownStore.list({ layer: "short" });
    const ids: string[] = [];
    for (const mem of short) {
      const fresh = await this.store.neo4j.getMemory(mem.id);
      if (!fresh) continue;
      const reinforcedEnough =
        fresh.reinforcements >= this.config.promotionReinforcementsThreshold;
      const confidentEnough =
        fresh.confidence >= this.config.promotionConfidenceThreshold;
      if (reinforcedEnough || confidentEnough) {
        await this.store.promote(mem.id);
        ids.push(mem.id);
      }
    }
    return ids;
  }

  private async detectConflicts(promotedIds: string[]): Promise<number> {
    let count = 0;
    for (const id of promotedIds) {
      const mem = await this.store.neo4j.getMemory(id);
      if (!mem) continue;
      const result = await this.conflictDetector.detectAndPersist(mem);
      count += result.contradicts.length;
    }
    return count;
  }

  private async runDecay(): Promise<number> {
    const short = await this.store.markdownStore.list({ layer: "short" });
    const now = Date.now();
    let decayed = 0;
    for (const mem of short) {
      if (shouldDecay(mem, this.config.decay, now)) {
        await this.store.delete(mem.id);
        await this.logger.logConsolidation({
          event: "decay",
          id: mem.id,
          title: mem.title,
          last_accessed: mem.last_accessed,
          age_days: (now - mem.last_accessed) / (1000 * 60 * 60 * 24),
        });
        decayed++;
      }
    }
    return decayed;
  }
}
