import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sparqlTerm, queryForm, selectVars } from '../src/endpoints.js';
import { recordRun, graphStatuses, emptyRegistry, retire, publicationStatuses, unpublish } from '../src/graphs.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

test('sparqlTerm: n20s row terms as SPARQL JSON terms', () => {
  assert.deepEqual(sparqlTerm(5), { type: 'literal', value: '5', datatype: `${XSD}integer` });
  assert.deepEqual(sparqlTerm(true), { type: 'literal', value: 'true', datatype: `${XSD}boolean` });
  assert.deepEqual(sparqlTerm('https://example.org/a#b'), { type: 'uri', value: 'https://example.org/a#b' });
  assert.deepEqual(sparqlTerm('urn:x:1'), { type: 'uri', value: 'urn:x:1' });
  assert.deepEqual(sparqlTerm('"demo:lineage:v2:dsv:x@1"'), { type: 'literal', value: 'demo:lineage:v2:dsv:x@1' }, 'an LPG id is a quoted literal');
  assert.deepEqual(sparqlTerm(`"2024-05-01T10:00:00Z"^^<${XSD}dateTime>`), { type: 'literal', value: '2024-05-01T10:00:00Z', datatype: `${XSD}dateTime` });
  assert.deepEqual(sparqlTerm('_:b0'), { type: 'bnode', value: 'b0' });
  assert.deepEqual(sparqlTerm('"a\\"b"@fr'), { type: 'literal', value: 'a"b', 'xml:lang': 'fr' });
  assert.deepEqual(sparqlTerm(`"1"^^<${XSD}int>`), { type: 'literal', value: '1', datatype: `${XSD}int` });
  assert.equal(sparqlTerm(null), undefined);
});

test('queryForm and selectVars: after prefixes and comments, # in IRIs is not a comment', () => {
  const q = 'PREFIX prov: <http://www.w3.org/ns/prov#>\n# a comment\nSELECT DISTINCT ?v (COUNT(?x) AS ?n) WHERE { ?v prov:used ?x } GROUP BY ?v';
  assert.equal(queryForm(q), 'SELECT');
  assert.deepEqual(selectVars(q), ['v', 'n']);
  assert.equal(selectVars('SELECT * WHERE { ?s ?p ?o }'), null);
  assert.equal(queryForm('BASE <http://x/> ASK { ?s ?p ?o }'), 'ASK');
  assert.equal(queryForm('PREFIX : <http://x#> INSERT DATA { :a :b :c }'), 'INSERT');
});

test('registry: builds recorded per persistent graph; statuses from what n20s holds and what changed', () => {
  const prov = { mapping: { id: 'm', contentHash: 'h1' }, lpg: { id: 'l', version: '1', contentHash: 'l1' } };
  const run = (ok, triples, start = 'rebuild') => ({ recipe: 'kg', runId: 'r1', ok, params: {}, graphs: {
    kg: { name: 'lineage-kg', lifecycle: 'persistent', start, written: true, triples },
    work: { name: 'recipe-kg-r1-work', lifecycle: 'ephemeral', written: true, triples: 3 },
    ref: { name: 'other-kg', lifecycle: 'persistent', start: 'reuse', written: false, triples: 9 },
  } });
  let reg = recordRun(emptyRegistry(), run(true, 100), { file: 'kg.recipe.yaml', provenance: prov });
  assert.deepEqual(Object.keys(reg.graphs), ['lineage-kg'], 'only persistent graphs the run wrote');
  const live = [{ graphName: 'lineage-kg', tripleCount: 100 }, { graphName: 'recipe-x-1-work', tripleCount: 4 }];
  const st = (r, l, cur = { 'kg.recipe.yaml': prov }) => Object.fromEntries(graphStatuses(r, l, cur).map((g) => [g.name, [g.status, ...g.reasons]]));
  assert.deepEqual(st(reg, live), { 'lineage-kg': ['stable'], 'recipe-x-1-work': ['unknown', 'an ephemeral graph kept after its run (--keep)'] });
  assert.deepEqual(st(reg, live, { 'kg.recipe.yaml': { ...prov, mapping: { id: 'm', contentHash: 'h2' } } })['lineage-kg'], ['stale', 'the mapping changed since the build']);
  assert.match(st(reg, live, { 'kg.recipe.yaml': { ...prov, lpg: { id: 'l', version: '2', contentHash: 'l2' } } })['lineage-kg'][1], /built from v1, now v2/);
  assert.deepEqual(st(reg, [{ graphName: 'lineage-kg', tripleCount: 120 }])['lineage-kg'], ['stale', '120 triples now, 100 when built']);
  assert.deepEqual(st(reg, [])['lineage-kg'], ['missing']);
  reg = recordRun(reg, run(false, 40), { file: 'kg.recipe.yaml', provenance: prov });
  assert.deepEqual(st(reg, [{ graphName: 'lineage-kg', tripleCount: 40 }])['lineage-kg'], ['incomplete']);
  const added = recordRun(reg, run(true, 140, 'reuse'), { file: 'kg.recipe.yaml', provenance: prov });
  assert.equal(added.graphs['lineage-kg'].basedOn.runId, 'r1', 'start: reuse builds on the previous build');
});

