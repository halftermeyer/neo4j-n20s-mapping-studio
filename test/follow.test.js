import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cdcStatus, touches, watchedOf, startFollowing, stopFollowing, syncOnce } from '../src/follow.js';
import { EXAMPLE } from './helpers.js';

/** A source that answers the CDC procedures as a scripted database would. */
function cdcSource({ enabled = true, procedure = true, mode = 'FULL', systemMode = mode, events = [], current = 'c0' } = {}) {
  const calls = [];
  return {
    calls,
    database: null,
    async run(cypher, params = {}) {
      calls.push(cypher);
      if (/db\.cdc\./.test(cypher) && !procedure) throw new Error('Neo.ClientError.Procedure.ProcedureNotFound: db.cdc.current');
      if (/db\.cdc\./.test(cypher) && !enabled) throw new Error('Change Data Capture is not currently enabled for this database [neo4j]');
      if (/db\.cdc\.current/.test(cypher)) return [{ id: current }];
      if (/db\.cdc\.earliest/.test(cypher)) return [{ id: 'c-earliest' }];
      if (/captureMode/.test(cypher)) return [{ mode }];
      if (/db\.cdc\.query/.test(cypher)) {
        const from = params.from;
        const i = events.findIndex((e) => e.id === from);
        return events.slice(i + 1);
      }
      throw new Error(`unexpected ${cypher}`);
    },
    async system() {
      if (systemMode === null) throw new Error('Permission denied');
      return [{ options: { txLogEnrichment: systemMode } }];
    },
    close: async () => {},
  };
}

test('cdcStatus: only FULL makes a publication followable; otherwise it says how to enable it', async () => {
  assert.deepEqual((await cdcStatus(cdcSource())).available, true);
  const diff = await cdcStatus(cdcSource({ mode: 'DIFF' }));
  assert.equal(diff.mode, 'DIFF');
  assert.equal(diff.available, false);
  assert.match(diff.message, /FULL/);
  const off = await cdcStatus(cdcSource({ enabled: false }));
  assert.equal(off.mode, 'OFF');
  assert.match(off.message, /Aura, instance → ⋯ → Change Data Capture → FULL/);
  assert.equal((await cdcStatus(cdcSource({ procedure: false }))).mode, 'unsupported', 'Relate and Community have no CDC');
  // No access to the system database: the mode is read from a change.
  const fromChange = await cdcStatus(cdcSource({ systemMode: null, mode: 'FULL' }));
  assert.equal(fromChange.available, true);
});

test('touches: a change matters when it concerns a watched label or relationship type', () => {
  const watched = { labels: ['Member'], types: ['KNOWS'] };
  assert.equal(touches({ eventType: 'n', labels: ['Member'] }, watched), true);
  assert.equal(touches({ eventType: 'n', labels: ['Dataset'] }, watched), false);
  assert.equal(touches({ eventType: 'n', labels: [], state: { before: { labels: ['Member'] }, after: null } }, watched), true, 'a deleted member');
  assert.equal(touches({ eventType: 'r', type: 'KNOWS', start: { labels: ['X'] }, end: { labels: ['Y'] } }, watched), true);
  assert.equal(touches({ eventType: 'r', type: 'USED', start: { labels: ['Run'] }, end: { labels: ['Dataset'] } }, watched), false);
  assert.equal(touches({ eventType: 'n', labels: ['Anything'] }, null), true, 'free Cypher: everything matters');
});

test('following: start from the current change, advance past changes that do not matter, stop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-follow-'));
  fs.cpSync(EXAMPLE, root, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const dir = path.join(root, 'recipes');
  // A registry with lineage published from recipe 5 (as a run would leave it).
  fs.writeFileSync(path.join(dir, 'graphs.json'), JSON.stringify({ format: 'n20s-graphs/0.1', graphs: {}, publications: { lineage: { graph: 'g1', file: '5-lineage-kg.recipe.yaml', params: {} } } }));
  const watched = await watchedOf(dir, 'lineage');
  assert.ok(watched.labels.includes('Dataset') && watched.types.includes('USED'), JSON.stringify(watched));

  await assert.rejects(startFollowing(dir, 'lineage', cdcSource({ mode: 'DIFF' })), /FULL/);
  await startFollowing(dir, 'lineage', cdcSource({ current: 'c0' }));
  let reg = JSON.parse(fs.readFileSync(path.join(dir, 'graphs.json'), 'utf8'));
  assert.equal(reg.follow.lineage.cursor, 'c0');

  // A change elsewhere in the database: the cursor moves, nothing is rebuilt.
  const source = cdcSource({ events: [{ id: 'c0' }, { id: 'c1', txId: 7, event: { eventType: 'n', labels: ['Member'] } }] });
  const res = await syncOnce(dir, { source, n20s: null });
  assert.deepEqual(res, [{ endpoint: 'lineage', changes: 0 }]);
  reg = JSON.parse(fs.readFileSync(path.join(dir, 'graphs.json'), 'utf8'));
  assert.equal(reg.follow.lineage.cursor, 'c1');
  assert.equal(reg.follow.lineage.syncs, 0);

  await stopFollowing(dir, 'lineage');
  reg = JSON.parse(fs.readFileSync(path.join(dir, 'graphs.json'), 'utf8'));
  assert.deepEqual(reg.follow, {});
});
