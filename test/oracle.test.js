// The oracle logic with stub sources: decoding, equal and disjoint modes.
// The real run against Relate and n20s-server is in e2e.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOracle } from '../src/index.js';
import { baseMapping, baseDoc } from './helpers.js';

const LIN = 'https://example.org/lineage/';
const stub = (rows) => ({ run: async () => rows, query: async () => rows });

function oracle(check) {
  return { prefixes: '', checks: [{ id: 'c', columns: Object.keys(check.decode ?? { x: 0 }), ...check }] };
}

async function run(check, cypherRows, sparqlRows) {
  let sent;
  const n20s = { query: async (graph, sparql) => { sent = sparql; return sparqlRows; } };
  const [r] = await runOracle({ oracle: oracle(check), mapping: baseMapping, lpgDoc: baseDoc, source: stub(cypherRows), n20s, graph: 'g' });
  return { r, sent };
}

test('SPARQL IRIs are decoded with the subject template and value tables', async () => {
  const { r, sent } = await run(
    {
      columns: ['run', 'role'],
      decode: { run: 'node:activity', role: 'values:relationships/was-associated-with/properties/role' },
      cypher: 'irrelevant',
      sparql: 'SELECT * WHERE { <{{entity|demo:x@1}}> ?p ?o }',
    },
    [{ run: 'demo:run:1', role: 'executor' }],
    [{ run: `${LIN}activity/demo%3Arun%3A1`, role: `${LIN}role/executor` }],
  );
  assert.equal(r.status, 'pass', JSON.stringify(r));
  assert.match(sent, /<https:\/\/example\.org\/lineage\/entity\/demo%3Ax%401>/);
});

test('equal mode reports rows on one side only', async () => {
  const { r } = await run(
    { columns: ['source'], decode: { source: 'node:entity' }, cypher: '', sparql: '' },
    [{ source: 'a' }, { source: 'b' }],
    [{ source: `${LIN}entity/a` }, { source: `${LIN}entity/c` }],
  );
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.onlyCypher, ['["b"]']);
  assert.deepEqual(r.onlySparql, ['["c"]']);
});

test('disjoint mode fails on overlap and on an empty Cypher side', async () => {
  const check = { mode: 'disjoint', columns: ['input'], decode: { input: 'node:entity' }, cypher: '', sparql: '' };
  assert.equal((await run(check, [{ input: 'a' }], [{ input: `${LIN}entity/b` }])).r.status, 'pass');
  assert.equal((await run(check, [{ input: 'a' }], [{ input: `${LIN}entity/a` }])).r.status, 'fail');
  assert.equal((await run(check, [], [])).r.status, 'fail');
});

test('a check that cannot be expressed is reported, not run; a bad decode spec is an error', async () => {
  const [r] = await runOracle({ oracle: { checks: [{ id: 'x', expressible: false, reason: 'not PROV' }] }, mapping: baseMapping, lpgDoc: baseDoc, source: stub([]), n20s: stub([]), graph: 'g' });
  assert.deepEqual(r, { id: 'x', status: 'not-expressible', reason: 'not PROV' });
  const { r: bad } = await run({ columns: ['x'], decode: { x: 'values:relationships/used/properties/nope' }, cypher: '', sparql: '' }, [], []);
  assert.equal(bad.status, 'error');
});
