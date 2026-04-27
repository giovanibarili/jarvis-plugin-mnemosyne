import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import * as net from "net";

const exec = promisify(execFile);

export class MnemosyneBootError extends Error {
  constructor(public failures: Array<{ check: string; reason: string; action?: string }>) {
    super(`Mnemosyne preflight failed: ${failures.length} check(s) failed`);
    this.name = "MnemosyneBootError";
  }
}

type CheckResult = { ok: true } | { ok: false; reason: string; action?: string };

interface PreflightCheck {
  name: string;
  fn: () => Promise<CheckResult>;
}

const checks: PreflightCheck[] = [
  {
    name: "docker",
    fn: async () => {
      try {
        await exec("docker", ["--version"]);
        return { ok: true };
      } catch {
        return {
          ok: false,
          reason: "Docker not found in PATH",
          action: "Install Docker Desktop: https://docs.docker.com/get-docker/",
        };
      }
    },
  },
  {
    name: "python",
    fn: async () => {
      try {
        const { stdout } = await exec("python3", ["--version"]);
        const version = stdout.trim().match(/(\d+)\.(\d+)/);
        if (!version) return { ok: false, reason: "Could not parse Python version" };
        const [, major, minor] = version.map(Number);
        if (major < 3 || (major === 3 && minor < 10)) {
          return { ok: false, reason: `Python ${major}.${minor} too old, need >= 3.10`, action: "brew install python@3.11" };
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: "python3 not found", action: "brew install python@3.11" };
      }
    },
  },
  {
    name: "chroma",
    fn: async () => {
      try {
        // Older `chroma` builds reject `--version`; `chroma --help` always exits 0
        await exec("chroma", ["--help"]);
        return { ok: true };
      } catch {
        return { ok: false, reason: "chroma CLI not found", action: "pip install chromadb" };
      }
    },
  },
  ...[7687, 7474, 8765].map<PreflightCheck>((port) => ({
    name: `port-${port}`,
    fn: async () => {
      const inUse = await isPortInUse(port);
      if (!inUse) return { ok: true };

      // Port is bound. Check if it's bound by OUR own service (re-boot scenario).
      // 7687 / 7474 → mnemosyne-neo4j container; 8765 → Chroma heartbeat.
      const ownedByUs = await isPortOwnedByMnemosyne(port);
      if (ownedByUs) {
        return { ok: true };
      }
      return { ok: false, reason: `Port ${port} in use by another process`, action: `Stop the conflicting process or change config` };
    },
  })),
  {
    name: "data-dir-writable",
    fn: async () => {
      const dir = `${process.env.HOME}/.jarvis/mnemosyne`;
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.access(dir, fs.constants.W_OK);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: `Cannot write to ${dir}: ${e}` };
      }
    },
  },
];

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Check if a bound port is owned by our own Mnemosyne services.
 *
 * This makes preflight idempotent — re-running on a host where Mnemosyne
 * is already up should NOT report port conflicts. Conflicts only matter
 * when ANOTHER process holds the port.
 *
 * - 7687 / 7474 → mnemosyne-neo4j container running + bound to 127.0.0.1
 * - 8765         → Chroma server responding to heartbeat
 */
async function isPortOwnedByMnemosyne(port: number): Promise<boolean> {
  if (port === 7687 || port === 7474) {
    try {
      const { stdout: state } = await exec("docker", [
        "inspect", "mnemosyne-neo4j",
        "--format", "{{.State.Running}}",
      ]);
      if (state.trim() !== "true") return false;
      const { stdout: portMap } = await exec("docker", ["port", "mnemosyne-neo4j", String(port)]);
      return portMap.trim().startsWith("127.0.0.1:");
    } catch {
      return false;
    }
  }
  if (port === 8765) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v2/heartbeat`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  return false;
}

export async function preflight(): Promise<void> {
  const failures: Array<{ check: string; reason: string; action?: string }> = [];
  for (const check of checks) {
    const result = await check.fn();
    if (!result.ok) {
      failures.push({ check: check.name, reason: result.reason, action: result.action });
    }
  }
  if (failures.length) throw new MnemosyneBootError(failures);
}
