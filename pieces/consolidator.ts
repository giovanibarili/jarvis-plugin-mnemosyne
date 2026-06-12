import type { Piece, EventBus } from "@jarvis/core";
import type { MnemosyneStore } from "../lib/store";
import type { ConflictDetector } from "../lib/conflict-detector";
import type { Logger } from "../lib/logger";
import type { LLMClient } from "../lib/extractor";
import { shouldDecay, type DecayConfig } from "../lib/decay";
import { PendingCategoriesStore } from "../lib/v12/pending-categories-store";
import { CategoryCatalog } from "../lib/v12/category-catalog";
import { CategoryMergeJudge } from "../lib/v12/category-merge-judge";
import { promises as fsPromises } from "fs";
import { join } from "path";

/** v1.2 TRIPLET pipeline knobs (opt-in). When absent, the consolidator
 * behaves exactly like v1.1: no pending-categories GC, no merge pass. */
export interface ConsolidatorPipelineConfig {
  v12_enabled: boolean;
  /** Path to the pending-categories JSON store. */
  pendingCategoriesPath: string;
  /** Directory containing seed extractor prompts (extract-<id>.md). */
  seedDir: string;
  /** Directory containing dynamic category files (<id>.md). */
  dynamicDir: string;
  /** Path to the category-merge-judge prompt template. */
  mergePromptPath: string;
  /** LLM client used by the merge judge. */
  llm: LLMClient;
  /** Model to use for the merge judge (default: haiku). */
  mergeModel?: string;
  /** GC parameters for pending categories. */
  pendingGc?: { maxAgeDays: number; minOccurrencesToKeep: number };
}

