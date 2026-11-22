// Competency questions as a validated oracle: parameter cases, checks from a
// drafted recipe, fingerprints, and coverage (what covers, what is suspected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { runOracle, checkFromDraft, checkFingerprint, coverage, oracleEvidence, compile, acceptAll, sparqlTerms, cypherReads, readsRelationship, emittedTerms, reliesOf, returnColumns } from '../src/index.js';
import { EXAMPLE, auraDoc, auraGold } from './helpers.js';

const auraOracle = YAML.parse(fs.readFileSync(path.join(EXAMPLE, 'oracle.aura.yaml'), 'utf8'));
const LIN = 'https://example.org/lineage/';

test('cases: a check runs once per parameter case; two empty answers pass but prove nothing', async () => {
  const check = {
    id: 'c', mode: 'equal', columns: ['source'], decode: { source: 'node:n:0' },
    cypher: 'MATCH (:DatasetVersion {id: $version})-[:WAS_DERIVED_FROM]->(s) RETURN s.id AS source',
    sparql: 'SELECT ?source WHERE { <{{n:0|$version}}> prov:wasDerivedFrom ?source . ?source rdfs:label {{literal|$label}} }',
    cases: [{ params: { version: 'a@1', label: 'x "y"' } }, { params: { version: 'b@2', label: 'z' } }],
  };
  const sent = [];
  const answers = { 'a@1': [{ source: 's@1' }], 'b@2': [] };
  const source = { run: async (cy, p) => answers[p.version] };
  const n20s = { query: async (g, sparql) => { sent.push(sparql); return sparql.includes('a%401') || sparql.includes('a@1') ? [{ source: `${LIN}entity/s%401` }] : []; } };
  let [r] = await runOracle({ oracle: { prefixes: '', checks: [check] }, mapping: auraGold, lpgDoc: auraDoc, source, n20s, graph: 'g' });
  assert.equal(r.status, 'pass', JSON.stringify(r));
  assert.equal(r.nonEmpty, true);
  assert.deepEqual(r.cases.map((c) => [c.status, c.empty]), [['pass', false], ['pass', true]]);
  assert.match(sent[0], /<https:\/\/example\.org\/lineage\/entity\/a%401> prov:wasDerivedFrom \?source \. \?source rdfs:label "x \\"y\\""/);

  [r] = await runOracle({ oracle: { prefixes: '', checks: [{ ...check, cases: [{ params: { version: 'b@2', label: 'z' } }] }] }, mapping: auraGold, lpgDoc: auraDoc, source, n20s, graph: 'g' });
  assert.equal(r.status, 'pass');
  assert.equal(r.nonEmpty, false, 'equal on two empty answers');

  [r] = await runOracle({ oracle: { prefixes: '', checks: [{ ...check, cases: [{ params: { version: 'a@1' } }] }] }, mapping: auraGold, lpgDoc: auraDoc, source, n20s, graph: 'g' });
  assert.equal(r.status, 'error');
  assert.match(r.error, /\$label has no value in this case/);
});

/** A recipe as the Design tab drafts it (recipeFromDraft): a scope and a query. */
const drafted = {
  format: 'n20s-recipe/0.1', id: 'upstream', title: 'Upstream sources', mapping: 'x.yaml',
  params: { version: { default: 'demo:lineage:v2:dsv:dash.revenue@31' } },
  steps: [
    { id: 'scope', type: 'scope', cypher: 'MATCH p = (:DatasetVersion {id: $version})-[:WAS_DERIVED_FROM*]->() RETURN p' },
    { id: 'answer', type: 'query', sparql: 'SELECT DISTINCT ?source WHERE { {{n:0|$version}} prov:wasDerivedFrom+ ?source . ?source a lin:Thing }', decode: { source: 'node:n:0' } },
  ],
};
const cypher = 'MATCH (:DatasetVersion {id: $version})-[:WAS_DERIVED_FROM]->{1,10}(s:DatasetVersion) RETURN DISTINCT s.id AS source ORDER BY source';

