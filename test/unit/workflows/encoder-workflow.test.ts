import { describe, it, expect, vi } from "vitest";
import { EncoderPiece } from "../../../pieces/encoder";
import type { TurnContext } from "../../../lib/types";
import type { Extractor, ExtractorResult } from "../../../lib/extractor";
import type { MnemosyneStore } from "../../../lib/store";
import type { Logger } from "../../../lib/logger";

/**
 * TW-2: after the encoder upserts a workflow into Neo4j, it must also
 * index it in Chroma for semantic retrieval. The Chroma write is
 * best-effort — it must never block the Neo4j save.
 */
describe("EncoderPiece — workflow Chroma indexing", () => {
  it("calls chroma.upsertWorkflow after neo4j.upsertWorkflow", async () => {
    const neoUpsert = vi.fn().mockResolvedValue(undefined);
    const chromaUpsert = vi.fn().mockResolvedValue(undefined);

    const extractResult: ExtractorResult = {
      candidates: [],
      workflow: {
        is_workflow: true,
        workflow: {
          name: "test-wf",
          description: "Test workflow",
          trigger: "when testing",
          outcome: "test passes",
          applies_to_project: null,
          steps: [
            {
              action: "run tests",
              order: 1,
              tool: null,
              guard: null,
              required: true,
              confirms_required: false,
            } as any,
            {
              action: "commit",
              order: 2,
              tool: null,
              guard: null,
              required: true,
              confirms_required: false,
            } as any,
          ],
          branches: [],
          confidence: 0.8,
        } as any,
      },
      triage: { present: ["workflow"] as any, skip_reason: null },
      costUsd: 0.0001,
    };

    const extractor = {
      extract: vi.fn().mockResolvedValue(extractResult),
    } as unknown as Extractor;

    const store = {
      markdownStore: {
        list: vi.fn().mockResolvedValue([]),
      },
      write: vi.fn().mockResolvedValue(undefined),
      neo4j: { upsertWorkflow: neoUpsert },
      chroma: { upsertWorkflow: chromaUpsert },
    } as unknown as MnemosyneStore;

    const logger = {
      logExtraction: vi.fn().mockResolvedValue(undefined),
    } as unknown as Logger;

    const piece = new EncoderPiece(extractor, store, logger);

    const turn: TurnContext = {
      session_id: "s1",
      user_message: "u",
      assistant_response: "a",
      tool_calls: [],
      timestamp: 1700000000000,
    };

    piece.enqueue(turn);
    await piece.stop();

    expect(neoUpsert).toHaveBeenCalledTimes(1);
    expect(chromaUpsert).toHaveBeenCalledTimes(1);
    // Both adapters receive the same hydrated Workflow object
    const wf = neoUpsert.mock.calls[0][0];
    expect(chromaUpsert.mock.calls[0][0]).toBe(wf);
    expect(wf).toMatchObject({
      name: "test-wf",
      trigger: "when testing",
      outcome: "test passes",
      reinforcements: 0,
    });
  });

  it("does not throw when chroma.upsertWorkflow is missing (older installs)", async () => {
    const neoUpsert = vi.fn().mockResolvedValue(undefined);

    const extractResult: ExtractorResult = {
      candidates: [],
      workflow: {
        is_workflow: true,
        workflow: {
          name: "test-wf2",
          description: "",
          trigger: "t",
          outcome: "o",
          applies_to_project: null,
          steps: [
            { action: "a", order: 1, tool: null, guard: null, required: true, confirms_required: false } as any,
            { action: "b", order: 2, tool: null, guard: null, required: true, confirms_required: false } as any,
          ],
          branches: [],
          confidence: 0.8,
        } as any,
      },
      triage: { present: ["workflow"] as any, skip_reason: null },
      costUsd: 0.0001,
    };

    const extractor = {
      extract: vi.fn().mockResolvedValue(extractResult),
    } as unknown as Extractor;

    const store = {
      markdownStore: { list: vi.fn().mockResolvedValue([]) },
      write: vi.fn().mockResolvedValue(undefined),
      neo4j: { upsertWorkflow: neoUpsert },
      // chroma has no upsertWorkflow method (older install) — must not crash
      chroma: {},
    } as unknown as MnemosyneStore;

    const logger = {
      logExtraction: vi.fn().mockResolvedValue(undefined),
    } as unknown as Logger;

    const piece = new EncoderPiece(extractor, store, logger);

    piece.enqueue({
      session_id: "s1",
      user_message: "u",
      assistant_response: "a",
      tool_calls: [],
      timestamp: 1700000000000,
    });

    await expect(piece.stop()).resolves.not.toThrow();
    expect(neoUpsert).toHaveBeenCalledTimes(1);
  });
});
