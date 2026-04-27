import type { CapabilityDefinition } from "@jarvis/core";
import type { Neo4jAdapter } from "../neo4j-adapter.js";
import type { ReplayEngine } from "../replay-engine.js";

interface WorkflowListArgs {
  project?: string;
}

interface WorkflowGetArgs {
  idOrName: string;
}

interface WorkflowReplayArgs {
  idOrName: string;
  vars?: Record<string, string>;
}

export function buildWorkflowListTool(
  neo4j: Neo4jAdapter
): CapabilityDefinition {
  return {
    name: "workflow_list",
    description:
      "List workflows extracted from past sessions. Optional project filter.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by applies_to_project" },
      },
    },
    handler: async (raw) => {
      const args = raw as unknown as WorkflowListArgs;
      const filter = args.project ? { project: args.project } : undefined;
      const workflows = await neo4j.listWorkflows(filter);
      return { workflows };
    },
  };
}

export function buildWorkflowGetTool(
  neo4j: Neo4jAdapter
): CapabilityDefinition {
  return {
    name: "workflow_get",
    description:
      "Fetch a workflow by id or by name (case-sensitive). Returns Workflow with steps, or { error: 'not found' }.",
    input_schema: {
      type: "object",
      properties: {
        idOrName: { type: "string", description: "Workflow id or name" },
      },
      required: ["idOrName"],
    },
    handler: async (raw) => {
      const args = raw as unknown as WorkflowGetArgs;
      if (!args.idOrName) return { error: "idOrName is required" };
      const wf = await neo4j.getWorkflow(args.idOrName);
      if (!wf) return { error: "not found" };
      return wf;
    },
  };
}

/**
 * workflow_replay (v1.0 simplified) — ReplayEngine.run requires an
 * interactive ReplayPrompt that asks the user for confirmation per step.
 * Wiring that to the bus is the HUD's responsibility (Task 14: a panel
 * button drives the prompt loop with confirm/skip/abort).
 *
 * For v1.0 the tool returns the full plan (steps with resolved vars where
 * possible) and instructs the caller to use the HUD's Replay button.
 * The plan errata #22 covers the capability.request shape — the actual
 * interactive run is dispatched by a panel command, not this tool.
 */
export function buildWorkflowReplayTool(
  neo4j: Neo4jAdapter,
  _replay: ReplayEngine
): CapabilityDefinition {
  return {
    name: "workflow_replay",
    description:
      "Plan an interactive replay of a workflow. Returns the steps that would execute (with $vars substituted from `vars`). Actual step-by-step confirmation runs from the HUD's Replay button (v1.0 limitation).",
    input_schema: {
      type: "object",
      properties: {
        idOrName: { type: "string", description: "Workflow id or name" },
        vars: {
          type: "object",
          description:
            "Optional variable substitutions, e.g. { ticket: 'PROJ-123' }",
          additionalProperties: { type: "string" },
        },
      },
      required: ["idOrName"],
    },
    handler: async (raw) => {
      const args = raw as unknown as WorkflowReplayArgs;
      if (!args.idOrName) return { error: "idOrName is required" };
      const wf = await neo4j.getWorkflow(args.idOrName);
      if (!wf) return { error: "not found" };

      const vars = args.vars ?? {};
      const steps = wf.steps
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((step) => {
          let resolved = step.action;
          const placeholders = [...step.action.matchAll(/\$(\w+)/g)].map(
            (m) => m[1]
          );
          const unresolved: string[] = [];
          for (const ph of placeholders) {
            if (vars[ph] !== undefined) {
              resolved = resolved.replaceAll(`$${ph}`, vars[ph]);
            } else {
              unresolved.push(ph);
            }
          }
          return {
            order: step.order,
            action: resolved,
            tool: step.tool,
            required: step.required,
            confirms_required: step.confirms_required,
            unresolved_vars: unresolved,
          };
        });

      return {
        workflow: {
          id: wf.id,
          name: wf.name,
          description: wf.description,
          trigger: wf.trigger,
          outcome: wf.outcome,
        },
        steps_to_replay: steps,
        message:
          "Use HUD or chat replay to confirm each step interactively (v1.0).",
      };
    },
  };
}
