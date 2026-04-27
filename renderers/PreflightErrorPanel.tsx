// renderers/PreflightErrorPanel.tsx
//
// Static error panel rendered when MnemosyneBootError prevents the
// plugin from starting. Receives the failures array via the panel piece's
// data payload and renders one card per failed check with the action hint.
//
// React is provided via the esbuild banner (window.__JARVIS_REACT). See
// renderers/globals.d.ts for the ambient declarations.

import type { PreflightFailure } from "./types";

interface Props {
  state: {
    id?: string;
    data?: {
      preflight?: { failures: PreflightFailure[] };
      error?: string;
    };
  };
}

export default function PreflightErrorPanel({ state }: Props) {
  const piece = useHudPiece?.(state.id ?? "mnemosyne-panel");
  const data = piece?.data ?? state?.data ?? {};
  const failures: PreflightFailure[] = data.preflight?.failures ?? [];
  const banner = data.error;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.icon}>💥</span>
        <div style={styles.headerText}>
          <div style={styles.title}>Mnemosyne refused to start</div>
          <div style={styles.subtitle}>
            {failures.length} preflight check{failures.length === 1 ? "" : "s"} failed.
            Fix the issues below and re-enable the plugin.
          </div>
        </div>
      </div>

      {banner ? (
        <pre style={styles.banner}>{banner}</pre>
      ) : null}

      <div style={styles.list}>
        {failures.length === 0 ? (
          <div style={styles.empty}>No structured failures reported.</div>
        ) : null}
        {failures.map((f, i) => (
          <div key={`${f.check}-${i}`} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={styles.checkBadge}>check</span>
              <span style={styles.checkName}>{f.check}</span>
            </div>
            <div style={styles.reasonRow}>
              <span style={styles.label}>Reason</span>
              <span style={styles.reason}>{f.reason}</span>
            </div>
            {f.action ? (
              <div style={styles.actionRow}>
                <span style={styles.label}>Fix</span>
                <code style={styles.action}>{f.action}</code>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div style={styles.footer}>
        <span style={styles.footerHint}>
          After fixing the environment, run{" "}
          <code style={styles.footerCode}>plugin_disable jarvis-plugin-mnemosyne</code>{" "}
          followed by{" "}
          <code style={styles.footerCode}>plugin_enable jarvis-plugin-mnemosyne</code>.
        </span>
      </div>
    </div>
  );
}

const styles: Record<string, any> = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "16px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: "13px",
    color: "#e0e0e0",
    height: "100%",
    overflow: "auto",
    backgroundColor: "#0c0c0c",
  },
  header: {
    display: "flex",
    gap: "12px",
    alignItems: "flex-start",
    padding: "12px",
    borderRadius: "6px",
    backgroundColor: "#2a0e0e",
    border: "1px solid #ef4444",
  },
  icon: {
    fontSize: "24px",
    lineHeight: "24px",
    display: "inline-block",
    mixBlendMode: "multiply",
  },
  headerText: { flex: 1 },
  title: {
    fontSize: "14px",
    fontWeight: 700,
    color: "#fecaca",
    marginBottom: "2px",
  },
  subtitle: {
    fontSize: "12px",
    color: "#fca5a5",
  },
  banner: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: "11px",
    color: "#fca5a5",
    backgroundColor: "#1a0a0a",
    padding: "8px 10px",
    borderRadius: "4px",
    border: "1px solid #3a1414",
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  empty: {
    color: "#666",
    fontStyle: "italic",
    padding: "12px",
    textAlign: "center",
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "10px 12px",
    borderRadius: "6px",
    border: "1px solid #3a1414",
    backgroundColor: "#1a0a0a",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "2px",
  },
  checkBadge: {
    padding: "1px 6px",
    fontSize: "10px",
    color: "#fff",
    backgroundColor: "#ef4444",
    borderRadius: "4px",
    textTransform: "uppercase",
    fontWeight: 600,
  },
  checkName: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: "12px",
    color: "#fecaca",
    fontWeight: 600,
  },
  reasonRow: {
    display: "flex",
    gap: "8px",
    alignItems: "flex-start",
  },
  actionRow: {
    display: "flex",
    gap: "8px",
    alignItems: "flex-start",
  },
  label: {
    fontSize: "10px",
    color: "#666",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontWeight: 600,
    minWidth: "40px",
    paddingTop: "2px",
  },
  reason: {
    fontSize: "12px",
    color: "#e0e0e0",
    flex: 1,
  },
  action: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: "12px",
    color: "#a7f3d0",
    backgroundColor: "#062514",
    padding: "2px 6px",
    borderRadius: "3px",
    border: "1px solid #064e3b",
    flex: 1,
  },
  footer: {
    paddingTop: "12px",
    borderTop: "1px solid #2a2a2a",
    fontSize: "11px",
    color: "#888",
  },
  footerHint: { lineHeight: "18px" },
  footerCode: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: "11px",
    backgroundColor: "#1a1a1a",
    padding: "1px 5px",
    borderRadius: "3px",
    color: "#e0e0e0",
  },
};
