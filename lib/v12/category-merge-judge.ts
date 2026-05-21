import { promises as fs } from "fs";
import type { LLMClient } from "../extractor";

export interface MergeInput {
  id: string;
  description: string;
  hint: string;
  examples: string[];
}

export interface MergeVerdict {
  should_merge: boolean;
  winner?: string;
  loser?: string;
  reason: string;
}

export class CategoryMergeJudge {
  private promptCache: string | null = null;

  constructor(
    private readonly llm: LLMClient,
    private readonly promptPath: string,
    private readonly model: string = "haiku",
  ) {}

  async judge(A: MergeInput, B: MergeInput): Promise<MergeVerdict> {
    const tpl = await this.loadPrompt();
    const user = tpl
      .replace("{{A_ID}}", A.id)
      .replace("{{A_DESC}}", A.description)
      .replace("{{A_HINT}}", A.hint)
      .replace("{{A_EXAMPLES}}", A.examples.map((e) => `- ${e}`).join("\n"))
      .replace("{{B_ID}}", B.id)
      .replace("{{B_DESC}}", B.description)
      .replace("{{B_HINT}}", B.hint)
      .replace("{{B_EXAMPLES}}", B.examples.map((e) => `- ${e}`).join("\n"));

    let raw: string;
    try {
      raw = await this.llm.call({
        system: "You are a JSON-only synonymy judge.",
        user,
        maxTokens: 200,
        model: this.model,
      });
    } catch (e) {
      return { should_merge: false, reason: `llm_error: ${e}` };
    }

    try {
      const m = raw.trim().match(/\{[\s\S]*\}/);
      if (!m) throw new Error("no json");
      const parsed = JSON.parse(m[0]);
      if (parsed.should_merge !== true) {
        return { should_merge: false, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
      }
      return {
        should_merge: true,
        winner: typeof parsed.winner === "string" ? parsed.winner : undefined,
        loser: typeof parsed.loser === "string" ? parsed.loser : undefined,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    } catch (e) {
      return { should_merge: false, reason: `parse_error: ${e}` };
    }
  }

  private async loadPrompt(): Promise<string> {
    if (this.promptCache) return this.promptCache;
    this.promptCache = await fs.readFile(this.promptPath, "utf8");
    return this.promptCache;
  }
}
