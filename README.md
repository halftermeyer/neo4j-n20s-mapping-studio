# n20s-mapping

A mapping format between a Neo4j **Ontology Graph Spec** document (the LPG ontology, as exported by Aura) and **RDF target ontologies**, with:

- a **checker** that validates references, lints the mapping, checks it against the targets, and reports **drift** when the LPG ontology changes;
- a **template compiler** that turns accepted entries into a projection plan: Cypher row queries plus n20s templates;
- a **projector** that runs the plan on a Cypher source (Relate or Neo4j, over Bolt) and builds the RDF graph in n20s-server, with no Neo4j plugin;
- an **oracle** that asks the same questions in Cypher on the LPG and in SPARQL on the projection, and compares the rows.

The `canonical-bridge` strategy (bridge rules over the canonical LPG snapshot) is checked but not compiled yet.

Design rules:

- **Separate file, one-way dependency.** The mapping points to the LPG ontology; the LPG ontology never points back. The modeling tool stays the only owner of its file.
- **Keyed by stable ids.** Entries use the node, relationship and property ids of the spec document, never labels, types or database names. A label renamed in the modeling tool does not touch the mapping.
- **Locked.** A lock file records what the mapping was checked against, so a new version of the LPG ontology produces a precise drift report.
- **Pure core.** `check()` reads no files, so the same code runs in a browser (a mapping studio) and in the CLI.

## Requirements

