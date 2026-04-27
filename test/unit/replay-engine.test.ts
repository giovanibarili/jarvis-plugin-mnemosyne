import { describe, it, expect, vi } from "vitest";
import { ReplayEngine } from "../../lib/replay-engine";
import type { ReplayPrompt } from "../../lib/replay-engine";
import type { Logger } from "../../lib/logger";
import type { Workflow, WorkflowStep } from "../../lib/types";

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: "s",
    order: 1,
    action: "do thing",
    tool: "bash",
    guard: null,
    required: true,
    confirms_required: false,
    ...overrides,
  };
}

function makeWorkflow(steps: WorkflowStep[]): Workflow {
  return {
    id: "w1",
    name: "test-workflow",
    description: "test",
    trigger: "manual",
    outcome: "ok",
    applies_to_project: null,
    steps,
    branches: [],
    confidence: 1,
    reinforcements: 0,
    created_at: 0,
    last_used: 0,
  };
}

function makeLogger(): Logger {
  return { logReplay: vi.fn().mockResolvedValue(undefined) } as unknown as Logger;
}

function makePrompt(
  askValues: string[],
  execResults: Array<{ success: boolean; result?: any; error?: string }>
): ReplayPrompt {
  let askIdx = 0;
  let execIdx = 0;
  return {
    ask: vi.fn(async () => askValues[askIdx++] ?? "abort"),
    execute: vi.fn(async () => execResults[execIdx++] ?? { success: true }),
  };
}

describe("ReplayEngine", () => {
  it("executes all steps when user says yes", async () => {
    const logger = makeLogger();
    const engine = new ReplayEngine({ logger });
    const wf = makeWorkflow([
      makeStep({ id: "a", order: 1, action: "step one" }),
      makeStep({ id: "b", order: 2, action: "step two" }),
      makeStep({ id: "c", order: 3, action: "step three" }),
    ]);
    const prompt = makePrompt(
      ["yes", "yes", "yes"],
      [{ success: true }, { success: true }, { success: true }]
    );

    const result = await engine.run(wf, prompt);

    expect(result.outcome).toBe("completed");
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every((s) => s.result === "success")).toBe(true);
    expect(prompt.execute).toHaveBeenCalledTimes(3);
  });

  it("skips step on 'skip' decision and marks completed_partial when required", async () => {
    const logger = makeLogger();
    const engine = new ReplayEngine({ logger });
    const wf = makeWorkflow([
      makeStep({ id: "a", order: 1, action: "step one", required: true }),
      makeStep({ id: "b", order: 2, action: "step two", required: true }),
      makeStep({ id: "c", order: 3, action: "step three", required: true }),
    ]);
    const prompt = makePrompt(
      ["yes", "skip", "yes"],
      [{ success: true }, { success: true }]
    );

    const result = await engine.run(wf, prompt);

    expect(result.outcome).toBe("completed_partial");
    expect(result.steps[1].decision).toBe("skip");
    expect(result.steps[1].result).toBe("skipped");
    expect(prompt.execute).toHaveBeenCalledTimes(2);
  });

  it("aborts on 'abort' decision and skips subsequent steps", async () => {
    const logger = makeLogger();
    const engine = new ReplayEngine({ logger });
    const wf = makeWorkflow([
      makeStep({ id: "a", order: 1, action: "step one" }),
      makeStep({ id: "b", order: 2, action: "step two" }),
      makeStep({ id: "c", order: 3, action: "step three" }),
    ]);
    const prompt = makePrompt(["yes", "abort"], [{ success: true }]);

    const result = await engine.run(wf, prompt);

    expect(result.outcome).toBe("aborted");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].decision).toBe("abort");
    expect(prompt.execute).toHaveBeenCalledTimes(1);
    // step 3 was never asked about
    expect(prompt.ask).toHaveBeenCalledTimes(2);
  });

  it("resolves $variables before exec", async () => {
    const logger = makeLogger();
    const engine = new ReplayEngine({ logger });
    const wf = makeWorkflow([
      makeStep({ id: "a", order: 1, action: "echo $message to $target" }),
    ]);
    // Sequence: ask for $message, ask for $target, ask for confirmation
    const prompt = makePrompt(["hello", "world", "yes"], [{ success: true }]);

    const result = await engine.run(wf, prompt);

    expect(result.outcome).toBe("completed");
    expect(prompt.execute).toHaveBeenCalledTimes(1);
    const execCall = (prompt.execute as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(execCall[1]).toBe("echo hello to world");
    expect(result.steps[0].action).toBe("echo hello to world");
  });

  it("halts on required step failure", async () => {
    const logger = makeLogger();
    const engine = new ReplayEngine({ logger });
    const wf = makeWorkflow([
      makeStep({ id: "a", order: 1, action: "step one", required: true }),
      makeStep({ id: "b", order: 2, action: "step two", required: true }),
      makeStep({ id: "c", order: 3, action: "step three", required: true }),
    ]);
    const prompt = makePrompt(
      ["yes", "yes"],
      [{ success: true }, { success: false, error: "boom" }]
    );

    const result = await engine.run(wf, prompt);

    expect(result.outcome).toBe("failed");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].result).toBe("failure");
    expect(result.steps[1].error).toBe("boom");
    expect(prompt.execute).toHaveBeenCalledTimes(2);
    // step 3 never asked
    expect(prompt.ask).toHaveBeenCalledTimes(2);
  });

  it("continues on optional step failure", async () => {
    const logger = makeLogger();
    const engine = new ReplayEngine({ logger });
    const wf = makeWorkflow([
      makeStep({ id: "a", order: 1, action: "step one", required: true }),
      makeStep({ id: "b", order: 2, action: "step two", required: false }),
      makeStep({ id: "c", order: 3, action: "step three", required: true }),
    ]);
    const prompt = makePrompt(
      ["yes", "yes", "yes"],
      [
        { success: true },
        { success: false, error: "soft fail" },
        { success: true },
      ]
    );

    const result = await engine.run(wf, prompt);

    expect(result.outcome).toBe("completed");
    expect(result.steps).toHaveLength(3);
    expect(result.steps[1].result).toBe("failure");
    expect(result.steps[1].error).toBe("soft fail");
    expect(result.steps[2].result).toBe("success");
    expect(prompt.execute).toHaveBeenCalledTimes(3);
  });

  it("logs outcome to replay.log via logger.logReplay", async () => {
    const logger = makeLogger();
    const engine = new ReplayEngine({ logger });
    const wf = makeWorkflow([
      makeStep({ id: "a", order: 1, action: "only step" }),
    ]);
    const prompt = makePrompt(["yes"], [{ success: true }]);

    const result = await engine.run(wf, prompt);

    expect(logger.logReplay).toHaveBeenCalledTimes(1);
    expect(logger.logReplay).toHaveBeenCalledWith(result);
    const arg = (logger.logReplay as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.workflow).toBe("test-workflow");
    expect(arg.outcome).toBe("completed");
    expect(arg.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(arg.steps).toHaveLength(1);
  });
});
