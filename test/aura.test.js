// Write-back on the Aura instance of .env, with Change Data Capture for real:
// another application invalidates a version, the followed publication of
// recipe 9 is rebuilt and writes back through n20s_writer, and its own writes
// do not trigger another rebuild. Also: the read source refuses to write, and
// the writer has no right beyond its names.
//
// Skipped unless N20S_AURA_TEST=1 and N20S_JAR are set, with .env holding the
// Aura credentials and the writer (node demo/aura.mjs reset creates it):
//   N20S_AURA_TEST=1 N20S_JAR=.../n20s-server-1.1.0-SNAPSHOT.jar node --test test/aura.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './helpers.js';

const ENV = path.join(ROOT, '.env');
const skip = process.env.N20S_AURA_TEST !== '1' ? 'set N20S_AURA_TEST=1 (and N20S_JAR) to run on the Aura of .env'
  : !process.env.N20S_JAR || !fs.existsSync(process.env.N20S_JAR) ? 'N20S_JAR not found'
  : !fs.existsSync(ENV) ? 'no .env' : false;

const LINEAGE = 'demo:lineage:v2:dsv:raw.customers@7';
const CLEAN = [
  `MATCH (v:DatasetVersion {id: '${LINEAGE}'}) REMOVE v.invalidatedAt`,
  'MATCH (n:Tainted) REMOVE n:Tainted',
  'MATCH ()-[r:READS_TAINTED_INPUT]->() DELETE r',
  'MATCH (l:WriteLedger) DELETE l',
];

let proc;
let n20s;
let admin;
let source;
let writer;
let m;