- Node 22+.
- For anything that touches RDF (projection, recipes, endpoints, oracle): n20s-server from [neo4j-n20s](https://github.com/halftermeyer/neo4j-n20s), **commit `f460c1f` or later** (temporal values in XSD form, column-valued IRIs, query results as terms), on Java 21: `mvn -pl n20s-server -am package`, then `PORT=7474 java -jar n20s-server/target/n20s-server-*.jar`.
- A Neo4j source: Aura, Neo4j, or Relate for local work. Following the database needs Neo4j Enterprise 5.13+ or Aura with change data capture in FULL mode.

## Quick start

```bash
npm install
node bin/n20s-mapping.js check   examples/lineage/lineage-prov.mapping.yaml
node bin/n20s-mapping.js compile examples/lineage/lineage-prov.mapping.yaml --out plan.json
npm test
```

End to end, with Relate as the source and n20s-server (Java 21) as the RDF side (`npm link` puts `n20s-mapping` on the PATH; otherwise use `node bin/n20s-mapping.js`):

```bash
relate serve -d :memory: --bolt 7688 --http 7475 --auth neo4j:$RELATE_PASSWORD &
PORT=7474 java -jar n20s-server-1.1.0-SNAPSHOT.jar &

export N20S_SOURCE=bolt://127.0.0.1:7688 N20S_SOURCE_USER=neo4j N20S_SOURCE_PASSWORD=$RELATE_PASSWORD
n20s-mapping load    examples/lineage/seed.cypher
n20s-mapping project examples/lineage/lineage-prov.mapping.yaml       # graph "lineage-prov"
n20s-mapping query   --graph lineage-prov 'PREFIX prov: <http://www.w3.org/ns/prov#> SELECT ?t (COUNT(?s) AS ?n) WHERE { ?s a ?t } GROUP BY ?t'
n20s-mapping oracle  examples/lineage/oracle.yaml
```

| Command | Does |
|---|---|
| `check <mapping> [--lpg f] [--lock f] [--json] [--strict] [--quiet]` | Validates and reports findings and coverage. |
| `lock <mapping> [--lpg f] [--lock f] [--force]` | Writes `<mapping>.lock.json` and sets `lpgOntology.version` in the mapping (YAML comments are kept). Refuses when `check` reports errors, unless `--force`. |
| `compile <mapping> [--out f] [--force]` | Writes the projection plan (stdout by default). Refuses when `check` reports errors, unless `--force`. |
| `project <mapping> [--source url] [--n20s url] [--graph name]` | Compiles, runs the row queries on the source, sends the rows to n20s-server. The graph (default: the mapping id) is replaced. |
| `compare <mapping> --source url [--source url]` | Runs every row query on two sources and lists the units whose rows differ. A missing second source comes from the environment. |
| `snapshot <mapping> [--oracle f] [--source url] --out f` | Saves the rows of every row query (and of the Cypher side of the oracle) to a file that works as a source. |
| `load <file.cypher>... [--source url]` | Runs a Cypher script (statements end with `;` at the end of a line). |
| `query <sparql or file> --graph name [--n20s url] [--json]` | SPARQL SELECT on an n20s graph. |
| `oracle <oracle.yaml> [--mapping f] [--source url] [--graph name] [--skip-project] [--json]` | Projects, then compares each check in Cypher and SPARQL. |
| `status <project.yaml> [--json]` | Sources, targets and mappings of a project, and how each stands. |
| `introspect <project.yaml> <source> [--source url]` | Reads the database into an LPG ontology document. |
| `fetch <project.yaml> <target> [--repin]` | Downloads a target from its URL or the catalog, pinned. |
| `propose <mapping> --out f --prefix p [--base-iri iri] [--model id] [--passes n] [--spec f] [--source url] [--no-descriptions] [--record f] [--replay f]` | Asks an AI model for the undecided elements and writes the mapping with its proposals to `--out` (see AI proposals). |
| `studio <mapping or project.yaml> [--mapping id] [--port n] [--reviewer name] [--oracle f] [--source url] [--n20s url] [--prefix p] [--recipes dir]` | Local page to review proposals on a drawing of the LPG ontology (see Studio). |
| `recipe <recipe.yaml> [--param name=value]... [--source url] [--n20s url] [--keep] [--proposals] [--json] [--check]` | Runs a recipe on named n20s graphs (see Recipes). |
| `graphs [<recipes dir>] [--n20s url] [--json]` | The graphs of n20s-server and those the recipes built, with their status. |
| `serve [<recipes dir>] [--port n] [--host addr] [--source url] [--n20s url] [--run]` | Published SPARQL endpoints and query APIs over HTTP. |
| `bench <bench.yaml> [--url base] [--only id]... [--iterations n] [--concurrency n] [--json]` | Sends a collection of requests to published APIs and endpoints (and draft recipes), checks the answers, times them. |
| `republish <endpoint> [--recipes dir]` | Runs again the recipe that published it: a new version, gated, swapped in. |
| `unpublish <endpoint> [--recipes dir]` | Stops serving it. |

Exit codes: `0` ok, `1` errors, refused command or failed check (or warnings with `--strict`), `2` usage, I/O or connection error.

## Sources: Relate or Neo4j

One adapter, over Bolt, with the official driver. The same commands work on Relate during design and on Neo4j or Aura in production.

| Source | URL |
|---|---|
| Relate, local | `relate serve -d <dir or :memory:> --bolt 7688 --auth neo4j:<password>`, then `bolt://127.0.0.1:7688` |
| Neo4j | `bolt://host:7687` or `neo4j://host:7687` |
| Aura | `neo4j+s://<id>.databases.neo4j.io` |

| Setting | Where, first found wins |
|---|---|
| URL | `--source`; missing sources come from `N20S_SOURCE`, else `NEO4J_URI` |
| User | `user@` in the URL, `NEO4J_USERNAME`, `N20S_SOURCE_USER` |
| Password | `user:password@` in the URL, `NEO4J_PASSWORD`, `N20S_SOURCE_PASSWORD`. A password in the URL works locally; keep it out of files, scripts and shell history you share. Mapping, plan, oracle and snapshot files never hold credentials. |
| Database | `?database=<name>` on the URL, `NEO4J_DATABASE`, `N20S_SOURCE_DATABASE` |
| n20s-server | `--n20s`, or `N20S_URL` (default `http://localhost:7474`) |

`NEO4J_*` are the names of the credentials file Aura gives you. They apply only to the server `NEO4J_URI` names, so the Aura password is never sent to another server. `--dotenv <file>` loads such a file (variables already set win; the option is not called `--env-file` because Node reads that flag itself):

```bash
# Relate (password in the URL, local) against the Aura instance of the .env file
n20s-mapping compare examples/lineage/lineage-prov.mapping.yaml --dotenv .env \
  --source bolt://neo4j:$RELATE_PASSWORD@127.0.0.1:7688
```

**Snapshots.** A machine that cannot reach the database (a CI job, a sandbox, a colleague) can work from a snapshot: the rows each query returned, saved to a file that then works as a source.

```bash
n20s-mapping snapshot examples/lineage/lineage-prov.mapping.yaml --oracle examples/lineage/oracle.yaml \
  --dotenv .env --out aura.snapshot.json
n20s-mapping oracle  examples/lineage/oracle.yaml --source aura.snapshot.json     # elsewhere, no database
n20s-mapping compare examples/lineage/lineage-prov.mapping.yaml --source aura.snapshot.json --source bolt://…
```

A snapshot answers only the queries it holds: after a change to the mapping or the oracle, take it again.

The row queries use plain `MATCH` and map projections: no APOC, no GDS, no node or relationship objects in the result. That is what lets them run unchanged on Relate and on Neo4j. `compare` checks it on real data: run it once on both before trusting a design done on Relate.

Temporal values are sent to n20s in their XSD lexical form (`2026-11-05T21:00:00Z`), with an explicit datatype.

## Projection plan

`compile` produces one unit per mapped node kind and relationship type:

```json
{ "id": "relationships/was-associated-with",
  "cypher": "MATCH (s:`Run`)-[r:`WAS_ASSOCIATED_WITH`]->(t:`Agent`) RETURN {_start: {`id`: s.`id`}, _end: {`id`: t.`id`}, `role`: r.`role`} AS row",
  "templates": [
    { "subject": "https://example.org/lineage/activity/{_start.id}", "triples": ["prov:wasAssociatedWith → agent", "prov:qualifiedAssociation → association"] },
    { "subject": "https://example.org/lineage/association/{_start.id}/{_end.id}", "triples": ["a prov:Association", "prov:agent → agent", "prov:hadRole from the value table"] } ] }
```

(triples abbreviated). Node units match on the identifier label, so a `Run` row uses the subject inherited from `activity`. Only `accepted` entries compile; `proposed` ones are checked but left out. The plan records the LPG ontology id, version and content hash it was compiled from.

Entries the compiler leaves out are listed as problems, and `project` refuses to run with problems unless `--force`: `compile.unsupported` (`kind: iri` without a value table), `compile.no-subject`, `compile.no-label` (a kind without an identifier label to match), `compile.strategy` (a `canonical-bridge` mapping compiled as templates).

## The example: data lineage LPG → PROV-O

[`examples/lineage`](examples/lineage) maps the 13 node kinds and 17 relationship types of `data-lineage-lpg` v3 to W3C PROV-O. Every element is decided: mapped, ignored with a reason, or deferred to a rule. Three decisions show what the format is for:

- `DEPENDS_ON` is ignored on purpose: it is an over-approximation, and mapping it to `prov:wasDerivedFrom` would assert lineage no source asserted.
- `USED`, `WAS_GENERATED_BY`, `WAS_ASSOCIATED_WITH`, `WAS_ATTRIBUTED_TO`, `WAS_INVALIDATED_BY` and the two derivations use the PROV **qualified pattern**, so that `role`, `reason` and similar relationship properties have a resource to attach to.
- `HAD_PLAN` and `runId` are **deferred**: in PROV the plan hangs on the association, and `prov:hadActivity` needs a join. Both span several elements, so they belong to a rule or to the scope query, not to a per-element entry.

## File format

```yaml
format: n20s-mapping/0.1
id: lineage-prov
lpgOntology: { id: data-lineage-lpg, version: "3", location: data-lineage-ontology.json }
targets:
  - { namespace: "http://www.w3.org/ns/prov#", location: targets/prov.nq }
strategy: template            # or canonical-bridge
prefixes: { prov: "http://www.w3.org/ns/prov#", xsd: "…", lin: "https://example.org/lineage/" }
nodes:
  entity:                     # node id in the spec document
    subject: "lin:entity/{id}"
    classes: [prov:Entity]
  dataset-version:            # implies Entity: inherits its subject and classes
    properties:
      generatedAt: { predicate: prov:generatedAtTime, datatype: xsd:dateTime }
      validFrom: { ignore: { reason: "Point-in-time validity is not PROV." } }
relationships:
  used:                       # relationship id in the spec document
    predicate: prov:used
    qualified:
      subject: "lin:usage/{start.id}/{end.id}"
      class: prov:Usage
      link: prov:qualifiedUsage
      target: prov:entity
    properties:
      role:
        predicate: prov:hadRole
        values: { input: "lin:role/input", config: "lin:role/config" }
  depends-on:
    ignore: { reason: "Potential dependency, not an asserted derivation." }
```

The JSON Schema is [`schema/n20s-mapping-0.1.schema.json`](schema/n20s-mapping-0.1.schema.json). The essentials:

| Field | Meaning |
|---|---|
| `nodes.<id>.subject` | IRI template for nodes of this kind. Inherited through implied labels; a subtype may repeat it but not change it. |
| `nodes.<id>.classes` | Classes asserted for this kind. Classes of implied kinds are asserted too. |
| `….properties.<id>` | `predicate`, optional `kind` (`literal` by default), `datatype` (derived from the Neo4j type when absent), or a `values` table (each value becomes an IRI; values not in the table emit nothing). |
| `relationships.<id>.predicate` | Direct triple, start node → end node. `direction: reverse` swaps them. |
| `relationships.<id>.qualified` | The relationship also becomes a resource of `class`, linked from the subject by `link` and pointing to the object with `target`. Relationship properties attach to it, and need it. |
| `ignore: { reason, deferred }` | A decision not to map, with the reason. `deferred: true` means "later, usually by a rule". |
| `meta` | `status` (`proposed`, `accepted`, `rejected`; accepted when absent), `proposedBy` (`human` or `ai`, with `model` and `promptVersion`), `reviewedBy`, `confidence`, `rationale`. Only accepted entries compile. |
| `rules`, `shapes` | Files for logic spanning several elements, and SHACL. Local files are checked for existence and `sha256`. |

**Placeholders.** In node subjects, `{<property id>}` of the node or of a node it implies. In qualified subjects, `{start.<property id>}`, `{end.<property id>}` (the LPG `from` and `to` nodes, whatever the direction) and `{<relationship property id>}`. The compiler resolves property ids to database names. Values are percent-encoded as in R2RML, which is why `/` is a safe separator and `-` or `_` are not.

## What `check` verifies

| Area | Codes | Severity |
|---|---|---|
| Structure | `schema.invalid` (mapping), `lpg.schema-invalid` (the LPG ontology against the official spec 1.1.0 schema) | error |
| References | `ref.unknown-node`, `ref.unknown-relationship`, `ref.unknown-property`, `ref.ontology-id` | error |
| Subjects | `subject.missing`, `subject.conflict`, `subject.unknown-placeholder`, `subject.not-invertible` (the IRI cannot be parsed back into values, which breaks showing a violation on the LPG node and passing a SPARQL result to a Cypher parameter) | error |
| | `subject.not-unique` (no uniqueness or key constraint covers the placeholders), `subject.optional-placeholder` (nodes without the value silently drop out), `subject.shared-pattern` (unrelated kinds share a pattern), `qualified.not-unique` (start-only or end-only qualified subject without a cardinality of one) | warning |
| Relationships | `rel.endpoint-no-subject`, `rel.property-without-qualified` | error |
| Values | `values.unknown-value` (not in `one_of`) | error |
| | `values.uncovered` (`one_of` values without an entry) | warning |
| Datatypes | `datatype.incompatible`, `datatype.no-default` | warning |
| Compilation | `compile.placeholder-name` (a database name n20s templates cannot use as is) | warning |
| IRIs | `iri.unknown-prefix` | error |
| Targets | `target.unknown-term` (an IRI in a target namespace that the ontology does not declare: the cheapest filter against invented terms), `target.not-a-class`, `target.not-a-property`, `target.load-failed` | error |
| | `target.domain`, `target.range`, `target.kind-mismatch` (literal on an object property, IRI on a datatype property) | warning |
| | `target.unchecked` (a target without a file) | info |
| LPG ontology | `lpg.unknown-endpoint` (a relationship end that is not a node of the document) | error |
| | `lpg.unresolved-implied` (an implied label no node declares: nothing is inherited through it) | warning |
| Files | `artifact.missing`, `artifact.hash-mismatch` | error |
| | `artifact.unchecked` (a URI, not a local file) | info |

Domain and range checks follow `rdfs:subClassOf` in the targets and are **lenient**: satisfied when at least one declared domain (or union member) holds. PROV-O declares several domains for some properties, to suit several OWL profiles.

## Drift and the lock

The lock records, per element, what the mapping depends on: labels and implied labels, relationship types and endpoints, property ids, database names, types and `one_of`. It also records a hash of the LPG ontology **without layout** (`extensions.display`), so moving nodes around in the modeling tool is not a change.

| Change in the LPG ontology | Finding |
|---|---|
| Element or property removed | `drift.removed`, `drift.property-removed`, and a `ref.*` error if an entry uses it |
| Element removed and another added with the same label or type | `drift.recreated`, with the old and new ids: a node deleted and recreated in the UI gets a new id |
| Element or property added | `drift.added`, `drift.property-added`; shows as undecided in coverage |
| Label, type or database name renamed | `drift.renamed`, `drift.property-renamed`: the entry still applies, recompile |
| Property type changed | `drift.type-changed`, a warning when an entry maps it |
| Endpoints or implied labels changed | `drift.endpoints-changed`, `drift.implied-changed` |
| `one_of` changed under a value table | `drift.values-changed` |
| Version differs from the mapping header | `drift.version-changed`; `lock.stale` when the lock and the header disagree |
| Anything else than layout | `drift.content-changed` (info), followed by the element findings above |
| Lock for another ontology, or in an unknown format | `drift.other-ontology`, `lock.format` (errors) |
| No lock yet | `drift.no-lock` (info) |

## Oracle

Structural checks cannot see a wrong meaning (see Known limits). The oracle tests the projection against data: each check is one question asked twice, in Cypher on the LPG and in SPARQL on the RDF graph, reduced to what the export carries.

```yaml
mapping: lineage-prov.mapping.yaml
checks:
  - id: q33-upstream-asserted-sources
    mode: equal                       # or disjoint
    columns: [source]
    decode: { source: "node:entity" } # parse the IRI back with the subject template
    cypher: MATCH (:DatasetVersion {id: '…dash.revenue@31'})-[:WAS_DERIVED_FROM]->{1,10}(src) …
    sparql: SELECT DISTINCT ?source WHERE { <{{entity|…dash.revenue@31}}> prov:wasDerivedFrom+ ?source … }
  - id: q36-point-in-time
    expressible: false
    reason: validFrom and validTo are not PROV.
```

`{{<node id>|<value>}}` becomes the IRI of that node. `decode` maps SPARQL values back to LPG values: `node:<node id>` parses an IRI with that kind's subject (this is what invertible subjects are for), `values:<section>/<id>/properties/<prop>` reverses a value table. `disjoint` passes when the Cypher side has rows and none of them appears on the SPARQL side.

**What a check says about a decision.** A check covers a mapping decision when its **SPARQL** uses a term the decision emits: a predicate or a class of that decision's templates in the compiled plan. Reading the relationship type in Cypher is not enough: `q34-asserted-inputs` reads DEPENDS_ON but only asks the RDF about `prov:wasDerivedFrom`, so it says nothing about DEPENDS_ON mapped to `prov:wasInfluencedBy`; `q34-potential-no-influence` does. For a decision to leave something out, what counts is the **Cypher** side: a check that reads the element (its label, relationship type, or `Label.property`, through variables or property maps; `covers: [TYPE, …]` adds relationship types) and fails says the RDF misses it (Dataset.name left out makes `q35-owners` fail). In the studio, every oracle run is kept next to the mapping (`<mapping>.oracle.json`: per check its status, the IRIs its SPARQL uses and what its Cypher reads; per decision its fingerprint and the terms it emits); the review uses it to decide what is safe (see Studio).

Lineage example, on Relate 1.1.0 and n20s-server, 64 nodes, 445 triples:

| Check | From query | Rows | Result |
|---|---|---|---|
| upstream runs, agents and roles | 32 | 4 | pass |
| upstream asserted sources | 33 | 2 | pass |
| asserted inputs of `mart.revenue@9` | 34 | 2 | pass |
| potential inputs are not `wasDerivedFrom` | 34 | 1 vs 2 (disjoint) | pass |
| potential inputs are no influence at all (closure of `wasInfluencedBy`, direct or qualified) | 34 | 1 vs 2 (disjoint) | pass |
| downstream impact, reads an invalidated input | 35 | 6 | pass |
| owners of impacted datasets, with roles | 35 | 4 | pass |
| column sources | 37 | 4 | pass |
| column versions and sources | 38 | 3 | pass |
| point in time | 36 | | not expressible: validFrom and validTo are not PROV |
| runs per job version | 39 | | not expressible: `HAD_PLAN` is deferred |

With `DEPENDS_ON` mapped to `prov:wasDerivedFrom`, `check` reports no error, and the oracle fails three checks (q33, q34 asserted, q34 disjoint) on `ref.dq_rules@2`, an input the run read but no source asserted. Mapped to `prov:wasInfluencedBy` (a model did it in the propose evaluation) or to a qualified `prov:Influence` alone, it passes those and fails the influence check. `test/e2e.test.js` runs these cases.

## Project

The head of the pipeline: a project names where the LPG ontologies and the RDF targets come from, and the mappings between them.

```yaml
format: n20s-project/0.1
name: Data lineage
sources:
  lineage:    { file: aura-export.json, origin: aura }          # exported from Aura (or Enterprise Studio: origin: enterprise)
  lineage-db: { introspect: true, file: introspected.json }     # read from the database (true: --source or the environment)
targets:
  prov: { file: targets/prov.nq, namespace: "http://www.w3.org/ns/prov#", prefix: prov }
  dcat: { catalog: dcat }                                       # from the catalog; or { url: …, namespace: …, prefix: … }
mappings:
  lineage-prov: { source: lineage, targets: [prov], file: lineage-prov.aura.mapping.yaml, recipes: recipes, spec: lineage-prov.spec.yaml }
```

- **Introspection** (`n20s-mapping introspect <project> <source>`) reads labels, properties and their types, relationship types and their ends, and constraints, with `db.schema.*`, `SHOW CONSTRAINTS` and plain Cypher (Relate, Neo4j, Aura), into an Ontology Graph Spec document. What the data shows, not what the model means: no descriptions; a label always found with another implies it (when two always come together the data cannot tell which is general: one is chosen and a note says so); a root label without a uniqueness constraint gets one when an id-like property is unique and always there, marked observed. Its version follows the structure, so introspecting an unchanged database gives the same version, and the lock records when and from where.
- **Targets** come from a file, a URL, or the catalog (`src/catalog.js`: PROV-O, DCAT 3, DCMI Terms, ORG, OWL-Time, Schema.org, SHACL; SKOS and FOAF are served as RDF/XML only, not supported yet). `n20s-mapping fetch <project> <target>` downloads one into `targets/`, pinned by SHA-256 in `n20s-project.lock.json`; a document that changed is refused unless `--repin`.
- `n20s-mapping status <project>` shows the sources (version, size, how many elements are described), the targets (classes, properties, pin) and each mapping: coverage, check, drift, spec, recipes, published endpoints.
- `n20s-mapping studio <project>` opens it: the **Project** tab shows sources, mappings and targets side by side, introspects, fetches, adds sources and targets, creates a mapping (source, targets, base IRI: an empty mapping with its header) and switches the mapping the other tabs work on.

## Design: the specification, written in conversation

Before proposing a mapping, an AI and a person write its specification together (the **Design** tab). The AI asks what the mapping is for, who will consume the RDF, what must never be asserted, and proposes spec items; the person accepts, rejects (with a reason the AI then sees) or edits each one. Only accepted items count. The spec, `<mapping>.spec.yaml`:

| Item | Says |
|---|---|
| `purpose` | What the mapping is for. |
| `include` / `exclude` | A node label or relationship type in or out of scope, with the reason. A property (`Member.email`) can be excluded: it is left out without asking the model, and mapping it anyway is a departure. |
| `principle` | A rule the mapping follows: "never assert a derivation no source asserts". |
| `note` | What an element (or `Label.property`) means or how to map it. |
| `question` | A competency question the RDF must answer. |
| `target` | A target ontology to use, from the project or the catalog. |

Elements are named as people see them (labels, types, `Label.property`) and checked against the LPG ontology; each item records who proposed and who accepted it, and the message it came from (`<mapping>.chat.jsonl` keeps the conversation). The model sees the ontology (descriptions when there are any: without them the conversation brings the meaning), the targets, the spec with what was rejected and why, and the conversation so far; it answers in the person's language.

What the spec drives:

- **`propose`** (CLI, or *Propose the mapping from this spec*): elements out of scope are left out with their reason, accepted, without asking the model; the purpose, the principles and the notes on an element go into its prompt (`propose/4`: a node kind with no class is sent back for repair; URL values become IRIs with `valueIsIri`).
- **Departures** from the spec lead the review queue: an element out of scope that is mapped, one in scope that is left out, a target the spec chose that the mapping does not have (*Add it to the mapping* adds it to the project, fetched, and to the mapping); *Check against the spec* asks the model where the decisions contradict a principle, the purpose or a note.
- **Competency questions become recipes.** *Draft a recipe* asks the model for a lazy recipe (Cypher scope, SPARQL, decode) and, next to it, a Cypher query answering the question directly on the LPG. The draft is checked (recipe structure, placeholders, decode columns, and the direction of every relationship pattern against the LPG ontology), repaired once, run, and compared with the direct answer: when they disagree, one more repair with the differences. It is saved as a draft whose header says whether it was cross-checked, linked from the question, and added to the bench. Agreement is evidence, not proof: the same model wrote both queries.

With a spec on the lineage example (Gemini 2.5 Flash), out-of-scope elements cut the calls from 30 to 11; the check found the mapping lacked PROV and DCMI Terms, which the spec had chosen; drafted recipes for two questions agreed with their direct Cypher answers once relationship directions were checked.

## Connections

The **Connections** tab of the studio sets what the studio talks to, while it runs:

- **Neo4j**: URL, user, password, database. *Connect* opens the database and counts its nodes before using it. An empty password keeps the one known for the same server.
- **AI model**: provider (Gemini, Anthropic, OpenAI or compatible, with its address), API key, model. *List the models* checks the key without spending tokens and offers the provider's models; *Use and try* also asks the model one tiny question and shows the time and tokens.
- **n20s-server**: its URL, checked with `/version`.

Passwords and keys stay in the studio's process: the page gets back only whether one is set and where it came from (environment, command line, set here). *Save to the env file* writes them to the `--dotenv` file (default `.env`), owner-readable only, keeping its other lines (`N20S_SOURCE`, `N20S_SOURCE_USER`, `N20S_SOURCE_PASSWORD`, `N20S_SOURCE_DATABASE`, `N20S_AI_PROVIDER`, `N20S_AI_MODEL`, `N20S_AI_BASE_URL`, the provider's key variable, `N20S_URL`); it is refused when git would commit that file (tracked, or not ignored). Nothing goes to a mapping, project, plan or recipe file. The studio answers only to its own page: host names other than 127.0.0.1 and localhost are refused before anything is served (the API, `/sparql`, `/query`, `/run`), and posts must be JSON.

