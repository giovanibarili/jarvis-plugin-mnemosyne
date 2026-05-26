// renderers/MnemosynePanel.tsx
//
// Main HUD panel for jarvis-plugin-mnemosyne. Subscribes to its piece's
// data via `useHudPiece(state.id)` and renders:
//   - Top bar with stats (total / short / long), search box, category +
//     project + layer filters, and primary actions.
//   - Scrollable list of MemoryCard components matching the filters.
//   - Right-side detail pane when a memory is selected (full content,
//     evidence, metadata).
//   - Switches to PreflightErrorPanel when bootstrap reports failures.
//   - Switches to WorkflowReplayDialog when a replay is awaiting input.
//
// React + HUD hooks come from the esbuild banner (see globals.d.ts).
// All side-effecting operations (forget, pin, refresh) call HTTP routes
// registered by the plugin under /plugins/jarvis-plugin-mnemosyne/...

import MemoryCard from "./MemoryCard";
import PreflightErrorPanel from "./PreflightErrorPanel";
import WorkflowReplayDialog from "./WorkflowReplayDialog";
import GraphTab from "./GraphTab";
import PromptsTab from "./PromptsTab";
import StatsBlock from "./StatsBlock";
import type {
  Memory,
  PanelData,
  FilterCategory,
  FilterLayer,
  Category,
} from "./types";

const PLUGIN_BASE = "/plugins/jarvis-plugin-mnemosyne";

type ActiveTab = "list" | "graph" | "categories";

interface Props {
  state: {
    id?: string;
    data?: PanelData;
  };
}

const ALL_CATEGORIES: Category[] = [
  "code-pattern",
  "preference",
  "architecture-decision",
  "mental-model",
  "glossary",
  "anti-pattern",
  "workflow",
];

async function postJson(path: string, body?: unknown): Promise<any> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.error("[mnemosyne-panel] HTTP failed:", path, e);
    return { ok: false, error: String(e) };
  }
}

async function getJson(path: string): Promise<any> {
  try {
    const res = await fetch(path);
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.error("[mnemosyne-panel] GET failed:", path, e);
    return null;
  }
}

