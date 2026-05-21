import { promises as fs } from "fs";
import { join } from "path";
import type { NewCategoryProposal } from "../types";

export interface CatalogEntry {
  id: string;
  description: string;
  hint: string;
  source: "seed" | "dynamic";
  examples?: string[];
}

function parseFrontmatter(raw: string): { description?: string; hint?: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

export class CategoryCatalog {
  private entries = new Map<string, CatalogEntry>();

  constructor(
    private readonly seedDir: string,
    private readonly dynamicDir: string,
  ) {}

  async load(): Promise<void> {
    this.entries.clear();
    await this.loadDir(this.seedDir, "seed", /^extract-(.+)\.md$/);
    await this.loadDir(this.dynamicDir, "dynamic", /^(.+)\.md$/);
  }

  private async loadDir(dir: string, source: "seed" | "dynamic", re: RegExp): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const f of files) {
      const m = f.match(re);
      if (!m) continue;
      const id = m[1];
      const raw = await fs.readFile(join(dir, f), "utf8");
      const fm = parseFrontmatter(raw);
      this.entries.set(id, {
        id,
        description: fm.description ?? id,
        hint: fm.hint ?? "",
        source,
      });
    }
  }

  has(id: string): boolean { return this.entries.has(id); }
  get(id: string): CatalogEntry | undefined { return this.entries.get(id); }
  list(): CatalogEntry[] { return [...this.entries.values()]; }
  existingIds(): string[] { return [...this.entries.keys()]; }

  async materialize(proposal: NewCategoryProposal): Promise<void> {
    await fs.mkdir(this.dynamicDir, { recursive: true });
    const path = join(this.dynamicDir, `${proposal.id}.md`);
    const body =
      `---\n` +
      `description: ${proposal.description}\n` +
      `hint: "${proposal.hint.replace(/"/g, '\\"')}"\n` +
      `created_at: ${new Date().toISOString()}\n` +
      `---\n` +
      proposal.extractor_template + "\n";
    await fs.writeFile(path, body);
    this.entries.set(proposal.id, {
      id: proposal.id,
      description: proposal.description,
      hint: proposal.hint,
      source: "dynamic",
    });
  }

  renderCatalog(): string {
    const lines: string[] = [];
    for (const e of this.entries.values()) {
      lines.push(`- **${e.id}** — ${e.description}`);
      if (e.hint) lines.push(`  hint: ${e.hint}`);
    }
    return lines.join("\n");
  }
}
