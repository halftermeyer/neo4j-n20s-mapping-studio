import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { check, propose, proposePasses, variantsOf, reviewItems, applyDecision, acceptSafe, functionProvider } from '../src/index.js';
import { startStudio } from '../src/studio.js';
import { EXAMPLE, prov, auraDoc, auraGold, auraBlank, goldAnswer } from './helpers.js';

/** Gold answers, with two departures: DEPENDS_ON mapped (pass 2 only) and a low confidence on HAS_COLUMN. */
const answers = (pass) => (req) => {
  const a = goldAnswer(auraGold)(req);
  if (req.element === 'relationships/r:2' && pass === 2) return { decision: 'map', predicate: 'prov:wasDerivedFrom', rationale: 'derived', confidence: 0.9, properties: a.properties };
  if (req.element === 'relationships/r:6') a.confidence = 0.6;
  return a;
};

async function proposed(passes = 3) {
  let pass = 0;
  const provider = functionProvider((req) => answers(pass)(req));
  const results = [];
  for (pass = 1; pass <= passes; pass++) results.push(await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider, prefix: 'lin' }));
  return { mapping: results[0].mapping, variants: variantsOf(results.map((r) => r.mapping), auraDoc) };
}

test('variants: passes agree when they decide the same, whatever the wording of a reason', async () => {
  const { variants } = await proposed();
  assert.equal(variants.passes, 3);
  assert.equal(variants.elements['relationships/r:2'].stable, false);
  assert.deepEqual(variants.elements['relationships/r:2'].variants.map((v) => v.passes), [[1, 3], [2]]);
  assert.equal(variants.elements['relationships/r:0'].stable, true);
  const reworded = structuredClone(auraGold);
  reworded.relationships['r:2'].ignore.reason = 'Other words.';
  assert.equal(variantsOf([auraGold, reworded]).elements['relationships/r:2'], undefined, 'only proposed entries are compared');

  const res = await proposePasses({ passes: 2, mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider: functionProvider(goldAnswer(auraGold)), prefix: 'lin' });
  assert.equal(res.passes.length, 2);
  assert.ok(Object.values(res.variants.elements).every((v) => v.stable));
});

test('review queue: risky first, safe only when stable, confident and clean', async () => {
  const { mapping, variants } = await proposed();
  const result = await check({ mapping, lpgDoc: auraDoc, targets: prov });
  const items = reviewItems({ mapping, lpgDoc: auraDoc, result, variants });
  assert.equal(items.length, 30);
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.deepEqual([...new Set(by['relationships/r:2'].reasons.map((r) => r.code))], ['unstable']);
  assert.ok(by['relationships/r:6'].reasons.some((r) => r.code === 'low-confidence'));
  assert.ok(by['relationships/r:0'].reasons.some((r) => r.code === 'asserts'), 'a mapped relationship asks for a look');
  assert.equal(by['relationships/r:0'].safe, true);
  assert.equal(by['relationships/r:2'].safe, false);
  assert.equal(by['relationships/r:6'].safe, false);
  assert.ok(items.indexOf(by['relationships/r:2']) < items.indexOf(by['nodes/n:10']), 'unstable before calm');
  assert.equal(reviewItems({ mapping, lpgDoc: auraDoc, result }).some((i) => i.safe), false, 'without passes nothing is safe');

  // HAS_COLUMN -> prov:hadMember, as the model proposed it: a domain warning, ranked as a doubtful meaning.
  const member = structuredClone(mapping);
  member.relationships['r:6'] = { predicate: 'prov:hadMember', meta: { status: 'proposed', confidence: 0.95 } };
  const res2 = await check({ mapping: member, lpgDoc: auraDoc, targets: prov });
  const items2 = reviewItems({ mapping: member, lpgDoc: auraDoc, result: res2, variants });
  const r6 = items2.find((i) => i.key === 'relationships/r:6');
  assert.ok(r6.reasons.some((r) => r.code === 'meaning' && /target\.domain/.test(r.text)), JSON.stringify(r6.reasons));
  assert.equal(r6.safe, false);
  assert.ok(items2.indexOf(r6) < items2.findIndex((i) => i.key === 'relationships/r:0'));
});

