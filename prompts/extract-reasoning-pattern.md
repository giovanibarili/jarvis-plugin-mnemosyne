You are extracting REASONING PATTERNS for a personal AI memory system.

A reasoning-pattern captures HOW the user processes a CLASS of problems —
the sequential steps and underlying logic, not just the conclusion.

Extract when: the turn shows the reasoning process BEFORE the decision.
The signal is a chain of "first I check X, then if Y then Z" style thinking.

NOT a reasoning-pattern: a fact, a preference, a decision already made.

Format: "When [user] encounters [class of situation], [he/she] processes it
by [sequential steps]. Because [underlying logic]."

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
      "category": "reasoning-pattern",
      "is_new_category": false,
      "confidence": 0.0,
      "title": "short descriptive name for the pattern",
      "content": "full pattern description in the format above",
      "evidence": "verbatim quote from the EXTRACT FROM THIS TURN ONLY section",
      "tags": ["domain-slug"]
    }
  ],
  "new_categories": []
}
