// renderers/StatsBlock.tsx
//
// Hermes-first Runtime Stats. Replaces the dead TRIPLET view
// (triage/classify/enrich/relate/skip-reasons/categories-extracted).
//
// Layout (2 + 1):
//   ┌─────────────── WRITER ──────────────┬─────── RETRIEVER ───────┐
//   │ new_domain / new_entity / new_memory │ T1 attention            │
//   │ writes · rejected · edges            │ T2 working memory       │
//   │ taxonomy: domains · entities         │ T3 reactive retrieval   │
//   └──────────────────────────────────────┴─────────────────────────┘
//   ┌──────────────── BG REVIEW (thin strip) ───────────────────────┐
//   │ status · per-session progress · last-run history              │
//   └────────────────────────────────────────────────────────────────┘
//
// All stats reflect the REAL Hermes flow:
//   hermes-reviewer → new_domain/new_entity/new_memory → store.write
// There is NO eager pipeline, NO triage, NO skip buckets, NO Haiku map.

import type {
  RuntimeStats,
  WriterBlock,
  RetrieverTierStats,
  BackgroundReviewStats,
} from "./types";

const PLUGIN_BASE = "/plugins/jarvis-plugin-mnemosyne";

function relTime(ts: number | null | undefined): string {
  if (!ts) return "never";
  const ms = Date.now() - ts;
  if (ms < 0) return "—";
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

interface Props {
  runtime: RuntimeStats | null | undefined;
  writer: WriterBlock | null | undefined;
  tiers: RetrieverTierStats | null | undefined;
  backgroundReview: BackgroundReviewStats | null | undefined;
  collapsed: boolean;
  onToggle: () => void;
}

export default function StatsBlock({ runtime, writer, tiers, backgroundReview, collapsed, onToggle }: Props) {
  return (
    <div style={s.root}>
      {/* Header bar */}
      <div style={s.header}>
        <span style={s.headerTitle}>
          <span style={{ color: "#00cc66" }}>▦</span> Runtime stats
          <span style={s.headerSub}>Hermes-first · tool-driven</span>
        </span>
        <span style={s.headerActions}>
          <span style={s.iconBtn} onClick={() => void triggerRefresh()} title="Refresh">↻</span>
          <span style={s.iconBtn} onClick={onToggle} title={collapsed ? "Expand" : "Collapse"}>
            {collapsed ? "▾" : "▴"}
          </span>
        </span>
      </div>

      {collapsed ? null : (
        <div style={s.body}>
          {/* Row 1: WRITER | RETRIEVER */}
          <div style={s.twoCol}>
            <WriterSection writer={writer} />
            <RetrieverSection runtime={runtime} tiers={tiers} />
          </div>
          {/* Row 2: BG REVIEW strip */}
          <ReviewStrip data={backgroundReview} />
        </div>
      )}
    </div>
  );
}

// ── WRITER ────────────────────────────────────────────────────────────────────

function WriterSection({ writer }: { writer: WriterBlock | null | undefined }) {
  const sess = writer?.session;
  const tot = writer?.total;
  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>✍️ WRITER <span style={s.sectionHint}>new_domain · new_entity · new_memory</span></div>

      {/* Live session counters */}
      <div style={s.statRow}>
        <Stat label="memories" value={sess?.memoryWrites ?? 0} color="#10b981" />
        <Stat label="rejected" value={sess?.memoryRejected ?? 0} color={(sess?.memoryRejected ?? 0) > 0 ? "#ef4444" : "#6b7280"} />
        <Stat label="edges" value={sess?.edgesCreated ?? 0} color="#f59e0b" />
        {(sess?.edgesFailed ?? 0) > 0 && <Stat label="edge fail" value={sess!.edgesFailed} color="#ef4444" />}
      </div>

      {/* Tool call breakdown */}
      <div style={s.subTable}>
        <ToolRow label="new_domain" calls={sess?.domainCalls ?? 0} created={sess?.domainsCreated ?? 0} color="#a855f7" />
        <ToolRow label="new_entity" calls={sess?.entityCalls ?? 0} created={sess?.entitiesCreated ?? 0} color="#8b5cf6" />
        <ToolRow label="new_memory" calls={(sess?.memoryWrites ?? 0) + (sess?.memoryRejected ?? 0)} created={sess?.memoryWrites ?? 0} color="#10b981" />
      </div>

      {/* Historical totals (disk) */}
      <div style={s.taxonomyBar}>
        <span style={s.taxItem}>⬡ <b style={{ color: "#a855f7" }}>{tot?.domains ?? 0}</b> domains</span>
        <span style={s.taxItem}>◇ <b style={{ color: "#8b5cf6" }}>{tot?.entities ?? 0}</b> entities</span>
        <span style={s.taxItem}>✎ <b style={{ color: "#10b981" }}>{tot?.memoriesViaTool ?? 0}</b> via tool</span>
        <span style={s.taxLast}>last write: {relTime(sess?.lastWriteAt)}</span>
      </div>
    </div>
  );
}

