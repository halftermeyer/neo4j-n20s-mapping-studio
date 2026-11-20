import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import {
  check, indexLpg, propose, acceptAll, compile, prepareSubjects, valueTable, slug, rekeyMapping, rekeyOracle,
  functionProvider, recordingProvider, replayProvider, geminiProvider, RECORDING_FORMAT, PROMPT_VERSION,
} from '../src/index.js';
import { proposeFiles } from '../src/node.js';
import { ROOT, EXAMPLE, baseMapping, baseDoc, prov, auraDoc, auraGold, auraBlank, goldAnswer, codes } from './helpers.js';

const BIN = path.join(ROOT, 'bin/n20s-mapping.js');
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('N20S_') && !k.startsWith('NEO4J_') && k !== 'GEMINI_API_KEY'));
const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: ENV });

const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'meta' ? undefined : v)));

test('aliases: a subtype property with the name and type of an inherited one is that property', () => {
  const idx = indexLpg(auraDoc);
  assert.deepEqual(idx.aliasOf('n:3', 'p:4'), { owner: 'n:0', prop: idx.nodes.get('n:0').props.get('p:0') }); // Dataset.id
  assert.equal(idx.aliasOf('n:3', 'p:0').owner, 'n:0'); // repeated under the same id
  assert.equal(idx.aliasOf('n:9', 'p:33').prop.id, 'p:1'); // Run.id -> Activity.id
  assert.equal(idx.aliasOf('n:3', 'p:6'), null); // Dataset.name: Entity has no name
  assert.equal(idx.aliasOf('n:0', 'p:0'), null); // a root property is no alias
});

test('rekey: the lineage gold moves onto the Aura export with the same decisions', async () => {
  const { mapping, unmatched } = rekeyMapping(baseMapping, baseDoc, auraDoc);
  assert.deepEqual(unmatched, []);
  assert.equal(mapping.nodes['n:0'].subject, 'lin:entity/{p:0}');
  assert.equal(mapping.relationships['r:0'].qualified.subject, 'lin:usage/{start.p:1}/{end.p:0}', 'Run.id resolves to Activity.id, which the constraint covers');
  assert.deepEqual(strip(mapping.relationships['r:2']), strip(baseMapping.relationships['depends-on']));

  const res = await check({ mapping, lpgDoc: auraDoc, targets: prov });
  assert.equal(res.summary.errors, 0, JSON.stringify(res.findings));
  // The export has no cardinalities: start-only qualified subjects are no longer known to be unique.
  assert.deepEqual(codes(res, 'warning'), ['qualified.not-unique', 'qualified.not-unique']);
  assert.deepEqual(res.coverage.undecided, [], 'aliases count as decided');
  assert.deepEqual(strip(mapping), strip({ ...auraGold, id: mapping.id, lpgOntology: mapping.lpgOntology }), 'the committed gold is up to date (node eval/rekey-gold.js)');

  const oracle = rekeyOracle(YAML.parse(fs.readFileSync(path.join(EXAMPLE, 'oracle.yaml'), 'utf8')), baseDoc, auraDoc);
  const q32 = oracle.checks.find((c) => c.id.startsWith('q32'));
  assert.deepEqual(q32.decode, { run: 'node:n:1', role: 'values:relationships/r:13/properties/p:68' });
  assert.match(oracle.checks.find((c) => c.id.startsWith('q33')).sparql, /\{\{n:0\|/);
});

test('prepare: subjects from uniqueness constraints on root kinds, value tables encoded like n20s', () => {
  const { mapping, added, unresolved } = prepareSubjects(auraBlank(), auraDoc, { prefix: 'lin' });
  assert.deepEqual(added, ['n:0', 'n:1', 'n:2']);
  assert.deepEqual(unresolved, []);
  assert.equal(mapping.nodes['n:3'], undefined, 'subtypes inherit');
  for (const id of added) assert.equal(mapping.nodes[id].subject, auraGold.nodes[id].subject);
  assert.equal(mapping.nodes['n:0'].meta.proposedBy.kind, 'tool');
  assert.throws(() => prepareSubjects(auraBlank(), auraDoc, { prefix: 'nope' }), /not declared/);

  const doc = structuredClone(auraDoc);
  delete doc.nodes['n:2'].constraints;
  assert.deepEqual(prepareSubjects(auraBlank(), doc, { prefix: 'lin' }).unresolved.map((u) => u.node), ['n:2']);

  assert.equal(slug('DatasetVersion'), 'dataset-version');
  assert.deepEqual(valueTable('role', ['b', 'a b', 'a'], { prefix: 'lin' }), { a: 'lin:role/a', 'a b': 'lin:role/a%20b', b: 'lin:role/b' });
});

test('propose: answers become proposed entries; gold answers give back the gold decisions', async () => {
  const requests = [];
  const answer = goldAnswer(auraGold);
  const provider = functionProvider((req) => { requests.push(req); return answer(req); });
  const res = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider, prefix: 'lin' });

  assert.equal(res.result.summary.errors, 0, JSON.stringify(res.result.findings));
  assert.deepEqual(res.dropped, []);
  assert.equal(requests.length, 30, 'one call per node kind and relationship type');
  assert.ok(requests.findIndex((r) => r.element === 'nodes/n:0') < requests.findIndex((r) => r.element === 'nodes/n:3'), 'general kinds first');
  const asked = (el) => requests.find((r) => r.element === el).schema.properties.properties?.items.properties.id.enum ?? [];
  assert.ok(asked('nodes/n:3').includes('p:6') && !asked('nodes/n:3').includes('p:4'), 'aliases are not asked');
  assert.deepEqual(asked('nodes/n:0'), [], 'subject properties are not asked');

  // Same decisions as the gold; generated IRIs (qualified subjects, value tables) may differ.
  const decisions = (m) => JSON.parse(JSON.stringify(m, (k, v) => (['meta', 'subject', 'values'].includes(k) ? undefined : v)));
  assert.deepEqual(decisions(res.mapping.nodes), decisions(auraGold.nodes));
  assert.deepEqual(decisions(res.mapping.relationships), decisions(auraGold.relationships));
  assert.equal(res.mapping.relationships['r:13'].qualified.subject, 'lin:association/{start.p:1}/{end.p:2}');
  assert.deepEqual(res.mapping.relationships['r:13'].properties['p:68'].values, { executor: 'lin:role/executor', triggeredBy: 'lin:role/triggeredBy' });

  const m = res.mapping.relationships['r:2'].meta;
  assert.deepEqual(m.proposedBy, { kind: 'ai', model: 'test', promptVersion: PROMPT_VERSION });
  assert.equal(m.status, 'proposed');
  assert.equal(res.result.coverage.relationships.proposed, 17, 'proposed ignores are pending, not decided');

  // Nothing compiles until accepted.
  assert.equal((await compile(res.mapping, auraDoc)).plan.units.length, 0);
  assert.ok((await compile(acceptAll(res.mapping), auraDoc)).plan.units.length > 0);
});

