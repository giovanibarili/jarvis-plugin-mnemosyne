import type { Piece, EventBus, BusMessage } from "@jarvis/core";
import type { TurnContext } from "../lib/types";

/**
 * Per-session buffer accumulating one conversation turn (user msg, assistant
 * stream chunks, and tool calls). A turn is closed when the next user message
 * arrives on `ai.request` or when the piece stops.
 */
export interface TurnBuffer {
  session_id: string;
  user_message: string;
  assistant_chunks: string[];
  tool_calls: Array<{ tool: string; args: any; result: any }>;
  open: boolean;
}

/**
 * ObserverPiece — translates JARVIS bus events into TurnContext callbacks.
 *
 * Subscribes to `ai.request` (turn boundary / start) and `ai.stream` (assistant
 * text and tool_done events). Maintains one buffer per session so concurrent
 * sessions don't bleed into each other. The encoder is wired by passing its
 * `enqueue` method as `onTurnComplete`.
 *
 * Note: the bus types in @jarvis/core for ai.* messages do not currently expose
 * the convenience fields used here (`sessionId`, `type`, `tool`, `args`,
 * `result`). The observer accepts whichever shape the caller publishes — tests
 * publish these fields directly. In real wiring the producer side normalises
 * them. We cast to `any` at the access points to keep this contract explicit.
 */
export class ObserverPiece implements Piece {
  id = "mnemosyne-observer";
  name = "Mnemosyne Observer";
  private buffers = new Map<string, TurnBuffer>();

  constructor(private onTurnComplete: (turn: TurnContext) => void) {}

  async start(bus: EventBus): Promise<void> {
    bus.subscribe("ai.request", (msg: BusMessage) => {
      const sid = (msg as any).sessionId ?? msg.target ?? "main";
      // close prior turn (a new user message ends the previous turn)
      const prior = this.buffers.get(sid);
      if (prior?.open && prior.user_message) {
        this.flush(prior);
      }
      this.buffers.set(sid, {
        session_id: sid,
        user_message: (msg as any).text ?? "",
        assistant_chunks: [],
        tool_calls: [],
        open: true,
      });
    });

    bus.subscribe("ai.stream", (msg: BusMessage) => {
      const sid = (msg as any).sessionId ?? msg.target ?? "main";
      const buf = this.buffers.get(sid);
      if (!buf?.open) return;

      const m = msg as any;
      if (m.type === "text") {
        buf.assistant_chunks.push(m.text ?? "");
      } else if (m.type === "tool_done") {
        buf.tool_calls.push({
          tool: m.tool ?? "unknown",
          args: m.args ?? {},
          result: m.result ?? null,
        });
      }
    });
  }

  async stop(): Promise<void> {
    for (const buf of this.buffers.values()) {
      if (buf.open && buf.user_message) this.flush(buf);
    }
    this.buffers.clear();
  }

  private flush(buf: TurnBuffer): void {
    buf.open = false;
    this.onTurnComplete({
      session_id: buf.session_id,
      user_message: buf.user_message,
      assistant_response: buf.assistant_chunks.join(""),
      tool_calls: buf.tool_calls,
      timestamp: Date.now(),
    });
  }
}
