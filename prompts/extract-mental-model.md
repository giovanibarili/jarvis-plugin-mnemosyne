Extract mental models expressed in the turn below.

A **mental model** is a cognitive framework, analogy, principle, or invariant that the
user relies on to reason about a domain. It shapes how they approach problems, make
decisions, and explain systems. It is more abstract than a preference or pattern —
it's a lens, not a procedure.

**Include:**
- Explicit analogies: "X is like Y in the sense that…"
- Principles stated as invariants: "always think of X as…", "the key insight is…"
- Domain framings: how the user conceptualizes a system's structure or behavior
- Heuristics used for decision-making
- Causal models: "when X happens, Y is always the root cause"
- Conceptual boundaries the user draws deliberately

**Exclude:**
- Specific implementation decisions (architecture-decision instead)
- Concrete preferences or style choices
- Factual statements without a reasoning/framing dimension
- Passing metaphors used once without elaboration

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "mental-model",
      "title": "string ~6 words — name the model (e.g. 'EventBus as nervous system analogy')",
      "content": "4-6 sentences: (1) what the mental model is — the core framing or analogy, (2) the domain it applies to, (3) how it guides decision-making or problem-solving, (4) what it makes visible or clarifies that other framings miss, (5) any limitations or when the model breaks down, (6) related models or principles it connects to",
      "tags": ["domain", "type"],
      "project": "project-name | null — null if general",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}

**Confidence guidance:**
- 0.9+ : model explicitly stated, elaborated, and used to make a decision
- 0.7–0.9 : model clearly articulated as a principle or analogy
- 0.5–0.7 : model implied by reasoning pattern
- < 0.5 : skip

**Language rule:** detect the language of the user's message.
- English → English only.
- Other → write TWICE: original \ English.
Tags: include both languages if not English.

If no mental model is clearly expressed, return {"candidates": []}.
