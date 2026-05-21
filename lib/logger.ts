import { promises as fs } from "fs";
import { join } from "path";

/**
 * Shape of an entry written to extraction.log.
 *
 * v1.2 TRIPLET adds optional fields that are only populated when
 * `pipeline_version === "1.2"`. v1.1 entries continue to work unchanged.
 */
export interface ExtractionLogEntry {
  turn_id: string;
  pass: 1 | 2;
  categories?: string[];
  candidates_emitted?: number;
  confidence_avg?: number;
  cost_usd?: number;
  skip_reason?: string | null;

  // v1.2 TRIPLET fields (optional — only present when pipeline_version = "1.2")
  pipeline_version?: "1.1" | "1.2";
  classify_candidates?: number;
  new_categories_proposed?: number;
  materialized?: string[]; // slugs materialized this turn
  intra_turn_edges?: number;
  cross_store_edges?: number;
}

export class Logger {
  constructor(private rootDir: string) {}

  private async append(file: string, entry: any): Promise<void> {
    const path = join(this.rootDir, file);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.appendFile(path, line, "utf-8");
  }

  async logExtraction(entry: ExtractionLogEntry): Promise<void> {
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
