import type { CapabilityDefinition } from "@jarvis/core";
import type { AttentionState } from "../types";

/**
 * buildSessionAttentionTool — builds the session_attention_update capability.
 *
 * WHY callbacks instead of a direct store reference:
 * Avoids tight coupling between the tool and MnemosyneStore. The wiring in
 * pieces/index.ts (T-11) passes store.getAttentionState.bind(store) and
 * store.setAttentionState.bind(store), keeping the tool testable in isolation
 * with plain stub functions.
 *
 * WHY in-memory only:
 * Attention state is session-scoped and intentionally ephemeral. The reviewer
 * piece re-declares context at the start of each session via a review pass.
 * Persisting it would create stale cross-session leakage.
 */
export function buildSessionAttentionTool(
  getAttentionState: (sessionId: string) => AttentionState | undefined,
  setAttentionState: (sessionId: string, state: AttentionState) => void,
): CapabilityDefinition {
  return {
    name: "session_attention_update",
    description:
      "Declare the active cognitive context for this session after a review pass. " +
      "Sets Tier 1 filter used by the retriever on the next turn. " +
      "Keep focused: 2-4 domains max, only what is genuinely active NOW.",
    input_schema: {
      type: "object",
      properties: {
        active_domains: {
          type: "array",
          items: { type: "string" },
          description: "Slug list of domains central to this session (e.g. ['mnemosyne', 'saa'])",
        },
        active_entities: {
          type: "array",
          items: { type: "string" },
          description: "Slug list of specific named entities being worked on",
        },
        active_categories: {
          type: "array",
          items: { type: "string" },
          description: "Category types most relevant right now",
        },
      },
      required: ["active_domains"],
    },
    handler: async (args: Record<string, unknown>, meta?: { sessionId?: string }) => {
      const sessionId = meta?.sessionId ?? "main";
      const state: AttentionState = {
        active_domains: Array.isArray(args.active_domains) ? (args.active_domains as string[]) : [],
        active_entities: Array.isArray(args.active_entities) ? (args.active_entities as string[]) : [],
        active_categories: Array.isArray(args.active_categories) ? (args.active_categories as string[]) : [],
        updated_at: Date.now(),
      };
      setAttentionState(sessionId, state);
      return { ok: true, sessionId, state };
    },
  };
}
