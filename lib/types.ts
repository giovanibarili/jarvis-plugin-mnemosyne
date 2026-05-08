/**
 * Canonical categories ship with hand-authored extraction prompts.
 * Triage may propose new categories; first sight auto-generates a prompt
 * file at prompts/extract-<id>.md and the new id becomes a first-class
 * Category from then on. Always slug-friendly: lowercase, hyphenated.
 */
export const CANONICAL_CATEGORIES = [
  "code-pattern",
  "preference",
  "architecture-decision",
  "mental-model",
  "glossary",
  "anti-pattern",
  "workflow",
] as const;

export type CanonicalCategory = (typeof CANONICAL_CATEGORIES)[number];

/** Open category. Canonical ids are preferred; anything else is dynamic. */
export type Category = CanonicalCategory | string;

/**
 * Triage-proposed new category. Carries enough metadata for the extractor
 * to author a per-category extraction prompt on first sight.
 */
export interface ProposedCategory {
  /** slug-friendly id, e.g. "incident-postmortem" */
  id: string;
  /** one sentence: what this category captures, why distinct from canonicals */
  description: string;
  /** one sentence: what kind of signal in the turn justifies extraction */
  hint: string;
}

export type Visibility = "open" | "private";

export interface Memory {
  id: string;
  category: Category;
  title: string;
  content: string;
  tags: string[];
  project: string | null;
  confidence: number;
  reinforcements: number;
  visibility: Visibility;
  pinned: boolean;
  created_at: number;
  last_accessed: number;
  source_session: string;
  promoted_at: number | null;
  evidence?: string;
  /**
   * Where the signal came from within the turn:
   *   "user"      — stated directly by the user (highest trust)
   *   "assistant" — inferred from the assistant response
   *   "tool"      — extracted from a tool result (file, URL, API call, etc.)
   */
  origin_source?: "user" | "assistant" | "tool";
  /** For tool origins: the tool name (e.g. "read_file", "web_fetch") */
  origin_tool?: string;
  /** For tool origins: the primary reference — file path, URL, or key arg */
  origin_ref?: string;
}

export interface WorkflowStep {
  id: string;
  order: number;
  action: string;
  category?: string;
  tool: string | null;
  guard: string | null;
  required: boolean;
  confirms_required: boolean;
  description?: string;
}

export interface WorkflowBranch {
  from_step: number;
  condition: string;
  alternative_action: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  trigger: string;
  outcome: string;
  applies_to_project: string | null;
  steps: WorkflowStep[];
  branches: WorkflowBranch[];
  confidence: number;
  reinforcements: number;
  created_at: number;
  last_used: number;
}

export interface MemoryCandidate {
  category: Category;
  title: string;
  content: string;
  tags: string[];
  project: string | null;
  confidence: number;
  evidence: string;
  visibility: Visibility;
}

export interface WorkflowCandidate {
  is_workflow: true;
  workflow: Omit<Workflow, "id" | "reinforcements" | "created_at" | "last_used">;
}

export interface TriageResult {
  /** Mix of canonical ids and dynamic ids. Dynamic ids must also appear in `proposed`. */
  present: Category[];
  /** Metadata for non-canonical ids in `present`. Empty/absent if all canonical. */
  proposed?: ProposedCategory[];
  skip_reason: string | null;
}

export interface TurnContext {
  session_id: string;
  user_message: string;
  assistant_response: string;
  tool_calls: Array<{ tool: string; args: any; result: any }>;
  timestamp: number;
  /** Sliding window of N prior turns for contextual extraction. Oldest first. */
  prior_turns?: Array<{
    user_message: string;
    assistant_response: string;
  }>;
}

export interface ScoreBreakdown {
  /** exp(-ageDays / 30) — recency decay */
  recency: number;
  /** memory.confidence (0..1) */
  confidence: number;
  /** min(reinforcements/10, 1) — saturated reinforcement signal */
  reinforcements: number;
  /** 1.0 for vector seed, 0.5 for graph 1-hop neighbour */
  graphDistance: number;
  /** weighted sum — same value as RetrievalHit.score post-rerank */
  total: number;
}

export interface MatchSnippet {
  /** Excerpt from memory.content (or .title if content has no overlap). */
  text: string;
  /** Token strings (lowercased) from the query that overlap with this memory. */
  matchedTerms: string[];
  /** Source field where the snippet was harvested from. */
  source: "content" | "title";
}

export interface RetrievalHit {
  memory: Memory;
  /** Reranker total score (recency·conf·reinf·graph weighted sum). */
  score: number;
  source: "vector" | "graph" | "workflow_lookup";
  conflicts_with?: string[];
  /** Populated by Reranker — drives the "why this memory?" UI block. */
  scoreBreakdown?: ScoreBreakdown;
  /**
   * Raw vector similarity from Chroma (1 - distance), if this hit came
   * from a vector match. Graph-only hits don't have one. Preserves the
   * "did this memory actually match the query semantically?" signal that
   * the reranker total score obscures.
   */
  vectorSim?: number;
  /** Snippet of the memory content that overlaps the query (lexical overlap). */
  matchSnippet?: MatchSnippet;
}
