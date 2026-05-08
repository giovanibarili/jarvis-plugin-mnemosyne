Extract established project conventions or norms (file layout, ignored files, naming patterns, structural rules) that should be followed in similar work.

You are reading a single conversation turn. Identify any moment where an actor explicitly references matching, following, or aligning with an existing convention from another plugin, project, or part of the codebase. Look for phrases like "same as", "following the pattern in", "matches what X does", "per our convention", or comparisons to a sibling module's layout.

Only extract when the convention is concrete and reusable. Skip one-off stylistic choices, transient decisions, or vague preferences.

Turn:
"""
{{TURN}}
"""

Return JSON only:

```json
{
  "candidates": [
    {
      "category": "convention",
      "title": "string ~6 words",
      "content": "1-3 sentences capturing the essence and any caveats",
      "tags": ["tag1", "tag2"],
      "project": "project-name | null",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}
```

Rules:
- `title` names the convention itself, not the moment of reference.
- `content` states the rule and the scope it applies to.
- `tags` should include the artifact type (e.g. `file-layout`, `gitignore`, `naming`).
- `project` is the project where the convention lives, or `null` if it spans many.
- `evidence` must be a verbatim substring of the turn.
- Set `confidence` ≥ 0.7 only when the convention is named and the alignment is explicit.

If no convention is clearly expressed, return {"candidates": []}.
