import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export interface Neo4jServerOptions {
  composeFile: string;
  containerName: string;
  boltUri: string;
}

// Compose binary detection.
//
// Plan uses `docker compose` (v2 plugin). That subcommand isn't installed on
// this host. Standalone `docker-compose` (v1 / Compose v5.x) is. Probe at
// import time and pick the one that exists. Either supports the same
// up/down -d -f arguments we use.
async function detectComposeCommand(): Promise<{ cmd: string; args: string[] }> {
  try {
    await exec("docker", ["compose", "version"]);
    return { cmd: "docker", args: ["compose"] };
  } catch {
    return { cmd: "docker-compose", args: [] };
  }
}

export class Neo4jServer {
  private compose?: { cmd: string; args: string[] };

  constructor(private opts: Neo4jServerOptions) {}

  private async composeCmd(): Promise<{ cmd: string; args: string[] }> {
    if (!this.compose) this.compose = await detectComposeCommand();
    return this.compose;
  }

  async start(): Promise<void> {
    const c = await this.composeCmd();
    await exec(c.cmd, [...c.args, "-f", this.opts.composeFile, "up", "-d"]);
    await this.waitForHealthy(60000);
  }

  async stop(): Promise<void> {
    const c = await this.composeCmd();
    await exec(c.cmd, [...c.args, "-f", this.opts.composeFile, "down"]);
  }

  async isHealthy(): Promise<boolean> {
    try {
      const { stdout } = await exec("docker", [
        "inspect",
        "--format", "{{.State.Health.Status}}",
        this.opts.containerName,
      ]);
      return stdout.trim() === "healthy";
    } catch {
      return false;
    }
  }

  async validateLoopbackBinding(): Promise<boolean> {
    try {
      const { stdout } = await exec("docker", [
        "port", this.opts.containerName, "7687/tcp",
      ]);
      // Expected: "127.0.0.1:7687"
      return stdout.trim().startsWith("127.0.0.1:");
    } catch {
      return false;
    }
  }

  private async waitForHealthy(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isHealthy()) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Neo4j did not become healthy within ${timeoutMs}ms`);
  }
}
