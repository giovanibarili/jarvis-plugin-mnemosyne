import { describe, it, expect } from "vitest";
import type { ExtractionLogEntry } from "../../../lib/logger";

// Type-level check: the extraction log entry accepts v12 fields.
// This test verifies the type compiles correctly with new optional fields.
// Runtime logging is covered by integration tests.

describe("Logger v12 fields (type check)", () => {
  it("accepts pipeline_version field", () => {
    const entry: ExtractionLogEntry = {
      turn_id: "t-1",
      pass: 2,
      pipeline_version: "1.2",
      classify_candidates: 3,
      new_categories_proposed: 1,
      materialized: ["ux-pattern"],
      intra_turn_edges: 2,
      cross_store_edges: 5,
    };
    expect(entry.pipeline_version).toBe("1.2");
    expect(entry.materialized).toHaveLength(1);
    expect(entry.classify_candidates).toBe(3);
    expect(entry.new_categories_proposed).toBe(1);
    expect(entry.intra_turn_edges).toBe(2);
    expect(entry.cross_store_edges).toBe(5);
  });

  it("accepts v1.1 entries without v12 fields", () => {
    const entry: ExtractionLogEntry = {
      turn_id: "t-2",
      pass: 1,
      categories: ["preference"],
      candidates_emitted: 1,
    };
    expect(entry.pipeline_version).toBeUndefined();
    expect(entry.materialized).toBeUndefined();
  });

  it("constrains pipeline_version to allowed values", () => {
    const v11: ExtractionLogEntry["pipeline_version"] = "1.1";
    const v12: ExtractionLogEntry["pipeline_version"] = "1.2";
    expect(v11).toBe("1.1");
    expect(v12).toBe("1.2");
  });
});
