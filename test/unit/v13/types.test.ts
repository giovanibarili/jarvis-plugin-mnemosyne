import { describe, it, expect } from "vitest";
import type { RelatedMemoryRef, MemoryNeighborhood, RetrievalHit } from "../../../lib/types";

describe("v1.3 types", () => {
  it("RelatedMemoryRef has required fields", () => {
    const ref: RelatedMemoryRef = {
      id: "m1", title: "t", category: "preference",
      relation: "relates_to", direction: "outgoing", childCount: 3,
    };
    expect(ref.childCount).toBe(3);
    expect(ref.direction).toBe("outgoing");
  });

  it("MemoryNeighborhood has parents and children arrays", () => {
    const n: MemoryNeighborhood = { parents: [], children: [] };
    expect(n.parents).toHaveLength(0);
    expect(n.children).toHaveLength(0);
  });

  it("RetrievalHit accepts optional neighborhood field", () => {
    const hit: Partial<RetrievalHit> = {
      neighborhood: { parents: [], children: [] },
    };
    expect(hit.neighborhood).toBeDefined();
  });

  it("config.default.json has graph_retrieval section", async () => {
    const { promises: fs } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const raw = await fs.readFile(join(__dirname, "../../../config.default.json"), "utf8");
    const cfg = JSON.parse(raw);
    expect(cfg.graph_retrieval).toBeDefined();
    expect(cfg.graph_retrieval.enabled).toBe(false);
    expect(cfg.graph_retrieval.max_parents).toBe(10);
    expect(cfg.graph_retrieval.max_children).toBe(20);
  });
});
