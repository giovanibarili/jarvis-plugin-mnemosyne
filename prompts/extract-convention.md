Extract established conventions expressed in the turn below.

A **convention** is a structural rule, naming standard, file layout policy, or
organizational norm that applies consistently across a project or codebase —
not a one-off decision, but a repeatable rule others should follow.

**Include:**
- File/directory naming standards ("plugins go in ~/.jarvis/plugins/")
- Module or layer organization rules ("pieces never import each other directly")
- Commit/PR/branch naming conventions
- Code style rules beyond linting (structural, not syntactic)
- Cross-cutting policies: "all routes must validate X", "every piece needs a unique ID"
- References to following an existing pattern from another module

**Exclude:**
- One-off structural decisions for a single file
- Preferences framed as personal taste without team/project scope
- Architecture decisions with explicit rationale (use architecture-decision instead)
- Tool choices (use preference or architecture-decision instead)

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "convention",
      "title": "string ~6 words — name the rule (e.g. 'Plugin pieces must have unique global IDs')",
      "content": "4-6 sentences: (1) the convention stated as a rule, (2) where it applies — which project, layer, or artifact type, (3) the reason or rationale if given, (4) the specific scope (all plugins? only backend pieces?), (5) any known exceptions, (6) where to find the canonical example or reference",
      "tags": ["domain", "artifact-type", "rule-type"],
      "project": "project-name | null — null if cross-project",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}

**Confidence guidance:**
- 0.9+ : convention explicitly named and scoped, presented as a rule to follow
- 0.7–0.9 : clear structural rule, scope implied
- 0.5–0.7 : convention inferred from repeated usage or alignment language
- < 0.5 : skip

**Language rule:** detect the language of the user's message.
- English → English only.
- Other → write TWICE: original \ English.
Tags: include both languages if not English.

If no convention is clearly expressed, return {"candidates": []}.