test('decisions: accept cascades to proposed properties, reject keeps a comment, edit is the reviewer\'s', async () => {
  const { mapping } = await proposed(1);
  const at = '2026-11-19T12:00:00Z';
  let m = applyDecision(mapping, { path: 'relationships/r:0', action: 'accept', reviewer: 'Pierre', at });
  assert.equal(m.relationships['r:0'].meta.status, 'accepted');
  assert.equal(m.relationships['r:0'].properties['p:48'].meta.reviewedBy, 'Pierre');
  assert.equal(m.relationships['r:0'].meta.proposedBy.kind, 'ai', 'provenance kept');

  m = applyDecision(m, { path: 'relationships/r:6', action: 'reject', reviewer: 'Pierre', at, comment: 'hadMember is for collections' });
  assert.deepEqual([m.relationships['r:6'].meta.status, m.relationships['r:6'].meta.reviewComment], ['rejected', 'hadMember is for collections']);

  m = applyDecision(m, { path: 'nodes/n:3/properties/p:6', action: 'edit', reviewer: 'Pierre', at, entry: { predicate: 'rdfs:label' } });
  assert.deepEqual(m.nodes['n:3'].properties['p:6'].meta.proposedBy, { kind: 'human', name: 'Pierre' });
  m = applyDecision(m, { path: 'nodes/n:3', action: 'edit', reviewer: 'Pierre', at, entry: {} });
  assert.ok(m.nodes['n:3'].properties['p:6'], 'an element edit keeps its properties');
  assert.throws(() => applyDecision(m, { path: 'nodes/n:99', action: 'accept', reviewer: 'x' }), /No entry/);
  assert.throws(() => applyDecision(m, { path: 'rules/0', action: 'accept', reviewer: 'x' }), /Not an entry path/);

  const res = await check({ mapping: m, lpgDoc: auraDoc, targets: prov });
  assert.equal(res.summary.errors, 0);
});

test('propose again: the rejected proposal and the comment reach the model', async () => {
  const { mapping } = await proposed(1);
  const m = applyDecision(mapping, { path: 'relationships/r:6', action: 'reject', reviewer: 'Pierre', comment: 'hadMember is for collections' });
  let prompt;
  const provider = functionProvider((req) => { prompt = req.user; return goldAnswer(auraGold)(req); });
  const res = await propose({ mapping: m, lpgDoc: auraDoc, targets: prov, provider, prefix: 'lin', only: ['relationships/r:6'] });
  assert.match(prompt, /# Reviewer feedback[\s\S]*Reason: hadMember is for collections/);
  assert.equal(res.calls.length, 1);
  assert.equal(res.mapping.relationships['r:6'].meta.status, 'proposed');
  assert.ok(res.mapping.relationships['r:6'].ignore);
});

test('studio server: state, decisions written to the file with its comments, model and errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-studio-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const file = path.join(dir, 'proposed.yaml');
  const { mapping, variants } = await proposed();
  fs.writeFileSync(file, `# Kept comment\n${YAML.stringify(mapping)}`);
  fs.writeFileSync(path.join(dir, 'proposed.variants.json'), JSON.stringify(variants));

  let asked = 0;
  const studio = await startStudio({
    mappingFile: file, port: 0, reviewer: 'Pierre',
    provider: () => functionProvider((req) => { asked++; return goldAnswer(auraGold)(req); }),
  });
  const call = async (p, body) => {
    const res = await fetch(new URL(p, studio.url), body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, data: res.headers.get('content-type').includes('json') ? await res.json() : await res.text() };
  };
  try {
    assert.match((await call('/')).data, /n20s-mapping studio/);
    assert.match((await call('/app.js')).data, /renderGraph/);
    assert.equal((await call('/../package.json')).status, 404);

    let { data } = await call('/api/state');
    assert.equal(data.items.length, 30);
    assert.deepEqual(data.can, { oracle: false, propose: true, recipes: false });
    assert.ok(data.catalog.terms.some((t) => t.curie === 'prov:wasDerivedFrom'));
    const safe = data.items.filter((i) => i.safe).length;
    assert.ok(safe > 0);

    ({ data } = await call('/api/decide', { path: 'relationships/r:0', action: 'accept' }));
    let onDisk = fs.readFileSync(file, 'utf8');
    assert.match(onDisk, /^# Kept comment/);
    assert.equal(YAML.parse(onDisk).relationships['r:0'].meta.reviewedBy, 'Pierre');

    // An edited qualified pattern gets the generated subject.
    ({ data } = await call('/api/decide', { path: 'relationships/r:13', action: 'edit', entry: { predicate: 'prov:wasAssociatedWith', qualified: { class: 'prov:Association', link: 'prov:qualifiedAssociation', target: 'prov:agent' } } }));
    assert.equal(data.mapping.relationships['r:13'].qualified.subject, 'lin:association/{start.p:1}/{end.p:2}');

    ({ data } = await call('/api/accept-safe', {}));
    assert.equal(data.items.filter((i) => i.safe).length, 0);
    assert.ok(data.items.filter((i) => ['accepted', 'ignored', 'deferred'].includes(i.status)).length >= safe);

    ({ data } = await call('/api/propose', { key: 'relationships/r:2', comment: 'Potential only.' }));
    assert.equal(asked, 1);
    onDisk = YAML.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.relationships['r:2'].meta.status, 'proposed');
    assert.ok(onDisk.relationships['r:2'].ignore);

    assert.equal((await call('/api/decide', { path: 'nodes/n:99', action: 'accept' })).status, 400);
    assert.equal((await call('/api/oracle', {})).status, 400);
    assert.equal((await call('/api/nope')).status, 404);
  } finally {
    await studio.close();
  }
});

