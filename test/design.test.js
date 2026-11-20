import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { designTurn, designRequest, decideItem, scopeOf, elementNames, itemProblems, emptySpec } from '../src/design.js';
import { functionProvider } from '../src/providers.js';
import { startStudio } from '../src/studio.js';
import { EXAMPLE, auraDoc } from './helpers.js';

const names = elementNames(auraDoc);
const targets = [{ id: 'prov', prefix: 'prov', namespace: 'http://www.w3.org/ns/prov#', title: 'PROV-O', inProject: true }];

test('elements by the names people use; proposals checked against them', () => {
  assert.deepEqual(names.get('DEPENDS_ON'), { section: 'relationships', id: 'r:2' });
  assert.deepEqual(names.get('Dataset.name'), { section: 'nodes', id: 'n:3', property: 'p:6' });
  assert.equal(names.has('Dataset.id'), false, 'an alias is its inherited property');
  assert.deepEqual(itemProblems({ kind: 'exclude', element: 'DEPENDS_ON' }, { names, targets }), ['exclude needs reason']);
  assert.deepEqual(itemProblems({ kind: 'include', element: 'Dataset.name' }, { names, targets }), ['scope is decided for node kinds and relationship types; a property goes in a note']);
  assert.deepEqual(itemProblems({ kind: 'note', element: 'Nope', text: 'x' }, { names, targets }), ['Nope is not an element of the LPG ontology']);
  assert.deepEqual(itemProblems({ kind: 'target', target: 'dcat' }, { names, targets }), ['dcat is not a known target']);
});

test('a turn: the request carries the ontology, the spec with its rejections, the history; the answer becomes checked proposals', async () => {
  let seen;
  const provider = functionProvider((req) => { seen = req; return { reply: 'Compris.', proposals: [
    { kind: 'purpose', text: 'Audit export.' },
    { kind: 'exclude', element: 'DEPENDS_ON', reason: 'potential, not asserted' },
    { kind: 'exclude', element: 'Column' },
  ] }; }, { model: 'test' });
  const spec = { ...emptySpec('m'), items: [{ id: 'i1', kind: 'principle', text: 'Use qualified forms everywhere.', status: 'rejected', reviewComment: 'too strict' }] };
  const chat = [{ id: 'm1', role: 'user', text: 'Hello' }, { id: 'm2', role: 'assistant', text: 'What for?', proposals: [] }];
  const [u, a] = await designTurn({ provider, lpgDoc: auraDoc, spec, chat, message: 'Pour un auditeur', targets, now: () => 'T' });
  assert.deepEqual([u.id, u.role, a.id, a.role, a.model], ['m3', 'user', 'm4', 'assistant', 'test']);
  assert.match(seen.user, /Over-approximation|over-approximation/, 'descriptions reach the model');
  assert.match(seen.user, /\[rejected\] principle: Use qualified forms everywhere\. \(rejected because: too strict\)/);
  assert.match(seen.user, /You: What for\?/);
  assert.ok(seen.schema.properties.proposals.items.properties.element.enum.includes('WAS_DERIVED_FROM.runId'));
  assert.deepEqual(a.proposals.map((p) => [p.pid, p.kind, p.problems]), [['m4p1', 'purpose', []], ['m4p2', 'exclude', []], ['m4p3', 'exclude', ['exclude needs reason']]]);
});

