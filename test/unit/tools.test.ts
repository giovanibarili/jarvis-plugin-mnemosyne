import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityDefinition } from "@jarvis/core";
import type { Memory, Workflow } from "../../lib/types";
import type { MnemosyneStore } from "../../lib/store";
import type { Neo4jAdapter } from "../../lib/neo4j-adapter";
import type { ConsolidatorPiece } from "../../pieces/consolidator";
import type { ReplayEngine } from "../../lib/replay-engine";

import {
  buildMemorySearchTool,
  buildMemoryGetTool,
  buildMemoryListTool,
  buildMemoryExplainTool,
  computeScoreBreakdown,
  resolveMemoryId,
} from "../../lib/tools/memory-search";
import {
  buildMemoryUpdateTool,
  buildMemoryPinTool,
  buildMemoryUnpinTool,
  buildMemoryDeleteTool,
  buildMemoryPromoteTool,
} from "../../lib/tools/memory-management";
import {
  buildWorkflowListTool,
  buildWorkflowGetTool,
  buildWorkflowReplayTool,
} from "../../lib/tools/workflow-tools";
import {
  buildMnemosyneConsolidateTool,
  buildMnemosyneStatsTool,
  __resetLastConsolidatorRun,
} from "../../lib/tools/admin-tools";

/* -------------------------------------------------------------- helpers ---- */

function mem(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    category: "preference",
    title: "prefer dark mode",
    content: "User prefers dark mode UI.",
    tags: ["ui"],
    project: null,
    confidence: 0.9,
    reinforcements: 2,
    visibility: "open",
    pinned: false,
    created_at: 1700000000000,
    last_accessed: 1700000000000,
    source_session: "s1",
    promoted_at: null,
    ...overrides,
  };
}

function wf(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    name: "deploy",
    description: "Deploy a service",
    trigger: "ready to deploy",
    outcome: "service deployed",
    applies_to_project: null,
    confidence: 0.8,
    reinforcements: 1,
    created_at: 1700000000000,
    last_used: 1700000000000,
    branches: [],
    steps: [
      {
        id: "s1",
        order: 1,
        action: "lint-fix on $project",
        tool: "bash",
        guard: null,
        required: true,
        confirms_required: false,
      },
      {
        id: "s2",
        order: 2,
        action: "tests",
        tool: "bash",
        guard: null,
        required: true,
        confirms_required: false,
      },
    ],
    ...overrides,
  };
}

function makeStore(opts: {
  memories?: Memory[];
  chromaHits?: Array<{ id: string; distance: number; layer?: "short" | "long" }>;
  chromaQueryFails?: boolean;
  writeFails?: boolean;
  deleteFails?: boolean;
  promoteFails?: boolean;
} = {}): MnemosyneStore {
  const memories = opts.memories ?? [];
  const writeSpy = vi.fn().mockImplementation(async (m: Memory) => {
    if (opts.writeFails) throw new Error("write boom");
    const idx = memories.findIndex((x) => x.id === m.id);
    if (idx >= 0) memories[idx] = m;
    else memories.push(m);
  });
  const deleteSpy = vi.fn().mockImplementation(async (id: string) => {
    if (opts.deleteFails) throw new Error("delete boom");
    const idx = memories.findIndex((x) => x.id === id);
    if (idx >= 0) memories.splice(idx, 1);
  });
  const promoteSpy = vi.fn().mockImplementation(async (id: string) => {
    if (opts.promoteFails) throw new Error("promote boom");
    const m = memories.find((x) => x.id === id);
    if (m && !m.promoted_at) m.promoted_at = Date.now();
  });
  const queryByLayer = (layer: "short" | "long") => {
    if (opts.chromaQueryFails) throw new Error("chroma down");
    return (opts.chromaHits ?? []).filter(
      (h) => (h.layer ?? "short") === layer
    );
  };
  return {
    markdownStore: {
      read: vi.fn().mockImplementation(async (id: string) => {
        return memories.find((m) => m.id === id) ?? null;
      }),
      list: vi.fn().mockImplementation(async (filter: any) => {
        let out = [...memories];
        if (filter?.category) out = out.filter((m) => m.category === filter.category);
        if (filter?.layer === "short") out = out.filter((m) => !m.promoted_at);
        if (filter?.layer === "long") out = out.filter((m) => m.promoted_at);
        if (filter?.pinned !== undefined)
          out = out.filter((m) => m.pinned === filter.pinned);
        return out;
      }),
      write: vi.fn(),
      delete: vi.fn(),
      promote: vi.fn(),
    },
    chroma: {
      query: vi.fn().mockImplementation(async (layer: "short" | "long") => {
        return queryByLayer(layer);
      }),
      count: vi.fn().mockResolvedValue(0),
      upsert: vi.fn(),
      delete: vi.fn(),
      move: vi.fn(),
    },
    neo4j: {
      upsertMemory: vi.fn(),
      deleteMemory: vi.fn(),
      incrementReinforcements: vi.fn(),
      markPromoted: vi.fn(),
    },
    write: writeSpy,
    delete: deleteSpy,
    promote: promoteSpy,
    incrementReinforcements: vi.fn(),
  } as unknown as MnemosyneStore;
}

