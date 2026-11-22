// Write-back without a database: what a write step may write (check rules),
// the ontology patch, the guards before anything is sent, and how change data
// capture tells a recipe's own writes. The writes themselves are in e2e.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, checkRecipe, checkWrites, exportPatch, withoutWriteBack, writtenPaths, ownTransaction, txMetadata, runRecipe, recipeKind } from '../src/index.js';
import { withoutWriteBack as stripped, adminScript } from '../src/writeback.js';
import { loadRecipe, loadFiles, compactSpecJson } from '../src/node.js';
import { endpoints } from '../src/endpoints.js';
import { syncOnce } from '../src/follow.js';
import { ROOT } from './helpers.js';

const DEMO = path.join(ROOT, 'demo/project/lineage');
const FILE = path.join(DEMO, 'recipes/9-taint-writeback.recipe.yaml');
const f = await loadRecipe(FILE);
const { recipe, mapping, lpgDoc } = f;
const lost = stripped(lpgDoc);
const codes = (findings, severity = 'error') => findings.filter((x) => x.severity === severity).map((x) => x.code);
const withStep = (id, change) => ({ ...recipe, steps: recipe.steps.map((s) => (s.id === id ? change(structuredClone(s)) : s)) });
const findingsOf = (r, doc = lpgDoc) => checkRecipe(r, { mapping, lpgDoc: doc });

test('recipe 9: a build recipe whose writes the ontology declares, owned by its steps', () => {
  assert.equal(recipeKind(recipe), 'build');
  assert.deepEqual(findingsOf(recipe), []);
});

test('write.undeclared: an export that lost the declarations gives one actionable error', () => {
  const found = findingsOf(recipe, lost);
  assert.deepEqual(codes(found), ['write.undeclared']);
  assert.match(found[0].message, /inferred label Tainted.*WriteLedger.*READS_TAINTED_INPUT/s);
  assert.match(found[0].message, /n20s-mapping write-patch/);
});

test('write.* rules: kind, owner, shared, keys, gate, retract, free Cypher, reads its own name', () => {
  const lazy = { ...recipe, graphs: { kg: { lifecycle: 'ephemeral' } }, steps: recipe.steps.filter((s) => s.type !== 'publish') };
  assert.ok(codes(findingsOf(lazy)).includes('write.kind'), 'a lazy recipe never writes');
  assert.ok(codes(findingsOf({ ...recipe, api: { name: 'taint', result: 'tainted' } })).includes('write.kind'), 'nor one served as a query');
  assert.ok(codes(findingsOf({ ...recipe, steps: recipe.steps.map((s) => (s.id === 'mark' ? { ...s, id: 'mark2' } : s)) })).includes('write.owner'), 'Tainted is inferred by taint-writeback/mark');
  assert.ok(codes(findingsOf(withStep('mark', (s) => ({ ...s, label: { node: 'version', add: 'Dataset' } })))).includes('write.owner'), 'never an identifying label');
  assert.ok(codes(findingsOf(withStep('mark', (s) => ({ id: s.id, type: 'write', from: 'tainted', property: { node: 'version', set: 'version', value: 'input' } })))).includes('write.owner'), 'never an ingested property');
  const sharedLabel = structuredClone(lpgDoc);
  sharedLabel.nodes['n:4'].labels.extensions.custom.inferredBy.Tainted = { shared: true };
  assert.ok(codes(findingsOf(recipe, sharedLabel)).includes('write.shared'), 'a label is never shared');
  assert.ok(codes(findingsOf(withStep('tainted', (s) => { delete s.decode; return s; }))).includes('write.keys'), 'node columns are decoded');
  assert.ok(codes(findingsOf(withStep('link', (s) => ({ ...s, gate: ['tainted'] })))).includes('write.gate'));
  assert.ok(codes(findingsOf(withStep('link', (s) => ({ ...s, retract: 'everything' })))).includes('write.retract'));
  assert.ok(codes(findingsOf(withStep('link', (s) => ({ ...s, from: 'check' })))).includes('write.from'), 'rows of a query or construct only');
  const free = findingsOf(withStep('link', (s) => ({ id: s.id, type: 'write', from: 'tainted', cypher: 'UNWIND $rows AS row RETURN row' })));
  assert.deepEqual(codes(free), []);
  assert.deepEqual(codes(free, 'warning'), ['write.free-cypher']);
  const readsOwn = findingsOf(withStep('lineage', (s) => ({ ...s, cypher: 'MATCH (n) WHERE n:DatasetVersion OR n:Run OR n:Tainted RETURN n' })));
  assert.deepEqual(codes(readsOwn, 'warning'), ['write.reads-own']);
});

