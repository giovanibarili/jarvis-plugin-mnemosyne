import type { LLMClient } from "../extractor";
import type { EncodedMemory } from "./encoder-v12";

// Minimal pino-compatible logger interface — avoids importing pino type directly
interface PinoLike {
  warn(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

/**
 * EnrichV12 — semantic enrichment step between classify and store.
 *
 * Problem: MiniLM embeds the full memory text as a semantic centroid.
 * Technically-worded memories (e.g. "NEVER use force-settlement on sa-authorizer-adapter")
 * produce vectors far from domain-generic queries (e.g. "settlement") because the
 * centroid is dominated by "forbidden endpoint" semantics, not "financial settlement".
 *
 * Solution: after classify produces a draft, enrich appends 2-5 domain synonyms and
 * related terms to the content — without changing the meaning — so the MiniLM vector
 * covers more of the relevant semantic space.
 *
 * Example:
 *   before: "PROIBIDO: POST /api/force-settlement/..."
 *   after:  "PROIBIDO: POST /api/force-settlement/... [domain: liquidação financeira,
 *            reprocessamento, settlement bancário, adapter SAA]"
 *
 * Cost: Haiku, ~80–120 tokens per memory. Optional — if disabled, pipeline is unchanged.
 */
export class EnrichV12 {
  private lastCostUsd = 0;

  constructor(
    private readonly llm: LLMClient,
    private readonly model: string,
    private readonly logger?: PinoLike,
  ) {}

  get cost(): number {
    return this.lastCostUsd;
  }

  async enrich(draft: EncodedMemory): Promise<EncodedMemory> {
    const prompt = buildPrompt(draft);

    try {
      const resp = await this.llm.call({
        system: "You are a semantic enrichment assistant. Output only the requested JSON.",
        user: prompt,
        maxTokens: 256,
        model: this.model,
      });

      this.lastCostUsd = resp.costUsd ?? 0;

      const raw = resp.text?.trim() ?? "";
      const json = extractJson(raw);
      if (!json) {
        this.logger?.warn({ title: draft.title }, "EnrichV12: no valid JSON, skipping enrich");
        return draft;
      }

      const parsed = JSON.parse(json) as { synonyms?: string[]; related_terms?: string[] };
      const terms = [...(parsed.synonyms ?? []), ...(parsed.related_terms ?? [])].filter(Boolean);

      if (terms.length === 0) return draft;

      // Append domain terms as a bracketed annotation — invisible to the user
      // but part of the MiniLM embedding input.
      const enriched = `${draft.content}\n[domain: ${terms.join(", ")}]`;

      this.logger?.debug(
        { title: draft.title, terms },
        "EnrichV12: appended domain terms to content",
      );

      return { ...draft, content: enriched };
    } catch (err) {
      this.logger?.warn({ err, title: draft.title }, "EnrichV12: failed, using original draft");
      return draft;
    }
  }
}

function buildPrompt(draft: EncodedMemory): string {
  return `You are enriching a memory for semantic search.
The memory will be embedded by MiniLM. Add domain synonyms so queries using
related terms (e.g. a high-level concept) can match this specific technical fact.

Memory:
  title: ${draft.title}
  category: ${draft.category}
  content: ${draft.content}
  tags: ${(draft.tags ?? []).join(", ")}

Task: Output a JSON object with:
  "synonyms": 2–4 domain synonyms for the core concept (e.g. "liquidação financeira" for "force-settlement")
  "related_terms": 1–3 related technical terms that someone might query when looking for this fact

Rules:
- Only output the JSON object, nothing else.
- Synonyms must be in the SAME LANGUAGE as the content.
- Do NOT restate what's already in the title or tags.
- Do NOT add noise — only terms a real user would search for.

Example output:
{"synonyms": ["liquidação financeira", "settlement bancário"], "related_terms": ["reprocessamento SAA", "endpoint proibido"]}`;
}

function extractJson(text: string): string | null {
  // Try to extract the first {...} block
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}