const WEIGHTS = {
  recency: 0.25,
  confidence: 0.3,
  reinforcements: 0.25,
  graph_distance: 0.2,
};

/* -------------------------------------------------------------- tests ----- */

describe("CapabilityDefinition shape", () => {
  it("every builder returns the @jarvis/core CapabilityDefinition shape", () => {
    const store = makeStore();
    const neo4j = {
      listWorkflows: vi.fn(),
      getWorkflow: vi.fn(),
    } as unknown as Neo4jAdapter;
    const consolidator = {
      run: vi.fn(),
      setLastActivityTs: vi.fn(),
    } as unknown as ConsolidatorPiece;
    const replay = {} as ReplayEngine;

    const defs: CapabilityDefinition[] = [
      buildMemorySearchTool(store),
      buildMemoryGetTool(store),
      buildMemoryListTool(store),
      buildMemoryExplainTool(store, WEIGHTS),
      buildMemoryUpdateTool(store),
      buildMemoryPinTool(store),
      buildMemoryUnpinTool(store),
      buildMemoryDeleteTool(store),
      buildMemoryPromoteTool(store),
      buildWorkflowListTool(neo4j),
      buildWorkflowGetTool(neo4j),
      buildWorkflowReplayTool(neo4j, replay),
      buildMnemosyneConsolidateTool(consolidator),
      buildMnemosyneStatsTool(store),
    ];

    expect(defs).toHaveLength(14);
    for (const d of defs) {
      expect(typeof d.name).toBe("string");
      expect(typeof d.description).toBe("string");
      expect(typeof d.input_schema).toBe("object");
      expect((d.input_schema as any).type).toBe("object");
      expect(typeof d.handler).toBe("function");
    }
    // Names match the spec exactly (order-independent)
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        "memory_search",
        "memory_get",
        "memory_list",
        "memory_update",
        "memory_pin",
        "memory_unpin",
        "memory_delete",
        "memory_promote",
        "memory_explain",
        "workflow_list",
        "workflow_get",
        "workflow_replay",
        "mnemosyne_consolidate",
        "mnemosyne_stats",
      ].sort()
    );
  });
});