/** F2: Workflow → SKILL.md promotion knobs. */
export interface SkillPromotionConfig {
  /** Master switch — must be true for any promotion to happen. */
  enabled: boolean;
  /**
   * A workflow memory must have at least this many reinforcements to be
   * promoted. Default: 2. Keeps noisy or single-use workflows out of skills.
   */
  minReinforcements: number;
  /**
   * Root directory where SKILL.md files are written.
   * Defaults to $HOME/.jarvis/skills if omitted.
   */
  skillsDir?: string;
}

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
  /** Optional v1.2 TRIPLET pipeline configuration. Disabled when omitted. */
  pipeline?: ConsolidatorPipelineConfig;
  /** Optional workflow→skill promotion configuration. Disabled when omitted. */
  skillPromotion?: SkillPromotionConfig;
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
  /** Last run stats exposed to the HUD panel. */
  _lastRunStats: { promoted: number; decayed: number; conflicts: number; merged: number; skillsPromoted: number; ranAt: number } | null = null;

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

    // 5. v1.2 TRIPLET — pending-categories GC + dynamic category merge pass
    //    (log-only). Gated so vNext can be rolled out without disturbing v1.1
    //    consolidation. Failures here are swallowed and logged — they MUST NOT
    //    poison the core consolidation stats.
    if (this.config.pipeline?.v12_enabled) {
      try {
        await this.runV12Pipeline();
      } catch (e) {
        await this.logger.logConsolidation({
          event: "v12_pipeline_error",
          error: String(e),
        });
      }
    }

    // 6. F1: Domain merge pass — checks pending categories against the
    //    materialized catalog for near-duplicates. Log-only; swallowed on error
    //    so it never poisons core stats. Only runs when v12 pipeline is wired
    //    (requires pendingCategoriesPath + llm from the same config block).
    if (this.config.pipeline?.v12_enabled) {
      try {
        await this.runDomainMergePass();
      } catch (e) {
        await this.logger.logConsolidation({
          event: "domain_merge_pass_error",
          error: String(e),
        });
      }
    }

    // 7. F2: Workflow → SKILL.md promotion. Swallowed on error — skill files
    //    are best-effort and must not affect core consolidation.
    if (this.config.skillPromotion?.enabled) {
      try {
        await this.runWorkflowSkillPromotion(
          this.config.skillPromotion.minReinforcements ?? 2,
          this.config.skillPromotion.skillsDir,
        );
      } catch (e) {
        await this.logger.logConsolidation({
          event: "skill_promotion_error",
          error: String(e),
        });
      }
    }

    const endSnapshot = await this.snapshot();
    const stats: ConsolidationStats = {
      promoted: promoted.length,
      decayed,
      conflicts,
      merged,
    };
    // Persist for HUD display
    this._lastRunStats = { ...stats, skillsPromoted: 0, ranAt: Date.now() };
    await this.logger.logConsolidation({
      outcome: "complete",
      start: startSnapshot,
      end: endSnapshot,
      stats,
    });

    return stats;
  }

  /** v1.2 TRIPLET pipeline: pending-categories GC and dynamic-category merge
   * detection. Merge detection is currently log-only — actual memory migration
   * lands in a follow-up task. */
  private async runV12Pipeline(): Promise<void> {
    const pipe = this.config.pipeline;
    if (!pipe) return;

    // 5a. Pending-categories GC
    const pending = new PendingCategoriesStore(pipe.pendingCategoriesPath);
    await pending.load();
    const gcOpts = pipe.pendingGc ?? { maxAgeDays: 30, minOccurrencesToKeep: 2 };
    const purged = pending.gc(gcOpts);
    await pending.save();
    if (purged.length > 0) {
      await this.logger.logConsolidation({
        event: "v12_pending_gc",
        purged,
        count: purged.length,
      });
    }

    // 5b. Dynamic-category merge detection (log-only)
    const catalog = new CategoryCatalog(pipe.seedDir, pipe.dynamicDir);
    await catalog.load();
    const dynamic = catalog.list().filter((c) => c.source === "dynamic");
    if (dynamic.length < 2) return;

    const judge = new CategoryMergeJudge(
      pipe.llm,
      pipe.mergePromptPath,
      pipe.mergeModel ?? "haiku",
    );

    for (let i = 0; i < dynamic.length; i++) {
      for (let j = i + 1; j < dynamic.length; j++) {
        const a = dynamic[i];
        const b = dynamic[j];
        const verdict = await judge.judge(
          {
            id: a.id,
            description: a.description,
            hint: a.hint,
            examples: a.examples ?? [],
          },
          {
            id: b.id,
            description: b.description,
            hint: b.hint,
            examples: b.examples ?? [],
          },
        );
        if (verdict.should_merge) {
          await this.logger.logConsolidation({
            event: "v12_merge_proposed",
            a: a.id,
            b: b.id,
            winner: verdict.winner,
            loser: verdict.loser,
            reason: verdict.reason,
          });
        }
      }
    }
  }

  /**
   * F1: Domain merge pass.
   *
   * The TRIPLET pipeline lets Haiku propose new categories freely; they land in
   * PendingCategoriesStore. Over time the store accumulates near-duplicates
   * (e.g. "saa" vs "simple-account-authorizer"). This pass cross-checks every
   * pending entry against the materialized catalog and logs merge proposals via
   * CategoryMergeJudge — the same judge used for dynamic↔dynamic merges in
   * runV12Pipeline (5b). No mutations happen here; log-only, same as 5b today.
   *
   * Runs only when the v12 pipeline is configured (needs llm + paths).
   */
  private async runDomainMergePass(): Promise<void> {
    const pipe = this.config.pipeline;
    if (!pipe) return;

    // Load pending store (fresh copy — not reusing the one from GC so we don't
    // clobber in-memory state from a parallel pass).
    const pendingStore = new PendingCategoriesStore(pipe.pendingCategoriesPath);
    await pendingStore.load();
    const pendingEntries = pendingStore.list();
    if (pendingEntries.length === 0) return;

    // Load the materialized catalog (seed + dynamic) to compare against.
    const catalog = new CategoryCatalog(pipe.seedDir, pipe.dynamicDir);
    await catalog.load();
    const catalogEntries = catalog.list();
    if (catalogEntries.length === 0) return;

    const judge = new CategoryMergeJudge(
      pipe.llm,
      pipe.mergePromptPath,
      pipe.mergeModel ?? "haiku",
    );

    // For each pending category, check it against every catalog entry.
    // O(pending × catalog) — both sets are small in practice (< 50 each).
    for (const pending of pendingEntries) {
      for (const catalogEntry of catalogEntries) {
        let verdict;
        try {
          verdict = await judge.judge(
            {
              id: pending.slug,
              description: pending.description,
              hint: pending.hint,
              examples: [],
            },
            {
              id: catalogEntry.id,
              description: catalogEntry.description,
              hint: catalogEntry.hint,
              examples: catalogEntry.examples ?? [],
            },
          );
        } catch (e) {
          // Per-pair LLM hiccup — log and continue to next pair.
          await this.logger.logConsolidation({
            event: "domain_merge_pass_pair_error",
            pending: pending.slug,
            catalog: catalogEntry.id,
            error: String(e),
          });
          continue;
        }

        if (verdict.should_merge) {
          await this.logger.logConsolidation({
            event: "domain_merge_proposed",
            pending: pending.slug,
            catalog: catalogEntry.id,
            winner: verdict.winner,
            loser: verdict.loser,
            reason: verdict.reason,
          });
        }
      }
    }
  }

  /**
   * F2: Workflow → SKILL.md promotion.
   *
   * Memories with category="workflow" that have accumulated sufficient
   * reinforcements are promoted to SKILL.md files on disk. The skill system
   * (`jarvis-plugin-skills`) picks them up from ~/.jarvis/skills/ on its next
   * scan, making the workflow invocable via `/skill-name`.
   *
   * Idempotent: if the SKILL.md already exists it is skipped — re-running the
   * consolidator will never overwrite a skill the user may have hand-edited.
   *
   * Why workflow memories only: category="workflow" is the canonical signal
   * that a memory encodes a multi-step procedure worth externalizing as a
   * reusable skill. Other high-reinforcement memories (preferences, mental
   * models, etc.) are better kept inside Mnemosyne.
   */
  private async runWorkflowSkillPromotion(
    minReinforcements: number,
    skillsDir?: string,
  ): Promise<void> {
    const root =
      skillsDir ??
      join(process.env.HOME ?? "/tmp", ".jarvis", "skills");

    // List workflow memories across both layers (short + long).
    // Workflows may already be promoted to long-term by the promote() pass.
    const allWorkflows = await this.store.markdownStore.list({
      category: "workflow",
    });

    let promoted = 0;
    for (const wf of allWorkflows) {
      // Prefer the live reinforcements counter from Neo4j when available.
      let reinforcements = wf.reinforcements;
      if (!this.store.isGraphDegraded()) {
        try {
          const fresh = await this.store.neo4j.getMemory(wf.id);
          if (fresh) reinforcements = fresh.reinforcements;
        } catch {
          // Graph hiccup — fall through to markdown value.
        }
      }

      if (reinforcements < minReinforcements) continue;

      // Derive a filesystem-safe slug from the title (max 40 chars to avoid
      // overly long directory names on case-insensitive filesystems).
      const slug = wf.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);

      // Use the first 12 chars of the memory id as a stable prefix so that
      // renames in the title don't collide with existing skill dirs.
      const dirName = `${wf.id.slice(0, 12)}-${slug}`;
      const skillDir = join(root, dirName);
      const skillPath = join(skillDir, "SKILL.md");

      // Idempotency check — skip if already promoted.
      try {
        await fsPromises.access(skillPath);
        continue; // SKILL.md exists — don't overwrite.
      } catch {
        // File doesn't exist — proceed to create.
      }

      await fsPromises.mkdir(skillDir, { recursive: true });

      const evidenceSection = wf.evidence
        ? `\n\n## Evidence\n\n${wf.evidence}`
        : "";

      const content =
        `---\n` +
        `name: ${slug}\n` +
        `description: ${wf.title}\n` +
        `promoted_from_memory: ${wf.id}\n` +
        `promoted_at: ${new Date().toISOString()}\n` +
        `---\n\n` +
        `${wf.content}` +
        `${evidenceSection}\n`;

      await fsPromises.writeFile(skillPath, content, "utf-8");
      promoted++;

      await this.logger.logConsolidation({
        event: "workflow_skill_promoted",
        memory_id: wf.id,
        title: wf.title,
        reinforcements,
        skill_path: skillPath,
      });
    }

    if (promoted > 0) {
      await this.logger.logConsolidation({
        event: "workflow_skill_promotion_complete",
        promoted,
      });
    }
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
      // incrementReinforcements is graph-only. Under degradation it's a no-op
      // — the dedup still happens (markdown + chroma stay consistent); only
      // the counter bump on the surviving memory is lost. Acceptable: the
      // graph is rebuildable from markdown.
      if (dupIsOlder) {
        await this.store.incrementReinforcements(dupMem.id);
        await this.store.delete(mem.id);
        deleted.add(mem.id);
      } else {
        await this.store.incrementReinforcements(mem.id);
        await this.store.delete(dupMem.id);
        deleted.add(dupMem.id);
      }
      merged++;
    }
    return merged;
  }

  private async promote(): Promise<string[]> {
    // Promotion criteria live in Neo4j (reinforcements counter). When the
    // graph is degraded, fall back to markdown-only confidence threshold —
    // we can still promote high-confidence memories without the graph.
    const short = await this.store.markdownStore.list({ layer: "short" });
    const ids: string[] = [];
    const degraded = this.store.isGraphDegraded();
    for (const mem of short) {
      let reinforcements = mem.reinforcements;
      let confidence = mem.confidence;
      if (!degraded) {
        try {
          const fresh = await this.store.neo4j.getMemory(mem.id);
          if (fresh) {
            reinforcements = fresh.reinforcements;
            confidence = fresh.confidence;
          }
        } catch {
          // Single-memory hiccup — fall through to markdown values.
        }
      }
      const reinforcedEnough =
        reinforcements >= this.config.promotionReinforcementsThreshold;
      const confidentEnough =
        confidence >= this.config.promotionConfidenceThreshold;
      if (reinforcedEnough || confidentEnough) {
        await this.store.promote(mem.id);
        ids.push(mem.id);
      }
    }
    return ids;
  }

  private async detectConflicts(promotedIds: string[]): Promise<number> {
    // Conflict detection writes CONTRADICTS edges to the graph. No graph,
    // no conflict pass — skip entirely.
    if (this.store.isGraphDegraded()) return 0;
    let count = 0;
    for (const id of promotedIds) {
      try {
        const mem = await this.store.neo4j.getMemory(id);
        if (!mem) continue;
        const result = await this.conflictDetector.detectAndPersist(mem);
        count += result.contradicts.length;
      } catch {
        // Per-memory hiccup — skip just this one.
      }
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
