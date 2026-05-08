// renderers/MemoryCard.tsx
//
// Compact card for a single Memory. Pure presentation + click handlers.
// React (`createElement`) and HUD hooks come from the esbuild banner —
// see `renderers/globals.d.ts` for the ambient declarations.

import type { Memory, Category } from "./types";

interface Props {
  memory: Memory;
  selected?: boolean;
  onSelect?: (id: string) => void;
  onPin?: (id: string, next: boolean) => void;
  onDelete?: (id: string) => void;
}

const CATEGORY_COLOR: Record<Category, string> = {
  "code-pattern": "#3b82f6",
  preference: "#8b5cf6",
  "architecture-decision": "#10b981",
  "mental-model": "#f59e0b",
  glossary: "#6366f1",
  "anti-pattern": "#ef4444",
  workflow: "#ec4899",
};

const CATEGORY_LABEL: Record<Category, string> = {
  "code-pattern": "code",
  preference: "pref",
  "architecture-decision": "decision",
  "mental-model": "model",
  glossary: "term",
  "anti-pattern": "anti",
  workflow: "wf",
};

function formatRelative(ts: number): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  return `${mon}mo ago`;
}

export default function MemoryCard({ memory, selected, onSelect, onPin, onDelete }: Props) {
  const promoted = !!memory.promoted_at;
  const conflict = !!memory.has_conflict;
  const pinned = !!memory.pinned;

  const baseStyle: any = { ...styles.card };
  if (promoted) Object.assign(baseStyle, styles.cardPromoted);
  if (pinned) Object.assign(baseStyle, styles.cardPinned);
  if (selected) Object.assign(baseStyle, styles.cardSelected);

  const stop = (e: any) => { e.stopPropagation(); };

  return (
    <div
      style={baseStyle}
      onClick={() => onSelect?.(memory.id)}
      title={memory.id}
    >
      <div style={styles.headerRow}>
        <span
          style={{ ...styles.categoryChip, backgroundColor: CATEGORY_COLOR[memory.category] }}
        >
          {CATEGORY_LABEL[memory.category]}
        </span>
        <span style={styles.title}>{memory.title}</span>
        <div style={styles.headerRight}>
          {conflict ? (
            <span style={styles.conflictBadge} title="Conflicts with another memory">
              ⚠ conflict
            </span>
          ) : null}
          {promoted ? <span style={styles.layerBadge}>long</span> : <span style={styles.layerBadgeShort}>short</span>}
          <div style={styles.actions} onClick={stop}>
            <button
              style={pinned ? { ...styles.iconBtn, color: "#fbbf24" } : styles.iconBtn}
              onClick={(e: any) => { stop(e); onPin?.(memory.id, !pinned); }}
              title={pinned ? "Unpin" : "Pin (immune to decay)"}
            >
              {pinned ? "★" : "☆"}
            </button>
            <button
              style={styles.iconBtnDanger}
              onClick={(e: any) => { stop(e); onDelete?.(memory.id); }}
              title="Forget this memory"
            >
              🗑
            </button>
          </div>
        </div>
      </div>

      <div style={styles.content}>{memory.content}</div>

      <div style={styles.metaRow}>
        <div style={styles.tagWrap}>
          {(memory.tags ?? []).slice(0, 4).map((t) => (
            <span key={t} style={styles.tag}>#{t}</span>
          ))}
          {memory.project ? <span style={styles.project}>@{memory.project}</span> : null}
        </div>
        <div style={styles.dates}>
          <span title={`reinforcements: ${memory.reinforcements}`}>↻ {memory.reinforcements}</span>
          <span title={new Date(memory.last_accessed).toISOString()}>
            seen {formatRelative(memory.last_accessed)}
          </span>
          <span title={new Date(memory.created_at).toISOString()}>
            born {formatRelative(memory.created_at)}
          </span>
        </div>
      </div>

    </div>
  );
}

const styles: Record<string, any> = {
  card: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px 12px",
    borderRadius: "6px",
    border: "1px solid #2a2a2a",
    backgroundColor: "#161616",
    cursor: "pointer",
    transition: "background-color 0.15s ease, border-color 0.15s ease",
  },
  cardPromoted: { backgroundColor: "#1a1d24" },
  cardPinned: { borderColor: "#fbbf24", boxShadow: "0 0 0 1px rgba(251, 191, 36, 0.25) inset" },
  cardSelected: { borderColor: "#8b5cf6", backgroundColor: "#1d1828" },

  headerRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  categoryChip: {
    padding: "1px 8px",
    borderRadius: "10px",
    fontSize: "10px",
    fontWeight: 600,
    color: "#fff",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    flexShrink: 0,
  },
  title: {
    fontWeight: 600,
    fontSize: "13px",
    color: "#e0e0e0",
    flex: 1,
    minWidth: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  headerRight: {
    display: "flex",
    gap: "4px",
    alignItems: "center",
    flexShrink: 0,
  },
  layerBadge: {
    fontSize: "10px",
    color: "#10b981",
    border: "1px solid #10b981",
    padding: "0 6px",
    borderRadius: "8px",
    textTransform: "uppercase",
  },
  layerBadgeShort: {
    fontSize: "10px",
    color: "#666",
    border: "1px solid #333",
    padding: "0 6px",
    borderRadius: "8px",
    textTransform: "uppercase",
  },
  conflictBadge: {
    fontSize: "10px",
    color: "#fff",
    backgroundColor: "#ef4444",
    padding: "1px 6px",
    borderRadius: "8px",
    fontWeight: 600,
  },
  content: {
    fontSize: "12px",
    color: "#bbb",
    lineHeight: "16px",
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
  },
  metaRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
  },
  tagWrap: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    minWidth: 0,
    flex: 1,
  },
  tag: {
    fontSize: "10px",
    color: "#9aa0a6",
    backgroundColor: "#1f1f1f",
    padding: "1px 6px",
    borderRadius: "10px",
  },
  project: {
    fontSize: "10px",
    color: "#60a5fa",
    backgroundColor: "#0e1a2a",
    padding: "1px 6px",
    borderRadius: "10px",
  },
  dates: {
    display: "flex",
    gap: "8px",
    fontSize: "10px",
    color: "#666",
    flexShrink: 0,
  },
  actions: {
    display: "flex",
    gap: "2px",
    opacity: 0.65,
    marginLeft: "4px",
  },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: "13px",
    width: "20px",
    height: "20px",
    padding: 0,
    borderRadius: "4px",
    outline: "none",
  },
  iconBtnDanger: {
    background: "transparent",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: "12px",
    width: "20px",
    height: "20px",
    padding: 0,
    borderRadius: "4px",
    outline: "none",
  },
};
