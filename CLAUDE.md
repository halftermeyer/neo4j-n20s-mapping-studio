# n20s-mapping

Maps a Neo4j Ontology Graph Spec 1.1.0 document (the LPG ontology from the Aura
ontology tool) to RDF target ontologies, then projects LPG data to RDF with n20s.
README.md is the reference for the format, the checks and the commands; read it first.

## Decisions (do not revisit without asking Pierre)

- The mapping is a separate file from the LPG ontology. The mapping points to the
  ontology, never the reverse. Entries are keyed by spec ids, not labels or types.
- Build from the ontology spec and n20s only. Do not reuse code or ideas from the
  old noRDF Studio project in the parent folder (app.py, engine.py, frontend/,
  server/, nordf-*). Relate is optional.
- No Neo4j plugin. Sources are reached over Bolt with the official driver: Relate
  (`relate serve --bolt`) during design, Neo4j or Aura in production, same code.
  Row queries stay plain Cypher (no APOC, no GDS) so they run on both.
- Credentials only in the environment or a .env file (`--dotenv`), never in
  mapping, plan, oracle or snapshot files. NEO4J_* from an Aura credentials file
  apply only to the NEO4J_URI host.
- Only `meta.status: accepted` entries compile; `proposed` entries are checked
  and shown, not compiled. This is the hook for AI proposals.
- In production, clients use their own AI provider: keep the provider behind a
  thin interface, key from the environment.
- No git commits or pushes unless Pierre asks.

## Layout

- `src/` core. `index.js` is browser-safe (check, lock, compile, project,
  runOracle, snapshots, n20sClient). `node.js` adds files and the Bolt source.
  - check.js (findings + coverage), lock.js (drift), resolve.js (inheritance
    through implied labels, entry status), compile.js (template strategy ->
    projection plan), source.js (Bolt + temporal -> XSD), snapshot.js (record and
    replay a source), project.js (plan -> n20s-server, compareSources),
    oracle.js (Cypher vs SPARQL), iri.js (templates, n20s-identical encoding),
    prepare.js (deterministic part of proposals: subjects, qualified and value
    IRIs), propose.js (AI proposals, passes, variants), providers.js (Gemini,
    record, replay), review.js (risk queue, accept/reject/edit), rekey.js (move a
    mapping between exports with different ids), studio.js (local server),
    recipe.js (recipes: ordered steps feeding, changing or asking named n20s
    graphs, ephemeral or persistent), graphs.js (registry of persistent graphs
    and their status), endpoints.js + serve.js (SPARQL endpoint, /query, /run),
    bench.js (requests, checks, benchmark; also loaded by the page),
    workspace.js (projects: sources, targets, mappings, lock, status),
    catalog.js (target vocabularies), introspect.js (LPG ontology from a
    database), design.js (spec, design conversation, spec checks, recipe drafts).
    project.js is NOT the project file: it runs a projection plan (project,
    compareSources); projects are workspace.js.
- `studio/` the page (plain DOM + SVG, no build step): app.js (Mapping tab),
  project-tab.js, design-tab.js, recipes.js, bench-tab.js (tabs), dom.js (shared helpers).
- `bin/n20s-mapping.js` CLI: status, introspect, fetch, check, lock, compile,
  propose, studio, recipe, graphs, serve, bench, republish, unpublish, project,
  compare, snapshot, load, query, oracle.
- `eval/` propose evaluation on lineage (propose-lineage.js, rekey-gold.js),
  recordings and reports per model and prompt version.
- `examples/lineage/` the reference case: data-lineage LPG v3 -> PROV-O, fully
  decided by hand; seed.cypher (the data), oracle.yaml (queries 32 to 39 of the
  lineage saved queries, reduced to what PROV carries). aura-export.json is the
  same model as the Aura tool exports it (ids n:0/r:0/p:0, no PROV references,
  no one_of, no cardinalities); lineage-prov.aura.mapping.yaml and
  oracle.aura.yaml are the gold moved onto it. AI input is the Aura export.
  recipes/ holds seven recipes, simple to complex, and bench.yaml (e2e-tested).
  graphs.json (run state) is git-ignored. n20s-project.yaml makes the example
  a project (Aura export, introspected source, prov file, dcat from the catalog).
- `aura.snapshot.json` rows from the Aura instance `data-lineage` (Neo4j 5.27).

## Running

```bash
npm test                      # unit + CLI tests; e2e skipped without RELATE_BIN and N20S_JAR
RELATE_BIN=/path/to/relate N20S_JAR=../n20s-plugin/n20s-server/target/n20s-server-1.1.0-SNAPSHOT.jar npm test
node bin/n20s-mapping.js compare examples/lineage/lineage-prov.mapping.yaml --dotenv .env --source bolt://neo4j:<pw>@127.0.0.1:7688
```

- n20s-server needs Java 21 (`PORT=7474 java -jar …`). Relate CLI: the
  `relate-darwin-arm64` asset of github.com/relatedb/relate releases (here in
  ~/bin/relate-dl/).
