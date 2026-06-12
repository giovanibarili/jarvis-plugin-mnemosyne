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
import type { DomainCatalog, EntityCatalog } from "../catalogs";
import { isValidSlug } from "../catalogs";

/** Minimal store surface the primitives need — keeps the tools testable. */
export interface PrimitiveStore {
  write(memory: Memory): Promise<void>;
}

/** Minimal graph surface for inline relations. */
export interface PrimitiveGraph {
  createExplicitEdge(fromId: string, toId: string, relation: string, reason: string): Promise<void>;
}

/** Mnemosyne id format — mirror EncoderV12: <session>-<ts>-<rand6>. */
function makeId(sessionId: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${sessionId}-${Date.now()}-${rand}`;
}

// ── new_domain ───────────────────────────────────────────────────────────────

export function buildNewDomainTool(catalog: DomainCatalog): CapabilityDefinition {
  return {
    name: "new_domain",
    description:
      "Register a thematic DOMAIN in the Mnemosyne taxonomy before writing memories that reference it. " +
      "A domain is a top-level theme (e.g. 'mnemosyne', 'saa', 'jarvis'). " +
      "Idempotent — registering an existing domain is a no-op. " +
      "Call this BEFORE new_memory when the memory's domain doesn't exist yet.",
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Lowercase-hyphenated slug, e.g. 'memory-architecture'" },
        description: { type: "string", description: "One-line description of what this domain covers" },
      },
      required: ["slug", "description"],
    },
    handler: async (args: Record<string, unknown>) => {
      const slug = String(args.slug ?? "").trim();
      const description = String(args.description ?? "").trim();
      if (!isValidSlug(slug)) {
        return { ok: false, error: `invalid slug '${slug}' — must be lowercase-hyphenated (a-z, 0-9, -)` };
      }
      if (!description) return { ok: false, error: "description is required" };
      const { created } = await catalog.register(slug, description);
      return { ok: true, slug, created, existed: !created };
    },
  };
}

// ── new_entity ───────────────────────────────────────────────────────────────

export function buildNewEntityTool(
  domains: DomainCatalog,
  entities: EntityCatalog,
): CapabilityDefinition {
  return {
    name: "new_entity",
    description:
      "Register a named ENTITY scoped under an existing domain (e.g. domain 'mnemosyne' → entity 'BackgroundReviewPiece'). " +
      "The domain MUST already exist (register it with new_domain first). " +
      "Idempotent — registering an existing entity is a no-op.",
    input_schema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Existing domain slug this entity belongs to" },
        slug: { type: "string", description: "Lowercase-hyphenated entity slug" },
        description: { type: "string", description: "One-line description of the entity" },
      },
      required: ["domain", "slug", "description"],
    },
    handler: async (args: Record<string, unknown>) => {
      const domain = String(args.domain ?? "").trim();
      const slug = String(args.slug ?? "").trim();
      const description = String(args.description ?? "").trim();
      if (!isValidSlug(domain)) return { ok: false, error: `invalid domain slug '${domain}'` };
      if (!isValidSlug(slug)) return { ok: false, error: `invalid entity slug '${slug}'` };
      if (!description) return { ok: false, error: "description is required" };
      if (!domains.has(domain)) {
        return { ok: false, error: `domain '${domain}' does not exist — call new_domain('${domain}', ...) first` };
      }
      const { created } = await entities.register(domain, slug, description);
      return { ok: true, domain, slug, created, existed: !created };
    },
  };
}

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
): CapabilityDefinition {
  return {
    name: "new_memory",
    description:
      "Write a fully-structured long-term memory DIRECTLY to Mnemosyne. " +
      "You provide the final title, content, category, domain, and (optionally) entity, tags, confidence, and relations. " +
      "STRICT: the referenced domain MUST exist (register via new_domain). If entity is given, it MUST exist under that domain (register via new_entity). " +
      "Write content already enriched with the domain terms you want embedded — there is no automatic enrichment. " +
      "Use relations[] to create explicit graph edges to existing memories at write time.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Concise memory title" },
        content: { type: "string", description: "Full memory body. Write it already enriched with domain synonyms for good embedding." },
        category: { type: "string", description: "Memory category slug (e.g. architecture-decision, reasoning-pattern, value-priority, code-pattern)" },
        domain: { type: "string", description: "Existing domain slug this memory belongs to (REQUIRED)" },
        entity: { type: "string", description: "Optional existing entity slug within the domain" },
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
      required: ["title", "content", "category", "domain"],
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
        return { ok: false, error: `domain '${domain}' does not exist — call new_domain('${domain}', ...) first` };
      }
      if (entity && !entities.has(domain, entity)) {
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

      // Inline relations — best-effort; a failed edge does not undo the write.
      const relations = Array.isArray(args.relations) ? (args.relations as RelationInput[]) : [];
      const edgeResults: Array<{ to_id: string; ok: boolean; error?: string }> = [];
      if (graph && relations.length > 0) {
        for (const r of relations) {
          try {
            await graph.createExplicitEdge(memory.id, r.to_id, r.relation, r.reason);
            edgeResults.push({ to_id: r.to_id, ok: true });
          } catch (e) {
            edgeResults.push({ to_id: r.to_id, ok: false, error: String(e) });
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