## AI proposals

`propose` fills the undecided elements of a mapping with entries marked `meta.status: proposed`, `proposedBy: {kind: ai, model, promptVersion}`, `confidence` and `rationale`. They are checked and shown, not compiled, until a reviewer accepts them. The input mapping is not changed; the result goes to `--out`.

```bash
n20s-mapping propose blank.yaml --out proposed.yaml --prefix lin --base-iri https://example.org/lineage/ \
  --dotenv .env --source bolt://neo4j:$RELATE_PASSWORD@127.0.0.1:7688 --record answers.json
```

What the model decides and what it does not:

| Part | Who |
|---|---|
| Subjects of root kinds | The tool, from the smallest uniqueness or key constraint on required properties: `lin:entity/{p:0}`. Marked `proposedBy: {kind: tool}`. A root kind without one is reported for a person. |
| Properties that repeat an inherited one (same database name and type, possibly under a new id, as Aura exports subtypes) | Nobody: they are the inherited property (`inherited` or `subject` in coverage). |
| Classes, predicates, direction, qualified class, link and target, datatype overrides, map / ignore / defer with a reason | The model. |
| Qualified subjects | The tool: `lin:<class>/{start…}/{end…}` from the end-node subjects. |
| Value tables | The model says that the values are codes (`asIris`); the tool builds `lin:<property>/<value>` for the distinct values found on `--source` (more than 50: no table), else for the values the model lists. Values are never sent to the model. |

