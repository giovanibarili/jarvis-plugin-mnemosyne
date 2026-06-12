// renderers/types.ts
//
// Shared frontend types for Mnemosyne HUD renderers.
//
// Intentionally NOT importing from `lib/types.ts`: esbuild bundles each
// renderer file independently and pulling backend types would also pull
// the entire dependency graph (chromadb, neo4j-driver, gray-matter, etc.).
// Mirror the minimal shape required by the renderers here.

export type Category =
  | "code-pattern"
  | "preference"
  | "architecture-decision"
  | "mental-model"
  | "glossary"
  | "anti-pattern"
  | "workflow"
  // Hermes v2 cognitive categories
  | "reasoning-pattern"
  | "decision-heuristic"
  | "value-priority";

export type Visibility = "open" | "private";

export type Layer = "short" | "long";

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
  /** Optional flag set by the conflict detector — surfaces a red badge in the card. */
  has_conflict?: boolean;
}

export interface MemoryStats {
  total: number;
  short: number;
  long: number;
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

export interface Workflow {
  id: string;
  name: string;
  description: string;
  trigger: string;
  outcome: string;
  applies_to_project: string | null;
  steps: WorkflowStep[];
  confidence: number;
  reinforcements: number;
  created_at: number;
  last_used: number;
}

export interface PreflightFailure {
  check: string;
  reason: string;
  action?: string;
}

/**
 * Data shape published by `pieces/panel.ts` on the `hud.update` channel.
 * Renderers consume this via `useHudPiece(state.id)?.data`.
 */
/** Runtime metrics block produced by lib/stats.ts. Optional in PanelData
 *  because older builds and degraded states (bootstrap-failure path) don't
 *  populate it. */
export interface PipelineStepStats {
  calls: number;
  costUsd: number;
}

export interface RuntimeStats {
  encoder: {
    turnsProcessed: number;
    turnsSkipped: number;
    turnsErrored: number;
    candidatesEmitted: number;
    memoriesWritten: number;
    memoriesDeduped: number;
    costUsd: number;
    queueDepth: number;
    processing: boolean;
    categoriesCount: Record<string, number>;
    pipeline: {
      triage:   PipelineStepStats;
      classify: PipelineStepStats;
      enrich:   PipelineStepStats;
      relate:   PipelineStepStats;
    };
    activeStep: "triage" | "classify" | "enrich" | "relate" | null;
  };
  retriever: {
    retrievals: number;
    retrievalsWithHits: number;
    cacheHits: number;
    hitsTotal: number;
    avgHits: number;
    reinforcements: number;
    injections: number;
    injectionsWithBlock: number;
    sessionsTracked: number;
  };
  skipBuckets: {
    casual: number;
    "no-signal": number;
    error: number;
    timeout: number;
    other: number;
  };
  totalMemories: number;
  bucketMapUpdatedAt: string | null;
}

// ── Hermes v2 new data shapes ────────────────────────────────────────────────

/** BackgroundReviewPiece state — per session + global. */
export interface BackgroundReviewStats {
  sessions: Record<string, {
    turnCount: number;
    reviewEveryNTurns: number;
    hasIdleTimer: boolean;
  }>;
  activeReviews: number;
  config: {
    enabled: boolean;
    reviewEveryNTurns: number;
    idleTriggerMinutes: number;
  };
  history: Array<{
    sessionId: string;
    turn: number;
    l1: number;
    l2: number;
    edges: number;
    savedAt: number;
  }>;
}

/** Retriever tier state — per session. */
export interface RetrieverTierStats {
  sessions: Record<string, {
    turnCounter: number;
    wmInjected: number;
    wmForgotten: number;
    tier1Domains: string[];
    tier1Categories: string[];
    tier1UpdatedAt: number | null;
  }>;
}

/** Hermes-first WRITER stats — live (session) + historical (disk). */
export interface WriterBlock {
  session: {
    domainCalls: number;
    domainsCreated: number;
    entityCalls: number;
    entitiesCreated: number;
    memoryWrites: number;
    memoryRejected: number;
    edgesCreated: number;
    edgesFailed: number;
    lastWriteAt: number | null;
  } | null;
  total: {
    memoriesViaTool: number;
    domains: number;
    entities: number;
  };
}

/** Consolidator last run stats. */
export interface ConsolidatorLastRun {
  promoted: number;
  decayed: number;
  conflicts: number;
  merged: number;
  skillsPromoted: number;
  ranAt: number | null;
}

export interface PanelData {
  memories: Memory[];
  stats: MemoryStats;
  /** Live runtime metrics — encoder, retriever, skip buckets. */
  runtime?: RuntimeStats | null;
  /** Hermes v2: BackgroundReview state. */
  backgroundReview?: BackgroundReviewStats | null;
  /** Hermes v2: Retriever tier state (working memory + attention). */
  retrieverTiers?: RetrieverTierStats | null;
  /** Hermes v2: Consolidator last run. */
  consolidatorLastRun?: ConsolidatorLastRun | null;
  /** Hermes-first: WRITER stats (replaces encoder pipeline). */
  writer?: WriterBlock | null;
  /** Set when the bootstrap fails or the store is unavailable. */
  error?: string;
  /** Set when preflight blocks plugin start. PreflightErrorPanel renders this. */
  preflight?: { failures: PreflightFailure[] };
  /** Set when an interactive workflow replay is awaiting user confirmation. */
  replay?: {
    workflow: Workflow;
    currentStep: number;
    awaiting: "confirm" | "idle";
  };
}

export type FilterCategory = Category | "all" | "cognitive";
export type FilterLayer = Layer | "all";

export type ReplayDecision = "yes" | "skip" | "abort";
