import { describe, it, expect } from "vitest";
import {
  TriageV12Result,
  ClassifiedCandidate,
  PendingCategory,
  RelateRelation,
} from "../../../lib/types";

describe("v12 types", () => {
  it("TriageV12Result accepts binary shape", () => {
    const r: TriageV12Result = { worth_extracting: true, reason: "user states preference" };
    expect(r.worth_extracting).toBe(true);
  });

  it("ClassifiedCandidate carries category + evidence + confidence", () => {
    const c: ClassifiedCandidate = {
      category: "preference",
      is_new_category: false,
      confidence: 0.92,
      title: "Likes Postgres",
      content: "User prefers Postgres for greenfield projects",
      evidence: "Eu gosto de Postgres",
      tags: ["postgres"],
    };
    expect(c.confidence).toBeGreaterThan(0.9);
  });

  it("PendingCategory tracks occurrences and timestamps", () => {
    const p: PendingCategory = {
      slug: "ux-pattern",
      description: "UX recurrence",
      hint: "user describes UX choice",
      extractor_template: "...",
      occurrences: 1,
      first_seen_ts: new Date().toISOString(),
      last_seen_ts: new Date().toISOString(),
    };
    expect(p.occurrences).toBe(1);
  });

  it("RelateRelation enumerates 5 values", () => {
    const values: RelateRelation[] = ["merge", "supersede", "relates_to", "contradicts", "unrelated"];
    expect(values).toHaveLength(5);
  });
});