before(async () => {
  if (skip) return;
  process.loadEnvFile(ENV);
  m = await import('../src/node.js');
  const { n20sClient } = await import('../src/n20s.js');
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  proc = spawn('java', ['-jar', process.env.N20S_JAR], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  n20s = n20sClient(`http://127.0.0.1:${port}`);
  const end = Date.now() + 60000;
  while (Date.now() < end) { try { await n20s.version(); break; } catch { await new Promise((r) => setTimeout(r, 300)); } }
  admin = m.openSource(process.env.NEO4J_URI);
  source = m.openSource(process.env.NEO4J_URI, { readOnly: true });
  writer = m.writerFromEnv(process.env.NEO4J_URI);
  for (const q of CLEAN) await admin.run(q);
});

after(async () => {
  if (skip) return;
  for (const q of CLEAN) await admin.run(q).catch(() => {});
  await Promise.all([admin?.close(), source?.close(), writer?.close()]);
  proc?.kill();
});

test('Aura: the read source never writes; the writer writes its names only, never the schema', { skip, timeout: 60000 }, async () => {
  assert.equal(writer.user, 'n20s_writer');
  await assert.rejects(source.run('CREATE (:ShouldNotExist)'), /read|access mode|not allowed/i);
  const tx = (q) => writer.transaction(async (t) => { await t.run(q); return { commit: true }; }, { attempts: 1 });
  // Members are invisible to the writer: the MATCH finds nothing, nothing changes.
  await tx("MATCH (m:Member {id: 'ben'}) SET m.nick = 'x'");
  await assert.rejects(tx('CREATE (:Member {id: "nope"})'), /permission|not allowed|denied/i);
  await assert.rejects(tx('CREATE CONSTRAINT nope IF NOT EXISTS FOR (n:X) REQUIRE n.id IS UNIQUE'), /permission|not allowed|denied|schema/i);
  assert.equal((await admin.run("MATCH (m:Member {id: 'ben'}) RETURN m.nick AS nick"))[0].nick, 'benno');
});

test('Aura: CDC loop — an invalidation rebuilds the publication, which writes back; its own writes do not rebuild it again', { skip, timeout: 240000 }, async () => {
  const { runRecipe } = await import('../src/recipe.js');
  const { startFollowing, syncOnce } = await import('../src/follow.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-aura-wb-'));
  fs.cpSync(path.join(ROOT, 'demo/project'), dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const recipes = path.join(dir, 'lineage/recipes');
  const file = path.join(recipes, '9-taint-writeback.recipe.yaml');
  const f = await m.loadRecipe(file);
  const links = async () => (await admin.run('MATCH (:Tainted)-[r:READS_TAINTED_INPUT]->() RETURN count(r) AS n'))[0].n;
  try {
    // Published once, by hand: writes what the seed's invalidation taints.
    const first = await runRecipe({ ...f, source, n20s, writer, allowWrite: true, freshness: m.freshnessOf(recipes, n20s) });
    assert.ok(first.ok, JSON.stringify(first.steps.filter((s) => s.status === 'error')));
    await m.recordRecipeRun(file, first, f, { source: { url: source.url }, n20s });
    const before = await links();
    assert.ok(before > 0);
    const [prov] = await admin.run('MATCH ()-[r:READS_TAINTED_INPUT]->() RETURN r.createdBy AS by LIMIT 1');
    assert.match(prov.by, /^taint-writeback\/link@/);

    await startFollowing(recipes, 'taint', source);
    // Our own first writes happened before the cursor: nothing to do.
    assert.deepEqual((await syncOnce(recipes, { source, n20s, writer, allowWrite: true })).map((r) => r.changes), [0]);

    // Another application commits an incident.
    const app = m.openSource(process.env.NEO4J_URI);
    await app.run(`MATCH (v:DatasetVersion {id: '${LINEAGE}'}) SET v.invalidatedAt = datetime('2026-11-06T09:30:00Z')`);
    await app.close();
    let [res] = await syncOnce(recipes, { source, n20s, writer, allowWrite: true });
    assert.ok(res.changes > 0, JSON.stringify(res));
    assert.ok(res.sync?.ok, JSON.stringify(res.sync));
    assert.ok((await links()) > before, 'the rebuild wrote back the new taint');

    // What the rebuild wrote back is in the log, tagged taint-writeback/<step>: skipped, no second rebuild.
    [res] = await syncOnce(recipes, { source, n20s, writer, allowWrite: true });
    assert.equal(res.changes, 0, JSON.stringify(res));
    assert.ok(res.own > 0, 'the change log carried the transaction metadata of the writes');
    const reg = await m.readRegistry(recipes);
    assert.equal(reg.follow.taint.syncs, 1);
  } finally {
    for (const g of await n20s.list()) if (g.graphName.startsWith('lineage-taint')) await n20s.drop(g.graphName);
  }
});

test('Aura: a node the writer cannot see but the source can is an error (missing visibility); one neither sees is a warning', { skip, timeout: 60000 }, async () => {
  const { runWrite } = await import('../src/writeback.js');
  for (const q of CLEAN) await admin.run(q);
  // Members are invisible to n20s_writer (it has no right on them); the read source sees them.
  const target = { form: 'label', owner: 'visibility-test/mark', kind: 'label', name: 'Tainted', on: 'Member', retract: 'scope',
    node: { id: 'n:x', label: 'Member', keyLabel: 'Member', key: 'id', column: 'm' } };
  await assert.rejects(runWrite({ writer, source, target, rows: [{ m: 'ben' }], run: 'vis1', scope: [] }),
    /Missing visibility for the writer: the source sees 1 Member node\(s\) the write user cannot \(ben\)/);
  const gone = await runWrite({ writer, source, target, rows: [{ m: 'nobody-at-all' }], run: 'vis2', scope: [] });
  assert.equal(gone.written, false);
  assert.match(gone.warnings.join(' '), /1 node\(s\) no longer in the database/);
  assert.equal((await admin.run("MATCH (l:WriteLedger {owner: 'visibility-test/mark'}) RETURN count(l) AS n"))[0].n, 0, 'rolled back, ledger included');
  assert.equal((await admin.run('MATCH (m:Member:Tainted) RETURN count(m) AS n'))[0].n, 0);
});
