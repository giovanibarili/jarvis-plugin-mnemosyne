// lib/match-snippet.ts
//
// Cheap lexical overlap snippet extractor — given a user query and a memory,
// pick the segment (sentence/line) of memory.content that best overlaps the
// query terms, and return that segment trimmed for chat-UI display.
//
// Why lexical and not embedding-based? We already have the embedding-derived
// similarity in `RetrievalHit.vectorSim`. The snippet is the *human-readable*
// counterpart — it answers "WHICH WORDS from my prompt connected to this
// memory?". TF-IDF or embedding subspace projection would be costlier and
// no more informative for the chat surface.
//
// Algorithm:
//   1. Tokenize both query and content into lowercase word-tokens, dropping
//      a small Portuguese+English stoplist + sub-3-char tokens.
//   2. Split content into candidate segments (lines first, sentences if a
//      line is too long).
//   3. Score each segment by count of distinct query tokens it contains.
//   4. Return the highest-scoring segment, trimmed/ellipsised, plus the
//      list of terms that matched.
//
// Falls back to memory.title when zero overlap exists (still surfaces *some*
// content so the user has context).

import type { Memory, MatchSnippet } from "./types.js";

// Stopwords are intentionally tiny — we strip the most common chat noise but
// leave domain words alone (e.g. "tool", "reset", "user" are useful signal,
// "the"/"de"/"a" aren't).
const STOPWORDS = new Set([
  // EN
  "the", "and", "for", "with", "that", "this", "from", "into", "have", "has",
  "was", "are", "but", "not", "you", "your", "can", "will", "would", "what",
  "how", "why", "does", "did", "all", "any", "use", "used",
  // PT
  "que", "uma", "uns", "umas", "dos", "das", "para", "com", "por", "como",
  "sobre", "isso", "esse", "essa", "este", "esta", "ele", "ela", "eles",
  "elas", "tem", "ter", "foi", "ser", "está", "esta", "mais", "menos",
  "também", "tambem", "mas", "ainda", "depois", "antes", "porque", "porém",
  "porem", "porqu", "pois", "muito", "pouco", "todo", "toda", "todos",
  "todas", "alguma", "algum", "alguns", "algumas", "qual", "quais", "quem",
  "onde", "quando", "isto", "aquilo", "nas", "nos", "num", "numa", "uns",
]);

const MIN_TOKEN_LEN = 3;
const MAX_SNIPPET_CHARS = 140;

/** Tokenize text into a deduplicated set of meaningful lowercase words. */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  // Split on anything that isn't a unicode letter/digit. Handles punctuation,
  // markdown, code-fence backticks, etc.
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/** Split content into candidate segments — lines preferred, sentences if a line is huge. */
function splitSegments(content: string): string[] {
  const segments: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length <= 200) {
      segments.push(trimmed);
    } else {
      // Long line — break on sentence enders.
      for (const sent of trimmed.split(/(?<=[.!?])\s+/)) {
        const s = sent.trim();
        if (s) segments.push(s);
      }
    }
  }
  return segments;
}

/** Trim a segment to MAX_SNIPPET_CHARS, centring on the first matched term. */
function trimAroundTerms(segment: string, matchedTerms: string[]): string {
  if (segment.length <= MAX_SNIPPET_CHARS) return segment;
  // Find earliest occurrence of any matched term.
  const lower = segment.toLowerCase();
  let earliest = -1;
  for (const term of matchedTerms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  if (earliest === -1) {
    return segment.slice(0, MAX_SNIPPET_CHARS - 1) + "…";
  }
  // Centre window around the term.
  const half = Math.floor(MAX_SNIPPET_CHARS / 2);
  const start = Math.max(0, earliest - half);
  const end = Math.min(segment.length, start + MAX_SNIPPET_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < segment.length ? "…" : "";
  return prefix + segment.slice(start, end).trim() + suffix;
}

/**
 * Compute the best overlap snippet between a query and a memory.
 *
 * Returns `undefined` when query is empty. When there's zero token overlap,
 * returns a snippet derived from the title so the UI never shows nothing.
 */
export function computeMatchSnippet(query: string, memory: Memory): MatchSnippet | undefined {
  if (!query || !query.trim()) return undefined;

  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return undefined;

  // Score every candidate segment in content.
  const segments = splitSegments(memory.content);
  let best: { segment: string; matched: Set<string>; score: number } | null = null;
  for (const segment of segments) {
    const segTokens = tokenize(segment);
    const matched = new Set<string>();
    for (const qt of queryTokens) {
      if (segTokens.has(qt)) matched.add(qt);
    }
    if (matched.size === 0) continue;
    if (!best || matched.size > best.score) {
      best = { segment, matched, score: matched.size };
    }
  }

  if (best) {
    const matchedTerms = Array.from(best.matched);
    return {
      text: trimAroundTerms(best.segment, matchedTerms),
      matchedTerms,
      source: "content",
    };
  }

  // No content overlap — try title before giving up.
  const titleTokens = tokenize(memory.title);
  const titleMatched = new Set<string>();
  for (const qt of queryTokens) {
    if (titleTokens.has(qt)) titleMatched.add(qt);
  }
  if (titleMatched.size > 0) {
    return {
      text: memory.title,
      matchedTerms: Array.from(titleMatched),
      source: "title",
    };
  }

  // Zero lexical overlap. The vector match was purely semantic (embeddings
  // captured a synonym/concept the lexical layer can't see). Return the title
  // with empty matchedTerms so the UI can label this honestly.
  return {
    text: memory.title,
    matchedTerms: [],
    source: "title",
  };
}