test('checkFromDraft: the validated Cypher, the recipe\'s SPARQL with its placeholders, decode, cases, missing prefixes', () => {
  const c = checkFromDraft({ recipe: drafted, cypher, cases: [{ params: { version: 'v1', other: 1 } }, { params: { version: 'v2' } }], id: 'cq-upstream', question: 'Where does it come from?', mapping: auraGold, oraclePrefixes: 'PREFIX prov: <http://www.w3.org/ns/prov#>\n' });
  assert.deepEqual(c.columns, ['source']);
  assert.deepEqual(c.decode, { source: 'node:n:0' });
  assert.deepEqual(c.cases, [{ params: { version: 'v1' } }, { params: { version: 'v2' } }], 'only the parameters the queries use');
  assert.match(c.sparql, /^PREFIX lin: <https:\/\/example\.org\/lineage\/>\n/, 'lin: is not in the oracle prefixes, prov: is');
  assert.doesNotMatch(c.sparql, /PREFIX prov:/);
  assert.match(c.sparql, /<\{\{n:0\|\$version\}\}> prov:wasDerivedFrom\+/);
  assert.equal(c.mode, 'equal');

  assert.throws(() => checkFromDraft({ recipe: { ...drafted, steps: [drafted.steps[0], { ...drafted.steps[1], profile: 'RDFS' }] }, cypher, cases: [{ params: { version: 'v' } }], id: 'x', mapping: auraGold }), /reasons \(profile or rules\)/);
  assert.throws(() => checkFromDraft({ recipe: drafted, cypher: 'MATCH (n) RETURN n.id AS other', cases: [], id: 'x', mapping: auraGold }), /need a column in common/);
  assert.throws(() => checkFromDraft({ recipe: { ...drafted, steps: [drafted.steps[0], { ...drafted.steps[1], decode: { source: 'any' } }] }, cypher, cases: [{ params: { version: 'v' } }], id: 'x', mapping: auraGold }), /any is not a check decoder/);
  assert.throws(() => checkFromDraft({ recipe: drafted, cypher, cases: [{ params: {} }], id: 'x', mapping: auraGold }), /no value for \$version/);
  assert.deepEqual(returnColumns('MATCH (a) WITH a RETURN a.id AS x, a, count(*) AS n'), ['x', 'a', 'n']);
});

test('a check edited after its validation is to revalidate', () => {
  const c = auraOracle.checks.find((x) => x.id.startsWith('q33'));
  assert.equal(checkFingerprint(c), checkFingerprint(structuredClone(c)));
  assert.notEqual(checkFingerprint(c), checkFingerprint({ ...c, cypher: `${c.cypher} LIMIT 5` }));
  assert.notEqual(checkFingerprint(c), checkFingerprint({ ...c, cases: [{ params: { a: 1 } }] }));
});

async function evidenceOf(mapping, oracle, status, nonEmpty = () => true) {
  const projected = acceptAll(mapping);
  const { plan } = await compile(projected, auraDoc);
  const results = oracle.checks.map((c) => ({ id: c.id, status: c.expressible === false ? 'not-expressible' : status(c.id), nonEmpty: nonEmpty(c.id) }));
  return { plan, evidence: oracleEvidence({ oracle, results, mapping: projected, lpgDoc: auraDoc, plan, withProposals: true }) };
}

test('coverage: on lineage, relationships are covered exactly as Accept safe covered them', async () => {
  const { plan, evidence } = await evidenceOf(auraGold, auraOracle, () => 'pass');
  const cov = coverage({ oracle: auraOracle, evidence, mapping: auraGold, lpgDoc: auraDoc, plan });
  const emitted = emittedTerms(plan);
  for (const d of cov.decisions.filter((x) => x.section === 'relationships' && x.kind === 'mapped' && !x.path.includes('/properties/'))) {
    const id = d.path.split('/')[1];
    // The rule as review.js had it: passed, SPARQL uses an emitted term, Cypher reads the relationship with its ends.
    const before = auraOracle.checks.filter((c) => c.expressible !== false && [...sparqlTerms(c, auraOracle.prefixes)].some((t) => (emitted[d.path] ?? []).includes(t)) && readsRelationship(cypherReads(c), auraDoc, id)).map((c) => c.id);
    assert.deepEqual(d.counted, before, d.path);
  }
  assert.ok(cov.summary.covered > 0);
  const n4 = cov.decisions.find((d) => d.path === 'nodes/n:4/properties/p:12');
  assert.ok(n4, 'property decisions are listed');
});

