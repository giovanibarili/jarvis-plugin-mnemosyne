Extract preferences expressed in the turn below. A preference is a stated choice of
tool, style, approach, or value with optional justification.

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "preference",
      "title": "string ~6 words",
      "content": "1-3 sentences capturing the preference and any reason given",
      "tags": ["tag1", "tag2"],
      "project": "project-name | null",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}

If no preference is clearly expressed, return {"candidates": []}.
