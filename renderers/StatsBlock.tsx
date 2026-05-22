// renderers/StatsBlock.tsx
//
// Inline collapsible runtime metrics block for the Mnemosyne HUD panel.
//
// Displays four cards in a 4-column grid:
//   1. Encoder    — turn throughput, new memories, dedupe, cost since boot
//   2. Retriever  — retrievals, hit rate, injection rate, reinforcements
//   3. Skip reasons — bucketed counts (Haiku-classified, fallback heuristics)
//   4. Categories — bar chart of category mix from triage
//
// Pure presentation. All numbers come from PanelData.runtime which is built
// server-side in lib/stats.ts. The block is collapsible (default open) so
// users with smaller HUD panels can hide it.
//
// React (createElement) is supplied by the esbuild banner — see globals.d.ts.

import type { RuntimeStats } from "./types";

const PLUGIN_BASE = "/plugins/jarvis-plugin-mnemosyne";

interface Props {
  runtime: RuntimeStats | null | undefined;
  collapsed: boolean;
  onToggle: () => void;
}

function fmtPct(num: number, denom: number): string {
  if (denom <= 0) return "—";
  const pct = (num / denom) * 100;
  return `${pct.toFixed(0)}%`;
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

export default function StatsBlock({ runtime, collapsed, onToggle }: Props) {
  // Empty state: bootstrap may not have completed yet, or stats wiring is
  // disabled. We still render the toggle so the layout is stable.
  if (!runtime) {
    return (
      <div style={styles.wrap}>
        <div style={styles.header} onClick={onToggle}>
          <span style={styles.headerTitle}>📊 Runtime stats</span>
          <span style={styles.headerHint}>(stats unavailable)</span>
          <button style={styles.refreshBtn} onClick={(e: any) => { e.stopPropagation(); void triggerRefresh(); }} title="Refresh">↺</button>
        </div>
      </div>
    );
  }

  const e = runtime.encoder;
  const r = runtime.retriever;
  const sb = runtime.skipBuckets;
  const totalSkips = sb.casual + sb["no-signal"] + sb.error + sb.timeout + sb.other;

  // Categories: take top 5 by count for compact display.
  const categories = Object.entries(e.categoriesCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const maxCat = categories.length > 0 ? categories[0][1] : 0;

  return (
    <div style={styles.wrap}>
      <div style={styles.header} onClick={onToggle}>
        <span style={styles.headerTitle}>📊 Runtime stats</span>
        <span style={styles.headerHint}>(since boot)</span>
        <button style={styles.refreshBtn} onClick={(e: any) => { e.stopPropagation(); void triggerRefresh(); }} title="Refresh stats">↺</button>
        <span style={styles.headerToggle}>{collapsed ? "▸" : "▾"}</span>
      </div>

      {!collapsed ? (
        <div style={styles.grid}>
          {/* ── Encoder ── */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>📥 Encoder</div>
            <div style={styles.row}>
              <span style={styles.metric}>{e.turnsProcessed}</span>
              <span style={styles.metricLabel}>turns processed</span>
            </div>
            <div style={styles.row}>
              <span style={{ ...styles.metric, color: "#10b981" }}>{e.memoriesWritten}</span>
              <span style={styles.metricLabel}>new memories</span>
            </div>
            <div style={styles.row}>
              <span style={{ ...styles.metric, color: "#888" }}>{e.memoriesDeduped}</span>
              <span style={styles.metricLabel}>deduped</span>
            </div>
            <div style={styles.row}>
              <span style={{ ...styles.metric, color: "#f59e0b" }}>{e.turnsSkipped}</span>
              <span style={styles.metricLabel}>skipped</span>
              <span style={styles.metricSub}>
                ({fmtPct(e.turnsSkipped, e.turnsProcessed)})
              </span>
            </div>
            {e.turnsErrored > 0 ? (
              <div style={styles.row}>
                <span style={{ ...styles.metric, color: "#ef4444" }}>{e.turnsErrored}</span>
                <span style={styles.metricLabel}>errors</span>
              </div>
            ) : null}
            <div style={styles.footer}>
              <span style={styles.footerHint}>{fmtCost(e.costUsd)} spent</span>
              <span style={styles.footerBadge}>queue: {e.queueDepth}</span>
              <span style={{
                ...styles.footerBadge,
                color: e.processing ? "#10b981" : "#555",
              }}>
                {e.processing ? "● processing" : "○ idle"}
              </span>
            </div>
          </div>

          {/* ── Retriever ── */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>🎯 Retriever</div>
            <div style={styles.row}>
              <span style={styles.metric}>{r.retrievals}</span>
              <span style={styles.metricLabel}>retrievals</span>
            </div>
            <div style={styles.row}>
              <span style={{ ...styles.metric, color: "#10b981" }}>{r.retrievalsWithHits}</span>
              <span style={styles.metricLabel}>with hits</span>
              <span style={styles.metricSub}>
                ({fmtPct(r.retrievalsWithHits, r.retrievals)})
              </span>
            </div>
            <div style={styles.row}>
              <span style={{ ...styles.metric, color: "#8b5cf6" }}>
                {r.avgHits.toFixed(1)}
              </span>
              <span style={styles.metricLabel}>avg hits/retrieval</span>
            </div>
            <div style={styles.row}>
              <span style={{ ...styles.metric, color: "#3b82f6" }}>{r.injectionsWithBlock}</span>
              <span style={styles.metricLabel}>injections</span>
              <span style={styles.metricSub}>
                ({fmtPct(r.injectionsWithBlock, r.injections)})
              </span>
            </div>
            <div style={styles.row}>
              <span style={{ ...styles.metric, color: "#fbbf24" }}>{r.reinforcements}</span>
              <span style={styles.metricLabel}>reinforcements</span>
            </div>
            <div style={styles.footer}>
              <span style={styles.footerHint}>
                {r.cacheHits} cache hit{r.cacheHits === 1 ? "" : "s"} · {r.sessionsTracked} session{r.sessionsTracked === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          {/* ── Skip reasons ── */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>🚫 Skip reasons</div>
            {totalSkips === 0 ? (
              <div style={styles.empty}>no skips recorded</div>
            ) : (
              <>
                <BucketRow label="casual" value={sb.casual} max={totalSkips} color="#888" />
                <BucketRow label="no-signal" value={sb["no-signal"]} max={totalSkips} color="#9aa0a6" />
                <BucketRow label="error" value={sb.error} max={totalSkips} color="#ef4444" />
                <BucketRow label="timeout" value={sb.timeout} max={totalSkips} color="#f59e0b" />
                <BucketRow label="other" value={sb.other} max={totalSkips} color="#666" />
              </>
            )}
            <div style={styles.footer}>
              <span style={styles.footerHint}>
                Haiku map: {fmtRelTime(runtime.bucketMapUpdatedAt)}
              </span>
            </div>
          </div>

          {/* ── Categories ── */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>🏷 Categories extracted</div>
            {categories.length === 0 ? (
              <div style={styles.empty}>no triage data yet</div>
            ) : (
              categories.map(([cat, n]) => (
                <BucketRow key={cat} label={cat} value={n} max={maxCat} color="#3b82f6" />
              ))
            )}
            <div style={styles.footer}>
              <span style={styles.footerHint}>
                {e.candidatesEmitted} candidate{e.candidatesEmitted === 1 ? "" : "s"} emitted
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BucketRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div style={styles.bucketRow}>
      <span style={styles.bucketLabel}>{label}</span>
      <div style={styles.bucketBarWrap}>
        <div style={{ ...styles.bucketBar, width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span style={styles.bucketValue}>{value}</span>
    </div>
  );
}

const styles: Record<string, any> = {
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
    gap: "6px",
    padding: "6px 10px",
    cursor: "pointer",
    backgroundColor: "#181818",
    borderBottom: "1px solid #222",
    userSelect: "none",
  },
  headerTitle: {
    fontSize: "12px",
    fontWeight: 600,
    color: "#bbb",
  },
  headerHint: {
    fontSize: "11px",
    color: "#666",
    flex: 1,
  },
  headerToggle: {
    fontSize: "11px",
    color: "#666",
  },
  refreshBtn: {
    background: "none",
    border: "none",
    color: "#555",
    cursor: "pointer",
    fontSize: "13px",
    padding: "0 2px",
    lineHeight: 1,
    marginLeft: "auto",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
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
    fontSize: "11px",
    fontWeight: 600,
    color: "#9aa0a6",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    marginBottom: "4px",
  },
  row: {
    display: "flex",
    alignItems: "baseline",
    gap: "5px",
  },
  metric: {
    fontSize: "15px",
    fontWeight: 700,
    color: "#e0e0e0",
    fontVariantNumeric: "tabular-nums",
    minWidth: "26px",
  },
  metricLabel: {
    fontSize: "11px",
    color: "#888",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  metricSub: {
    fontSize: "10px",
    color: "#555",
    fontVariantNumeric: "tabular-nums",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    marginTop: "4px",
    paddingTop: "4px",
    borderTop: "1px dashed #232323",
    flexWrap: "wrap",
  },
  footerHint: {
    fontSize: "10px",
    color: "#555",
  },
  footerBadge: {
    fontSize: "10px",
    color: "#888",
    backgroundColor: "#1f1f1f",
    padding: "1px 6px",
    borderRadius: "8px",
  },
  empty: {
    fontSize: "11px",
    color: "#555",
    fontStyle: "italic",
    padding: "4px 0",
  },
  bucketRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "11px",
  },
  bucketLabel: {
    color: "#9aa0a6",
    width: "70px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  bucketBarWrap: {
    flex: 1,
    height: "6px",
    backgroundColor: "#1a1a1a",
    borderRadius: "3px",
    overflow: "hidden",
    minWidth: "20px",
  },
  bucketBar: {
    height: "100%",
    transition: "width 0.2s ease",
  },
  bucketValue: {
    fontVariantNumeric: "tabular-nums",
    color: "#bbb",
    width: "24px",
    textAlign: "right",
    flexShrink: 0,
  },
};