function ToolRow({ label, calls, created, color }: { label: string; calls: number; created: number; color: string }) {
  const noop = calls - created;
  return (
    <div style={s.toolRow}>
      <span style={{ ...s.toolLabel, color }}>{label}</span>
      <span style={s.toolCalls}>{calls}×</span>
      <span style={s.toolMeta}>
        {created > 0 && <span style={{ color }}>{created} new</span>}
        {noop > 0 && <span style={{ color: "#6b7280", marginLeft: created > 0 ? "6px" : 0 }}>{noop} no-op</span>}
        {calls === 0 && <span style={{ color: "#334455" }}>—</span>}
      </span>
    </div>
  );
}

// ── RETRIEVER ─────────────────────────────────────────────────────────────────

function RetrieverSection({ runtime, tiers }: { runtime: RuntimeStats | null | undefined; tiers: RetrieverTierStats | null | undefined }) {
  const r = runtime?.retriever;
  const sessions = Object.entries(tiers?.sessions ?? {});
  const totalInj = sessions.reduce((a, [, v]) => a + v.wmInjected, 0);
  const totalForg = sessions.reduce((a, [, v]) => a + v.wmForgotten, 0);
  const activeDomains = sessions.flatMap(([, v]) => v.tier1Domains);

  return (
    <div style={s.section}>
      <div style={s.sectionTitle}>📥 RETRIEVER <span style={s.sectionHint}>3-tier · cognitive-first</span></div>

      {/* T1 — attention */}
      <div style={s.tierLine}>
        <span style={{ ...s.tierTag, color: "#00cc66", borderColor: "#226633" }}>T1</span>
        <span style={s.tierLabel}>attention</span>
        {activeDomains.length > 0 ? (
          <span style={s.tierDomains}>{activeDomains.slice(0, 4).map((d) => <span key={d} style={s.domainPill}>⬡ {d}</span>)}</span>
        ) : (
          <span style={s.tierNone}>none declared</span>
        )}
      </div>

      {/* T2 — working memory */}
      <div style={s.tierLine}>
        <span style={{ ...s.tierTag, color: "#cccc00", borderColor: "#665500" }}>T2</span>
        <span style={s.tierLabel}>working mem</span>
        <span style={s.tierVals}>
          <b style={{ color: "#cccc00" }}>{totalInj}</b> inj
          <span style={s.dot}>·</span>
          <b style={{ color: totalForg > 0 ? "#ef4444" : "#446655" }}>{totalForg}</b> forgotten
          <span style={s.dot}>·</span>
          {sessions.length} sess
        </span>
      </div>

      {/* T3 — reactive */}
      <div style={s.tierLine}>
        <span style={{ ...s.tierTag, color: "#6688aa", borderColor: "#334455" }}>T3</span>
        <span style={s.tierLabel}>reactive</span>
        <span style={s.tierVals}>
          <b>{r?.retrievals ?? 0}</b> retr
          <span style={s.dot}>·</span>
          <b style={{ color: "#10b981" }}>{r?.retrievalsWithHits ?? 0}</b> hits
          <span style={s.dot}>·</span>
          <b style={{ color: "#a855f7" }}>{r?.injectionsWithBlock ?? 0}</b> cog-block
          <span style={s.dot}>·</span>
          <b style={{ color: "#f59e0b" }}>{r?.reinforcements ?? 0}</b> reinf
        </span>
      </div>
    </div>
  );
}

// ── BG REVIEW strip ───────────────────────────────────────────────────────────

function ReviewStrip({ data }: { data: BackgroundReviewStats | null | undefined }) {
  const enabled = data?.config?.enabled ?? false;
  const sessions = Object.entries(data?.sessions ?? {});
  const history = data?.history ?? [];
  const every = data?.config?.reviewEveryNTurns ?? 5;

  return (
    <div style={s.reviewStrip}>
      <span style={s.reviewTitle}>⟳ BG REVIEW</span>
      <span style={{ ...s.reviewStatus, color: enabled ? "#00cc66" : "#6b7280" }}>
        {enabled ? "● auto" : "○ manual"}
      </span>
      <span style={s.reviewSep}>·</span>

      {/* Per-session progress */}
      {sessions.length === 0 ? (
        <span style={s.reviewNone}>no turns counted</span>
      ) : (
        sessions.slice(0, 3).map(([sid, sv]) => (
          <span key={sid} style={s.reviewSession}>
            <span style={s.reviewSid}>{sid.split("-")[0]}</span>
            <span style={s.reviewProg}>{sv.turnCount}/{sv.reviewEveryNTurns ?? every}</span>
            {sv.hasIdleTimer && <span style={s.idleDot} title="idle timer armed">◷</span>}
          </span>
        ))
      )}

      <span style={s.reviewSpacer} />

      {/* Activity count */}
      {(data?.activeReviews ?? 0) > 0 && <span style={s.reviewActive}>● {data!.activeReviews} active</span>}

      {/* Last review */}
      {history.length > 0 ? (() => {
        const last = history[history.length - 1];
        return (
          <span style={s.reviewLast}>
            last: <b style={{ color: "#10b981" }}>{last.l1}</b>L1
            <span style={s.dot}>·</span>
            <b style={{ color: "#a855f7" }}>{last.l2}</b>L2
            <span style={s.dot}>·</span>
            <b style={{ color: "#f59e0b" }}>{last.edges}</b>e
            <span style={s.reviewWhen}>{relTime(last.savedAt)}</span>
          </span>
        );
      })() : (
        <span style={s.reviewLast}><span style={{ color: "#334455" }}>no reviews yet</span></span>
      )}
    </div>
  );
}

