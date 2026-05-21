import { describe, it, expect } from "vitest";
import { formatNeighborhood, buildHint } from "../../../pieces/retriever.js";
import type { MemoryNeighborhood, RetrievalHit } from "../../../lib/types.js";

describe("RetrieverPiece graph formatting (pure functions)", () => {
  it("formatNeighborhood renders parent with ↑ and childCount", () => {
    const n: MemoryNeighborhood = {
      parents: [{ id: "p1", title: "Parent mem", category: "preference",
        relation: "relates_to", direction: "incoming", childCount: 2 }],
      children: [],
    };
    const result = formatNeighborhood(n);
    expect(result).toContain("↑");
    expect(result).toContain("Parent mem");
    expect(result).toContain("relates_to");
    expect(result).toContain("(2 filhos)");
  });

  it("formatNeighborhood renders child with ↓ and childCount", () => {
    const n: MemoryNeighborhood = {
      parents: [],
      children: [{ id: "c1", title: "Child mem", category: "code-pattern",
        relation: "contradicts", direction: "outgoing", childCount: 0 }],
    };
    const result = formatNeighborhood(n);
    expect(result).toContain("↓");
    expect(result).toContain("Child mem");
    expect(result).toContain("contradicts");
    expect(result).toContain("(0 filhos)");
  });

  it("formatNeighborhood returns empty string when no parents or children", () => {
    const n: MemoryNeighborhood = { parents: [], children: [] };
    expect(formatNeighborhood(n)).toBe("");
  });

  it("buildHint returns hint string when at least one memory has parents", () => {
    const hits = [
      { neighborhood: { parents: [{ id: "p1" }], children: [] } },
    ] as unknown as RetrievalHit[];
    expect(buildHint(hits)).toContain("memory_fetch");
  });

  it("buildHint returns hint string when at least one memory has children", () => {
    const hits = [
      { neighborhood: { parents: [], children: [{ id: "c1" }] } },
    ] as unknown as RetrievalHit[];
    expect(buildHint(hits)).toContain("memory_fetch");
  });

  it("buildHint returns empty string when no relations exist", () => {
    const hits = [
      { neighborhood: { parents: [], children: [] } },
      { neighborhood: undefined },
    ] as unknown as RetrievalHit[];
    expect(buildHint(hits)).toBe("");
  });

  it("buildHint returns empty string when no neighborhood attached", () => {
    const hits = [{}] as unknown as RetrievalHit[];
    expect(buildHint(hits)).toBe("");
  });
});
