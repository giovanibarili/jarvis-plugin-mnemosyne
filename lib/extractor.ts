import { promises as fs } from "fs";
import { join } from "path";
import {
  CANONICAL_CATEGORIES,
  type CanonicalCategory,
  type Category,
  type MemoryCandidate,
  type ProposedCategory,
  type TriageResult,
  type TurnContext,
  type WorkflowCandidate,
} from "./types";

export interface LLMCallResult {
  text: string;
  /** Real cost in USD computed from API usage tokens. */
  costUsd: number;
}

export interface LLMClient {
  call(opts: {
    system: string;
    user: string;
    maxTokens?: number;
    model?: string;
  }): Promise<LLMCallResult>;
}

export interface ExtractorResult {
  candidates: MemoryCandidate[];
  workflow: WorkflowCandidate | null;
  triage: TriageResult;
  costUsd: number;
  /** Categories whose extraction prompts were auto-generated this run. */
  newPromptsGenerated?: string[];
}

const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

export class Extractor {
  private promptCache = new Map<string, string>();
  private knownDynamic = new Set<string>(); // discovered at construction + after each generate
  /** Accumulates real LLM cost (USD) across all calls within one extract() invocation. */
  _costAccumulator = 0;

  constructor(
    private llm: LLMClient,
    private promptsDir: string,
    private minConfidence = 0.6
  ) {}

  /** Call once at startup so the triage prompt can list dynamic categories. */
  async init(): Promise<void> {
    try {
      const entries = await fs.readdir(this.promptsDir);
      for (const e of entries) {
        const m = e.match(/^extract-(.+)\.md$/);
        if (!m) continue;
        const id = m[1];
        if ((CANONICAL_CATEGORIES as readonly string[]).includes(id)) continue;
        this.knownDynamic.add(id);
      }
    } catch {
      // prompts dir may not exist yet in test fixtures
    }
  }

  private async loadPrompt(name: string): Promise<string> {
    const cached = this.promptCache.get(name);
    if (cached) return cached;
    const content = await fs.readFile(join(this.promptsDir, name), "utf-8");
    this.promptCache.set(name, content);
    return content;
  }

  private renderTurn(turn: TurnContext): string {
    const tools = turn.tool_calls
      .map((tc) => {
        const call = `${tc.tool}(${JSON.stringify(tc.args)})`;
        // Include result for feedback tools — the LLM's downvote reason and
        // reinforce neighbors are semantically meaningful for extraction.
        if (
          tc.tool === "memory_downvote" ||
          tc.tool === "memory_reinforce" ||
          tc.tool === "memory_add_evidence"
        ) {
          const resultStr = tc.result ? ` → ${JSON.stringify(tc.result)}` : "";
          return call + resultStr;
        }
        return call;
      })
      .join("\n");

    const currentTurn = `User: ${turn.user_message}\n\nAssistant: ${turn.assistant_response}\n\nTool calls:\n${tools}`;

    if (!turn.prior_turns?.length) return currentTurn;

    // Prepend condensed context window — user messages only to keep tokens low.
    // Tool calls and assistant responses from prior turns are omitted; the
    // current turn's full content is what the extractor judges.
    const contextLines = turn.prior_turns.map((t, i) => {
      const label = `[Turn -${turn.prior_turns!.length - i}]`;
      return `${label} User: ${t.user_message.slice(0, 300)}${t.user_message.length > 300 ? "…" : ""}\n${label} Assistant: ${t.assistant_response.slice(0, 200)}${t.assistant_response.length > 200 ? "…" : ""}`;
    });

    return `--- CONTEXT ONLY — DO NOT EXTRACT FROM THIS SECTION (${turn.prior_turns.length} prior turns for reference) ---
${contextLines.join("\n\n")}

--- EXTRACT FROM THIS TURN ONLY — this is the new content to analyse ---
${currentTurn}`;
  }

  private renderKnownDynamicBlock(): string {
    if (this.knownDynamic.size === 0) return "";
    const lines = [...this.knownDynamic]
      .sort()
      .map((id) => `- ${id}: previously proposed dynamic category`);
    return `\n## Previously discovered dynamic categories (also valid)\n${lines.join("\n")}`;
  }

  async triage(turn: TurnContext): Promise<TriageResult> {
    const template = await this.loadPrompt("triage.md");
    const prompt = template
      .replace("{{TURN}}", this.renderTurn(turn))
      .replace("{{KNOWN_DYNAMIC_CATEGORIES}}", this.renderKnownDynamicBlock());
    const { text: raw, costUsd: c0 } = await this.llm.call({
      system: prompt,
      user: "Extract.",
      maxTokens: 400,
    });
    this._costAccumulator += c0;
    const parsed = JSON.parse(this.stripJsonFence(raw)) as TriageResult;
    parsed.proposed = parsed.proposed ?? [];
    return parsed;
  }

  async extractCategory(
    category: Category,
    turn: TurnContext
  ): Promise<MemoryCandidate[]> {
    if (category === "workflow") {
      throw new Error("Use extractWorkflow for workflows");
    }
    const file = `extract-${category}.md`;
    const template = await this.loadPrompt(file);
    const prompt = template.replace("{{TURN}}", this.renderTurn(turn));
    const { text: raw, costUsd: c1 } = await this.llm.call({
      system: prompt,
      user: "Extract.",
      maxTokens: 800,
    });
    this._costAccumulator += c1;
    const parsed = JSON.parse(this.stripJsonFence(raw));
    return (parsed.candidates ?? []).filter(
      (c: MemoryCandidate) => c.confidence >= this.minConfidence
    );
  }