// ── primitives ────────────────────────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div style={s.stat}>
      <span style={{ ...s.statVal, color }}>{value}</span>
      <span style={s.statLabel}>{label}</span>
    </div>
  );
}

const s: Record<string, any> = {
  root: { backgroundColor: "#070b14", border: "1px solid #141f30", borderRadius: "6px", margin: "8px 12px", overflow: "hidden" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 12px", backgroundColor: "#0a1018", borderBottom: "1px solid #141f30" },
  headerTitle: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", fontWeight: 600, color: "#cdd6e0", fontFamily: "monospace" },
  headerSub: { fontSize: "9px", color: "#446655", fontWeight: 400, marginLeft: "4px" },
  headerActions: { display: "flex", gap: "8px" },
  iconBtn: { cursor: "pointer", color: "#6b7280", fontSize: "12px", userSelect: "none" },
  body: { padding: "10px 12px", display: "flex", flexDirection: "column", gap: "10px" },
  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" },

  section: { display: "flex", flexDirection: "column", gap: "8px", padding: "8px", backgroundColor: "#090e18", border: "1px solid #141f30", borderRadius: "5px" },
  sectionTitle: { fontSize: "10px", color: "#88a", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700, fontFamily: "monospace", display: "flex", alignItems: "center", gap: "6px" },
  sectionHint: { fontSize: "8px", color: "#446655", fontWeight: 400, textTransform: "none", letterSpacing: 0 },

  statRow: { display: "flex", gap: "10px", flexWrap: "wrap" },
  stat: { display: "flex", flexDirection: "column", alignItems: "center", minWidth: "44px" },
  statVal: { fontFamily: "monospace", fontSize: "16px", fontWeight: 700 },
  statLabel: { fontFamily: "monospace", fontSize: "8px", color: "#6b7280", textTransform: "uppercase" },

  subTable: { display: "flex", flexDirection: "column", gap: "2px" },
  toolRow: { display: "flex", alignItems: "center", gap: "8px", fontFamily: "monospace", fontSize: "10px" },
  toolLabel: { width: "84px", flexShrink: 0 },
  toolCalls: { width: "32px", color: "#aaa", textAlign: "right" },
  toolMeta: { flex: 1 },

  taxonomyBar: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", paddingTop: "4px", borderTop: "1px solid #0d1520", fontFamily: "monospace", fontSize: "9px", color: "#88a" },
  taxItem: { display: "flex", alignItems: "center", gap: "3px" },
  taxLast: { marginLeft: "auto", color: "#446655" },

  tierLine: { display: "flex", alignItems: "center", gap: "6px", fontFamily: "monospace", fontSize: "10px" },
  tierTag: { fontSize: "8px", fontWeight: 700, padding: "1px 5px", borderRadius: "8px", border: "1px solid", flexShrink: 0 },
  tierLabel: { color: "#88a", width: "78px", flexShrink: 0 },
  tierVals: { color: "#aaa", display: "flex", alignItems: "center", gap: "3px", flexWrap: "wrap" },
  tierDomains: { display: "flex", gap: "4px", flexWrap: "wrap" },
  tierNone: { color: "#334455", fontStyle: "italic", fontSize: "9px" },
  domainPill: { fontSize: "8px", color: "#a855f7", backgroundColor: "#1a0d2e", border: "1px solid #3b1d5a", padding: "0 5px", borderRadius: "8px" },
  dot: { color: "#334455", margin: "0 2px" },

  reviewStrip: { display: "flex", alignItems: "center", gap: "6px", padding: "6px 10px", backgroundColor: "#0d0a1a", border: "1px solid #2a1a4a", borderRadius: "5px", fontFamily: "monospace", fontSize: "10px", flexWrap: "wrap" },
  reviewTitle: { color: "#8866ee", fontWeight: 700, letterSpacing: "0.04em" },
  reviewStatus: { fontSize: "9px" },
  reviewSep: { color: "#334455" },
  reviewNone: { color: "#446655", fontStyle: "italic", fontSize: "9px" },
  reviewSession: { display: "flex", alignItems: "center", gap: "3px", backgroundColor: "#0a1520", padding: "1px 6px", borderRadius: "8px" },
  reviewSid: { color: "#00cc66", fontSize: "9px" },
  reviewProg: { color: "#8866ee" },
  idleDot: { color: "#f59e0b", fontSize: "9px" },
  reviewSpacer: { flex: 1 },
  reviewActive: { color: "#f59e0b", fontSize: "9px" },
  reviewLast: { color: "#88a", display: "flex", alignItems: "center", gap: "2px" },
  reviewWhen: { color: "#446655", marginLeft: "5px", fontSize: "9px" },
};
