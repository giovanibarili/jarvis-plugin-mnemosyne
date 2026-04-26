import { spawn, ChildProcess } from "child_process";

export interface ChromaServerOptions {
  dataDir: string;
  port: number;
  host?: string;
}

export class ChromaServer {
  private proc?: ChildProcess;
  private opts: Required<ChromaServerOptions>;

  constructor(opts: ChromaServerOptions) {
    this.opts = { host: "127.0.0.1", ...opts };
  }

  async start(): Promise<void> {
    if (this.proc) throw new Error("Already started");

    this.proc = spawn(
      "chroma",
      [
        "run",
        "--path", this.opts.dataDir,
        "--port", String(this.opts.port),
        "--host", this.opts.host,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    this.proc.stderr?.on("data", (d) => {
      process.stderr.write(`[chroma] ${d}`);
    });

    await this.waitForHealthy(30000);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      this.proc!.once("exit", () => resolve());
      setTimeout(() => {
        this.proc!.kill("SIGKILL");
        resolve();
      }, 5000);
    });
    this.proc = undefined;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`http://${this.opts.host}:${this.opts.port}/api/v2/heartbeat`);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitForHealthy(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isHealthy()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Chroma did not become healthy within ${timeoutMs}ms`);
  }
}
