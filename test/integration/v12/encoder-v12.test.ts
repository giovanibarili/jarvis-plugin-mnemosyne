import { describe, it, expect } from "vitest";
import { join } from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { EncoderV12 } from "../../../lib/v12/encoder-v12";
import { CategoryCatalog } from "../../../lib/v12/category-catalog";
import { PendingCategoriesStore } from "../../../lib/v12/pending-categories-store";

const TRIAGE = join(__dirname, "../../../prompts/triage-v12.md");
const CLASSIFY = join(__dirname, "../../../prompts/classify-v12.md");
const RELATE = join(__dirname, "../../../prompts/relate-judge-v12.md");

async function makeRig() {
  const root = join(tmpdir(), `enc12-${Date.now()}-${Math.random()}`);
  const seed = join(root, "prompts");
  const dyn = join(root, "categories");
  await fs.mkdir(seed, { recursive: true });
  await fs.mkdir(dyn, { recursive: true });
  await fs.writeFile(
    join(seed, "extract-preference.md"),
    "---\ndescription: User preferences\nhint: I like X\n---\n"
  );
  const catalog = new CategoryCatalog(seed, dyn);
  await catalog.load();
  const pending = new PendingCategoriesStore(join(root, "pending.json"));
  await pending.load();
  const written: any[] = [];
  const sink = {
    write: async (m: any) => {
      written.push(m);
      return { id: m.id ?? `id-${written.length}` };
    },
  };
  return { catalog, pending, sink, written, root };
}

