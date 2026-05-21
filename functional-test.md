# Functional Tests — jarvis-plugin-mnemosyne

> **MANDATORY.** Every scenario below MUST be executed individually after `plugin_install`,
> `plugin_update`, or `plugin_enable`. No skipping, no batching, no LLM-judgement shortcuts.
> The plugin is not considered installed until **all 19 scenarios pass**.

Mnemosyne is a long-term memory plugin modeled on brain memory consolidation. It runs a
hybrid storage stack — Markdown (canonical) + ChromaDB (vector) + Neo4j (graph) — extracts
memories via two-pass LLM, retrieves top-K hybrid context per turn, and consolidates daily.
This document is the **acceptance contract** for v1.0.

---

## Setup (run once before the first scenario)

**Prerequisites:**

- macOS or Linux host
- Docker installed and the daemon running (`docker info` returns 0)
- Python 3.10+ with `chromadb` package (`python3 -c "import chromadb"` returns 0)
- Free TCP ports on `127.0.0.1`: **7687** (Neo4j Bolt), **7474** (Neo4j HTTP), **8765** (Chroma)
- JARVIS running (this is the host)
- Plugin installed at `~/.jarvis/plugins/jarvis-plugin-mnemosyne/` (via `plugin_install`
  or manual clone) and enabled via `plugin_enable jarvis-plugin-mnemosyne`

**One-shot preflight (sanity check before scenarios):**

```bash
cd ~/.jarvis/plugins/jarvis-plugin-mnemosyne
./scripts/preflight-check.sh    # must exit 0
```

If preflight reports failures, fix the host first — scenarios assume a green environment
unless they explicitly degrade it (Scenarios 2 and 3).

---

## Reset between scenarios

**Default reset (derived state only — keeps canonical markdown):**

```bash
cd ~/.jarvis/plugins/jarvis-plugin-mnemosyne
./scripts/wipe-test-state.sh --yes
# Then re-enable the plugin so it boots fresh:
#   piece_disable mnemosyne   (or plugin_disable jarvis-plugin-mnemosyne)
#   piece_enable  mnemosyne   (or plugin_enable  jarvis-plugin-mnemosyne)
```

**Full reset (also deletes canonical markdown — destructive):**

```bash
./scripts/wipe-test-state.sh --all --yes
```

Use `--all` only when a scenario explicitly requires a virgin install. Otherwise the default
keeps `~/.jarvis/mnemosyne/memories/` so `rebuild-indexes.ts` (Scenario 18 setup) can
regenerate the derived stores from canonical truth.

---

# Boot & preflight

## Scenario 1: Plugin enables and bootstraps successfully on a healthy host

**Given:** Docker is running, ports 7687/7474/8765 are free, Python 3.10+ with `chromadb` is
installed, and `~/.jarvis/plugins/jarvis-plugin-mnemosyne/` exists.
**When:** I call `plugin_enable jarvis-plugin-mnemosyne` (or `piece_enable mnemosyne` if
already loaded).
**Then:** Boot preflight passes; the Chroma server is listening on `127.0.0.1:8765`; the
Neo4j container `mnemosyne-neo4j` is running and bound to `127.0.0.1:7687`/`127.0.0.1:7474`;
the HUD shows the Mnemosyne panel with the Memories/Workflows/Graph/Conflicts/Stats tabs;
all 14 capability tools (`memory_search`, `memory_get`, `memory_list`, `memory_explain`,
`memory_update`, `memory_pin`, `memory_unpin`, `memory_delete`, `memory_promote`,
`workflow_list`, `workflow_get`, `workflow_replay`, `mnemosyne_consolidate`,
`mnemosyne_stats`) are registered.

**Verification:**
1. Run `plugin_list` and confirm `jarvis-plugin-mnemosyne` is `enabled: true`.
2. Run `docker ps --filter name=mnemosyne-neo4j --format '{{.Status}}'` — must include `Up`.
3. Run `lsof -nP -iTCP:8765 -sTCP:LISTEN | grep 127.0.0.1` — must return one line.
4. Run `lsof -nP -iTCP:7687 -sTCP:LISTEN | grep 127.0.0.1` — must return one line.
5. Use `session_get_tools filter=memory_` and confirm 9 entries; `filter=workflow_` → 3;
   `filter=mnemosyne_` → 2 (total 14).
6. Take a HUD screenshot — the Mnemosyne panel is visible with five tabs.

**Pass criteria:** All four services are up on loopback, all 14 tools are registered, and
the HUD panel renders the five tabs without an error overlay.

---

## Scenario 2: Plugin shows preflight error panel when Docker is missing/stopped