One call per node kind or relationship type, with its pending properties, the most general kinds first so that relationships see the classes of their ends. The prompt holds the target catalog (every class and property of the targets, with label, comment, definition, domains, ranges, parents and the annotations pointing to other terms, such as PROV `qualifiedForm`; plus `rdfs:label` and `rdfs:comment`), the shape of the LPG ontology, the decisions so far, and the element with its descriptions (`--no-descriptions` leaves them out). The answer follows a JSON Schema whose term fields are enums over the catalog: the model cannot name an undeclared term (`--open-terms` lifts the enums, to measure how often it would).

Each answer is validated against the schema and the rules it cannot say (every property answered once, a predicate for each map, a reason for each ignore or defer; an empty reason takes the rationale, where models tend to put it). An invalid answer gets one repair call at once. When the answer gives a qualified pattern without the unqualified predicate, or with the link as predicate, the tool sets the predicate whose target annotations point to that link (PROV `qualifiedForm`), and reports it as completed.

The result is then checked. An element with check errors gets one repair call that shows the findings; if errors remain, the element goes back to undecided and is listed as dropped. Warnings are kept for the reviewer.

The provider sits behind `complete({system, user, schema}) → {json, usage}` (`src/providers.js`): Gemini (`GEMINI_API_KEY`), Anthropic (`ANTHROPIC_API_KEY`; the answer is the input of a forced tool), any OpenAI-compatible API (`OPENAI_API_KEY`, `N20S_AI_BASE_URL` for Mistral, OpenRouter, Ollama, vLLM…: a JSON schema response, or `json_object` with the schema in the prompt when the server does not know it), a recording wrapper, a replay of a recording (tests, offline re-runs), and a function. `N20S_AI_PROVIDER` chooses (else the first key set, Gemini first), `N20S_AI_MODEL` the model; `--provider` and `--model` on the command line. A client uses its own provider by implementing that method. Only Gemini has been evaluated (eval/).

