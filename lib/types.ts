export type Category =
  | "code-pattern"
  | "preference"
  | "architecture-decision"
  | "mental-model"
  | "glossary"
  | "anti-pattern"
  | "workflow";

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
  present: Category[];
  skip_reason: string | null;
}

export interface TurnContext {
  session_id: string;
  user_message: string;
  assistant_response: string;
  tool_calls: Array<{ tool: string; args: any; result: any }>;
  timestamp: number;
}

export interface RetrievalHit {
  memory: Memory;
  score: number;
  source: "vector" | "graph" | "workflow_lookup";
  conflicts_with?: string[];
}
