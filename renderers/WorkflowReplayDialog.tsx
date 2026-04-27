// renderers/WorkflowReplayDialog.tsx
//
// Step-by-step viewer for an interactive workflow replay. The current
// step is highlighted; the three buttons (Yes / Skip / Abort) POST the
// decision to the plugin's HTTP route. The backend (replay-engine.ts)
// is responsible for advancing `currentStep` and re-publishing the panel
// state, so this component is intentionally stateless.
//
// React + HUD hooks come from the esbuild banner (see globals.d.ts).

import type { Workflow, WorkflowStep, ReplayDecision } from "./types";

interface ReplayState {
  workflow: Workflow;
  currentStep: number;
  awaiting: "confirm" | "idle";
}

interface Props {
  state: {
    id?: string;
    data?: { replay?: ReplayState };
  };
}

const REPLAY_DECISION_PATH =
  "/plugins/jarvis-plugin-mnemosyne/replay/decision";

async function postDecision(decision: ReplayDecision, workflowId: string, stepIndex: number) {
  try {
    await fetch(REPLAY_DECISION_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, workflowId, stepIndex }),
    });
  } catch (e) {
    // The HTTP endpoint may not be wired in v1.0; log and continue —
    // the LLM-driven replay tool will eventually pick up this state.
    console.warn("[mnemosyne-replay] decision POST failed:", e);
  }
}

