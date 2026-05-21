import { describe, it, expect } from "vitest";
import { join } from "path";
import { RelateJudge } from "../../../lib/v12/relate-judge";

const PROMPT = join(__dirname, "../../../prompts/relate-judge-v12.md");

const M = {
  title: "Likes Postgres", content: "Prefers PG for greenfield", evidence: "I like PG",
  origin: "user", createdAt: "2026-05-21T12:00:00Z", category: "preference",
};
const C = {
  title: "Loves Postgres JSONB", content: "Picks PG for JSONB native", evidence: "PG JSONB is great",
  origin: "user", createdAt: "2026-05-20T12:00:00Z", category: "architecture-decision",
};

describe("RelateJudge", () => {
  it("returns the parsed relation", async () => {
    const llm = { call: async () => '{"relation":"relates_to_variant","confidence":0.8,"reason":"variant"}' };
    const j = new RelateJudge(llm, PROMPT, "haiku");
    const r = await j.judge(M, C);
    expect(r.relation).toBe("relates_to_variant");
    expect(r.confidence).toBe(0.8);
  });

  it("returns unrelated as safe default on parse error", async () => {
    const llm = { call: async () => "garbage" };
    const j = new RelateJudge(llm, PROMPT, "haiku");
    const r = await j.judge(M, C);
    expect(r.relation).toBe("unrelated");
    expect(r.reason).toMatch(/parse/i);
  });

  it("populates the prompt with full payload of both memories", async () => {
    let captured: any = null;
    const llm = {
      call: async (o: any) => { captured = o; return '{"relation":"unrelated","confidence":0.1,"reason":"x"}'; },
    };
    const j = new RelateJudge(llm, PROMPT, "haiku");
    await j.judge(M, C);
    expect(captured.user).toContain("Likes Postgres");
    expect(captured.user).toContain("PG JSONB is great");
    expect(captured.user).toContain("2026-05-21T12:00:00Z");
    expect(captured.model).toBe("haiku");
  });

  it("rejects invalid relation values, returns unrelated", async () => {
    const llm = { call: async () => '{"relation":"nonsense","confidence":0.9,"reason":"x"}' };
    const j = new RelateJudge(llm, PROMPT, "haiku");
    const r = await j.judge(M, C);
    expect(r.relation).toBe("unrelated");
  });

  it("passes maxTokens <= 200 to LLM", async () => {
    let opts: any = null;
    const llm = { call: async (o: any) => { opts = o; return '{"relation":"unrelated","confidence":0.1,"reason":"x"}'; } };
    const j = new RelateJudge(llm, PROMPT, "haiku");
    await j.judge(M, C);
    expect(opts.maxTokens).toBeLessThanOrEqual(200);
  });
});
