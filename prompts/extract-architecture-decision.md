Extract architecture-decisions expressed in the turn below. An architecture-decision
is a technical choice (library, structure, protocol, boundary) made with an explicit
justification or trade-off.

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "architecture-decision",
      "title": "string ~6 words",
      "content": "1-3 sentences capturing the decision, the alternatives considered, and the rationale",
      "tags": ["tag1", "tag2"],
      "project": "project-name | null",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}

If no architecture-decision is clearly expressed, return {"candidates": []}.
