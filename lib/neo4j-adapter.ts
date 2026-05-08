import neo4j, { Driver, Session } from "neo4j-driver";
import { promises as fs } from "fs";
import type { Memory, Workflow, WorkflowStep } from "./types";

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
   * Create a directed RELATES_TO edge from memory A to memory B.
   * Used by the SemanticRelationLinker (Pass 3) to wire non-trivial
   * semantic relations discovered at write time.
   *
   * The edge carries:
   *   - relation: semantic label ("reinforces" | "extends" | "example-of" | "depends-on")
   *   - score:    cosine similarity that triggered the link (0–1)
   *   - source:   always "semantic" so the edge can be filtered/audited
   *   - created_at: epoch ms
   *
   * MERGE on (aId, bId, relation) — re-running on the same pair only
   * updates score/created_at, never duplicates the edge.
   */
  async createRelatesToEdge(
    aId: string,
    bId: string,
    relation: string,
    score: number
  ): Promise<void> {
    const s = this.session();
    try {
      await s.run(
        `MATCH (a:Memory {id: $aId}), (b:Memory {id: $bId})
         MERGE (a)-[r:RELATES_TO {relation: $relation}]->(b)
         SET r.score      = $score,
             r.source     = 'semantic',
             r.created_at = $now`,
        { aId, bId, relation, score, now: Date.now() }
      );
    } finally {
      await s.close();
    }
  }

  /**
   * Return all RELATES_TO edges for a given memory (outgoing + incoming).
   * Used by the panel renderer and future retriever graph-hop expansion.
   */
  async getRelations(
    id: string
  ): Promise<
    Array<{
      targetId: string;
      relation: string;
      score: number;
      direction: "outgoing" | "incoming";
    }>
  > {
    const s = this.session();
    try {
      const result = await s.run(
        `MATCH (m:Memory {id: $id})-[r:RELATES_TO]-(other:Memory)
         RETURN other.id AS targetId,
                r.relation AS relation,
                r.score AS score,
                CASE WHEN startNode(r).id = $id THEN 'outgoing' ELSE 'incoming' END AS direction`,
        { id }
      );
      return result.records.map((rec) => ({
        targetId: rec.get("targetId"),
        relation: rec.get("relation"),
        score: rec.get("score")?.toNumber?.() ?? rec.get("score"),
        direction: rec.get("direction") as "outgoing" | "incoming",
      }));
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

  // ---------------------------------------------------------------------------
  // Workflows (Task 8)
  //
  // Schema:
  //   (Workflow {id, name, description, trigger, outcome, confidence,
  //              reinforcements, created_at, last_used})
  //   (Step {id, action, tool, guard, required, confirms_required, order})
  //   (Workflow)-[:STARTS_AT]->(Step)
  //   (Workflow)-[:ENDS_AT]->(Step)
  //   (Step)-[:NEXT {order, probability}]->(Step)
  //   (Workflow)-[:APPLIES_TO]->(Project {name})
  // ---------------------------------------------------------------------------

  async upsertWorkflow(wf: Workflow): Promise<void> {
    const s = this.session();
    try {
      await s.executeWrite(async (tx) => {
        await tx.run(
          `MERGE (w:Workflow {id: $id})
           SET w += $props`,
          {
            id: wf.id,
            props: {
              name: wf.name,
              description: wf.description,
              trigger: wf.trigger,
              outcome: wf.outcome,
              confidence: wf.confidence,
              reinforcements: wf.reinforcements,
              created_at: wf.created_at,
              last_used: wf.last_used,
            },
          }
        );

        // Steps
        for (const step of wf.steps) {
          await tx.run(
            `MERGE (s:Step {id: $id})
             SET s += $props`,
            {
              id: step.id,
              props: {
                action: step.action,
                tool: step.tool,
                guard: step.guard,
                required: step.required,
                confirms_required: step.confirms_required,
                order: step.order,
              },
            }
          );
        }

        // STARTS_AT, ENDS_AT, NEXT
        const sorted = [...wf.steps].sort((a, b) => a.order - b.order);
        if (sorted.length) {
          await tx.run(
            `MATCH (w:Workflow {id: $wfId}), (s:Step {id: $sId})
             MERGE (w)-[:STARTS_AT]->(s)`,
            { wfId: wf.id, sId: sorted[0].id }
          );
          await tx.run(
            `MATCH (w:Workflow {id: $wfId}), (s:Step {id: $sId})
             MERGE (w)-[:ENDS_AT]->(s)`,
            { wfId: wf.id, sId: sorted[sorted.length - 1].id }
          );
        }
        for (let i = 0; i < sorted.length - 1; i++) {
          await tx.run(
            `MATCH (a:Step {id: $aId}), (b:Step {id: $bId})
             MERGE (a)-[r:NEXT]->(b)
             SET r.order = $order, r.probability = 1.0`,
            { aId: sorted[i].id, bId: sorted[i + 1].id, order: i + 1 }
          );
        }

        // APPLIES_TO project
        if (wf.applies_to_project) {
          await tx.run(
            `MERGE (p:Project {name: $name})
             WITH p
             MATCH (w:Workflow {id: $wfId})
             MERGE (w)-[:APPLIES_TO]->(p)`,
            { name: wf.applies_to_project, wfId: wf.id }
          );
        }
      });
    } finally {
      await s.close();
    }
  }

  async getWorkflow(idOrName: string): Promise<Workflow | null> {
    const s = this.session();
    try {
      const result = await s.run(
        `MATCH (w:Workflow) WHERE w.id = $key OR w.name = $key
         OPTIONAL MATCH (w)-[:STARTS_AT]->(start:Step)
         OPTIONAL MATCH path = (start)-[:NEXT*0..]->(step:Step)
         OPTIONAL MATCH (w)-[:APPLIES_TO]->(p:Project)
         RETURN w, collect(DISTINCT step) AS steps, p.name AS project`,
        { key: idOrName }
      );
      if (!result.records.length) return null;
      const rec = result.records[0];
      const wNode = rec.get("w");
      if (!wNode) return null;
      const wProps = wNode.properties;
      const stepsRaw = (rec.get("steps") ?? []).filter(
        (n: any) => n != null
      );
      const steps: WorkflowStep[] = stepsRaw
        .map((n: any) => {
          const p = n.properties;
          return {
            id: p.id,
            order: p.order?.toNumber?.() ?? p.order,
            action: p.action,
            tool: p.tool,
            guard: p.guard,
            required: p.required,
            confirms_required: p.confirms_required ?? false,
          } as WorkflowStep;
        })
        .sort((a: WorkflowStep, b: WorkflowStep) => a.order - b.order);

      return {
        id: wProps.id,
        name: wProps.name,
        description: wProps.description ?? "",
        trigger: wProps.trigger,
        outcome: wProps.outcome,
        applies_to_project: rec.get("project") ?? null,
        steps,
        branches: [],
        confidence: wProps.confidence?.toNumber?.() ?? wProps.confidence,
        reinforcements:
          wProps.reinforcements?.toNumber?.() ?? wProps.reinforcements,
        created_at: wProps.created_at?.toNumber?.() ?? wProps.created_at,
        last_used: wProps.last_used?.toNumber?.() ?? wProps.last_used,
      };
    } finally {
      await s.close();
    }
  }

  async listWorkflows(filter?: { project?: string }): Promise<Workflow[]> {
    const s = this.session();
    try {
      let cypher = `MATCH (w:Workflow)`;
      if (filter?.project) {
        cypher += ` MATCH (w)-[:APPLIES_TO]->(:Project {name: $project})`;
      }
      cypher += ` RETURN w.id AS id ORDER BY w.last_used DESC`;
      const result = await s.run(cypher, { project: filter?.project ?? null });
      const workflows: Workflow[] = [];
      for (const rec of result.records) {
        const wf = await this.getWorkflow(rec.get("id"));
        if (wf) workflows.push(wf);
      }
      return workflows;
    } finally {
      await s.close();
    }
  }
}
