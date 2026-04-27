Extract code-patterns expressed in the turn below. A code-pattern is an idiomatic
snippet, recurring code structure, or notable gotcha worth remembering for reuse.

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "code-pattern",
      "title": "string ~6 words",
      "content": "1-3 sentences capturing the pattern, when to use it, and any gotcha",
      "tags": ["tag1", "tag2"],
      "project": "project-name | null",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}

If no code-pattern is clearly expressed, return {"candidates": []}.