test('propose: terms are enums over the catalog; an invented term is an invalid answer', async () => {
  let seen;
  const provider = functionProvider((req) => {
    if (req.element !== 'relationships/r:3') return goldAnswer(auraGold)(req);
    seen = req;
    return { ...goldAnswer(auraGold)(req), predicate: 'prov:wasComputedFrom' };
  });
  const res = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider, prefix: 'lin' });
  const defs = seen.schema.$defs;
  assert.equal(seen.schema.properties.predicate.$ref, '#/$defs/relation');
  assert.ok(defs.relation.enum.includes('prov:wasDerivedFrom'));
  assert.ok(!defs.relation.enum.includes('rdfs:label') && !defs.relation.enum.includes('prov:generatedAtTime'), 'no datatype property between two nodes');
  assert.ok(defs.property.enum.includes('rdfs:label') && defs.property.enum.includes('prov:generatedAtTime'), 'node properties may take them');
  assert.ok(!defs.property.enum.includes('prov:Entity'), 'classes are not predicates');
  assert.equal(seen.schema.properties.qualified.properties.class.$ref, '#/$defs/class');
  assert.ok(defs.class.enum.includes('prov:Derivation'));
  assert.match(res.notes.find((n) => n.path === 'relationships/r:3').message, /Invalid answer.*predicate/);
  assert.equal(res.mapping.relationships['r:3'], undefined);

  // Open terms: no enum, the checker catches the invented term.
  const open = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider, prefix: 'lin', openTerms: true, repair: false });
  assert.equal(open.dropped[0].element, 'relationships/r:3');
  assert.match(open.dropped[0].findings[0], /^target\.unknown-term/);
});