test('decisions: accept, reject with a reason, edit (the person becomes the author), remove; one scope decision per element', () => {
  let spec = emptySpec('m');
  const p1 = { pid: 'm2p1', kind: 'exclude', element: 'DEPENDS_ON', reason: 'potential' };
  spec = decideItem(spec, { action: 'accept', proposal: p1, by: 'Pierre', model: 'gemini', names, targets, at: 'T' });
  assert.deepEqual(spec.items[0], { id: 'i1', kind: 'exclude', element: 'DEPENDS_ON', reason: 'potential', status: 'accepted', by: { kind: 'ai', model: 'gemini' }, reviewedBy: 'Pierre', at: 'T', from: 'm2p1' });
  spec = decideItem(spec, { action: 'reject', proposal: { pid: 'm2p2', kind: 'principle', text: 'x' }, comment: 'no', by: 'Pierre', names, targets });
  assert.deepEqual([spec.items[1].status, spec.items[1].reviewComment], ['rejected', 'no']);
  spec = decideItem(spec, { action: 'edit', proposal: { pid: 'm2p3', kind: 'purpose', text: 'Audit' }, item: { kind: 'purpose', text: 'External audit' }, by: 'Pierre', names, targets });
  assert.deepEqual([spec.items[2].text, spec.items[2].by], ['External audit', { kind: 'human', name: 'Pierre' }]);
  assert.throws(() => decideItem(spec, { action: 'accept', proposal: { pid: 'x', kind: 'exclude', element: 'Nope', reason: 'r' }, by: 'P', names, targets }), /not an element/);
  // In scope after all: the exclusion goes.
  spec = decideItem(spec, { action: 'edit', item: { kind: 'include', element: 'DEPENDS_ON' }, by: 'Pierre', names, targets });
  assert.deepEqual(spec.items.filter((i) => i.element === 'DEPENDS_ON').map((i) => i.kind), ['include']);
  const s = scopeOf(spec, auraDoc);
  assert.equal(s.elements.find((e) => e.name === 'DEPENDS_ON').scope, 'in');
  assert.equal(s.mode, 'full');
  spec = decideItem(spec, { action: 'edit', item: { kind: 'exclude', element: 'Column', reason: 'later' }, by: 'Pierre', names, targets });
  assert.deepEqual([scopeOf(spec, auraDoc).mode, scopeOf(spec, auraDoc).counts.out], ['partial', 1]);
  spec = decideItem(spec, { action: 'remove', id: spec.items.find((i) => i.element === 'Column').id });
  assert.equal(scopeOf(spec, auraDoc).counts.out, 0);
});

