import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, EXAMPLE, baseMapping, baseDoc } from './helpers.js';
import { compile, SNAPSHOT_FORMAT } from '../src/index.js';

const BIN = path.join(ROOT, 'bin/n20s-mapping.js');
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('N20S_') && !k.startsWith('NEO4J_')));
const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: ENV });

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-mapping-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  return dir;
}

test('check, drift, refused lock, fix, lock', () => {
  const dir = workspace();
  const mappingFile = path.join(dir, 'lineage-prov.mapping.yaml');
  const docFile = path.join(dir, 'data-lineage-ontology.json');

  let r = cli('check', mappingFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0 error\(s\), 0 warning\(s\), 0 info/);

  // Version 4 of the LPG ontology: a mapped property changes type, another disappears.
  const doc = JSON.parse(fs.readFileSync(docFile, 'utf8'));
  doc.version = '4';
  doc.nodes['dataset-version'].properties.generatedAt.type = 'STRING';
  delete doc.nodes.run.properties.endedAt;
  fs.writeFileSync(docFile, JSON.stringify(doc, null, 2));

  r = cli('check', mappingFile, '--json');
  assert.equal(r.status, 1);
  const res = JSON.parse(r.stdout);
  const codes = res.findings.map((f) => f.code);
  for (const c of ['ref.unknown-property', 'drift.type-changed', 'drift.version-changed', 'drift.property-removed']) assert.ok(codes.includes(c), c);

  r = cli('lock', mappingFile);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Not locked/);

  // Fix: drop the entry for the removed property, accept the new type as a plain string.
  let text = fs.readFileSync(mappingFile, 'utf8');
  text = text.replace(/^ {6}endedAt: .*\n/m, '');
  text = text.replace('generatedAt: { predicate: prov:generatedAtTime, datatype: xsd:dateTime }', 'generatedAt: { ignore: { reason: "Became a string in v4." } }');
  fs.writeFileSync(mappingFile, text);

  r = cli('lock', mappingFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /mapping header set to version 4/);
  const after = fs.readFileSync(mappingFile, 'utf8');
  assert.match(after, /^# Data lineage LPG -> W3C PROV-O\./, 'comments are kept');
  assert.match(after, /version: "4"/);

  r = cli('check', mappingFile, '--strict');
  assert.equal(r.status, 0, r.stdout);
});

test('warnings fail only with --strict', () => {
  const dir = workspace();
  const mappingFile = path.join(dir, 'lineage-prov.mapping.yaml');
  const text = fs.readFileSync(mappingFile, 'utf8').replace('subject: "lin:activity/{id}"', 'subject: "lin:entity/{id}"');
  fs.writeFileSync(mappingFile, text);
  assert.equal(cli('check', mappingFile).status, 0);
  assert.equal(cli('check', mappingFile, '--strict').status, 1);
});

test('rule files are checked when local', () => {
  const dir = workspace();
  const mappingFile = path.join(dir, 'lineage-prov.mapping.yaml');
  fs.writeFileSync(path.join(dir, 'had-plan.rules'), '# rule\n');
  fs.appendFileSync(mappingFile, [
    'rules:',
    '  - location: had-plan.rules',
    '    sha256: "0000000000000000000000000000000000000000000000000000000000000000"',
    '  - location: missing.rules',
    '',
  ].join('\n'));
  const res = JSON.parse(cli('check', mappingFile, '--json').stdout);
  assert.deepEqual(res.findings.filter((f) => f.path.startsWith('rules/')).map((f) => f.code).sort(), ['artifact.hash-mismatch', 'artifact.missing']);
});

test('usage errors exit with 2', () => {
  assert.equal(cli('check').status, 2);
  assert.equal(cli('check', path.join(os.tmpdir(), 'nope.yaml')).status, 2);
});

test('compile writes a plan; it refuses a mapping with errors unless --force', () => {
  const dir = workspace();
  const mappingFile = path.join(dir, 'lineage-prov.mapping.yaml');
  const out = path.join(dir, 'plan.json');
  let r = cli('compile', mappingFile, '--out', out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /25 units, 32 templates/);
  const plan = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(plan.format, 'n20s-projection-plan/0.1');

  fs.writeFileSync(mappingFile, fs.readFileSync(mappingFile, 'utf8').replace('predicate: prov:wasInformedBy', 'predicate: prov:wasInformedByX'));
  r = cli('compile', mappingFile);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Not compiled/);
  assert.equal(cli('compile', mappingFile, '--force', '--out', out).status, 0);
});

test('commands that need a source or a graph say so', () => {
  const mappingFile = path.join(EXAMPLE, 'lineage-prov.mapping.yaml');
  let r = cli('project', mappingFile);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No source: pass --source <url>, or set N20S_SOURCE or NEO4J_URI/);
  r = cli('compare', mappingFile, '--source', 'bolt://127.0.0.1:1');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs 2 sources/);
  r = cli('query', 'SELECT * WHERE { ?s ?p ?o }');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--graph/);
});

test('snapshots work as sources: compare two of them, the second one from an env file', async () => {
  const dir = workspace();
  const mappingFile = path.join(dir, 'lineage-prov.mapping.yaml');
  const { plan } = await compile(baseMapping, baseDoc);
  const snap = (rows) => ({
    format: SNAPSHOT_FORMAT, takenAt: 'now', source: { url: 'bolt://x', agent: 'Test/1' },
    queries: plan.units.map((u) => ({ cypher: u.cypher, params: {}, rows: u.id === 'nodes/run' ? rows : [] })),
  });
  const a = path.join(dir, 'a.snapshot.json');
  const b = path.join(dir, 'b.snapshot.json');
  fs.writeFileSync(a, JSON.stringify(snap([{ id: 'run:1', startedAt: '2026-01-01T00:00:00Z', endedAt: null }])));
  fs.writeFileSync(b, JSON.stringify(snap([{ id: 'run:1', startedAt: '2026-01-01T00:00Z', endedAt: null }])));
  const envFile = path.join(dir, 'aura.env');

  fs.writeFileSync(envFile, `# Aura credentials file\nNEO4J_URI=${a}\nNEO4J_PASSWORD=never-printed\n`);
  let r = cli('compare', mappingFile, '--source', a, '--dotenv', envFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  fs.writeFileSync(envFile, `NEO4J_URI=${b}\n`);
  r = cli('compare', mappingFile, '--source', a, '--dotenv', envFile);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /nodes\/run +1 +1 +NO/);
  assert.match(r.stdout, /only B: .*2026-01-01T00:00Z/);
  assert.ok(!r.stdout.includes('never-printed'));

  r = cli('compare', mappingFile, '--source', a, '--dotenv', path.join(dir, 'missing.env'));
  assert.equal(r.status, 2);
});