test('coverage: an empty answer covers nothing; blame is wider than coverage', async () => {
  const q33 = auraOracle.checks.find((c) => c.id.startsWith('q33')).id;
  let { plan, evidence } = await evidenceOf(auraGold, auraOracle, () => 'pass', (id) => id !== q33);
  let cov = coverage({ oracle: auraOracle, evidence, mapping: auraGold, lpgDoc: auraDoc, plan });
  const wdf = cov.decisions.find((d) => d.label === '(DatasetVersion)-[:WAS_DERIVED_FROM]->(DatasetVersion)');
  const c33 = wdf.covering.find((c) => c.id === q33);
  assert.equal(c33.counts, false);
  assert.match(c33.why, /answers nothing/);

  // DEPENDS_ON -> prov:wasDerivedFrom: q33 reads WAS_DERIVED_FROM only, and fails: DEPENDS_ON is suspected, not covered.
  const mapping = structuredClone(auraGold);
  mapping.relationships['r:2'] = { predicate: 'prov:wasDerivedFrom', meta: { status: 'proposed' } };
  ({ plan, evidence } = await evidenceOf(mapping, auraOracle, (id) => (id === q33 ? 'fail' : 'pass')));
  cov = coverage({ oracle: auraOracle, evidence, mapping, lpgDoc: auraDoc, plan });
  const dep = cov.decisions.find((d) => d.path === 'relationships/r:2');
  assert.ok(dep.suspects.includes(q33), JSON.stringify(dep));
  assert.ok(!dep.covering.some((c) => c.id === q33));
});

test('coverage: a check drafted from a proposed decision does not cover it; once accepted it does, shown as drafted from it', async () => {
  const mapping = structuredClone(auraGold);
  mapping.relationships['r:0'] = { ...mapping.relationships['r:0'], meta: { status: 'proposed' } };
  const { plan: proposedPlan } = await compile(acceptAll(mapping), auraDoc);
  const base = {
    id: 'cq-used', mode: 'equal', columns: ['input'], decode: { input: 'node:n:0' },
    cypher: "MATCH (:Run {id: $run})-[:USED]->(v:DatasetVersion) RETURN v.id AS input",
    sparql: 'SELECT ?input WHERE { <{{n:1|$run}}> prov:used ?input }', cases: [{ params: { run: 'r1' } }],
  };
  const relies = reliesOf(base, { mapping, lpgDoc: auraDoc, plan: proposedPlan, prefixes: auraOracle.prefixes });
  assert.deepEqual(relies.map((r) => [r.path, r.status]), [['relationships/r:0', 'proposed']]);
  const check = { ...base, validated: { by: 'pierre', at: 'now', fingerprint: checkFingerprint(base), relies } };
  const oracle = { ...auraOracle, checks: [check] };
  const at = async (m) => {
    const { plan, evidence } = await evidenceOf(m, oracle, () => 'pass');
    return coverage({ oracle, evidence, mapping: m, lpgDoc: auraDoc, plan }).decisions.find((d) => d.path === 'relationships/r:0').covering[0];
  };
  let c = await at(mapping);
  assert.equal(c.counts, false);
  assert.match(c.why, /drafted from this decision while it is proposed/);
  mapping.relationships['r:0'].meta.status = 'accepted';
  c = await at(mapping);
  assert.deepEqual([c.counts, c.draftedFrom], [true, true]);
  // Another decision than the one it was drafted from: an independent check.
  mapping.relationships['r:0'] = { ...mapping.relationships['r:0'], properties: {} };
  c = await at(mapping);
  assert.deepEqual([c.counts, c.draftedFrom], [true, false]);
  // Edited by hand after its validation: to revalidate.
  const edited = { ...auraOracle, checks: [{ ...check, cypher: `${check.cypher} LIMIT 3` }] };
  const { plan, evidence } = await evidenceOf(mapping, edited, () => 'pass');
  c = coverage({ oracle: edited, evidence, mapping, lpgDoc: auraDoc, plan }).decisions.find((d) => d.path === 'relationships/r:0').covering[0];
  assert.match(c.why, /to revalidate/);
});
