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

// ── Taxon visual palette (mirrors GraphTab) ───────────────────────────────────
const TAXON_TYPE_COLORS: Record<string, string> = {
  "business-unit": "#c084fc",
  "domain":        "#a855f7",
  "service":       "#8b5cf6",
  "entity":        "#818cf8",
  "model":         "#0ea5e9",
  "topic":         "#16a34a",
  "table":         "#78716c",
};

const TAXON_TYPE_ICONS: Record<string, string> = {
  "business-unit": "⬡",
  "domain":        "⬡",
  "service":       "◈",
  "entity":        "◆",
  "model":         "▲",
  "topic":         "⬮",
  "table":         "▪",
};

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
  // Hermes v2 cognitive categories
  "reasoning-pattern",
  "decision-heuristic",
  "value-priority",
];

const COGNITIVE_CATEGORIES = new Set(["reasoning-pattern", "decision-heuristic", "value-priority"]);
const COGNITIVE_COLORS: Record<string, string> = {
  "reasoning-pattern": "#f59e0b",
  "decision-heuristic": "#f97316",
  "value-priority": "#a855f7",
};

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
  const [filterDomain, setFilterDomain] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Edges connected to the currently selected node (from graph click or Neo4j fetch)
  const [nodeEdges, setNodeEdges] = useState<import('./GraphTab').SelectedEdge[]>([]);
  // Domain or Entity node selected from the graph (not a Memory)
  const [selectedTaxon, setSelectedTaxon] = useState<{ type: string; slug: string; description?: string; } | null>(null);

  // Fetch edges for a node (Memory, Domain, or Entity) directly from Neo4j.
  // Returns edges with direction: outgoing (this->other) and incoming (other->this).
  const fetchEdgesForNode = useCallback(async (nodeId: string, nodeLabel: "Memory" | "Domain" | "Entity" | "Taxon") => {
    try {
      // For Memory: fetch Memory↔Memory semantic edges + Domain/Entity taxonomy edges
      // For Domain/Entity: fetch all edges (HAS_ENTITY, BELONGS_TO, ABOUT, semantic)
      const statement = nodeLabel === "Memory"
        ? `
            MATCH (m:Memory {id: $id})
            OPTIONAL MATCH (m)-[r1]->(other1:Memory)
            OPTIONAL MATCH (other2:Memory)-[r2]->(m)
            OPTIONAL MATCH (m)-[r3:BELONGS_TO]->(d:Domain)
            OPTIONAL MATCH (m)-[r4:ABOUT]->(e:Entity)
            WITH m,
                 collect(DISTINCT {rel: r1, target: other1, dir: "out", targetDesc: other1.evidence}) AS outEdges,
                 collect(DISTINCT {rel: r2, target: other2, dir: "in",  targetDesc: other2.evidence}) AS inEdges,
                 collect(DISTINCT {rel: r3, target: d,      dir: "out", targetDesc: d.description, kind: "domain"}) AS domEdges,
                 collect(DISTINCT {rel: r4, target: e,      dir: "out", targetDesc: e.description, kind: "entity"}) AS entEdges
            UNWIND (outEdges + inEdges + domEdges + entEdges) AS edge
            WITH m, edge WHERE edge.rel IS NOT NULL
            RETURN
              type(edge.rel)                                   AS relType,
              coalesce(edge.rel.relation, type(edge.rel))      AS relation,
              coalesce(edge.rel.reason, edge.rel.evidence)     AS reason,
              edge.targetDesc                                  AS targetDesc,
              m.title                                          AS fromTitle,
              coalesce(edge.target.title, edge.target.slug)    AS toTitle,
              edge.target.id                                   AS otherId,
              edge.target.slug                                 AS otherSlug,
              edge.dir                                         AS direction,
              coalesce(edge.kind, "memory")                    AS targetKind
          `
        : `
            MATCH (n {slug: $id}) WHERE n:Taxon OR n:Domain OR n:Entity
            MATCH (n)-[r]->(other)
            RETURN
              type(r)                                          AS relType,
              coalesce(r.relation, type(r))                    AS relation,
              coalesce(r.reason, r.evidence)                   AS reason,
              coalesce(other.description, other.evidence)      AS targetDesc,
              n.slug                                           AS fromTitle,
              coalesce(other.title, other.slug)                AS toTitle,
              other.id                                         AS otherId,
              other.slug                                       AS otherSlug,
              "out"                                            AS direction,
              CASE WHEN other:Domain THEN "domain"
                   WHEN other:Entity THEN "entity"
                   ELSE "memory" END                          AS targetKind
            UNION ALL
            MATCH (n {slug: $id}) WHERE n:Domain OR n:Entity
            MATCH (other)-[r]->(n)
            RETURN
              type(r)                                          AS relType,
              coalesce(r.relation, type(r))                    AS relation,
              coalesce(r.reason, r.evidence)                   AS reason,
              coalesce(other.description, other.title, other.evidence) AS targetDesc,
              n.slug                                           AS fromTitle,
              coalesce(other.title, other.slug)                AS toTitle,
              other.id                                         AS otherId,
              other.slug                                       AS otherSlug,
              "in"                                             AS direction,
              CASE WHEN other:Domain THEN "domain"
                   WHEN other:Entity THEN "entity"
                   ELSE "memory" END                          AS targetKind
          `;

      const res = await fetch("http://127.0.0.1:7474/db/neo4j/tx/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Basic bmVvNGo6" },
        body: JSON.stringify({ statements: [{ statement, parameters: { id: nodeId } }] }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const rows = data?.results?.[0]?.data ?? [];
      const edges: (import('./GraphTab').SelectedEdge & { direction: "in" | "out"; targetKind: string; targetDesc: string | null })[] = rows.map((row: any) => {
        const [relType, relation, reason, targetDesc, fromTitle, toTitle, otherId, otherSlug, direction, targetKind] = row.row ?? [];
        return {
          relation:   relation ?? relType ?? "relates to",
          reason:     reason ?? null,
          evidence:   null,
          targetDesc: targetDesc ?? null,
          fromTitle:  fromTitle ?? null,
          toTitle:    toTitle ?? null,
          otherId:    otherId ?? otherSlug ?? null,
          direction:  direction ?? "out",
          targetKind: targetKind ?? "memory",
        };
      });
      setNodeEdges(edges as any);
    } catch {
      // Neo4j unreachable — silently skip
    }
  }, []);

  // Fetch full taxon node data (description + any extra props) from Neo4j.
  const fetchTaxonDescription = useCallback(async (slug: string, nodeLabel: string) => {
    try {
      const stmt = `MATCH (n {slug: $slug}) WHERE n:Taxon OR n:Domain OR n:Entity RETURN n.description AS description LIMIT 1`;
      void nodeLabel; // type used for intent only
      const res = await fetch("http://127.0.0.1:7474/db/neo4j/tx/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Basic bmVvNGo6" },
        body: JSON.stringify({ statements: [{ statement: stmt, parameters: { slug } }] }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const description = data?.results?.[0]?.data?.[0]?.row?.[0] ?? null;
      if (description) {
        setSelectedTaxon((prev) => prev?.slug === slug ? { ...prev, description } : prev);
      }
    } catch { /* Neo4j unreachable */ }
  }, []);

  // Whenever selectedTaxon changes, fetch its description if missing.
  useEffect(() => {
    if (!selectedTaxon || selectedTaxon.description) return;
    fetchTaxonDescription(selectedTaxon.slug, selectedTaxon.type);
  }, [selectedTaxon, fetchTaxonDescription]);

  // Whenever selectedId changes (from any source), load its edges from Neo4j.
  // NOTE: do NOT clear selectedTaxon here — taxon selection sets selectedId=null intentionally.
  useEffect(() => {
    if (!selectedId) { setNodeEdges([]); return; }
    setSelectedTaxon(null);
    fetchEdgesForNode(selectedId, "Memory");
  }, [selectedId, fetchEdgesForNode]);

  // Stable callbacks for GraphTab — must not be inline arrows or the neovis
  // useEffect will re-run (and destroy the graph) on every MnemosynePanel render.
  const handleGraphSelect = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleGraphSelectEdge = useCallback((_edge: import('./GraphTab').SelectedEdge | null) => {
    // No longer used — edges are shown inside the node detail panel via onSelectNode
  }, []);
  const handleGraphSelectNode = useCallback((selection: import('./GraphTab').NodeSelection | null) => {
    if (!selection) { setSelectedId(null); setSelectedTaxon(null); return; }

    const nodeProps = (selection as any).properties ?? {};
    const nodeLabels: string[] = (selection as any).labels ?? [];

    // Detect Taxon: :Taxon/:Domain/:Entity label, taxon_type property, or heuristic (slug + no title/id/category)
    const isTaxon = nodeLabels.includes("Taxon")
      || nodeLabels.includes("Domain")
      || nodeLabels.includes("Entity")
      || !!nodeProps.taxon_type
      || (!!nodeProps.slug && !nodeProps.title && !nodeProps.id && !nodeProps.category);

    if (isTaxon) {
      const slug = nodeProps.slug ?? selection.id;
      // Prefer explicit taxon_type, then infer from Neo4j label, then fallback
      const type: string = nodeProps.taxon_type
        ?? (nodeLabels.includes("Domain") ? "domain"
          : nodeLabels.includes("Entity") ? "entity"
          : "taxon");
      const description = nodeProps.description ?? null;
      setSelectedTaxon({ type, slug, description });
      setSelectedId(null);
      fetchEdgesForNode(slug, "Taxon");
    } else {
      setSelectedTaxon(null);
      setSelectedId(selection.id ?? null);
    }
  }, [fetchEdgesForNode]);
  // Memory fetched on demand when clicked node is not in the preloaded list
  const [fetchedMemory, setFetchedMemory] = useState<Memory | null>(null);
  const [fetchingMemory, setFetchingMemory] = useState<boolean>(false);
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

  // Hermes v2: domain list from memory domain fields
  const domains = useMemo(() => {
    const set = new Set<string>();
    for (const m of memories) {
      const d = (m as any).domain;
      if (d) set.add(d);
    }
    return set.size > 0 ? ["all", ...Array.from(set).sort()] : ["all"];
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
      if (filterDomain !== "all" && (m as any).domain !== filterDomain) return false;
      if (!searchHits && q) {
        const hay =
          (m.title + " " + m.content + " " + (m.tags ?? []).join(" ")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [memories, searchHits, debouncedSearch, filterCategory, filterLayer, filterProject]);

  // selected: the memory to show in the detail pane.
  // Priority: preloaded list > fetchedMemory (must match selectedId).
  const selected = useMemo(() => {
    if (!selectedId) return null;
    return memories.find((m) => m.id === selectedId) ?? 
      (fetchedMemory?.id === selectedId ? fetchedMemory : null);
  }, [selectedId, memories, fetchedMemory]);

  // Fetch on-demand when the clicked node is not in the preloaded list.
  // Clear immediately on every selectedId change to avoid showing stale data.
  useEffect(() => {
    // Always clear stale fetchedMemory when selection changes
    setFetchedMemory(null);

    if (!selectedId) { setFetchingMemory(false); return; }
    if (selectedId === "__resolving__") { setFetchingMemory(true); return; } // wait for real ID
    if (memories.find((m) => m.id === selectedId)) { setFetchingMemory(false); return; } // already in list

    setFetchingMemory(true);
    let cancelled = false;
    getJson(`${PLUGIN_BASE}/memory?id=${encodeURIComponent(selectedId)}`)
      .then((r: any) => {
        if (!cancelled) {
          setFetchedMemory(r?.memory ? (r.memory as Memory) : null);
          setFetchingMemory(false);
        }
      })
      .catch(() => { if (!cancelled) { setFetchedMemory(null); setFetchingMemory(false); } });
    return () => { cancelled = true; };
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

      {/* Setup warnings — shown until user configures the missing settings */}
      {(data?.setupWarnings ?? []).map((w: any) => (
        <div key={w.code} style={styles.setupWarning}>
          <span style={styles.setupWarningIcon}>⚠</span>
          <div style={styles.setupWarningBody}>
            <span style={styles.setupWarningMsg}>{w.message}</span>
            <span style={styles.setupWarningAction}>→ {w.action}</span>
          </div>
        </div>
      ))}

      {/* Hermes v2: header pills for BG Review + Consolidator */}
      <div style={styles.hermesPills}>
        {data?.backgroundReview ? (() => {
          const br = data.backgroundReview!;
          const mainSession = Object.entries(br.sessions)[0];
          const [sid, sv] = mainSession ?? ["main", { turnCount: 0, reviewEveryNTurns: 5, hasIdleTimer: false }];
          const remaining = (sv?.reviewEveryNTurns ?? 5) - (sv?.turnCount ?? 0);
          return (
            <div style={styles.hermesPill} title="Background review progress — see Runtime Stats">
              <span style={{ color: "#8866ee", marginRight: "4px" }}>⟳</span>
              <span style={{ color: "#554488" }}>review: </span>
              <span style={{ color: "#8866ee" }}>{sv?.turnCount ?? 0}/{sv?.reviewEveryNTurns ?? 5}</span>
              {br.activeReviews > 0 && <span style={{ color: "#f59e0b", marginLeft: "4px" }}>● active</span>}
              {remaining <= 0 && <span style={{ color: "#f59e0b", marginLeft: "4px" }}>pending</span>}
            </div>
          );
        })() : null}
        {data?.consolidatorLastRun && (data.consolidatorLastRun.promoted + data.consolidatorLastRun.decayed + data.consolidatorLastRun.skillsPromoted) > 0 ? (
          <div style={styles.hermesPill}>
            <span style={{ color: "#ccaa00", marginRight: "4px" }}>⚙</span>
            <span style={{ color: "#886600" }}>last run: </span>
            {data.consolidatorLastRun.promoted > 0 && <span style={{ color: "#10b981", marginRight: "4px" }}>+{data.consolidatorLastRun.promoted}</span>}
            {data.consolidatorLastRun.decayed > 0 && <span style={{ color: "#ef4444", marginRight: "4px" }}>-{data.consolidatorLastRun.decayed}</span>}
            {data.consolidatorLastRun.skillsPromoted > 0 && <span style={{ color: "#f59e0b" }}>↑{data.consolidatorLastRun.skillsPromoted} skills</span>}
          </div>
        ) : null}
      </div>

      <StatsBlock
        runtime={data?.runtime}
        writer={data?.writer}
        tiers={data?.retrieverTiers}
        backgroundReview={data?.backgroundReview}
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
          {/* Hermes v2: domain filter */}
          {domains.length > 1 ? (
            <select
              style={styles.select}
              value={filterDomain}
              onChange={(e: any) => setFilterDomain(e.target.value)}
            >
              {domains.map((d: string) => (
                <option key={d} value={d}>{d === "all" ? "all domains" : `⬡ ${d}`}</option>
              ))}
            </select>
          ) : null}
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
            onSelect={handleGraphSelect}
            onSelectEdge={handleGraphSelectEdge}
            onSelectNode={handleGraphSelectNode}
            projects={projects}
          />
        ) : (
          <PromptsTab />
        )}

        {selectedTaxon && activeTab === "graph" ? (
          <div style={styles.detail}>
            <div style={styles.detailHeader}>
              <div style={styles.detailTitle}>{selectedTaxon.slug}</div>
              <button style={styles.closeBtn} onClick={() => { setSelectedTaxon(null); setNodeEdges([]); }} title="Close">✕</button>
            </div>
            <div style={styles.detailMeta}>
              <span style={{
                ...styles.detailChip,
                color: TAXON_TYPE_COLORS[selectedTaxon.type] ?? "#9ca3af",
                borderColor: (TAXON_TYPE_COLORS[selectedTaxon.type] ?? "#9ca3af") + "44",
                fontWeight: 700,
              }}>
                {(TAXON_TYPE_ICONS[selectedTaxon.type] ?? "◆")} {selectedTaxon.type}
              </span>
            </div>
            {selectedTaxon.description ? (
              <div style={styles.detailContent}>{selectedTaxon.description}</div>
            ) : (
              <div style={{ ...styles.detailContent, color: "#6b7280", fontStyle: "italic" }}>no description</div>
            )}
            {nodeEdges.length > 0 ? (
              <div style={styles.detailEvidenceWrap}>
                <div style={styles.detailLabel}>connections ({nodeEdges.length})</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {nodeEdges.map((e: any, i: number) => {
                    const relColors: Record<string, string> = {
                      "BELONGS_TO": "#a855f7", "ABOUT": "#8b5cf6", "HAS_ENTITY": "#6d28d9",
                      "reinforces": "#10b981", "extends": "#3b82f6", "contradicts": "#ef4444",
                      "supersede": "#a855f7", "derived_from": "#10b981",
                    };
                    const color = relColors[e.relation] ?? "#9ca3af";
                    const isOut = e.direction === "out";
                    const dirArrow = isOut ? "→" : "←";
                    const otherLabel = isOut ? e.toTitle : e.fromTitle;
                    return (
                      <div key={i} style={{
                        padding: "6px 8px", borderRadius: "4px",
                        border: `1px solid ${color}44`, backgroundColor: "#0e0e0e",
                        cursor: e.otherId ? "pointer" : "default",
                      }}
                        onClick={() => {
                          if (!e.otherId) return;
                          if (e.targetKind === "memory") {
                            setSelectedTaxon(null); setSelectedId(e.otherId);
                          } else {
                            fetchEdgesForNode(e.otherId, e.targetKind === "domain" ? "Domain" : "Entity");
                            setSelectedTaxon({ type: e.targetKind, slug: e.otherId });
                          }
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span style={{ fontSize: "10px", color, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            {dirArrow} {e.relation.replace(/_/g, " ")}
                          </span>
                          {otherLabel ? (
                            <span style={{ fontSize: "11px", color: "#d1d5db", flex: 1, wordBreak: "break-word" }}>
                              {otherLabel}
                            </span>
                          ) : null}
                        </div>
                        {e.reason ? (
                          <div style={{ fontSize: "11px", color: "#9ca3af", lineHeight: 1.4, marginTop: "3px" }}>{e.reason}</div>
                        ) : null}
                        {(e as any).targetDesc && !(e as any).reason ? (
                          <div style={{ fontSize: "11px", color: "#6b7280", lineHeight: 1.4, marginTop: "3px", fontStyle: "italic" }}>{(e as any).targetDesc}</div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {(selected || (selectedId && fetchingMemory)) && activeTab !== "categories" ? (
          <div style={styles.detail}>
            <div style={styles.detailHeader}>
              <div style={styles.detailTitle}>
                {selected ? selected.title : <span style={{ color: "#888", fontStyle: "italic" }}>loading…</span>}
              </div>
              <button style={styles.closeBtn} onClick={() => setSelectedId(null)} title="Close">
                ✕
              </button>
            </div>
            {selected ? (<>
            <div style={styles.detailMeta}>
              {/* Category chip — cognitive categories get distinct color */}
              <span style={{
                ...styles.detailChip,
                ...(COGNITIVE_CATEGORIES.has(selected.category) ? {
                  color: COGNITIVE_COLORS[selected.category] ?? "#aaa",
                  borderColor: COGNITIVE_COLORS[selected.category] ?? "#2a2a2a",
                } : {}),
              }}>{selected.category}</span>
              {/* Hermes v2: domain + entity chips */}
              {(selected as any).domain ? (
                <span style={{ ...styles.detailChip, color: "#a855f7", borderColor: "#3b1d5a" }}>
                  ⬡ {(selected as any).domain}
                </span>
              ) : null}
              {(selected as any).entity ? (
                <span style={{ ...styles.detailChip, color: "#8b5cf6", borderColor: "#2d1b4e" }}>
                  ◈ {(selected as any).entity}
                </span>
              ) : null}
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
            <div style={styles.detailContent}>{selected.content}</div>
            {selected.evidence ? (
              <div style={styles.detailEvidenceWrap}>
                <div style={styles.detailLabel}>evidence</div>
                <div style={styles.detailEvidence}>{selected.evidence}</div>
              </div>
            ) : null}
            {nodeEdges.length > 0 ? (
              <div style={styles.detailEvidenceWrap}>
                <div style={styles.detailLabel}>relations ({nodeEdges.length})</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {nodeEdges.map((e, i) => {
                    const relColors: Record<string, string> = {
                      "reinforces": "#10b981", "extends": "#3b82f6",
                      "example-of": "#06b6d4", "depends-on": "#f59e0b",
                      "contradicts": "#ef4444", "supersede": "#a855f7",
                      "same_as": "#06b6d4", "inherits": "#8b5cf6",
                      "shortcut_for": "#f59e0b", "derived_from": "#10b981",
                      "enables": "#3b82f6", "opposes": "#ef4444",
                    };
                    const color = relColors[e.relation] ?? "#9ca3af";
                    const isExplicit = (e as any).source === "explicit";
                    const otherTitle = e.fromTitle === selected.title ? e.toTitle : e.fromTitle;
                    return (
                      <div
                        key={i}
                        style={{
                          padding: "6px 8px",
                          borderRadius: "4px",
                          border: `1px solid ${isExplicit ? color + "88" : color + "33"}`,
                          backgroundColor: isExplicit ? "#0f0e14" : "#0e0e0e",
                          cursor: e.otherId ? "pointer" : "default",
                        }}
                        onClick={() => {
                          if (e.otherId) setSelectedId(e.otherId);
                          // nodeEdges auto-reloaded by useEffect on selectedId change
                        }}
                        title={e.otherId ? `Open: ${otherTitle}` : undefined}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: e.reason ? "4px" : 0 }}>
                          <span style={{ fontSize: "10px", color, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            {e.relation.replace(/_/g, " ")}
                          </span>
                          {isExplicit ? (
                            <span style={{ fontSize: "9px", color: "#6b7280", background: "#1a1a2e", padding: "1px 4px", borderRadius: "3px" }}>explicit</span>
                          ) : null}
                          {otherTitle ? (
                            <span style={{ fontSize: "11px", color: "#d1d5db", flex: 1, wordBreak: "break-word" }}>
                              {(e as any).direction === "in" ? "← " : "→ "}{otherTitle}
                            </span>
                          ) : null}
                        </div>
                        {e.reason ? (
                          <div style={{ fontSize: "11px", color: "#9ca3af", lineHeight: 1.4 }}>{e.reason}</div>
                        ) : null}
                        {(e as any).targetDesc && !(e as any).reason ? (
                          <div style={{ fontSize: "11px", color: "#6b7280", lineHeight: 1.4, marginTop: "2px", fontStyle: "italic" }}>{(e as any).targetDesc}</div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div style={styles.detailFooter}>
              <span style={styles.idMono}>id: {selected.id}</span>
              <span>
                created {new Date(selected.created_at).toLocaleString()}
              </span>
            </div>
            </>) : null}
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
  hermesPills: {
    display: "flex",
    gap: "8px",
    padding: "4px 12px",
    backgroundColor: "#09111d",
    borderBottom: "1px solid #1a2a3a",
    flexWrap: "wrap",
  },
  hermesPill: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "2px 8px",
    borderRadius: "10px",
    backgroundColor: "#0d0a1a",
    border: "1px solid #5533aa44",
    fontSize: "10px",
    fontFamily: "monospace",
    cursor: "pointer",
  },

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
    fontSize: "12px",
    color: "#d1d5db",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    padding: "0 2px",
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
    fontSize: "11px",
    color: "#9ca3af",
    lineHeight: 1.5,
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
  setupWarning: {
    display: "flex",
    alignItems: "flex-start",
    gap: "10px",
    padding: "8px 14px",
    backgroundColor: "#1a1200",
    borderBottom: "1px solid #7c5a00",
    borderLeft: "3px solid #f59e0b",
  },
  setupWarningIcon: {
    fontSize: "14px",
    color: "#f59e0b",
    flexShrink: 0,
    marginTop: "1px",
  },
  setupWarningBody: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
  setupWarningMsg: {
    fontSize: "11px",
    color: "#fde68a",
    fontWeight: 600,
    fontFamily: "monospace",
  },
  setupWarningAction: {
    fontSize: "10px",
    color: "#d97706",
    fontFamily: "monospace",
  },
};
