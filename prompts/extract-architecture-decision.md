Extract architecture decisions expressed in the turn below.

An **architecture decision** is a deliberate technical choice about system structure,
component boundaries, protocols, data models, libraries, or runtime behavior — made with
an explicit or implicit rationale. It is durable: it constrains or shapes future work.

**Include:**
- Technology/library selection with reasoning ("we use X because Y")
- Structural choices: how modules communicate, data flows, API contracts
- Trade-off resolutions: "we chose X over Y because of Z"
- Constraints adopted as policy ("no direct imports between pieces", "always use EventBus")
- Performance or scalability choices backed by reasoning
- Security or operational boundaries

**Exclude:**
- Pure implementation details with no structural consequence
- Temporary workarounds explicitly marked as such
- Choices made without any stated rationale (these are preferences, not decisions)

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "architecture-decision",
      "title": "string ~6 words — name the decision, not the context",
      "content": "4-6 sentences: (1) what was decided, (2) the specific alternatives that were considered or rejected, (3) the rationale / driving forces, (4) the constraints or forces that shaped it, (5) consequences or trade-offs accepted, (6) scope — which parts of the system this applies to",
      "tags": ["tag1", "tag2"],
      "project": "project-name | null",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn",
      "visibility": "open"
    }
  ]
}

**Confidence guidance:**
- 0.9+ : explicit decision with alternatives considered and rationale stated
- 0.7–0.9 : clear decision with at least one reason
- 0.5–0.7 : implied structural choice, rationale inferred
- < 0.5 : skip

**Language rule:** detect the language of the user's message.
- English → English only.
- Other → write TWICE: original \ English, separated by " \ ".
Tags: include both languages if not English.

If no architecture decision is clearly expressed, return {"candidates": []}.