describe("memory_search", () => {
  it("queries both layers, dedups, returns ranked results", async () => {
    const m1 = mem({ id: "aaa-1", title: "A" });
    const m2 = mem({ id: "bbb-2", title: "B", promoted_at: 1700000100000 });
    const store = makeStore({
      memories: [m1, m2],
      chromaHits: [
        { id: "aaa-1", distance: 0.3, layer: "short" },
        { id: "bbb-2", distance: 0.1, layer: "long" },
      ],
    });
    const tool = buildMemorySearchTool(store);
    const out = (await tool.handler({ query: "ui", k: 5 })) as {
      results: Array<{ id: string; score: number; layer: string }>;
    };
    expect(out.results).toHaveLength(2);
    // Closest distance (highest score) ranks first
    expect(out.results[0].id).toBe("bbb-2");
    expect(out.results[0].layer).toBe("long");
    expect(out.results[0].score).toBeCloseTo(0.9);
  });

  it("returns error when query missing", async () => {
    const tool = buildMemorySearchTool(makeStore());
    const out = (await tool.handler({} as any)) as { error: string };
    expect(out.error).toMatch(/query/);
  });
});

describe("memory_get", () => {
  it("returns memory by full id", async () => {
    const m = mem();
    const store = makeStore({ memories: [m] });
    const tool = buildMemoryGetTool(store);
    const out = (await tool.handler({ id: m.id })) as Memory;
    expect(out.id).toBe(m.id);
  });

  it("resolves unique short prefix (>=4 chars)", async () => {
    const m = mem({ id: "abcd1234-rest" });
    const store = makeStore({ memories: [m] });
    const tool = buildMemoryGetTool(store);
    const out = (await tool.handler({ id: "abcd" })) as Memory;
    expect(out.id).toBe(m.id);
  });

  it("returns error for ambiguous prefix", async () => {
    const a = mem({ id: "abcd-1111" });
    const b = mem({ id: "abcd-2222" });
    const store = makeStore({ memories: [a, b] });
    const tool = buildMemoryGetTool(store);
    const out = (await tool.handler({ id: "abcd" })) as { error: string };
    expect(out.error).toBe("not found");
  });

  it("returns error when missing", async () => {
    const store = makeStore({ memories: [] });
    const tool = buildMemoryGetTool(store);
    const out = (await tool.handler({ id: "deadbeef-xxxx" })) as {
      error: string;
    };
    expect(out.error).toBe("not found");
  });
});

describe("memory_list", () => {
  it("paginates with limit/offset and returns total", async () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      mem({ id: `id-${i}`, title: `m${i}` })
    );
    const store = makeStore({ memories });
    const tool = buildMemoryListTool(store);
    const out = (await tool.handler({ limit: 2, offset: 1 })) as {
      memories: Memory[];
      total: number;
    };
    expect(out.total).toBe(5);
    expect(out.memories).toHaveLength(2);
    expect(out.memories[0].id).toBe("id-1");
  });

  it("filters by project", async () => {
    const a = mem({ id: "a", project: "proj-x" });
    const b = mem({ id: "b", project: "proj-y" });
    const store = makeStore({ memories: [a, b] });
    const tool = buildMemoryListTool(store);
    const out = (await tool.handler({ project: "proj-x" })) as {
      memories: Memory[];
    };
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0].id).toBe("a");
  });
});

describe("memory_update", () => {
  it("applies whitelisted patch and writes through store", async () => {
    const m = mem();
    const store = makeStore({ memories: [m] });
    const tool = buildMemoryUpdateTool(store);
    const out = (await tool.handler({
      id: m.id,
      patch: { title: "new", pinned: true },
    })) as { ok: boolean; id: string };
    expect(out.ok).toBe(true);
    expect(out.id).toBe(m.id);
    expect(store.write).toHaveBeenCalledWith(
      expect.objectContaining({ title: "new", pinned: true })
    );
  });

  it("returns error when patch missing", async () => {
    const m = mem();
    const store = makeStore({ memories: [m] });
    const tool = buildMemoryUpdateTool(store);
    const out = (await tool.handler({ id: m.id } as any)) as { error: string };
    expect(out.error).toMatch(/patch/);
  });

  it("returns error on store.write failure", async () => {
    const m = mem();
    const store = makeStore({ memories: [m], writeFails: true });
    const tool = buildMemoryUpdateTool(store);
    const out = (await tool.handler({
      id: m.id,
      patch: { title: "x" },
    })) as { error: string };
    expect(out.error).toMatch(/update failed/);
  });
});

