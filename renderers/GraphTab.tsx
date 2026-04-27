// renderers/GraphTab.tsx
//
// Decision D9 — Graph visualization tab using neovis.js, connected
// directly to Neo4j Bolt at bolt://127.0.0.1:7687 (loopback only, no
// auth per D10).
//
// ## Direct Bolt — no backend proxy
//
// Electron's renderer in JARVIS runs with `nodeIntegration: false`,
// `contextIsolation: true` and no Content-Security-Policy header
// (verified in app/src/transport/hud/electron.ts and electron-main.cjs),
// so plain WebSocket connections to ws://127.0.0.1:7687 are allowed.
// neovis.js → neo4j-driver opens that ws:// link itself; nothing in
// JARVIS forbids it. No backend HTTP proxy needed — D9 stays direct.
//
// ## Lazy loading caveat (deviation from D9)
//
// The plan called for the ~150kb neovis bundle to be loaded only when
// the Graph tab is activated. The current renderer endpoint
// (app/src/server.ts servePluginRenderer) bundles each file
// independently with `bundle: true` and no code-splitting (no `outdir`,
// no `splitting: true`). A URL-based dynamic `import("/plugins/.../
// renderers/GraphTab.js")` would require externalizing `/plugins/*`
// in that esbuild config, which is out of scope for this plugin.
//
// Compromise: GraphTab is statically imported by MnemosynePanel.tsx,
// so the bundle parse happens once on panel mount. **The actual
// neovis instantiation, websocket connection, and vis-network DOM
// attach still happen only when the Graph tab becomes active**
// (the component isn't mounted until then). On unmount we destroy
// the network so memory + the WebSocket are released.
//
// React (`createElement`) and HUD hooks come from the esbuild banner;
// see renderers/globals.d.ts for the ambient declarations.

import NeoVis, { NeoVisEvents } from "neovis.js";
import type { Memory, FilterCategory, Category } from "./types";

interface Props {
  memories: Memory[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Available project values for the filter (same list MnemosynePanel computes). */
  projects: string[];
}

// Same palette as MemoryCard — keeps category recognition consistent
// across the List and Graph tabs.
const CATEGORY_COLOR: Record<Category, string> = {
  "code-pattern": "#3b82f6",
  preference: "#8b5cf6",
  "architecture-decision": "#10b981",
  "mental-model": "#f59e0b",
  glossary: "#6366f1",
  "anti-pattern": "#ef4444",
  workflow: "#ec4899",
};

const ALL_CATEGORIES: Category[] = [
  "code-pattern",
  "preference",
  "architecture-decision",
  "mental-model",
  "glossary",
  "anti-pattern",
  "workflow",
];

type TimeWindow = "24h" | "7d" | "30d" | "all";

const TIME_WINDOW_MS: Record<TimeWindow, number | null> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: null,
};

interface Filters {
  timeWindow: TimeWindow;
  categories: Set<Category>;
  project: string; // "all" or a project name
  onlyConflicts: boolean;
  onlyWorkflows: boolean;
  onlyLongTerm: boolean;
}

const DEFAULT_FILTERS: Filters = {
  timeWindow: "7d",
  categories: new Set<Category>(),
  project: "all",
  onlyConflicts: false,
  onlyWorkflows: false,
  onlyLongTerm: false,
};

/**
 * Build the Cypher query from the active filter set. The query always
 * includes one OPTIONAL MATCH for relationships so isolated nodes are
 * still rendered, and a LIMIT 100 cap to keep the visualization legible.
 */