export default function WorkflowReplayDialog({ state }: Props) {
  const piece = useHudPiece?.(state.id ?? "mnemosyne-panel");
  const data = piece?.data ?? state?.data ?? {};
  const replay: ReplayState | undefined = data.replay;

  if (!replay) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>No replay in progress.</div>
      </div>
    );
  }

  const { workflow, currentStep, awaiting } = replay;
  const total = workflow.steps?.length ?? 0;
  const step: WorkflowStep | undefined = workflow.steps?.[currentStep];
  const isAwaiting = awaiting === "confirm";

  const handle = (decision: ReplayDecision) => {
    void postDecision(decision, workflow.id, currentStep);
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.title}>{workflow.name}</div>
        <div style={styles.subtitle}>{workflow.description}</div>
        <div style={styles.metaLine}>
          <span style={styles.metaChip}>trigger: {workflow.trigger || "—"}</span>
          <span style={styles.metaChip}>outcome: {workflow.outcome || "—"}</span>
        </div>
      </div>

      <div style={styles.progressWrap}>
        <div style={styles.progressLabel}>
          <span>
            Step {Math.min(currentStep + 1, Math.max(total, 1))}/{Math.max(total, 1)}
          </span>
          <span style={styles.statusChip(isAwaiting)}>
            {isAwaiting ? "awaiting decision" : "idle"}
          </span>
        </div>
        <div style={styles.progressTrack}>
          <div
            style={{
              ...styles.progressFill,
              width: total > 0 ? `${(currentStep / total) * 100}%` : "0%",
            }}
          />
        </div>
      </div>

      <div style={styles.stepList}>
        {(workflow.steps ?? []).map((s, i) => {
          const past = i < currentStep;
          const active = i === currentStep;
          const rowStyle: any = {
            ...styles.stepRow,
            ...(past ? styles.stepRowPast : {}),
            ...(active ? styles.stepRowActive : {}),
          };
          return (
            <div key={s.id ?? i} style={rowStyle}>
              <span style={styles.stepIdx}>{i + 1}.</span>
              <div style={styles.stepBody}>
                <div style={styles.stepAction}>{s.action}</div>
                {s.description ? (
                  <div style={styles.stepDescription}>{s.description}</div>
                ) : null}
                <div style={styles.stepMeta}>
                  {s.tool ? <span style={styles.stepMetaChip}>tool: {s.tool}</span> : null}
                  {s.guard ? <span style={styles.stepMetaChip}>guard: {s.guard}</span> : null}
                  {s.required ? (
                    <span style={{ ...styles.stepMetaChip, color: "#fbbf24" }}>required</span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={styles.actions}>
        <button
          style={{ ...styles.btn, ...styles.btnYes }}
          disabled={!isAwaiting || !step}
          onClick={() => handle("yes")}
        >
          ✓ Yes — execute step
        </button>
        <button
          style={{ ...styles.btn, ...styles.btnSkip }}
          disabled={!isAwaiting || !step}
          onClick={() => handle("skip")}
        >
          ↷ Skip
        </button>
        <button
          style={{ ...styles.btn, ...styles.btnAbort }}
          disabled={!isAwaiting}
          onClick={() => handle("abort")}
        >
          ✕ Abort
        </button>
      </div>

      {!isAwaiting ? (
        <div style={styles.hint}>
          The replay engine is processing — buttons re-enable when the next
          step asks for a decision.
        </div>
      ) : null}
    </div>
  );
}

const styles: Record<string, any> = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "12px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "13px",
    color: "#e0e0e0",
    height: "100%",
    overflow: "auto",
    backgroundColor: "#0c0c0c",
  },
  empty: {
    color: "#666",
    fontStyle: "italic",
    padding: "20px",
    textAlign: "center",
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    paddingBottom: "8px",
    borderBottom: "1px solid #2a2a2a",
  },
  title: { fontSize: "15px", fontWeight: 700, color: "#fff" },
  subtitle: { fontSize: "12px", color: "#aaa" },
  metaLine: { display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "4px" },
  metaChip: {
    fontSize: "10px",
    color: "#9aa0a6",
    backgroundColor: "#1f1f1f",
    padding: "1px 6px",
    borderRadius: "10px",
  },
  progressWrap: { display: "flex", flexDirection: "column", gap: "4px" },
  progressLabel: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "12px",
    color: "#aaa",
  },
  statusChip: (awaiting: boolean) => ({
    fontSize: "10px",
    padding: "1px 8px",
    borderRadius: "10px",
    fontWeight: 600,
    textTransform: "uppercase",
    backgroundColor: awaiting ? "#8b5cf6" : "#333",
    color: "#fff",
  }),
  progressTrack: {
    height: "6px",
    borderRadius: "3px",
    backgroundColor: "#2a2a2a",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#8b5cf6",
    transition: "width 0.25s ease",
  },
  stepList: { display: "flex", flexDirection: "column", gap: "4px" },
  stepRow: {
    display: "flex",
    gap: "8px",
    padding: "8px 10px",
    borderRadius: "4px",
    backgroundColor: "#161616",
    border: "1px solid transparent",
  },
  stepRowPast: { opacity: 0.5 },
  stepRowActive: {
    borderColor: "#8b5cf6",
    backgroundColor: "#1d1828",
  },
  stepIdx: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: "12px",
    color: "#888",
    width: "24px",
    flexShrink: 0,
  },
  stepBody: { flex: 1, minWidth: 0 },
  stepAction: { fontSize: "13px", color: "#e0e0e0" },
  stepDescription: { fontSize: "11px", color: "#888", marginTop: "2px" },
  stepMeta: { display: "flex", gap: "6px", marginTop: "4px", flexWrap: "wrap" },
  stepMetaChip: {
    fontSize: "10px",
    color: "#9aa0a6",
    backgroundColor: "#1f1f1f",
    padding: "1px 6px",
    borderRadius: "10px",
  },
  actions: {
    display: "flex",
    gap: "8px",
    paddingTop: "8px",
    borderTop: "1px solid #2a2a2a",
  },
  btn: {
    padding: "6px 14px",
    borderRadius: "4px",
    border: "none",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: 600,
    fontFamily: "inherit",
    outline: "none",
  },
  btnYes: { backgroundColor: "#10b981", color: "#fff" },
  btnSkip: { backgroundColor: "#374151", color: "#e0e0e0" },
  btnAbort: { backgroundColor: "#ef4444", color: "#fff" },
  hint: {
    fontSize: "11px",
    color: "#666",
    fontStyle: "italic",
    textAlign: "center",
    paddingTop: "4px",
  },
};