**Given:** Docker daemon is stopped (`osascript -e 'quit app "Docker"'` on macOS, or
`sudo systemctl stop docker` on Linux). The plugin is currently disabled.
**When:** I call `plugin_enable jarvis-plugin-mnemosyne`.
**Then:** Boot fails with `MnemosyneBootError`; the HUD renders a red `PreflightErrorPanel`
listing the failed check `docker-running` with action text "Start Docker Desktop"; the
plugin is marked disabled (no tools registered, no consolidator cron scheduled).

**Verification:**
1. Confirm Docker is stopped: `docker info` exits non-zero.
2. Trigger enable; observe the error panel in the HUD.
3. Take a screenshot — panel shows red border, header `Mnemosyne — boot failed`, and the
   row for `docker-running` with `✗` and the suggested action.
4. Run `session_get_tools filter=memory_` — must return zero entries.
5. Restart Docker, run `./scripts/wipe-test-state.sh --yes`, then re-enable the plugin and
   confirm Scenario 1 passes again (return host to a healthy state for downstream tests).

**Pass criteria:** The panel surfaces the exact failed check with an actionable hint and no
Mnemosyne tools are registered while Docker is down.

---

## Scenario 3: Plugin refuses to start if Neo4j ports aren't bound to 127.0.0.1 (D10)

**Given:** A rogue process is listening on `0.0.0.0:7687` (simulate with
`python3 -c "import socket,time; s=socket.socket(); s.bind(('0.0.0.0',7687)); s.listen(1); time.sleep(600)" &`)
or the `mnemosyne-neo4j` container has been started manually with port-forward on
`0.0.0.0:7687`.
**When:** I call `plugin_enable jarvis-plugin-mnemosyne`.
**Then:** Preflight check `port-7687` fails with detail "port not bound to loopback"; the
HUD shows the red `PreflightErrorPanel` with action "Stop the conflicting process"; the
plugin is marked disabled and no tools are registered. The Neo4j container is **not**
started by Mnemosyne while this state persists (D10 — security check enforces loopback).

**Verification:**
1. Confirm conflict: `lsof -nP -iTCP:7687 -sTCP:LISTEN` shows the rogue binding (`*:7687` or
   `0.0.0.0:7687`).
2. Trigger enable; observe failure.
3. Screenshot — `PreflightErrorPanel` lists `port-7687` in red with the action hint.
4. Confirm Mnemosyne did NOT spawn its container: `docker ps --filter name=mnemosyne-neo4j`
   returns no row (or the row is unchanged from before the enable attempt).
5. Kill the rogue listener, run `./scripts/wipe-test-state.sh --yes`, re-enable, confirm
   green boot before moving on.

**Pass criteria:** Plugin refuses to start, surfaces `port-7687` failure, and never opens
Neo4j on a non-loopback interface.

---

# Memory extraction

## Scenario 4: Casual conversation produces zero memories (triage rejects)

**Given:** Plugin is running on a healthy host; the markdown store under
`~/.jarvis/mnemosyne/memories/` is empty (run `./scripts/wipe-test-state.sh --all --yes`,
then re-enable).
**When:** The user sends a casual turn — for example, type into the chat panel:
`oi, tudo bem?` and let the assistant respond once.
**Then:** The encoder runs **only the triage pass** (1 LLM call); no memories are persisted;
no markdown files are created; Chroma collection size stays at 0; Neo4j Memory node count
stays at 0; the extraction log records `pass: 1, skip_reason: "casual conversation"`.

**Verification:**
1. Send the casual turn and wait ~5 seconds for encoder completion.
2. Run `npx tsx scripts/check-stats.ts` from the plugin root — markdown / chroma / neo4j
   counts must all be `0`.
3. Inspect `~/.jarvis/mnemosyne/extraction.log` (last entry) — must contain
   `"pass": 1` and `"skip_reason"` with a casual-conversation phrase.
4. Call the `mnemosyne_stats` tool — `total_memories: 0`.

**Pass criteria:** Zero memories across all three layers and the log shows triage stopped
the pipeline at pass 1.

---

## Scenario 5: Stated preference is extracted and persisted to all 3 layers

**Given:** Plugin is running, store is empty (full reset).
**When:** The user sends `Eu prefiro Effect-TS para gerenciar erros em código TypeScript` and
the assistant responds.
**Then:** Within 5 seconds, exactly one memory of category `preference` exists; it is written
to a markdown file under `~/.jarvis/mnemosyne/short/preference/<slug>.md` with valid YAML
frontmatter (`id`, `category: preference`, `confidence`, `created_at`, `source_session`); a
matching document exists in the Chroma collection (returned by similarity query); a
matching `Memory` node exists in Neo4j with the same `id`.

**Verification:**
1. Send the turn, wait ≤ 5s.
2. `ls ~/.jarvis/mnemosyne/short/preference/` — must show one new `.md` file referencing
   Effect-TS in its filename or body. Capture the memory `id` from the frontmatter.
