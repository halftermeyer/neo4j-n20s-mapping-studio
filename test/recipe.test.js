import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { checkRecipe, recipeOutline, recipeKind, coerceParams, graphOf, runRecipe, compile } from '../src/index.js';
import { ROOT, EXAMPLE, auraGold, auraDoc } from './helpers.js';

const DIR = path.join(EXAMPLE, 'recipes');
const recipes = Object.fromEntries(fs.readdirSync(DIR).filter((f) => f.endsWith('.recipe.yaml')).map((f) => [f.split('.')[0], YAML.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))]));
const messages = (recipe) => checkRecipe(recipe, { mapping: auraGold }).map((f) => `${f.path}: ${f.message}`);

test('example recipes check clean', () => {
  assert.equal(Object.keys(recipes).length, 7);
  for (const [name, recipe] of Object.entries(recipes)) assert.deepEqual(messages(recipe), [], name);
});

test('checkRecipe: types, fields, ids, references to later steps and unknown parameters', () => {
  const f = structuredClone(recipes['4-owners-to-notify']);
  f.steps.push({ id: 'owners', type: 'query', sparql: 'SELECT * {}' });
  f.steps.push({ id: 'x', type: 'teleport' });
  f.steps.push({ id: 'y', type: 'explain', s: '{{n:0|$nope}}', p: 'prov:used' });
  f.steps.splice(2, 0, { id: 'early', type: 'scope', cypher: 'MATCH (n) WHERE n.id IN $ids RETURN n', params: { ids: '$later.version' } });
  f.steps.push({ id: 'later', type: 'query', sparql: 'SELECT ?version {}' });
  f.steps.push({ id: 'z', type: 'scope', cypher: 'MATCH (n {id: $unknown}) RETURN n' });
  const m = messages(f);
  assert.ok(m.includes('steps/owners: Step id owners is used twice.'), m.join('\n'));
  assert.ok(m.some((x) => /steps\/x: Unknown step type teleport/.test(x)));
  assert.ok(m.includes('steps/y: An explain step needs o.'));
  assert.ok(m.includes('steps/y: $nope is not a parameter of the recipe.'));
  assert.ok(m.includes('steps/early: $later.version refers to a step that does not run before it.'));
  assert.ok(m.includes('steps/z: $unknown in the Cypher is neither a recipe parameter nor in params.'));
  // SPARQL may use $ for variables: not a reference.
  assert.deepEqual(messages({ ...recipes['1-upstream-sources'], steps: [...recipes['1-upstream-sources'].steps, { id: 'q', type: 'query', sparql: 'SELECT $x WHERE { $x ?p ?o }' }] }), []);
});

test('graphs: lifecycles, names and starts are checked; steps use declared graphs', () => {
  const base = recipes['1-upstream-sources'];
  assert.equal(graphOf(base, base.steps[0]), 'work', 'no graphs declared: one ephemeral graph, work');
  const with_ = (graphs, steps = base.steps) => messages({ ...base, graphs, steps });
  assert.deepEqual(with_({ kg: { lifecycle: 'persistent', name: 'lineage', start: 'reuse' } }), [], 'one graph: steps use it');
  assert.ok(with_({ kg: { lifecycle: 'persistent' } }).some((x) => /needs a name/.test(x)));
  assert.ok(with_({ kg: { lifecycle: 'persistent', name: 'x' } }).some((x) => /needs start: rebuild/.test(x)));
  assert.ok(with_({ kg: { lifecycle: 'forever' } }).some((x) => /Unknown lifecycle forever/.test(x)));
  assert.ok(with_({ w: { lifecycle: 'ephemeral', name: 'fixed' } }).some((x) => /An ephemeral graph has no name/.test(x)));
  assert.ok(with_({ a: { lifecycle: 'persistent', name: 'same', start: 'reuse' }, b: { lifecycle: 'persistent', name: 'same', start: 'reuse' } }, [{ ...base.steps[0], graph: 'a' }, { ...base.steps[1], graph: 'a' }]).some((x) => /name same is used by a too/.test(x)));
  assert.ok(with_({ a: { lifecycle: 'ephemeral' }, b: { lifecycle: 'ephemeral' } }).some((x) => /Graph work is not declared/.test(x)), 'several graphs: steps say which');
});

test('recipeOutline: the steps in order, their role, their graph, the results they use', () => {
  const o = recipeOutline(recipes['4-owners-to-notify']);
  assert.deepEqual(o.graphs, [{ key: 'work', lifecycle: 'ephemeral', name: null, start: null, versioned: false, endpoint: null }]);
  assert.deepEqual(o.steps.map((s) => `${s.id}:${s.role}:${s.graph}`), ['downstream:feed:work', 'tainted:ask:work', 'owners-scope:feed:work', 'owners:ask:work']);
  assert.deepEqual(o.steps[2].uses, [{ step: 'tainted', column: 'version' }]);
  const kg = recipeOutline(recipes['5-lineage-kg']);
  assert.deepEqual(kg.graphs, [{ key: 'kg', lifecycle: 'persistent', name: 'lineage-prov-kg', start: 'rebuild', versioned: true, endpoint: null }]);
  assert.deepEqual(kg.steps.map((s) => s.role), ['feed', 'feed', 'feed', 'ask', 'change', 'change', 'publish']);
  assert.deepEqual(kg.steps.at(-1).uses, [{ step: 'check', column: 'conforms' }], 'a gate uses the validation result');
  const hybrid = recipeOutline(recipes['7-owners-hybrid']);
  assert.equal(hybrid.steps.find((s) => s.id === 'attributions').role, 'feed', 'a construct from another graph feeds its own');
});

