import { promises as fs } from "fs";
import { join } from "path";

export class Logger {
  constructor(private rootDir: string) {}

  private async append(file: string, entry: any): Promise<void> {
    const path = join(this.rootDir, file);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.appendFile(path, line, "utf-8");
  }

  async logExtraction(entry: {
    turn_id: string;
    pass: 1 | 2;
    categories?: string[];
    candidates_emitted?: number;
    confidence_avg?: number;
    cost_usd?: number;
    skip_reason?: string | null;
  }): Promise<void> {
    await this.append("extraction.log", entry);
  }

  async logConsolidation(entry: any): Promise<void> {
    await this.append("consolidation.log", entry);
  }

  async logReplay(entry: any): Promise<void> {
    await this.append("replay.log", entry);
  }

  async logPreflight(entry: any): Promise<void> {
    await this.append("preflight.log", entry);
  }
}