test('write-patch: what the recipes write is added to the export, once; the patched export passes', () => {
  const { changes, doc } = exportPatch(lost, [{ recipe, mapping }]);
  assert.deepEqual(changes.map((c) => c.op).sort(), ['add-label', 'add-node', 'add-relationship']);
  assert.deepEqual(findingsOf(recipe, doc), []);
  assert.deepEqual(exportPatch(doc, [{ recipe, mapping }]).changes, [], 'nothing more to add');
  const r = Object.values(doc.relationships).find((x) => x.type === 'READS_TAINTED_INPUT');
  assert.deepEqual(Object.values(r.properties).map((p) => [p.name, p.extensions.custom.provenance]), [['createdBy', true], ['createdAt', true]]);
  const ledger = Object.values(doc.nodes).find((n) => n.labels.identifier === 'WriteLedger');
  assert.equal(ledger.extensions.custom.technical, true);
  assert.equal(Object.values(ledger.constraints)[0].type, 'UNIQUE');
});

test('write-patch keeps the layout of the export file', () => {
  const text = fs.readFileSync(path.join(DEMO, 'aura-export.json'), 'utf8');
  assert.equal(compactSpecJson(JSON.parse(text)) + '\n', text);
});

test('mapping: inferred names, provenance and the ledger are not ingested; a lost export is one error', async () => {
  const l = await loadFiles(path.join(DEMO, 'lineage-prov.mapping.yaml'));
  assert.deepEqual([...writtenPaths(lpgDoc).keys()].sort(), ['nodes/n:13', 'relationships/r:17']);
  assert.equal(l.mapping.relationships['r:17'].meta.proposedBy.name, 'write-back', 'propose left it out');
  let res = await check({ mapping: l.mapping, lpgDoc, targets: l.targets });
  assert.equal(res.summary.errors, 0);

  const mapped = structuredClone(l.mapping);
  mapped.relationships['r:17'] = { predicate: 'prov:wasInfluencedBy' };
  res = await check({ mapping: mapped, lpgDoc, targets: l.targets });
  assert.deepEqual(res.findings.filter((x) => x.severity === 'error').map((x) => [x.code, x.path]), [['mapping.inferred-mapped', 'relationships/r:17']]);

  res = await check({ mapping: l.mapping, lpgDoc: lost, targets: l.targets });
  const errors = res.findings.filter((x) => x.severity === 'error');
  assert.deepEqual(errors.map((x) => x.code), ['write.undeclared'], 'no unknown-node or unknown-relationship on top of it');
  assert.deepEqual(errors[0].data.paths, ['nodes/n:13', 'relationships/r:17']);
});

test('propose never shows the model what is written back', () => {
  const s = withoutWriteBack(lpgDoc);
  assert.ok(!s.nodes['n:13'] && !s.relationships['r:17']);
  assert.equal(s.nodes['n:4'].labels.optional, undefined);
  assert.equal(JSON.stringify(s).includes('inferredBy'), false);
});

test('CDC: a recipe\'s own transactions are recognized by the exact recipe id', () => {
  const meta = txMetadata('taint-writeback/mark', 'r1');
  assert.deepEqual(meta, { app: 'n20s', owner: 'taint-writeback/mark', run: 'r1' });
  assert.equal(ownTransaction(meta, 'taint-writeback'), true);
  assert.equal(ownTransaction(meta, 'taint'), false, 'taint does not cover taint-writeback');
  assert.equal(ownTransaction({ ...meta, app: 'other' }, 'taint-writeback'), false);
  assert.equal(ownTransaction(null, 'taint-writeback'), false);
  assert.equal(ownTransaction({ app: 'n20s', owner: 'taint/mark' }, 'taint-writeback'), false);
});

