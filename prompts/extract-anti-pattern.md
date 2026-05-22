Extract anti-patterns expressed in the turn below.

An **anti-pattern** is an approach, practice, tool usage, or design choice that is
explicitly called out as harmful, fragile, misleading, or wrong — with a stated reason
or observed negative consequence. It must be presented as something to actively avoid,
not merely a less-preferred option.

**Include:**
- Explicit rejections: "never do X", "X causes Y problem", "X is wrong because…"
- Documented failure modes: "we tried X and it caused Y"
- Security or data-safety violations
- Performance traps with observed or predicted impact
- Common mistakes in a library/API that produce subtle bugs

**Exclude:**
- Merely less-preferred options without a stated harm
- Preferences framed positively (extract as preference instead)
- Hypothetical anti-patterns without concrete signal of harm
- One-off mistakes not worth generalizing

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "anti-pattern",
      "title": "string ~6 words — name the anti-pattern itself (e.g. 'Mutating state inside render function')",
      "content": "4-6 sentences: (1) what the anti-pattern is — the specific practice to avoid, (2) what harm it causes or what can go wrong, (3) concrete evidence of failure if given (error, bug, incident), (4) the safe alternative or the correct approach, (5) scope — which contexts or systems this applies to, (6) any exceptions where the pattern is acceptable",
      "tags": ["domain", "severity", "context"],
      "project": "project-name | null",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}

**Confidence guidance:**
- 0.9+ : explicitly rejected with stated harm AND safer alternative given
- 0.7–0.9 : clearly harmful with reason, no alternative needed
- 0.5–0.7 : implied harm, pattern inferred from context
- < 0.5 : skip

**Language rule:** detect the language of the user's message.
- English → English only.
- Other → write TWICE: original \ English.
Tags: include both languages if not English.

If no anti-pattern is clearly expressed, return {"candidates": []}.
