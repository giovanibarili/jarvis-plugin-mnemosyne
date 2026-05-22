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

// ── force_store fast path ─────────────────────────────────────────────────────

describe("force_store fast path", () => {
  it("writes directly to sink, bypasses v12.encoder.process, stats incremented", async () => {
    const { piece, sinkWrite, v12Process, logExtraction } = makeEncoder();

    piece.enqueue(
      makeTurn({
        force_store: {
          content:
            "SAA is the core settlement engine — 17 operation types, FIFO ordering via EC",
          category: "architecture-decision",
        },
      })
    );
    await flush(piece);

    expect(v12Process).not.toHaveBeenCalled();
    expect(sinkWrite).toHaveBeenCalledOnce();

    const written = sinkWrite.mock.calls[0][0];
    expect(written.content).toBe(
      "SAA is the core settlement engine — 17 operation types, FIFO ordering via EC"
    );
    expect(written.category).toBe("architecture-decision");
    expect(written.confidence).toBe(1.0);
    expect(written.origin_source).toBe("user");

    expect(logExtraction).toHaveBeenCalledOnce();
    const log = logExtraction.mock.calls[0][0];
    expect(log.skip_reason).toBeNull();
    expect(log.confidence_avg).toBe(1.0);

    const stats = (piece as any)._stats;
    expect(stats.turnsProcessed).toBe(1);
    expect(stats.memoriesWritten).toBe(1);
    expect(stats.categoriesCount["architecture-decision"]).toBe(1);
  });

  it("uses first 80 chars as title when title is omitted", async () => {
    const { piece, sinkWrite } = makeEncoder();
    const longContent = "A".repeat(120);
    piece.enqueue(makeTurn({ force_store: { content: longContent } }));
    await flush(piece);
    const written = sinkWrite.mock.calls[0][0];
    expect(written.title.length).toBe(80);
    expect(written.category).toBe("preference"); // default
  });

  it("uses provided title and category", async () => {
    const { piece, sinkWrite } = makeEncoder();
    piece.enqueue(
      makeTurn({
        force_store: {
          title: "Custom Title",
          content: "Some content",
          category: "mental-model",
        },
      })
    );
    await flush(piece);
    const written = sinkWrite.mock.calls[0][0];
    expect(written.title).toBe("Custom Title");
    expect(written.category).toBe("mental-model");
  });

  it("calls relatePiece.handleNewMemory when wired", async () => {
    const handleNewMemory = vi.fn().mockResolvedValue(undefined);
    const { piece, sinkWrite } = makeEncoder();
    (piece as any).v12.relatePiece = { handleNewMemory };

    piece.enqueue(makeTurn({ force_store: { content: "test memory" } }));
    await flush(piece);

    expect(handleNewMemory).toHaveBeenCalledOnce();
    const call = handleNewMemory.mock.calls[0][0];
    expect(call.id).toBe((await sinkWrite.mock.results[0].value).id);
    expect(call.content).toBe("test memory");
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
