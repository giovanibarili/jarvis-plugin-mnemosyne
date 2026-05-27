import type { RuntimeStats, PipelineStepStats } from "./types";

const PLUGIN_BASE = "/plugins/jarvis-plugin-mnemosyne";

interface Props {
  runtime: RuntimeStats | null | undefined;
  collapsed: boolean;
  onToggle: () => void;
}

function fmtPct(num: number, denom: number): string {
  if (denom <= 0) return "—";
  return `${((num / denom) * 100).toFixed(0)}%`;
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function fmtRelTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

async function triggerRefresh(): Promise<void> {
  await fetch(`${PLUGIN_BASE}/refresh`, { method: "POST" });
}

// ── Pipeline step state ───────────────────────────────────────────────────────
type StepState = "active" | "next" | "idle";

function stepState(
  step: "triage" | "classify" | "enrich" | "relate",
  activeStep: "triage" | "classify" | "enrich" | "relate" | null
): StepState {
  if (activeStep === step) return "active";
  if (activeStep === "triage"   && step === "classify") return "next";
  if (activeStep === "classify" && step === "enrich")   return "next";
  if (activeStep === "enrich"   && step === "relate")   return "next";
  return "idle";
}

// queue per step: only triage has a real queue (turns waiting to enter the
// pipeline). classify = 1 if triage just passed (turn is in classify now),
// relate = 1 if classify just passed. Both are derived from activeStep.
function stepQueue(
  step: "triage" | "classify" | "enrich" | "relate",
  queueDepth: number,
  activeStep: "triage" | "classify" | "enrich" | "relate" | null
): number {
  if (step === "triage")   return activeStep ? queueDepth : 0;
  if (step === "classify") return activeStep === "classify" || activeStep === "enrich" || activeStep === "relate" ? 1 : 0;
  if (step === "enrich")   return activeStep === "enrich" || activeStep === "relate" ? 1 : 0;
  if (step === "relate")   return activeStep === "relate" ? 1 : 0;
  return 0;
}

const STEP_COLORS: Record<StepState, { bar: string; label: string; bg: string; queue: string }> = {
  active: { bar: "#10b981", label: "#10b981", bg: "#0a1f14", queue: "#10b981" },
  next:   { bar: "#065f46", label: "#6ee7b7", bg: "#0a1a10", queue: "#6ee7b7" },
  idle:   { bar: "#2a2a2a", label: "#555",    bg: "#111",    queue: "#444"    },
};

function PipelineTableRow({
  step, stats, state, queue,
}: {
  step: "triage" | "classify" | "enrich" | "relate";
  stats: PipelineStepStats;
  state: StepState;
  queue: number;
}) {
  const c = STEP_COLORS[state];
  return (
    <div style={{ ...s.pipelineRow, backgroundColor: c.bg }}>
      {/* left state bar */}
      <div style={{ ...s.pipelineBar, backgroundColor: c.bar }} />
      {/* step name */}
      <span style={{ ...s.pipelineStepName, color: c.label }}>{step}</span>
      {/* calls */}
      <span style={s.pipelineCalls}>{stats.calls}×</span>
      {/* spend */}
      <span style={{ ...s.pipelineSpend, color: state === "idle" ? "#555" : "#10b981" }}>
        {fmtCost(stats.costUsd)}
      </span>
      {/* queue badge */}
      <div style={{
        ...s.pipelineQueueBadge,
        backgroundColor: queue > 0 ? (state === "active" ? "#1a2f1a" : "#1f1a0a") : "#0d0d0d",
        color: queue > 0 ? (state === "active" ? c.queue : "#f59e0b") : "#2a2a2a",
        border: `1px solid ${queue > 0 ? (state === "active" ? "#1a3f1a" : "#3f2f0a") : "#1a1a1a"}`,
      }}>
        {queue}
      </div>
    </div>
  );
}

export default function StatsBlock({ runtime, collapsed, onToggle }: Props) {
  if (!runtime) {
    return (
      <div style={s.wrap}>
        <div style={s.header} onClick={onToggle}>
          <span style={s.headerTitle}>📊 Runtime stats</span>
          <span style={s.headerHint}>(stats unavailable)</span>
          <button style={s.refreshBtn} onClick={(e: any) => { e.stopPropagation(); void triggerRefresh(); }}>↺</button>
        </div>
      </div>
    );
  }

  const e  = runtime.encoder;
  const r  = runtime.retriever;
  const sb = runtime.skipBuckets;
  const totalSkips = sb.casual + sb["no-signal"] + sb.error + sb.timeout + sb.other;
  const activeStep = e.activeStep ?? null;

  const categories = Object.entries(e.categoriesCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const maxCat = categories.length > 0 ? categories[0][1] : 0;

  return (
    <div style={s.wrap}>
      {/* ── Header ── */}
      <div style={s.header}>
        <div style={s.headerLeft} onClick={onToggle}>
          <span style={s.headerTitle}>📊 Runtime stats</span>
          <span style={s.headerHint}>(since boot)</span>
          <span style={s.headerToggle}>{collapsed ? "▸" : "▾"}</span>
        </div>
        <button style={s.refreshBtn} onClick={(ev: any) => { ev.stopPropagation(); void triggerRefresh(); }} title="Refresh">↺</button>
      </div>

      {!collapsed ? (
        <div style={s.grid}>

          {/* ── ENCODER ── col 1, full height */}
          <div style={s.card}>
            <div style={s.cardTitle}>📥 Encoder</div>

            {/* stats in one horizontal row */}
            <div style={s.statsRow}>
              <StatChip value={e.turnsProcessed} label="turns" color="#e0e0e0" />
              <StatChip value={e.memoriesWritten} label="new" color="#10b981" />
              <StatChip value={e.memoriesDeduped} label="deduped" color="#888" />
              <StatChip value={e.turnsSkipped} label={`skipped (${fmtPct(e.turnsSkipped, e.turnsProcessed)})`} color="#f59e0b" />
              {e.turnsErrored > 0 && <StatChip value={e.turnsErrored} label="errors" color="#ef4444" />}
            </div>

            {/* pipeline table */}
            {e.pipeline ? (
              <>
                <div style={s.pipelineDivider} />
                {/* column headers */}
                <div style={s.pipelineHeaders}>
                  <div style={s.pipelineBar} />
                  <span style={{ ...s.pipelineStepName, color: "#333" }}>STEP</span>
                  <span style={s.pipelineCalls}>CALLS</span>
                  <span style={s.pipelineSpend}>SPEND</span>
                  <span style={s.pipelineQueueBadge}>Q</span>
                </div>
                {(["triage", "classify", "enrich", "relate"] as const).map((step) => (
                  <PipelineTableRow
                    key={step}
                    step={step}
                    stats={e.pipeline![step]}
                    state={stepState(step, activeStep)}
                    queue={stepQueue(step, e.queueDepth, activeStep)}
                  />
                ))}
                <div style={s.pipelineLegend}>
                  Q: triage=fila entrada · classify/relate= 0 ou 1
                </div>
              </>
            ) : null}

            {/* footer */}
            <div style={s.footer}>
              <span style={s.footerHint}>{fmtCost(e.costUsd)} total</span>
              <span style={{ ...s.badge, color: e.processing ? "#10b981" : "#555", backgroundColor: e.processing ? "#0a1f14" : "#181818" }}>
                {e.processing ? "● processing" : "○ idle"}
              </span>
              {e.queueDepth > 0 && (
                <span style={{ ...s.badge, color: "#f59e0b", backgroundColor: "#1f1a0a" }}>
                  queue: {e.queueDepth}
                </span>
              )}
            </div>
          </div>

          {/* ── RETRIEVER ── col 2 */}
          <div style={s.card}>
            <div style={s.cardTitle}>🎯 Retriever</div>
            <MetricRow value={r.retrievals}           label="retrievals"        color="#e0e0e0" />
            <MetricRow value={r.retrievalsWithHits}   label={`with hits (${fmtPct(r.retrievalsWithHits, r.retrievals)})`} color="#10b981" />
            <MetricRow value={r.avgHits.toFixed(1)}   label="avg hits/retrieval" color="#8b5cf6" />
            <MetricRow value={r.injectionsWithBlock}  label={`injections (${fmtPct(r.injectionsWithBlock, r.injections)})`} color="#3b82f6" />
            <MetricRow value={r.reinforcements}       label="reinforcements"     color="#fbbf24" />
            <div style={s.footer}>
              <span style={s.footerHint}>
                {r.cacheHits} cache hit{r.cacheHits === 1 ? "" : "s"} · {r.sessionsTracked} session{r.sessionsTracked === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          {/* ── SKIP REASONS ── col 1 row 2 */}
          <div style={s.card}>
            <div style={s.cardTitle}>🚫 Skip reasons</div>
            {totalSkips === 0 ? (
              <div style={s.empty}>no skips recorded</div>
            ) : (
              <>
                <BucketRow label="casual"    value={sb.casual}          max={totalSkips} color="#888" />
                <BucketRow label="no-signal" value={sb["no-signal"]}    max={totalSkips} color="#9aa0a6" />
                <BucketRow label="error"     value={sb.error}           max={totalSkips} color="#ef4444" />
                <BucketRow label="timeout"   value={sb.timeout}         max={totalSkips} color="#f59e0b" />
                <BucketRow label="other"     value={sb.other}           max={totalSkips} color="#666" />
              </>
            )}
            <div style={s.footer}>
              <span style={s.footerHint}>Haiku map: {fmtRelTime(runtime.bucketMapUpdatedAt)}</span>
            </div>
          </div>

          {/* ── CATEGORIES ── col 2 row 2 */}
          <div style={s.card}>
            <div style={s.cardTitle}>🏷 Categories extracted</div>
            {categories.length === 0 ? (
              <div style={s.empty}>no triage data yet</div>
            ) : (
              categories.map(([cat, n]) => (
                <BucketRow key={cat} label={cat} value={n} max={maxCat} color="#3b82f6" />
              ))
            )}
            <div style={s.footer}>
              <span style={s.footerHint}>
                {e.candidatesEmitted} candidate{e.candidatesEmitted === 1 ? "" : "s"} emitted
              </span>
            </div>
          </div>

        </div>
      ) : null}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatChip({ value, label, color }: { value: number | string; label: string; color: string }) {
  return (
    <div style={s.statChip}>
      <span style={{ ...s.statChipValue, color }}>{value}</span>
      <span style={s.statChipLabel}>{label}</span>
    </div>
  );
}

function MetricRow({ value, label, color }: { value: number | string; label: string; color: string }) {
  return (
    <div style={s.row}>
      <span style={{ ...s.metric, color }}>{value}</span>
      <span style={s.metricLabel}>{label}</span>
    </div>
  );
}

function BucketRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={s.bucketRow}>
      <span style={s.bucketLabel}>{label}</span>
      <div style={s.bucketBarWrap}>
        <div style={{ ...s.bucketBar, width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span style={s.bucketValue}>{value}</span>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, any> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    backgroundColor: "#141414",
    border: "1px solid #2a2a2a",
    borderRadius: "6px",
    margin: "8px 12px",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    padding: "6px 10px",
    backgroundColor: "#181818",
    borderBottom: "1px solid #222",
    userSelect: "none",
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flex: 1,
    cursor: "pointer",
  },
  headerTitle: { fontSize: "12px", fontWeight: 600, color: "#bbb" },
  headerHint:  { fontSize: "11px", color: "#666", flex: 1 },
  headerToggle:{ fontSize: "11px", color: "#666" },
  refreshBtn: {
    background: "none", border: "none", color: "#555",
    cursor: "pointer", fontSize: "13px", padding: "0 0 0 8px", lineHeight: 1, flexShrink: 0,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "8px",
    padding: "10px",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "8px 10px",
    backgroundColor: "#161616",
    border: "1px solid #232323",
    borderRadius: "4px",
    minWidth: 0,
  },
  cardTitle: {
    fontSize: "11px", fontWeight: 600, color: "#9aa0a6",
    textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "4px",
  },

  // stats in one row
  statsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    alignItems: "baseline",
  },
  statChip: {
    display: "flex",
    alignItems: "baseline",
    gap: "3px",
  },
  statChipValue: {
    fontSize: "15px",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
  },
  statChipLabel: {
    fontSize: "10px",
    color: "#555",
  },

  // pipeline table
  pipelineDivider: {
    height: "1px",
    backgroundColor: "#1e1e1e",
    margin: "6px 0 2px",
  },
  pipelineHeaders: {
    display: "flex",
    alignItems: "center",
    gap: "0",
    padding: "0 0 2px 0",
  },
  pipelineRow: {
    display: "flex",
    alignItems: "center",
    borderRadius: "3px",
    marginBottom: "2px",
    overflow: "hidden",
  },
  pipelineBar: {
    width: "3px",
    alignSelf: "stretch",
    flexShrink: 0,
    minHeight: "24px",
  },
  pipelineStepName: {
    fontSize: "11px",
    fontWeight: 600,
    width: "62px",
    paddingLeft: "8px",
    flexShrink: 0,
  },
  pipelineCalls: {
    fontSize: "11px",
    color: "#bbb",
    fontVariantNumeric: "tabular-nums",
    width: "36px",
    textAlign: "right" as const,
    flexShrink: 0,
  },
  pipelineSpend: {
    fontSize: "11px",
    fontVariantNumeric: "tabular-nums",
    flex: 1,
    textAlign: "right" as const,
    paddingRight: "10px",
  },
  pipelineQueueBadge: {
    fontSize: "11px",
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    width: "28px",
    textAlign: "center" as const,
    borderRadius: "4px",
    padding: "2px 0",
    flexShrink: 0,
    margin: "2px 4px",
  },
  pipelineLegend: {
    fontSize: "9px",
    color: "#2a2a2a",
    marginTop: "2px",
    lineHeight: 1.4,
  },

  // metric row (Retriever)
  row: { display: "flex", alignItems: "baseline", gap: "5px" },
  metric: {
    fontSize: "15px", fontWeight: 700, color: "#e0e0e0",
    fontVariantNumeric: "tabular-nums", minWidth: "26px",
  },
  metricLabel: {
    fontSize: "11px", color: "#888", flex: 1,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },

  // footer
  footer: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginTop: "6px",
    paddingTop: "4px",
    borderTop: "1px dashed #1e1e1e",
    flexWrap: "wrap",
  },
  footerHint: { fontSize: "10px", color: "#555", flex: 1 },
  badge: {
    fontSize: "10px",
    padding: "1px 7px",
    borderRadius: "8px",
  },

  empty: { fontSize: "11px", color: "#555", fontStyle: "italic", padding: "4px 0" },

  // bucket rows (Skip / Categories)
  bucketRow: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px" },
  bucketLabel: {
    color: "#9aa0a6", width: "70px", overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0,
  },
  bucketBarWrap: {
    flex: 1, height: "6px", backgroundColor: "#1a1a1a",
    borderRadius: "3px", overflow: "hidden", minWidth: "20px",
  },
  bucketBar: { height: "100%", transition: "width 0.2s ease" },
  bucketValue: {
    fontVariantNumeric: "tabular-nums", color: "#bbb",
    width: "24px", textAlign: "right" as const, flexShrink: 0,
  },
};
