// renderers/RetrieverTab.tsx
//
// Hermes v2 — dedicated Retriever tab.
// Shows the three-tier architecture: Tier 1 (attention state), Tier 2
// (working memory with amnesia), Tier 3 (reactive retrieval stats),
// and a per-session state table.

import type { RuntimeStats, RetrieverTierStats } from "./types";

function relTime(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

interface Props {
  runtime: RuntimeStats | null | undefined;
  tiers: RetrieverTierStats | null | undefined;
}

export default function RetrieverTab({ runtime, tiers }: Props) {
  const r = runtime?.retriever;
  const sessions = tiers?.sessions ?? {};
  const sessionList = Object.entries(sessions);

  const totalInjected = sessionList.reduce((s, [, v]) => s + v.wmInjected, 0);
  const totalForgotten = sessionList.reduce((s, [, v]) => s + v.wmForgotten, 0);

  return (
    <div style={s.container}>

      {/* Tier 1 — Attention State */}
      <div style={s.tier} data-tier="1">
        <div style={s.tierHeader}>
          <span style={{ ...s.tierBadge, backgroundColor: "#0a1a0d", color: "#00cc66", borderColor: "#226633" }}>TIER 1</span>
          <span style={s.tierTitle}>Attention State</span>
          <span style={s.tierHint}>declared by reviewer after each analysis</span>
        </div>
        {sessionList.length === 0 ? (
          <div style={s.empty}>No sessions with declared attention state yet.</div>
        ) : (
          <div style={s.sessionTable}>
            {sessionList.map(([sid, sv]) => (
              <div key={sid} style={s.sessionRow}>
                <div style={s.sessionId}>{sid}</div>
                <div style={s.sessionDetails}>
                  {sv.tier1Domains.length > 0 ? (
                    <div style={s.domainPills}>
                      {sv.tier1Domains.map(d => (
                        <span key={d} style={s.domainPill}>⬡ {d}</span>
                      ))}
                    </div>
                  ) : (
                    <span style={s.noneHint}>(none declared)</span>
                  )}
                  {sv.tier1UpdatedAt && (
                    <span style={s.updatedAt}>· updated {relTime(sv.tier1UpdatedAt)}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tier 2 — Working Memory */}
      <div style={s.tier} data-tier="2">
        <div style={s.tierHeader}>
          <span style={{ ...s.tierBadge, backgroundColor: "#1a1200", color: "#cccc00", borderColor: "#665500" }}>TIER 2</span>
          <span style={s.tierTitle}>Working Memory</span>
          <span style={s.tierHint}>10-turn amnesia · reset by memory_reinforce</span>
        </div>

        {/* Global WM summary */}
        <div style={s.wmSummary}>
          <WMChip label="injected" value={totalInjected} color="#cccc00" />
          <WMChip label="forgotten" value={totalForgotten} color="#ef4444" />
          <WMChip label="sessions" value={sessionList.length} color="#6b7280" />
        </div>

        {/* Per-session WM rows */}
        {sessionList.length > 0 && (
          <div style={s.sessionTable}>
            {sessionList.map(([sid, sv]) => (
              <div key={sid} style={s.sessionRow}>
                <div style={s.sessionId}>{sid}</div>
                <div style={s.sessionDetails}>
                  <span style={{ color: "#cccc00" }}>{sv.wmInjected} inj</span>
                  <span style={{ color: "#6b7280", margin: "0 4px" }}>·</span>
                  <span style={{ color: sv.wmForgotten > 0 ? "#ef4444" : "#446655" }}>{sv.wmForgotten} amn</span>
                  <span style={{ color: "#6b7280", margin: "0 4px" }}>·</span>
                  <span style={{ color: "#446655" }}>T{sv.turnCounter}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tier 3 — Reactive Retrieval */}
      <div style={s.tier} data-tier="3">
        <div style={s.tierHeader}>
          <span style={{ ...s.tierBadge, backgroundColor: "#0a1520", color: "#6688aa", borderColor: "#334455" }}>TIER 3</span>
          <span style={s.tierTitle}>Reactive Retrieval</span>
          <span style={s.tierHint}>vector + 1-hop graph · cognitive block first</span>
        </div>

        {!r ? (
          <div style={s.empty}>No retrieval data yet.</div>
        ) : (
          <div style={s.statGrid}>
            <StatRow label="retrievals" value={r.retrievals} />
            <StatRow label="with hits" value={`${r.retrievalsWithHits} (${r.retrievals > 0 ? Math.round((r.retrievalsWithHits / r.retrievals) * 100) : 0}%)`} color="#10b981" />
            <StatRow label="avg hits/retrieval" value={r.avgHits.toFixed(1)} color="#3b82f6" />
            <StatRow label="injections" value={`${r.injections} (${r.retrievals > 0 ? Math.round((r.injections / r.retrievals) * 100) : 0}%)`} />
            <StatRow label="cognitive block rendered" value={r.injectionsWithBlock} color="#a855f7" />
            <StatRow label="reinforcements" value={r.reinforcements} color="#f59e0b" />
            <StatRow label="cache hits" value={r.cacheHits} />
            <StatRow label="sessions tracked" value={r.sessionsTracked} />
          </div>
        )}
      </div>

    </div>
  );
}

function WMChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ ...s.chip, borderColor: color + "44" }}>
      <div style={{ ...s.chipVal, color }}>{value}</div>
      <div style={s.chipLabel}>{label}</div>
    </div>
  );
}

function StatRow({ label, value, color = "#aaa" }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={s.statRow}>
      <span style={s.statLabel}>{label}</span>
      <span style={{ ...s.statVal, color }}>{value}</span>
    </div>
  );
}

const s: Record<string, any> = {
  container: { display: "flex", flexDirection: "column", gap: "16px", padding: "12px", overflowY: "auto", height: "100%" },
  tier: { display: "flex", flexDirection: "column", gap: "8px", padding: "10px", borderRadius: "6px", backgroundColor: "#090e18", border: "1px solid #1a2a3a" },
  tierHeader: { display: "flex", alignItems: "center", gap: "8px" },
  tierBadge: { fontFamily: "monospace", fontSize: "9px", fontWeight: 700, padding: "2px 8px", borderRadius: "10px", border: "1px solid", letterSpacing: "0.06em" },
  tierTitle: { fontFamily: "monospace", fontSize: "11px", fontWeight: 600, color: "#d1d5db" },
  tierHint: { fontFamily: "monospace", fontSize: "9px", color: "#446655" },
  sessionTable: { display: "flex", flexDirection: "column", gap: "4px" },
  sessionRow: { display: "flex", alignItems: "center", gap: "8px", padding: "4px 8px", backgroundColor: "#0a1520", borderRadius: "4px" },
  sessionId: { fontFamily: "monospace", fontSize: "10px", color: "#00cc66", width: "120px", flexShrink: 0, textOverflow: "ellipsis", overflow: "hidden" },
  sessionDetails: { display: "flex", alignItems: "center", gap: "4px", flex: 1, flexWrap: "wrap" },
  domainPills: { display: "flex", gap: "4px", flexWrap: "wrap" },
  domainPill: { fontFamily: "monospace", fontSize: "9px", color: "#a855f7", backgroundColor: "#1a0d2e", border: "1px solid #3b1d5a", padding: "1px 6px", borderRadius: "10px" },
  updatedAt: { fontFamily: "monospace", fontSize: "9px", color: "#446655" },
  noneHint: { fontFamily: "monospace", fontSize: "9px", color: "#334455", fontStyle: "italic" },
  wmSummary: { display: "flex", gap: "8px" },
  chip: { display: "flex", flexDirection: "column", alignItems: "center", padding: "6px 12px", backgroundColor: "#0d1b2a", border: "1px solid #1a2a3a", borderRadius: "6px", minWidth: "60px" },
  chipVal: { fontFamily: "monospace", fontSize: "16px", fontWeight: 700 },
  chipLabel: { fontFamily: "monospace", fontSize: "9px", color: "#6b7280", textTransform: "uppercase" },
  statGrid: { display: "flex", flexDirection: "column", gap: "4px" },
  statRow: { display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #0d1520" },
  statLabel: { fontFamily: "monospace", fontSize: "10px", color: "#6b7280" },
  statVal: { fontFamily: "monospace", fontSize: "10px", fontWeight: 600 },
  empty: { fontFamily: "monospace", fontSize: "11px", color: "#446655", fontStyle: "italic", padding: "8px" },
};
