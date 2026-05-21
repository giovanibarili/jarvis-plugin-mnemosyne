import { ChromaClient, Collection, IEmbeddingFunction, DefaultEmbeddingFunction } from "chromadb";
import type { Workflow } from "./types.js";

export type Layer = "short" | "long";

export interface WorkflowQueryHit {
  id: string;
  distance: number;
  content: string;
  metadata: Record<string, unknown>;
}

export interface ChromaAdapterOptions {
  host: string;
  port: number;
  embeddingModel: "minilm";  // OpenAI/Voyage commented below for future
}

export interface UpsertInput {
  id: string;
  content: string;
  metadata: Record<string, any>;
}

export interface QueryHit {
  id: string;
  content: string;
  distance: number;
  metadata: Record<string, any>;
}

// Embedding model — currently all-MiniLM-L6-v2 (default Chroma, local, free)
//
// To swap:
// - Change embeddingModel in config.json
// - Run scripts/rebuild-indexes.sh (vectors from different models are not comparable)
//
// Pre-wired alternatives (uncomment to use):
//   case "openai-small":
//     return new OpenAIEmbeddingFunction({
//       openai_api_key: process.env.OPENAI_API_KEY!,
//       openai_model: "text-embedding-3-small",
//     });
//
//   case "openai-large":
//     return new OpenAIEmbeddingFunction({
//       openai_api_key: process.env.OPENAI_API_KEY!,
//       openai_model: "text-embedding-3-large",
//     });
//
//   case "voyage":
//     return new VoyageEmbeddingFunction({
//       api_key: process.env.VOYAGE_API_KEY!,
//       model_name: "voyage-3",
//     });

function getEmbeddingFunction(model: string): IEmbeddingFunction {
  switch (model) {
    case "minilm":
      return new DefaultEmbeddingFunction();
    default:
      throw new Error(`Unknown embedding model: ${model}`);
  }
}

export class ChromaAdapter {
  private client: ChromaClient;
  private embedFn: IEmbeddingFunction;
  private shortColl?: Collection;
  private longColl?: Collection;
  private workflowColl?: Collection;

  constructor(opts: ChromaAdapterOptions) {
    this.client = new ChromaClient({ path: `http://${opts.host}:${opts.port}` });
    this.embedFn = getEmbeddingFunction(opts.embeddingModel);
  }

  async init(): Promise<void> {
    this.shortColl = await this.client.getOrCreateCollection({
      name: "mnemosyne_short",
      embeddingFunction: this.embedFn,
    });
    this.longColl = await this.client.getOrCreateCollection({
      name: "mnemosyne_long",
      embeddingFunction: this.embedFn,
    });
  }

  private getCollection(layer: Layer): Collection {
    const c = layer === "short" ? this.shortColl : this.longColl;
    if (!c) throw new Error("ChromaAdapter not initialized; call init()");
    return c;
  }

  async upsert(layer: Layer, input: UpsertInput): Promise<void> {
    await this.getCollection(layer).upsert({
      ids: [input.id],
      documents: [input.content],
      metadatas: [input.metadata],
    });
  }

  async query(layer: Layer, queryText: string, k: number, where?: Record<string, any>): Promise<QueryHit[]> {
    const result = await this.getCollection(layer).query({
      queryTexts: [queryText],
      nResults: k,
      where,
    });
    const hits: QueryHit[] = [];
    const ids = result.ids?.[0] ?? [];
    for (let i = 0; i < ids.length; i++) {
      hits.push({
        id: ids[i],
        content: result.documents?.[0]?.[i] ?? "",
        distance: result.distances?.[0]?.[i] ?? 0,
        metadata: (result.metadatas?.[0]?.[i] ?? {}) as Record<string, any>,
      });
    }
    return hits;
  }

  async delete(layer: Layer, id: string): Promise<void> {
    await this.getCollection(layer).delete({ ids: [id] });
  }

  async move(fromLayer: Layer, toLayer: Layer, id: string): Promise<void> {
    const result = await this.getCollection(fromLayer).get({ ids: [id] });
    if (!result.ids.length) return;
    await this.upsert(toLayer, {
      id,
      content: result.documents?.[0] ?? "",
      metadata: (result.metadatas?.[0] ?? {}) as Record<string, any>,
    });
    await this.delete(fromLayer, id);
  }

  async count(layer: Layer): Promise<number> {
    return await this.getCollection(layer).count();
  }

  private async getWorkflowCollection(): Promise<Collection> {
    if (!this.workflowColl) {
      this.workflowColl = await this.client.getOrCreateCollection({
        name: "mnemosyne_workflows",
        embeddingFunction: this.embedFn,
        metadata: { "hnsw:space": "cosine" },
      });
    }
    return this.workflowColl;
  }

  async upsertWorkflow(wf: Workflow): Promise<void> {
    const coll = await this.getWorkflowCollection();
    const stepSummary = wf.steps.map((s, i) => `${i + 1}. ${s.action}`).join("; ");
    const content = [wf.name, wf.description, wf.trigger, wf.outcome, stepSummary]
      .filter(Boolean).join(" | ");
    await coll.upsert({
      ids: [wf.id],
      documents: [content],
      metadatas: [{
        name: wf.name,
        trigger: wf.trigger ?? "",
        outcome: wf.outcome ?? "",
        confidence: wf.confidence,
        reinforcements: wf.reinforcements,
        applies_to_project: wf.applies_to_project ?? "",
        step_count: wf.steps.length,
      }],
    });
  }

  async queryWorkflows(queryText: string, k: number): Promise<WorkflowQueryHit[]> {
    const coll = await this.getWorkflowCollection();
    const result = await coll.query({ queryTexts: [queryText], nResults: k });
    const ids = result.ids[0] ?? [];
    const distances = result.distances?.[0] ?? [];
    const documents = result.documents?.[0] ?? [];
    const metadatas = result.metadatas?.[0] ?? [];
    return ids.map((id, i) => ({
      id,
      distance: distances[i] ?? 1,
      content: (documents[i] as string) ?? "",
      metadata: (metadatas[i] as Record<string, unknown>) ?? {},
    }));
  }
}