- `node eval/propose-lineage.js --dotenv .env --passes 3` with RELATE_BIN and
  N20S_JAR set (oracle on); `--gold-answers` checks the evaluation itself.
- Node 22+. The CLI option is `--dotenv`, not `--env-file`: Node intercepts
  `--env-file` even after the script name.

## Known pitfalls

- Fixed in n20s (2026-11-20, needs the rebuilt jar): temporal values in XSD
  form (was Java toString: no zero seconds, [Zone]); a whole-placeholder
  `kind: iri` value that is an absolute IRI is used as is (so `kind: iri`
  without a value table compiles); query `terms: true` keeps literal datatype
  and language (the SPARQL endpoint uses it). The server still gets rows as
  JSON: source.js keeps sending XSD strings with an explicit datatype.
- Structural checks cannot see a wrong meaning: DEPENDS_ON -> prov:wasDerivedFrom
  passes `check` and fails the oracle (test/e2e.test.js). Keep that test.
- Gemini refuses large response schemas ("too many states"): properties are an
  array with one item schema, numbers have no bounds.
- Models put the reason of an ignore in `rationale` and leave `reason` empty;
  propose takes the rationale then.
- Replaying recordings only works while prompts are unchanged: a change in one
  answer changes "Decisions so far" in every later prompt.

## Status (2026-11-20, evening)

Done: format, checker, lock/drift, template compiler, Bolt source, project,
compare, snapshot, oracle. Lineage: 9 oracle checks pass, q36 and q39 not
expressible. Relate 1.1.0 and Aura 5.27 give identical rows on all 25 units and
on the oracle Cypher.

propose (prompt propose/2, gemini-2.5-flash, Aura export, 3 passes):
agreement with the gold 77-86% (84-90% counting rdfs:label/comment on left-out
metadata as acceptable, Pierre's call), 0 check errors, oracle 8/8 in 2 of 3
passes. DEPENDS_ON: ignored with descriptions, mapped to prov:wasDerivedFrom 3/3
without; once to prov:wasInfluencedBy, now caught by q34-potential-no-influence. Recurring
errors: HAS_COLUMN -> prov:hadMember (check warns), retiredAt ->
prov:invalidatedAtTime, runId -> prov:hadActivity. Stable decisions are right
92% of the time, unstable ones 65%. Reports: eval/results/.

Studio done (graph from extensions.display, risk queue, accept/reject/edit,
ask again with the reviewer's comment, accept safe, oracle panel). Human in the
loop is the intended mode: good-enough AI plus review, per Pierre.

Recipes done (the "second studio"; first called flows, renamed by Pierre: a
recipe is an execution order feeding or changing named n20s graphs, with data
passing only to follow up on a result). Format n20s-recipe/0.1; graphs are
ephemeral (per run, dropped) or persistent (fixed name, start: rebuild|reuse);
registry graphs.json with stable/stale/incomplete/missing/unknown; `serve`
gives a read-only SPARQL 1.1 endpoint on persistent graphs and /run/<recipe>;
Recipes tab: sequence view with graph state per step, graph panel with SPARQL.
Publication (Pierre, 2026-11-20): a publish step serves a persistent graph as
/sparql/<as>; versioned graphs are built then swapped (never a half-built or
invalid endpoint), behind fail-closed validate gates; a published lifecycle
reads an endpoint; construct ... from pulls a precomputed slice into a lazy
graph; recipes have a kind (build, precomputed, lazy, hybrid); a recipe with
api: is served as /query/<name> (lazy scoping is the default for APIs);
republish/unpublish (CLI and studio). Bench (Pierre, 2026-11-20): bench.yaml
collections of requests (published APIs and endpoints, draft recipes via /run)
with expectations; `bench` CLI and a Bench tab (send, checks, history,
benchmark with percentiles and histogram, compare). Only published endpoints are served;
/run needs serve --run. Future: CDC-driven updates of published graphs
(re-scope the changed keys into a new version, then swap).
Scopes restrict the plan by subject keys, not elementId (elementId is for the
canonical-bridge strategy; Pierre's call). Not yet: composite subject keys in
scopes, rows/construct examples, detecting source data changes for staleness.

Next, in order:
Head of the pipeline (Pierre, 2026-11-20): project (sources from an Aura or
Enterprise export or introspection; targets from file, URL or catalog), the
specification written in a chat where the AI proposes and the person
validates (scope, purpose, principles, notes, competency questions, targets),
propose driven by the spec, departures from the spec in the review queue, and
competency questions drafted as recipes cross-checked against a direct Cypher
answer. Tabs: Project, Design, Mapping, Recipes, Bench.

Order agreed with Pierre (2026-11-20): 3 (recipes, done), then 2, then 1.
1. Repair calls for AI entries with domain/range warnings; second eval set from
   another domain (names that do not match the target terms).
2. n20s rules for deferred elements (HAD_PLAN, runId), making q39 expressible.
   Scopes (3) may cover part of it: decide after 3.
3. Second studio: Cypher scopes and parametrized SPARQL chains.
Not started: the canonical-bridge strategy (checked, not compiled).