test('studio design: conversation appended, decisions written to the spec next to the mapping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-design-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const provider = () => functionProvider(() => ({ reply: 'Noted.', proposals: [{ kind: 'exclude', element: 'DEPENDS_ON', reason: 'potential' }, { kind: 'question', text: 'Who owns what?' }] }), { model: 'test' });
  const studio = await startStudio({ mappingFile: path.join(dir, 'lineage-prov.aura.mapping.yaml'), port: 0, reviewer: 'Pierre', provider });
  const call = async (p, body) => { const r = await fetch(new URL(p, studio.url), body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  try {
    let { data } = await call('/api/design');
    assert.deepEqual([data.chat.length, data.spec.items.length, data.scope.mode, data.can.model], [0, 0, 'full', true]);
    assert.ok(data.targets.some((t) => t.id === 'dcat' && !t.inProject), 'the catalog is offered');
    ({ data } = await call('/api/design/say', { message: 'Audit export' }));
    assert.deepEqual(data.chat.map((m) => m.role), ['user', 'assistant']);
    ({ data } = await call('/api/design/decide', { pid: 'm2p1', action: 'accept' }));
    ({ data } = await call('/api/design/decide', { pid: 'm2p2', action: 'reject', comment: 'later' }));
    assert.deepEqual(data.spec.items.map((i) => [i.kind, i.status]), [['exclude', 'accepted'], ['question', 'rejected']]);
    assert.equal(data.scope.counts.out, 1);
    const spec = YAML.parse(fs.readFileSync(path.join(dir, 'lineage-prov.aura.spec.yaml'), 'utf8'));
    assert.equal(spec.items[0].from, 'm2p1');
    assert.equal(fs.readFileSync(path.join(dir, 'lineage-prov.aura.chat.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.equal((await call('/api/design/say', { message: '' })).status, 400);
  } finally {
    await studio.close();
  }
});

import { propose } from '../src/propose.js';
import { specFindings, cypherDirectionProblems, draftProblems, compareAnswers, recipeFromDraft } from '../src/design.js';
import { prov, auraGold, auraBlank, goldAnswer } from './helpers.js';

const accepted = (items) => ({ ...emptySpec('m'), items: items.map((x, i) => ({ id: `i${i + 1}`, status: 'accepted', reviewedBy: 'Pierre', ...x })) });

test('propose from a spec: out of scope left out without the model, accepted; purpose, principles and notes in the prompt', async () => {
  const spec = accepted([
    { kind: 'purpose', text: 'Audit export of provenance.' },
    { kind: 'principle', text: 'Never assert a derivation no source asserts.' },
    { kind: 'exclude', element: 'Column', reason: 'column level later' },
    { kind: 'exclude', element: 'DEPENDS_ON', reason: 'potential, not asserted' },
    { kind: 'note', element: 'WAS_DERIVED_FROM.runId', text: 'join to the Run by a rule' },
  ]);
  const requests = [];
  const provider = functionProvider((req) => { requests.push(req); return goldAnswer(auraGold)(req); });
  const res = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider, prefix: 'lin', spec });
  assert.ok(!requests.some((r) => ['nodes/n:5', 'relationships/r:2'].includes(r.element)), 'no call for what is out of scope');
  assert.equal(requests.length, 28);
  assert.deepEqual(res.mapping.relationships['r:2'], { ignore: { reason: 'Out of scope: potential, not asserted' }, meta: { status: 'accepted', proposedBy: { kind: 'tool', name: 'spec' }, rationale: 'Spec item i4 (DEPENDS_ON), accepted by Pierre.' } });
  const derived = requests.find((r) => r.element === 'relationships/r:3').user;
  assert.match(derived, /# Specification, validated by the person: follow it\nPurpose: Audit export of provenance\.\nPrinciple: Never assert a derivation no source asserts\.\nNote on WAS_DERIVED_FROM\.runId: join to the Run by a rule/);
  assert.doesNotMatch(requests.find((r) => r.element === 'relationships/r:0').user, /Note on/, 'notes only where they belong');
});

test('departures from the spec: out of scope but mapped, in scope but left out, a chosen target missing', () => {
  const spec = accepted([
    { kind: 'exclude', element: 'DEPENDS_ON', reason: 'potential' },
    { kind: 'include', element: 'HAS_COLUMN' },
    { kind: 'target', target: 'dcat', reason: 'catalog' },
  ]);
  const mapping = structuredClone(auraGold);
  mapping.relationships['r:2'] = { predicate: 'prov:wasDerivedFrom' };
  const f = specFindings(spec, mapping, auraDoc, { targets: [{ id: 'dcat', namespace: 'http://www.w3.org/ns/dcat#', title: 'DCAT' }] });
  assert.deepEqual(f.map((x) => [x.code, x.path]), [['spec.target-missing', 'targets'], ['spec.out-of-scope-mapped', 'relationships/r:2'], ['spec.in-scope-left-out', 'relationships/r:6']]);
});

test('drafts: relationship directions, decode columns, placeholders; answers compared', () => {
  assert.deepEqual(cypherDirectionProblems('MATCH (v:DatasetVersion)<-[:WAS_GENERATED_BY]-(r:Run) RETURN v', auraDoc), ['WAS_GENERATED_BY goes from DatasetVersion to Run, not from Run to DatasetVersion: (DatasetVersion)-[:WAS_GENERATED_BY]->(Run).']);
  assert.deepEqual(cypherDirectionProblems('MATCH (v:DatasetVersion)-[:WAS_GENERATED_BY]->(r:Run)-[:USED]->(i) MATCH (d:Dataset)-[:WAS_ATTRIBUTED_TO]->(a:Agent) RETURN v', auraDoc), [], 'Dataset is an Entity');
  const recipe = recipeFromDraft({ id: 'Up stream!', title: 'Up', params: [{ name: 'v', default: '' }, { name: 'n', type: 'integer', default: '3' }], cypher: 'MATCH (x:DatasetVersion)<-[:WAS_GENERATED_BY]-(r:Run) RETURN x', sparql: 'SELECT ?version WHERE { {{n:4|v}} prov:used ?version }', decode: [{ column: 'source', node: 'n:4' }] }, { mappingPath: '../m.yaml', question: 'q' });
  assert.deepEqual([recipe.id, recipe.params.n.default, recipe.params.v.default, recipe.steps[1].decode], ['up-stream', 3, '', { source: 'node:n:4' }]);
  assert.deepEqual(draftProblems(recipe, auraDoc).map((p) => p.message.split(':')[0]), ['WAS_GENERATED_BY goes from DatasetVersion to Run, not from Run to DatasetVersion', 'decode source', '{{n']);
  assert.deepEqual(compareAnswers([{ version: 'a' }, { version: 'b' }], [{ version: 'b' }, { version: 'a' }]).agree, true);
  assert.deepEqual(compareAnswers([{ version: 'a' }], [{ version: 'b' }]), { columns: ['version'], agree: false, recipeRows: 1, cypherRows: 1, onlyRecipe: ['["a"]'], onlyCypher: ['["b"]'] });
  assert.deepEqual(compareAnswers([], []).agree, null, 'two empty answers check nothing');
});

test('studio: a question drafted as a recipe, checked, repaired once, saved, added to the bench, linked from the spec', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-draft-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  let calls = 0;
  const provider = () => functionProvider((req) => {
    calls++;
    const bad = !req.user.includes('# What went wrong');
    return { id: 'invalidated-inputs', title: 'Versions written by a run that read an invalidated version', params: [],
      cypher: bad ? 'MATCH (v:DatasetVersion)<-[:WAS_GENERATED_BY]-(r:Run) RETURN v, r' : 'MATCH p = (v:DatasetVersion)-[:WAS_GENERATED_BY]->(r:Run)-[:USED]->(i:DatasetVersion) WHERE i.invalidatedAt IS NOT NULL RETURN p',
      sparql: 'SELECT DISTINCT ?version WHERE { ?version prov:wasGeneratedBy ?r . ?r prov:used ?i . ?i prov:invalidatedAtTime ?t }', decode: [{ column: 'version', node: 'n:0' }],
      answerCypher: 'MATCH (v:DatasetVersion)-[:WAS_GENERATED_BY]->(:Run)-[:USED]->(i:DatasetVersion) WHERE i.invalidatedAt IS NOT NULL RETURN DISTINCT v.id AS version', explanation: 'Generation then usage.' };
  }, { model: 'test' });
  const studio = await startStudio({ mappingFile: path.join(dir, 'lineage-prov.aura.mapping.yaml'), port: 0, reviewer: 'Pierre', provider });
  const call = async (p, body) => { const r = await fetch(new URL(p, studio.url), { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  try {
    await call('/api/design/decide', { action: 'edit', item: { kind: 'question', text: 'Which versions did a run write after reading an invalidated version?' } });
    const { data } = await call('/api/design/draft', { id: 'i1' });
    assert.equal(calls, 2, 'the reversed relationship got one repair call');
    assert.deepEqual([data.drafted.file, data.drafted.findings, data.drafted.tried], ['invalidated-inputs.recipe.yaml', [], null], 'no source: not tried');
    const text = fs.readFileSync(path.join(dir, 'recipes', 'invalidated-inputs.recipe.yaml'), 'utf8');
    assert.match(text, /^# Drafted by test from the question i1 of the spec/);
    assert.match(text, /Not cross-checked\./);
    assert.equal(data.spec.items[0].recipe, 'invalidated-inputs.recipe.yaml');
    const bench = YAML.parse(fs.readFileSync(path.join(dir, 'recipes', 'bench.yaml'), 'utf8'));
    assert.deepEqual(bench.requests.at(-1).target, { recipe: 'invalidated-inputs' });
    assert.equal((await call('/api/design/draft', { id: 'i9' })).status, 400);
  } finally {
    await studio.close();
  }
});
