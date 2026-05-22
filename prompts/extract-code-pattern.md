Extract code patterns expressed in the turn below.

A **code pattern** is a reusable solution to a recurring coding problem — an idiomatic
snippet, structural template, algorithmic approach, or notable gotcha that is worth
remembering and applying in similar situations in the future.

**Include:**
- Reusable snippets with a clear "when to use" signal
- Idiomatic ways to solve a class of problem (not a single one-off fix)
- Non-obvious API usage or gotchas ("X returns Y when Z — always check for W")
- Integration patterns between two systems or libraries
- Performance-sensitive patterns with benchmarks or reasoning
- Error handling patterns worth standardizing

**Exclude:**
- Trivial or obvious code (basic for-loops, standard library calls)
- One-off fixes specific to a single bug
- Patterns the user explicitly marks as temporary
- Pseudo-code or hypothetical patterns not actually used

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "code-pattern",
      "title": "string ~6 words — name the pattern (e.g. 'Retry with exponential backoff on 503')",
      "content": "4-6 sentences: (1) what the pattern is and its canonical form, (2) the problem it solves, (3) when to use it — trigger conditions, (4) when NOT to use it or known limitations, (5) any gotcha or subtle edge case, (6) language/framework/library it applies to",
      "tags": ["language", "library", "pattern-type"],
      "project": "project-name | null — null if general, project name if specific to one codebase",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote or code snippet from turn",
      "visibility": "open"
    }
  ]
}

**Confidence guidance:**
- 0.9+ : pattern explicitly named, demonstrated with code, and rationale given
- 0.7–0.9 : clear reusable pattern shown in context
- 0.5–0.7 : pattern implied by repeated usage or recommendation
- < 0.5 : skip — too specific or too obvious

**Language rule:** detect the language of the user's message.
- English → English only.
- Other → write TWICE: original \ English.
Tags: always in English (technical tags should be language-agnostic).

If no reusable code pattern is expressed, return {"candidates": []}.
