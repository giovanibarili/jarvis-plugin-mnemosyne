import { promises as fs } from "fs";
import type { LLMClient } from "../extractor";
import type { RelateRelation, RelateJudgement } from "../types";

export interface RelatePayload {
  title: string;
  content: string;
  evidence: string;
  origin: string;
  createdAt: string;
  category: string;
}

const VALID_RELATIONS: RelateRelation[] = [
  "merge", "supersede", "contradicts", "relates_to", "relates_to_variant", "unrelated",
];

export class RelateJudge {
  private promptCache: string | null = null;

  constructor(
    private readonly llm: LLMClient,
    private readonly promptPath: string,
    private readonly model: string = "haiku",
  ) {}

  async judge(M: RelatePayload, C: RelatePayload): Promise<RelateJudgement> {
    const tpl = await this.loadPrompt();
    const user = tpl
      .replace("{{M_TITLE}}", M.title).replace("{{M_CONTENT}}", M.content)
      .replace("{{M_EVIDENCE}}", M.evidence).replace("{{M_ORIGIN}}", M.origin)
      .replace("{{M_TS}}", M.createdAt).replace("{{M_CATEGORY}}", M.category)
      .replace("{{C_TITLE}}", C.title).replace("{{C_CONTENT}}", C.content)
      .replace("{{C_EVIDENCE}}", C.evidence).replace("{{C_ORIGIN}}", C.origin)
      .replace("{{C_TS}}", C.createdAt).replace("{{C_CATEGORY}}", C.category);

    let raw: string;
    try {
      raw = await this.llm.call({
        system: "You are a JSON-only relation classifier.",
        user,
        maxTokens: 200,
        model: this.model,
      });
    } catch (err: any) {
      return { relation: "unrelated", confidence: 0, reason: `llm_error: ${err.message ?? err}` };
    }

    try {
      const m = raw.trim().match(/\{[\s\S]*\}/);
      if (!m) throw new Error("no JSON");
      const parsed = JSON.parse(m[0]);
      const rel = parsed.relation as RelateRelation;
      if (!VALID_RELATIONS.includes(rel)) {
        return { relation: "unrelated", confidence: 0, reason: `invalid_relation: ${rel}` };
      }
      return {
        relation: rel,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    } catch (err: any) {
      return { relation: "unrelated", confidence: 0, reason: `parse_error: ${err.message ?? err}` };
    }
  }

  private async loadPrompt(): Promise<string> {
    if (this.promptCache) return this.promptCache;
    this.promptCache = await fs.readFile(this.promptPath, "utf8");
    return this.promptCache;
  }
}
