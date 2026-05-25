import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

/**
 * Result of probing the Neo4j stack BEFORE we attempt to connect.
 *
 * `ok` → daemon + container running + bound to loopback. Safe to connect.
 * Any other code is a degraded state; the plugin should NOT attempt to
 * bring the container up automatically (except for `container-stopped`,
 * which we try to nudge with a single `docker start`).
 *
 * The `userMessage` is what we surface to the user via
 * `addChatTimelineEntry` — a single, plain sentence + remediation hint.
 * `actionTaken` records any auto-remediation we attempted, so the same
 * notification doesn't fire twice for the same root cause.
 */
export type Neo4jStatusCode =
  | "ok"
  | "daemon-down"
  | "container-missing"
  | "container-stopped"
  | "container-unhealthy"
  | "unknown-error";

export interface Neo4jStatus {
  code: Neo4jStatusCode;
  /** Human-readable explanation — surfaced to the user in the chat timeline. */
  userMessage: string;
  /** Optional remediation hint shown alongside the message. */
  remediation?: string;
  /** True when we attempted an automatic recovery (e.g. `docker start`). */
  actionTaken?: string;
  /** Raw stderr / error string from the probe — useful for the status tool. */
  detail?: string;
}

const CONTAINER = "mnemosyne-neo4j";

/**
 * Probe the Neo4j stack. Never throws — always returns a Neo4jStatus.
 *
 * Order:
 *  1. `docker info`            → daemon reachable?
 *  2. `docker inspect <c>`     → container exists?
 *  3. read `.State.Running`    → up or stopped?
 *  4. if stopped + autoStart   → try `docker start <c>` once, re-probe.
 *  5. read `.State.Health`     → healthy / unhealthy / starting?
 *
 * Loopback validation (127.0.0.1 binding) is left to Neo4jServer — that
 * check only matters when we actually connect.
 */
export async function detectNeo4jStatus(opts: {
  autoStartStopped: boolean;
}): Promise<Neo4jStatus> {
  // 1. Daemon — if unreachable, try `nu docker start` once before giving up.
  try {
    await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 4000 });
  } catch (firstErr: any) {
    // Attempt auto-recovery via `nu docker start`
    try {
      await exec("nu", ["docker", "start"], { timeout: 60_000 });
      // Wait for daemon + container to become ready (Neo4j takes ~30s to be healthy)
      await waitForHealthy(CONTAINER, { maxWaitMs: 45_000, pollMs: 3000 });
      // Re-probe — fall through to container checks
      await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 4000 });
    } catch {
      return {
        code: "daemon-down",
        userMessage:
          "Mnemosyne: Docker daemon não está acessível — memória semântica em modo vector-only nesta sessão.",
        remediation:
          "Suba o Docker (ex: `nu docker start` ou Docker Desktop) e rode `jarvis_reset`.",
        detail: shortenErr(firstErr),
      };
    }
  }

  // 2. Container existence
  let inspectOut: string;
  try {
    const { stdout } = await exec(
      "docker",
      [
        "inspect",
        "--format",
        // Compact one-liner: running|status|health
        "{{.State.Running}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
        CONTAINER,
      ],
      { timeout: 4000 },
    );
    inspectOut = stdout.trim();
  } catch (e: any) {
    // `docker inspect` exits non-zero when the container doesn't exist.
    return {
      code: "container-missing",
      userMessage:
        "Mnemosyne: container `mnemosyne-neo4j` não encontrado — grafo de memória desativado nesta sessão.",
      remediation:
        "Execute `docker-compose up -d` em `~/.jarvis/plugins/jarvis-plugin-mnemosyne/docker/` e rode `jarvis_reset`.",
      detail: shortenErr(e),
    };
  }

  const [runningStr, status, health] = inspectOut.split("|");
  const running = runningStr === "true";

  // 3 + 4. Stopped → try one auto-start
  if (!running) {
    if (opts.autoStartStopped) {
      try {
        await exec("docker", ["start", CONTAINER], { timeout: 8000 });
        // After auto-start, re-probe once. We don't recurse — single retry.
        return await detectNeo4jStatus({ autoStartStopped: false }).then((r) => ({
          ...r,
          actionTaken:
            r.code === "ok"
              ? `docker start ${CONTAINER} → recovered`
              : `docker start ${CONTAINER} → still ${r.code}`,
        }));
      } catch (e: any) {
        return {
          code: "container-stopped",
          userMessage:
            "Mnemosyne: container `mnemosyne-neo4j` parado e falhei ao iniciar — grafo desativado.",
          remediation:
            "Verifique `docker ps -a`, libere recursos, e rode `docker start mnemosyne-neo4j`.",
          actionTaken: `docker start ${CONTAINER} → failed`,
          detail: shortenErr(e),
        };
      }
    }
    return {
      code: "container-stopped",
      userMessage: `Mnemosyne: container \`mnemosyne-neo4j\` está parado (status: ${status}).`,
      remediation: "Rode `docker start mnemosyne-neo4j` e `jarvis_reset`.",
    };
  }

  // 5. Health
  // `health=none` means no healthcheck defined — treat as ok (legacy compose).
  if (health && health !== "none" && health !== "healthy") {
    return {
      code: "container-unhealthy",
      userMessage: `Mnemosyne: container \`mnemosyne-neo4j\` está rodando mas não saudável (health: ${health}).`,
      remediation:
        "Aguarde alguns segundos (Neo4j leva ~30s pra ficar healthy) ou rode `docker logs mnemosyne-neo4j` pra diagnosticar.",
    };
  }

  return {
    code: "ok",
    userMessage: "Mnemosyne: Neo4j ok.",
  };
}

/**
 * Poll `docker inspect` until the container is healthy (or maxWaitMs elapsed).
 * Resolves when healthy, rejects on timeout.
 */
async function waitForHealthy(container: string, opts: { maxWaitMs: number; pollMs: number }): Promise<void> {
  const deadline = Date.now() + opts.maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await exec(
        "docker",
        ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container],
        { timeout: 4000 },
      );
      const health = stdout.trim();
      if (health === "healthy" || health === "none") return;
    } catch {
      // container may not exist yet — keep polling
    }
    await new Promise(r => setTimeout(r, opts.pollMs));
  }
  throw new Error(`Container ${container} not healthy after ${opts.maxWaitMs}ms`);
}

function shortenErr(e: any): string {
  const raw = String(e?.stderr ?? e?.message ?? e ?? "");
  return raw.split("\n")[0].slice(0, 240);
}
