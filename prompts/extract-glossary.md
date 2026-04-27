Extract glossary entries expressed in the turn below. A glossary entry is a new term,
acronym, or codename being defined or aliased to a meaning the user expects to reuse.

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "glossary",
      "title": "string ~6 words (the term itself + short qualifier)",
      "content": "1-3 sentences defining the term, its aliases, and the context it applies to",
      "tags": ["tag1", "tag2"],
      "project": "project-name | null",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}

If no glossary entry is clearly expressed, return {"candidates": []}.