describe("EncoderV12", () => {
  it("skips when triage returns worth_extracting=false", async () => {
    const { catalog, pending, sink, written } = await makeRig();
    let callCount = 0;
    const llm = {
      call: async () => {
        callCount++;
        return '{"worth_extracting":false,"reason":"greeting"}';
      },
    };
    const enc = new EncoderV12({
      llm, catalog, pending, sink,
      promptPaths: { triage: TRIAGE, classify: CLASSIFY, relate: RELATE },
      classifyCfg: { model: "haiku", maxCandidates: 5 },
      gateCfg: { minConfidence: 0.7, windowDays: 7, minOccurrences: 2 },
      intraTurnCfg: { maxPairs: 3 },
      model: "haiku",
    });
    const result = await enc.process("Hi!", "session-1");
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("greeting");
    expect(written).toHaveLength(0);
    expect(callCount).toBe(1); // only triage called
  });

  it("writes memories for existing categories", async () => {
    const { catalog, pending, sink, written } = await makeRig();
    let callCount = 0;
    const llm = {
      call: async () => {
        callCount++;
        if (callCount === 1) return '{"worth_extracting":true,"reason":"preference stated"}';
        return JSON.stringify({
          candidates: [{
            category: "preference", is_new_category: false, confidence: 0.9,
            title: "Likes PG", content: "User likes Postgres", evidence: "I like PG", tags: ["pg"],
          }],
          new_categories: [],
        });
      },
    };
    const enc = new EncoderV12({
      llm, catalog, pending, sink,
      promptPaths: { triage: TRIAGE, classify: CLASSIFY, relate: RELATE },
      classifyCfg: { model: "haiku", maxCandidates: 5 },
      gateCfg: { minConfidence: 0.7, windowDays: 7, minOccurrences: 2 },
      intraTurnCfg: { maxPairs: 3 },
      model: "haiku",
    });
    const result = await enc.process("I like PG", "session-1");
    expect(result.skipped).toBe(false);
    expect(written).toHaveLength(1);
    expect(written[0].category).toBe("preference");
    expect(result.memories).toHaveLength(1);
    expect(result.intraTurnEdges).toHaveLength(0); // only 1 memory, no pairs
  });

  it("triggers fallback re-classify on first new-category proposal", async () => {
    const { catalog, pending, sink, written } = await makeRig();
    let callCount = 0;
    const llm = {
      call: async () => {
        callCount++;
        if (callCount === 1) return '{"worth_extracting":true,"reason":"new signal"}';
        if (callCount === 2) return JSON.stringify({
          candidates: [{
            category: "ux-pattern", is_new_category: true, confidence: 0.85,
            title: "UX rule", content: "Primary action top-right", evidence: "I put X TR", tags: [],
          }],
          new_categories: [{
            id: "ux-pattern", description: "UX choices", hint: "user states UX rule",
            extractor_template: "Extract UX rules.",
          }],
        });
        // callCount 3 = fallback re-classify
        return JSON.stringify({
          candidates: [{
            category: "preference", is_new_category: false, confidence: 0.7,
            title: "UX pref", content: "Prefers TR primary", evidence: "I put X TR", tags: [],
          }],
          new_categories: [],
        });
      },
    };
    const enc = new EncoderV12({
      llm, catalog, pending, sink,
      promptPaths: { triage: TRIAGE, classify: CLASSIFY, relate: RELATE },
      classifyCfg: { model: "haiku", maxCandidates: 5 },
      gateCfg: { minConfidence: 0.7, windowDays: 7, minOccurrences: 2 },
      intraTurnCfg: { maxPairs: 3 },
      model: "haiku",
    });
    const result = await enc.process("I put primary actions top-right", "s1");
    expect(written).toHaveLength(1);
    expect(written[0].category).toBe("preference"); // fallback used
    expect(pending.get("ux-pattern")?.occurrences).toBe(1);
  });

  it("materializes new category on 2nd occurrence and persists under new slug", async () => {
    const { catalog, pending, sink, written } = await makeRig();
    // Pre-seed 1 prior occurrence
    pending.register({ id: "ux-pattern", description: "UX", hint: "h", extractor_template: "tpl" });
    await pending.save();

    let callCount = 0;
    const llm = {
      call: async () => {
        callCount++;
        if (callCount === 1) return '{"worth_extracting":true,"reason":"ux signal"}';
        return JSON.stringify({
          candidates: [{
            category: "ux-pattern", is_new_category: true, confidence: 0.85,
            title: "UX rule", content: "Primary TR", evidence: "I put primary TR", tags: [],
          }],
          new_categories: [{
            id: "ux-pattern", description: "UX choices", hint: "user UX",
            extractor_template: "Extract UX rules.",
          }],
        });
      },
    };
    const enc = new EncoderV12({
      llm, catalog, pending, sink,
      promptPaths: { triage: TRIAGE, classify: CLASSIFY, relate: RELATE },
      classifyCfg: { model: "haiku", maxCandidates: 5 },
      gateCfg: { minConfidence: 0.7, windowDays: 7, minOccurrences: 2 },
      intraTurnCfg: { maxPairs: 3 },
      model: "haiku",
    });
    const result = await enc.process("turn with UX insight", "s1");
    expect(catalog.has("ux-pattern")).toBe(true); // materialized
    expect(written).toHaveLength(1);
    expect(written[0].category).toBe("ux-pattern");
  });

  it("produces intra-turn edges when classify emits 2 candidates", async () => {
    const { catalog, pending, sink } = await makeRig();
    let callCount = 0;
    const llm = {
      call: async () => {
        callCount++;
        if (callCount === 1) return '{"worth_extracting":true,"reason":"multi"}';
        if (callCount === 2) return JSON.stringify({
          candidates: [
            { category: "preference", is_new_category: false, confidence: 0.9,
              title: "A", content: "fact A", evidence: "e1", tags: [] },
            { category: "preference", is_new_category: false, confidence: 0.85,
              title: "B", content: "fact B", evidence: "e2", tags: [] },
          ],
          new_categories: [],
        });
        // callCount 3 = relate-judge for the intra-turn pair
        return '{"relation":"relates_to","confidence":0.8,"reason":"both about same topic"}';
      },
    };
    const enc = new EncoderV12({
      llm, catalog, pending, sink,
      promptPaths: { triage: TRIAGE, classify: CLASSIFY, relate: RELATE },
      classifyCfg: { model: "haiku", maxCandidates: 5 },
      gateCfg: { minConfidence: 0.7, windowDays: 7, minOccurrences: 2 },
      intraTurnCfg: { maxPairs: 3 },
      model: "haiku",
    });
    const result = await enc.process("turn with two facts", "s1");
    expect(result.memories).toHaveLength(2);
    expect(result.intraTurnEdges).toHaveLength(1);
    expect(result.intraTurnEdges[0].relation).toBe("relates_to");
  });
});
