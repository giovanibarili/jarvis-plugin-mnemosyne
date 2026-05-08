// renderers/MemoryInjectionEntry.tsx
//
// Chat timeline renderer for memory injection notifications.
// Loaded dynamically by ChatTimeline when the `mnemosyne-memory-injection`
// rendererKind is encountered. The core has zero knowledge of this file.
//
// React + hooks come from the esbuild banner (globals.d.ts).
//
// Layout (since v0.5.0 — "why this memory" surfacing):
//   header  → "🧠 Mnemosyne — injected N memories"  (always visible)
//   subhdr  → ↳ query: "..."   ◆ vector:N · ◇ graph:N
//   list    → per memory: category badge + title + reinforcements
//             when expanded: source pill, score bar, breakdown line,
//             optional conflicts badge.
//
// Data comes from `payload` (see pieces/index.ts addChatTimelineEntry call).
// We treat every field as optional to stay backward compatible with old
// timeline entries persisted under the previous schema.

interface ScoreBreakdown {
  recency: number;
  confidence: number;
  reinforcements: number;
  graphDistance: number;
  total: number;
}

interface MatchSnippet {
  text: string;
  matchedTerms: string[];
  source: "content" | "title";
}

interface Memory {
  id: string;
  category: string;
  title: string;
  confidence: number;
  reinforcements: number;
  source?: "vector" | "graph" | "workflow_lookup";
  score?: number;
  scoreBreakdown?: ScoreBreakdown;
  conflicts?: string[];
  /** Raw Chroma similarity (1 - distance). Absent for graph-only hits. */
  vectorSim?: number;
  /** Lexical overlap snippet between query and memory content. */
  matchSnippet?: MatchSnippet;
}

interface SourceCounts {
  vector: number;
  graph: number;
  workflow: number;
}

interface Payload {
  count: number;
  query?: string;
  sourceCounts?: SourceCounts;
  memories: Memory[];
}

interface Props {
  text: string;
  payload: unknown;
  expanded?: boolean;
}

const CATEGORY_COLOR: Record<string, string> = {
  "code-pattern":            "#3b82f6",
  preference:                "#8b5cf6",
  "architecture-decision":   "#10b981",
  "mental-model":            "#f59e0b",
  glossary:                  "#6366f1",
  "anti-pattern":            "#ef4444",
  workflow:                  "#ec4899",
};

const SOURCE_META: Record<string, { glyph: string; color: string; label: string }> = {
  vector:          { glyph: "◆", color: "#3b82f6", label: "vector" },
  graph:           { glyph: "◇", color: "#10b981", label: "graph" },
  workflow_lookup: { glyph: "▶", color: "#ec4899", label: "workflow" },
};

/** Truncate a string to N chars with an ellipsis. Keeps query header readable. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Compact 0.123 → "0.12"; preserves whole numbers (e.g. reinforcements raw). */
function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

/**
 * Qualitative label for a cosine similarity in [-1..+1].
 * Thresholds calibrated from observed MiniLM distribution:
 *   on-topic queries cluster at +0.10..+0.30
 *   tangentially related at  −0.05..+0.10
 *   noise/off-topic at       < −0.10
 */
function simLabel(sim: number): { text: string; color: string } {
  if (sim >= 0.20) return { text: "strong",    color: "#10b981" };
  if (sim >= 0.05) return { text: "medium",    color: "#3b82f6" };
  if (sim >= -0.10) return { text: "weak",      color: "#f59e0b" };
  return                  { text: "unrelated", color: "#ef4444" };
}

/** Map cosine similarity (−1..+1) to bar fill (0..1). */
function simToBar(sim: number): number {
  return Math.max(0, Math.min(1, (sim + 1) / 2));
}