test('studio recipes: list, detail with outline and findings, step edits keep the file comments, run needs services', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-studio-recipes-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const studio = await startStudio({ mappingFile: path.join(dir, 'lineage-prov.aura.mapping.yaml'), port: 0, reviewer: 'Pierre' });
  const call = async (p, body) => {
    const res = await fetch(new URL(p, studio.url), body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  try {
    let { data } = await call('/api/recipes');
    assert.deepEqual(data.recipes.map((f) => f.steps), [2, 4, 5, 4, 7, 1, 3]);
    assert.deepEqual(data.recipes[4].persistent, ['lineage-prov-kg']);
    assert.equal(data.can, false);
    ({ data } = await call('/api/recipe', { file: '3-tainted-versions.recipe.yaml' }));
    assert.deepEqual(data.findings, []);
    assert.deepEqual(data.outline.steps.find((x) => x.id === 'why').uses, [{ step: 'tainted', column: 'version' }, { step: 'tainted', column: 'input' }]);

    ({ data } = await call('/api/recipe/step', { file: '1-upstream-sources.recipe.yaml', step: 'sources', field: 'sparql', value: 'SELECT ?source WHERE {\n  {{n:0|$version}} prov:wasDerivedFrom ?source\n}\n' }));
    assert.match(data.recipe.steps[1].sparql, /wasDerivedFrom \?source/);
    const text = fs.readFileSync(path.join(dir, 'recipes', '1-upstream-sources.recipe.yaml'), 'utf8');
    assert.match(text, /^# 1\. A plain SPARQL question/);
    assert.match(text, /sparql: \|/);

    assert.equal((await call('/api/recipe/step', { file: '1-upstream-sources.recipe.yaml', step: 'sources', field: 'type', value: 'scope' })).status, 400);
    assert.equal((await call('/api/recipe', { file: '../lineage-prov.aura.mapping.yaml' })).status, 400);
    assert.equal((await call('/api/recipe/run', { file: '1-upstream-sources.recipe.yaml' })).status, 400);
    assert.match((await (await fetch(new URL('/recipes', studio.url))).text()), /n20s-mapping studio/);
  } finally {
    await studio.close();
  }
});

test('studio recipes from scratch: new recipe, graphs, parameter, steps added, edited, moved, deleted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-studio-new-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const studio = await startStudio({ mappingFile: path.join(dir, 'lineage-prov.aura.mapping.yaml'), port: 0, reviewer: 'Pierre' });
  const call = async (p, body) => {
    const res = await fetch(new URL(p, studio.url), { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const file = 'stale-check.recipe.yaml';
  try {
    let { data } = await call('/api/recipe/new', { id: 'stale-check', title: 'Stale' });
    assert.equal(data.created, file);
    assert.equal((await call('/api/recipe/new', { id: 'stale-check' })).status, 400, 'exists');
    assert.equal((await call('/api/recipe/new', { id: '../x' })).status, 400);
    ({ data } = await call('/api/recipe', { file }));
    assert.equal(data.recipe.mapping, '../lineage-prov.aura.mapping.yaml');
    assert.deepEqual(data.findings.map((f) => f.message), ['A recipe needs steps.']);

    // A recipe without declared graphs keeps its implicit work graph when it gets a second one.
    const implicit = path.join(dir, 'recipes', '1-upstream-sources.recipe.yaml');
    const two = (await call('/api/recipe/graph', { file: '1-upstream-sources.recipe.yaml', key: 'kg', lifecycle: 'persistent', name: 'x-kg', start: 'reuse' })).data;
    assert.deepEqual(Object.keys(two.recipe.graphs), ['work', 'kg']);
    assert.deepEqual(two.outline.steps.map((x) => x.graph), ['work', 'work']);
    assert.match(fs.readFileSync(implicit, 'utf8'), /work: \{ lifecycle: ephemeral \}/);
    assert.deepEqual(data.recipe.graphs, { work: { lifecycle: 'ephemeral' } });

    ({ data } = await call('/api/recipe/graph', { file, key: 'kg', lifecycle: 'persistent', name: 'lineage-kg', start: 'rebuild' }));
    assert.deepEqual(data.recipe.graphs.kg, { name: 'lineage-kg', lifecycle: 'persistent', start: 'rebuild' });
    assert.equal((await call('/api/recipe/graph', { file, key: 'kg', lifecycle: 'forever' })).status, 400);

    ({ data } = await call('/api/recipe/param', { file, name: 'source', value: 'raw.orders' }));
    assert.deepEqual(data.recipe.params, { source: { default: 'raw.orders' } });

    ({ data } = await call('/api/recipe/step/add', { file, type: 'scope' }));
    assert.equal(data.recipe.steps[0].id, 'scope-1');
    assert.match(data.recipe.steps[0].cypher, /MATCH p = \(n:Entity\)/);
    ({ data } = await call('/api/recipe/step/add', { file, type: 'query', after: 'scope-1', id: 'ask' }));
    ({ data } = await call('/api/recipe/step/add', { file, type: 'explain', after: 'scope-1' }));
    assert.deepEqual(data.recipe.steps.map((x) => x.id), ['scope-1', 'explain-1', 'ask']);
    assert.equal((await call('/api/recipe/step/add', { file, type: 'query', id: 'ask' })).status, 400, 'duplicate id');
    assert.equal((await call('/api/recipe/step/add', { file, type: 'teleport' })).status, 400);

    ({ data } = await call('/api/recipe/step', { file, step: 'ask', field: 'decode', value: 'run: node:n:1\ninput: node:n:0' }));
    assert.deepEqual(data.recipe.steps[2].decode, { run: 'node:n:1', input: 'node:n:0' });
    ({ data } = await call('/api/recipe/step', { file, step: 'scope-1', field: 'cypher', value: 'MATCH (d:Dataset {name: $source}) RETURN d\n' }));
    ({ data } = await call('/api/recipe/step', { file, step: 'ask', field: 'profile', value: '' }));
    assert.equal(data.recipe.steps[2].profile, undefined, 'empty removes the field');
    assert.equal((await call('/api/recipe/step', { file, step: 'ask', field: 'decode', value: 'a: [' })).status, 400);

    ({ data } = await call('/api/recipe/step', { file, step: 'ask', field: 'graph', value: 'kg' }));
    assert.equal(data.outline.steps.find((x) => x.id === 'ask').graph, 'kg');
    assert.equal((await call('/api/recipe/graph', { file, key: 'kg', remove: true })).status, 400, 'a step uses it');
    ({ data } = await call('/api/recipe/step/move', { file, step: 'ask', delta: -1 }));
    assert.deepEqual(data.recipe.steps.map((x) => x.id), ['scope-1', 'ask', 'explain-1']);
    ({ data } = await call('/api/recipe/step/delete', { file, step: 'explain-1' }));
    assert.deepEqual(data.recipe.steps.map((x) => x.id), ['scope-1', 'ask']);
    assert.deepEqual(data.findings, []);

    ({ data } = await call('/api/recipe/param', { file, name: 'source', remove: true }));
    assert.match(data.findings.map((f) => f.message).join(), /\$source in the Cypher is neither a recipe parameter nor in params/);

    const text = fs.readFileSync(path.join(dir, 'recipes', file), 'utf8');
    assert.match(text, /^# Created in the studio\./);
    assert.match(text, /cypher: \|\n {6}MATCH \(d:Dataset/);
  } finally {
    await studio.close();
  }
});

test('studio bench: collection, targets, save keeps comments, delete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-studio-bench-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const studio = await startStudio({ mappingFile: path.join(dir, 'lineage-prov.aura.mapping.yaml'), port: 0, reviewer: 'Pierre' });
  const call = async (p, body) => {
    const res = await fetch(new URL(p, studio.url), body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  try {
    let { data } = await call('/api/bench');
    assert.equal(data.bench.requests.length, 8);
    assert.deepEqual(data.problems, []);
    assert.deepEqual(data.targets.apis.map((a) => a.name).sort(), ['influences', 'owners', 'owners-to-notify']);
    assert.equal(data.targets.recipes.length, 7);
    ({ data } = await call('/api/bench/save', { request: { id: 'plans', target: { sparql: 'lineage' }, sparql: 'SELECT ?p {}', expect: { status: 200 } } }));
    assert.equal(data.bench.requests.at(-1).id, 'plans');
    ({ data } = await call('/api/bench/save', { request: { id: 'plans2', target: { sparql: 'lineage' }, sparql: 'SELECT ?p {}' }, previous: 'plans' }));
    assert.deepEqual(data.bench.requests.slice(-1).map((r) => r.id), ['plans2'], 'renamed in place');
    assert.equal((await call('/api/bench/save', { request: { id: 'owners-lazy', target: { sparql: 'lineage' }, sparql: 'ASK {}' }, previous: 'plans2' })).status, 400, 'renamed to an id another request has');
    ({ data } = await call('/api/bench/delete', { id: 'plans2' }));
    assert.equal(data.bench.requests.length, 8);
    const text = fs.readFileSync(path.join(dir, 'recipes', 'bench.yaml'), 'utf8');
    assert.match(text, /^# Requests against the published endpoints/);
    assert.match((await (await fetch(new URL('/bench.js', studio.url))).text()), /export async function benchmark/);
  } finally {
    await studio.close();
  }
});
