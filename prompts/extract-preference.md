Extract preferences expressed in the turn below.

A **preference** is a stated or revealed choice — of tool, style, framework, workflow,
naming convention, communication style, or value — that the user or assistant explicitly
commits to or repeats. It should be actionable: knowing it changes how future work is done.

**Include:**
- Explicit statements: "I prefer X over Y", "always use X", "I like X because…"
- Revealed preferences: user repeatedly rejects Y in favor of X across the turn
- Style/aesthetic choices with context ("I want it minimal", "no preamble")
- Tool or stack preferences with rationale

**Exclude:**
- One-off choices for a single task ("use X just this time")
- Vague approvals with no specificity ("looks good")
- Inferred preferences without explicit signal

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "preference",
      "title": "string ~6 words — name the preference, not the situation",
      "content": "3-5 sentences: (1) what the preference is, (2) what it applies to / its scope, (3) the reason or motivation if given, (4) what the rejected alternative is if mentioned, (5) any caveats or conditions",
      "tags": ["tag1", "tag2"],
      "project": "project-name | null — null if cross-project",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn — the exact phrase that reveals the preference",
      "visibility": "open"
    }
  ]
}

**Confidence guidance:**
- 0.9+ : explicit, strong statement ("always", "never", "I strongly prefer")
- 0.7–0.9 : clear preference with reason
- 0.5–0.7 : implied by behavior or mild statement
- < 0.5 : skip — too ambiguous

**Language rule:** detect the language of the user's message.
- English → write title and content in English only.
- Other language → write title and content TWICE: original language \ English (e.g. "Prefiro X porque Y. \ I prefer X because Y.")
Tags: include both languages if not English.

If no preference is clearly expressed, return {"candidates": []}.
