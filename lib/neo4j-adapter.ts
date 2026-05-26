import neo4j, { Driver, Session } from "neo4j-driver";
import { promises as fs } from "fs";
import type {
  Memory,
  Workflow,
  WorkflowStep,
  RelatedMemoryRef,
  MemoryNeighborhood,
  ExpandedChild,
  RelateRelation,
} from "./types";

export interface Neo4jAdapterOptions {
  uri: string;
}

/**
 * Thrown when an operation is attempted while the adapter is not connected.
 * The plugin's runtime guards (store / retriever / consolidator) catch this
 * and treat it as "graph degraded" — they fall back to vector-only behaviour
 * instead of propagating the failure to the user.
 */
export class Neo4jNotReadyError extends Error {
  constructor(public reason: string = "Adapter not connected") {
    super(reason);
    this.name = "Neo4jNotReadyError";
  }
}

export class Neo4jAdapter {
  private driver?: Driver;

  constructor(private opts: Neo4jAdapterOptions) {}

  /**
   * Connect with a hard timeout. The Neo4j driver's `verifyConnectivity()`
   * may hang indefinitely when the server is reachable on TCP but not
   * responding to Bolt (e.g. Neo4j still booting inside the container).
   * Wrapping in Promise.race prevents the whole bootstrap from blocking.
   *
   * @param timeoutMs default 2000 — fail-soft is preferred over slow boot.
   */
  async connect(timeoutMs: number = 2000): Promise<void> {
    // NEO4J_AUTH=none — no credentials passed
    const drv = neo4j.driver(this.opts.uri, undefined, {
      connectionTimeout: timeoutMs,
      connectionAcquisitionTimeout: timeoutMs,
    });
    try {
      await Promise.race([
        drv.verifyConnectivity(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Neo4jNotReadyError(`verifyConnectivity timeout after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
      this.driver = drv;
    } catch (e) {
      // Avoid leaking the half-open driver if verifyConnectivity rejected
      // before we stashed it. Best-effort close — ignore errors.
      try { await drv.close(); } catch { /* noop */ }
      this.driver = undefined;
      if (e instanceof Neo4jNotReadyError) throw e;
      throw new Neo4jNotReadyError(String((e as Error)?.message ?? e));
    }
  }

  /** True when verifyConnectivity succeeded and the driver is live. */
  isReady(): boolean {
    return this.driver !== undefined;
  }

  async close(): Promise<void> {
    await this.driver?.close();
    this.driver = undefined;
  }

  private session(): Session {
    if (!this.driver) throw new Neo4jNotReadyError();
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
    score: number,
    reason?: string,
    evidence?: string
  ): Promise<void> {
    const s = this.session();
    try {
      await s.run(
        `MATCH (a:Memory {id: $aId}), (b:Memory {id: $bId})
         MERGE (a)-[r:RELATES_TO {relation: $relation}]->(b)
         SET r.score      = $score,
             r.source     = 'semantic',
             r.created_at = $now,
             r.reason     = $reason,
             r.evidence   = $evidence`,
        { aId, bId, relation, score, now: Date.now(), reason: reason ?? null, evidence: evidence ?? null }
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
      reason?: string;
      evidence?: string;
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
                r.reason AS reason,
                r.evidence AS evidence,
                CASE WHEN startNode(r).id = $id THEN 'outgoing' ELSE 'incoming' END AS direction`,
        { id }
      );
      return result.records.map((rec) => ({
        targetId: rec.get("targetId"),
        relation: rec.get("relation"),
        score: rec.get("score")?.toNumber?.() ?? rec.get("score"),
        reason: rec.get("reason") ?? undefined,
        evidence: rec.get("evidence") ?? undefined,
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

  // ---------------------------------------------------------------------------
  // v1.3 Graph Retrieval — runQuery helper + neighborhood expansion
  // ---------------------------------------------------------------------------

  /**
   * Internal helper that runs a Cypher query and returns plain JS objects
   * (one per record). Each row is a map from RETURN alias → field value.
   * Used by the v1.3 neighborhood methods. Stubbed in unit tests.
   */
  private async runQuery(
    cypher: string,
    params: Record<string, unknown> = {}
  ): Promise<Array<Record<string, unknown>>> {
    const s = this.session();
    try {
      const result = await s.run(cypher, params);
      return result.records.map((rec) => {
        const obj: Record<string, unknown> = {};
        for (const key of rec.keys as string[]) {
          obj[key] = rec.get(key);
        }
        return obj;
      });
    } finally {
      await s.close();
    }
  }

  /**
   * Batch-fetch one-hop neighborhoods for a list of memory ids. For each root:
   *   - parents:  memories that point TO root via RELATES_TO (incoming)
   *   - children: memories that root points TO via RELATES_TO (outgoing)
   *
   * The `childCount` on a parent counts how many OTHER memories that parent
   * relates to (excluding root). The `childCount` on a child counts how many
   * grandchildren that child relates to (excluding root). Used by the retriever
   * to decorate hits with neighborhood context.
   */
  async getNeighborhoodBatch(
    ids: string[]
  ): Promise<Map<string, MemoryNeighborhood>> {
    if (ids.length === 0) return new Map();
    const toNum = (v: unknown): number => {
      if (v === null || v === undefined) return 0;
      if (typeof v === "object" && v !== null && "low" in v)
        return (v as { low: number }).low ?? 0;
      return typeof v === "number" ? v : 0;
    };
    const rows = await this.runQuery(
      `
      UNWIND $ids AS rootId
      MATCH (root:Memory {id: rootId})
      OPTIONAL MATCH (parent:Memory)-[rp:RELATES_TO]->(root)
      OPTIONAL MATCH (parent)<-[:RELATES_TO]-(parentChild:Memory)
        WHERE parentChild.id <> root.id
      OPTIONAL MATCH (root)-[rc:RELATES_TO]->(child:Memory)
      OPTIONAL MATCH (child)-[:RELATES_TO]->(grandchild:Memory)
        WHERE grandchild.id <> root.id
      RETURN
        rootId,
        parent.id AS parentId, parent.title AS parentTitle,
        parent.category AS parentCategory, rp.relation AS parentRelation, rp.reason AS parentReason,
        count(DISTINCT parentChild) AS parentChildCount,
        child.id AS childId, child.title AS childTitle,
        child.category AS childCategory, rc.relation AS childRelation, rc.reason AS childReason,
        count(DISTINCT grandchild) AS childGrandchildCount
    `,
      { ids }
    );

    const result = new Map<string, MemoryNeighborhood>();
    for (const row of rows) {
      const rootId = row.rootId as string;
      if (!result.has(rootId))
        result.set(rootId, { parents: [], children: [] });
      const n = result.get(rootId)!;

      if (row.parentId) {
        if (!n.parents.some((p) => p.id === row.parentId)) {
          n.parents.push({
            id: row.parentId as string,
            title: (row.parentTitle as string) ?? "",
            category: (row.parentCategory as string) ?? "",
            relation: ((row.parentRelation as string) ??
              "relates_to") as RelateRelation,
            direction: "incoming",
            childCount: toNum(row.parentChildCount),
            reason: (row.parentReason as string) ?? undefined,
          });
        }
      }
      if (row.childId) {
        if (!n.children.some((c) => c.id === row.childId)) {
          n.children.push({
            id: row.childId as string,
            title: (row.childTitle as string) ?? "",
            category: (row.childCategory as string) ?? "",
            relation: ((row.childRelation as string) ??
              "relates_to") as RelateRelation,
            direction: "outgoing",
            childCount: toNum(row.childGrandchildCount),
            reason: (row.childReason as string) ?? undefined,
          });
        }
      }
    }
    return result;
  }

  /**
   * Single-memory neighborhood expansion with grandchildren. Returns the same
   * parents/children as `getNeighborhoodBatch` plus a `childrenExpanded` array
   * where each child carries its own `grandchildren` (excluding the root).
   * Used by the panel to render the "drill into a memory" view.
   */
  async getNeighborhoodOne(
    id: string
  ): Promise<MemoryNeighborhood & { childrenExpanded: ExpandedChild[] }> {
    const rows = await this.runQuery(
      `
      MATCH (root:Memory {id: $id})
      OPTIONAL MATCH (parent:Memory)-[rp:RELATES_TO]->(root)
      OPTIONAL MATCH (root)-[rc:RELATES_TO]->(child:Memory)
      OPTIONAL MATCH (child)-[rg:RELATES_TO]->(grandchild:Memory)
        WHERE grandchild.id <> root.id
      RETURN
        parent.id AS parentId, parent.title AS parentTitle,
        parent.category AS parentCategory, rp.relation AS parentRelation,
        child.id AS childId, child.title AS childTitle,
        child.category AS childCategory, rc.relation AS childRelation,
        grandchild.id AS grandchildId, grandchild.title AS grandchildTitle,
        grandchild.category AS grandchildCategory, rg.relation AS grandchildRelation
    `,
      { id }
    );

    const parents: RelatedMemoryRef[] = [];
    const childMap = new Map<string, ExpandedChild>();

    for (const row of rows) {
      if (row.parentId && !parents.some((p) => p.id === row.parentId)) {
        parents.push({
          id: row.parentId as string,
          title: (row.parentTitle as string) ?? "",
          category: (row.parentCategory as string) ?? "",
          relation: ((row.parentRelation as string) ??
            "relates_to") as RelateRelation,
          direction: "incoming",
          childCount: 0,
        });
      }
      if (row.childId) {
        if (!childMap.has(row.childId as string)) {
          childMap.set(row.childId as string, {
            id: row.childId as string,
            title: (row.childTitle as string) ?? "",
            category: (row.childCategory as string) ?? "",
            relation: ((row.childRelation as string) ??
              "relates_to") as RelateRelation,
            direction: "outgoing",
            childCount: 0,
            grandchildren: [],
          });
        }
        if (row.grandchildId) {
          const child = childMap.get(row.childId as string)!;
          if (!child.grandchildren.some((g) => g.id === row.grandchildId)) {
            child.grandchildren.push({
              id: row.grandchildId as string,
              title: (row.grandchildTitle as string) ?? "",
              category: (row.grandchildCategory as string) ?? "",
              relation: ((row.grandchildRelation as string) ??
                "relates_to") as RelateRelation,
              direction: "outgoing",
              childCount: 0,
            });
          }
        }
      }
    }

    const childrenExpanded = Array.from(childMap.values()).map((c) => ({
      ...c,
      childCount: c.grandchildren.length,
    }));
    const children: RelatedMemoryRef[] = childrenExpanded.map(
      ({ grandchildren: _, ...rest }) => rest
    );
    return { parents, children, childrenExpanded };
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
