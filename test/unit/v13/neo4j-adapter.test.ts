import { describe, it, expect, vi } from "vitest";

vi.mock("neo4j-driver", () => ({
  default: {
    driver: vi.fn(() => ({
      session: vi.fn(() => ({ run: vi.fn(), close: vi.fn() })),
      close: vi.fn(),
    })),
    auth: { basic: vi.fn(() => ({})) },
    integer: {
      toNumber: (n: any) =>
        typeof n === "object" && n !== null ? n.low ?? 0 : n ?? 0,
    },
  },
}));

import { Neo4jAdapter } from "../../../lib/neo4j-adapter";

describe("Neo4jAdapter v1.3 methods", () => {
  it("getNeighborhoodBatch returns empty map for empty input", async () => {
    const adapter = new Neo4jAdapter({ uri: "bolt://127.0.0.1:7687" });
    (adapter as any).runQuery = vi.fn().mockResolvedValue([]);
    const result = await adapter.getNeighborhoodBatch([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("getNeighborhoodBatch parses parent rows correctly", async () => {
    const adapter = new Neo4jAdapter({ uri: "bolt://127.0.0.1:7687" });
    (adapter as any).runQuery = vi.fn().mockResolvedValue([
      {
        rootId: "m1",
        parentId: "p1",
        parentTitle: "Parent",
        parentCategory: "preference",
        parentRelation: "relates_to",
        parentChildCount: { low: 3, high: 0 },
        childId: null,
        childTitle: null,
        childCategory: null,
        childRelation: null,
        childGrandchildCount: { low: 0, high: 0 },
      },
    ]);
    const result = await adapter.getNeighborhoodBatch(["m1"]);
    const n = result.get("m1")!;
    expect(n.parents).toHaveLength(1);
    expect(n.parents[0]).toMatchObject({
      id: "p1",
      title: "Parent",
      childCount: 3,
      direction: "incoming",
    });
    expect(n.children).toHaveLength(0);
  });

  it("getNeighborhoodBatch parses child rows correctly", async () => {
    const adapter = new Neo4jAdapter({ uri: "bolt://127.0.0.1:7687" });
    (adapter as any).runQuery = vi.fn().mockResolvedValue([
      {
        rootId: "m1",
        parentId: null,
        parentTitle: null,
        parentCategory: null,
        parentRelation: null,
        parentChildCount: { low: 0, high: 0 },
        childId: "c1",
        childTitle: "Child",
        childCategory: "code-pattern",
        childRelation: "contradicts",
        childGrandchildCount: { low: 5, high: 0 },
      },
    ]);
    const result = await adapter.getNeighborhoodBatch(["m1"]);
    const n = result.get("m1")!;
    expect(n.children).toHaveLength(1);
    expect(n.children[0]).toMatchObject({
      id: "c1",
      childCount: 5,
      direction: "outgoing",
      relation: "contradicts",
    });
  });

  it("getNeighborhoodOne returns expanded neighborhood with grandchildren", async () => {
    const adapter = new Neo4jAdapter({ uri: "bolt://127.0.0.1:7687" });
    (adapter as any).runQuery = vi.fn().mockResolvedValue([
      {
        parentId: "p1",
        parentTitle: "P",
        parentCategory: "pref",
        parentRelation: "relates_to",
        childId: "c1",
        childTitle: "C",
        childCategory: "code-pattern",
        childRelation: "merge",
        grandchildId: "g1",
        grandchildTitle: "G",
        grandchildCategory: "pattern",
        grandchildRelation: "relates_to",
      },
    ]);
    const n = await adapter.getNeighborhoodOne("m1");
    expect(n.parents).toHaveLength(1);
    expect(n.childrenExpanded).toHaveLength(1);
    expect(n.childrenExpanded[0].grandchildren).toHaveLength(1);
    expect(n.childrenExpanded[0].grandchildren[0].id).toBe("g1");
  });
});
