import type { CapabilityDefinition } from "@jarvis/core";
import type { MnemosyneStore } from "../store.js";
import { resolveMemoryId } from "./memory-search.js";

/**
 * memory_reinforce — explicit feedback tool for the LLM to signal that a
 * retrieved memory was directly useful. Increments the memory's
 * `reinforcements` counter, which boosts future retrieval ranking.
 *
 * Replaces the fragile [mnemo:used:ID] text signal emitted inline in
 * responses. Tool calls are guaranteed to reach the handler; text signals
 * could be placed incorrectly or stripped by renderers.
 *
 * The id accepts the 8-char suffix shown as `id:XXXXXXXX` in the injected
 * memory block (e.g. `fibkbi`), or a full memory UUID.
 */
export function buildMemoryReinforce(
  store: MnemosyneStore
): CapabilityDefinition {
  return {
    name: "memory_reinforce",
    description:
      "Signal that a retrieved memory was directly useful in answering the current query. " +
      "Increments the memory's reinforcement score, boosting its future retrieval rank. " +
      "Use the 8-char suffix shown as `id:XXXXXXXX` at the bottom of the memory entry.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Memory id — the 8-char suffix from `id:XXXXXXXX` in the injected block, or a full UUID.",
        },
      },
      required: ["id"],
    },
    handler: async (args: { id: string; __sessionId?: string }) => {
      const mem = await resolveMemoryId(store, args.id);
      if (!mem) {
        return { ok: false, error: `Memory not found: ${args.id}` };
      }
      await store.incrementReinforcements(mem.id);

      // Return top-10 vector neighbors of the reinforced memory so the LLM
      // can decide whether to fetch any of them for deeper context.
      // Uses the memory's own content as the query — finds semantically related
      // memories without requiring the LLM to rephrase.
      const neighbors: Array<{ id: string; title: string; sim: number; category: string }> = [];
      try {
        const layer = mem.promoted_at ? "long" : "short";
        const hits = await store.chroma.query(layer, mem.content, 11); // 11 = self + 10
        for (const h of hits) {
          if (h.id === mem.id) continue; // skip self
          const neighbor = await store.markdownStore.read(h.id);
          if (!neighbor) continue;
          neighbors.push({
            id: neighbor.id,
            title: neighbor.title,
            sim: parseFloat((1 - h.distance).toFixed(3)),
            category: neighbor.category,
          });
          if (neighbors.length >= 10) break;
        }
      } catch {
        // Chroma unavailable — return reinforcement without neighbors
      }

      return {
        ok: true,
        id: mem.id,
        reinforcements: mem.reinforcements + 1,
        ...(neighbors.length > 0 ? {
          related_memories: neighbors,
          _hint: "Use memory_fetch(id) on any related memory above if it would enrich your answer.",
        } : {}),
      };
    },
  };
}

/**
 * memory_add_evidence — add new evidence or context to an existing memory.
 * Appends the given text to the memory's `evidence` field and rewrites all
 * three storage layers (markdown + Chroma + Neo4j).
 *
 * Use when you discover new information that refines or extends a memory
 * without replacing its core claim.
 *
 * Replaces the fragile [mnemo:update:ID:...] text signal.
 */
export function buildMemoryAddEvidence(
  store: MnemosyneStore
): CapabilityDefinition {
  return {
    name: "memory_add_evidence",
    description:
      "Append new evidence or context to an existing memory's evidence field. " +
      "Use when you discover information that refines or extends a memory without replacing its core claim. " +
      "Use the 8-char suffix shown as `id:XXXXXXXX` at the bottom of the memory entry.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Memory id — the 8-char suffix from `id:XXXXXXXX` in the injected block, or a full UUID.",
        },
        evidence: {
          type: "string",
          description: "New evidence to append. One sentence. Must be new — duplicate text is silently skipped.",
        },
      },
      required: ["id", "evidence"],
    },
    handler: async (args: { id: string; evidence: string; __sessionId?: string }) => {
      const mem = await resolveMemoryId(store, args.id);
      if (!mem) {
        return { ok: false, error: `Memory not found: ${args.id}` };
      }
      const existing = mem.evidence ?? "";
      if (existing.includes(args.evidence)) {
        return { ok: true, id: mem.id, skipped: true, reason: "duplicate evidence" };
      }
      const updated = {
        ...mem,
        evidence: existing ? `${existing}\n${args.evidence}` : args.evidence,
      };
      await store.write(updated);
      return { ok: true, id: mem.id, evidence: updated.evidence };
    },
  };
}