test('kinds: what a recipe computes ahead and what on demand', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(recipes).map(([k, r]) => [k, recipeKind(r)])), {
    '1-upstream-sources': 'lazy', '2-influences': 'lazy', '3-tainted-versions': 'lazy', '4-owners-to-notify': 'lazy',
    '5-lineage-kg': 'build', '6-ask-lineage-kg': 'precomputed', '7-owners-hybrid': 'hybrid',
  });
});

test('publish, published graphs, construct from, api: checked before running', () => {
  const kg = recipes['5-lineage-kg'];
  const steps = (f) => messages({ ...kg, steps: f(structuredClone(kg.steps)) });
  assert.ok(steps((x) => { x.at(-1).gate = ['closure']; return x; }).includes('steps/publish: Gate closure is not a validate step.'));
  assert.ok(steps((x) => { x.at(-1).gate = ['later']; return x; }).includes('steps/publish: Gate later is not a step that runs before.'));
  assert.ok(steps((x) => [...x, { id: 'again', type: 'publish', as: 'lineage' }]).includes('steps/again: Endpoint lineage is published twice.'));
  assert.ok(messages({ ...recipes['1-upstream-sources'], steps: [...recipes['1-upstream-sources'].steps, { id: 'p', type: 'publish', as: 'x' }] }).includes('steps/p: Only a persistent graph can be published; work is ephemeral.'));
  assert.ok(messages({ ...kg, graphs: { kg: { name: 'k', lifecycle: 'persistent', versioned: true, start: 'reuse' } } }).includes('graphs/kg: A versioned graph is built anew on every run: start is rebuild.'));

  const ask = recipes['6-ask-lineage-kg'];
  assert.ok(messages({ ...ask, steps: [...ask.steps, { id: 'w', type: 'triples', turtle: '# x' }] }).includes('steps/w: Graph kg is published: read it, or construct from it into another graph.'));
  assert.ok(messages({ ...ask, graphs: { kg: { lifecycle: 'published' } } }).includes('graphs/kg: A published graph names the endpoint it reads: endpoint: <name>.'));
  assert.ok(messages({ ...ask, api: { name: 'x', result: 'nope' } }).includes('api: api.result nope is not a query, validate or explain step.'));
  const hy = recipes['7-owners-hybrid'];
  assert.ok(messages({ ...hy, steps: hy.steps.map((x) => (x.id === 'attributions' ? { ...x, from: 'other' } : x)) }).includes('steps/attributions: Graph other is not declared in graphs.'));
  assert.ok(messages({ ...hy, steps: hy.steps.map((x) => (x.id === 'downstream' ? { ...x, from: 'kg' } : x)) }).includes('steps/downstream: from is for construct steps: they copy from another graph.'));
});

test('coerceParams: query-string values become what the recipe declares', () => {
  const r = { params: { n: { type: 'integer' }, x: { type: 'number' }, b: { type: 'boolean' }, l: { type: 'list' }, s: {} } };
  assert.deepEqual(coerceParams(r, { n: '3', x: '1.5', b: 'true', l: 'a, b', s: 7 }), { params: { n: 3, x: 1.5, b: true, l: ['a', 'b'], s: '7' }, errors: [] });
  assert.deepEqual(coerceParams(r, { l: '["a","b"]' }).params.l, ['a', 'b']);
  assert.deepEqual(coerceParams(r, { n: '3.2', b: 'maybe', z: 1 }).errors, ['n: not an integer.', 'b: true or false.', 'Unknown parameter z.']);
});

test('runRecipe refuses a recipe with errors or unknown parameters before touching anything', async () => {
  const { plan } = await compile(auraGold, auraDoc);
  const touch = { run: () => assert.fail('no source call'), drop: () => assert.fail('no n20s call'), list: () => assert.fail('no n20s call') };
  await assert.rejects(runRecipe({ recipe: { ...recipes['1-upstream-sources'], steps: [] }, mapping: auraGold, lpgDoc: auraDoc, plan, source: touch, n20s: touch }), /needs steps/);
  await assert.rejects(runRecipe({ recipe: recipes['1-upstream-sources'], params: { nope: 1 }, mapping: auraGold, lpgDoc: auraDoc, plan, source: touch, n20s: touch }), /Unknown parameter nope/);
});

test('cli recipe --check', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/n20s-mapping.js'), 'recipe', path.join(DIR, '3-tainted-versions.recipe.yaml'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /5 steps, no finding/);
});
