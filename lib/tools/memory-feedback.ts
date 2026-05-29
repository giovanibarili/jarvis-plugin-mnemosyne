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

/**
 * memory_downvote — negative feedback signal.
 * Called when the LLM notices that a retrieved memory is incorrect,
 * outdated, or misleading. Decrements the reinforcements counter
 * (floor 0) and optionally records a reason in the evidence field.
 *
 * Use when:
 * - A memory contradicts verified facts
 * - A memory injected outdated context that led to a wrong assumption
 * - A memory is about a different topic than the current one
 */
export function buildMemoryDownvote(store: MnemosyneStore): CapabilityDefinition {
  return {
    name: "memory_downvote",
    description: [
      "Signal that a retrieved memory was incorrect, outdated, or misleading.",
      "Decrements the memory's reinforcements counter (floor 0), reducing its future retrieval rank.",
      "Optionally records a reason in the evidence field for audit.",
      "",
      "## When to call",
      "- A memory injected context that contradicted a verified fact",
      "- A memory is clearly about a different topic and caused confusion",
      "- A memory is outdated and its content is no longer accurate",
      "",
      "## Do NOT call for",
      "- Memories that are simply not relevant to the current turn (use nothing)",
      "- Memories that are partially correct (use memory_add_evidence instead)",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id (full or 8-char suffix)" },
        reason: {
          type: "string",
          description: "Why this memory was incorrect or misleading. Added to evidence for audit.",
        },
      },
      required: ["id"],
    },
    handler: async (args: { id: string; reason?: string; __sessionId?: string }) => {
      const mem = await resolveMemoryId(store, args.id);
      if (!mem) {
        return { ok: false, error: `Memory not found: ${args.id}` };
      }
      await store.decrementReinforcements(mem.id);
      // Record the downvote reason in evidence for audit trail
      if (args.reason) {
        const existing = mem.evidence ?? "";
        const note = `[DOWNVOTE] ${args.reason}`;
        if (!existing.includes(note)) {
          const updated = { ...mem, evidence: existing ? `${existing}\n${note}` : note };
          await store.write(updated);
        }
      }
      const newReinf = Math.max(0, (mem.reinforcements ?? 0) - 1);
      return {
        ok: true,
        id: mem.id,
        reinforcements: newReinf,
        ...(args.reason ? { reason_recorded: true } : {}),
      };
    },
  };
}
