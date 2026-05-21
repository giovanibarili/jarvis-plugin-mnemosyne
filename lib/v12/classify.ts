import { promises as fs } from "fs";
import type { LLMClient } from "../extractor";
import type { ClassifyV12Result, ClassifiedCandidate, NewCategoryProposal } from "../types";
import { CategoryCatalog } from "./category-catalog";

const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

export class ClassifyV12 {
  private promptCache: string | null = null;

  constructor(
    private readonly llm: LLMClient,
    private readonly promptPath: string,
    private readonly catalog: CategoryCatalog,
    private readonly model: string = "haiku",
    private readonly maxCandidates: number = 5,
  ) {}

  async run(turn: string, triageReason: string): Promise<ClassifyV12Result> {
    const tpl = await this.loadPrompt();
    const user = tpl
      .replace("{{CATALOG}}", this.catalog.renderCatalog())
      .replace("{{TRIAGE_REASON}}", triageReason || "(none)")
      .replace("{{TURN}}", turn);

    let raw: string;
    try {
      raw = await this.llm.call({
        system: "You are a JSON-only classifier. Output one JSON object.",
        user,
        maxTokens: 2000,
        model: this.model,
      });
    } catch {
      return { candidates: [], new_categories: [] };
    }

    let parsed: any;
    try {
      const m = raw.trim().match(/\{[\s\S]*\}/);
      if (!m) throw new Error("no JSON");
      parsed = JSON.parse(m[0]);
    } catch {
      return { candidates: [], new_categories: [] };
    }

    const candidates = sanitizeCandidates(parsed.candidates, this.maxCandidates);
    const new_categories = sanitizeNewCategories(parsed.new_categories, this.catalog);
    return { candidates, new_categories };
  }

  private async loadPrompt(): Promise<string> {
    if (this.promptCache) return this.promptCache;
    this.promptCache = await fs.readFile(this.promptPath, "utf8");
    return this.promptCache;
  }
}

function sanitizeCandidates(arr: unknown, max: number): ClassifiedCandidate[] {
  if (!Array.isArray(arr)) return [];
  const out: ClassifiedCandidate[] = [];
  for (const c of arr) {
    if (typeof c?.category !== "string") continue;
    if (typeof c?.title !== "string") continue;
    if (typeof c?.content !== "string") continue;
    if (typeof c?.evidence !== "string") continue;
    out.push({
      category: c.category,
      is_new_category: c.is_new_category === true,
      confidence: typeof c.confidence === "number" ? c.confidence : 0,
      title: c.title,
      content: c.content,
      evidence: c.evidence,
      tags: Array.isArray(c.tags) ? c.tags.filter((t: unknown) => typeof t === "string") : [],
    });
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeNewCategories(arr: unknown, catalog: CategoryCatalog): NewCategoryProposal[] {
  if (!Array.isArray(arr)) return [];
  const out: NewCategoryProposal[] = [];
  for (const n of arr) {
    if (typeof n?.id !== "string") continue;
    if (!SLUG_RE.test(n.id)) continue;
    if (catalog.has(n.id)) continue; // already exists — filter out
    if (typeof n?.description !== "string") continue;
    if (typeof n?.hint !== "string") continue;
    if (typeof n?.extractor_template !== "string") continue;
    out.push({
      id: n.id,
      description: n.description,
      hint: n.hint,
      extractor_template: n.extractor_template,
    });
  }
  return out;
}
