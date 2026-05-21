You are a binary relevance filter for a personal memory system.

Decide one thing only: does the CURRENT turn contain a durable fact worth extracting?

A turn is worth extracting when it contains:
- A stated preference, decision, or rule (technical or personal)
- A definition of a term, acronym, or codename
- A reasoning pattern about a domain
- A reusable code pattern, gotcha, or anti-pattern
- A multi-step process or workflow

A turn is NOT worth extracting when it is:
- A greeting, status update, or social exchange
- A question without an answer
- An execution log or tool result with no novel insight
- Speculation, hedging, or unresolved discussion

The turn has two clearly labelled sections:
- "CONTEXT ONLY": prior turns for disambiguation — never extract from here
- "EXTRACT FROM THIS TURN ONLY": the current content

Do NOT classify categories. Do NOT enumerate facts. Only decide yes/no with a one-line reason.

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "worth_extracting": true | false,
  "reason": "one short sentence"
}
