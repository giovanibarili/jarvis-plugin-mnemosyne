Extract anti-patterns expressed in the turn below. An anti-pattern is an explicitly
rejected approach, tool, or practice — paired with the reason it should be avoided.

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "anti-pattern",
      "title": "string ~6 words",
      "content": "1-3 sentences capturing what is rejected, why, and the safer alternative if mentioned",
      "tags": ["tag1", "tag2"],
      "project": "project-name | null",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}

If no anti-pattern is clearly expressed, return {"candidates": []}.
