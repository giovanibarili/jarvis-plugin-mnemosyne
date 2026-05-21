import { describe, it, expect } from "vitest";
import { join } from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { ClassifyV12 } from "../../../lib/v12/classify";
import { CategoryCatalog } from "../../../lib/v12/category-catalog";

const PROMPT = join(__dirname, "../../../prompts/classify-v12.md");

async function makeCatalog() {
  const root = join(tmpdir(), `clsf-${Date.now()}-${Math.random()}`);
  const seed = join(root, "prompts");
  const dyn = join(root, "categories");
  await fs.mkdir(seed, { recursive: true });
  await fs.mkdir(dyn, { recursive: true });
  await fs.writeFile(
    join(seed, "extract-preference.md"),
    "---\ndescription: User preferences\nhint: I like X\n---\n"
  );
  const cat = new CategoryCatalog(seed, dyn);
  await cat.load();
  return cat;
}

describe("ClassifyV12", () => {
  it("returns candidates from valid LLM response", async () => {
    const llm = {
      call: async () => JSON.stringify({
        candidates: [{
          category: "preference",
          is_new_category: false,
          confidence: 0.9,
          title: "Likes Postgres",
          content: "User likes Postgres",
          evidence: "I like Postgres",
          tags: ["postgres"],
        }],
        new_categories: [],
      }),
    };
    const cat = await makeCatalog();
    const c = new ClassifyV12(llm, PROMPT, cat, "haiku", 5);
    const r = await c.run("turn", "preference stated");
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].category).toBe("preference");
    expect(r.new_categories).toHaveLength(0);
  });

  it("returns new_categories when proposed", async () => {
    const llm = {
      call: async () => JSON.stringify({
        candidates: [{
          category: "ux-pattern",
          is_new_category: true,
          confidence: 0.85,
          title: "UX guideline",
          content: "User describes UX rule",
          evidence: "I always put primary action top-right",
          tags: ["ux"],
        }],
        new_categories: [{
          id: "ux-pattern",
          description: "UX choices and patterns",
          hint: "user describes a UX decision",
          extractor_template: "Extract UX patterns from the turn.",
        }],
      }),
    };
    const cat = await makeCatalog();
    const c = new ClassifyV12(llm, PROMPT, cat, "haiku", 5);
    const r = await c.run("turn", "");
    expect(r.new_categories).toHaveLength(1);
    expect(r.new_categories[0].id).toBe("ux-pattern");
  });

  it("caps candidates at max_candidates_per_turn", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      category: "preference",
      is_new_category: false,
      confidence: 0.7,
      title: `t${i}`,
      content: `c${i}`,
      evidence: `e${i}`,
      tags: [],
    }));
    const llm = {
      call: async () => JSON.stringify({ candidates: many, new_categories: [] }),
    };
    const cat = await makeCatalog();
    const c = new ClassifyV12(llm, PROMPT, cat, "haiku", 5);
    const r = await c.run("turn", "");
    expect(r.candidates).toHaveLength(5);
  });

  it("returns empty result on parse error", async () => {
    const llm = { call: async () => "not json" };
    const cat = await makeCatalog();
    const c = new ClassifyV12(llm, PROMPT, cat, "haiku", 5);
    const r = await c.run("turn", "");
    expect(r.candidates).toHaveLength(0);
    expect(r.new_categories).toHaveLength(0);
  });

  it("renders catalog + turn + triage_reason in the user prompt", async () => {
    let captured: any = null;
    const llm = {
      call: async (o: any) => {
        captured = o;
        return JSON.stringify({ candidates: [], new_categories: [] });
      },
    };
    const cat = await makeCatalog();
    const c = new ClassifyV12(llm, PROMPT, cat, "haiku", 5);
    await c.run("the turn", "the reason");
    expect(captured.user).toContain("preference");
    expect(captured.user).toContain("the turn");
    expect(captured.user).toContain("the reason");
  });

  it("rejects new_category proposals that match existing catalog ids", async () => {
    const llm = {
      call: async () => JSON.stringify({
        candidates: [{
          category: "preference",
          is_new_category: true,
          confidence: 0.9,
          title: "t",
          content: "c",
          evidence: "e",
          tags: [],
        }],
        new_categories: [{
          id: "preference",  // already exists
          description: "d",
          hint: "h",
          extractor_template: "t",
        }],
      }),
    };
    const cat = await makeCatalog();
    const c = new ClassifyV12(llm, PROMPT, cat, "haiku", 5);
    const r = await c.run("turn", "");
    // new_categories should be filtered out because "preference" already exists
    expect(r.new_categories).toHaveLength(0);
  });
});
