// lib/catalogs.ts
//
// Hermes-first: DomainCatalog + EntityCatalog.
//
// WHY these exist:
//   In the Hermes-first model, the LLM (via hermes-reviewer) registers domains
//   and entities as first-class, validated objects BEFORE writing a memory that
//   references them. new_memory enforces STRICT validation — a memory cannot
//   reference a domain/entity that was never registered. This keeps the
//   knowledge graph's top-level taxonomy clean and intentional, instead of the
//   organic free-form `[domain: ...]` text hints of the old TRIPLET pipeline.
//
// Storage layout (mirrors CategoryCatalog's dynamic-dir pattern):
//   ~/.jarvis/mnemosyne/domains/<slug>.md
//   ~/.jarvis/mnemosyne/entities/<domain>/<slug>.md
//
// Each file is a markdown doc with a small YAML frontmatter (description +
// created_at). The body is free-form notes the LLM may expand later.

import { promises as fs } from "fs";
import { join } from "path";

export interface DomainEntry {
  slug: string;
  description: string;
  created_at: string;
}

export interface EntityEntry {
  slug: string;
  domain: string;
  description: string;
  created_at: string;
}

/** Minimal YAML frontmatter parser — same approach as CategoryCatalog.
 *  Avoids pulling gray-matter into this hot path; only reads description. */
function parseFrontmatter(raw: string): Record<string, string> {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

/** Slug guard — domain/entity slugs are lowercase-hyphenated. We don't
 *  silently rewrite the LLM's input; we reject malformed slugs so the tool
 *  surfaces a clear error and the LLM retries with a clean slug. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * DomainCatalog — top-level thematic domains (e.g. "mnemosyne", "saa", "jarvis").
 * Flat namespace, one file per domain.
 */
export class DomainCatalog {
  private entries = new Map<string, DomainEntry>();

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    this.entries.clear();
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const f of files) {
      const m = f.match(/^(.+)\.md$/);
      if (!m) continue;
      const slug = m[1];
      const raw = await fs.readFile(join(this.dir, f), "utf8");
      const fm = parseFrontmatter(raw);
      this.entries.set(slug, {
        slug,
        description: fm.description ?? slug,
        created_at: fm.created_at ?? "",
      });
    }
  }

  has(slug: string): boolean { return this.entries.has(slug); }
  get(slug: string): DomainEntry | undefined { return this.entries.get(slug); }
  list(): DomainEntry[] { return [...this.entries.values()]; }
  slugs(): string[] { return [...this.entries.keys()]; }

  /** Register a domain. Idempotent: if it already exists, the existing entry
   *  is kept and `created` is false (so the tool can report "already exists"). */
  async register(slug: string, description: string): Promise<{ created: boolean }> {
    if (this.entries.has(slug)) return { created: false };
    await fs.mkdir(this.dir, { recursive: true });
    const created_at = new Date().toISOString();
    const body =
      `---\n` +
      `description: ${description}\n` +
      `created_at: ${created_at}\n` +
      `---\n\n` +
      `# ${slug}\n\n${description}\n`;
    await fs.writeFile(join(this.dir, `${slug}.md`), body);
    this.entries.set(slug, { slug, description, created_at });
    return { created: true };
  }
}

/**
 * EntityCatalog — named entities scoped under a domain
 * (e.g. domain "mnemosyne" → entity "BackgroundReviewPiece").
 * Two-level namespace: <domain>/<slug>.
 */
export class EntityCatalog {
  /** keyed by `${domain}/${slug}` */
  private entries = new Map<string, EntityEntry>();

  constructor(private readonly dir: string) {}

  private key(domain: string, slug: string): string {
    return `${domain}/${slug}`;
  }

  async load(): Promise<void> {
    this.entries.clear();
    let domains: string[];
    try {
      domains = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const domain of domains) {
      const domainDir = join(this.dir, domain);
      let files: string[];
      try {
        files = await fs.readdir(domainDir);
      } catch {
        continue; // not a directory — skip
      }
      for (const f of files) {
        const m = f.match(/^(.+)\.md$/);
        if (!m) continue;
        const slug = m[1];
        const raw = await fs.readFile(join(domainDir, f), "utf8");
        const fm = parseFrontmatter(raw);
        this.entries.set(this.key(domain, slug), {
          slug,
          domain,
          description: fm.description ?? slug,
          created_at: fm.created_at ?? "",
        });
      }
    }
  }

  has(domain: string, slug: string): boolean { return this.entries.has(this.key(domain, slug)); }
  get(domain: string, slug: string): EntityEntry | undefined { return this.entries.get(this.key(domain, slug)); }
  list(): EntityEntry[] { return [...this.entries.values()]; }
  listByDomain(domain: string): EntityEntry[] {
    return [...this.entries.values()].filter((e) => e.domain === domain);
  }

  /** Register an entity under a domain. Idempotent. */
  async register(domain: string, slug: string, description: string): Promise<{ created: boolean }> {
    const k = this.key(domain, slug);
    if (this.entries.has(k)) return { created: false };
    const domainDir = join(this.dir, domain);
    await fs.mkdir(domainDir, { recursive: true });
    const created_at = new Date().toISOString();
    const body =
      `---\n` +
      `description: ${description}\n` +
      `domain: ${domain}\n` +
      `created_at: ${created_at}\n` +
      `---\n\n` +
      `# ${slug}\n\n${description}\n`;
    await fs.writeFile(join(domainDir, `${slug}.md`), body);
    this.entries.set(k, { slug, domain, description, created_at });
    return { created: true };
  }
}
