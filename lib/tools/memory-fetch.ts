import type { CapabilityDefinition } from "@jarvis/core";
import type { GraphNeighborhoodService, EnrichedNeighborhood } from "../graph-neighborhood.js";

/**
 * Minimal store interface — only what memory_fetch needs.
 *
 * Decoupled from MnemosyneStore / MarkdownStore so the tool stays easy to test
 * with a hand-rolled mock and stays insensitive to refactors that rename
 * `.read` / `.get`. The pieces/index.ts wiring adapts the real store to this
 * shape (`{ get: (id) => store.markdownStore.read(id) }`).
 */
interface MemoryStore {
  get(id: string): Promise<{
    id: string;
    title: string;
    content: string;
    category: string;
    confidence: number;
    evidence?: string;
  } | null>;
}

export function buildMemoryFetchTool(
  store: MemoryStore,
  graphSvc: Pick<GraphNeighborhoodService, "enrichOne">,
): CapabilityDefinition {
  return {
    name: "memory_fetch",
    description: [
      "Fetch a memory by ID with its full relational neighborhood (parents, children, grandchildren).",
      "",
      "Use this during thinking whenever:",
      "- The injected context or memory_search results mention a related memory worth exploring",
      "- You see a parent/child relation (↑/↓) in the injection block and want to follow the chain",
      "- You need the full content + evidence of a specific memory before reasoning about it",
      "- You want to understand why a decision was made (evidence field) before building on it",
      "",
      "Call during the thinking phase — not just reactively. Proactively fetch memories that seem",
      "relevant to the current task even if not explicitly referenced by the user.",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The memory ID to fetch (e.g. the id shown in context annotations)",
        },
      },
      required: ["id"],
    },
    handler: async (raw) => {
      const args = raw as unknown as { id: string };
      if (!args.id || typeof args.id !== "string") {
        return `Memory "${String(args.id)}" not found.`;
      }
      const memory = await store.get(args.id);
      if (!memory) return `Memory "${args.id}" not found.`;

      const n = await graphSvc.enrichOne(args.id);
      return formatMemoryWithNeighborhood(memory, n);
    },
  };
}

function formatMemoryWithNeighborhood(
  memory: {
    id: string;
    title: string;
    content: string;
    category: string;
    confidence: number;
    evidence?: string;
  },
  n: EnrichedNeighborhood,
): string {
  const lines: string[] = [
    `**${memory.id}** [${memory.category}] — "${memory.title}"`,
    `> ${memory.content}`,
  ];
  if (memory.evidence) {
    lines.push(`  evidence (accumulated): "${memory.evidence}"`);
  }
  lines.push("");

  for (const p of n.parents) {
    lines.push(`  ↑ ${p.id} [${p.category}] "${p.title}" — ${p.relation}`);
  }

  for (const c of n.childrenExpanded) {
    lines.push(`  ↓ ${c.id} [${c.category}] "${c.title}" — ${c.relation}`);
    for (const g of c.grandchildren) {
      lines.push(`      → ${g.id} [${g.category}] "${g.title}" — ${g.relation}`);
    }
    if (c.grandchildren.length === 0) {
      lines.push(`      (no children)`);
    }
  }

  const hasRelations = n.parents.length > 0 || n.childrenExpanded.length > 0;
  if (hasRelations) {
    lines.push("");
    lines.push("_Use memory_fetch(id) to continue exploring._");
  }

  return lines.join("\n");
}
