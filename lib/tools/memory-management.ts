import type { CapabilityDefinition } from "@jarvis/core";
import type { MnemosyneStore } from "../store.js";
import type { Memory, Visibility } from "../types.js";
import { resolveMemoryId } from "./memory-search.js";

/* -------------------------------------------------------------- shapes ---- */

interface MemoryUpdateArgs {
  id: string;
  patch: Partial<
    Pick<Memory, "title" | "content" | "tags" | "project" | "visibility" | "pinned">
  >;
}

interface MemoryIdArgs {
  id: string;
}

/* -------------------------------------------------------------- builders -- */

/**
 * memory_update — manual edit of mutable fields. Goes through `store.write`
 * so the three storage layers stay consistent (markdown canonical → Chroma
 * upsert → Neo4j upsert). Re-uses the rollback semantics from store.write.
 *
 * The `patch` is whitelisted to (title, content, tags, project, visibility,
 * pinned). Other fields (id, category, confidence, reinforcements,
 * created_at, promoted_at) require explicit pipeline operations
 * (consolidator, retriever) and are not user-editable here.
 */
export function buildMemoryUpdateTool(
  store: MnemosyneStore
): CapabilityDefinition {
  return {
    name: "memory_update",
    description:
      "Manually edit a memory's mutable fields (title, content, tags, project, visibility, pinned). Patches the existing memory and rewrites all three storage layers.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id (full or short prefix)" },
        patch: {
          type: "object",
          properties: {
            title: { type: "string" },
            content: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            project: { type: ["string", "null"] },
            visibility: { type: "string", enum: ["open", "private"] },
            pinned: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["id", "patch"],
    },
    handler: async (raw) => {
      const args = raw as unknown as MemoryUpdateArgs;
      if (!args.id) return { error: "id is required" };
      if (!args.patch || typeof args.patch !== "object") {
        return { error: "patch is required" };
      }

      const mem = await resolveMemoryId(store, args.id);
      if (!mem) return { error: "not found" };

      // Whitelist + apply
      const allowed: Array<keyof MemoryUpdateArgs["patch"]> = [
        "title",
        "content",
        "tags",
        "project",
        "visibility",
        "pinned",
      ];
      const updated: Memory = { ...mem };
      for (const key of allowed) {
        if (args.patch[key] !== undefined) {
          (updated as any)[key] = args.patch[key];
        }
      }

      // Validate visibility if changed (defense in depth — schema enforces)
      if (
        updated.visibility !== "open" &&
        updated.visibility !== "private"
      ) {
        return { error: `invalid visibility: ${updated.visibility as Visibility}` };
      }

      try {
        await store.write(updated);
      } catch (e) {
        return {
          error: `update failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return { ok: true, id: updated.id };
    },
  };
}

export function buildMemoryPinTool(
  store: MnemosyneStore
): CapabilityDefinition {
  return {
    name: "memory_pin",
    description:
      "Pin a memory — it becomes immortal (never decays, weighted higher in retrieval).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id (full or short prefix)" },
      },
      required: ["id"],
    },
    handler: async (raw) => {
      const args = raw as unknown as MemoryIdArgs;
      if (!args.id) return { error: "id is required" };
      const mem = await resolveMemoryId(store, args.id);
      if (!mem) return { error: "not found" };
      if (mem.pinned) return { ok: true, id: mem.id, already_pinned: true };
      const updated: Memory = { ...mem, pinned: true };
      try {
        await store.write(updated);
      } catch (e) {
        return {
          error: `pin failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return { ok: true, id: updated.id };
    },
  };
}

export function buildMemoryUnpinTool(
  store: MnemosyneStore
): CapabilityDefinition {
  return {
    name: "memory_unpin",
    description:
      "Unpin a memory — it returns to normal decay/scoring rules.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id (full or short prefix)" },
      },
      required: ["id"],
    },
    handler: async (raw) => {
      const args = raw as unknown as MemoryIdArgs;
      if (!args.id) return { error: "id is required" };
      const mem = await resolveMemoryId(store, args.id);
      if (!mem) return { error: "not found" };
      if (!mem.pinned) return { ok: true, id: mem.id, already_unpinned: true };
      const updated: Memory = { ...mem, pinned: false };
      try {
        await store.write(updated);
      } catch (e) {
        return {
          error: `unpin failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return { ok: true, id: updated.id };
    },
  };
}

export function buildMemoryDeleteTool(
  store: MnemosyneStore
): CapabilityDefinition {
  return {
    name: "memory_delete",
    description:
      "Hard delete a memory from all three layers (markdown, Chroma, Neo4j). Irreversible.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id (full or short prefix)" },
      },
      required: ["id"],
    },
    handler: async (raw) => {
      const args = raw as unknown as MemoryIdArgs;
      if (!args.id) return { error: "id is required" };
      const mem = await resolveMemoryId(store, args.id);
      if (!mem) return { error: "not found" };
      try {
        await store.delete(mem.id);
      } catch (e) {
        return {
          error: `delete failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return { ok: true, id: mem.id };
    },
  };
}

export interface RelatePieceHook {
  handleNewMemory(opts: {
    id: string;
    title: string;
    content: string;
    evidence?: string;
    origin: string;
    createdAt: string;
    category: string;
    siblingIds: string[];
  }): Promise<void>;
}

export function buildMemoryPromoteTool(
  store: MnemosyneStore,
  relatePiece?: RelatePieceHook
): CapabilityDefinition {
  return {
    name: "memory_promote",
    description:
      "Manually promote a short-term memory to long-term. No-op if already promoted.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id (full or short prefix)" },
      },
      required: ["id"],
    },
    handler: async (raw) => {
      const args = raw as unknown as MemoryIdArgs;
      if (!args.id) return { error: "id is required" };
      const mem = await resolveMemoryId(store, args.id);
      if (!mem) return { error: "not found" };
      if (mem.promoted_at) {
        return { ok: true, id: mem.id, already_promoted: true };
      }
      try {
        await store.promote(mem.id);
      } catch (e) {
        return {
          error: `promote failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      // Trigger async relate so promoted memory gets graph edges
      if (relatePiece) {
        relatePiece.handleNewMemory({
          id: mem.id,
          title: mem.title,
          content: mem.content,
          evidence: mem.evidence,
          origin: mem.origin_source ?? "user",
          createdAt: new Date(mem.created_at).toISOString(),
          category: mem.category,
          siblingIds: [],
        }).catch(() => {/* fire-and-forget */});
      }
      return { ok: true, id: mem.id };
    },
  };
}
