// lib/catalogs.ts
//
// Hermes-first: TaxonCatalog — free-form taxonomy nodes.
//
// WHY this exists:
//   In the Hermes-first model, the LLM registers taxonomy nodes as first-class
//   validated objects BEFORE writing a memory that references them.
//   new_memory enforces STRICT validation — a memory cannot reference a taxon
//   that was never registered.
//
//   Taxonomy nodes are free-form: the LLM chooses a `type` (e.g. "business-unit",
//   "domain", "service", "entity", "model", "topic") and a slug. There are no
//   hardcoded levels — the LLM picks the minimal representation that fits.
//
// Storage layout:
//   ~/.jarvis/mnemosyne/taxons/<type>/<slug>.md
//
// Each file has YAML frontmatter (type, description, created_at).

import { promises as fs } from "fs";
import { join } from "path";

export interface TaxonEntry {
  type: string;   // e.g. "business-unit", "domain", "service", "entity"
  slug: string;
  description: string;
  level: number;  // 1 = hexagon (broad), 2 = diamond (concrete). Default: 2.
  created_at: string;
}

// ── backward-compat aliases ──────────────────────────────────────────────────
// Keep old interfaces alive so types.ts + store.ts compile without changes.
export interface DomainEntry { slug: string; description: string; created_at: string; }
export interface EntityEntry { slug: string; domain: string; description: string; created_at: string; }

/** Minimal YAML frontmatter parser. */
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

/** Slug guard — taxon slugs are lowercase-hyphenated. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * TaxonCatalog — stores free-form taxonomy nodes keyed by `type/slug`.
 * Replaces the old DomainCatalog + EntityCatalog pair.
 */
export class TaxonCatalog {
  /** keyed by `${type}/${slug}` */
  private entries = new Map<string, TaxonEntry>();

  constructor(private readonly dir: string) {}

  private key(type: string, slug: string): string { return `${type}/${slug}`; }

  async load(): Promise<void> {
    this.entries.clear();
    let types: string[];
    try { types = await fs.readdir(this.dir); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const type of types) {
      const typeDir = join(this.dir, type);
      let files: string[];
      try { files = await fs.readdir(typeDir); } catch { continue; }
      for (const f of files) {
        const m = f.match(/^(.+)\.md$/);
        if (!m) continue;
        const slug = m[1];
        const raw = await fs.readFile(join(typeDir, f), "utf8");
        const fm = parseFrontmatter(raw);
        this.entries.set(this.key(type, slug), {
          type, slug,
          description: fm.description ?? slug,
          level: fm.level ? parseInt(fm.level, 10) : 2,
          created_at: fm.created_at ?? "",
        });
      }
    }
  }

  has(type: string, slug: string): boolean { return this.entries.has(this.key(type, slug)); }
  hasSlug(slug: string): boolean { return [...this.entries.values()].some(e => e.slug === slug); }
  get(type: string, slug: string): TaxonEntry | undefined { return this.entries.get(this.key(type, slug)); }
  getBySlug(slug: string): TaxonEntry | undefined { return [...this.entries.values()].find(e => e.slug === slug); }
  list(): TaxonEntry[] { return [...this.entries.values()]; }
  listByType(type: string): TaxonEntry[] { return [...this.entries.values()].filter(e => e.type === type); }
  types(): string[] { return [...new Set([...this.entries.values()].map(e => e.type))]; }

  async register(type: string, slug: string, description: string, level: number = 2): Promise<{ created: boolean }> {
    const k = this.key(type, slug);
    if (this.entries.has(k)) return { created: false };
    const typeDir = join(this.dir, type);
    await fs.mkdir(typeDir, { recursive: true });
    const created_at = new Date().toISOString();
    const body =
      `---\n` +
      `type: ${type}\n` +
      `level: ${level}\n` +
      `description: ${description}\n` +
      `created_at: ${created_at}\n` +
      `---\n\n` +
      `# ${slug}\n\n${description}\n`;
    await fs.writeFile(join(typeDir, `${slug}.md`), body);
    this.entries.set(k, { type, slug, description, level, created_at });
    return { created: true };
  }
}

// ── backward-compat shims ────────────────────────────────────────────────────
// DomainCatalog and EntityCatalog forward to a shared TaxonCatalog so
// existing call sites compile without changes during migration.

export class DomainCatalog {
  constructor(private readonly taxons: TaxonCatalog) {}
  async load(): Promise<void> { /* taxons.load() called externally */ }
  has(slug: string): boolean { return this.taxons.has("domain", slug) || this.taxons.hasSlug(slug); }
  get(slug: string): DomainEntry | undefined {
    const e = this.taxons.get("domain", slug) ?? this.taxons.getBySlug(slug);
    return e ? { slug: e.slug, description: e.description, created_at: e.created_at } : undefined;
  }
  list(): DomainEntry[] {
    return this.taxons.list()
      .filter(e => e.type === "domain")
      .map(e => ({ slug: e.slug, description: e.description, created_at: e.created_at }));
  }
  slugs(): string[] { return this.list().map(e => e.slug); }
  async register(slug: string, description: string): Promise<{ created: boolean }> {
    return this.taxons.register("domain", slug, description);
  }
}

export class EntityCatalog {
  constructor(private readonly taxons: TaxonCatalog) {}
  async load(): Promise<void> { /* taxons.load() called externally */ }
  has(domain: string, slug: string): boolean { return this.taxons.hasSlug(slug); }
  get(domain: string, slug: string): EntityEntry | undefined {
    const e = this.taxons.getBySlug(slug);
    return e ? { slug: e.slug, domain, description: e.description, created_at: e.created_at } : undefined;
  }
  list(): EntityEntry[] {
    return this.taxons.list()
      .filter(e => e.type !== "domain")
      .map(e => ({ slug: e.slug, domain: "", description: e.description, created_at: e.created_at }));
  }
  listByDomain(domain: string): EntityEntry[] { return this.list(); }
  async register(domain: string, slug: string, description: string): Promise<{ created: boolean }> {
    // entity type is "entity" by default when called via shim
    return this.taxons.register("entity", slug, description);
  }
}