describe("memory_pin / memory_unpin", () => {
  it("memory_pin sets pinned=true", async () => {
    const m = mem({ pinned: false });
    const store = makeStore({ memories: [m] });
    const tool = buildMemoryPinTool(store);
    const out = (await tool.handler({ id: m.id })) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(store.write).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: true })
    );
  });

  it("memory_pin is idempotent on already-pinned", async () => {
    const m = mem({ pinned: true });
    const store = makeStore({ memories: [m] });
    const tool = buildMemoryPinTool(store);
    const out = (await tool.handler({ id: m.id })) as {
      ok: boolean;
      already_pinned?: boolean;
    };
    expect(out.ok).toBe(true);
    expect(out.already_pinned).toBe(true);
    expect(store.write).not.toHaveBeenCalled();
  });

  it("memory_unpin sets pinned=false", async () => {
    const m = mem({ pinned: true });
    const store = makeStore({ memories: [m] });
    const tool = buildMemoryUnpinTool(store);
    const out = (await tool.handler({ id: m.id })) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(store.write).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: false })
    );
  });
});

describe("memory_delete", () => {
  it("calls store.delete and returns ok", async () => {
    const m = mem();
    const store = makeStore({ memories: [m] });
    const tool = buildMemoryDeleteTool(store);
    const out = (await tool.handler({ id: m.id })) as { ok: boolean; id: string };
    expect(out.ok).toBe(true);
    expect(out.id).toBe(m.id);
    expect(store.delete).toHaveBeenCalledWith(m.id);
  });

  it("returns error when missing", async () => {
    const store = makeStore({ memories: [] });
    const tool = buildMemoryDeleteTool(store);
    const out = (await tool.handler({ id: "missing-id-xxxx" })) as {
      error: string;
    };
    expect(out.error).toBe("not found");
  });
});

describe("memory_promote", () => {
  it("promotes a short-term memory", async () => {
    const m = mem({ promoted_at: null });
    const store = makeStore({ memories: [m] });
    const tool = buildMemoryPromoteTool(store);
    const out = (await tool.handler({ id: m.id })) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(store.promote).toHaveBeenCalledWith(m.id);
  });

  it("is no-op for already promoted", async () => {
    const m = mem({ promoted_at: 1700000100000 });
    const store = makeStore({ memories: [m] });
    const tool = buildMemoryPromoteTool(store);
    const out = (await tool.handler({ id: m.id })) as {
      ok: boolean;
      already_promoted?: boolean;
    };
    expect(out.ok).toBe(true);
    expect(out.already_promoted).toBe(true);
    expect(store.promote).not.toHaveBeenCalled();
  });
});