3. Invoke the `memory_search` tool with `query="Effect-TS error handling"` — the response
   must contain a result whose `id` equals the captured `id`.
4. Open the Mnemosyne HUD Stats tab — `total_memories: 1`.
5. Inspect Neo4j: `docker exec mnemosyne-neo4j cypher-shell -u neo4j -p neo4j --format plain
   "MATCH (m:Memory {id:'<id>'}) RETURN m.id, m.category"` returns the row.
6. HUD Memories tab shows a `MemoryCard` with the preference text and category badge.

**Pass criteria:** The memory exists in markdown, Chroma, and Neo4j with matching `id`, and
is visible from the HUD.

---

## Scenario 6: Two-pass extraction triggers correct category (preference vs code-pattern vs decision)

**Given:** Empty store, plugin running.
**When:** Three turns are sent (one at a time, waiting for encoder completion between each):
- Turn A: `Eu prefiro tabs sobre espaços` (preference)
- Turn B: `Sempre uso Result<T,E> em vez de exceptions no domínio` (code-pattern)
- Turn C: `Decidi migrar o serviço de auth para Rust em Q3` (decision)
**Then:** Triage (pass 1) flags each as a different memory candidate; pass 2 routes each to
the matching category extractor; three markdown files exist in
`~/.jarvis/mnemosyne/short/preference/`, `.../code-pattern/`, and `.../decision/`
respectively.

**Verification:**
1. Send the three turns in order; capture each memory `id` from `extraction.log`.
2. `find ~/.jarvis/mnemosyne/short -name '*.md' | sort` — must list three files split across
   three category folders.
3. For each file, `head -10 <file>` confirms the `category:` frontmatter matches the folder.
4. Call `mnemosyne_stats` — `categories: { preference: 1, code-pattern: 1, decision: 1 }`.
5. `extraction.log` last three entries each show `pass: 2` with non-empty
   `category_extractor` field matching the category.

**Pass criteria:** Three memories persisted in three distinct categories with the right
folder layout and stats.

---

## Scenario 7: Workflow with 3+ steps is detected and persisted with NEXT edges

**Given:** Empty store, plugin running.
**When:** The user sends `O processo de release é: primeiro rodo lint-fix, depois lein test,
depois faço commit assinado, e por último push pro main`.
**Then:** The encoder routes this to the workflow extractor; one `Workflow` node and four
`Step` nodes are created in Neo4j; `NEXT` edges connect the steps in order
(`lint-fix → test → commit → push`); the workflow appears in the HUD `Workflows` tab.

**Verification:**
1. Send the turn, wait ≤ 5s.
2. Run Cypher: `MATCH (w:Workflow)-[:HAS_STEP]->(s:Step) RETURN w.name, count(s)` — count is 4.
3. Run `MATCH (a:Step)-[:NEXT]->(b:Step) RETURN a.order, b.order ORDER BY a.order` — must
   return three rows with consecutive integer orders (1→2, 2→3, 3→4).
4. Invoke `workflow_list` tool — response includes the new workflow with `step_count: 4`.
5. Invoke `workflow_get` with that workflow name — returns ordered steps array.
6. Open the HUD Workflows tab — entry with name and "4 steps" badge is visible.

**Pass criteria:** Workflow persisted with exactly 4 ordered steps connected by `NEXT` edges
and surfaced in tool + HUD.

---

# Retrieval

## Scenario 8: Top-K hybrid retrieval surfaces vector seeds + 1-hop graph neighbors

**Given:** Two memories are persisted with a `RELATES_TO` edge between them — A:
`Sir prefere Effect-TS para erros` and B: `Effect-TS suporta dependency injection via Layer`.
Insert A first, then B, and (if the encoder has not auto-linked them) manually create the
edge with Cypher: `MATCH (a:Memory),(b:Memory) WHERE a.id='<A>' AND b.id='<B>' MERGE (a)-[:RELATES_TO]->(b)`.
**When:** The user sends a query semantically close only to A — for example
`como eu prefiro tratar erros mesmo?` — and the retriever runs with `topK=1`.
**Then:** The retriever's response (returned by `memory_search` with the same query, or
inspected via the retriever's logged context) includes BOTH A (vector seed) AND B
(1-hop graph expansion). A's `reinforcements` counter is incremented from 0 to 1; B's is
unchanged.

**Verification:**
1. Confirm the edge exists: Cypher `MATCH (:Memory {id:'<A>'})-[:RELATES_TO]->(:Memory {id:'<B>'}) RETURN 1` returns one row.
2. Read each memory's frontmatter — record `reinforcements` for A and B (both should be 0).
3. Send the query turn (or call `memory_search` directly with `topK: 1, expand: true`).
4. Confirm the response payload contains both `<A.id>` and `<B.id>`.
5. Re-read both markdown files — A's `reinforcements` is now `1`, B's is still `0`.