Gemini compiles the response schema into a grammar and refuses large ones ("too many states"). The answer therefore lists properties as an array (one copy of the item schema with the term enums, not one per property) and has no numeric bounds.

`--passes 3` runs three passes: the first is the proposal, and `<out>.variants.json` records, per element and property, whether the passes agree (the wording of a reason does not count, nor a datatype equal to the default). On lineage, decisions identical in all passes were right or acceptable 92% of the time, the others 65%: stability is the best risk signal, ahead of the model's confidence.

## Studio

```bash
n20s-mapping studio proposed.yaml --reviewer Pierre --dotenv .env \
  --oracle oracle.yaml --source bolt://127.0.0.1:7688 --n20s http://localhost:7474
```

A local page (127.0.0.1, default port 4321) to review proposals. The mapping file is the only state: every decision is written to it at once, YAML comments kept, and every request reads it again.

- **Graph.** The LPG ontology as drawn in the modeling tool (`extensions.display`, nodes that sit too close pushed apart), node kinds and relationship types colored by status: accepted, proposed and safe, to review, rejected, left out, undecided. Dashed lines are implied labels. Wheel to zoom, drag to pan; `#relationships/r:0` in the URL selects an element.
- **Queue.** A domain or range conflict on a predicate that comes from the typing of a node kind is credited to that node kind too, with the fix (add the expected class, or change the other mapping). Elements ranked by risk: check errors, domain, range and kind warnings (a doubtful meaning), other warnings, decisions that differ between passes, low confidence, mapped relationships (asserting what the source does not is the costly mistake), undecided properties. **Safe** means proposed, identical in every pass, confidence ≥ 0.95 and no check finding; and, for a mapped relationship, an oracle check whose SPARQL uses a term it emits passed with that very decision projected (*Run with proposals too*); a decision to leave something out is not safe when a check whose Cypher reads it failed. Stable and confident is not enough there: without descriptions, the model maps DEPENDS_ON to prov:wasDerivedFrom the same way in every pass, fully confident, and the structure fits; only the oracle sees it. A relationship type no check reads is never safe: a person decides. **Accept safe** accepts them all. Without a variants file nothing is safe.
- **Panel.** The LPG description, the decision in sentences, a before/after drawing for relationships (the LPG edge, the triples, the qualified resource), the rationale, check findings, the properties with their own decisions, and the other passes. **Accept** (with the proposed properties), **Reject** with a comment, **Edit** (terms restricted to the target catalog; saved as accepted, `proposedBy: {kind: human}`), **Ask the model** / **Reject and ask again**: the rejected proposal and the comment go into the prompt (a model needed: Connections tab or environment).
- **Oracle.** Projects the accepted entries (or the proposals too) and runs the oracle; a failure lists the rows missing or extra in RDF (an oracle, a source and n20s-server needed: `oracle:` on the mapping in the project, or `--oracle`).

Options for showing the studio: `--title <text>` (the name in the header), `--mask-hosts` (database host names shown as `••••••••`), `--replay <recording>` (the AI answers of a recording, so a demo runs the same every time; the Connections tab says so) and `--record <file>` (keeps every answer of the live model). [demo/](demo/README.md) is a narrated demo built on them.

Decisions are recorded in `meta`: `status`, `reviewedBy`, `reviewedAt`, `reviewComment`.

## Recipes

A recipe is an ordered list of steps on **named n20s graphs**. Each step **feeds** a graph, **changes** it, **asks** it, or **publishes** it:

| Step | Role | Does |
|---|---|---|
| `scope` | feeds | Cypher (with parameters) picks nodes; the mapping projects them and the relationships between them. The row queries of the plan run restricted to the subject keys of the picked nodes (`WHERE n.id IN $keys`): template projection identifies nodes by their business key, so IRIs are the same in every graph and decode back to keys. |
| `rows` | feeds | Cypher rows through an inline n20s template: computed values, or what the mapping defers. |
| `triples` | feeds | Static triples: ontology files (Turtle, N-Triples, N-Quads), shapes, inline Turtle. |
| `construct` with `from` | feeds | A CONSTRUCT on another graph (a published one) whose triples go into this one: a slice of a precomputed graph pulled into a lazy one. |
| `infer` | changes | Forward chaining under a profile (`RDFS`, `OWL_MICRO`…) and Jena rules: the inferences are materialized in the graph. |
| `construct`, `update` | changes | Derive triples into the graph, or change it. |
| `query` | asks | SPARQL SELECT; with a profile or rules, reasoning on the fly for this step only (backward). `decode` turns IRIs back into LPG keys (`node:<id>`, or `any`, which adds `<column>_kind`). |
| `validate` | asks | SHACL, over the profile and rules; violations come with the LPG node and key. |
| `explain` | asks | The derivation of a statement, each fact as LPG nodes: `DatasetVersion(…) prov:wasGeneratedBy Run(…)`. A statement materialized by an earlier `infer` explains as asserted: explain on a graph that reasons on the fly. |
| `publish` | publishes | Serves a persistent graph as `/sparql/<as>`, once the run has gone through, and only if the `validate` steps of its `gate` found no violation (fail-closed): otherwise nothing changes for the endpoint's consumers. |

**Graphs and their lifecycle.** A recipe declares its graphs; without a declaration it has one, `work`, ephemeral.

```yaml
graphs:
  work: { lifecycle: ephemeral }                                       # built for the run, dropped at the end
  kg:   { name: lineage-prov-kg, lifecycle: persistent, versioned: true } # a new version per run, to publish
  ref:  { lifecycle: published, endpoint: lineage }                     # read-only: what /sparql/lineage serves now
  client: { lifecycle: remote, sparql: "${CLIENT_KG_SPARQL}", user: CLIENT_KG_USER, password: CLIENT_KG_PASSWORD }  # the client's triple store
```

- **Ephemeral**: a name unique to the run, dropped at the end, even on error (`--keep` keeps it, to look at it). The question is answered in a graph holding only what it needs: nothing else of the LPG is projected.
- **Persistent**: outlives the run. With `start: rebuild` it is emptied when the run starts, with `start: reuse` taken as it is (to add to it, or only read it). With `versioned: true`, every run builds a new version (`lineage-prov-kg--<run>`): a `publish` step swaps the endpoint to it once it is complete and valid, then the version served before is dropped. A failed run drops its own version; the endpoint never serves a half-built or invalid graph.
- **Published**: a reference to an endpoint, resolved at run time to the graph it serves. Read it, or `construct … from` it into another graph; a recipe cannot write it.
- **Remote**: a SPARQL 1.1 endpoint outside, usually the client's own triple store (Fuseki, GraphDB, Neptune…). `construct … from` sends the CONSTRUCT there (with `$params` and `{{…}}` filled in, so it pulls only the slice the question needs) and adds the answer to the step's graph, next to the triples scoped from Neo4j; the reasoning that follows runs over both. Blank nodes are renamed per step. The URL may take `${VAR}` from the environment; `user` and `password` **name** environment variables, the recipe never holds credentials. Nothing is ever written to a remote store; the trace records which endpoint each triple came from.

**Mixing with the client's triple store.** Reading (above) is safe by construction: the mix lives in a working graph rebuilt from both sources on every run, and the reasoning starts from scratch each time, so nothing can go stale. Writing our triples into their store is not done yet; when it is, it follows three rules: one named graph per publication, ours only, replaced as a whole (Graph Store Protocol `PUT`, or a new version then `MOVE`); never a triple-level delete outside that graph (a triple asserted by another of their sources must survive ours being retracted: the union of named graphs keeps it); and reasoning on their side at query time, or with an engine that retracts its inferences (GraphDB, RDFox), since inferences they materialize from our triples would otherwise outlive them.

[`demo/project/lineage/recipes/8-personal-data-alert.recipe.yaml`](demo/project/lineage/recipes/8-personal-data-alert.recipe.yaml) does it with three sources, each for what it does best: the taint scoped from Neo4j on each call (it changes with every transaction), the owners from our published lineage endpoint (stable, precomputed, following the database), and the client's data classification ontology and catalog from their Fuseki ([`demo/client-kg/client.ttl`](demo/client-kg/client.ttl) is its initial content; it is updatable, and changes there show in the next answer). OWL runs over all three: a dataset nobody tagged is classified as personal because the client's ontology says a dataset holding an email address is one.

**What is precomputed, what is computed on demand.** Every recipe has a kind, from its graphs:

| Kind | Graphs | Typical use |
|---|---|---|
| `build` | writes a persistent graph | builds and publishes a SPARQL endpoint |
| `precomputed` | only reads published graphs (or remote stores) | a query on the published graph: nothing projected per call |
| `lazy` | only ephemeral graphs | a parametrized question: scoped and reasoned per call, only what it needs |
| `hybrid` | ephemeral and published | what changes often is scoped per call, what is stable is pulled from the published graph |

**Query APIs.** A recipe that declares an `api` is served as a parametrized query, run on each call:

```yaml
params:
  name: { type: string, default: raw.orders }   # string, integer, number, boolean, list
api:
  name: owners
  result: owners                                # the step whose result is returned (default: the last asking step)
  description: Owners of datasets with a tainted version.
```

`GET /query/owners?name=raw.orders` (or POST with a JSON body) returns the rows of the `owners` step. Values are typed as declared; unknown parameters are refused.

Steps say their `graph` when there are several. Data passing is the exception: `$name` is a recipe parameter, `$step.column` the values of a column of an earlier step, `$step.column[0]` the first. In a step's `params` they become Cypher parameters; in SPARQL, `{{<node id>|expr}}` gives the IRIs of that kind (a list gives several terms, for `VALUES`), `{{literal|expr}}` literals (escaped), `{{iri|expr}}` IRIs (a value holding a character an IRI cannot, `<>"{}|^\`\\`, space or control, is refused: it could close the IRI and add SPARQL of its own). Prefixed names of the mapping and of the recipe's `prefixes` work in SPARQL, Turtle, Jena rules and templates. The run returns, per step, the state of its graph after it (triples and change) and every statement sent (Cypher with parameters, SPARQL, rules, profile): the trace replays it.

[`examples/lineage/recipes`](examples/lineage/recipes):

