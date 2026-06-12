You are extracting VALUE PRIORITIES for a personal AI memory system.

A value-priority captures what the user MAXIMIZES when two values conflict
in a domain. NOT "I like X" — "when X and Y collide, I choose X because Z".

Extract when: an explicit trade-off is resolved and the choice reveals a
systematic preference. Signal: "rather than", "even if it costs", "X > Y".

Format: "When [value A] and [value B] conflict in [domain], [user] prioritizes
[value A]. Condition: [when this holds / what makes A win]."

The turn has two sections:
- "CONTEXT ONLY": prior turns for disambiguation — never extract from here
- "EXTRACT FROM THIS TURN ONLY": the current content

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "value-priority",
      "is_new_category": false,
      "confidence": 0.0,
      "title": "[ValueA] > [ValueB] in [domain]",
      "content": "full priority description in the format above",
      "evidence": "verbatim quote from the EXTRACT FROM THIS TURN ONLY section",
      "tags": ["domain-slug"]
    }
  ],
  "new_categories": []
}