**Pass criteria:** Retrieval returned A via vector and B via graph expansion; only A's
reinforcement counter advanced.

---

## Scenario 9: Private memories from session A do NOT leak to session B

**Given:** A memory `M` is persisted with frontmatter `visibility: private` and
`source_session: actor-foo`. Easiest setup: dispatch an actor named `foo` and have it state
a private preference, then verify the file's frontmatter; or create the file directly under
`~/.jarvis/mnemosyne/short/preference/` and run `npx tsx scripts/rebuild-indexes.ts`.
**When:** A query is issued from `session_id: main` whose semantic content matches `M`'s
content (use `memory_search` with `__sessionId="main"` or trigger from the main chat).
**Then:** `M` does NOT appear in the retrieval result. The same query issued from
`session_id: actor-foo` DOES return `M`.

**Verification:**
1. `head -10 <file-of-M>` confirms `visibility: private` and `source_session: actor-foo`.
2. From `main`, call `memory_search` with the matching query — response array does not
   contain `M.id`.
3. Send the same query as `actor-foo` (via `actor_dispatch foo nu-discovery-agent "search
   memory: <query>"`) — the actor's response references `M` (or the bus publishes a
   `memory_search` result containing `M.id`).
4. Call `memory_explain` with the query as `actor-foo` — the explanation includes M with
   non-zero score; calling it as `main` returns no entry for M (filtered before reranking).

**Pass criteria:** `M` is invisible to `main` and visible to `actor-foo` with the filter
explicitly recorded.

---

## Scenario 10: CONTRADICTS edges are surfaced in retrieved block

**Given:** Two memories exist with a `CONTRADICTS` edge: A — `Sir prefers Effect-TS for
errors` (long-term, older), B — `Sir abandonou Effect-TS, voltou para try/catch` (recent
promotion). Create the edge if the consolidator hasn't yet (Scenario 13 verifies auto-creation):
`MATCH (a:Memory {id:'<A>'}),(b:Memory {id:'<B>'}) MERGE (a)-[:CONTRADICTS]->(b)`.
**When:** The user issues a query semantically matching both — `como eu trato erros em TS?`.
**Then:** The retrieval block returned to the prompt (Block 1 dynamic context) contains both
A and B with an explicit conflict marker (e.g. `⚠ contradicts <other-id>` or a
`conflicts:` field) so the assistant can address the inconsistency.

**Verification:**
1. Confirm edge: Cypher `MATCH (:Memory {id:'<A>'})-[:CONTRADICTS]->(:Memory {id:'<B>'}) RETURN 1` returns one.
2. Call `memory_explain` with the query and `topK: 5` — the response payload includes both
   memories and an explicit conflict annotation referencing the partner id.
3. In a JARVIS chat session, send the query verbatim and use `session_get_system raw=true`
   to dump the system prompt; the dynamic Block 1 contains both memories with a conflict
   marker (`contradicts`, `conflict`, or `⚠`).
4. Open the HUD Conflicts tab — the pair appears as a row.

**Pass criteria:** The retrieved block includes both contradicting memories together with
an explicit conflict signal, and the Conflicts tab lists the pair.

---

# Consolidation

## Scenario 11: Memory with reinforcements >= threshold is promoted (short → long)

**Given:** A memory `M` exists in `~/.jarvis/mnemosyne/short/<category>/<slug>.md` with
`reinforcements: <N>` where `N` equals the configured `consolidator.promotion_threshold`
(see `config.default.json` — typically 3). Set `M.reinforcements = N` directly in the
frontmatter to make the test deterministic, then run `npx tsx scripts/rebuild-indexes.ts`.
**When:** I invoke the `mnemosyne_consolidate` tool (which runs the full consolidator
pipeline, equivalent to the 3am cron).
**Then:** `M` is moved to `~/.jarvis/mnemosyne/long/<category>/<slug>.md`; the short-term
file no longer exists; the Neo4j node updates `tier: "long"`; consolidation log records
`promoted: [<M.id>]`.

**Verification:**
1. `cat <short-file>` confirms `reinforcements: <threshold>` before running.
2. Invoke `mnemosyne_consolidate` (no args).
3. `ls ~/.jarvis/mnemosyne/short/<category>/<slug>.md` returns "No such file" and
   `ls ~/.jarvis/mnemosyne/long/<category>/<slug>.md` exists.
4. Cypher: `MATCH (m:Memory {id:'<M.id>'}) RETURN m.tier` returns `"long"`.
5. `~/.jarvis/mnemosyne/consolidation.log` last entry contains the id under `promoted`.

**Pass criteria:** File moved, Neo4j tier updated, log recorded the promotion.

---

## Scenario 12: Old, low-confidence memory decays per forgetScore