test('propose: an ignore without a reason takes its rationale as the reason; without either it is invalid', async () => {
  const answer = (rationale) => functionProvider((req) => {
    const a = goldAnswer(auraGold)(req);
    if (req.element === 'relationships/r:2') { delete a.reason; a.rationale = rationale; }
    return a;
  });
  const ok = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider: answer('Potential, not asserted.'), prefix: 'lin' });
  assert.equal(ok.mapping.relationships['r:2'].ignore.reason, 'Potential, not asserted.');
  const bad = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider: answer(''), prefix: 'lin' });
  assert.match(bad.notes.find((n) => n.path === 'relationships/r:2').message, /ignore without a reason/);
  assert.equal(bad.mapping.relationships['r:2'], undefined);
});

test('propose: a qualified pattern without the unqualified predicate gets it from the target (qualifiedForm)', async () => {
  const provider = functionProvider((req) => {
    const a = goldAnswer(auraGold)(req);
    if (req.element === 'relationships/r:0') delete a.predicate; // USED: qualified prov:Usage only
    if (req.element === 'relationships/r:14') a.predicate = 'prov:qualifiedAttribution'; // the link as predicate
    return a;
  });
  const res = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider, prefix: 'lin' });
  assert.equal(res.mapping.relationships['r:0'].predicate, 'prov:used');
  assert.equal(res.mapping.relationships['r:14'].predicate, 'prov:wasAttributedTo');
  assert.deepEqual(res.completed, [
    { element: 'relationships/r:0', predicate: 'prov:used', was: null },
    { element: 'relationships/r:14', predicate: 'prov:wasAttributedTo', was: 'prov:qualifiedAttribution' },
  ]);
});

test('propose: an invalid answer gets one repair call at once', async () => {
  let calls = 0;
  const provider = functionProvider((req) => {
    const a = goldAnswer(auraGold)(req);
    if (req.element !== 'relationships/r:3') return a;
    calls++;
    if (req.user.includes('# The checker rejected it')) { assert.match(req.user, /answer\.invalid.*p:54: no answer/); return a; }
    a.properties = a.properties.filter((p) => p.id !== 'p:54');
    return a;
  });
  const res = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider, prefix: 'lin' });
  assert.equal(calls, 2);
  assert.deepEqual(res.repaired.map((r) => r.element), ['relationships/r:3']);
  assert.ok(res.mapping.relationships['r:3'].properties['p:54'].ignore);
});

test('propose: check errors get one repair call with the findings, then the element is dropped', async () => {
  // A relationship property mapped without a qualified pattern: rel.property-without-qualified.
  const bad = (req) => {
    const a = goldAnswer(auraGold)(req);
    if (req.element === 'relationships/r:13') delete a.qualified;
    return a;
  };
  let repairPrompt;
  const fixes = functionProvider((req) => {
    if (req.user.includes('# The checker rejected it')) { repairPrompt = req.user; return goldAnswer(auraGold)(req); }
    return bad(req);
  });
  const res = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider: fixes, prefix: 'lin' });
  assert.match(repairPrompt, /rel\.property-without-qualified/);
  assert.deepEqual(res.repaired.map((r) => r.element), ['relationships/r:13']);
  assert.ok(res.mapping.relationships['r:13'].qualified);
  assert.equal(res.result.summary.errors, 0);

  const stubborn = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider: functionProvider(bad), prefix: 'lin' });
  assert.deepEqual(stubborn.dropped.map((d) => d.element), ['relationships/r:13']);
  assert.equal(stubborn.mapping.relationships['r:13'], undefined, 'restored to what it was before the call');
  assert.equal(stubborn.result.summary.errors, 0);
  assert.ok(stubborn.result.coverage.undecided.includes('relationships/r:13'));
});

test('propose: without descriptions, no description reaches the model; decided elements are not asked', async () => {
  const requests = [];
  const provider = functionProvider((req) => { requests.push(req); return goldAnswer(auraGold)(req); });
  const start = { ...auraBlank(), nodes: structuredClone(auraGold.nodes) };
  await propose({ mapping: start, lpgDoc: auraDoc, targets: prov, provider, prefix: 'lin', descriptions: false });
  assert.equal(requests.length, 17, 'only the relationship types');
  for (const r of requests) assert.ok(!r.user.includes('over-approximation') && !r.user.includes('"description"'), r.element);
  const dep = requests.find((r) => r.element === 'relationships/r:2').user;
  assert.match(dep, /"classes": \[\s*"prov:Entity"\s*\]/, 'end classes from the decisions so far');
});

