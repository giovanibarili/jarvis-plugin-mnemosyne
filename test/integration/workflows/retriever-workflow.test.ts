import { describe, it, expect } from "vitest";
import { formatWorkflowHit } from "../../../pieces/retriever.js";
import type { WorkflowHitFormatInput } from "../../../pieces/retriever.js";

describe("Retriever — workflow formatting (pure function)", () => {
  const hit: WorkflowHitFormatInput = {
    id: "wf1",
    name: "ship-it",
    trigger: "implementation complete, ready to deliver",
    outcome: "PR merged and deployed to production",
    stepCount: 5,
    similarity: 0.88,
  };

  it("renders 📋 workflow prefix", () => {
    expect(formatWorkflowHit(hit)).toContain("📋");
  });

  it("renders workflow name", () => {
    expect(formatWorkflowHit(hit)).toContain("ship-it");
  });

  it("renders similarity score", () => {
    expect(formatWorkflowHit(hit)).toContain("0.88");
  });

  it("renders trigger text", () => {
    expect(formatWorkflowHit(hit)).toContain("implementation complete");
  });

  it("renders step count", () => {
    expect(formatWorkflowHit(hit)).toContain("5 steps");
  });

  it("renders workflow_replay call", () => {
    expect(formatWorkflowHit(hit)).toContain('workflow_replay("ship-it")');
  });

  it("omits sim line when similarity is 0", () => {
    const zeroHit = { ...hit, similarity: 0 };
    const result = formatWorkflowHit(zeroHit);
    expect(result).not.toContain("sim 0.00");
  });
});