**Given:** A memory `M` with `confidence: 0.3`, `created_at` set 365 days in the past,
`reinforcements: 0`, and `pinned: false` — values chosen so its `forgetScore` exceeds the
configured `consolidator.decay_threshold`. Set the frontmatter directly and run
`npx tsx scripts/rebuild-indexes.ts`.
**When:** I invoke `mnemosyne_consolidate`.
**Then:** `M` is removed from all three layers — markdown file deleted, Chroma document
deleted, Neo4j node deleted (or marked `tombstoned: true` per implementation). The
consolidation log records `decayed: [<M.id>]`.

**Verification:**
1. Pre-run: confirm `M`'s frontmatter values and that `forgetScore` (per
   `lib/consolidator/forget-score.ts`) crosses threshold.
2. Invoke `mnemosyne_consolidate`.
3. `ls <markdown-path>` returns "No such file".
4. Call `memory_get` with `<M.id>` — returns `success: false, error: "not found"`.
5. Cypher: `MATCH (m:Memory {id:'<M.id>'}) RETURN m` returns 0 rows.
6. `consolidation.log` records `<M.id>` under `decayed`.

**Pass criteria:** Memory is gone from all three layers; an immediately-following
`memory_search` for its content returns nothing.

---

## Scenario 13: Conflict detector creates CONTRADICTS edge for true contradictions

**Given:** Memory A: `Sir prefere Effect-TS para tratar erros em TypeScript` exists in
long-term tier (use Scenario 11 setup, or seed directly under `long/preference/`).
**When:** A new memory B containing `Sir abandonou Effect-TS e voltou para try/catch padrão`
is captured (send the user turn `Mudei de ideia: abandonei Effect-TS, voltei pra try/catch`)
AND the consolidator runs (`mnemosyne_consolidate`).
**Then:** The consolidator's conflict detector links A and B with a `CONTRADICTS` edge in
Neo4j; the Conflicts HUD tab shows the pair.

**Verification:**
1. Confirm A exists in long-term and capture `<A.id>`.
2. Send the contradicting turn; confirm B persists (`mnemosyne_stats` count increased).
3. Invoke `mnemosyne_consolidate`.
4. Cypher: `MATCH (a:Memory {id:'<A.id>'})-[r:CONTRADICTS]-(b:Memory) RETURN b.id` returns
   `<B.id>` (edge may be directional or undirected — accept either).
5. Open HUD Conflicts tab — row showing both memories with a "Resolve" action.
6. `consolidation.log` last entry contains `conflicts: [{a: "<A.id>", b: "<B.id>"}]`.

**Pass criteria:** `CONTRADICTS` edge exists in Neo4j and the pair is listed in the HUD.

---

# Workflow replay

## Scenario 14: Replay engine confirms each step (yes/skip/abort)

**Given:** A workflow `W` with three steps exists (use Scenario 7 setup, or seed via
Cypher).
**When:** I invoke `workflow_replay` with `name: "<W.name>"` and respond:
- step 1 → `yes`
- step 2 → `skip`
- step 3 → `yes`
**Then:** Steps 1 and 3 are executed (their `command` field is run, or marked executed for
manual steps); step 2 is logged as `skipped`; the replay log records all three decisions.

