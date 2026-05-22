import { describe, it, expect, vi } from "vitest";
import { buildMemoryFetchTool } from "../../../lib/tools/memory-fetch";

const makeMemory = (overrides = {}) => ({
  id: "m1",
  title: "Likes PG",
  content: "User likes Postgres",
  category: "preference",
  confidence: 0.9,
  evidence: "I like PG",
  created_at: "2026-05-21T10:00:00Z",
  origin_source: "user",
  tags: [],
  project: null,
  visibility: "open",
  pinned: false,
  reinforcements: 0,
  last_accessed: null,
  source_session: "s",
  promoted_at: null,
  ...overrides,
});

const makeGraphSvc = (result: any) => ({
  enrichOne: vi.fn().mockResolvedValue(result),
});

describe("memory_fetch tool", () => {
  it("has correct name and input schema", () => {
    const tool = buildMemoryFetchTool({} as any, {} as any);
    expect(tool.name).toBe("memory_fetch");
    const schema = tool.input_schema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.properties.id).toBeDefined();
    expect(schema.required).toContain("id");
  });

  it("returns not-found message for missing id", async () => {
    const store = { get: vi.fn().mockResolvedValue(null) };
    const tool = buildMemoryFetchTool(store as any, makeGraphSvc({}) as any);
    const result = await tool.handler({ id: "missing" });
    expect(result).toMatch(/not found/i);
  });

  it("returns memory title and content", async () => {
    const memory = makeMemory();
    const store = { get: vi.fn().mockResolvedValue(memory) };
    const neighborhood = { parents: [], children: [], childrenExpanded: [] };
    const tool = buildMemoryFetchTool(store as any, makeGraphSvc(neighborhood) as any);
    const result = await tool.handler({ id: "m1" });
    expect(result).toContain("Likes PG");
    expect(result).toContain("User likes Postgres");
    expect(result).toContain("I like PG");
  });

  it("renders parent with ↑ arrow", async () => {
    const store = { get: vi.fn().mockResolvedValue(makeMemory()) };
    const neighborhood = {
      parents: [
        {
          id: "p1",
          title: "Parent",
          category: "pref",
          relation: "relates_to",
          direction: "incoming",
          childCount: 3,
        },
      ],
      children: [],
      childrenExpanded: [],
    };
    const tool = buildMemoryFetchTool(store as any, makeGraphSvc(neighborhood) as any);
    const result = await tool.handler({ id: "m1" });
    expect(result).toContain("↑");
    expect(result).toContain("Parent");
    expect(result).toContain("relates_to");
  });

  it("renders child with ↓ arrow and grandchildren with →", async () => {
    const store = { get: vi.fn().mockResolvedValue(makeMemory()) };
    const neighborhood = {
      parents: [],
      children: [
        {
          id: "c1",
          title: "Child",
          category: "code-pattern",
          relation: "contradicts",
          direction: "outgoing",
          childCount: 1,
        },
      ],
      childrenExpanded: [
        {
          id: "c1",
          title: "Child",
          category: "code-pattern",
          relation: "contradicts",
          direction: "outgoing",
          childCount: 1,
          grandchildren: [
            {
              id: "g1",
              title: "Grandchild",
              category: "pattern",
              relation: "relates_to",
              direction: "outgoing",
              childCount: 0,
            },
          ],
        },
      ],
    };
    const tool = buildMemoryFetchTool(store as any, makeGraphSvc(neighborhood) as any);
    const result = await tool.handler({ id: "m1" });
    expect(result).toContain("↓");
    expect(result).toContain("Child");
    expect(result).toContain("→");
    expect(result).toContain("Grandchild");
  });

  it("includes navigation hint when relations exist", async () => {
    const store = { get: vi.fn().mockResolvedValue(makeMemory()) };
    const neighborhood = {
      parents: [
        {
          id: "p1",
          title: "P",
          category: "pref",
          relation: "relates_to",
          direction: "incoming",
          childCount: 0,
        },
      ],
      children: [],
      childrenExpanded: [],
    };
    const tool = buildMemoryFetchTool(store as any, makeGraphSvc(neighborhood) as any);
    const result = await tool.handler({ id: "m1" });
    expect(result).toContain("memory_fetch");
  });

  it("does NOT include navigation hint when no relations", async () => {
    const store = { get: vi.fn().mockResolvedValue(makeMemory()) };
    const neighborhood = { parents: [], children: [], childrenExpanded: [] };
    const tool = buildMemoryFetchTool(store as any, makeGraphSvc(neighborhood) as any);
    const result = await tool.handler({ id: "m1" });
    expect(result).not.toContain("memory_fetch(id)");
  });
});
