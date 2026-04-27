import { describe, it, expect, vi } from "vitest";
import { EncoderPiece } from "../../pieces/encoder";
import type { TurnContext, MemoryCandidate } from "../../lib/types";
import type { Extractor, ExtractorResult } from "../../lib/extractor";
import type { MnemosyneStore } from "../../lib/store";
import type { Logger } from "../../lib/logger";

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

function makeCandidate(
  overrides: Partial<MemoryCandidate> = {}
): MemoryCandidate {
  return {
    category: "preference",
    title: "prefer dark mode",
    content: "User prefers dark mode UI.",
    tags: ["ui"],
    project: null,
    confidence: 0.9,
    evidence: "user said so",
    visibility: "open",
    ...overrides,
  };
}

function buildEnv(opts: {
  extractResult: ExtractorResult;
  existing?: Array<{ title: string; content: string; category: string }>;
}) {
  const extractor = {
    extract: vi.fn().mockResolvedValue(opts.extractResult),
  } as unknown as Extractor;

  const writes: any[] = [];
  const store = {
    markdownStore: {
      list: vi.fn().mockImplementation(async (_filter: any) => {
        return opts.existing ?? [];
      }),
    },
    write: vi.fn().mockImplementation(async (mem: any) => {
      writes.push(mem);
    }),
  } as unknown as MnemosyneStore;

  const logEntries: any[] = [];
  const logger = {
    logExtraction: vi.fn().mockImplementation(async (entry: any) => {
      logEntries.push(entry);
    }),
  } as unknown as Logger;

  const piece = new EncoderPiece(extractor, store, logger);
  return { piece, extractor, store, logger, writes, logEntries };
}

async function flush(piece: EncoderPiece) {
  // Wait until queue + processing both drain
  await piece.stop();
}

describe("EncoderPiece", () => {
  it("enqueue → processTurn writes one Memory per candidate", async () => {
    const cand1 = makeCandidate({ title: "t1", content: "c1" });
    const cand2 = makeCandidate({
      title: "t2",
      content: "c2",
      category: "code-pattern",
    });
    const env = buildEnv({
      extractResult: {
        candidates: [cand1, cand2],
        workflow: null,
        triage: { present: ["preference", "code-pattern"], skip_reason: null },
        costUsd: 0.0007,
      },
    });

    env.piece.enqueue(makeTurn());
    await flush(env.piece);

    expect(env.extractor.extract).toHaveBeenCalledTimes(1);
    expect(env.store.write).toHaveBeenCalledTimes(2);
    expect(env.writes[0]).toMatchObject({
      title: "t1",
      content: "c1",
      category: "preference",
      reinforcements: 0,
      pinned: false,
      promoted_at: null,
      source_session: "s1",
    });
    expect(env.writes[1]).toMatchObject({
      title: "t2",
      content: "c2",
      category: "code-pattern",
    });
    // Each Memory must get a fresh uuid
    expect(env.writes[0].id).toBeTruthy();
    expect(env.writes[1].id).toBeTruthy();
    expect(env.writes[0].id).not.toBe(env.writes[1].id);
  });

  it("logs a pass=2 extraction entry per turn with avg confidence", async () => {
    const env = buildEnv({
      extractResult: {
        candidates: [
          makeCandidate({ confidence: 0.8 }),
          makeCandidate({ title: "x", content: "y", confidence: 1.0 }),
        ],
        workflow: null,
        triage: { present: ["preference"], skip_reason: null },
        costUsd: 0.0004,
      },
    });

    env.piece.enqueue(makeTurn({ session_id: "abc", timestamp: 42 }));
    await flush(env.piece);

    expect(env.logger.logExtraction).toHaveBeenCalledTimes(1);
    const entry = env.logEntries[0];
    expect(entry).toMatchObject({
      turn_id: "abc-42",
      pass: 2,
      categories: ["preference"],
      candidates_emitted: 2,
      cost_usd: 0.0004,
      skip_reason: null,
    });
    expect(entry.confidence_avg).toBeCloseTo(0.9, 5);
  });

  it("skips when extractor returns no candidates", async () => {
    const env = buildEnv({
      extractResult: {
        candidates: [],
        workflow: null,
        triage: { present: [], skip_reason: "casual conversation" },
        costUsd: 0.0001,
      },
    });

    env.piece.enqueue(makeTurn());
    await flush(env.piece);

    expect(env.store.write).not.toHaveBeenCalled();
    // pass=2 entry still emitted, with skip_reason from triage
    expect(env.logger.logExtraction).toHaveBeenCalledTimes(1);
    expect(env.logEntries[0]).toMatchObject({
      pass: 2,
      candidates_emitted: 0,
      confidence_avg: 0,
      skip_reason: "casual conversation",
    });
  });

  it("dedups against markdown store: existing title+content+category is skipped", async () => {
    const cand = makeCandidate({
      category: "preference",
      title: "dup",
      content: "same",
    });
    const env = buildEnv({
      extractResult: {
        candidates: [cand],
        workflow: null,
        triage: { present: ["preference"], skip_reason: null },
        costUsd: 0.0004,
      },
      existing: [
        { category: "preference", title: "dup", content: "same" } as any,
      ],
    });

    env.piece.enqueue(makeTurn());
    await flush(env.piece);

    expect(env.store.write).not.toHaveBeenCalled();
  });
});
