import type { CapabilityDefinition } from "@jarvis/core";
import type { MnemosyneStore } from "../store.js";
import type { Memory, Category } from "../types.js";
import type { ListFilter, Layer } from "../markdown-store.js";
import type { Reranker } from "../reranker.js";

/**
 * Resolve an id parameter — supports full uuid or unique short prefix
 * (≥4 chars). Returns the matched Memory or null if not found / ambiguous.
 *
 * Short-prefix matching mirrors `git rev-parse --short` semantics — the
 * caller wants a quick way to address a memory without copying the full
 * uuid from the HUD. Ambiguous prefixes resolve to `null` (not error)
 * so callers can fall back to the full id message uniformly.
 */
export async function resolveMemoryId(
  store: MnemosyneStore,
  idOrPrefix: string
): Promise<Memory | null> {
  if (!idOrPrefix) return null;
  // Fast path: full id
  const direct = await store.markdownStore.read(idOrPrefix);
  if (direct) return direct;
  if (idOrPrefix.length < 4) return null;

  // Slow path: scan all memories for prefix matches
  const all = await store.markdownStore.list({});
  const matches = all.filter((m) => m.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  return null;
}

/* -------------------------------------------------------------- shapes ---- */

interface MemorySearchArgs {
  query: string;
  k?: number;
  layer?: "short" | "long" | "both";
  category?: Category;
  project?: string;
}

interface MemoryGetArgs {
  id: string;
}

interface MemoryListArgs {
  category?: Category;
  project?: string;
  layer?: Layer;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

interface MemoryExplainArgs {
  id: string;
  query: string;
}

/* -------------------------------------------------------------- builders -- */

export function buildMemorySearchTool(store: MnemosyneStore, reranker?: Reranker): CapabilityDefinition {
  return {
    name: "memory_search",
    description: [
      "Semantic search across personal memories (Mnemosyne). Returns relevant memories ranked by score.",
      "",
      "## When to call — MANDATORY",
      "ALWAYS call this tool as the FIRST action during thinking/reasoning — before web search,",
      "before assumptions, before answering from training data — whenever:",
      "- You are unsure about the user's preferences, habits, or past decisions",
      "- The user references something they may have mentioned before ('I usually...', 'like I said...', 'my preference is...')",
      "- You need context about the user's stack, tools, coding style, architecture choices",
      "- The user asks something personal or project-specific that you might have seen before",
      "- You are about to suggest a default that may contradict a known preference",
      "- You are starting a new task and want to check for relevant past decisions",
      "- You are in the thinking phase and want to validate an assumption before committing to it",
      "",
      "## During thinking",
      "Use this tool actively during your internal reasoning. The injected preview is a starting point,",
      "not the complete picture. If the injected memories suggest a lead, call memory_search to go deeper.",
      "If you are reasoning about something the user might have said before, search before deciding.",
      "Multiple searches per turn are encouraged — search on different angles (project, pattern, preference).",
      "",
      "This is the primary source of truth about the user. Training data is the last resort.",
      "",
      "## Examples",
      "  memory_search('preferred test framework')  — before suggesting Jest vs Vitest",
      "  memory_search('database choice rationale') — before proposing a DB",
      "  memory_search('code style preferences')    — before writing code",
      "  memory_search('SAA architecture decisions') — before touching a specific service",
      "  memory_search('banana preference')         — if user asks about fruit",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query" },
        k: { type: "number", default: 5, description: "Max number of results (default 5)" },
        layer: {
          type: "string",
          enum: ["short", "long", "both"],
          default: "both",
          description: "Memory layer to search (default both)",
        },
        category: {
          type: "string",
          enum: [
            "code-pattern",
            "preference",
            "architecture-decision",
            "mental-model",
            "glossary",
            "anti-pattern",
            "workflow",
          ],
          description: "Optional category filter",
        },
        project: { type: "string", description: "Optional project filter" },
      },
      required: ["query"],
    },
    handler: async (raw) => {
      const args = raw as unknown as MemorySearchArgs;
      if (!args.query || typeof args.query !== "string") {
        return { error: "query is required and must be a string" };
      }
      const k = args.k ?? 5;
      const layer = args.layer ?? "both";

      const where: Record<string, any> | undefined =
        args.category || args.project
          ? {
              ...(args.category ? { category: args.category } : {}),
              ...(args.project ? { project: args.project } : {}),
            }
          : undefined;

      const layers: Array<"short" | "long"> =
        layer === "both" ? ["short", "long"] : [layer];

      const allHits: Array<{
        id: string;
        distance: number;
        layer: "short" | "long";
      }> = [];
      for (const l of layers) {
        const hits = await store.chroma.query(l, args.query, k, where);
        for (const h of hits) {
          allHits.push({ id: h.id, distance: h.distance, layer: l });
        }
      }

      // Dedup by id (a memory may live in only one layer, but be defensive)
      const seen = new Set<string>();
      const ranked = allHits
        .filter((h) => {
          if (seen.has(h.id)) return false;
          seen.add(h.id);
          return true;
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, k);

      // Hydrate memories and optionally apply reranker for richer scores.
      const hits: Array<{ mem: Memory; vectorSim: number; layer: string }> = [];
      for (const h of ranked) {
        const mem = await store.markdownStore.read(h.id);
        if (!mem) continue;
        hits.push({ mem, vectorSim: 1 - h.distance, layer: h.layer });
      }

      // Apply reranker if available — overwrites score with weighted total
      // and produces a scoreBreakdown. Falls back to vectorSim-only order.
      let reranked = hits;
      let breakdowns: Map<string, { recency: number; confidence: number; reinforcements: number; graphDistance: number; total: number }> | undefined;
      if (reranker && hits.length > 0) {
        const rerankHits = hits.map((h) => ({
          memory: h.mem,
          score: h.vectorSim,
          source: "vector" as const,
          vectorSim: h.vectorSim,
        }));
        const sorted = reranker.rerank(rerankHits);
        breakdowns = new Map(sorted.map((h) => [h.memory.id, h.scoreBreakdown!]));
        reranked = sorted.map((h) => ({ mem: h.memory, vectorSim: h.vectorSim ?? 0, layer: hits.find((x) => x.mem.id === h.memory.id)?.layer ?? "unknown" }));
      }

      const results = reranked.map(({ mem, vectorSim, layer }) => {
        const bd = breakdowns?.get(mem.id);
        return {
          id: mem.id,
          title: mem.title,
          content: mem.content,
          category: mem.category,
          project: mem.project,
          layer,
          // sim = raw vector similarity; score = rerank total (or sim if no reranker)
          sim: parseFloat(vectorSim.toFixed(3)),
          score: bd ? parseFloat(bd.total.toFixed(3)) : parseFloat(vectorSim.toFixed(3)),
          ...(bd ? {
            score_breakdown: {
              recency: parseFloat(bd.recency.toFixed(3)),
              confidence: parseFloat(bd.confidence.toFixed(3)),
              reinforcements: parseFloat(bd.reinforcements.toFixed(3)),
              graph_distance: parseFloat(bd.graphDistance.toFixed(3)),
            },
          } : {}),
          last_accessed: mem.last_accessed,
          confidence: mem.confidence,
          reinforcements: mem.reinforcements,
          pinned: mem.pinned,
        };
      });
      return { results };
    },
  };
}

export function buildMemoryGetTool(store: MnemosyneStore): CapabilityDefinition {
  return {
    name: "memory_get",
    description:
      "Fetch a single memory by full id or unique short-id prefix (>=4 chars). Returns the full Memory object or { error: 'not found' }.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Full uuid or unique short prefix" },
      },
      required: ["id"],
    },
    handler: async (raw) => {
      const args = raw as unknown as MemoryGetArgs;
      if (!args.id) return { error: "id is required" };
      const mem = await resolveMemoryId(store, args.id);
      if (!mem) return { error: "not found" };
      return mem;
    },
  };
}

