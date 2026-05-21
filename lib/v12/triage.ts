import { promises as fs } from "fs";
import type { LLMClient } from "../extractor";
import type { TriageV12Result } from "../types";

export class TriageV12 {
  private promptCache: string | null = null;

  constructor(
    private readonly llm: LLMClient,
    private readonly promptPath: string,
    private readonly model: string = "haiku",
  ) {}

  async evaluate(turn: string): Promise<TriageV12Result> {
    const prompt = await this.loadPrompt();
    const user = prompt.replace("{{TURN}}", turn);
    let raw: string;
    try {
      raw = await this.llm.call({
        system: "You are a JSON-only assistant. Output exactly one JSON object.",
        user,
        maxTokens: 200,
        model: this.model,
      });
    } catch (err: any) {
      return { worth_extracting: false, reason: `llm_error: ${err.message ?? err}` };
    }
    try {
      const parsed = JSON.parse(extractJson(raw));
      if (typeof parsed.worth_extracting !== "boolean") {
        return { worth_extracting: false, reason: "parse_error: missing worth_extracting" };
      }
      return {
        worth_extracting: parsed.worth_extracting,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    } catch (err: any) {
      return { worth_extracting: false, reason: `parse_error: ${err.message ?? err}` };
    }
  }

  private async loadPrompt(): Promise<string> {
    if (this.promptCache) return this.promptCache;
    this.promptCache = await fs.readFile(this.promptPath, "utf8");
    return this.promptCache;
  }
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON object in response");
  return m[0];
}
