import neo4j, { Driver, Session } from "neo4j-driver";
import { promises as fs } from "fs";
import type { Memory } from "./types";

export interface Neo4jAdapterOptions {
  uri: string;
}

export class Neo4jAdapter {
  private driver?: Driver;

  constructor(private opts: Neo4jAdapterOptions) {}

  async connect(): Promise<void> {
    // NEO4J_AUTH=none — no credentials passed
    this.driver = neo4j.driver(this.opts.uri);
    await this.driver.verifyConnectivity();
  }

  async close(): Promise<void> {
    await this.driver?.close();
  }

  private session(): Session {
    if (!this.driver) throw new Error("Adapter not connected");
    return this.driver.session();
  }

  async applySchema(cypherFile: string): Promise<void> {
    const cypher = await fs.readFile(cypherFile, "utf-8");
    // Strip line comments before splitting (Cypher allows `// ...` lines but
    // splitting on `;` would otherwise leave dangling comment-only segments).
    const stripped = cypher
      .split("\n")
      .map((line) => {
        const i = line.indexOf("//");
        return i >= 0 ? line.slice(0, i) : line;
      })
      .join("\n");
    const statements = stripped.split(";").map((s) => s.trim()).filter(Boolean);
    const s = this.session();
    try {
      for (const stmt of statements) {
        await s.run(stmt);
      }
    } finally {
      await s.close();
    }
  }

  async upsertMemory(memory: Memory): Promise<void> {
    const s = this.session();
    try {
      await s.run(
        `MERGE (m:Memory {id: $id})
         SET m += $props`,
        {
          id: memory.id,
          props: {
            id: memory.id,
            category: memory.category,
            title: memory.title,
            content: memory.content,
            tags: memory.tags,
            project: memory.project,
            confidence: memory.confidence,
            reinforcements: memory.reinforcements,
            visibility: memory.visibility,
            pinned: memory.pinned,
            created_at: memory.created_at,
            last_accessed: memory.last_accessed,
            promoted_at: memory.promoted_at,
            source_session: memory.source_session,
            chroma_id: memory.id,
          },
        }
      );
    } finally {
      await s.close();
    }
  }

  async getMemory(id: string): Promise<Memory | null> {
    const s = this.session();
    try {
      const result = await s.run(
        `MATCH (m:Memory {id: $id}) RETURN m`,
        { id }
      );
      if (!result.records.length) return null;
      const props = result.records[0].get("m").properties;
      return this.propsToMemory(props);
    } finally {
      await s.close();
    }
  }

  async incrementReinforcements(id: string): Promise<void> {
    const s = this.session();
    try {
      await s.run(
        `MATCH (m:Memory {id: $id})
         SET m.reinforcements = m.reinforcements + 1,
             m.last_accessed = $now`,
        { id, now: Date.now() }
      );
    } finally {
      await s.close();
    }
  }

  async oneHopNeighbors(seedIds: string[]): Promise<Memory[]> {
    const s = this.session();
    try {
      const result = await s.run(
        `MATCH (seed:Memory) WHERE seed.id IN $seedIds
         MATCH (seed)-[r]-(neighbor:Memory)
         WHERE NOT neighbor.id IN $seedIds
         RETURN DISTINCT neighbor`,
        { seedIds }
      );
      return result.records.map((rec) => {
        const props = rec.get("neighbor").properties;
        return this.propsToMemory(props);
      });
    } finally {
      await s.close();
    }
  }

  async deleteMemory(id: string): Promise<void> {
    const s = this.session();
    try {
      await s.run(
        `MATCH (m:Memory {id: $id}) DETACH DELETE m`,
        { id }
      );
    } finally {
      await s.close();
    }
  }

  async markPromoted(id: string, promotedAt: number): Promise<void> {
    const s = this.session();
    try {
      await s.run(
        `MATCH (m:Memory {id: $id}) SET m.promoted_at = $at`,
        { id, at: promotedAt }
      );
    } finally {
      await s.close();
    }
  }

  async getContradictions(memoryId: string): Promise<string[]> {
    const s = this.session();
    try {
      const result = await s.run(
        `MATCH (m:Memory {id: $id})-[:CONTRADICTS]-(other:Memory)
         RETURN other.id AS id`,
        { id: memoryId }
      );
      return result.records.map((r) => r.get("id"));
    } finally {
      await s.close();
    }
  }

  /**
   * Create a bidirectional CONTRADICTS edge between two memories. Used by the
   * consolidator's conflict detector — both nodes stay in the graph (D6 keep-both)
   * and the retriever surfaces the conflict at query time.
   */
  async createContradictsEdge(aId: string, bId: string): Promise<void> {
    const s = this.session();
    try {
      await s.run(
        `MATCH (a:Memory {id: $aId}), (b:Memory {id: $bId})
         MERGE (a)-[r:CONTRADICTS {detected_at: $now}]->(b)
         MERGE (b)-[r2:CONTRADICTS {detected_at: $now}]->(a)`,
        { aId, bId, now: Date.now() }
      );
    } finally {
      await s.close();
    }
  }

  private propsToMemory(props: any): Memory {
    return {
      id: props.id,
      category: props.category,
      title: props.title,
      content: props.content,
      tags: props.tags,
      project: props.project,
      confidence: props.confidence?.toNumber?.() ?? props.confidence,
      reinforcements: props.reinforcements?.toNumber?.() ?? props.reinforcements,
      visibility: props.visibility,
      pinned: props.pinned,
      created_at: props.created_at?.toNumber?.() ?? props.created_at,
      last_accessed: props.last_accessed?.toNumber?.() ?? props.last_accessed,
      promoted_at: props.promoted_at?.toNumber?.() ?? props.promoted_at,
      source_session: props.source_session,
    };
  }
}