**Verification:**
1. `workflow_get <W.name>` confirms three steps with the expected order.
2. Invoke `workflow_replay` and respond as above (interaction surface is the
   `WorkflowReplayDialog` HUD renderer or, for headless, the tool's `decisions` parameter).
3. Inspect `~/.jarvis/mnemosyne/replay.log` — the last entry is a JSON object with a
   `decisions` array of length 3 in the order `["yes","skip","yes"]` and a final
   `outcome: "completed"`.
4. If steps 1 and 3 had `command` fields, side effects observable (e.g. file created); for
   manual steps, `executed_at` timestamp is set.

**Pass criteria:** Replay log shows all three decisions; only confirmed steps were
executed; skipped step has no execution record.

---

## Scenario 15: Required step failure halts replay; optional step failure continues

**Given:** A workflow `W2` with three steps where step 2 has `required: true` and step 3
has `required: false`. Seed via Cypher or via a turn describing the workflow with explicit
required/optional language. Step 2's `command` is set to a script that exits non-zero
(e.g. `bash -c "exit 1"`); step 3's command is also failing but optional.
**When:** I invoke `workflow_replay` and confirm `yes` to all three steps.
**Then:** Step 1 succeeds; step 2 fails — replay halts immediately with `outcome: "halted"`;
step 3 is NOT attempted. Re-run the test after flipping required/optional: with step 2
optional and failing, step 3 IS attempted and (if also failing-but-optional) the workflow
completes with `outcome: "completed_with_warnings"`.

**Verification:**
1. Confirm `W2`'s steps' `required` flags via `workflow_get`.
2. Invoke `workflow_replay` and confirm all steps.
3. `replay.log` shows step 1 `executed`, step 2 `failed`, step 3 absent;
   final `outcome: "halted"` and `halted_at_step: 2`.
4. Edit step 2 to `required: false`, re-run replay.
5. `replay.log` now shows step 1 `executed`, step 2 `failed_optional`, step 3 attempted
   (status reflects step 3's outcome); final `outcome: "completed_with_warnings"`.

**Pass criteria:** Required-failure halts the engine; optional-failure lets execution
continue with a warning outcome.

---

# HUD & tools

## Scenario 16: memory_search tool returns ranked results matching the query

**Given:** Three memories are persisted: A — `Sir prefere Effect-TS para erros`, B — `Sir
prefere camelCase em variáveis JS`, C — `Sir gosta de café com leite pela manhã`. (Seed by
sending each as a separate turn or by writing markdown directly + `rebuild-indexes.ts`.)
**When:** I invoke the `memory_search` tool with `query: "como prefiro tratar erros?"` and
`topK: 3`.
**Then:** The response is a ranked array; A is rank 1 with the highest score; B is below A;
C is below B (or absent); each result includes `id`, `score`, `category`, `text` snippet.

**Verification:**
1. After seeding, confirm `mnemosyne_stats.total_memories ≥ 3`.
2. Invoke `memory_search` with the query above and `topK: 3`.
3. Parse the response — assert `results[0].id == <A.id>`.
4. Assert scores are monotonically non-increasing (`results[0].score >= results[1].score >=
   results[2].score`).
5. Assert each result has all four fields populated.

**Pass criteria:** Effect-TS memory is the top hit and the result list is sorted by score
descending.

---

## Scenario 17: mnemosyne_consolidate tool runs the full consolidator pipeline

**Given:** A non-empty store with at least one promotion-eligible memory and at least one
decay-eligible memory (combine setup from Scenarios 11 and 12).
**When:** I invoke the `mnemosyne_consolidate` tool with no arguments.
**Then:** The tool returns a structured report with counts for `dedup`, `promoted`,
`decayed`, `conflicts_detected`, and `duration_ms`; all four phases ran (verifiable in
`consolidation.log`); the side effects observed individually in Scenarios 11–13 hold here
too (promotion file moved, decay deletion, conflict edge if applicable).

**Verification:**
1. Pre-run: capture `mnemosyne_stats` snapshot (`total`, per-tier counts).
2. Invoke `mnemosyne_consolidate`.
3. Response payload includes all five fields; `duration_ms > 0`; `promoted >= 1` and
   `decayed >= 1`.
4. `~/.jarvis/mnemosyne/consolidation.log` last entry has timestamps for each phase
   (`dedup`, `promote`, `decay`, `conflict`) all within the last minute.
5. Post-run: `mnemosyne_stats` shows the long-term tier increased and total decreased
   relative to pre-run snapshot.

**Pass criteria:** The single tool call drives all four phases and produces a structured
report with non-zero counts matching observable side effects.

---

## Scenario 18: HUD panel displays memories with stats and supports search/filter

**Given:** At least 5 memories exist across at least 2 categories (use a mix of Scenarios 5,
6, 11 to seed; or run `npx tsx scripts/rebuild-indexes.ts` after writing them directly).
**When:** I open the Mnemosyne HUD panel and switch to the Memories tab.
**Then:** The Stats header shows the correct totals (e.g. `5 memories · 2 short · 3 long`);
the memory list shows one `MemoryCard` per memory; pinned memories render with a gold
border (verify by pinning one via `memory_pin <id>` and refreshing); typing in the search
box filters the list to results matching the query semantically (calls `memory_search`
behind the scenes); selecting a category filter chip narrows by category.

**Verification:**
1. Take a HUD screenshot with the Memories tab open. Confirm the stats line at the top
   matches `mnemosyne_stats` output (`total_memories`, per-tier counts).
2. Count rendered `MemoryCard` elements — equals total memories.
3. Invoke `memory_pin <id>` for any one memory; refresh the panel; screenshot — that card
   has a gold border (per `MemoryCard.tsx`).
4. Type a query into the panel's search box (e.g. `"Effect-TS"`); the list narrows to
   memories matching the query and the network/log shows a `memory_search` call.
5. Click a category filter chip (e.g. `preference`); only preference memories remain
   visible.

**Pass criteria:** The HUD panel correctly renders stats, lists every memory, highlights
pinned memories with a gold border, and live-filters via the search box and category chips.

---

# System prompt invariant

## Scenario 19: Mnemosyne preserves Block 0 of system prompt (D2 invariant)

**Given:** A JARVIS session with the Mnemosyne plugin DISABLED, and a user message sent to
capture the baseline system prompt structure.
**When:** Plugin is enabled, several memories are persisted, and the same user message is
sent in a fresh session to trigger retrieval (Block 1 should populate).
**Then:** Block 0 of the system prompt is byte-identical between the two captures — no
Mnemosyne content, no citation instructions, no behavioral nudges. All memory context lives
exclusively in Block 1 (dynamic context).

**Verification:**
1. With plugin DISABLED (`plugin_disable jarvis-plugin-mnemosyne`), call
   `session_get_system raw=true` against a clean session. Save the response as
   `prompt_baseline.json` (e.g. via `jarvis_eval` writing to disk, or copy from the tool
   result). Note Block 0's text content and char count.
2. `plugin_enable jarvis-plugin-mnemosyne`, wait for bootstrap (Scenario 1 green), then
   persist 3 distinct memories — either by sending three extracting turns (Scenario 5/6
   patterns) or by writing markdown directly and running `npx tsx scripts/rebuild-indexes.ts`.
   Verify via `mnemosyne_stats` that `total_memories >= 3`.
3. In a fresh session, send a query that should match at least one memory; capture the
   system prompt with `session_get_system raw=true` and save as `prompt_with_mnemosyne.json`.
   Verify Block 1 populates — the memory section is non-empty and contains at least one
   memory id.
4. Compare Block 0 across both captures — must be byte-identical:
   `diff <(jq -r '.blocks[0].text' prompt_baseline.json) <(jq -r '.blocks[0].text' prompt_with_mnemosyne.json)`
   returns empty.
5. Block 0 contains zero Mnemosyne fingerprints:
   `jq -r '.blocks[0].text' prompt_with_mnemosyne.json | grep -ciE 'mnemosyne|\[mem:|remembered|previously stated|your preferences'`
   returns `0`.

**Pass criteria:** Block 0 is byte-for-byte identical with and without the plugin loaded;
all Mnemosyne-injected content is confined to Block 1.

---

# Troubleshooting common failures

| Symptom | Likely cause | Action |
|---|---|---|
| Boot fails with `port-7687` red | Another process or another Neo4j is bound to 7687 | `lsof -nP -iTCP:7687 -sTCP:LISTEN` → kill the offender, or stop the other Neo4j |
| Boot fails with `docker-running` red | Docker daemon is stopped | Start Docker Desktop (macOS) or `sudo systemctl start docker` (Linux) |
| Boot fails with `chroma-server` red | Python / `chromadb` package missing | `python3 -m pip install --user chromadb`; verify with `python3 -c "import chromadb"` |
| Encoder never persists memories | LLM provider unreachable or rate-limited | Check `~/.jarvis/mnemosyne/extraction.log` for HTTP errors; confirm `model_get` returns a healthy provider |
| Stats divergence between markdown / Chroma / Neo4j | Manual edits or partial wipe | `npx tsx scripts/rebuild-indexes.ts` rebuilds derived stores from canonical markdown |
| HUD panel does not render | Plugin disabled mid-boot | `plugin_list` to confirm enabled; `piece_enable mnemosyne` to retry |
| Replay halts when it should continue | A step was tagged `required: true` unintentionally | `workflow_get <name>` to inspect; edit step `required` flag in Neo4j or recreate workflow |
| `mnemosyne_consolidate` returns zero counts unexpectedly | No memory met any threshold | Check `consolidation.log` — likely correct behaviour; lower thresholds in `config.json` only for testing |
| Test pollution between scenarios | Forgot to wipe state | `./scripts/wipe-test-state.sh --yes` and re-enable the plugin |

---

**End of acceptance contract.** Treat any scenario failure as a v1.0 blocker. Open an issue
referencing the scenario number, paste the failing log lines, and either fix or downgrade
the release scope before tagging `v1.0.0`.

---

## v1.2 TRIPLET BDD scenarios

These scenarios exercise the three-step pipeline (triage → classify → relate) introduced in v1.2. All scenarios assume `pipeline.v12_enabled: true` in JARVIS config.

### Scenario T12-1: Triage skips a greeting

**Given** MNEMO_PIPELINE_V12 is enabled
**When** the user sends "Hi! How are you today?"
**Then** the encoder logs `worth_extracting: false`
**And** no memory is written to the store
**And** the triage reason does not contain a category name

### Scenario T12-2: Classify writes a preference memory

**Given** MNEMO_PIPELINE_V12 is enabled
**And** "preference" exists in the category catalog
**When** the user sends "Eu prefiro Postgres em projetos novos"
**Then** the encoder logs `worth_extracting: true`
**And** a memory with `category: "preference"` is written
**And** no new category is materialized

### Scenario T12-3: New category — first occurrence triggers fallback

**Given** MNEMO_PIPELINE_V12 is enabled
**And** no pending category "ux-pattern" exists
**When** the user sends a turn that classify proposes "ux-pattern" with confidence >= 0.7
**Then** `~/.jarvis/mnemosyne/pending-categories.json` has "ux-pattern" with `occurrences: 1`
**And** the persisted memory is in an EXISTING category (fallback applied)
**And** `~/.jarvis/mnemosyne/categories/ux-pattern.md` is NOT created

### Scenario T12-4: New category — second occurrence materializes it

**Given** MNEMO_PIPELINE_V12 is enabled
**And** `pending-categories.json` has "ux-pattern" with `occurrences: 1` and `last_seen_ts` within the last 7 days
**When** the user sends another turn that classify proposes "ux-pattern" with confidence >= 0.7
**Then** `~/.jarvis/mnemosyne/categories/ux-pattern.md` is created
**And** the persisted memory has `category: "ux-pattern"`
**And** "ux-pattern" no longer appears in `pending-categories.json`

### Scenario T12-5: Intra-turn relate links two sibling memories

**Given** MNEMO_PIPELINE_V12 is enabled
**When** the user sends a turn that classify yields 2 candidates from different categories
**Then** both memories are persisted
**And** a Neo4j edge with `intra_turn: true` and a valid relation type links them
**And** the relation is not "unrelated"

### Scenario T12-6: Async relate piece links new memory to a neighbor

**Given** MNEMO_PIPELINE_V12 is enabled
**And** there is an existing memory C in the store
**When** a new memory M is persisted that is semantically similar to C (similarity >= 0.55)
**Then** within 5 seconds a Neo4j edge M→C is created
**And** the edge relation is not "unrelated"
**And** the edge carries a `reason` field

### Scenario T12-7: Feature flag off keeps v1.1 path

**Given** `pipeline.v12_enabled` is false (default)
**When** the user sends any turn
**Then** the encoder runs the v1.1 triage+extract code path
**And** no v12 prompts are loaded
**And** `pipeline_version` in extraction.log is absent or "1.1"
**And** `~/.jarvis/mnemosyne/pending-categories.json` is not created or modified

---

## v1.3 Graph Retrieval BDD scenarios

All scenarios assume `graph_retrieval.enabled: true` in config.

### Scenario T13-1: Passive injection shows neighborhood

**Given** `graph_retrieval.enabled: true`
**And** memory M1 has 2 children in Neo4j (M2 with 3 grandchildren, M7 with 0)
**And** M1 has 1 parent P1 with 0 grandchildren
**When** the retriever fetches M1
**Then** context injection contains `↑ P1 ... (0 filhos)`
**And** context injection contains `↓ M2 ... (3 filhos)`
**And** context injection contains `↓ M7 ... (0 filhos)`
**And** the hint line `memory_fetch` appears

### Scenario T13-2: Hint absent when no relations

**Given** `graph_retrieval.enabled: true`
**And** retrieved memory M1 has no parents or children in Neo4j
**When** the retriever fetches M1
**Then** no `↑` or `↓` lines appear
**And** the hint line is NOT injected

### Scenario T13-3: memory_fetch returns expanded neighborhood

**Given** memory M2 has 2 children (C1 with 2 grandchildren, C2 with 0)
**And** M2 has 1 parent P1
**When** the LLM calls `memory_fetch("M2")`
**Then** response includes `↑ P1 ...`
**And** response includes `↓ C1 ...`
**And** response includes `→ G1 ...` and `→ G2 ...` (grandchildren of C1)
**And** response includes `↓ C2 ... (no children)`
**And** response ends with `memory_fetch` navigation hint

### Scenario T13-4: Feature flag off keeps v1.2 behavior

**Given** `graph_retrieval.enabled: false` (default)
**When** retriever fetches memories
**Then** no neighborhood is attached to any RetrievalHit
**And** no `↑`/`↓` lines appear in context injection
**And** `memory_fetch` tool is not registered

---

## Workflow Chroma Retrieval BDD scenarios

### Scenario TW-1: Workflow appears in injection when query matches trigger

**Given** a workflow "ship-it" with trigger "implementation complete, ready to deliver" indexed in Chroma
**When** the retriever receives query "ready to commit and push"
**Then** the injected context includes a `📋 workflow` block
**And** the block contains "ship-it", the trigger text, and `workflow_replay("ship-it")`

### Scenario TW-2: Workflow not injected when similarity below threshold

**Given** workflow "ship-it" indexed in Chroma
**When** query has no semantic overlap (e.g. "what is the weather?")
**Then** no `📋 workflow` block appears in the injected context

### Scenario TW-3: Workflow indexed in Chroma when saved

**Given** encoder processes a turn with a workflow candidate (≥2 steps, confidence ≥0.6)
**When** `upsertWorkflow()` is called on Neo4j
**Then** `chroma.upsertWorkflow()` is also called with name + trigger + outcome + steps summary
**And** the workflow is retrievable via `queryWorkflows()`
