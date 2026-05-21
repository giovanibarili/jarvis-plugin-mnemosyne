import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCollection = {
  upsert: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({
    ids: [["wf1"]],
    distances: [[0.1]],
    documents: [["ship-it | Full deploy pipeline | implementation complete | PR merged"]],
    metadatas: [[{ name: "ship-it", trigger: "implementation complete", outcome: "PR merged", confidence: 0.9, reinforcements: 0, applies_to_project: "", step_count: 5 }]],
  }),
};

vi.mock("chromadb", () => ({
  ChromaClient: vi.fn(() => ({
    getOrCreateCollection: vi.fn().mockResolvedValue(mockCollection),
  })),
  DefaultEmbeddingFunction: vi.fn(() => ({})),
}));

import { ChromaAdapter } from "../../../lib/chroma-adapter";

const makeWorkflow = (overrides = {}) => ({
  id: "wf1", name: "ship-it", description: "Full deploy pipeline",
  trigger: "implementation complete, ready to deliver",
  outcome: "PR merged and deployed to production",
  steps: [
    { id: "s1", action: "commit changes", order: 1, tool: null, guard: null, required: true, confirms_required: false },
    { id: "s2", action: "push branch", order: 2, tool: null, guard: null, required: true, confirms_required: false },
    { id: "s3", action: "open PR", order: 3, tool: null, guard: null, required: true, confirms_required: false },
  ],
  branches: [], confidence: 0.9, reinforcements: 0,
  created_at: Date.now(), last_used: Date.now(), applies_to_project: null,
  ...overrides,
});

describe("ChromaAdapter — workflow collection", () => {
  let adapter: ChromaAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ChromaAdapter({ host: "127.0.0.1", port: 8765, embeddingModel: "minilm" });
  });

  it("upsertWorkflow calls collection.upsert with rich content blob", async () => {
    await adapter.upsertWorkflow(makeWorkflow());
    expect(mockCollection.upsert).toHaveBeenCalledOnce();
    const call = mockCollection.upsert.mock.calls[0][0];
    expect(call.ids).toEqual(["wf1"]);
    expect(call.documents[0]).toContain("ship-it");
    expect(call.documents[0]).toContain("implementation complete");
    expect(call.documents[0]).toContain("commit changes");
    expect(call.metadatas[0].name).toBe("ship-it");
    expect(call.metadatas[0].step_count).toBe(3);
  });

  it("queryWorkflows returns WorkflowQueryHit array with id, distance, metadata", async () => {
    const hits = await adapter.queryWorkflows("ready to deploy", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("wf1");
    expect(hits[0].distance).toBeCloseTo(0.1);
    expect(hits[0].metadata.name).toBe("ship-it");
    expect(hits[0].content).toContain("ship-it");
  });

  it("queryWorkflows returns empty array when Chroma returns no results", async () => {
    mockCollection.query.mockResolvedValueOnce({ ids: [[]], distances: [[]], documents: [[]], metadatas: [[]] });
    const hits = await adapter.queryWorkflows("nothing matches", 5);
    expect(hits).toHaveLength(0);
  });

  it("upsertWorkflow content blob includes all step actions joined", async () => {
    const wf = makeWorkflow();
    await adapter.upsertWorkflow(wf);
    const doc = mockCollection.upsert.mock.calls[0][0].documents[0];
    expect(doc).toContain("commit changes");
    expect(doc).toContain("push branch");
    expect(doc).toContain("open PR");
  });
});
