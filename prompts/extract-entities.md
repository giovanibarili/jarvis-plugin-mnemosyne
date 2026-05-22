Extract named entities from the turn below.

An **entity** is a specific, concrete named thing that is central to the conversation:
a project, microservice, tool, library, technology platform, person, team, or
organization. Entities are nodes in the knowledge graph — they should be worth
remembering because they connect to many memories.

**Include:**
- Projects and initiatives (e.g. "Mnemosyne", "JARVIS", "Operation Blackout")
- Microservices and APIs (e.g. "labrador", "simple-account-authorizer", "trabalha")
- Tools, CLIs, libraries, platforms (e.g. "neovis.js", "ChromaDB", "Neo4j", "esbuild")
- People being discussed in a meaningful role (author, owner, reviewer)
- Teams and squads with their area of responsibility
- External organizations relevant to the work

**Exclude:**
- Generic concepts or abstract terms (extract as mental-model or glossary instead)
- Entities mentioned only in passing, as examples, or in boilerplate
- Standard industry tools everyone knows (React, TypeScript — unless their specific
  version/configuration is being discussed)

Turn:
"""
{{TURN}}
"""

Output JSON only:
{
  "candidates": [
    {
      "category": "entities",
      "title": "EntityName — EntityType (e.g. 'ChromaDB — vector database', 'labrador — Nu microservice')",
      "content": "3-5 sentences: (1) what this entity is — its type and canonical description, (2) its role in the current conversation, (3) how it relates to other entities or projects mentioned, (4) any specific version, configuration, or deployment context discussed, (5) ownership or team if known",
      "tags": ["entity-type", "domain", "project-or-system"],
      "project": "project-name | null — the project that owns or primarily uses this entity",
      "confidence": 0.0-1.0,
      "evidence": "verbatim quote from turn where this entity is discussed",
      "visibility": "open"
    }
  ]
}

**Entity types:**
- `project` — named software project or initiative
- `service` — microservice or internal API
- `tool` — CLI, library, or platform being configured/debugged/used
- `person` — named individual in a relevant role
- `team` — named team or squad
- `organization` — company or external organization

**Confidence guidance:**
- 0.9+ : entity is the main subject of the turn, discussed in depth
- 0.7–0.9 : entity actively discussed, configured, or built
- 0.5–0.7 : entity referenced as context or dependency
- < 0.5 : skip — too peripheral

**Language rule:** detect the language of the user's message.
- English → English only.
- Other → write TWICE: original \ English.
Tags: include both languages if not English; always include the entity name as a tag.

If no qualifying entity is found, return {"candidates": []}.
