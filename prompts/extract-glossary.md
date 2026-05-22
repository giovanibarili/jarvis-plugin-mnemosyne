Extract glossary entries expressed in the turn below.

A **glossary entry** is a term, acronym, codename, alias, or domain-specific concept
being defined, named, or given a canonical meaning — one that will be reused in future
conversations and should be retrieved consistently.

**Include:**
- New terms being defined: "X means…", "we call this Y"
- Aliases or nicknames with binding: "SAA = simple-account-authorizer"
- Codenames for projects, initiatives, or components
- Domain jargon specific to the user's stack or organization
- Overloaded terms being disambiguated ("in our context, X means…")

**Exclude:**
- Standard industry terms with no local definition
- Terms defined in passing without any intent to reuse
- Synonyms that don't add precision

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "glossary",
      "title": "Term — short qualifier (e.g. 'SAA — Nu microservice acronym')",
      "content": "3-5 sentences: (1) the canonical definition of the term, (2) its full form if it's an acronym or alias, (3) the domain or system it belongs to, (4) any synonyms or related terms, (5) disambiguation — what it is NOT, if there's risk of confusion",
      "tags": ["domain", "acronym-or-alias", "system"],
      "project": "project-name | null — the project/system where this term is used",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn where the term is defined or used",
      "visibility": "open"
    }
  ]
}

**Confidence guidance:**
- 0.9+ : explicit definition with full form and domain given
- 0.7–0.9 : term clearly named and scoped
- 0.5–0.7 : term implied as domain-specific without explicit definition
- < 0.5 : skip

**Language rule:** detect the language of the user's message.
- English → English only.
- Other → write TWICE: original \ English.
Tags: include both languages if not English; always include the term itself as a tag.

If no glossary entry is clearly expressed, return {"candidates": []}.
