import { promises as fs } from "fs";
import { dirname } from "path";
import type { PendingCategory, NewCategoryProposal } from "../types";

const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

export class PendingCategoriesStore {
  private data: Record<string, PendingCategory> = {};

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.path, "utf8");
      this.data = JSON.parse(raw);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.data = {};
        return;
      }
      throw err;
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(this.data, null, 2));
  }

  get(slug: string): PendingCategory | null {
    return this.data[slug] ?? null;
  }

  register(proposal: NewCategoryProposal): PendingCategory {
    const now = new Date().toISOString();
    const existing = this.data[proposal.id];
    if (!existing) {
      this.data[proposal.id] = {
        slug: proposal.id,
        description: proposal.description,
        hint: proposal.hint,
        extractor_template: proposal.extractor_template,
        occurrences: 1,
        first_seen_ts: now,
        last_seen_ts: now,
      };
      return this.data[proposal.id];
    }
    const lastMs = new Date(existing.last_seen_ts).getTime();
    if (Date.now() - lastMs > SEVEN_DAYS_MS) {
      existing.occurrences = 1;
      existing.first_seen_ts = now;
    } else {
      existing.occurrences += 1;
    }
    existing.last_seen_ts = now;
    existing.description = proposal.description;
    existing.hint = proposal.hint;
    existing.extractor_template = proposal.extractor_template;
    return existing;
  }

  remove(slug: string): void {
    delete this.data[slug];
  }

  gc(opts: { maxAgeDays: number; minOccurrencesToKeep: number }): string[] {
    const maxAgeMs = opts.maxAgeDays * 24 * 3600 * 1000;
    const now = Date.now();
    const purged: string[] = [];
    for (const [slug, entry] of Object.entries(this.data)) {
      const ageMs = now - new Date(entry.last_seen_ts).getTime();
      if (ageMs > maxAgeMs && entry.occurrences < opts.minOccurrencesToKeep) {
        delete this.data[slug];
        purged.push(slug);
      }
    }
    return purged;
  }

  list(): PendingCategory[] {
    return Object.values(this.data);
  }
}
