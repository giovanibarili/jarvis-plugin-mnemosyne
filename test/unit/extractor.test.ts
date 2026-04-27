import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { Extractor } from "../../lib/extractor";
import type { LLMClient } from "../../lib/extractor";
import type { TurnContext } from "../../lib/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const promptsDir = resolve(__dirname, "../../prompts");

function makeTurn(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    session_id: "s1",
    user_message: "oi",
    assistant_response: "olá",
    tool_calls: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("Extractor", () => {
  it("pass1 returns empty for casual turn", async () => {
    const llm: LLMClient = {
      call: vi
        .fn()
        .mockResolvedValue(
          '{"present": [], "skip_reason": "casual conversation"}'
        ),
    };
    const ext = new Extractor(llm, promptsDir);
    const result = await ext.triage(makeTurn());
    expect(result.present).toEqual([]);
    expect(llm.call).toHaveBeenCalledTimes(1);
  });

  it("pass1 + pass2 extracts preference", async () => {
    const llm: LLMClient = {
      call: vi
        .fn()
        .mockResolvedValueOnce(
          '{"present": ["preference"], "skip_reason": null}'
        )
        .mockResolvedValueOnce(
          '{"candidates":[{"category":"preference","title":"x","content":"y","tags":[],"project":null,"confidence":0.9,"evidence":"y","visibility":"open"}]}'
        ),
    };
    const ext = new Extractor(llm, promptsDir);
    const result = await ext.extract(
      makeTurn({ user_message: "I prefer X", assistant_response: "noted" })
    );
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].category).toBe("preference");
    expect(llm.call).toHaveBeenCalledTimes(2);
  });

  it("does not call pass2 when triage empty", async () => {
    const llm: LLMClient = {
      call: vi
        .fn()
        .mockResolvedValue('{"present": [], "skip_reason": "casual"}'),
    };
    const ext = new Extractor(llm, promptsDir);
    await ext.extract(makeTurn());
    expect(llm.call).toHaveBeenCalledTimes(1);
  });

  it("workflow extractor returns workflow when present", async () => {
    const wfJson = JSON.stringify({
      is_workflow: true,
      workflow: {
        name: "test",
        trigger: "t",
        outcome: "o",
        applies_to_project: null,
        steps: [
          {
            order: 1,
            action: "a",
            tool: "bash",
            guard: null,
            required: true,
            confirms_required: false,
          },
          {
            order: 2,
            action: "b",
            tool: "bash",
            guard: null,
            required: true,
            confirms_required: false,
          },
          {
            order: 3,
            action: "c",
            tool: "bash",
            guard: null,
            required: true,
            confirms_required: false,
          },
        ],
        branches: [],
        confidence: 0.9,
      },
    });
    const llm: LLMClient = {
      call: vi
        .fn()
        .mockResolvedValueOnce(
          '{"present": ["workflow"], "skip_reason": null}'
        )
        .mockResolvedValueOnce(wfJson),
    };
    const ext = new Extractor(llm, promptsDir);
    const result = await ext.extract(
      makeTurn({
        user_message: "process",
        assistant_response: "...",
      })
    );
    expect(result.workflow).not.toBeNull();
    expect(result.workflow?.workflow.steps.length).toBe(3);
  });

  it("rejects candidates with confidence < 0.6", async () => {
    const llm: LLMClient = {
      call: vi
        .fn()
        .mockResolvedValueOnce(
          '{"present": ["preference"], "skip_reason": null}'
        )
        .mockResolvedValueOnce(
          '{"candidates":[{"category":"preference","title":"x","content":"y","tags":[],"project":null,"confidence":0.4,"evidence":"","visibility":"open"}]}'
        ),
    };
    const ext = new Extractor(llm, promptsDir);
    const result = await ext.extract(
      makeTurn({ user_message: "x", assistant_response: "y" })
    );
    expect(result.candidates.length).toBe(0);
  });
});
