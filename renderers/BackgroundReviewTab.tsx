// renderers/BackgroundReviewTab.tsx
//
// Hermes v2 — dedicated Background Review tab.
// Shows per-session progress toward next review, active reviews,
// config, and a history log of past reviews.

import type { BackgroundReviewStats } from "./types";

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

interface Props {
  data: BackgroundReviewStats | null | undefined;
}

export default function BackgroundReviewTab({ data }: Props) {
  if (!data) {
    return (
      <div style={s.empty}>
        BackgroundReview not running — enable via plugin config: background_review.enabled = true
      </div>
    );
  }

  const { sessions, activeReviews, config, history } = data;
  const sessionList = Object.entries(sessions);

  return (
    <div style={s.container}>

      {/* Config + global status */}
      <div style={s.section}>
        <div style={s.sectionTitle}>⟳ STATUS</div>
        <div style={s.configRow}>
          <Pill label={config.enabled ? "● enabled" : "○ disabled"} color={config.enabled ? "#00cc66" : "#ef4444"} />
          <Pill label={`every ${config.reviewEveryNTurns} turns`} color="#6688aa" />
          <Pill label={`idle: ${config.idleTriggerMinutes}m`} color="#6688aa" />
          {activeReviews > 0 && <Pill label={`${activeReviews} active`} color="#f59e0b" />}
        </div>
      </div>

      {/* Per-session progress */}
      <div style={s.section}>
        <div style={s.sectionTitle}>📊 PER-SESSION PROGRESS</div>
        {sessionList.length === 0 ? (
          <div style={s.empty}>No qualified turns yet — needs {config.reviewEveryNTurns} non-review turns to fire.</div>
        ) : (
          <div style={s.sessionTable}>
            {sessionList.map(([sid, sv]) => {
              const progress = Math.min(sv.turnCount / sv.reviewEveryNTurns, 1);
              const remaining = sv.reviewEveryNTurns - sv.turnCount;
              return (
                <div key={sid} style={s.sessionRow}>
                  <div style={s.sessionId}>{sid}</div>
                  <div style={s.progressWrap}>
                    <div style={{ ...s.progressBar, width: `${progress * 100}%` }} />
                  </div>
                  <div style={s.sessionMeta}>
                    <span style={s.turnCount}>{sv.turnCount}/{sv.reviewEveryNTurns}</span>
                    {remaining > 0 ? (
                      <span style={s.remaining}>{remaining} turns until review</span>
                    ) : (
                      <span style={{ ...s.remaining, color: "#f59e0b" }}>review pending</span>
                    )}
                    {sv.hasIdleTimer && <span style={s.idleTag}>idle timer</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Review history */}
      <div style={s.section}>
        <div style={s.sectionTitle}>📋 REVIEW HISTORY</div>
        {(!history || history.length === 0) ? (
          <div style={s.empty}>No reviews completed yet in this session.</div>
        ) : (
          <div style={s.historyTable}>
            <div style={s.historyHeader}>
              <span style={s.hCol}>session</span>
              <span style={s.hCol}>turn</span>
              <span style={s.hCol}>L1</span>
              <span style={s.hCol}>L2</span>
              <span style={s.hCol}>edges</span>
              <span style={s.hCol}>when</span>
            </div>
            {[...history].reverse().slice(0, 20).map((h, i) => (
              <div key={i} style={{ ...s.historyRow, backgroundColor: i % 2 === 0 ? "#090e18" : "#0a1015" }}>
                <span style={{ ...s.hCell, color: "#00cc66" }}>{h.sessionId?.split("-")[0] ?? "?"}</span>
                <span style={s.hCell}>T{h.turn}</span>
                <span style={{ ...s.hCell, color: h.l1 > 0 ? "#10b981" : "#334455" }}>{h.l1}</span>
                <span style={{ ...s.hCell, color: h.l2 > 0 ? "#a855f7" : "#334455" }}>{h.l2}</span>
                <span style={{ ...s.hCell, color: h.edges > 0 ? "#f59e0b" : "#334455" }}>{h.edges}</span>
                <span style={{ ...s.hCell, color: "#446655" }}>{relTime(h.savedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ fontFamily: "monospace", fontSize: "10px", color, backgroundColor: color + "18", border: `1px solid ${color}44`, padding: "2px 8px", borderRadius: "10px" }}>
      {label}
    </span>
  );
}

const s: Record<string, any> = {
  container: { display: "flex", flexDirection: "column", gap: "16px", padding: "12px", overflowY: "auto", height: "100%" },
  section: { display: "flex", flexDirection: "column", gap: "8px" },
  sectionTitle: { fontSize: "10px", color: "#446655", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, fontFamily: "monospace" },
  configRow: { display: "flex", gap: "8px", flexWrap: "wrap" },
  sessionTable: { display: "flex", flexDirection: "column", gap: "6px" },
  sessionRow: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px", backgroundColor: "#0a1520", borderRadius: "4px" },
  sessionId: { fontFamily: "monospace", fontSize: "10px", color: "#00cc66", width: "100px", flexShrink: 0, textOverflow: "ellipsis", overflow: "hidden" },
  progressWrap: { flex: 1, height: "6px", backgroundColor: "#1a2a3a", borderRadius: "3px", overflow: "hidden" },
  progressBar: { height: "100%", backgroundColor: "#8b5cf6", borderRadius: "3px", transition: "width 0.4s" },
  sessionMeta: { display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 },
  turnCount: { fontFamily: "monospace", fontSize: "10px", color: "#aaa" },
  remaining: { fontFamily: "monospace", fontSize: "9px", color: "#6b7280" },
  idleTag: { fontFamily: "monospace", fontSize: "9px", color: "#f59e0b", backgroundColor: "#2a1800", padding: "1px 6px", borderRadius: "8px", border: "1px solid #664400" },
  historyTable: { display: "flex", flexDirection: "column", gap: "1px" },
  historyHeader: { display: "flex", gap: "0", padding: "4px 8px", backgroundColor: "#0d1b2a", borderRadius: "3px 3px 0 0" },
  historyRow: { display: "flex", gap: "0", padding: "4px 8px" },
  hCol: { fontFamily: "monospace", fontSize: "9px", color: "#446655", textTransform: "uppercase", flex: 1 },
  hCell: { fontFamily: "monospace", fontSize: "10px", color: "#aaa", flex: 1 },
  empty: { fontFamily: "monospace", fontSize: "11px", color: "#446655", fontStyle: "italic", padding: "8px" },
};
