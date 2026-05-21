import { describe, it, expect } from "vitest";
import { join } from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { CategoryGate } from "../../../lib/v12/category-gate";
import { CategoryCatalog } from "../../../lib/v12/category-catalog";
import { PendingCategoriesStore } from "../../../lib/v12/pending-categories-store";
import { ClassifyV12 } from "../../../lib/v12/classify";

const CLASSIFY_PROMPT = join(__dirname, "../../../prompts/classify-v12.md");

async function setup() {
  const root = join(tmpdir(), `gate-${Date.now()}-${Math.random()}`);
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
  const pendingPath = join(root, "pending.json");
  const pending = new PendingCategoriesStore(pendingPath);
  await pending.load();
  return { catalog, pending, seed, dyn };
}

describe("CategoryGate", () => {
  it("materializes when conf >= 0.7 and occurrences >= 2 within 7d", async () => {
    const { catalog, pending } = await setup();
    // Pre-seed 1 prior occurrence
    pending.register({ id: "ux-pattern", description: "UX", hint: "h", extractor_template: "tpl" });

    const llm = { call: async () => "{}" }; // fallback not needed
    const classify = new ClassifyV12(llm, CLASSIFY_PROMPT, catalog, "haiku", 5);
    const gate = new CategoryGate(catalog, pending, classify, {
      minConfidence: 0.7, windowDays: 7, minOccurrences: 2,
    });

    const proposal = { id: "ux-pattern", description: "UX", hint: "h", extractor_template: "tpl" };
    const candidate = {
      category: "ux-pattern", is_new_category: true, confidence: 0.85,
      title: "t", content: "c", evidence: "e", tags: [],
    };

    const result = await gate.handle(proposal, candidate, "turn", "reason");

    expect(result.materialized).toBe(true);
    expect(catalog.has("ux-pattern")).toBe(true);
    expect(result.finalCandidate?.category).toBe("ux-pattern");
    expect(result.fallbackInvoked).toBe(false);
  });

  it("registers pending and fallbacks on first occurrence (conf >= 0.7)", async () => {
    const { catalog, pending } = await setup();

    // Fallback LLM returns an existing category
    const llm = {
      call: async () => JSON.stringify({
        candidates: [{
          category: "preference", is_new_category: false, confidence: 0.8,
          title: "fb", content: "fallback content", evidence: "e", tags: [],
        }],
        new_categories: [],
      }),
    };
    const classify = new ClassifyV12(llm, CLASSIFY_PROMPT, catalog, "haiku", 5);
    const gate = new CategoryGate(catalog, pending, classify, {
      minConfidence: 0.7, windowDays: 7, minOccurrences: 2,
    });

    const proposal = { id: "ux-pattern", description: "UX", hint: "h", extractor_template: "tpl" };
    const candidate = {
      category: "ux-pattern", is_new_category: true, confidence: 0.85,
      title: "t", content: "c", evidence: "e", tags: [],
    };

    const result = await gate.handle(proposal, candidate, "turn", "reason");

    expect(result.materialized).toBe(false);
    expect(result.fallbackInvoked).toBe(true);
    expect(pending.get("ux-pattern")?.occurrences).toBe(1);
    expect(result.finalCandidate?.category).toBe("preference");
  });

  it("drops and fallbacks when conf < 0.7 (no pending registration)", async () => {
    const { catalog, pending } = await setup();

    const llm = {
      call: async () => JSON.stringify({
        candidates: [{
          category: "preference", is_new_category: false, confidence: 0.7,
          title: "t", content: "c", evidence: "e", tags: [],
        }],
        new_categories: [],
      }),
    };
    const classify = new ClassifyV12(llm, CLASSIFY_PROMPT, catalog, "haiku", 5);
    const gate = new CategoryGate(catalog, pending, classify, {
      minConfidence: 0.7, windowDays: 7, minOccurrences: 2,
    });

    const proposal = { id: "weak", description: "x", hint: "x", extractor_template: "x" };
    const candidate = {
      category: "weak", is_new_category: true, confidence: 0.5,  // below threshold
      title: "t", content: "c", evidence: "e", tags: [],
    };

    const result = await gate.handle(proposal, candidate, "turn", "reason");

    expect(result.materialized).toBe(false);
    expect(result.fallbackInvoked).toBe(true);
    expect(pending.get("weak")).toBeNull();  // NOT registered
  });
});