export default function MemoryInjectionEntry({ text, payload, expanded: initialExpanded }: Props) {
  const [open, setOpen] = useState(!!initialExpanded);
  const p = payload as Payload | undefined;
  const memories = p?.memories ?? [];
  const query = p?.query;
  const sources = p?.sourceCounts;

  // Build the source-breakdown suffix shown under the title when expanded.
  // Only render counts > 0 to keep it terse.
  const sourceParts: Array<{ glyph: string; color: string; label: string; count: number }> = [];
  if (sources) {
    if (sources.vector)   sourceParts.push({ ...SOURCE_META.vector,          count: sources.vector });
    if (sources.graph)    sourceParts.push({ ...SOURCE_META.graph,           count: sources.graph });
    if (sources.workflow) sourceParts.push({ ...SOURCE_META.workflow_lookup, count: sources.workflow });
  }

  return (
    <div style={{ marginBottom: "2px" }}>
      {/* Header pill — always visible */}
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: open ? "3px 8px 5px 8px" : "3px 8px",
          borderRadius: open ? "4px 4px 0 0" : "4px",
          fontSize: "10px",
          borderLeft: "3px solid #a78bfa",
          background: "#1a1e2e",
          color: "#c4b5fd",
          fontFamily: "var(--font-mono)",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ flex: 1 }}>{text}</span>
          <span style={{ opacity: 0.5, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
        </div>

        {/* Subheader: query + source counts. Only when expanded — keeps the
            collapsed state visually identical to the old card. */}
        {open && (query || sourceParts.length > 0) && (
          <div
            style={{
              marginTop: "3px",
              fontSize: "9px",
              color: "#6b7280",
              display: "flex",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
            }}
          >
            {query && (
              <span title={query}>
                ↳ query: <span style={{ color: "#9ca3af" }}>"{truncate(query, 60)}"</span>
              </span>
            )}
            {sourceParts.map((s, i) => (
              <span key={i} style={{ color: s.color }}>
                {s.glyph} {s.label}:{s.count}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Expanded list */}
      {open && memories.length > 0 && (
        <div
          style={{
            padding: "6px 8px 6px 12px",
            background: "#0d1117",
            borderLeft: "3px solid #a78bfa44",
            borderRadius: "0 0 4px 4px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          {memories.map((m) => {
            const color = CATEGORY_COLOR[m.category] ?? "#9ca3af";
            const srcMeta = m.source ? SOURCE_META[m.source] : undefined;
            const breakdown = m.scoreBreakdown;
            // Bar fraction: cosine similarity is in [−1..+1], so we rebase
            // to [0..1] via (sim+1)/2. A sim of 0 (orthogonal) shows 50% —
            // honest signal that the embedder considers them unrelated.
            // Graph-only hits (no vectorSim) fall back to the rerank score,
            // already in roughly 0..1.
            const barValue = m.vectorSim !== undefined
              ? simToBar(m.vectorSim)
              : Math.max(0, Math.min(1, m.score ?? 0));
            const barFraction = barValue;
            const qualLabel = m.vectorSim !== undefined ? simLabel(m.vectorSim) : null;

            return (
              <div
                key={m.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "3px",
                  fontSize: "10px",
                  lineHeight: "1.4",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {/* Title row */}
                <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "1px 5px",
                      borderRadius: "3px",
                      background: `${color}22`,
                      color,
                      border: `1px solid ${color}44`,
                      fontSize: "9px",
                      flexShrink: 0,
                      letterSpacing: "0.02em",
                    }}
                  >
                    {m.category}
                  </span>
                  <span
                    style={{
                      color: "#bbb",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: 1,
                    }}
                    title={m.title}
                  >
                    {m.title}
                  </span>
                  {m.reinforcements > 0 && (
                    <span style={{ color: "#555", fontSize: "9px", flexShrink: 0 }}>
                      ×{m.reinforcements}
                    </span>
                  )}
                </div>

                {/* Match row — source glyph + similarity (semantic relevance to query)
                    + score bar. Bar reflects vectorSim for vector hits (the
                    "did this match the prompt?" signal), or rerank score for
                    graph hits where vectorSim is absent. */}
                {srcMeta && (m.vectorSim !== undefined || m.score !== undefined) && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      paddingLeft: "12px",
                      fontSize: "9px",
                    }}
                  >
                    <span style={{ color: srcMeta.color, flexShrink: 0 }}>
                      {srcMeta.glyph} {srcMeta.label}
                    </span>
                    {m.vectorSim !== undefined ? (
                      <>
                        <span style={{ color: "#9ca3af", flexShrink: 0 }} title="Cosine similarity between query embedding and memory embedding (range −1..+1)">
                          sim {m.vectorSim >= 0 ? "+" : ""}{fmt(m.vectorSim)}
                        </span>
                        {qualLabel && (
                          <span
                            style={{
                              color: qualLabel.color,
                              background: `${qualLabel.color}1f`,
                              border: `1px solid ${qualLabel.color}55`,
                              padding: "0 4px",
                              borderRadius: "2px",
                              fontSize: "8px",
                              flexShrink: 0,
                              textTransform: "uppercase",
                              letterSpacing: "0.04em",
                            }}
                            title="Qualitative bucket calibrated for MiniLM"
                          >
                            {qualLabel.text}
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={{ color: "#9ca3af", flexShrink: 0 }} title="Pulled in by graph relation (no direct vector match)">
                        graph hit
                      </span>
                    )}
                    {m.score !== undefined && m.vectorSim !== undefined && (
                      <span style={{ color: "#4b5563", flexShrink: 0 }} title="Weighted reranker total (recency·conf·reinf·graph)">
                        · rerank {fmt(m.score)}
                      </span>
                    )}
                    <div
                      style={{
                        flex: 1,
                        maxWidth: "120px",
                        height: "6px",
                        background: "#1f2937",
                        borderRadius: "2px",
                        overflow: "hidden",
                      }}
                      title={`vector similarity bar (0..1)`}
                    >
                      <div
                        style={{
                          width: `${barFraction * 100}%`,
                          height: "100%",
                          background: srcMeta.color,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Match snippet — the actual content fragment that overlapped
                    the query. This is what answers "WHY was this memory pulled
                    for THIS prompt?". When matchedTerms is empty, the vector
                    match was purely semantic (no lexical overlap) — we say so. */}
                {m.matchSnippet && (
                  <div
                    style={{
                      paddingLeft: "12px",
                      color: "#9ca3af",
                      fontSize: "9px",
                      lineHeight: "1.5",
                      fontStyle: m.matchSnippet.source === "title" ? "italic" : "normal",
                    }}
                  >
                    └{" "}
                    {m.matchSnippet.matchedTerms.length > 0 ? (
                      <>
                        matched on{" "}
                        {m.matchSnippet.matchedTerms.slice(0, 4).map((t, i) => (
                          <span key={t}>
                            {i > 0 ? ", " : ""}
                            <span style={{ color: "#fbbf24", background: "#fbbf2422", padding: "0 3px", borderRadius: "2px" }}>
                              {t}
                            </span>
                          </span>
                        ))}
                        :{" "}
                      </>
                    ) : m.vectorSim !== undefined && m.vectorSim < 0 ? (
                      <span style={{ color: "#ef4444" }}>weak/no relation — embedder pulled this anyway: </span>
                    ) : (
                      <span style={{ color: "#6b7280" }}>concept match (no shared words): </span>
                    )}
                    <span style={{ color: m.matchSnippet.matchedTerms.length > 0 ? "#d1d5db" : "#6b7280" }}>
                      {m.matchSnippet.text}
                    </span>
                  </div>
                )}

                {/* Breakdown row — recency · confidence · reinforcements · graph.
                    Tucked below the match info as secondary signal. */}
                {breakdown && (
                  <div
                    style={{
                      paddingLeft: "12px",
                      color: "#6b7280",
                      fontSize: "9px",
                    }}
                    title="Reranker components — weighted in store config"
                  >
                    └ rec {fmt(breakdown.recency)} · conf {fmt(breakdown.confidence)} · reinf {breakdown.reinforcements ? fmt(breakdown.reinforcements) : "0"} · graph {fmt(breakdown.graphDistance, 1)}
                  </div>
                )}

                {/* Conflict badge — surfaces hit.conflicts_with as the
                    Retriever already detects them via Neo4j.getContradictions. */}
                {m.conflicts && m.conflicts.length > 0 && (
                  <div
                    style={{
                      marginTop: "1px",
                      marginLeft: "12px",
                      padding: "2px 6px",
                      borderRadius: "3px",
                      background: "#ef444422",
                      border: "1px solid #ef444466",
                      color: "#ef4444",
                      fontSize: "9px",
                      alignSelf: "flex-start",
                    }}
                    title="These memories disagree per Mnemosyne's conflict detector"
                  >
                    ⚠ conflicts with: {m.conflicts.map((c) => c.slice(0, 4)).join(", ")}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
