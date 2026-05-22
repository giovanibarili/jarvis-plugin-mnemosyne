import { describe, it, expect, vi } from "vitest";
import { GraphNeighborhoodService } from "../../../lib/graph-neighborhood";

const makeAdapter = (batchResult: Map<string, any>, oneResult?: any) => ({
  getNeighborhoodBatch: vi.fn().mockResolvedValue(batchResult),
  getNeighborhoodOne: vi.fn().mockResolvedValue(
    oneResult ?? { parents: [], children: [], childrenExpanded: [] }
  ),
});

describe("GraphNeighborhoodService", () => {
  it("enrichBatch returns empty map for empty input without calling adapter", async () => {
    const adapter = makeAdapter(new Map());
    const svc = new GraphNeighborhoodService(adapter as any);
    const result = await svc.enrichBatch([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(adapter.getNeighborhoodBatch).not.toHaveBeenCalled();
  });

  it("enrichBatch delegates to adapter and returns map", async () => {
    const m = new Map([["m1", { parents: [], children: [] }]]);
    const adapter = makeAdapter(m);
    const svc = new GraphNeighborhoodService(adapter as any);
    const result = await svc.enrichBatch(["m1"]);
    expect(adapter.getNeighborhoodBatch).toHaveBeenCalledWith(["m1"]);
    expect(result.get("m1")).toMatchObject({ parents: [], children: [] });
  });

  it("enrichOne delegates to adapter and returns expanded neighborhood", async () => {
    const oneResult = {
      parents: [{ id: "p1", title: "P", category: "pref", relation: "relates_to", direction: "incoming", childCount: 0 }],
      children: [{ id: "c1", title: "C", category: "code-pattern", relation: "merge", direction: "outgoing", childCount: 1 }],
      childrenExpanded: [{
        id: "c1", title: "C", category: "code-pattern", relation: "merge", direction: "outgoing", childCount: 1,
        grandchildren: [{ id: "g1", title: "G", category: "pattern", relation: "relates_to", direction: "outgoing", childCount: 0 }],
      }],
    };
    const adapter = makeAdapter(new Map(), oneResult);
    const svc = new GraphNeighborhoodService(adapter as any);
    const result = await svc.enrichOne("m1");
    expect(adapter.getNeighborhoodOne).toHaveBeenCalledWith("m1");
    expect(result.parents).toHaveLength(1);
    expect(result.childrenExpanded).toHaveLength(1);
    expect(result.childrenExpanded[0].grandchildren).toHaveLength(1);
  });

  it("enrichBatch caps parents to maxParents config", async () => {
    const manyParents = Array.from({ length: 15 }, (_, i) => ({
      id: `p${i}`, title: `P${i}`, category: "pref",
      relation: "relates_to", direction: "incoming", childCount: 0,
    }));
    const m = new Map([["m1", { parents: manyParents, children: [] }]]);
    const svc = new GraphNeighborhoodService(makeAdapter(m) as any, { maxParents: 10, maxChildren: 20 });
    const result = await svc.enrichBatch(["m1"]);
    expect(result.get("m1")!.parents).toHaveLength(10);
  });

  it("enrichBatch caps children to maxChildren config", async () => {
    const manyChildren = Array.from({ length: 25 }, (_, i) => ({
      id: `c${i}`, title: `C${i}`, category: "code-pattern",
      relation: "relates_to", direction: "outgoing", childCount: 0,
    }));
    const m = new Map([["m1", { parents: [], children: manyChildren }]]);
    const svc = new GraphNeighborhoodService(makeAdapter(m) as any, { maxParents: 10, maxChildren: 20 });
    const result = await svc.enrichBatch(["m1"]);
    expect(result.get("m1")!.children).toHaveLength(20);
  });
});
