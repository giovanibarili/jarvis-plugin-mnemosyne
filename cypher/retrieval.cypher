// Mnemosyne — retrieval queries (REFERENCE ONLY).
//
// These queries are issued inline by Neo4jAdapter (see lib/neo4j-adapter.ts).
// This file is intentionally NOT auto-loaded by applySchema(). It documents
// the canonical Cypher used by the retriever so reviewers and future
// maintainers can read the queries without spelunking through TypeScript
// string templates.
//
// Conventions:
//   - $seedIds       array of memory ids returned by the vector top-K seed
//   - $sessionId     caller's session id (privacy filter)
//   - $id            single memory id (contradiction lookup)
//   - $trigger       short workflow trigger phrase

// 1) Vector top-K seeds + 1-hop graph expansion
//    Vector layer is queried separately via Chroma; this query takes the
//    resulting seed ids and pulls every directly-connected Memory node,
//    excluding seeds themselves and respecting privacy.
//
//    Used by: Neo4jAdapter.oneHopNeighbors
//
//    MATCH (seed:Memory) WHERE seed.id IN $seedIds
//    MATCH (seed)-[r]-(neighbor:Memory)
//    WHERE NOT neighbor.id IN $seedIds
//      AND (neighbor.visibility = "open" OR neighbor.source_session = $sessionId)
//    RETURN DISTINCT neighbor;

// 2) Contradiction lookup for a single memory
//    Used to surface ⚠️ Conflicts with: ... in the rendered block.
//
//    Used by: Neo4jAdapter.getContradictions
//
//    MATCH (m:Memory {id: $id})-[:CONTRADICTS]-(other:Memory)
//    RETURN other.id AS id;

// 3) Workflow trigger lookup (Task 9 Step 5 — gated by workflowLookupEnabled)
//    Looks up workflows whose trigger phrase matches the user's last message.
//    Returns the workflow plus its ordered steps so the retriever can render
//    a step-by-step plan in the memory block.
//
//    NOTE: this query is wired up by the cron / consolidator path in Task 12.
//    Retriever opts.workflowLookupEnabled merely toggles whether the piece
//    will call into the lookup at retrieval time.
//
//    MATCH (w:Workflow)
//    WHERE toLower($trigger) CONTAINS toLower(w.trigger)
//      AND ($project IS NULL OR w.applies_to_project IS NULL OR w.applies_to_project = $project)
//    OPTIONAL MATCH (w)-[:HAS_STEP]->(s:Step)
//    WITH w, s ORDER BY s.order
//    RETURN w, collect(s) AS steps;
