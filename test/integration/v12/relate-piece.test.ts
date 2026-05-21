import { describe, it, expect, vi } from "vitest";
import { RelatePiece } from "../../../pieces/relate";

const makeNeighbors = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    title: `Neighbor ${i}`,
    content: `content ${i}`,
    evidence: `evidence ${i}`,
    origin: "user",
    createdAt: "2026-05-21T12:00:00Z",
    category: "preference",
  }));

const baseMemory = {
  id: "m1",
  title: "New memory",
  content: "content",
  evidence: "evidence",
  origin: "user",
  createdAt: "2026-05-21T13:00:00Z",
  category: "preference",
  siblingIds: [] as string[],
};

describe("RelatePiece", () => {
  it("calls judge for each neighbor and writes non-unrelated edges", async () => {
    const judge = {
      judge: vi.fn().mockResolvedValue({ relation: "relates_to", confidence: 0.8, reason: "related" }),
    };
    const neighbors = makeNeighbors(2);
    const chromaQuery = vi.fn().mockResolvedValue(neighbors);
    const writeEdge = vi.fn().mockResolvedValue(undefined);
    const piece = new RelatePiece({
      judge: judge as any,
      chromaQuery,
      neo4jWriteEdge: writeEdge,
      cfg: { topK: 20, similarityThreshold: 0.55, judgeCap: 20 },
    });
    await piece.handleNewMemory(baseMemory);
    expect(judge.judge).toHaveBeenCalledTimes(2);
    expect(writeEdge).toHaveBeenCalledTimes(2);
  });

  it("skips neighbors whose id is in siblingIds", async () => {
    const judge = { judge: vi.fn() };
    const chromaQuery = vi.fn().mockResolvedValue([
      { id: "sibling", title: "s", content: "c", evidence: "e", origin: "user", createdAt: "t", category: "p" },
    ]);
    const piece = new RelatePiece({
      judge: judge as any,
      chromaQuery,
      neo4jWriteEdge: vi.fn(),
      cfg: { topK: 20, similarityThreshold: 0.55, judgeCap: 20 },
    });
    await piece.handleNewMemory({ ...baseMemory, siblingIds: ["sibling"] });
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it("skips the memory itself if it appears in Chroma results", async () => {
    const judge = { judge: vi.fn() };
    const chromaQuery = vi.fn().mockResolvedValue([
      { id: "m1", title: "self", content: "c", evidence: "e", origin: "user", createdAt: "t", category: "p" },
    ]);
    const piece = new RelatePiece({
      judge: judge as any,
      chromaQuery,
      neo4jWriteEdge: vi.fn(),
      cfg: { topK: 20, similarityThreshold: 0.55, judgeCap: 20 },
    });
    await piece.handleNewMemory(baseMemory);
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it("respects judgeCap — stops after cap even if more neighbors exist", async () => {
    const judge = {
      judge: vi.fn().mockResolvedValue({ relation: "relates_to", confidence: 0.8, reason: "" }),
    };
    const chromaQuery = vi.fn().mockResolvedValue(makeNeighbors(30));
    const piece = new RelatePiece({
      judge: judge as any,
      chromaQuery,
      neo4jWriteEdge: vi.fn(),
      cfg: { topK: 30, similarityThreshold: 0.55, judgeCap: 20 },
    });
    await piece.handleNewMemory(baseMemory);
    expect(judge.judge).toHaveBeenCalledTimes(20);
  });

  it("does not write edge for unrelated verdict", async () => {
    const judge = {
      judge: vi.fn().mockResolvedValue({ relation: "unrelated", confidence: 0.1, reason: "" }),
    };
    const writeEdge = vi.fn();
    const piece = new RelatePiece({
      judge: judge as any,
      chromaQuery: vi.fn().mockResolvedValue(makeNeighbors(1)),
      neo4jWriteEdge: writeEdge,
      cfg: { topK: 20, similarityThreshold: 0.55, judgeCap: 20 },
    });
    await piece.handleNewMemory(baseMemory);
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(writeEdge).not.toHaveBeenCalled();
  });
});
