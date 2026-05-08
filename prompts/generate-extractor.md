You are authoring a memory extraction prompt for a new category in a personal
AI assistant's long-term memory system. The new category was proposed by the
triage classifier and now needs its own extraction template.

## Context
- New category id: {{CATEGORY_ID}}
- Description: {{CATEGORY_DESCRIPTION}}
- Hint (signal that triggers extraction): {{CATEGORY_HINT}}

## Task
Produce the full content of `prompts/extract-{{CATEGORY_ID}}.md` following the
exact shape of the existing canonical extractors. The template MUST:

1. Open with a one-sentence definition of what the category captures.
2. Include the literal placeholder `{{TURN}}` inside a triple-quoted block.
3. Output JSON only, with this schema:

```
{
  "candidates": [
    {
      "category": "{{CATEGORY_ID}}",
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

4. End with: `If no <category> is clearly expressed, return {"candidates": []}.`

## Style
- Imperative, terse, second-person.
- ~20-30 lines total.
- No code fences around the entire output. Plain markdown.
- Do not include the `{{CATEGORY_ID}}` placeholder verbatim — substitute it.

## Output
Return ONLY the markdown content of the new prompt file. No commentary, no
preamble, no explanation. The first character must be a letter (the start
of the first sentence).
