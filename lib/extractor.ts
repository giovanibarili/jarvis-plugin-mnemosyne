import { promises as fs } from "fs";
import { join } from "path";
import type {
  Category,
  MemoryCandidate,
  WorkflowCandidate,
  TriageResult,
  TurnContext,
} from "./types";

export interface LLMClient {
  call(opts: {
    system: string;
    user: string;
    maxTokens?: number;
    model?: string;
  }): Promise<string>;
}

export interface ExtractorResult {
  candidates: MemoryCandidate[];
  workflow: WorkflowCandidate | null;
  triage: TriageResult;
  costUsd: number;
}

export class Extractor {
  private promptCache = new Map<string, string>();

  constructor(
    private llm: LLMClient,
    private promptsDir: string,
    private minConfidence = 0.6
  ) {}

  private async loadPrompt(name: string): Promise<string> {
    const cached = this.promptCache.get(name);
    if (cached) return cached;
    const content = await fs.readFile(join(this.promptsDir, name), "utf-8");
    this.promptCache.set(name, content);
    return content;
  }

  private renderTurn(turn: TurnContext): string {
    const tools = turn.tool_calls
      .map((tc) => `${tc.tool}(${JSON.stringify(tc.args)})`)
      .join("\n");
    return `User: ${turn.user_message}\n\nAssistant: ${turn.assistant_response}\n\nTool calls:\n${tools}`;
  }

  async triage(turn: TurnContext): Promise<TriageResult> {
    const template = await this.loadPrompt("triage.md");
    const prompt = template.replace("{{TURN}}", this.renderTurn(turn));
    const raw = await this.llm.call({
      system: prompt,
      user: "Extract.",
      maxTokens: 200,
    });
    return JSON.parse(this.stripJsonFence(raw));
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
    const raw = await this.llm.call({
      system: prompt,
      user: "Extract.",
      maxTokens: 800,
    });
    const parsed = JSON.parse(this.stripJsonFence(raw));
    return (parsed.candidates ?? []).filter(
      (c: MemoryCandidate) => c.confidence >= this.minConfidence
    );
  }

  async extractWorkflow(turn: TurnContext): Promise<WorkflowCandidate | null> {
    const template = await this.loadPrompt("extract-workflow.md");
    const prompt = template.replace("{{TURN}}", this.renderTurn(turn));
    const raw = await this.llm.call({
      system: prompt,
      user: "Extract.",
      maxTokens: 1500,
    });
    const parsed = JSON.parse(this.stripJsonFence(raw));
    if (!parsed.is_workflow) return null;
    if (!parsed.workflow?.steps || parsed.workflow.steps.length < 3) return null;
    if (parsed.workflow.confidence < this.minConfidence) return null;
    return parsed as WorkflowCandidate;
  }

  async extract(turn: TurnContext): Promise<ExtractorResult> {
    const triage = await this.triage(turn);
    if (triage.present.length === 0) {
      return { candidates: [], workflow: null, triage, costUsd: 0.0001 };
    }

    const memoryCategories = triage.present.filter(
      (c) => c !== "workflow"
    ) as Category[];
    const hasWorkflow = triage.present.includes("workflow");

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

    const costUsd = 0.0001 + 0.0003 * promises.length;
    return { candidates, workflow, triage, costUsd };
  }

  private stripJsonFence(s: string): string {
    return s.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  }
}
