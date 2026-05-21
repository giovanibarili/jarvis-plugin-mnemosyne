import { describe, it, expect, vi } from "vitest";
import { IntraTurnRelate } from "../../../lib/v12/intra-turn-relate";

const makeMemories = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    title: `Title ${i}`,
    content: `content ${i}`,
    evidence: `evidence ${i}`,
    origin: "user",
    createdAt: "2026-05-21T12:00:00Z",
    category: "preference",
  }));

describe("IntraTurnRelate", () => {
  it("returns zero edges for a single memory", async () => {
    const judge = { judge: vi.fn() };
    const r = new IntraTurnRelate(judge as any, { maxPairs: 3 });
    const edges = await r.relate(makeMemories(1));
    expect(edges).toHaveLength(0);
    expect(judge.judge).not.toHaveBeenCalled();
  });

  it("judges exactly 1 pair for N=2 memories", async () => {
    const judge = {
      judge: vi.fn().mockResolvedValue({ relation: "relates_to", confidence: 0.8, reason: "related" }),
    };
    const r = new IntraTurnRelate(judge as any, { maxPairs: 3 });
    const edges = await r.relate(makeMemories(2));
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ from: "m0", to: "m1", relation: "relates_to", confidence: 0.8 });
  });

  it("judges 3 pairs for N=3 memories", async () => {
    const judge = {
      judge: vi.fn().mockResolvedValue({ relation: "relates_to", confidence: 0.9, reason: "" }),
    };
    const r = new IntraTurnRelate(judge as any, { maxPairs: 3 });
    const edges = await r.relate(makeMemories(3));
    expect(judge.judge).toHaveBeenCalledTimes(3);
    expect(edges).toHaveLength(3);
  });

  it("respects maxPairs cap with 5 memories (10 possible pairs → capped at 3)", async () => {
    const judge = {
      judge: vi.fn().mockResolvedValue({ relation: "relates_to", confidence: 0.8, reason: "" }),
    };
    const r = new IntraTurnRelate(judge as any, { maxPairs: 3 });
    await r.relate(makeMemories(5));
    expect(judge.judge).toHaveBeenCalledTimes(3);
  });

  it("filters out unrelated verdicts", async () => {
    const judge = {
      judge: vi.fn()
        .mockResolvedValueOnce({ relation: "relates_to", confidence: 0.9, reason: "a" })
        .mockResolvedValueOnce({ relation: "unrelated", confidence: 0.1, reason: "b" })
        .mockResolvedValueOnce({ relation: "contradicts", confidence: 0.8, reason: "c" }),
    };
    const r = new IntraTurnRelate(judge as any, { maxPairs: 3 });
    const edges = await r.relate(makeMemories(3));
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.relation)).toEqual(["relates_to", "contradicts"]);
  });

  it("edge carries from, to, relation, confidence, reason", async () => {
    const judge = {
      judge: vi.fn().mockResolvedValue({ relation: "merge", confidence: 0.95, reason: "same fact" }),
    };
    const r = new IntraTurnRelate(judge as any, { maxPairs: 3 });
    const edges = await r.relate(makeMemories(2));
    expect(edges[0]).toEqual({ from: "m0", to: "m1", relation: "merge", confidence: 0.95, reason: "same fact" });
  });
});
