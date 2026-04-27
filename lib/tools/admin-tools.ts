import type { CapabilityDefinition } from "@jarvis/core";
import type { MnemosyneStore } from "../store.js";
import type { ConsolidatorPiece } from "../../pieces/consolidator.js";
import type { Category } from "../types.js";

const ALL_CATEGORIES: Category[] = [
  "code-pattern",
  "preference",
  "architecture-decision",
  "mental-model",
  "glossary",
  "anti-pattern",
  "workflow",
];

/**
 * Tracks the most recent successful consolidator run launched via the
 * `mnemosyne_consolidate` tool. Lives in this module so multiple tool
 * invocations (consolidate + stats) share the same view.
 *
 * Note: this is best-effort and does NOT include cron-driven runs. For a
 * fully durable timestamp, the consolidator would need to persist its own
 * run history; a v1.1 enhancement.
 */
let lastConsolidatorRunIso: string | null = null;

export function buildMnemosyneConsolidateTool(
  consolidator: ConsolidatorPiece
): CapabilityDefinition {
  return {
    name: "mnemosyne_consolidate",
    description:
      "Manually trigger the consolidator pipeline (dedup, promote short→long, detect conflicts, decay). Skips by default if user was active recently — pass { force: true } to override.",
    input_schema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          default: false,
          description:
            "If true, bypass the active-recently guard (sets last activity to 0).",
        },
      },
    },
    handler: async (raw) => {
      const args = (raw as { force?: boolean }) ?? {};
      if (args.force) {
        consolidator.setLastActivityTs(0);
      }
      const stats = await consolidator.run();
      lastConsolidatorRunIso = new Date().toISOString();
      return {
        ...stats,
        ran_at: lastConsolidatorRunIso,
      };
    },
  };
}

export function buildMnemosyneStatsTool(
  store: MnemosyneStore
): CapabilityDefinition {
  return {
    name: "mnemosyne_stats",
    description:
      "Counters across the memory store: total, short vs long, by_category, last_consolidator_run.",
    input_schema: { type: "object", properties: {} },
    handler: async () => {
      const all = await store.markdownStore.list({});
      const by_category: Record<string, number> = {};
      for (const cat of ALL_CATEGORIES) by_category[cat] = 0;
      for (const m of all) {
        by_category[m.category] = (by_category[m.category] ?? 0) + 1;
      }
      return {
        total: all.length,
        short: all.filter((m) => !m.promoted_at).length,
        long: all.filter((m) => m.promoted_at).length,
        pinned: all.filter((m) => m.pinned).length,
        by_category,
        last_consolidator_run: lastConsolidatorRunIso,
      };
    },
  };
}

/** Test hook — reset the in-memory last-run timestamp between tests. */
export function __resetLastConsolidatorRun(): void {
  lastConsolidatorRunIso = null;
}
