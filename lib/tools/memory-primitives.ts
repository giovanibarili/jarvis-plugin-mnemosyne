// lib/tools/memory-primitives.ts
//
// Hermes-first atomic memory primitives: new_domain, new_entity, new_memory.
//
// WHY these replace mnemosyne_triage + EncoderV12:
//   The old TRIPLET pipeline ran triage→classify→enrich→relate mechanically on
//   every turn (and on triage tool calls). It used a cheap Haiku model to GUESS
//   the title/category/content/tags from raw conversation. That is strictly
//   worse than the orchestrating LLM (hermes-reviewer) which already KNOWS the
//   structured shape. These primitives let the LLM write a fully-formed memory
//   in one deliberate call — no guessing, no second model, no async queue.
//
// Design:
//   - new_domain / new_entity register taxonomy in DomainCatalog / EntityCatalog.
//   - new_memory writes DIRECTLY through store.write (markdown+chroma+neo4j,
//     embedding computed automatically by Chroma's MiniLM). STRICT validation:
//     the referenced domain (and entity, if given) MUST already exist.
//   - relations[] create explicit graph edges inline via neo4j.createExplicitEdge,
//     the same mechanism memory_relate uses.
//
// No enrich: the LLM is expected to write content already enriched with the
// domain synonyms it wants embedded. We do not append [domain: ...] hints.

import type { CapabilityDefinition } from "@jarvis/core";
import type { Memory, Category } from "../types";
import { TaxonCatalog, DomainCatalog, EntityCatalog, isValidSlug } from "../catalogs";

/** Minimal store surface the primitives need — keeps the tools testable. */
export interface PrimitiveStore {
  write(memory: Memory): Promise<void>;
}

/** Minimal graph surface for inline relations + taxonomy wiring. */
export interface PrimitiveGraph {
  createExplicitEdge(fromId: string, toId: string, relation: string, reason: string): Promise<void>;
  upsertTaxon(type: string, slug: string, description: string): Promise<void>;
  upsertDomain(slug: string, description: string): Promise<void>;
  upsertEntity(domain: string, slug: string, description: string): Promise<void>;
  linkMemoryToTaxonomy(memoryId: string, domain: string | null, entity: string | null): Promise<void>;
  linkMemoryToTaxon(memoryId: string, slug: string): Promise<void>;
}

