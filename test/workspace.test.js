import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { readProject, checkProject, targetInfo, fetchTarget, newMapping, projectStatus, addToProject } from '../src/workspace.js';
import { CATALOG } from '../src/catalog.js';
import { startStudio } from '../src/studio.js';
import { EXAMPLE } from './helpers.js';

const copy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-project-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  return path.join(dir, 'n20s-project.yaml');
};
const ttl = '@prefix d: <http://www.w3.org/ns/dcat#> . @prefix owl: <http://www.w3.org/2002/07/owl#> . d:Dataset a owl:Class . d:distribution a owl:ObjectProperty .';
const fakeFetch = (body) => async () => new Response(body, { status: 200 });

test('project: checks, and targets resolved from the catalog', async () => {
  const p = await readProject(copy());
  assert.deepEqual(checkProject(p.project), []);
  assert.deepEqual(checkProject({ format: 'n20s-project/0.1', sources: { s: {} }, targets: { a: { catalog: 'nope' }, b: { url: 'x' } }, mappings: { m: { source: 'z', targets: ['y'] } } }), [
    'sources/s: a source needs a file (the export, or where the introspection is written).',
    'targets/a: nope is not in the catalog (' + CATALOG.map((c) => c.id).join(', ') + ').',
    'targets/b: a target from a file or URL needs its namespace.',
    'mappings/m: source z is not declared.', 'mappings/m: target y is not declared.', 'mappings/m: a mapping needs a file.',
  ]);
  const dcat = targetInfo(p, 'dcat');
  assert.deepEqual([dcat.origin, dcat.prefix, dcat.namespace, dcat.file], ['catalog', 'dcat', 'http://www.w3.org/ns/dcat#', 'targets/dcat.ttl']);
});

test('fetch: a catalog target is downloaded, pinned, and a changed document is refused unless repinned', async () => {
  const file = copy();
  let p = await readProject(file);
  const r = await fetchTarget(p, 'dcat', { fetch: fakeFetch(ttl) });
  assert.deepEqual([r.terms, r.triples], [2, 2]);
  assert.ok(fs.existsSync(path.join(path.dirname(file), 'targets/dcat.ttl')));
  p = await readProject(file);
  assert.equal(p.lock.targets.dcat.sha256, r.sha256);
  await assert.rejects(fetchTarget(p, 'dcat', { fetch: fakeFetch(`${ttl} d:Catalog a owl:Class .`) }), /changed since it was pinned/);
  const again = await fetchTarget(p, 'dcat', { fetch: fakeFetch(`${ttl} d:Catalog a owl:Class .`), repin: true });
  assert.equal(again.terms, 3);
  await assert.rejects(fetchTarget(p, 'prov', { fetch: fakeFetch(ttl) }), /is a file/);
});

test('new mapping: an empty mapping between a source and targets, added to the project with its comments', async () => {
  const file = copy();
  let p = await readProject(file);
  await fetchTarget(p, 'dcat', { fetch: fakeFetch(ttl) });
  p = await readProject(file);
  await assert.rejects(newMapping(p, { id: 'x', source: 'lineage-db', targets: ['dcat'], baseIri: 'https://e.org/x/' }), /introspect it first/);
  await assert.rejects(newMapping(p, { id: 'x', source: 'lineage', targets: ['dcat'], baseIri: 'not an iri' }), /base IRI/);
  const r = await newMapping(p, { id: 'lineage-dcat', source: 'lineage', targets: ['dcat'], baseIri: 'https://example.org/catalog/', prefix: 'cat' });
  const m = YAML.parse(fs.readFileSync(path.join(path.dirname(file), r.file), 'utf8'));
  assert.deepEqual([m.lpgOntology.location, m.targets[0].location, m.prefixes.cat, m.prefixes.dcat], ['aura-export.json', 'targets/dcat.ttl', 'https://example.org/catalog/', 'http://www.w3.org/ns/dcat#']);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# The lineage example as a project/);
  assert.match(text, /lineage-dcat:/);
  await addToProject(await readProject(file), 'targets', 'org', { catalog: 'org' });
  const st = await projectStatus(await readProject(file));
  assert.deepEqual(st.mappings.map((x) => [x.id, x.coverage?.decided, x.coverage?.total]), [['lineage-prov', 114, 114], ['lineage-dcat', 0, 114]]);
  assert.deepEqual(st.targets.map((t) => [t.id, t.exists]), [['prov', true], ['dcat', true], ['org', false]]);
  assert.equal(st.sources.find((s) => s.id === 'lineage').doc.described, 30);
});

test('studio on a project: the Project tab, and switching the open mapping', async () => {
  const file = copy();
  const p = await readProject(file);
  await fetchTarget(p, 'dcat', { fetch: fakeFetch(ttl) });
  await newMapping(await readProject(file), { id: 'lineage-dcat', source: 'lineage', targets: ['dcat'], baseIri: 'https://example.org/catalog/', prefix: 'cat' });
  const studio = await startStudio({ projectFile: file, port: 0, reviewer: 'Pierre' });
  const call = async (q, body) => { const r = await fetch(new URL(q, studio.url), body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  try {
    let { data } = await call('/api/project');
    assert.equal(data.active, 'lineage-prov');
    assert.equal((await call('/api/state')).data.items.filter((i) => i.status === 'undecided').length, 0);
    ({ data } = await call('/api/project/open', { mapping: 'lineage-dcat' }));
    assert.equal(data.active, 'lineage-dcat');
    const st = (await call('/api/state')).data;
    assert.deepEqual([st.project.mapping, st.items.filter((i) => i.status === 'undecided').length], ['lineage-dcat', 30]);
    assert.equal((await call('/api/project/open', { mapping: 'nope' })).status, 400);
    assert.equal((await call('/api/project/introspect', { source: 'lineage-db' })).status, 400, 'no source configured');
  } finally {
    await studio.close();
  }
});
