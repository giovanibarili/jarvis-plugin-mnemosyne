// Constraints
CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE;
CREATE CONSTRAINT workflow_id IF NOT EXISTS FOR (w:Workflow) REQUIRE w.id IS UNIQUE;
CREATE CONSTRAINT step_id IF NOT EXISTS FOR (s:Step) REQUIRE s.id IS UNIQUE;
CREATE CONSTRAINT project_name IF NOT EXISTS FOR (p:Project) REQUIRE p.name IS UNIQUE;
CREATE CONSTRAINT tool_name IF NOT EXISTS FOR (t:Tool) REQUIRE t.name IS UNIQUE;
CREATE CONSTRAINT concept_name IF NOT EXISTS FOR (c:Concept) REQUIRE c.name IS UNIQUE;
CREATE CONSTRAINT skill_name IF NOT EXISTS FOR (s:Skill) REQUIRE s.name IS UNIQUE;

// Indexes
CREATE INDEX memory_category IF NOT EXISTS FOR (m:Memory) ON (m.category);
CREATE INDEX memory_promoted IF NOT EXISTS FOR (m:Memory) ON (m.promoted_at);
CREATE INDEX memory_last_accessed IF NOT EXISTS FOR (m:Memory) ON (m.last_accessed);
CREATE INDEX memory_visibility IF NOT EXISTS FOR (m:Memory) ON (m.visibility);
CREATE INDEX memory_pinned IF NOT EXISTS FOR (m:Memory) ON (m.pinned);
CREATE INDEX memory_session IF NOT EXISTS FOR (m:Memory) ON (m.source_session);
CREATE INDEX workflow_name IF NOT EXISTS FOR (w:Workflow) ON (w.name);

// Hermes-first taxonomy nodes
CREATE CONSTRAINT domain_slug IF NOT EXISTS FOR (d:Domain) REQUIRE d.slug IS UNIQUE;
CREATE CONSTRAINT entity_slug IF NOT EXISTS FOR (e:Entity) REQUIRE (e.slug, e.domain) IS UNIQUE;
CREATE INDEX domain_description IF NOT EXISTS FOR (d:Domain) ON (d.description);
CREATE INDEX entity_domain IF NOT EXISTS FOR (e:Entity) ON (e.domain);