test('providers: recording and replay; Gemini sends the key in a header and refuses truncated answers', async () => {
  const rec = recordingProvider(functionProvider(() => ({ ok: true })));
  const req = { element: 'x', system: 's', user: 'u', schema: { type: 'object' } };
  await rec.complete(req);
  assert.equal(rec.recording.format, RECORDING_FORMAT);
  const replay = replayProvider(JSON.parse(JSON.stringify(rec.recording)));
  assert.deepEqual((await replay.complete(req)).json, { ok: true });
  await assert.rejects(replay.complete({ ...req, user: 'changed' }), /prompt changed/);

  const sent = [];
  const fakeFetch = (finishReason, parts) => async (url, init) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ candidates: [{ finishReason, content: { parts } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 1 } }), { status: 200 });
  };
  const g = geminiProvider({ apiKey: 'k-secret', fetch: fakeFetch('STOP', [{ thought: true, text: 'thinking' }, { text: '{"a":1}' }]) });
  const r = await g.complete(req);
  assert.deepEqual(r.json, { a: 1 });
  assert.deepEqual(r.usage, { input: 3, output: 2, thinking: 1, cached: 0 });
  assert.ok(!sent[0].url.includes('k-secret'));
  assert.equal(sent[0].init.headers['x-goog-api-key'], 'k-secret');
  assert.deepEqual(JSON.parse(sent[0].init.body).generationConfig.responseJsonSchema, { type: 'object' });
  const cut = geminiProvider({ apiKey: 'k', fetch: fakeFetch('MAX_TOKENS', [{ text: '{"a"' }]) });
  await assert.rejects(cut.complete(req), /MAX_TOKENS/);
  assert.throws(() => geminiProvider({}), /GEMINI_API_KEY/);
});

test('cli propose: writes proposals to --out from a recording, the input mapping unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-propose-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const input = path.join(dir, 'blank.yaml');
  fs.writeFileSync(input, YAML.stringify(auraBlank()));
  const before = fs.readFileSync(input, 'utf8');

  // Record gold answers through the library, as the CLI would ask them.
  const provider = recordingProvider(functionProvider(goldAnswer(auraGold), { name: 'gold', model: 'gold-answers' }));
  await proposeFiles(input, { prefix: 'lin', provider });
  const recording = path.join(dir, 'answers.json');
  fs.writeFileSync(recording, JSON.stringify(provider.recording));

  fs.mkdirSync(path.join(dir, 'out'));
  const out = path.join(dir, 'out', 'proposed.yaml');
  let r = cli('propose', input, '--out', out, '--prefix', 'lin', '--replay', recording);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Wrote .*30 calls to gold-answers/);
  assert.equal(fs.readFileSync(input, 'utf8'), before);
  const proposed = YAML.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(proposed.lpgOntology.location, '../aura-export.json', 'paths rebased to --out');
  assert.equal(proposed.relationships['r:2'].meta.status, 'proposed');
  r = cli('check', out);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /relationship types\s+0\/17\s+proposed 17/);

  r = cli('propose', input, '--out', out, '--prefix', 'nope', '--replay', recording);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base-iri/);
  r = cli('propose', input, '--out', out, '--prefix', 'lin');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /GEMINI_API_KEY/);
});

test('propose: a schema the provider finds too large goes without the term lists; the full schema still judges the answer', async () => {
  const sent = [];
  const provider = functionProvider((req) => {
    sent.push(!!req.schema.$defs);
    if (req.schema.$defs) throw new Error('Gemini 400: The specified schema produces a constraint that has too many states for serving.');
    const a = goldAnswer(auraGold)(req);
    // The first answer for WAS_DERIVED_FROM invents a term; the repair call gets it right.
    if (req.element === 'relationships/r:3' && !req.user.includes('# The checker rejected it')) a.predicate = 'prov:wasComputedFrom';
    return a;
  });
  const res = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider, prefix: 'lin' });
  assert.ok(sent.includes(true) && sent.includes(false), 'tried with the lists, then without');
  assert.equal(res.result.summary.errors, 0);
  assert.equal(res.mapping.relationships['r:3'].predicate, 'prov:wasDerivedFrom');
  assert.ok(res.repaired.some((r) => r.element === 'relationships/r:3'), 'the invented term was repaired');
});