describe("memory_explain", () => {
  it("returns score breakdown components", async () => {
    const now = Date.now();
    const m = mem({
      last_accessed: now - 1000 * 60 * 60 * 24 * 30,
      confidence: 0.8,
      reinforcements: 5,
    });
    const store = makeStore({ memories: [m] });
    const tool = buildMemoryExplainTool(store, WEIGHTS);
    const out = (await tool.handler({ id: m.id, query: "ui" })) as {
      recency: number;
      confidence: number;
      reinforcements: number;
      graphDistance: number;
      total: number;
    };
    expect(out.recency).toBeGreaterThan(0);
    expect(out.recency).toBeLessThanOrEqual(1);
    expect(out.confidence).toBe(0.8);
    expect(out.reinforcements).toBeCloseTo(0.5, 5);
    expect(out.graphDistance).toBe(1.0);
    expect(out.total).toBeGreaterThan(0);
  });

  it("returns error when missing id", async () => {
    const store = makeStore({ memories: [] });
    const tool = buildMemoryExplainTool(store, WEIGHTS);
    const out = (await tool.handler({ id: "x", query: "y" })) as {
      error: string;
    };
    expect(out.error).toBe("not found");
  });

  it("computeScoreBreakdown matches reranker formula for known inputs", () => {
    const now = 1_700_000_000_000;
    const m = mem({
      last_accessed: now,
      confidence: 1,
      reinforcements: 10,
    });
    const out = computeScoreBreakdown(m, WEIGHTS, "vector", now);
    // ageDays=0 → recency=1, confidence=1, reinforcements=1, graphDistance=1
    // total = 1*0.25 + 1*0.3 + 1*0.25 + 1*0.2 = 1.0
    expect(out.recency).toBeCloseTo(1, 5);
    expect(out.total).toBeCloseTo(1.0, 5);
  });

  it("graphDistance lowers when source=graph", () => {
    const now = 1_700_000_000_000;
    const m = mem({ last_accessed: now });
    const v = computeScoreBreakdown(m, WEIGHTS, "vector", now);
    const g = computeScoreBreakdown(m, WEIGHTS, "graph", now);
    expect(g.graphDistance).toBe(0.5);
    expect(v.graphDistance).toBe(1.0);
    expect(g.total).toBeLessThan(v.total);
  });
});

describe("workflow_list", () => {
  it("delegates to neo4j.listWorkflows with project filter", async () => {
    const list = vi.fn().mockResolvedValue([wf()]);
    const neo4j = { listWorkflows: list } as unknown as Neo4jAdapter;
    const tool = buildWorkflowListTool(neo4j);
    const out = (await tool.handler({ project: "p" })) as {
      workflows: Workflow[];
    };
    expect(list).toHaveBeenCalledWith({ project: "p" });
    expect(out.workflows).toHaveLength(1);
  });

  it("calls without filter when project absent", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const neo4j = { listWorkflows: list } as unknown as Neo4jAdapter;
    const tool = buildWorkflowListTool(neo4j);
    await tool.handler({});
    expect(list).toHaveBeenCalledWith(undefined);
  });
});

describe("workflow_get", () => {
  it("returns the workflow when found", async () => {
    const w = wf();
    const get = vi.fn().mockResolvedValue(w);
    const neo4j = { getWorkflow: get } as unknown as Neo4jAdapter;
    const tool = buildWorkflowGetTool(neo4j);
    const out = (await tool.handler({ idOrName: "deploy" })) as Workflow;
    expect(out.id).toBe("wf-1");
  });

  it("returns not found", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const neo4j = { getWorkflow: get } as unknown as Neo4jAdapter;
    const tool = buildWorkflowGetTool(neo4j);
    const out = (await tool.handler({ idOrName: "nope" })) as { error: string };
    expect(out.error).toBe("not found");
  });
});

describe("workflow_replay", () => {
  it("returns plan with $vars substituted", async () => {
    const w = wf();
    const get = vi.fn().mockResolvedValue(w);
    const neo4j = { getWorkflow: get } as unknown as Neo4jAdapter;
    const tool = buildWorkflowReplayTool(neo4j, {} as ReplayEngine);
    const out = (await tool.handler({
      idOrName: "deploy",
      vars: { project: "saa" },
    })) as {
      workflow: { name: string };
      steps_to_replay: Array<{
        action: string;
        unresolved_vars: string[];
      }>;
      message: string;
    };
    expect(out.workflow.name).toBe("deploy");
    expect(out.steps_to_replay[0].action).toBe("lint-fix on saa");
    expect(out.steps_to_replay[0].unresolved_vars).toEqual([]);
    expect(out.message).toMatch(/HUD/);
  });

  it("flags unresolved vars when none provided", async () => {
    const w = wf();
    const get = vi.fn().mockResolvedValue(w);
    const neo4j = { getWorkflow: get } as unknown as Neo4jAdapter;
    const tool = buildWorkflowReplayTool(neo4j, {} as ReplayEngine);
    const out = (await tool.handler({ idOrName: "deploy" })) as {
      steps_to_replay: Array<{
        action: string;
        unresolved_vars: string[];
      }>;
    };
    expect(out.steps_to_replay[0].unresolved_vars).toEqual(["project"]);
    expect(out.steps_to_replay[0].action).toBe("lint-fix on $project");
  });
});