function buildCypher(filters: Filters): string {
  const clauses: string[] = [];

  // Workflow-only mode short-circuits the Memory-centric query — match
  // Workflow + Step nodes and their NEXT/ON_FAILURE edges.
  if (filters.onlyWorkflows) {
    return `
      MATCH (n)
      WHERE n:Workflow OR n:Step
      OPTIONAL MATCH (n)-[r:NEXT|ON_FAILURE|HAS_STEP]-(m)
      RETURN n, r, m
      LIMIT 100
    `.trim();
  }

  // Memory-centric query
  const winMs = TIME_WINDOW_MS[filters.timeWindow];
  if (winMs !== null) {
    clauses.push(`n.last_accessed > timestamp() - ${winMs}`);
  }
  if (filters.categories.size > 0) {
    const list = Array.from(filters.categories)
      .map((c) => `'${c.replace(/'/g, "\\'")}'`)
      .join(", ");
    clauses.push(`n.category IN [${list}]`);
  }
  if (filters.project !== "all") {
    const p = filters.project.replace(/'/g, "\\'");
    clauses.push(`n.project = '${p}'`);
  }
  if (filters.onlyLongTerm) {
    clauses.push(`n.promoted_at IS NOT NULL`);
  }

  // "Only conflicts" — restrict to nodes touched by a CONTRADICTS edge.
  // Implemented as an EXISTS subquery so the rest of the WHERE clause
  // composes cleanly.
  if (filters.onlyConflicts) {
    clauses.push(`EXISTS { MATCH (n)-[:CONTRADICTS]-() }`);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  return `
    MATCH (n:Memory)
    ${whereClause}
    OPTIONAL MATCH (n)-[r]-(m)
    RETURN n, r, m
    LIMIT 100
  `.trim();
}

function summarizeFilters(filters: Filters): string {
  const parts: string[] = [];
  if (filters.onlyWorkflows) {
    parts.push("workflows only");
    return parts.join(", ");
  }
  parts.push(`window=${filters.timeWindow}`);
  if (filters.categories.size > 0) {
    parts.push(`categories=${Array.from(filters.categories).join("/")}`);
  }
  if (filters.project !== "all") parts.push(`project=@${filters.project}`);
  if (filters.onlyLongTerm) parts.push("long-term only");
  if (filters.onlyConflicts) parts.push("conflicts only");
  return parts.join(", ");
}

export default function GraphTab({ memories, selectedId, onSelect, projects }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const visRef = useRef<NeoVis | null>(null);

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [loading, setLoading] = useState<boolean>(true);
  const [recordCount, setRecordCount] = useState<number>(-1);
  const [error, setError] = useState<string | null>(null);
  // Bumped on Refresh / Reset to force the (re)render effect to re-run
  // even when the filter object is reference-equal.
  const [renderTick, setRenderTick] = useState(0);

  // Initialize / re-initialize neovis whenever filters or renderTick change.
  useEffect(() => {
    if (!containerRef.current) return;

    // Clean up any prior instance before rebuilding — neovis writes to
    // the DOM and the underlying vis-network keeps long-lived listeners.
    if (visRef.current) {
      try {
        visRef.current.network?.destroy();
      } catch {
        /* best-effort */
      }
      visRef.current = null;
    }
    containerRef.current.innerHTML = "";

    const cypher = buildCypher(filters);
    setLoading(true);
    setRecordCount(-1);
    setError(null);

    let cancelled = false;
    let viz: NeoVis;
    try {
      viz = new NeoVis({
        containerId: containerRef.current.id,
        neo4j: {
          serverUrl: "bolt://127.0.0.1:7687",
          // D10 — no auth on loopback. neo4j-driver still requires
          // string args; empty strings are accepted.
          serverUser: "",
          serverPassword: "",
        },
        labels: {
          // Memory nodes — colored by category, sized by confidence.
          Memory: {
            label: "title",
            value: "confidence",
            group: "category",
            [NeoVis.NEOVIS_ADVANCED_CONFIG]: {
              static: {
                shape: "dot",
                font: { color: "#e0e0e0", size: 12 },
              },
              function: {
                color: (node: any) => {
                  const cat = node?.properties?.category as Category | undefined;
                  return cat && CATEGORY_COLOR[cat]
                    ? CATEGORY_COLOR[cat]
                    : "#888888";
                },
                title: (node: any) => {
                  const p = node?.properties ?? {};
                  const created = p.created_at
                    ? new Date(Number(p.created_at)).toLocaleString()
                    : "—";
                  const conf =
                    typeof p.confidence === "number"
                      ? p.confidence.toFixed(2)
                      : String(p.confidence ?? "—");
                  return [
                    `<div style="font-family:system-ui;font-size:12px;color:#e0e0e0;background:#0e0e0e;padding:6px 8px;border-radius:4px;border:1px solid #2a2a2a;">`,
                    `<b>${escapeHtml(String(p.title ?? p.id ?? "—"))}</b><br/>`,
                    `category: ${escapeHtml(String(p.category ?? "—"))}<br/>`,
                    `confidence: ${conf}<br/>`,
                    `reinforcements: ${p.reinforcements ?? 0}<br/>`,
                    `created: ${created}<br/>`,
                    `pinned: ${p.pinned ? "★" : "no"}`,
                    `</div>`,
                  ].join("");
                },
                size: (node: any) => {
                  const c = Number(node?.properties?.confidence ?? 0.5);
                  // confidence is 0..1; map to 15..40px
                  const clamped = Math.max(0, Math.min(1, c));
                  return 15 + clamped * 25;
                },
              },
            },
          },
          Workflow: { label: "name" },
          Step: { label: "action" },
        },
        relationships: {
          MENTIONS: {
            [NeoVis.NEOVIS_ADVANCED_CONFIG]: {
              static: { arrows: { to: { enabled: true } }, color: { color: "#3b82f6" } },
            },
          },
          REFERENCES: {
            [NeoVis.NEOVIS_ADVANCED_CONFIG]: {
              static: { arrows: { to: { enabled: true } }, color: { color: "#10b981" } },
            },
          },
          CONTRADICTS: {
            [NeoVis.NEOVIS_ADVANCED_CONFIG]: {
              static: {
                arrows: { to: { enabled: false }, from: { enabled: false } },
                color: { color: "#ef4444" },
                dashes: true,
              },
            },
          },
          NEXT: {
            [NeoVis.NEOVIS_ADVANCED_CONFIG]: {
              static: { arrows: { to: { enabled: true } }, color: { color: "#ec4899" } },
            },
          },
          ON_FAILURE: {
            [NeoVis.NEOVIS_ADVANCED_CONFIG]: {
              static: { arrows: { to: { enabled: true } }, color: { color: "#f59e0b" }, dashes: true },
            },
          },
        },
        initialCypher: cypher,
        visConfig: {
          physics: {
            enabled: true,
            solver: "forceAtlas2Based",
            forceAtlas2Based: {
              gravitationalConstant: -30,
              centralGravity: 0.005,
              springLength: 110,
              springConstant: 0.08,
              avoidOverlap: 0.6,
            },
            stabilization: { enabled: true, iterations: 200, fit: true },
          },
          interaction: { hover: true, tooltipDelay: 120 },
          edges: { smooth: { enabled: true, type: "dynamic", roundness: 0.3 } },
          nodes: { borderWidth: 1, borderWidthSelected: 3 },
        },
        consoleDebug: false,
      } as any);
    } catch (e) {
      setLoading(false);
      setError(`Failed to construct NeoVis: ${String(e)}`);
      return;
    }

    visRef.current = viz;

    viz.registerOnEvent(NeoVisEvents.CompletionEvent, (evt: any) => {
      if (cancelled) return;
      setLoading(false);
      setRecordCount(Number(evt?.recordCount ?? 0));
    });
    viz.registerOnEvent(NeoVisEvents.ErrorEvent, (evt: any) => {
      if (cancelled) return;
      setLoading(false);
      setError(String(evt?.error?.message ?? evt?.error ?? "unknown error"));
    });
    viz.registerOnEvent(NeoVisEvents.ClickNodeEvent, (evt: any) => {
      const props = evt?.node?.raw?.properties ?? evt?.node?.properties ?? {};
      const id =
        (typeof props.id === "string" && props.id) ||
        (typeof evt?.node?.id === "string" && evt.node.id) ||
        null;
      if (id) onSelect(id);
    });

    viz.render();

    return () => {
      cancelled = true;
      try {
        visRef.current?.network?.destroy();
      } catch {
        /* best-effort */
      }
      visRef.current = null;
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [filters, renderTick]);

  const toggleCategory = useCallback((c: Category) => {
    setFilters((prev) => {
      const next = new Set(prev.categories);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return { ...prev, categories: next };
    });
  }, []);

  const handleReset = useCallback(() => {
    setFilters({ ...DEFAULT_FILTERS, categories: new Set<Category>() });
    setRenderTick((t) => t + 1);
  }, []);

  const handleRefresh = useCallback(() => {
    setRenderTick((t) => t + 1);
  }, []);

  const summary = useMemo(() => summarizeFilters(filters), [filters]);

  // Empty state — neovis reported 0 records back from the query.
  const showEmpty = !loading && recordCount === 0 && !error;

  return (
    <div style={styles.wrap}>
      <div style={styles.controls}>
        <div style={styles.controlsRow}>
          <span style={styles.label}>window</span>
          {(Object.keys(TIME_WINDOW_MS) as TimeWindow[]).map((tw) => (
            <button
              key={tw}
              style={{
                ...styles.chip,
                ...(filters.timeWindow === tw ? styles.chipActive : {}),
              }}
              onClick={() => setFilters((p) => ({ ...p, timeWindow: tw }))}
              disabled={filters.onlyWorkflows}
              title={filters.onlyWorkflows ? "Disabled in workflows-only mode" : undefined}
            >
              {tw === "all" ? "all time" : `last ${tw}`}
            </button>
          ))}
        </div>

        <div style={styles.controlsRow}>
          <span style={styles.label}>categories</span>
          {ALL_CATEGORIES.map((c) => (
            <button
              key={c}
              style={{
                ...styles.chip,
                ...(filters.categories.has(c)
                  ? { ...styles.chipActive, backgroundColor: CATEGORY_COLOR[c], borderColor: CATEGORY_COLOR[c] }
                  : {}),
              }}
              onClick={() => toggleCategory(c)}
              disabled={filters.onlyWorkflows}
              title={filters.onlyWorkflows ? "Disabled in workflows-only mode" : undefined}
            >
              {c}
            </button>
          ))}
        </div>

        <div style={styles.controlsRow}>
          <span style={styles.label}>project</span>
          <select
            style={styles.select}
            value={filters.project}
            onChange={(e: any) => setFilters((p) => ({ ...p, project: e.target.value }))}
            disabled={filters.onlyWorkflows}
          >
            {projects.map((p) => (
              <option key={p} value={p}>
                {p === "all" ? "all projects" : `@${p}`}
              </option>
            ))}
          </select>

          <label style={styles.toggle}>
            <input
              type="checkbox"
              checked={filters.onlyConflicts}
              onChange={(e: any) =>
                setFilters((p) => ({ ...p, onlyConflicts: !!e.target.checked }))
              }
              disabled={filters.onlyWorkflows}
            />
            <span>only conflicts</span>
          </label>

          <label style={styles.toggle}>
            <input
              type="checkbox"
              checked={filters.onlyLongTerm}
              onChange={(e: any) =>
                setFilters((p) => ({ ...p, onlyLongTerm: !!e.target.checked }))
              }
              disabled={filters.onlyWorkflows}
            />
            <span>only long-term</span>
          </label>

          <label style={styles.toggle}>
            <input
              type="checkbox"
              checked={filters.onlyWorkflows}
              onChange={(e: any) =>
                setFilters((p) => ({ ...p, onlyWorkflows: !!e.target.checked }))
              }
            />
            <span>only workflows</span>
          </label>

          <button style={styles.actionBtn} onClick={handleRefresh}>
            ↻ Refresh
          </button>
          <button style={styles.actionBtnGhost} onClick={handleReset}>
            Reset
          </button>

          <span style={styles.summary}>{summary}</span>
        </div>
      </div>

      <div style={styles.canvasOuter}>
        <div
          id="mnemosyne-graph-canvas"
          ref={containerRef}
          style={styles.canvas}
        />

        {loading ? (
          <div style={styles.overlay}>
            <span>loading graph…</span>
          </div>
        ) : null}

        {error ? (
          <div style={styles.overlayError}>
            <div style={styles.overlayTitle}>graph error</div>
            <pre style={styles.errorText}>{error}</pre>
            <button style={styles.actionBtn} onClick={handleRefresh}>retry</button>
          </div>
        ) : null}

        {showEmpty ? (
          <div style={styles.overlay}>
            <div style={styles.overlayTitle}>No memories match these filters</div>
            <div style={styles.overlaySub}>{summary || "(default)"}</div>
            <button style={styles.actionBtnGhost} onClick={handleReset}>
              Reset filters
            </button>
          </div>
        ) : null}
      </div>

      <div style={styles.footer}>
        <span style={styles.footerHint}>
          {selectedId
            ? `selected: ${selectedId}`
            : "click a node to open its detail pane"}
        </span>
        <span style={styles.footerHint}>
          {recordCount >= 0 ? `${recordCount} records` : ""}
        </span>
        <span style={styles.footerHint}>
          {memories.length} memories in panel
        </span>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const styles: Record<string, any> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    backgroundColor: "#0c0c0c",
    color: "#e0e0e0",
  },

  controls: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "8px 12px",
    borderBottom: "1px solid #1f1f1f",
    backgroundColor: "#0e0e0e",
  },
  controlsRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
  },
  label: {
    fontSize: "10px",
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginRight: "4px",
  },
  chip: {
    padding: "3px 8px",
    borderRadius: "10px",
    border: "1px solid #2a2a2a",
    backgroundColor: "#161616",
    color: "#bbb",
    fontSize: "11px",
    cursor: "pointer",
    fontFamily: "inherit",
    outline: "none",
  },
  chipActive: {
    backgroundColor: "#1d1828",
    borderColor: "#8b5cf6",
    color: "#fff",
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
  toggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "11px",
    color: "#bbb",
    cursor: "pointer",
  },
  actionBtn: {
    padding: "3px 10px",
    borderRadius: "4px",
    border: "1px solid #2a2a2a",
    backgroundColor: "#1d1828",
    color: "#e0e0e0",
    cursor: "pointer",
    fontSize: "11px",
    fontFamily: "inherit",
    outline: "none",
  },
  actionBtnGhost: {
    padding: "3px 10px",
    borderRadius: "4px",
    border: "1px solid #2a2a2a",
    backgroundColor: "transparent",
    color: "#bbb",
    cursor: "pointer",
    fontSize: "11px",
    fontFamily: "inherit",
    outline: "none",
  },
  summary: {
    marginLeft: "auto",
    fontSize: "10px",
    color: "#666",
    fontStyle: "italic",
  },

  canvasOuter: {
    position: "relative",
    flex: 1,
    minHeight: 0,
    backgroundColor: "#080808",
  },
  canvas: {
    position: "absolute",
    inset: 0,
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    color: "#888",
    fontSize: "12px",
    fontStyle: "italic",
    pointerEvents: "auto",
    backgroundColor: "rgba(8,8,8,0.6)",
  },
  overlayError: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    color: "#fca5a5",
    fontSize: "12px",
    backgroundColor: "rgba(8,8,8,0.85)",
    padding: "16px",
  },
  overlayTitle: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#ddd",
  },
  overlaySub: {
    fontSize: "11px",
    color: "#777",
  },
  errorText: {
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    fontSize: "11px",
    color: "#fca5a5",
    backgroundColor: "#1a0a0a",
    border: "1px solid #3a1414",
    padding: "8px 10px",
    borderRadius: "4px",
    margin: 0,
    whiteSpace: "pre-wrap",
    maxWidth: "560px",
    maxHeight: "180px",
    overflow: "auto",
  },

  footer: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "4px 12px",
    borderTop: "1px solid #1f1f1f",
    backgroundColor: "#0e0e0e",
    fontSize: "10px",
    color: "#666",
  },
  footerHint: {
    fontStyle: "italic",
  },
};
