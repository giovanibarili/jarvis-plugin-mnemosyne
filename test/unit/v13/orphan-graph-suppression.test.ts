/**
 * BDD T13-5, T13-6, T13-7 — Orphan graph hit suppression.
 *
 * Regression for the 14:47 Groq Whisper turn bug where 7 negative-sim vectors
 * acted as graph seeds, producing 4 orphan graph hits in the final injection.
 *
 * Spec memories: kmp3qz (code-pattern), kiib1l (architecture-decision),
 *                v2kjtk (anti-pattern), f5okki (mental-model).
 *
 * Strategy: cover the pure decision logic that decides which memories
 * become graph seeds and which graph hits survive the topK slicing.
 * These functions are extracted from RetrieverPiece.retrieve() so the
 * complex DB-bound pipeline doesn't need to be mocked end-to-end.
 */
import { describe, it, expect } from "vitest";
import { pickGraphSeeds, selectTopHits } from "../../../pieces/retriever.js";
import type { RetrievalHit, Memory } from "../../../lib/types.js";

const M = (id: string, overrides: Partial<Memory> = {}): Memory => ({
  id,
  title: `Memory ${id}`,
  content: "",
  category: "preference",
  tags: [],
  project: null,
  visibility: "open",
  pinned: false,
  source_session: "test",
  created_at: Date.now(),
  last_accessed: Date.now(),
  promoted_at: null,
  confidence: 0.8,
  reinforcements: 0,
  ...overrides,
});

const vectorHit = (id: string, sim: number): RetrievalHit => ({
  memory: M(id),
  score: sim,
  source: "vector",
  vectorSim: sim,
});

const graphHit = (id: string, seedId: string): RetrievalHit => ({
  memory: M(id),
  score: 0.5,
  source: "graph",
  seedId, // ← new field
});

describe("T13-5: pickGraphSeeds — orphan prevention", () => {
  it("returns only memories with vectorSim >= 0", () => {
    const memories: RetrievalHit[] = [
      vectorHit("V_pos", 0.4),
      vectorHit("V_neg1", -0.2),
      vectorHit("V_neg2", -0.3),
    ];
    const seeds = pickGraphSeeds(memories);
    expect(seeds.map((m) => m.memory.id)).toEqual(["V_pos"]);
  });

  it("returns empty when all vectors are negative-sim", () => {
    const memories: RetrievalHit[] = [
      vectorHit("V_neg1", -0.1),
      vectorHit("V_neg2", -0.5),
    ];
    expect(pickGraphSeeds(memories)).toEqual([]);
  });

  it("ignores graph hits (only vector seeds count)", () => {
    const memories: RetrievalHit[] = [
      vectorHit("V_pos", 0.4),
      graphHit("G_x", "V_pos"),
    ];
    const seeds = pickGraphSeeds(memories);
    expect(seeds.map((m) => m.memory.id)).toEqual(["V_pos"]);
  });

  it("treats missing vectorSim as ineligible (defensive)", () => {
    const memories: RetrievalHit[] = [
      { memory: M("V_unknown"), score: 0.5, source: "vector" }, // no vectorSim
      vectorHit("V_pos", 0.3),
    ];
    expect(pickGraphSeeds(memories).map((m) => m.memory.id)).toEqual(["V_pos"]);
  });
});

describe("T13-6: selectTopHits — graph hits only when seed survives", () => {
  it("keeps graph hits whose seedId is in topVector", () => {
    const reranked: RetrievalHit[] = [
      vectorHit("V_a", 0.8),
      vectorHit("V_b", 0.6),
      graphHit("N_b", "V_b"), // seed V_b survives
    ];
    const top = selectTopHits(reranked, { topK: 3, minVectorSlots: 2 });
    expect(top.map((h) => h.memory.id)).toEqual(["V_a", "V_b", "N_b"]);
  });

  it("drops graph hits whose seedId was cut by minVectorSlots", () => {
    const reranked: RetrievalHit[] = [
      vectorHit("V_a", 0.8),
      vectorHit("V_b", 0.6),
      vectorHit("V_c", 0.5), // will be cut (slot=2)
      graphHit("N_c", "V_c"), // orphan after cut
    ];
    const top = selectTopHits(reranked, { topK: 3, minVectorSlots: 2 });
    expect(top.map((h) => h.memory.id)).toEqual(["V_a", "V_b"]);
    expect(top.some((h) => h.memory.id === "N_c")).toBe(false);
  });

  it("regression: 1 positive + 7 negative vectors + 4 graph orphans → only 1 hit", () => {
    // Reproduces 14:47 Groq Whisper turn shape exactly.
    const reranked: RetrievalHit[] = [
      vectorHit("V_pos", 0.14),
      vectorHit("V_neg1", -0.1),
      vectorHit("V_neg2", -0.2),
      vectorHit("V_neg3", -0.3),
      graphHit("G_orphan1", "V_neg1"),
      graphHit("G_orphan2", "V_neg2"),
      graphHit("G_orphan3", "V_neg3"),
      graphHit("G_orphan4", "V_neg1"),
    ];
    const top = selectTopHits(reranked, { topK: 5, minVectorSlots: 2 });
    expect(top.length).toBe(1);
    expect(top[0].memory.id).toBe("V_pos");
  });
});

describe("T13-7: selectTopHits — no positive vectors → empty injection", () => {
  it("returns empty array when no vector has sim >= 0", () => {
    const reranked: RetrievalHit[] = [
      vectorHit("V_neg1", -0.1),
      vectorHit("V_neg2", -0.5),
      graphHit("G1", "V_neg1"),
      graphHit("G2", "V_neg2"),
    ];
    const top = selectTopHits(reranked, { topK: 5, minVectorSlots: 2 });
    expect(top).toEqual([]);
  });

  it("returns empty when reranked is empty", () => {
    expect(selectTopHits([], { topK: 5, minVectorSlots: 2 })).toEqual([]);
  });
});
