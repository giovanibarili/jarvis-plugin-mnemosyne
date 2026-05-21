import { describe, it, expect } from "vitest";
import { join } from "path";
import { CategoryMergeJudge } from "../../../lib/v12/category-merge-judge";

const PROMPT = join(__dirname, "../../../prompts/category-merge-judge.md");

const A = { id: "code-pattern", description: "code patterns", hint: "user shows snippet", examples: ["Idiomatic map usage", "Builder pattern in TS"] };
const B = { id: "coding-pattern", description: "coding patterns", hint: "user writes code", examples: ["React hook pattern", "Error wrapping"] };

describe("CategoryMergeJudge", () => {
  it("returns should_merge=true with winner/loser for synonyms", async () => {
    const llm = {
      call: async () => '{"should_merge":true,"winner":"code-pattern","loser":"coding-pattern","reason":"synonym labels"}',
    };
    const j = new CategoryMergeJudge(llm, PROMPT, "haiku");
    const r = await j.judge(A, B);
    expect(r.should_merge).toBe(true);
    expect(r.winner).toBe("code-pattern");
    expect(r.loser).toBe("coding-pattern");
  });

  it("returns should_merge=false for distinct categories", async () => {
    const llm = {
      call: async () => '{"should_merge":false,"winner":null,"loser":null,"reason":"different concerns"}',
    };
    const j = new CategoryMergeJudge(llm, PROMPT, "haiku");
    const r = await j.judge(A, B);
    expect(r.should_merge).toBe(false);
    expect(r.winner).toBeUndefined();
  });

  it("returns safe default (should_merge=false) on parse error", async () => {
    const llm = { call: async () => "not json" };
    const j = new CategoryMergeJudge(llm, PROMPT, "haiku");
    const r = await j.judge(A, B);
    expect(r.should_merge).toBe(false);
    expect(r.reason).toMatch(/parse/i);
  });

  it("populates prompt with A and B fields", async () => {
    let captured: any = null;
    const llm = {
      call: async (o: any) => { captured = o; return '{"should_merge":false,"winner":null,"loser":null,"reason":"x"}'; },
    };
    const j = new CategoryMergeJudge(llm, PROMPT, "haiku");
    await j.judge(A, B);
    expect(captured.user).toContain("code-pattern");
    expect(captured.user).toContain("coding-pattern");
    expect(captured.user).toContain("code patterns");
    expect(captured.user).toContain("Idiomatic map usage");
  });
});
