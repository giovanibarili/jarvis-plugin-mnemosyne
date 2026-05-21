import { describe, it, expect } from "vitest";
import { join } from "path";
import { TriageV12 } from "../../../lib/v12/triage";

const PROMPT = join(__dirname, "../../../prompts/triage-v12.md");

describe("TriageV12", () => {
  it("parses a positive triage response", async () => {
    const llm = { call: async () => '{"worth_extracting": true, "reason": "preference stated"}' };
    const t = new TriageV12(llm, PROMPT, "haiku");
    const r = await t.evaluate("user says: I prefer Postgres");
    expect(r.worth_extracting).toBe(true);
    expect(r.reason).toMatch(/preference/);
  });

  it("parses a negative triage response", async () => {
    const llm = { call: async () => '{"worth_extracting": false, "reason": "greeting only"}' };
    const t = new TriageV12(llm, PROMPT, "haiku");
    const r = await t.evaluate("Hi!");
    expect(r.worth_extracting).toBe(false);
  });

  it("falls back to worth_extracting=false on parse error", async () => {
    const llm = { call: async () => "not json at all" };
    const t = new TriageV12(llm, PROMPT, "haiku");
    const r = await t.evaluate("anything");
    expect(r.worth_extracting).toBe(false);
    expect(r.reason).toMatch(/parse/i);
  });

  it("passes model + maxTokens to LLM", async () => {
    let opts: any = null;
    const llm = { call: async (o: any) => { opts = o; return '{"worth_extracting": false, "reason": "x"}'; } };
    const t = new TriageV12(llm, PROMPT, "haiku");
    await t.evaluate("turn");
    expect(opts.model).toBe("haiku");
    expect(opts.maxTokens).toBeLessThanOrEqual(200);
  });
});
