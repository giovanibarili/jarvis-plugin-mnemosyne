import type { Workflow, WorkflowStep } from "./types";
import type { Logger } from "./logger";

export interface ReplayPrompt {
  ask(question: string): Promise<string>;
  execute(
    step: WorkflowStep,
    resolvedAction: string
  ): Promise<{ success: boolean; result?: any; error?: string }>;
}

export interface ReplayOptions {
  logger: Logger;
}

export type StepDecision = "yes" | "skip" | "abort";

export interface ReplayOutcome {
  workflow: string;
  startedAt: string;
  steps: Array<{
    order: number;
    action: string;
    decision: StepDecision;
    result: "success" | "skipped" | "failure";
    durationMs?: number;
    error?: string;
  }>;
  outcome: "completed" | "completed_partial" | "aborted" | "failed";
}

export class ReplayEngine {
  constructor(private opts: ReplayOptions) {}

  async run(workflow: Workflow, prompt: ReplayPrompt): Promise<ReplayOutcome> {
    const startedAt = new Date().toISOString();
    const log: ReplayOutcome["steps"] = [];
    let outcome: ReplayOutcome["outcome"] = "completed";

    const sorted = [...workflow.steps].sort((a, b) => a.order - b.order);

    for (const step of sorted) {
      const resolvedAction = await this.resolveVariables(step.action, prompt);

      const question = [
        `Step ${step.order}/${sorted.length}: ${resolvedAction}`,
        `  Tool: ${step.tool ?? "n/a"}`,
        `  Required: ${step.required ? "yes" : "no"}`,
        `  → Execute? [yes/skip/abort]`,
      ].join("\n");

      const reply = (await prompt.ask(question)).trim().toLowerCase();
      const decision: StepDecision = ["yes", "y", "sim"].includes(reply)
        ? "yes"
        : ["skip", "s"].includes(reply)
        ? "skip"
        : "abort";

      if (decision === "abort") {
        log.push({
          order: step.order,
          action: resolvedAction,
          decision,
          result: "skipped",
        });
        outcome = "aborted";
        break;
      }
      if (decision === "skip") {
        log.push({
          order: step.order,
          action: resolvedAction,
          decision,
          result: "skipped",
        });
        if (step.required) outcome = "completed_partial";
        continue;
      }

      const t0 = Date.now();
      const exec = await prompt.execute(step, resolvedAction);
      const durationMs = Date.now() - t0;

      if (!exec.success) {
        log.push({
          order: step.order,
          action: resolvedAction,
          decision,
          result: "failure",
          durationMs,
          error: exec.error,
        });
        if (step.required) {
          outcome = "failed";
          break;
        }
        continue;
      }

      log.push({
        order: step.order,
        action: resolvedAction,
        decision,
        result: "success",
        durationMs,
      });
    }

    const result: ReplayOutcome = {
      workflow: workflow.name,
      startedAt,
      steps: log,
      outcome,
    };
    await this.opts.logger.logReplay(result);
    return result;
  }

  private async resolveVariables(
    action: string,
    prompt: ReplayPrompt
  ): Promise<string> {
    const placeholders = [...action.matchAll(/\$(\w+)/g)].map((m) => m[1]);
    let resolved = action;
    for (const ph of placeholders) {
      const val = await prompt.ask(`Variable required: $${ph} = ?`);
      resolved = resolved.replaceAll(`$${ph}`, val);
    }
    return resolved;
  }
}