| Recipe | Kind | Shows |
|---|---|---|
| 1 upstream sources | lazy | a 6-node graph answers q33 |
| 2 influences | lazy | no answer before PROV-O is in the graph, RDFS answers after |
| 3 tainted versions | lazy | a Jena rule, a SHACL shape, the violation explained down to the LPG facts |
| 4 owners to notify | lazy, `/query/owners-to-notify` | the SPARQL result becomes the parameter of a second scope |
| 5 lineage KG | build | a versioned graph: full projection, PROV-O, shapes checked then taken out, RDFS closure materialized, published as `/sparql/lineage` behind the check (3,833 triples) |
| 6 ask the lineage KG | precomputed, `/query/influences` | a plain query on the published closure, no reasoning needed |
| 7 owners, hybrid | hybrid, `/query/owners` | the taint scoped per call, ownership pulled from `/sparql/lineage` with `construct … from` |

```bash
n20s-mapping recipe examples/lineage/recipes/5-lineage-kg.recipe.yaml     # publishes /sparql/lineage
n20s-mapping recipe examples/lineage/recipes/7-owners-hybrid.recipe.yaml --param name=raw.orders
n20s-mapping republish lineage --recipes examples/lineage/recipes          # same recipe, same parameters: new version, gated, swapped
n20s-mapping unpublish lineage --recipes examples/lineage/recipes
```

**Stable or not.** Every run that writes a persistent graph or publishes one is recorded in `graphs.json`, next to the recipes (ignored by git): recipe, run, time, parameters, the mapping (by its compiled plan: a review that changes no triple does not count) and LPG ontology hashes, source, size, and per endpoint the graph it serves, its gates and the version it replaced. `n20s-mapping graphs <recipes dir>` compares that with n20s-server:

| Status | Means |
|---|---|
| `stable` | Built by a recipe that finished, from the mapping and LPG ontology as they are now, with the size it had. |
| `stale` | The mapping or the LPG ontology changed since, or the size did: re-publish it. |
| `incomplete` | The last build stopped on an error. |
| `missing` | Recorded but not in n20s-server, which keeps graphs in memory: a restart empties it. |
| `unknown` | In n20s-server, built by no recipe of the directory (an ephemeral graph kept with `--keep`, another tool). |

**Following the database.** A published endpoint can follow the database (*Follow the database* in its panel, or `n20s-mapping follow <endpoint> --recipes <dir>`): Neo4j change data capture says which transactions committed since the last look (every 1.5 s); when one touches a label or relationship type the publication is built from (its recipe's mapping; any change at all when the recipe has free Cypher `rows` steps), the publication is rebuilt with the same recipe and parameters, through its gates, and swapped in, exactly as *Re-publish*. A transaction the database rolled back changes nothing, so nothing is rebuilt. The studio and `serve` do the following, for every mapping of the project; the endpoint panel shows the last change, the last rebuild and what it serves now, and the state is kept in `graphs.json` (`follow`: cursor, what is watched, counts). On the Aura instance of the demo, a committed transaction is in the published graph about three seconds later.

It needs change data capture in **FULL** mode (Neo4j Enterprise 5.13+; on Aura, instance → ⋯ → Change Data Capture → FULL): FULL rather than DIFF because the state before and after a change carries the subject key even when another property changed, which the next step needs. Without it the option is off and says how to enable it; on Relate and Community there is none. **Next:** re-scope only the keys that changed into a new version (their triples out, the rows of the plan for those keys in, the closure again) instead of rebuilding.

**Endpoints.** `n20s-mapping serve <recipes dir>` (127.0.0.1:7480 by default; also mounted in the studio):

| Endpoint | Does |
|---|---|
| `GET /sparql` | The published endpoints, with the status of the graph each one serves. |
| `GET\|POST /sparql/<endpoint>` | SPARQL 1.1 Protocol, read-only: SELECT and ASK give `application/sparql-results+json`, CONSTRUCT `application/n-triples`; updates are refused. Only published endpoints, by name (never a graph name); `X-N20s-Graph-Status` and `X-N20s-Graph` say what is served. |
| `GET /query` | The query APIs, with their parameters, types and kind. |
| `GET\|POST /query/<api>` | Runs the recipe with these parameters and returns its result step: rows, or violations. `?trace` adds the full run. |
| `GET /run`, `POST /run/<recipe>` | Any recipe, by id: only with `serve --run` (and in the studio). A run is a `POST` with an `application/json` body (its parameters): never a `GET` (405) nor a form post (415), since a run can change and publish graphs. |

The endpoint asks n20s-server for terms (`terms: true`): literals keep their datatype and language.

**In the studio**, the **Recipes** tab lists the recipes (with their kind and API), the SPARQL endpoints, the query APIs, and the graphs of n20s-server with their status. A recipe shows as its sequence of steps (role, graph, state of the graph after the step, result); a step's panel edits it and, after a run, shows what its graph holds (classes and predicates with counts). Recipes are built from scratch there: **New recipe**, graphs (ephemeral, persistent and versioned, or published), parameters, **publish as API**, steps added from a skeleton for their type (`publish` included), moved, deleted, every field edited; each change is written to the file at once, comments kept, and checked as you go. An endpoint's panel shows what it serves and how it was published, **Re-publish** (the same recipe and parameters: a new version, through its gates, swapped in), **Unpublish**, and a SPARQL console on the endpoint; an API's panel has a form for its parameters and **Call**; a graph's panel shows where it comes from and a console on it.

## Bench

A Postman-like bench for what the recipes publish, and for recipes before they are published. A collection, `bench.yaml` next to the recipes (versioned with them), holds requests:

```yaml
format: n20s-bench/0.1
requests:
  - id: owners-hybrid
    target: { query: owners }                  # published API: GET /query/owners
    params: { name: raw.orders }
    expect: { status: 200, rows: 2, contains: [{ agent: Alice }], maxMs: 500 }
  - id: lineage-size
    target: { sparql: lineage }                # published endpoint: POST /sparql/lineage
    sparql: SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }
    expect: { rows: 1, contains: [{ n: 3833 }] }
  - id: tainted-draft
    target: { recipe: tainted-versions }       # not published yet: POST /run/tainted-versions
    expect: { rows: 4 }
```

`expect` takes `status` (200 by default), `rows`, `minRows`, `maxRows`, `contains` (rows that must be there, compared as strings) and `maxMs`. Rows are read the same way from every endpoint: the result step of an API or recipe, SPARQL JSON bindings, or `{boolean}` for ASK.

```bash
n20s-mapping serve examples/lineage/recipes --run &                 # --run for draft recipes
n20s-mapping bench examples/lineage/recipes/bench.yaml --url http://127.0.0.1:7480
n20s-mapping bench examples/lineage/recipes/bench.yaml --iterations 30 --concurrency 4   # and time them
```

`bench` exits with 1 when a request does not answer as expected, for CI. With `--iterations`, each request is also timed: warm-up calls first, then the iterations with at most `--concurrency` in flight; min, p50, p90, p95, p99, max, mean and requests per second. On the lineage example (Relate, n20s-server, concurrency 4), the same question costs p50 ≈ 150 ms lazy, ≈ 120 ms hybrid, ≈ 55 ms precomputed: what precomputation buys.

In the studio, the **Bench** tab lists the collection with the last status, time and p50 of each request. Its editor picks the target among the published APIs and endpoints and the recipes (draft), shows the parameters the target declares, the expectations and the HTTP request it builds; **Send** shows the response (status, time, checks, headers, rows, raw body) and keeps a history; **Save** writes the request to `bench.yaml` (comments kept). **Run benchmark** times the request (iterations, concurrency, warm-up) with a latency histogram; **Send all** checks the whole collection; **Benchmark all** compares every request side by side. The page and the CLI use the same engine (`src/bench.js`).

**Evaluation.** [`eval/propose-lineage.js`](eval/propose-lineage.js) runs `propose` on the Aura export of the lineage model, starting from no entries, and compares with the hand-made mapping moved onto the export (`lineage-prov.aura.mapping.yaml`, generated by `eval/rekey-gold.js`). Three conditions: the export as is, without descriptions, and relationships only with the gold node decisions. Per decision: agree, acceptable (`rdfs:label` or `rdfs:comment` on a property the gold leaves out: descriptive metadata kept, not a wrong meaning), related (sub or super term), different, false map, false ignore, ignore vs defer; plus stability across passes, calibration of the confidence, check findings, repairs, and the oracle on the proposals accepted in a copy (with `RELATE_BIN` and `N20S_JAR`). `--gold-answers` replaces the model with the gold, to check the evaluation itself: everything agrees and the oracle passes.

**Evaluation sets.** [`eval/propose-eval.js --set <dir>`](eval/propose-eval.js) runs the same evaluation on any set: a directory with an `eval.yaml` manifest naming the LPG export, the gold, the acceptable **alternatives** (decisions as good as the gold, counted as right: an inverse property reversed, a deferral for an ignore), the oracle, the seed data, the prefix of generated IRIs, the **traps** to follow (what should catch each one: the check, an oracle check), and **frozen** fingerprints: the gold, alternatives and oracle are decided before any model sees the set, and the evaluation refuses to run when one of them changed. Conditions add `open-terms` (no term lists in the answer schema: the model may invent terms, and the check must catch them). The report starts with the commit (and whether the tree differs from it), the SHA-256 of the set's files and of `src/`, the prompt version and the model. Its **safety net** classes every wrong decision (neither gold nor alternative) by severity: **false assertion** (a false map, another term, an extra class), **omission** (a false ignore, a missing class or qualified form), **benign** (ignore instead of defer, a qualified form on top of the gold's predicate); and says, for the false assertions and omissions, whether the check caught it (a finding on the entry, or a domain or range conflict elsewhere that comes from its typing: Rig typed only sosa:Platform shows on ON), the oracle (a failing check whose Cypher reads the element and whose SPARQL asks about a term of the proposal or of the gold), both, or neither; and how precise Accept safe is: after an oracle run on the proposals, which elements it would accept, and how many of them hold a false assertion or an omission. A replay (`--replay`) re-reads the recorded answers with the code of now and writes its report next to the run's (`…-replay`); `--fingerprints` prints them and stops. `--answers <mapping>` makes the model answer a given mapping, to test the evaluation itself (alternatives, traps). Two sets: `examples/lineage` (`eval/propose-lineage.js` is a shortcut) and [`examples/sensors`](examples/sensors): plant telemetry to W3C SOSA, a client's model whose names never repeat the target terms, with 4000 readings, traps (a unit with no SOSA term, a reading time tempting `sosa:phenomenonTime` with a literal, rollups related to their inputs by no SOSA term, alarm limits) and an oracle of 11 questions.