export function buildMemoryListTool(store: MnemosyneStore): CapabilityDefinition {
  return {
    name: "memory_list",
    description:
      "Paginated list of memories with optional filters (category, project, layer, pinned). Returns { memories, total }.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [
            "code-pattern",
            "preference",
            "architecture-decision",
            "mental-model",
            "glossary",
            "anti-pattern",
            "workflow",
          ],
        },
        project: { type: "string" },
        layer: { type: "string", enum: ["short", "long"] },
        pinned: { type: "boolean" },
        limit: { type: "number", default: 50 },
        offset: { type: "number", default: 0 },
      },
    },
    handler: async (raw) => {
      const args = raw as unknown as MemoryListArgs;
      const filter: ListFilter = {};
      if (args.category) filter.category = args.category;
      if (args.layer) filter.layer = args.layer;
      if (args.pinned !== undefined) filter.pinned = args.pinned;

      let memories = await store.markdownStore.list(filter);
      if (args.project !== undefined) {
        memories = memories.filter((m) => m.project === args.project);
      }
      const total = memories.length;
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      memories = memories.slice(offset, offset + limit);
      return { memories, total };
    },
  };
}

/**
 * Score breakdown helper — recomputes the rerank components for a single
 * memory without going through the Reranker (which only exposes the total).
 *
 * Mirrors lib/reranker.ts formula. If weights diverge (config drift),
 * the breakdown still shows raw signals + their weighted contributions.
 */