/** Mnemosyne id format — mirror EncoderV12: <session>-<ts>-<rand6>. */
function makeId(sessionId: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${sessionId}-${Date.now()}-${rand}`;
}

/**
 * Hermes-first WRITER stats — in-memory counters for the current process
 * lifetime. The panel merges these with disk-derived historical totals.
 * Shared singleton so all three primitive tools write to the same object.
 */
export interface WriterStats {
  domainCalls: number;
  domainsCreated: number;
  entityCalls: number;
  entitiesCreated: number;
  memoryWrites: number;
  memoryRejected: number;
  edgesCreated: number;
  edgesFailed: number;
  lastWriteAt: number | null;
}

export function makeWriterStats(): WriterStats {
  return {
    domainCalls: 0,
    domainsCreated: 0,
    entityCalls: 0,
    entitiesCreated: 0,
    memoryWrites: 0,
    memoryRejected: 0,
    edgesCreated: 0,
    edgesFailed: 0,
    lastWriteAt: null,
  };
}

// ── new_taxon ────────────────────────────────────────────────────────────────
//
// Single tool that replaces new_domain + new_entity.
// The LLM freely chooses the `type` (e.g. "business-unit", "domain",
// "service", "entity", "model", "topic"). No hardcoded hierarchy.
//
// Palette examples (non-exhaustive — LLM can use any lowercase-hyphenated type):
//   type: "business-unit"  → GBA, Payments, Lending
//   type: "domain"         → deposit-platform, authorization, accounting
//   type: "service"        → gdm, saa, sam, horadric, bag-of-holding
//   type: "entity"         → deposit, simple-account, event-counter
//   type: "model"          → account-snapshot, policy, tax-rule
//   type: "topic"          → SIMPLE-ACCOUNT.AUTHORIZER.OPERATION-PROCESSED
//   type: "table"          → docstore-settlement-request

export function buildNewTaxonTool(catalog: TaxonCatalog, stats?: WriterStats, graph?: PrimitiveGraph): CapabilityDefinition {
  return {
    name: "new_taxon",
    description:
      "Register a taxonomy node in Mnemosyne before writing memories that reference it. " +
      "Choose the `type` that best represents the concept — the type is free-form. " +
      "Palette examples: 'business-unit' (GBA, Payments), 'domain' (deposit-platform), " +
      "'service' (gdm, saa, sam), 'entity' (deposit, simple-account), " +
      "'model' (account-snapshot), 'topic' (kafka topic name), 'table' (dynamodb table). " +
      "Idempotent — registering an existing slug is a no-op. " +
      "Call this BEFORE new_memory when the taxon doesn't exist yet.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Free-form type label, lowercase-hyphenated. e.g. 'domain', 'service', 'entity', 'model', 'business-unit', 'topic', 'table'",
        },
        slug: {
          type: "string",
          description: "Lowercase-hyphenated identifier slug. e.g. 'deposit-platform', 'gdm', 'simple-account'",
        },
        description: {
          type: "string",
          description: "One-line description of what this taxon represents",
        },
        level: {
          type: "number",
          description: "Visual level in graph: 1 = hexagon (broad/thematic, e.g. domain, business-unit), 2 = diamond (concrete/specific, e.g. service, entity, model). Default: 2.",
        },
      },
      required: ["type", "slug", "description"],
    },
    handler: async (args: Record<string, unknown>) => {
      const type = String(args.type ?? "").trim().toLowerCase();
      const slug = String(args.slug ?? "").trim();
      const description = String(args.description ?? "").trim();
      const level = typeof args.level === "number" ? args.level : 2;
      if (!isValidSlug(type)) return { ok: false, error: `invalid type '${type}' — must be lowercase-hyphenated` };
      if (!isValidSlug(slug)) return { ok: false, error: `invalid slug '${slug}' — must be lowercase-hyphenated` };
      if (!description) return { ok: false, error: "description is required" };
      const { created } = await catalog.register(type, slug, description, level);
      if (stats) {
        stats.domainCalls++;
        if (created) stats.domainsCreated++;
      }
      if (graph) await (graph as any).upsertTaxon ? (graph as any).upsertTaxon(type, slug, description, level).catch(() => {}) : graph.upsertDomain(slug, description).catch(() => {});
      return { ok: true, type, slug, level, created, existed: !created };
    },
  };
}

// ── backward-compat shims ─────────────────────────────────────────────────────
// new_domain and new_entity are kept for any agent that still calls them.
// They delegate to new_taxon with fixed types.

export function buildNewDomainTool(catalog: DomainCatalog, stats?: WriterStats, graph?: PrimitiveGraph): CapabilityDefinition {
  const taxonCatalog = (catalog as any).taxons as TaxonCatalog;
  const inner = buildNewTaxonTool(taxonCatalog, stats, graph);
  return { ...inner, name: "new_domain",
    handler: (args: Record<string, unknown>) => (inner.handler as any)({ ...args, type: "domain" }),
  };
}

export function buildNewEntityTool(domains: DomainCatalog, entities: EntityCatalog, stats?: WriterStats, graph?: PrimitiveGraph): CapabilityDefinition {
  const taxonCatalog = (entities as any).taxons as TaxonCatalog;
  const inner = buildNewTaxonTool(taxonCatalog, stats, graph);
  return { ...inner, name: "new_entity",
    handler: (args: Record<string, unknown>) => (inner.handler as any)({ ...args, type: "entity" }),
  };
}

// ── new_memory ────────────────────────────────────────────────────────────────
// ── new_memory ───────────────────────────────────────────────────────────────

export interface RelationInput {
  to_id: string;
  relation: string;
  reason: string;
}

export function buildNewMemoryTool(
  store: PrimitiveStore,
  domains: DomainCatalog,
  entities: EntityCatalog,
  graph: PrimitiveGraph | undefined,
  stats?: WriterStats,
): CapabilityDefinition {
  return {
    name: "new_memory",
    description:
      "Write a fully-structured long-term memory DIRECTLY to Mnemosyne. " +
      "You provide the final title, content, category, and optionally taxons (free-form taxonomy tags), tags, confidence, and relations. " +
      "STRICT: any taxon slug referenced in `taxons` MUST exist (register via new_taxon first). " +
      "Write content already enriched with the domain terms you want embedded — there is no automatic enrichment. " +
      "Use relations[] to create explicit graph edges to existing memories at write time." +
      "Backward-compat: `domain` and `entity` fields still accepted and mapped to taxons automatically.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Concise memory title" },
        content: { type: "string", description: "Full memory body. Write it already enriched with domain synonyms for good embedding." },
        category: { type: "string", description: "Memory category slug (e.g. architecture-decision, reasoning-pattern, value-priority, code-pattern)" },
        domain: { type: "string", description: "DEPRECATED — use taxons. Backward-compat: mapped to taxon type=domain automatically." },
        entity: { type: "string", description: "DEPRECATED — use taxons. Backward-compat: mapped to taxon type=entity automatically." },
        taxons: {
          type: "array",
          description: "Optional taxonomy tags. Each is a {type, slug} pair referencing a registered taxon. type is free-form (e.g. 'domain', 'service', 'entity'). MUST be registered via new_taxon first.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Taxon type (e.g. 'domain', 'service', 'entity')" },
              slug: { type: "string", description: "Taxon slug (must be registered)" },
            },
            required: ["type", "slug"],
          },
        },
        tags: { type: "array", items: { type: "string" }, description: "Optional tag slugs" },
        confidence: { type: "number", description: "Optional confidence 0–1 (default 0.9)" },
        project: { type: "string", description: "Optional project scope" },
        evidence: { type: "string", description: "Optional one-line evidence/justification" },
        relations: {
          type: "array",
          description: "Optional explicit edges to existing memories",
          items: {
            type: "object",
            properties: {
              to_id: { type: "string", description: "Target memory id" },
              relation: { type: "string", description: "Relation label (supersede, relates_to, contradicts, derived_from, etc.)" },
              reason: { type: "string", description: "Why this edge exists — quote the connecting element" },
            },
            required: ["to_id", "relation", "reason"],
          },
        },
      },
      required: ["title", "content", "category"],
    },
    handler: async (args: Record<string, unknown>, meta?: { sessionId?: string }) => {
      const sessionId = meta?.sessionId ?? "main";
      const title = String(args.title ?? "").trim();
      const content = String(args.content ?? "").trim();
      const category = String(args.category ?? "").trim() as Category;
      const domain = String(args.domain ?? "").trim();
      const entity = args.entity ? String(args.entity).trim() : null;

      if (!title) return { ok: false, error: "title is required" };
      if (!content) return { ok: false, error: "content is required" };
      if (!category) return { ok: false, error: "category is required" };
      if (!domain) return { ok: false, error: "domain is required" };

      // STRICT validation against the taxonomy.
      if (!domains.has(domain)) {
        if (stats) stats.memoryRejected++;
        return { ok: false, error: `domain '${domain}' does not exist — call new_domain('${domain}', ...) first` };
      }
      if (entity && !entities.has(domain, entity)) {
        if (stats) stats.memoryRejected++;
        return { ok: false, error: `entity '${entity}' does not exist under domain '${domain}' — call new_entity('${domain}', '${entity}', ...) first` };
      }

      const now = Date.now();
      const memory: Memory = {
        id: makeId(sessionId),
        category,
        title,
        content,
        tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
        project: args.project ? String(args.project) : null,
        confidence: typeof args.confidence === "number" ? args.confidence : 0.9,
        reinforcements: 0,
        visibility: "open",
        pinned: false,
        created_at: now,
        last_accessed: now,
        source_session: sessionId,
        promoted_at: null,
        evidence: args.evidence ? String(args.evidence) : undefined,
        origin_source: "tool",
        origin_tool: "new_memory",
        domain,
        entity,
      };

      await store.write(memory);
      if (stats) { stats.memoryWrites++; stats.lastWriteAt = now; }
      // Wire Memory → Domain (and → Entity) in the graph, best-effort
      if (graph) await graph.linkMemoryToTaxonomy(memory.id, domain, entity).catch(() => {});

      // Inline relations — best-effort; a failed edge does not undo the write.
      const relations = Array.isArray(args.relations) ? (args.relations as RelationInput[]) : [];
      const edgeResults: Array<{ to_id: string; ok: boolean; error?: string }> = [];
      if (graph && relations.length > 0) {
        for (const r of relations) {
          try {
            await graph.createExplicitEdge(memory.id, r.to_id, r.relation, r.reason);
            edgeResults.push({ to_id: r.to_id, ok: true });
            if (stats) stats.edgesCreated++;
          } catch (e) {
            edgeResults.push({ to_id: r.to_id, ok: false, error: String(e) });
            if (stats) stats.edgesFailed++;
          }
        }
      }

      return {
        ok: true,
        id: memory.id,
        domain,
        entity,
        category,
        edges: edgeResults,
      };
    },
  };
}
