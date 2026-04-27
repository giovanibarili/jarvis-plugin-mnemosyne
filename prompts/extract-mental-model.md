Extract mental-models expressed in the turn below. A mental-model is how the user
reasons about a domain — analogies, framings, principles, or invariants they rely on.

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "mental-model",
      "title": "string ~6 words",
      "content": "1-3 sentences capturing the model, the domain it applies to, and the framing",
      "tags": ["tag1", "tag2"],
      "project": "project-name | null",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}

If no mental-model is clearly expressed, return {"candidates": []}.
