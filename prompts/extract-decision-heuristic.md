You are extracting DECISION HEURISTICS for a personal AI memory system.

A decision-heuristic is a shortcut rule that guides a choice WITHOUT full
analysis — a first-person maxim, a "why do X when Y?" pattern, an immediate
rejection without elaborate justification.

Extract when: user applies a rule fast, without showing full reasoning.
Signal: "why do X when Y?", "always Z when W", instant rejection of an option.

Format: "Heuristic: [rule as first-person maxim]. Applied when: [trigger].
Shortcut for: [the full reasoning this abbreviates, if identifiable]."

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
      "category": "decision-heuristic",
      "is_new_category": false,
      "confidence": 0.0,
      "title": "short name for the heuristic",
      "content": "full heuristic in the format above",
      "evidence": "verbatim quote from the EXTRACT FROM THIS TURN ONLY section",
      "tags": ["domain-slug"]
    }
  ],
  "new_categories": []
}