test('publication: the endpoint swaps to the new version once the run went through; old and failed versions retire', () => {
  const prov = { mapping: { id: 'm', contentHash: 'h1' }, lpg: { id: 'l', version: '1', contentHash: 'l1' } };
  const run = (id, ok, publish = ok) => ({ recipe: 'kg', runId: id, ok, params: {},
    graphs: { kg: { name: `lineage--${id}`, base: 'lineage', versioned: true, lifecycle: 'persistent', start: 'rebuild', written: true, triples: 10 } },
    publications: publish ? [{ as: 'lineage', graph: `lineage--${id}`, base: 'lineage', description: null, gate: [] }] : [] });
  const step = (reg, r) => retire(recordRun(reg, r, { file: 'kg.recipe.yaml', provenance: prov }), r);

  let { registry, drop } = step(emptyRegistry(), run('a', true));
  assert.equal(registry.publications.lineage.graph, 'lineage--a');
  assert.deepEqual(drop, []);
  ({ registry, drop } = step(registry, run('b', true)));
  assert.equal(registry.publications.lineage.graph, 'lineage--b');
  assert.deepEqual(registry.publications.lineage.replaced.graph, 'lineage--a');
  assert.deepEqual(drop, ['lineage--a'], 'the version served before the swap');
  ({ registry, drop } = step(registry, run('c', false)));
  assert.equal(registry.publications.lineage.graph, 'lineage--b', 'a failed run publishes nothing');
  assert.deepEqual(drop, ['lineage--c'], 'and its version goes');
  assert.deepEqual(Object.keys(registry.graphs), ['lineage--b']);

  const live = [{ graphName: 'lineage--b', tripleCount: 10 }];
  const statuses = graphStatuses(registry, live, { 'kg.recipe.yaml': prov });
  assert.deepEqual(statuses.map((g) => [g.name, g.status, g.endpoints]), [['lineage--b', 'stable', ['lineage']]]);
  assert.deepEqual(publicationStatuses(registry, statuses).map((e) => [e.endpoint, e.graph, e.status]), [['lineage', 'lineage--b', 'stable']]);
  assert.deepEqual(publicationStatuses(registry, graphStatuses(registry, [], {})).map((e) => e.status), ['missing']);

  const u = unpublish(registry, 'lineage');
  assert.deepEqual([Object.keys(u.registry.publications), u.graph], [[], 'lineage--b']);
});

test('bench: requests by target, rows from any endpoint, checks, statistics', async () => {
  const { httpRequest, rowsOf, checkExpect, stats, checkBench, send } = await import('../src/bench.js');
  assert.deepEqual(httpRequest({ target: { query: 'owners' }, params: { name: 'raw.orders', ids: ['a', 'b'] } }, 'http://h:1'), { method: 'GET', url: 'http://h:1/query/owners?name=raw.orders&ids=a%2Cb', headers: {}, body: null });
  assert.equal(httpRequest({ target: { sparql: 'lineage' }, sparql: 'ASK {}' }, 'http://h:1/').method, 'POST');
  assert.equal(httpRequest({ target: { recipe: 'r' }, params: { x: 1 } }, 'http://h:1/').body, '{"x":1}');
  assert.deepEqual(rowsOf({ head: { vars: ['n'] }, results: { bindings: [{ n: { type: 'literal', value: '5' } }] } }), [{ n: '5' }]);
  assert.deepEqual(rowsOf({ head: {}, boolean: true }), [{ boolean: true }]);
  assert.deepEqual(rowsOf({ result: { rows: [{ a: 1 }] } }), [{ a: 1 }]);
  const res = { status: 200, ms: 40, rows: [{ agent: 'Alice' }, { agent: 'Bob' }] };
  assert.deepEqual(checkExpect({ rows: 2, contains: [{ agent: 'Alice' }], maxMs: 30 }, res).map((c) => [c.name, c.ok]), [['status', true], ['rows = 2', true], ['contains {"agent":"Alice"}', true], ['≤ 30 ms', false]]);
  assert.deepEqual(stats([{ ms: 10, ok: true }, { ms: 30, ok: true }, { ms: 20, ok: true }, { ms: 99, ok: false }]), { count: 4, errors: 1, min: 10, p50: 20, p90: 30, p95: 30, p99: 30, max: 30, mean: 20 });
  assert.deepEqual(checkBench({ format: 'n20s-bench/0.1', requests: [{ id: 'a', target: { sparql: 'x' } }, { id: 'a', target: {} }] }), ['a: a sparql target needs sparql.', 'a: id used twice.', 'a: target needs exactly one of query, sparql, recipe.']);
  const down = await send({ id: 'x', target: { query: 'q' }, expect: { status: 200 } }, 'http://h:1/', { fetch: async () => { throw new Error('refused'); } });
  assert.deepEqual([down.status, down.error, down.checks[0].ok], [0, 'refused', false]);
});