export function computeScoreBreakdown(
  memory: Memory,
  weights: {
    confidence: number;
    reinforcements: number;
    graph_distance: number;
  },
  source: "vector" | "graph" | "workflow_lookup" = "vector",
): {
  recency: number;
  confidence: number;
  reinforcements: number;
  graphDistance: number;
  total: number;
} {
  const confidence = memory.confidence;
  const reinforcements = Math.min(memory.reinforcements / 10, 1);
  const graphDistance = source === "graph" ? 0.5 : 1.0;
  const total =
    confidence * weights.confidence +
    reinforcements * weights.reinforcements +
    graphDistance * weights.graph_distance;
  // recency kept as 0 for backward compat with breakdown display shape
  return { recency: 0, confidence, reinforcements, graphDistance, total };
}

export function buildMemoryExplainTool(
  store: MnemosyneStore,
  weights: {
    confidence: number;
    reinforcements: number;
    graph_distance: number;
  }
): CapabilityDefinition {
  return {
    name: "memory_explain",
    description:
      "Show the rerank score breakdown for a memory against a query. Returns { recency, confidence, reinforcements, graphDistance, total } — useful for debugging why a memory ranks high or low.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id (full or short prefix)" },
        query: { type: "string", description: "Query text to score against" },
      },
      required: ["id", "query"],
    },
    handler: async (raw) => {
      const args = raw as unknown as MemoryExplainArgs;
      if (!args.id || !args.query) {
        return { error: "id and query are required" };
      }
      const mem = await resolveMemoryId(store, args.id);
      if (!mem) return { error: "not found" };

      // Probe Chroma for vector distance — purely informational, surfaces in
      // the breakdown so callers can see the raw similarity signal alongside
      // the weighted rerank components.
      let vectorDistance: number | null = null;
      try {
        const layer = mem.promoted_at ? "long" : "short";
        const hits = await store.chroma.query(layer, args.query, 50);
        const hit = hits.find((h) => h.id === mem.id);
        if (hit) vectorDistance = hit.distance;
      } catch {
        // Chroma unreachable — score breakdown still works without it
      }

      const breakdown = computeScoreBreakdown(mem, weights);
      return {
        id: mem.id,
        title: mem.title,
        vector_distance: vectorDistance,
        vector_similarity:
          vectorDistance !== null ? 1 - vectorDistance : null,
        recency: breakdown.recency,
        confidence: breakdown.confidence,
        reinforcements: breakdown.reinforcements,
        graphDistance: breakdown.graphDistance,
        total: breakdown.total,
        weights,
      };
    },
  };
}
