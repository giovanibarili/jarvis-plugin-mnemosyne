import { describe, it, expect, vi } from "vitest";
import { EncoderPiece } from "../../pieces/encoder";
import type { TurnContext } from "../../lib/types";

function makeTurn(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    session_id: "s1",
    user_message: "u",
    assistant_response: "a",
    tool_calls: [],
    timestamp: 1700000000000,
    ...overrides,
  };
}

function makeEncoder(overrides: { processResult?: any; sinkWrite?: any } = {}) {
  const sinkWrite =
    overrides.sinkWrite ??
    vi.fn().mockImplementation(async (m: any) => ({ ...m, id: m.id ?? "written-id" }));

  const processResult = overrides.processResult ?? {
    skipped: false,
    memories: [
      {
        id: "m1",
        category: "preference",
        title: "prefer dark mode",
        content: "User prefers dark mode.",
        evidence: "user said so",
        origin_source: "user",
        created_at: new Date().toISOString(),
        session_id: "s1",
        tags: [],
        confidence: 0.9,
      },
    ],
    intraTurnEdges: [],
  };

  const logExtraction = vi.fn().mockResolvedValue(undefined);

  const v12Encoder = {
    // process(turn, sessionId, onStep, skipTriage) — capture all args
    process: vi.fn().mockResolvedValue(processResult),
    opts: { sink: { write: sinkWrite } },
  };

  const piece = new EncoderPiece(
    { write: sinkWrite, list: vi.fn().mockResolvedValue([]) } as any,
    { logExtraction } as any,
    { encoder: v12Encoder as any, relatePiece: undefined }
  );

  return { piece, sinkWrite, logExtraction, v12Process: v12Encoder.process };
}

async function flush(piece: EncoderPiece) {
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      if ((piece as any).queue.length === 0 && !(piece as any).processing) {
        clearInterval(iv);
        resolve();
      }
    }, 10);
  });
}

// ── Normal path ───────────────────────────────────────────────────────────────

describe("EncoderPiece — normal path", () => {
  it("enqueue calls v12.encoder.process and increments stats", async () => {
    const { piece, v12Process } = makeEncoder();
    piece.enqueue(makeTurn());
    await flush(piece);
    expect(v12Process).toHaveBeenCalledOnce();
    const stats = (piece as any)._stats;
    expect(stats.turnsProcessed).toBe(1);
    expect(stats.memoriesWritten).toBe(1);
    expect(stats.turnsSkipped).toBe(0);
  });

  it("skipped result increments turnsSkipped, not memoriesWritten", async () => {
    const { piece } = makeEncoder({
      processResult: { skipped: true, memories: [], intraTurnEdges: [] },
    });
    piece.enqueue(makeTurn());
    await flush(piece);
    const stats = (piece as any)._stats;
    expect(stats.turnsProcessed).toBe(1);
    expect(stats.turnsSkipped).toBe(1);
    expect(stats.memoriesWritten).toBe(0);
  });

  it("queues multiple turns and processes them sequentially", async () => {
    const { piece, v12Process } = makeEncoder();
    piece.enqueue(makeTurn());
    piece.enqueue(makeTurn());
    piece.enqueue(makeTurn());
    await flush(piece);
    expect(v12Process).toHaveBeenCalledTimes(3);
    expect((piece as any)._stats.turnsProcessed).toBe(3);
  });

  it("turnsErrored incremented when process throws", async () => {
    const { piece, logExtraction } = makeEncoder({
      processResult: undefined,
    });
    (piece as any).v12.encoder.process = vi.fn().mockRejectedValue(new Error("boom"));
    piece.enqueue(makeTurn());
    await flush(piece);
    expect((piece as any)._stats.turnsErrored).toBe(1);
    expect(logExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ skip_reason: expect.stringContaining("boom") })
    );
  });
});

// ── skip_triage path ──────────────────────────────────────────────────────────

describe("skip_triage path", () => {
  it("calls v12.encoder.process with skipTriage=true, skips triage LLM", async () => {
    const { piece, v12Process } = makeEncoder();

    piece.enqueue(makeTurn({ skip_triage: true }));
    await flush(piece);

    expect(v12Process).toHaveBeenCalledOnce();
    // 4th arg should be true
    expect(v12Process.mock.calls[0][3]).toBe(true);

    const stats = (piece as any)._stats;
    expect(stats.turnsProcessed).toBe(1);
    expect(stats.memoriesWritten).toBe(1);
  });

  it("normal turn calls v12.encoder.process with skipTriage=false", async () => {
    const { piece, v12Process } = makeEncoder();

    piece.enqueue(makeTurn());
    await flush(piece);

    expect(v12Process.mock.calls[0][3]).toBe(false);
  });
});

// ── getStats ──────────────────────────────────────────────────────────────────

describe("getStats", () => {
  it("returns live queue depth and processing flag", async () => {
    const { piece } = makeEncoder();
    // Before any enqueue: queue=0, processing=false
    const before = piece.getStats();
    expect(before.queueDepth).toBe(0);
    expect(before.processing).toBe(false);
  });

  it("categoriesCount is a shallow copy (no shared mutation)", async () => {
    const { piece } = makeEncoder();
    piece.enqueue(makeTurn());
    await flush(piece);
    const s1 = piece.getStats();
    s1.categoriesCount["injected"] = 999;
    const s2 = piece.getStats();
    expect(s2.categoriesCount["injected"]).toBeUndefined();
  });
});
