import type { Neo4jAdapter } from "./neo4j-adapter.js";
import type { MemoryNeighborhood, ExpandedChild, RelatedMemoryRef } from "./types.js";

export interface GraphNeighborhoodConfig {
  maxParents: number;
  maxChildren: number;
}

const DEFAULTS: GraphNeighborhoodConfig = { maxParents: 10, maxChildren: 20 };

export interface EnrichedNeighborhood extends MemoryNeighborhood {
  childrenExpanded: ExpandedChild[];
}

export class GraphNeighborhoodService {
  private readonly cfg: GraphNeighborhoodConfig;

  constructor(
    private readonly neo4j: Pick<Neo4jAdapter, "getNeighborhoodBatch" | "getNeighborhoodOne">,
    cfg: Partial<GraphNeighborhoodConfig> = {},
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  async enrichBatch(ids: string[]): Promise<Map<string, MemoryNeighborhood>> {
    if (ids.length === 0) return new Map();
    const raw = await this.neo4j.getNeighborhoodBatch(ids);
    const result = new Map<string, MemoryNeighborhood>();
    for (const [id, n] of raw) {
      result.set(id, {
        parents: n.parents.slice(0, this.cfg.maxParents),
        children: n.children.slice(0, this.cfg.maxChildren),
      });
    }
    return result;
  }

  async enrichOne(id: string): Promise<EnrichedNeighborhood> {
    const raw = await this.neo4j.getNeighborhoodOne(id);
    return {
      parents: raw.parents.slice(0, this.cfg.maxParents),
      children: raw.children.slice(0, this.cfg.maxChildren),
      childrenExpanded: raw.childrenExpanded.slice(0, this.cfg.maxChildren),
    };
  }
}
