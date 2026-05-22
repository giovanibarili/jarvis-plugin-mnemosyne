// renderers/PromptsTab.tsx
//
// Tab that lists all extract-<category>.md prompts and lets the user
// view / edit their content directly in the HUD.

const PLUGIN_BASE = "/plugins/jarvis-plugin-mnemosyne";

// Mirrors GraphTab's COLOR_PALETTE + PINNED_CATEGORIES for consistent coloring.
const _PINNED: string[] = [
  "code-pattern", "preference", "architecture-decision", "mental-model",
  "glossary", "anti-pattern", "workflow", "convention", "entities", "memory",
];
const _PALETTE: string[] = [
  "#3b82f6","#8b5cf6","#10b981","#f59e0b","#6366f1","#ef4444","#ec4899",
  "#06b6d4","#f97316","#a3e635","#14b8a6","#a855f7","#22c55e","#e879f9",
  "#fb923c","#34d399","#f472b6","#60a5fa","#fbbf24","#4ade80","#c084fc",
  "#38bdf8","#f87171","#2dd4bf","#fb7185","#a78bfa","#86efac","#fde68a",
  "#bfdbfe","#ddd6fe","#bbf7d0","#fecdd3","#e0f2fe","#fef3c7","#d1fae5",
  "#ede9fe","#fee2e2","#ccfbf1","#fae8ff","#ecfdf5","#ff6b6b","#ffd93d",
  "#6bcb77","#4d96ff","#c77dff","#ff9f1c","#2ec4b6","#e71d36","#ff9f51","#b5e48c",
];
const _colorMap: Record<string, string> = {};
for (let i = 0; i < _PINNED.length; i++) _colorMap[_PINNED[i]] = _PALETTE[i];
let _slot = _PINNED.length;
function catColor(cat: string): string {
  if (!_colorMap[cat]) { _colorMap[cat] = _PALETTE[_slot % _PALETTE.length]; _slot++; }
  return _colorMap[cat];
}

interface PromptFile {
  name: string;       // e.g. "extract-preference.md"
  category: string;   // e.g. "preference"
  content: string;
}

async function fetchPrompts(): Promise<PromptFile[]> {
  try {
    const res = await fetch(`${PLUGIN_BASE}/prompts`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.prompts ?? [];
  } catch {
    return [];
  }
}

async function savePrompt(name: string, content: string): Promise<boolean> {
  try {
    const res = await fetch(`${PLUGIN_BASE}/prompts/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default function PromptsTab() {
  const [prompts, setPrompts] = useState<PromptFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editContent, setEditContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    fetchPrompts().then((ps) => {
      setPrompts(ps);
      setLoading(false);
    });
  }, []);

  useEffect(() => { reload(); }, []);

  const selectPrompt = useCallback((p: PromptFile) => {
    setSelected(p.name);
    setEditContent(p.content);
    setDirty(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    const ok = await savePrompt(selected, editContent);
    setSaving(false);
    if (ok) {
      setDirty(false);
      setPrompts((ps) => ps.map((p) => p.name === selected ? { ...p, content: editContent } : p));
      setFlash("Saved ✓");
      setTimeout(() => setFlash(null), 2000);
    } else {
      setFlash("Save failed ✗");
      setTimeout(() => setFlash(null), 3000);
    }
  }, [selected, editContent]);

  return (
    <div style={s.wrap}>
      {/* Sidebar — list of prompts */}
      <div style={s.sidebar}>
        <div style={s.sidebarHeader}>
          <span style={s.sidebarTitle}>category</span>
          <button style={s.reloadBtn} onClick={reload} title="Reload from disk">↺</button>
        </div>
        {loading ? (
          <div style={s.sidebarEmpty}>loading…</div>
        ) : prompts.length === 0 ? (
          <div style={s.sidebarEmpty}>no prompts found</div>
        ) : (
          prompts.map((p) => {
            const color = catColor(p.category);
            return (
              <button
                key={p.name}
                style={s.sidebarItem}
                onClick={() => selectPrompt(p)}
              >
                <span style={{ ...s.categoryDot, backgroundColor: color }} />
                <span style={{ ...s.categoryLabel, color: color }}>{p.category}</span>
              </button>
            );
          })
        )}
      </div>

      {/* Editor — right pane */}
      <div style={s.editor}>
        {selected ? (
          <>
            <div style={s.editorHeader}>
              <span style={s.editorTitle}>{selected}</span>
              <div style={s.editorActions}>
                {flash && <span style={s.flashMsg}>{flash}</span>}
                {dirty && (
                  <button
                    style={s.saveBtn}
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? "saving…" : "Save"}
                  </button>
                )}
              </div>
            </div>
            <textarea
              style={s.textarea}
              value={editContent}
              onChange={(e: any) => {
                setEditContent(e.target.value);
                setDirty(true);
              }}
              spellCheck={false}
            />
          </>
        ) : (
          <div style={s.placeholder}>← select a prompt to view / edit</div>
        )}
      </div>
    </div>
  );
}

const s: Record<string, any> = {
  wrap: {
    display: "flex",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  sidebar: {
    width: "160px",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid #1f1f1f",
    backgroundColor: "#0e0e0e",
    overflowY: "auto",
  },
  sidebarHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px 6px",
    borderBottom: "1px solid #1a1a1a",
  },
  sidebarTitle: {
    fontSize: "9px",
    color: "#555",
    textTransform: "uppercase",
    letterSpacing: "0.07em",
  },
  reloadBtn: {
    background: "none",
    border: "none",
    color: "#555",
    cursor: "pointer",
    fontSize: "13px",
    padding: "0",
    lineHeight: 1,
  },
  sidebarEmpty: {
    fontSize: "11px",
    color: "#555",
    padding: "12px 10px",
    fontStyle: "italic",
  },
  sidebarItem: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    width: "100%",
    padding: "7px 10px",
    background: "none",
    border: "none",
    borderBottom: "1px solid #141414",
    color: "#aaa",
    fontSize: "11px",
    cursor: "pointer",
    textAlign: "left" as const,
    fontFamily: "inherit",
    transition: "background 0.1s",
  },
  sidebarItemActive: {
    backgroundColor: "#1a1a2e",
    color: "#e0e0e0",
    borderLeft: "2px solid #8b5cf6",
  },
  categoryDot: {
    display: "inline-block",
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    backgroundColor: "#8b5cf6",
    flexShrink: 0,
  },
  categoryLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  editor: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    backgroundColor: "#0a0a0a",
  },
  editorHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 12px",
    borderBottom: "1px solid #1a1a1a",
    backgroundColor: "#0e0e0e",
    flexShrink: 0,
  },
  editorTitle: {
    fontSize: "11px",
    color: "#888",
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
  },
  editorActions: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  flashMsg: {
    fontSize: "10px",
    color: "#10b981",
  },
  saveBtn: {
    padding: "2px 10px",
    borderRadius: "4px",
    border: "1px solid #8b5cf6",
    backgroundColor: "#1d1828",
    color: "#c4b5fd",
    cursor: "pointer",
    fontSize: "11px",
    fontFamily: "inherit",
  },
  textarea: {
    flex: 1,
    resize: "none" as const,
    backgroundColor: "#0a0a0a",
    color: "#d4d4d4",
    border: "none",
    outline: "none",
    padding: "12px 14px",
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    fontSize: "12px",
    lineHeight: 1.6,
    overflow: "auto",
  },
  placeholder: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#444",
    fontSize: "12px",
    fontStyle: "italic",
  },
};
