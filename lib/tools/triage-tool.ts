import type { CapabilityDefinition } from "@jarvis/core";
import type { EncoderPiece } from "../../pieces/encoder.js";
import type { TurnContext } from "../types.js";

/**
 * mnemosyne_triage — send an arbitrary prompt through the full Mnemosyne
 * extraction pipeline (triage → classify → gate → store).
 *
 * Use when you want to force-encode a specific insight, decision, or piece
 * of knowledge that might have been missed in normal conversation flow.
 */
export function buildMnemosyneTriageTool(encoder: EncoderPiece): CapabilityDefinition {
  return {
    name: "mnemosyne_triage",
    description:
      "Force-encode a prompt directly into Mnemosyne long-term memory. " +
      "Bypasses triage/classify/gate entirely — no LLM inference, no skip risk. " +
      "Content is written with confidence=1.0 and immediately reinforced if a " +
      "near-duplicate already exists. Use when you have already decided that " +
      "something is worth remembering — insights, decisions, preferences, domain knowledge. " +
      "Returns immediately; write runs async in the encoder queue.",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "The text to triage. Write it as if it were the user's message " +
            "in a conversation — clear, specific, in the language you want the " +
            "memory stored in. Include context so the extractor can classify correctly.",
        },
        assistant_response: {
          type: "string",
          description:
            "Optional assistant-side context for this synthetic turn. " +
            "Leave empty if the content is self-contained.",
        },
        session_id: {
          type: "string",
          description:
            "Session to attribute this triage to. Defaults to 'manual-triage'.",
        },
      },
      required: ["prompt"],
    },
    handler: async (args: Record<string, unknown>, meta?: { sessionId?: string }) => {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) {
        return { ok: false, error: "prompt is required and must be a non-empty string" };
      }

      const assistantResponse =
        typeof args.assistant_response === "string" ? args.assistant_response : "";
      const sessionId =
        typeof args.session_id === "string" && args.session_id
          ? args.session_id
          : meta?.sessionId ?? "manual-triage";

      const turn: TurnContext = {
        session_id: sessionId,
        user_message: prompt,
        assistant_response: assistantResponse,
        tool_calls: [],
        timestamp: Date.now(),
        // Bypass triage/classify/gate — the caller has already decided this
        // content is worth storing. Write directly with confidence=1.0.
        force_store: {
          content: prompt,
          // Let the encoder derive the title from the first 80 chars
        },
      };

      encoder.enqueue(turn);

      return {
        ok: true,
        message: "Enqueued for direct write. Bypasses triage/classify/gate — will be stored with confidence=1.0.",
        session_id: sessionId,
        preview: {
          user_message: prompt.slice(0, 120) + (prompt.length > 120 ? "…" : ""),
          assistant_response: assistantResponse.slice(0, 80) + (assistantResponse.length > 80 ? "…" : ""),
        },
      };
    },
  };
}