test('follow: the publication\'s own writes are not changes to follow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-wb-follow-'));
  fs.cpSync(DEMO, dir, { recursive: true, filter: (x) => !x.endsWith('graphs.json') });
  const recipes = path.join(dir, 'recipes');
  fs.writeFileSync(path.join(recipes, 'graphs.json'), JSON.stringify({
    format: 'n20s-graphs/0.1', graphs: {},
    publications: { taint: { graph: 'g1', recipe: 'taint-writeback', file: '9-taint-writeback.recipe.yaml', params: {} } },
    follow: { taint: { cursor: 'c0', watched: { labels: ['DatasetVersion'], types: [] }, changes: 0, syncs: 0, state: 'idle' } },
  }));
  const own = (id, owner) => ({ id, txId: 9, event: { eventType: 'n', labels: ['DatasetVersion', 'Entity', 'Tainted'] }, txMetadata: { app: 'n20s', owner, run: 'r1' } });
  const source = { async run(cypher, p) { if (/db\.cdc\.query/.test(cypher)) return [own('c1', 'taint-writeback/mark'), own('c2', 'taint-writeback/link')].filter((e) => e.id > p.from); throw new Error(cypher); } };
  const [res] = await syncOnce(recipes, { source, n20s: null });
  assert.deepEqual(res, { endpoint: 'taint', changes: 0, own: 2 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(recipes, 'graphs.json'), 'utf8')).follow.taint.cursor, 'c2');
});

/** A run up to the write steps, with n20s faked: the tainted query answers two rows. */
async function runUpToWrites({ conforms = true, allowWrite = false, writer = null } = {}) {
  const iri = (k) => `https://example.org/lineage/entity/${encodeURIComponent(k)}`;
  const n20s = {
    list: async () => [], drop: async () => ({}), addTurtle: async () => ({ added: 0 }), projectTemplate: async () => ({ added: 0 }),
    infer: async () => ({ newTriples: 0 }), update: async () => ({}),
    validate: async () => (conforms ? [] : [{ focusNode: iri('v1'), severity: 'Violation', message: 'A version derived from itself.' }]),
    query: async () => [{ version: iri('v2'), input: iri('v1') }],
  };
  return runRecipe({ ...f, n20s, source: { run: async () => [] }, allowWrite, writer });
}

test('guards: no write unless allowed; a closed gate stops it; no write connection, no write', async () => {
  let run = await runUpToWrites();
  let mark = run.steps.find((s) => s.id === 'mark');
  assert.equal(mark.status, 'error');
  assert.match(mark.error, /^Not written: this run may not write back/);
  assert.equal(run.publications.length, 0, 'nothing published either');

  run = await runUpToWrites({ conforms: false, allowWrite: true });
  mark = run.steps.find((s) => s.id === 'mark');
  assert.match(mark.error, /^Not written: check found 1 violation/);

  run = await runUpToWrites({ allowWrite: true });
  assert.match(run.steps.find((s) => s.id === 'mark').error, /No write connection: set N20S_WRITE/);
});

test('guards: the write connection is refused without the ledger constraint, with the Cypher for an administrator', async () => {
  const sent = [];
  const writer = { run: async (q) => { sent.push(q); return [{ n: 0 }]; }, transaction: async () => { throw new Error('no transaction expected'); } };
  const run = await runUpToWrites({ allowWrite: true, writer });
  const mark = run.steps.find((s) => s.id === 'mark');
  assert.match(mark.error, /CREATE CONSTRAINT write_ledger_owner IF NOT EXISTS FOR \(l:WriteLedger\) REQUIRE l\.owner IS UNIQUE/);
  assert.ok(sent.every((q) => /^SHOW CONSTRAINTS/.test(q)), 'the tool never changes the schema');
});

test('serve: a recipe that writes back runs by POST /run only, with --write and a write connection; never by GET or /query', async () => {
  const dir = path.join(DEMO, 'recipes');
  const req = (method, body = '{}') => Object.assign((async function* () { yield body; })(), { method, headers: { 'content-type': 'application/json' } });
  const url = (p) => new URL(`http://localhost${p}`);
  const openSource = () => { throw new Error('nothing may be opened'); };
  let handle = endpoints({ recipesDir: dir, n20s: {}, openSource, allowRun: true });
  assert.equal((await handle(req('GET'), url('/run/taint-writeback'))).status, 405);
  let out = await handle(req('POST'), url('/run/taint-writeback'));
  assert.equal(out.status, 403);
  assert.match(JSON.parse(out.body).error, /serve --run --write/);
  handle = endpoints({ recipesDir: dir, n20s: {}, openSource, allowRun: true, allowWrite: true });
  out = await handle(req('POST'), url('/run/taint-writeback'));
  assert.equal(out.status, 403);
  assert.match(JSON.parse(out.body).error, /no write connection/);
  handle = endpoints({ recipesDir: dir, n20s: {}, openSource, allowRun: false, allowWrite: true });
  assert.equal(await handle(req('POST'), url('/run/taint-writeback')), null, 'no /run without --run');

  // Declared as a query API (which check refuses anyway): /query never writes.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-wb-api-'));
  fs.cpSync(DEMO, tmp, { recursive: true, filter: (x) => !x.endsWith('graphs.json') });
  const file = path.join(tmp, 'recipes/9-taint-writeback.recipe.yaml');
  fs.appendFileSync(file, 'api: { name: taint, result: tainted }\n');
  handle = endpoints({ recipesDir: path.join(tmp, 'recipes'), n20s: {}, openSource, allowRun: true, allowWrite: true, openWriter: () => { throw new Error('never opened'); } });
  out = await handle(req('GET'), url('/query/taint'));
  assert.equal(out.status, 403);
  assert.match(JSON.parse(out.body).error, /a query never writes/);
});

