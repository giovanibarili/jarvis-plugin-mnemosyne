// renderers/EncoderTab.tsx
//
// Hermes v2 — dedicated Encoder tab.
// Shows the pipeline visual (TRIAGE → CLASSIFY → ENRICH → RELATE) with
// per-stage call counts, cost, and queue depth, plus a live active-step
// indicator and the categories bar chart with cognitive-L2 distinct colors.

import type { RuntimeStats } from "./types";

const COGNITIVE_COLORS: Record<string, string> = {
  "reasoning-pattern": "#f59e0b",
  "decision-heuristic": "#f97316",
  "value-priority": "#a855f7",
};
const STAGE_COLORS: Record<string, string> = {
  triage: "#3b82f6",
  classify: "#10b981",
  enrich: "#f59e0b",
  relate: "#8b5cf6",
};
const STAGES = ["triage", "classify", "enrich", "relate"] as const;

function pct(value: number, max: number): number {
  if (max === 0) return 0;
  return Math.min(100, Math.round((value / max) * 100));
}

function fmt(n: number): string {
  if (n >= 1000) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

interface Props {
  runtime: RuntimeStats | null | undefined;
}

export default function EncoderTab({ runtime }: Props) {
  if (!runtime) {
    return (
      <div style={s.empty}>No encoder data yet — start a conversation to begin extraction.</div>
    );
  }
  const e = runtime.encoder;
  const maxCalls = Math.max(...STAGES.map(st => e.pipeline[st]?.calls ?? 0), 1);

  // Categories
  const categories = Object.entries(e.categoriesCount ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const maxCat = Math.max(...categories.map(([, n]) => n), 1);

  return (
    <div style={s.container}>
      {/* Pipeline visual */}
      <div style={s.section}>
        <div style={s.sectionTitle}>📥 PIPELINE</div>

        {/* Active step indicator */}
        {e.activeStep ? (
          <div style={s.activePill}>
            <span style={{ ...s.dot, backgroundColor: STAGE_COLORS[e.activeStep] }} />
            processing — {e.activeStep}
            {e.queueDepth > 0 && <span style={s.queue}> · queue: {e.queueDepth}</span>}
          </div>
        ) : (
          <div style={s.idlePill}>
            <span style={{ ...s.dot, backgroundColor: "#334455" }} /> idle
            {e.queueDepth > 0 && <span style={s.queue}> · queue: {e.queueDepth}</span>}
          </div>
        )}

        {/* Stage bars */}
        <div style={s.pipeline}>
          {STAGES.map((stage, i) => {
            const st = e.pipeline[stage] ?? { calls: 0, costUsd: 0 };
            const isActive = e.activeStep === stage;
            const width = pct(st.calls, maxCalls);
            return (
              <div key={stage} style={s.stageRow}>
                <div style={{ ...s.stageLabel, color: STAGE_COLORS[stage], fontWeight: isActive ? 700 : 400 }}>
                  {stage}
                </div>
                <div style={s.barWrap}>
                  <div
                    style={{
                      ...s.bar,
                      width: `${Math.max(width, st.calls > 0 ? 4 : 0)}%`,
                      backgroundColor: STAGE_COLORS[stage],
                      opacity: isActive ? 1 : 0.7,
                      boxShadow: isActive ? `0 0 6px ${STAGE_COLORS[stage]}` : "none",
                    }}
                  />
                </div>
                <div style={s.stageMeta}>
                  <span style={s.metaNum}>{st.calls}×</span>
                  <span style={s.metaCost}>{fmt(st.costUsd)}</span>
                </div>
                {i < STAGES.length - 1 && <div style={s.arrow}>→</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Summary stats */}
      <div style={s.section}>
        <div style={s.sectionTitle}>📊 SUMMARY</div>
        <div style={s.statGrid}>
          <StatChip label="turns" value={e.turnsProcessed} color="#aaa" />
          <StatChip label="new" value={e.memoriesWritten} color="#10b981" />
          <StatChip label="dedup" value={e.memoriesDeduped} color="#f59e0b" />
          <StatChip
            label={`skipped (${e.turnsProcessed > 0 ? Math.round((e.turnsSkipped / e.turnsProcessed) * 100) : 0}%)`}
            value={e.turnsSkipped}
            color="#6b7280"
          />
          <StatChip label="errors" value={e.turnsErrored} color="#ef4444" />
          <StatChip label="total cost" value={fmt(e.costUsd)} color="#8b5cf6" />
        </div>
      </div>

      {/* Categories */}
      <div style={s.section}>
        <div style={s.sectionTitle}>🏷 CATEGORIES EXTRACTED</div>
        {categories.length === 0 ? (
          <div style={s.empty}>no candidates yet</div>
        ) : (
          <div style={s.catList}>
            {categories.map(([cat, n]) => {
              const color = COGNITIVE_COLORS[cat] ?? "#3b82f6";
              return (
                <div key={cat} style={s.catRow}>
                  <div style={{ ...s.catLabel, color: COGNITIVE_COLORS[cat] ? color : "#aaa" }}>{cat}</div>
                  <div style={s.catBarWrap}>
                    <div style={{ ...s.catBar, width: `${pct(n, maxCat)}%`, backgroundColor: color }} />
                  </div>
                  <div style={{ ...s.catCount, color }}>{n}</div>
                </div>
              );
            })}
          </div>
        )}
        <div style={s.catFooter}>{e.candidatesEmitted} candidates emitted</div>
      </div>

      {/* Skip reasons */}
      <div style={s.section}>
        <div style={s.sectionTitle}>🚫 SKIP REASONS</div>
        <div style={s.skipGrid}>
          {Object.entries(runtime.skipBuckets ?? {}).map(([k, v]) => (
            <div key={k} style={s.skipRow}>
              <span style={s.skipLabel}>{k}</span>
              <span style={s.skipVal}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatChip({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div style={s.chip}>
      <div style={{ ...s.chipVal, color }}>{value}</div>
      <div style={s.chipLabel}>{label}</div>
    </div>
  );
}

const s: Record<string, any> = {
  container: { display: "flex", flexDirection: "column", gap: "16px", padding: "12px", overflowY: "auto", height: "100%" },
  section: { display: "flex", flexDirection: "column", gap: "8px" },
  sectionTitle: { fontSize: "10px", color: "#446655", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, fontFamily: "monospace" },
  activePill: { display: "inline-flex", alignItems: "center", gap: "6px", padding: "3px 10px", borderRadius: "12px", backgroundColor: "#0d2a1a", border: "1px solid #00aa44", fontSize: "11px", color: "#00cc66", fontFamily: "monospace", width: "fit-content" },
  idlePill: { display: "inline-flex", alignItems: "center", gap: "6px", padding: "3px 10px", borderRadius: "12px", backgroundColor: "#0d1b2a", border: "1px solid #1a2a3a", fontSize: "11px", color: "#446655", fontFamily: "monospace", width: "fit-content" },
  dot: { width: "6px", height: "6px", borderRadius: "50%", display: "inline-block" },
  queue: { color: "#f59e0b", marginLeft: "4px" },
  pipeline: { display: "flex", flexDirection: "column", gap: "6px" },
  stageRow: { display: "flex", alignItems: "center", gap: "8px" },
  stageLabel: { fontFamily: "monospace", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em", width: "60px", flexShrink: 0 },
  barWrap: { flex: 1, height: "8px", backgroundColor: "#1a2a3a", borderRadius: "4px", overflow: "hidden" },
  bar: { height: "100%", borderRadius: "4px", transition: "width 0.3s" },
  stageMeta: { display: "flex", gap: "8px", flexShrink: 0, minWidth: "100px" },
  metaNum: { fontFamily: "monospace", fontSize: "10px", color: "#aaa", width: "32px" },
  metaCost: { fontFamily: "monospace", fontSize: "10px", color: "#6b7280" },
  arrow: { color: "#334455", fontSize: "12px", flexShrink: 0, position: "absolute" as any, display: "none" },
  statGrid: { display: "flex", flexWrap: "wrap", gap: "8px" },
  chip: { display: "flex", flexDirection: "column", alignItems: "center", padding: "6px 12px", backgroundColor: "#0d1b2a", border: "1px solid #1a2a3a", borderRadius: "6px", minWidth: "60px" },
  chipVal: { fontFamily: "monospace", fontSize: "14px", fontWeight: 700 },
  chipLabel: { fontFamily: "monospace", fontSize: "9px", color: "#6b7280", textTransform: "uppercase" },
  catList: { display: "flex", flexDirection: "column", gap: "4px" },
  catRow: { display: "flex", alignItems: "center", gap: "8px" },
  catLabel: { fontFamily: "monospace", fontSize: "10px", width: "160px", flexShrink: 0, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" },
  catBarWrap: { flex: 1, height: "8px", backgroundColor: "#1a2a3a", borderRadius: "4px", overflow: "hidden" },
  catBar: { height: "100%", borderRadius: "4px", transition: "width 0.3s" },
  catCount: { fontFamily: "monospace", fontSize: "10px", width: "24px", textAlign: "right" },
  catFooter: { fontFamily: "monospace", fontSize: "9px", color: "#446655", marginTop: "4px" },
  skipGrid: { display: "flex", flexDirection: "column", gap: "3px" },
  skipRow: { display: "flex", justifyContent: "space-between", fontFamily: "monospace", fontSize: "10px" },
  skipLabel: { color: "#6b7280" },
  skipVal: { color: "#aaa" },
  empty: { fontFamily: "monospace", fontSize: "11px", color: "#446655", fontStyle: "italic", padding: "20px" },
};