export default function MnemosynePanel({ state }: Props) {
  const pieceId = state.id ?? "mnemosyne-panel";
  const piece = useHudPiece?.(pieceId);
  const data: PanelData = (piece?.data ?? state?.data ?? {}) as PanelData;

  // ── Routing: preflight / replay / normal ──────────────
  if (data.preflight && (data.preflight.failures?.length ?? 0) > 0) {
    return <PreflightErrorPanel state={state as any} />;
  }
  if (data.replay && data.replay.awaiting === "confirm") {
    return <WorkflowReplayDialog state={state as any} />;
  }

  // ── Local UI state ───────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>("list");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchHits, setSearchHits] = useState<Memory[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [filterCategory, setFilterCategory] = useState<FilterCategory>("all");
  const [filterLayer, setFilterLayer] = useState<FilterLayer>("all");
  const [filterProject, setFilterProject] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Memory fetched on demand when clicked node is not in the preloaded list
  const [fetchedMemory, setFetchedMemory] = useState<Memory | null>(null);
  const [actionStatus, setActionStatus] = useState<string>("");
  const [statsCollapsed, setStatsCollapsed] = useState<boolean>(false);

  const memories: Memory[] = data?.memories ?? [];
  const stats = data?.stats ?? { total: 0, short: 0, long: 0 };

  // Debounce the search input → 300ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Shared semantic search endpoint: vector seeds + 1-hop neighbors (same
  // pipeline as retriever injection). List tab shows ranked seed hits;
  // Graph tab uses both seeds + neighborIds to highlight the subgraph.
  useEffect(() => {
    let cancelled = false;
    if (!debouncedSearch) {
      setSearchHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    (async () => {
      const result = await getJson(
        `${PLUGIN_BASE}/search?q=${encodeURIComponent(debouncedSearch)}`,
      );
      if (cancelled) return;
      if (result && Array.isArray(result.memories)) {
        // List shows seed memories ranked by vector similarity.
        // neighborIds (1-hop graph expansion) are used by Graph tab only.
        setSearchHits(result.memories as Memory[]);
      } else {
        // Fallback to client-side text match if backend unavailable
        setSearchHits(null);
      }
      setSearching(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch]);

  // Project list extracted from current data (fallback when backend has no facets)
  const projects = useMemo(() => {
    const set = new Set<string>();
    for (const m of memories) {
      if (m.project) set.add(m.project);
    }
    return ["all", ...Array.from(set).sort()];
  }, [memories]);

  // Apply filters (category, layer, project, local search fallback)
  const filtered = useMemo(() => {
    const base = searchHits ?? memories;
    const q = debouncedSearch.toLowerCase();
    return base.filter((m) => {
      if (filterCategory !== "all" && m.category !== filterCategory) return false;
      if (filterLayer === "short" && m.promoted_at) return false;
      if (filterLayer === "long" && !m.promoted_at) return false;
      if (filterProject !== "all" && m.project !== filterProject) return false;
      if (!searchHits && q) {
        const hay =
          (m.title + " " + m.content + " " + (m.tags ?? []).join(" ")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [memories, searchHits, debouncedSearch, filterCategory, filterLayer, filterProject]);

  const selected = useMemo(
    () => {
      if (!selectedId) return null;
      const inList = memories.find((m) => m.id === selectedId);
      if (inList) return inList;
      // Use fetchedMemory only when it matches the current selection
      if (fetchedMemory && fetchedMemory.id === selectedId) return fetchedMemory;
      return null;
    },
    [selectedId, memories, fetchedMemory],
  );

  // When selectedId changes and isn't in the preloaded list, fetch from backend.
  // We do NOT clear fetchedMemory immediately to avoid the flicker where selected
  // becomes null between the click and the fetch completing.
  useEffect(() => {
    if (!selectedId) { setFetchedMemory(null); return; }
    if (memories.find((m) => m.id === selectedId)) {
      // In the preloaded list — clear any stale fetched memory
      setFetchedMemory(null);
      return;
    }
    // Not in list — fetch without clearing first (avoids flicker)
    getJson(`${PLUGIN_BASE}/memory?id=${encodeURIComponent(selectedId)}`)
      .then((r: any) => r?.memory ? setFetchedMemory(r.memory as Memory) : setFetchedMemory(null))
      .catch(() => setFetchedMemory(null));
  }, [selectedId, memories]);

  const flash = (msg: string) => {
    setActionStatus(msg);
    setTimeout(() => setActionStatus(""), 2500);
  };

  const handlePin = useCallback(async (id: string, next: boolean) => {
    const r = await postJson(`${PLUGIN_BASE}/pin`, { id, pinned: next });
    flash(r?.ok === false ? `pin failed: ${r.error}` : (next ? "📌 pinned" : "unpinned"));
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    // We keep a tiny confirm step but make it visible so the user can see why
    // a click "did nothing" — Electron's native window.confirm sometimes
    // dismisses without showing in sandboxed/renderer contexts. To avoid that
    // entirely we use a second-click pattern: the first click flashes a
    // warning + arms a 4s window during which a second click actually deletes.
    const armedKey = `__mnemo_delete_armed_${id}`;
    const w = window as any;
    if (w[armedKey]) {
      clearTimeout(w[armedKey]);
      delete w[armedKey];
      flash("🗑 deleting…");
      const r = await postJson(`${PLUGIN_BASE}/forget`, { id });
      flash(r?.ok === false ? `forget failed: ${r.error}` : "🧠 forgotten");
      if (selectedId === id) setSelectedId(null);
      return;
    }
    flash("⚠ click trash again within 4s to forget");
    w[armedKey] = setTimeout(() => { delete w[armedKey]; }, 4000);
  }, [selectedId]);

  const handleConsolidate = useCallback(async () => {
    flash("running consolidator…");
    const r = await postJson(`${PLUGIN_BASE}/consolidate`);
    flash(r?.ok === false ? `consolidate failed: ${r.error}` : "consolidator done");
  }, []);

  // ── Render ───────────────────────────────────────────
  return (
    <div style={styles.container}>
      <div style={styles.topBar}>
        <div style={styles.statsBlock}>
          <span style={styles.statTotal}>{stats.total}</span>
          <span style={styles.statLabel}>memories</span>
          <span style={styles.statSep}>·</span>
          <span style={styles.statShort}>{stats.short}</span>
          <span style={styles.statHint}>short</span>
          <span style={styles.statSep}>·</span>
          <span style={styles.statLong}>{stats.long}</span>
          <span style={styles.statHint}>long</span>
        </div>
        {activeTab === "list" ? (
          <div style={styles.searchWrap}>
            <input
              type="text"
              placeholder="🔍 search memories…"
              value={search}
              onChange={(e: any) => setSearch(e.target.value)}
              style={styles.searchInput}
            />
            {searching ? <span style={styles.searchHint}>…</span> : null}
          </div>
        ) : (
          <span style={styles.tabHint}>
            graph view · click a node for details
          </span>
        )}
      </div>

      <StatsBlock
        runtime={data?.runtime}
        collapsed={statsCollapsed}
        onToggle={() => setStatsCollapsed((v: boolean) => !v)}
      />

      <div style={styles.tabBar}>
        <button
          style={{
            ...styles.tab,
            ...(activeTab === "list" ? styles.tabActive : {}),
          }}
          onClick={() => setActiveTab("list")}
        >
          List
        </button>
        <button
          style={{
            ...styles.tab,
            ...(activeTab === "graph" ? styles.tabActive : {}),
          }}
          onClick={() => setActiveTab("graph")}
        >
          Graph
        </button>
        <button
          style={{
            ...styles.tab,
            ...(activeTab === "categories" ? styles.tabActive : {}),
          }}
          onClick={() => setActiveTab("categories")}
        >
          Categories
        </button>
      </div>

      {activeTab === "list" ? (
        <div style={styles.filterBar}>
          <select
            style={styles.select}
            value={filterCategory}
            onChange={(e: any) => setFilterCategory(e.target.value as FilterCategory)}
          >
            <option value="all">all categories</option>
            {ALL_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select
            style={styles.select}
            value={filterLayer}
            onChange={(e: any) => setFilterLayer(e.target.value as FilterLayer)}
          >
            <option value="all">all layers</option>
            <option value="short">short</option>
            <option value="long">long</option>
          </select>
          <select
            style={styles.select}
            value={filterProject}
            onChange={(e: any) => setFilterProject(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p} value={p}>{p === "all" ? "all projects" : `@${p}`}</option>
            ))}
          </select>
          <span style={styles.filterCount}>
            {filtered.length}/{memories.length} shown
          </span>
        </div>
      ) : null}

      <div style={styles.body}>
        {activeTab === "list" ? (
          <div style={styles.list}>
            {filtered.length === 0 ? (
              <div style={styles.empty}>
                {memories.length === 0
                  ? "No memories yet. Have a conversation with JARVIS — encoded memories appear here."
                  : "No memories match the current filters."}
              </div>
            ) : (
              filtered.map((m) => (
                <MemoryCard
                  key={m.id}
                  memory={m}
                  selected={m.id === selectedId}
                  onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
                  onPin={handlePin}
                  onDelete={handleDelete}
                />
              ))
            )}
          </div>
        ) : activeTab === "graph" ? (
          <GraphTab
            memories={memories}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            projects={projects}
          />
        ) : (
          <PromptsTab />
        )}

        {selected && activeTab !== "categories" ? (
          <div style={styles.detail}>
            <div style={styles.detailHeader}>
              <div style={styles.detailTitle}>{selected.title}</div>
              <button style={styles.closeBtn} onClick={() => setSelectedId(null)} title="Close">
                ✕
              </button>
            </div>
            <div style={styles.detailMeta}>
              <span style={styles.detailChip}>{selected.category}</span>
              {selected.project ? (
                <span style={styles.detailChip}>@{selected.project}</span>
              ) : null}
              <span style={styles.detailChip}>
                {selected.promoted_at ? "long-term" : "short-term"}
              </span>
              <span style={styles.detailChip}>
                confidence {selected.confidence.toFixed(2)}
              </span>
              <span style={styles.detailChip}>↻ {selected.reinforcements}</span>
              {selected.pinned ? (
                <span style={{ ...styles.detailChip, color: "#fbbf24", borderColor: "#fbbf24" }}>
                  ★ pinned
                </span>
              ) : null}
            </div>
            <pre style={styles.detailContent}>{selected.content}</pre>
            {selected.evidence ? (
              <div style={styles.detailEvidenceWrap}>
                <div style={styles.detailLabel}>evidence</div>
                <pre style={styles.detailEvidence}>{selected.evidence}</pre>
              </div>
            ) : null}
            <div style={styles.detailFooter}>
              <span style={styles.idMono}>id: {selected.id}</span>
              <span>
                created {new Date(selected.created_at).toLocaleString()}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <div style={styles.bottomBar}>
        {activeTab === "list" ? (
          <>
            <button style={styles.actionBtn} onClick={handleConsolidate}>
              ⚙ Consolidate now
            </button>
            <a
              style={styles.actionLink}
              href={`${PLUGIN_BASE}/scripts/rebuild-indexes`}
              onClick={(e: any) => {
                e.preventDefault();
                void postJson(`${PLUGIN_BASE}/rebuild-indexes`).then((r) =>
                  flash(r?.ok === false ? `rebuild failed: ${r.error}` : "rebuild requested"),
                );
              }}
            >
              ↻ Rebuild indexes
            </a>
          </>
        ) : activeTab === "graph" ? (
          <span style={styles.tabHint}>
            bolt://127.0.0.1:7687 · live graph · D9
          </span>
        ) : (
          <span style={styles.tabHint}>
            prompts dir: {"{plugin}"}/prompts/ · edits take effect on next extraction
          </span>
        )}
        {data.error ? (
          <span style={styles.errorBanner}>error: {data.error}</span>
        ) : null}
        <span style={styles.statusFlash}>{actionStatus}</span>
      </div>
    </div>
  );
}

const styles: Record<string, any> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    backgroundColor: "#0c0c0c",
    color: "#e0e0e0",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "13px",
    overflow: "hidden",
  },

  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    padding: "10px 12px",
    borderBottom: "1px solid #1f1f1f",
    backgroundColor: "#101010",
  },
  statsBlock: { display: "flex", alignItems: "baseline", gap: "6px" },
  statTotal: { fontSize: "20px", fontWeight: 700, color: "#8b5cf6" },
  statLabel: { fontSize: "11px", color: "#888", textTransform: "uppercase", letterSpacing: "0.05em" },
  statShort: { fontSize: "14px", fontWeight: 600, color: "#aaa" },
  statLong: { fontSize: "14px", fontWeight: 600, color: "#10b981" },
  statHint: { fontSize: "10px", color: "#666", textTransform: "uppercase" },
  statSep: { color: "#333", fontSize: "12px" },

  searchWrap: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    flex: 1,
    maxWidth: "360px",
  },
  searchInput: {
    flex: 1,
    padding: "5px 10px",
    borderRadius: "4px",
    border: "1px solid #2a2a2a",
    backgroundColor: "#161616",
    color: "#e0e0e0",
    fontSize: "12px",
    fontFamily: "inherit",
    outline: "none",
  },
  searchHint: { fontSize: "12px", color: "#888" },
  tabHint: {
    fontSize: "11px",
    color: "#666",
    fontStyle: "italic",
    marginLeft: "auto",
  },

  tabBar: {
    display: "flex",
    gap: "0",
    padding: "0 12px",
    borderBottom: "1px solid #1f1f1f",
    backgroundColor: "#0c0c0c",
  },
  tab: {
    padding: "6px 14px",
    border: "none",
    borderBottom: "2px solid transparent",
    backgroundColor: "transparent",
    color: "#888",
    cursor: "pointer",
    fontSize: "12px",
    fontFamily: "inherit",
    fontWeight: 600,
    outline: "none",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  tabActive: {
    color: "#fff",
    borderBottom: "2px solid #8b5cf6",
  },

  filterBar: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 12px",
    borderBottom: "1px solid #1f1f1f",
    backgroundColor: "#0e0e0e",
  },
  select: {
    padding: "3px 8px",
    borderRadius: "4px",
    border: "1px solid #2a2a2a",
    backgroundColor: "#161616",
    color: "#e0e0e0",
    fontSize: "11px",
    fontFamily: "inherit",
    outline: "none",
  },
  filterCount: { fontSize: "11px", color: "#666", marginLeft: "auto" },

  body: {
    flex: 1,
    display: "flex",
    minHeight: 0,
  },

  list: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px 12px",
    overflowY: "auto",
  },

  empty: {
    color: "#666",
    fontStyle: "italic",
    padding: "40px 16px",
    textAlign: "center",
  },

  detail: {
    width: "360px",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    padding: "12px",
    borderLeft: "1px solid #1f1f1f",
    backgroundColor: "#101010",
    overflowY: "auto",
  },
  detailHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "8px",
  },
  detailTitle: {
    fontSize: "14px",
    fontWeight: 700,
    color: "#fff",
    flex: 1,
    lineHeight: "18px",
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: "14px",
    padding: "0 4px",
    outline: "none",
  },
  detailMeta: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
  },
  detailChip: {
    fontSize: "10px",
    color: "#aaa",
    border: "1px solid #2a2a2a",
    backgroundColor: "#161616",
    padding: "1px 8px",
    borderRadius: "10px",
  },
  detailContent: {
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    fontSize: "12px",
    color: "#ddd",
    backgroundColor: "#0a0a0a",
    border: "1px solid #1f1f1f",
    padding: "8px 10px",
    borderRadius: "4px",
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: "40vh",
    overflowY: "auto",
  },
  detailEvidenceWrap: { display: "flex", flexDirection: "column", gap: "4px" },
  detailLabel: {
    fontSize: "10px",
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontWeight: 600,
  },
  detailEvidence: {
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    fontSize: "11px",
    color: "#a0a0a0",
    backgroundColor: "#0a0a0a",
    border: "1px solid #1f1f1f",
    padding: "6px 8px",
    borderRadius: "4px",
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  detailFooter: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "10px",
    color: "#666",
    paddingTop: "6px",
    borderTop: "1px solid #1f1f1f",
  },
  idMono: { fontFamily: "ui-monospace, Menlo, monospace" },

  bottomBar: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 12px",
    borderTop: "1px solid #1f1f1f",
    backgroundColor: "#101010",
  },
  actionBtn: {
    padding: "4px 10px",
    borderRadius: "4px",
    border: "1px solid #2a2a2a",
    backgroundColor: "#161616",
    color: "#e0e0e0",
    cursor: "pointer",
    fontSize: "12px",
    fontFamily: "inherit",
    outline: "none",
  },
  actionLink: {
    fontSize: "12px",
    color: "#8b5cf6",
    cursor: "pointer",
    textDecoration: "none",
  },
  errorBanner: {
    fontSize: "11px",
    color: "#fca5a5",
    backgroundColor: "#2a0e0e",
    padding: "2px 8px",
    borderRadius: "4px",
    border: "1px solid #3a1414",
  },
  statusFlash: {
    marginLeft: "auto",
    fontSize: "11px",
    color: "#10b981",
    fontStyle: "italic",
    minHeight: "14px",
  },
};