## Coverage

Every node kind, relationship type and property is counted as **decided** (`mapped`, `ignored`, `deferred`, `subject`: used in the IRI, `inherited`: handled through an implied kind, including a property that repeats an inherited one) or **pending** (`proposed`: awaiting review, an ignore included; `undecided`: no entry). Rejected entries count as no entry. The undecided list is the to-do list of a mapping session.

## Known limits

- **Structural checks do not catch a wrong meaning.** Mapping `DEPENDS_ON` to `prov:wasDerivedFrom` passes: Entity to Entity fits the domain and the range. The oracle catches it (see above).
- Value tables are checked against `one_of`, not against the values actually present in the data.
- Two relationships of the same type between the same pair of nodes share one qualified resource when the qualified subject uses only start and end values.
- `kind: iri` without a value table takes the value as the IRI: n20s uses a whole-placeholder value as is when it is an absolute IRI, and percent-encodes any other value (a relative IRI then, which is not what you want: check the data).
- The oracle decodes `node:` columns only for subjects with one placeholder.
- n20s-server needs Java 21 and neo4j-n20s `f460c1f` or later (see Requirements): the SPARQL endpoint asks for terms, so literals keep their datatype and language.
- Rows reach n20s-server as JSON, so temporal values are sent as XSD strings with an explicit datatype (source.js). Inside Neo4j, the n20s plugin writes Neo4j temporal values in their XSD form itself.

## Library use

```js
// Browser-safe: no file system, no driver.
import { check, compile, project, runOracle, n20sClient, fillTemplate, matchTemplate, propose, geminiProvider } from 'n20s-mapping';
// Node: files and the Bolt source.
import { checkFiles, lockFiles, compileFiles, proposeFiles, sourceValues, openSource, splitStatements } from 'n20s-mapping/node';

const { plan } = await compile(mapping, lpgDoc);
const source = openSource('neo4j+s://…');            // or bolt://127.0.0.1:7688 for Relate
await project({ plan, source, n20s: n20sClient(), graph: 'lineage' });
```

`project` and `runOracle` take any object with `run(cypher, params)` as the source, so a studio can pass its own (for instance a Query API client).

`check()` imports its JSON Schemas with import attributes (`with { type: 'json' }`): Node 22+ or a recent browser or bundler.

## Vendored files

- `vendor/ontology-graph-spec-1.1.0.schema.json`: from `https://neo4j.com/docs/ontology-graph-spec/1.1.0/schema.json`.
- `examples/lineage/targets/prov.nq`: the W3C PROV namespace document (PROV-O and its extensions), as packaged in npm `@vocabulary/prov` 1.0.6.
- `examples/lineage/data-lineage-ontology.json`: `data-lineage-lpg` v3, as exported.
- `examples/lineage/aura-export.json`: the same model as exported by the Aura ontology tool: generated ids (`n:0`, `r:0`, `p:0`), no `reference` to PROV terms, no `one_of`, no cardinalities, inherited properties repeated on subtypes.
- `examples/lineage/seed.cypher`: the data of the lineage queries (statements 03 to 29 of the saved queries).

## Tests

`npm test` runs the checker, compiler and oracle tests. The end-to-end test starts Relate and n20s-server itself, and runs only when both are available:

```bash
RELATE_BIN=/path/to/relate N20S_JAR=/path/to/n20s-server-1.1.0-SNAPSHOT.jar npm test
```

With `FUSEKI_JAR` (the standalone `org.apache.jena:jena-fuseki-server` jar) as well, the mixed-sources test starts a Fuseki serving `demo/client-kg/client.ttl` and runs the act 3 recipe against it.
