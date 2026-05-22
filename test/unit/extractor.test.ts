import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { Extractor } from "../../lib/extractor";
import type { LLMClient } from "../../lib/extractor";
import type { TurnContext } from "../../lib/types";

/** Wrap a raw JSON string (or any string) into an LLMCallResult for mocking. */
const llmResult = (text: string) => ({ text, costUsd: 0 });

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
        .mockResolvedValue(llmResult('{"present": [], "skip_reason": "casual conversation"}')),
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
        .mockResolvedValueOnce(llmResult('{"present": ["preference"], "skip_reason": null}'))
        .mockResolvedValueOnce(llmResult('{"candidates":[{"category":"preference","title":"x","content":"y","tags":[],"project":null,"confidence":0.9,"evidence":"y","visibility":"open"}]}')),
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
        .mockResolvedValue(llmResult('{"present": [], "skip_reason": "casual"}')),
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
        .mockResolvedValueOnce(llmResult('{"present": ["workflow"], "skip_reason": null}'))
        .mockResolvedValueOnce(llmResult(wfJson)),
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
        .mockResolvedValueOnce(llmResult('{"present": ["preference"], "skip_reason": null}'))
        .mockResolvedValueOnce(llmResult('{"candidates":[{"category":"preference","title":"x","content":"y","tags":[],"project":null,"confidence":0.4,"evidence":"","visibility":"open"}]}')),
    };
    const ext = new Extractor(llm, promptsDir);
    const result = await ext.extract(
      makeTurn({ user_message: "x", assistant_response: "y" })
    );
    expect(result.candidates.length).toBe(0);
  });

  describe("dynamic categories", () => {
    let scratchDir: string;

    beforeEach(async () => {
      scratchDir = await fs.mkdtemp(join(tmpdir(), "mnemo-prompts-"));
      // Copy required prompts so the extractor can read them.
      for (const f of ["triage.md", "generate-extractor.md"]) {
        await fs.copyFile(resolve(promptsDir, f), join(scratchDir, f));
      }
    });

    afterEach(async () => {
      await fs.rm(scratchDir, { recursive: true, force: true });
    });

    it("auto-generates extract-<id>.md when triage proposes a new category", async () => {
      const triageJson = JSON.stringify({
        present: ["incident-postmortem"],
        proposed: [
          {
            id: "incident-postmortem",
            description: "Lessons from production incidents.",
            hint: "User narrates a postmortem with timeline + root cause.",
          },
        ],
        skip_reason: null,
      });
      const generatedPrompt = `Extract incident postmortems from the turn below.\n\nTurn:\n"""\n{{TURN}}\n"""\n\nOutput JSON only:\n{\n  "candidates": [\n    {\n      "category": "incident-postmortem",\n      "title": "string ~6 words",\n      "content": "1-3 sentences",\n      "tags": ["tag"],\n      "project": null,\n      "confidence": 0.9,\n      "evidence": "quote",\n      "visibility": "open"\n    }\n  ]\n}\n\nIf no incident-postmortem is clearly expressed, return {"candidates": []}.`;
      const candJson = JSON.stringify({
        candidates: [
          {
            category: "incident-postmortem",
            title: "DB outage from missing index",
            content: "Outage caused by absent index on hot table.",
            tags: ["db", "postmortem"],
            project: null,
            confidence: 0.92,
            evidence: "we lost the table",
            visibility: "open",
          },
        ],
      });
      const llm: LLMClient = {
        call: vi
          .fn()
          .mockResolvedValueOnce(llmResult(triageJson))
          .mockResolvedValueOnce(llmResult(generatedPrompt))
          .mockResolvedValueOnce(llmResult(candJson)),
      };
      const ext = new Extractor(llm, scratchDir);
      await ext.init();
      const result = await ext.extract(
        makeTurn({ user_message: "let me share a postmortem...", assistant_response: "ok" })
      );
      expect(result.newPromptsGenerated).toEqual(["incident-postmortem"]);
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0].category).toBe("incident-postmortem");
      // The file was authored on disk and is reusable on next turn.
      const written = await fs.readFile(
        join(scratchDir, "extract-incident-postmortem.md"),
        "utf-8"
      );
      expect(written).toContain("{{TURN}}");
      expect(written).toContain("incident-postmortem");
    });

    it("rejects malformed slug for proposed category", async () => {
      const triageJson = JSON.stringify({
        present: ["NotASlug!"],
        proposed: [
          { id: "NotASlug!", description: "x", hint: "y" },
        ],
        skip_reason: null,
      });
      const llm: LLMClient = {
        call: vi.fn().mockResolvedValueOnce(llmResult(triageJson)),
      };
      const ext = new Extractor(llm, scratchDir);
      await ext.init();
      const result = await ext.extract(makeTurn());
      expect(result.candidates.length).toBe(0);
      expect(result.newPromptsGenerated ?? []).toEqual([]);
      expect(result.triage.present).toEqual([]);
    });

    it("reuses existing dynamic prompt without re-authoring", async () => {
      // Pre-author the prompt as if a previous run had generated it.
      await fs.writeFile(
        join(scratchDir, "extract-runbook.md"),
        `Extract runbooks.\nTurn:\n"""\n{{TURN}}\n"""\nOutput JSON only:\n{"candidates":[{"category":"runbook","title":"t","content":"c","tags":[],"project":null,"confidence":0.9,"evidence":"e","visibility":"open"}]}\nIf no runbook, return {"candidates": []}.\n`,
        "utf-8"
      );
      const triageJson = JSON.stringify({
        present: ["runbook"],
        proposed: [], // not even necessary — id is already known
        skip_reason: null,
      });
      const candJson = JSON.stringify({
        candidates: [
          {
            category: "runbook",
            title: "Restart deposits-api",
            content: "When stuck, kubectl rollout restart.",
            tags: ["ops"],
            project: null,
            confidence: 0.9,
            evidence: "kubectl",
            visibility: "open",
          },
        ],
      });
      const llm: LLMClient = {
        call: vi
          .fn()
          .mockResolvedValueOnce(llmResult(triageJson))
          .mockResolvedValueOnce(llmResult(candJson)),
      };
      const ext = new Extractor(llm, scratchDir);
      await ext.init();
      const result = await ext.extract(makeTurn());
      expect(result.newPromptsGenerated ?? []).toEqual([]);
      expect(result.candidates.length).toBe(1);
      // Only triage + extract were called — no meta-prompt.
      expect(llm.call).toHaveBeenCalledTimes(2);
    });
  });
});
