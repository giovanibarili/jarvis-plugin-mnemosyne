import type { CapabilityDefinition } from "@jarvis/core";
import type { Neo4jAdapter } from "../neo4j-adapter.js";

/**
 * memory_relate — explicit LLM-callable edge creation for the Mnemosyne graph.
 *
 * WHY: Mnemosyne v1 uses an opaque `relate-judge` that runs internally after
 * persist, invisible to the reviewer. This tool gives the reviewer explicit
 * control to create semantic graph edges when a meaningful connection is
 * identified during review or retrieval. Replaces the blind automatic wiring
 * with intentional, reasoned links.
 *
 * Edges created here are marked source='explicit' to distinguish them from
 * automatic relate-judge edges (source='semantic'). The MERGE ensures
 * idempotency — calling with the same (from_id, to_id, relation) tuple only
 * updates reason/created_at, never creates duplicate edges.
 *
 * Relation naming is intentionally free-form (not a rigid enum) — the LLM
 * should name the actual connection. Suggestions are provided in the description
 * to guide naming without constraining it.
 */
export function buildMemoryRelateTool(neo4j: Neo4jAdapter): CapabilityDefinition {
  return {
    name: "memory_relate",
    description:
      "Create an explicit semantic edge between two existing memories. " +
      "Use when you identify a meaningful connection during review. " +
      "relation is a free string — name the actual connection. " +
      "Suggestions: merge | supersede | contradicts | relates_to | " +
      "relates_to_variant | same_as | inherits | instance_of | derived_from | " +
      "shortcut_for | opposes | enables | precondition_of. " +
      "reason MUST quote the specific element — NEVER 'same domain'.",
    input_schema: {
      type: "object",
      properties: {
        from_id: { type: "string", description: "Source memory ID" },
        to_id: { type: "string", description: "Target memory ID" },
        relation: {
          type: "string",
          description: "Relation label (free string, see suggestions in description)",
        },
        reason: {
          type: "string",
          description: "Specific justification quoting the connecting element",
        },
      },
      required: ["from_id", "to_id", "relation", "reason"],
    },
    handler: async (args: Record<string, unknown>) => {
      const from_id = String(args.from_id ?? "").trim();
      const to_id = String(args.to_id ?? "").trim();
      const relation = String(args.relation ?? "").trim();
      const reason = String(args.reason ?? "").trim();
      if (!from_id || !to_id || !relation || !reason) {
        return { ok: false, error: "from_id, to_id, relation, and reason are all required" };
      }
      await neo4j.createExplicitEdge(from_id, to_id, relation, reason);
      return { ok: true, from_id, to_id, relation };
    },
  };
}