test('checkWrites: nothing to say about a recipe without write steps', () => {
  assert.deepEqual(checkWrites({ id: 'x', steps: [{ id: 'q', type: 'query', sparql: 'ASK {}' }] }, { lpgDoc }), []);
});

test('write-patch: one admin script, the constraint and every name the writer writes', async () => {
  const script = adminScript(lpgDoc, [{ recipe, mapping }]);
  const { splitStatements } = await import('../src/node.js');
  const st = splitStatements(script);
  assert.equal(st.length, 2);
  assert.match(st[0], /CREATE CONSTRAINT write_ledger_owner IF NOT EXISTS FOR \(l:WriteLedger\) REQUIRE l\.owner IS UNIQUE$/);
  assert.match(st[1], /CREATE \(l:`WriteLedger`:`Tainted` \{`owner`: '__names__', `kind`: ''/);
  assert.match(st[1], /\[:`READS_TAINTED_INPUT` \{`createdBy`: '', `createdAt`: ''\}\]/);
  assert.match(st[1], /DETACH DELETE l$/);
});

/** Recipe 9 with an inferred property on DatasetVersion, of the given type, written by a step since. */
function withProperty(type = 'ZONED DATETIME', datatype = undefined) {
  const doc = structuredClone(lpgDoc);
  doc.nodes['n:4'].properties['p:90'] = { type, name: 'taintedSince', extensions: { custom: { inferredBy: { recipe: 'taint-writeback', step: 'since' } } } };
  const r = structuredClone(recipe);
  const at = r.steps.findIndex((x) => x.id === 'publish');
  r.steps.splice(at, 0,
    { id: 'since-q', type: 'query', sparql: 'SELECT ?version (MIN(?at) AS ?since) WHERE { ?version lin:taintedBy ?i . ?i prov:invalidatedAtTime ?at } GROUP BY ?version', decode: { version: 'node:n:4' } },
    { id: 'since', type: 'write', from: 'since-q', property: { node: 'version', set: 'taintedSince', value: 'since', ...(datatype ? { datatype } : {}) } });
  return { doc, recipe: r };
}

test('write.datatype: a declared datatype must fit the property type; a type without conversion is refused', () => {
  let p = withProperty('ZONED DATETIME', 'xsd:dateTime');
  assert.deepEqual(codes(checkRecipe(p.recipe, { mapping, lpgDoc: p.doc })), []);
  p = withProperty('ZONED DATETIME', 'xsd:boolean');
  assert.deepEqual(codes(checkRecipe(p.recipe, { mapping, lpgDoc: p.doc })), ['write.datatype']);
  p = withProperty('POINT');
  assert.deepEqual(codes(checkRecipe(p.recipe, { mapping, lpgDoc: p.doc })), ['write.datatype']);
});

test('a scope or rows step that would write is refused before it runs (EXPLAIN)', async () => {
  const ran = [];
  const source = { queryType: async (c) => (/SET/.test(c) ? 'rw' : 'r'), run: async (c) => { ran.push(c); return []; } };
  const n20s = { list: async () => [], drop: async () => ({}), addTurtle: async () => ({ added: 0 }) };
  const r = { format: 'n20s-recipe/0.1', id: 'sneaky', steps: [{ id: 's', type: 'scope', cypher: 'MATCH (n:DatasetVersion) SET n.x = 1 RETURN n' }] };
  const run = await runRecipe({ recipe: r, mapping, lpgDoc, plan: f.plan, source, n20s });
  assert.match(run.steps[0].error, /^Not run: a scope step only reads, and this Cypher writes \(EXPLAIN gives query type rw\)/);
  assert.deepEqual(ran, [], 'nothing was run');
});