  async extractWorkflow(turn: TurnContext): Promise<WorkflowCandidate | null> {
    const template = await this.loadPrompt("extract-workflow.md");
    const prompt = template.replace("{{TURN}}", this.renderTurn(turn));
    const { text: raw, costUsd: c2 } = await this.llm.call({
      system: prompt,
      user: "Extract.",
      maxTokens: 2000,
    });
    this._costAccumulator += c2;
    let parsed: any;
    try {
      parsed = JSON.parse(this.stripJsonFence(raw));
    } catch (e) {
      console.warn("[mnemosyne] workflow JSON parse failed:", e, "raw:", raw.slice(0, 200));
      return null;
    }
    if (!parsed.is_workflow) return null;
    const steps = parsed.workflow?.steps ?? [];
    if (steps.length < 2) {
      console.debug(`[mnemosyne] workflow dropped: only ${steps.length} step(s) — need 2+`);
      return null;
    }
    if ((parsed.workflow.confidence ?? 0) < this.minConfidence) {
      console.debug(`[mnemosyne] workflow dropped: confidence ${parsed.workflow.confidence} < ${this.minConfidence}`);
      return null;
    }
    return parsed as WorkflowCandidate;
  }

  /**
   * Validate a proposed category and, if accepted and not already on disk,
   * author its extract-<id>.md via the meta-prompt. Returns true if the
   * category is now usable for extraction.
   */
  private async ensurePromptForProposed(
    proposal: ProposedCategory
  ): Promise<boolean> {
    const id = proposal.id?.trim().toLowerCase();
    if (!id || !SLUG_RE.test(id)) return false;
    if ((CANONICAL_CATEGORIES as readonly string[]).includes(id)) return true;
    if (this.knownDynamic.has(id)) return true;

    const path = join(this.promptsDir, `extract-${id}.md`);
    try {
      await fs.access(path);
      this.knownDynamic.add(id);
      return true;
    } catch {
      // file missing — generate it
    }

    if (!proposal.description?.trim() || !proposal.hint?.trim()) return false;

    const meta = await this.loadPrompt("generate-extractor.md");
    const prompt = meta
      .replace(/\{\{CATEGORY_ID\}\}/g, id)
      .replace(/\{\{CATEGORY_DESCRIPTION\}\}/g, proposal.description.trim())
      .replace(/\{\{CATEGORY_HINT\}\}/g, proposal.hint.trim());
    const { text: generated, costUsd: c3 } = await this.llm.call({
      system: prompt,
      user: "Author the prompt now.",
      maxTokens: 800,
    });
    this._costAccumulator += c3;
    const body = this.stripJsonFence(generated).trim();
    if (!body || !body.includes("{{TURN}}") || !body.includes(`"${id}"`)) {
      // Reject malformed output — keep the system safe rather than store junk.
      return false;
    }
    await fs.writeFile(path, `${body}\n`, "utf-8");
    this.promptCache.delete(`extract-${id}.md`); // force re-read on next use
    this.knownDynamic.add(id);
    return true;
  }

  async extract(turn: TurnContext): Promise<ExtractorResult> {
    this._costAccumulator = 0; // reset for this invocation
    const triage = await this.triage(turn);
    if (triage.present.length === 0) {
      return { candidates: [], workflow: null, triage, costUsd: 0 };
    }

    // Resolve each proposed id: canonical / known dynamic / new (auto-author).
    const proposalById = new Map<string, ProposedCategory>();
    for (const p of triage.proposed ?? []) proposalById.set(p.id, p);

    const accepted: Category[] = [];
    const newPromptsGenerated: string[] = [];
    for (const id of triage.present) {
      if ((CANONICAL_CATEGORIES as readonly string[]).includes(id)) {
        accepted.push(id);
        continue;
      }
      if (this.knownDynamic.has(id)) {
        accepted.push(id);
        continue;
      }
      const proposal = proposalById.get(id);
      if (!proposal) continue; // dynamic id without metadata — drop
      const before = this.knownDynamic.has(id);
      const ok = await this.ensurePromptForProposed(proposal);
      if (!ok) continue;
      if (!before) newPromptsGenerated.push(id);
      accepted.push(id);
    }

    if (accepted.length < triage.present.length) {
      triage.present = accepted; // reflect reality in logs
    }
    if (accepted.length === 0) {
      const costUsd = this._costAccumulator;
      this._costAccumulator = 0;
      return { candidates: [], workflow: null, triage, costUsd, newPromptsGenerated };
    }

    const memoryCategories = accepted.filter((c) => c !== "workflow");
    const hasWorkflow = accepted.includes("workflow" as CanonicalCategory);

    const promises: Promise<MemoryCandidate[] | WorkflowCandidate | null>[] = [];
    for (const cat of memoryCategories) {
      promises.push(this.extractCategory(cat, turn));
    }
    if (hasWorkflow) {
      promises.push(this.extractWorkflow(turn));
    }

    const results = await Promise.all(promises);
    const candidates: MemoryCandidate[] = [];
    let workflow: WorkflowCandidate | null = null;
    for (let i = 0; i < memoryCategories.length; i++) {
      candidates.push(...(results[i] as MemoryCandidate[]));
    }
    if (hasWorkflow) {
      workflow = results[results.length - 1] as WorkflowCandidate | null;
    }

    // costUsd is accumulated by the LLMClient via the costAccumulator ref.
    const costUsd = this._costAccumulator;
    this._costAccumulator = 0;
    return { candidates, workflow, triage, costUsd, newPromptsGenerated };
  }

  private stripJsonFence(s: string): string {
    return s.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  }
}
