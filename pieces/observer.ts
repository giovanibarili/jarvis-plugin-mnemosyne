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
 * Turn lifecycle:
 *   1. `ai.request`          → opens a new TurnBuffer for the session
 *   2. `ai.stream` (text)    → appends assistant text chunks
 *   3. `ai.stream` (tool_done) → appends tool call records
 *   4. `ai.stream` (complete)  → CLOSES and flushes the turn immediately
 *
 * The flush on `event: "complete"` means the encoder sees the current turn
 * as soon as the assistant finishes responding — not delayed to the next
 * user message. `ai.request` still guards against orphaned open buffers
 * (e.g. if `complete` was missed) but no longer owns the flush path.
 *
 * Maintains one buffer per session so concurrent sessions don't bleed.
 * Ring buffer of `contextWindowSize` prior turns is populated on flush
 * and attached to the next turn as `prior_turns` for contextual extraction.
 *
 * Note: bus types in @jarvis/core for ai.* messages do not expose the
 * convenience fields used here (`sessionId`, `event`, `tool`, etc.).
 * We cast to `any` — tests publish these fields directly.
 */
export class ObserverPiece implements Piece {
  id = "mnemosyne-observer";
  name = "Mnemosyne Observer";
  private buffers = new Map<string, TurnBuffer>();

  /**
   * Ring buffer of completed turns per session — oldest first.
   * Capped at `contextWindowSize` entries. Populated on flush so the
   * *next* turn can reference what came before it.
   */
  private history = new Map<string, Array<{ user_message: string; assistant_response: string }>>();

  constructor(
    private onTurnComplete: (turn: TurnContext) => void,
    private contextWindowSize = 14
  ) {}

  async start(bus: EventBus): Promise<void> {
    bus.subscribe("ai.request", (msg: BusMessage) => {
      const sid = (msg as any).sessionId ?? msg.target ?? "main";
      // Guard: flush any orphaned open buffer (e.g. complete event was missed).
      // Normal path: buffer is already closed by the `complete` handler below.
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
      if (m.event === "complete") {
        // Primary flush path: assistant finished responding for this turn.
        // `complete` is emitted by JarvisCore when the stream ends with no
        // pending tool calls — i.e. the turn is truly done.
        if (buf.user_message) this.flush(buf);
      } else if (m.type === "text" || m.event === "delta") {
        buf.assistant_chunks.push(m.text ?? "");
      } else if (m.type === "tool_done" || m.event === "tool_done") {
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
    const assistant_response = buf.assistant_chunks.join("");

    // Snapshot prior turns before pushing the current one
    const prior_turns = [...(this.history.get(buf.session_id) ?? [])];

    this.onTurnComplete({
      session_id: buf.session_id,
      user_message: buf.user_message,
      assistant_response,
      tool_calls: buf.tool_calls,
      timestamp: Date.now(),
      prior_turns,
    });

    // Push current turn into the history ring buffer (cap at contextWindowSize)
    const hist = this.history.get(buf.session_id) ?? [];
    hist.push({ user_message: buf.user_message, assistant_response });
    if (hist.length > this.contextWindowSize) hist.shift();
    this.history.set(buf.session_id, hist);
  }
}