describe("mnemosyne_consolidate", () => {
  beforeEach(() => __resetLastConsolidatorRun());

  it("calls consolidator.run() and returns stats + ran_at", async () => {
    const stats = { promoted: 1, decayed: 0, conflicts: 0, merged: 0 };
    const consolidator = {
      run: vi.fn().mockResolvedValue(stats),
      setLastActivityTs: vi.fn(),
    } as unknown as ConsolidatorPiece;
    const tool = buildMnemosyneConsolidateTool(consolidator);
    const out = (await tool.handler({})) as typeof stats & { ran_at: string };
    expect(out.promoted).toBe(1);
    expect(typeof out.ran_at).toBe("string");
    expect(consolidator.setLastActivityTs).not.toHaveBeenCalled();
  });

  it("force=true bypasses active-recently guard", async () => {
    const consolidator = {
      run: vi.fn().mockResolvedValue({ promoted: 0, decayed: 0, conflicts: 0, merged: 0 }),
      setLastActivityTs: vi.fn(),
    } as unknown as ConsolidatorPiece;
    const tool = buildMnemosyneConsolidateTool(consolidator);
    await tool.handler({ force: true });
    expect(consolidator.setLastActivityTs).toHaveBeenCalledWith(0);
  });
});

describe("mnemosyne_stats", () => {
  beforeEach(() => __resetLastConsolidatorRun());

  it("returns counters across the store", async () => {
    const memories = [
      mem({ id: "a", category: "preference", promoted_at: null }),
      mem({ id: "b", category: "preference", promoted_at: 1700000100000 }),
      mem({ id: "c", category: "code-pattern", pinned: true, promoted_at: null }),
    ];
    const store = makeStore({ memories });
    const tool = buildMnemosyneStatsTool(store);
    const out = (await tool.handler({})) as {
      total: number;
      short: number;
      long: number;
      pinned: number;
      by_category: Record<string, number>;
      last_consolidator_run: string | null;
    };
    expect(out.total).toBe(3);
    expect(out.short).toBe(2);
    expect(out.long).toBe(1);
    expect(out.pinned).toBe(1);
    expect(out.by_category.preference).toBe(2);
    expect(out.by_category["code-pattern"]).toBe(1);
    expect(out.by_category.glossary).toBe(0);
    expect(out.last_consolidator_run).toBeNull();
  });

  it("last_consolidator_run is updated after consolidate runs", async () => {
    const consolidator = {
      run: vi.fn().mockResolvedValue({ promoted: 0, decayed: 0, conflicts: 0, merged: 0 }),
      setLastActivityTs: vi.fn(),
    } as unknown as ConsolidatorPiece;
    const store = makeStore({ memories: [] });
    const consolidateTool = buildMnemosyneConsolidateTool(consolidator);
    const statsTool = buildMnemosyneStatsTool(store);

    expect(((await statsTool.handler({})) as any).last_consolidator_run).toBeNull();
    await consolidateTool.handler({});
    const out = (await statsTool.handler({})) as { last_consolidator_run: string };
    expect(out.last_consolidator_run).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("resolveMemoryId edge cases", () => {
  it("rejects prefixes shorter than 4 chars", async () => {
    const m = mem({ id: "abcd1234" });
    const store = makeStore({ memories: [m] });
    const got = await resolveMemoryId(store, "abc");
    expect(got).toBeNull();
  });

  it("returns null for empty input", async () => {
    const store = makeStore({ memories: [] });
    expect(await resolveMemoryId(store, "")).toBeNull();
  });
});
