// Published graphs that follow the database: Change Data Capture tells which
// transactions committed since the last look; when one touches what a
// publication is built from, the publication is rebuilt and swapped (the same
// build-then-swap as Re-publish: a gate that fails leaves the endpoint as it was).
//
// Needs CDC in FULL mode (Neo4j Enterprise 5.13+, Aura: instance → Change Data
// Capture → FULL). FULL rather than DIFF because the state before and after a
// change carries the subject key even when another property changed: what an
// incremental update needs next. Today the whole publication is rebuilt.
import path from 'node:path';
import { readRegistry, updateRegistry, republish, loadRecipe, UsageError } from './node.js';
import { ownTransaction } from './writeback.js';
import { writeOutcomes } from './recipe.js';

export const ENABLE_CDC = 'Enable Change Data Capture in FULL mode on the database: on Aura, instance → ⋯ → Change Data Capture → FULL; on a self-managed Neo4j Enterprise, ALTER DATABASE <name> SET OPTION txLogEnrichment "FULL".';

/**
 * Whether a source can be followed.
 * @returns {Promise<{mode: 'FULL'|'DIFF'|'OFF'|'unsupported'|'unknown', available: boolean, message: string}>}
 */
export async function cdcStatus(source) {
  try {
    await source.run('CALL db.cdc.current() YIELD id RETURN id');
  } catch (err) {
    if (/not currently enabled/i.test(err.message)) return { mode: 'OFF', available: false, message: `Change Data Capture is off on this database. ${ENABLE_CDC}` };
    if (/ProcedureNotFound|no procedure|not found/i.test(err.message)) return { mode: 'unsupported', available: false, message: 'This database has no Change Data Capture (Neo4j Enterprise 5.13+ or Aura). Re-publish by hand, or on a schedule.' };
    return { mode: 'unknown', available: false, message: `Change Data Capture could not be read: ${err.message.split('\n')[0]}` };
  }
  let mode = null;
  try {
    const [r] = await source.system?.('SHOW DATABASES YIELD name, home, options WHERE ($db IS NULL AND home) OR name = $db RETURN options LIMIT 1', { db: source.database ?? null }) ?? [];
    mode = r?.options?.txLogEnrichment ?? null;
  } catch { /* no access to the system database: read it from a change */ }
  if (!mode) {
    try {
      const [{ id }] = await source.run('CALL db.cdc.earliest() YIELD id RETURN id');
      const [r] = await source.run('CALL db.cdc.query($from) YIELD metadata RETURN metadata.captureMode AS mode LIMIT 1', { from: id });
      mode = r?.mode ?? null;
    } catch { /* keep unknown */ }
  }
  mode = mode ? String(mode).toUpperCase() : 'unknown';
  if (mode === 'FULL') return { mode, available: true, message: 'Change Data Capture is on (FULL): a publication can follow the database.' };
  if (mode === 'DIFF') return { mode, available: false, message: `Change Data Capture is in DIFF mode. ${ENABLE_CDC}` };
  return { mode, available: false, message: `Change Data Capture is on, but its mode could not be read: it must be FULL. ${ENABLE_CDC}` };
}

/**
 * What a publication is built from: the node labels, relationship types and
 * property keys its recipe reads (the row queries of its mapping's plan, and
 * its scope Cypher), null when anything may matter (free Cypher rows steps).
 * props maps a label or type to the keys read on it; '*' holds keys read
 * through a variable whose label the text does not say.
 */
export async function watchedOf(recipesDir, endpoint) {
  const p = (await readRegistry(recipesDir)).publications?.[endpoint];
  if (!p) throw new UsageError(`Endpoint ${endpoint} is not published from ${recipesDir}.`);
  const { recipe, lpgDoc, plan } = await loadRecipe(path.join(recipesDir, p.file));
  // Free Cypher (rows steps) may read anything.
  if ((recipe.steps ?? []).some((s) => s.type === 'rows')) return null;
  const labels = new Set();
  const types = new Set();
  const props = {};
  const read = (owner, key) => { (props[owner] ??= new Set()).add(key); };
  const readCypher = (cypher) => {
    const text = String(cypher ?? '').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
    const vars = new Map();
    for (const m of text.matchAll(/\(\s*([A-Za-z_]\w*)?\s*((?::\s*`?[A-Za-z_]\w*`?\s*)+)/g)) {
      const ls = [...m[2].matchAll(/:\s*`?([A-Za-z_]\w*)`?/g)].map((x) => x[1]);
      for (const l of ls) labels.add(l);
      if (m[1]) vars.set(m[1], ls);
    }
    for (const m of text.matchAll(/\[\s*([A-Za-z_]\w*)?\s*:\s*`?([A-Za-z_]\w*)`?((?:\s*\|\s*:?`?[A-Za-z_]\w*`?)*)/g)) {
      const ts = [m[2], ...[...m[3].matchAll(/([A-Za-z_]\w*)/g)].map((x) => x[1])];
      for (const t of ts) types.add(t);
      if (m[1]) vars.set(m[1], ts);
    }
    // n:Label in a WHERE: a label the query filters on.
    for (const m of text.matchAll(/\bWHERE\b[\s\S]*/gi)) for (const l of m[0].matchAll(/\b[A-Za-z_]\w*\s*:\s*`?([A-Za-z_]\w*)`?/g)) labels.add(l[1]);
    for (const m of text.matchAll(/\b([A-Za-z_]\w*)\.`?([A-Za-z_]\w*)`?/g)) {
      const owners = vars.get(m[1]);
      if (owners) for (const o of owners) read(o, m[2]); else read('*', m[2]);
    }
    // {key: …} maps on patterns: keys read on that label or type.
    for (const m of text.matchAll(/[([]\s*[A-Za-z_]?\w*\s*:\s*`?([A-Za-z_]\w*)`?[^{)\]]*\{([^}]*)\}/g)) {
      for (const k of m[2].matchAll(/`?([A-Za-z_]\w*)`?\s*:/g)) read(m[1], k[1]);
    }
  };
  for (const u of plan.units) {
    const [section, id] = u.id.split('/');
    if (section === 'nodes') {
      const n = lpgDoc.nodes[id];
      if (n) for (const l of [n.labels?.identifier ?? n.label, ...(n.labels?.implied ?? [])]) if (l) labels.add(l);
    } else if (section === 'relationships') {
      const r = lpgDoc.relationships[id];
      if (r?.type) types.add(r.type);
    }
    for (const v of Object.values(u.scope?.nodes ?? {})) if (v.label) labels.add(v.label);
    readCypher(u.cypher);
  }
  for (const s of recipe.steps ?? []) if (s.type === 'scope') readCypher(s.cypher);
  return { labels: [...labels].sort(), types: [...types].sort(), props: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, [...v].sort()]).sort()) };
}

/** The property keys whose value differs between two states. */
function changedKeys(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null));
}

/**
 * Whether a CDC event changes something a publication reads: a node of a
 * watched label created or deleted; a watched label added or removed; a
 * property key the publication reads changed on a node of a watched label; a
 * relationship of a watched type created or deleted, or one of its read keys
 * changed. A label or a relationship type the publication does not read (one
 * another recipe writes back, for instance) changes nothing.
 */
export function touches(event, watched) {
  if (!watched) return true;
  // Registries from before property keys were recorded: any update of a watched element counts.
  const reads = (owners, keys) => !watched.props || keys.some((k) => (watched.props['*'] ?? []).includes(k) || owners.some((o) => (watched.props[o] ?? []).includes(k)));
  const before = event.state?.before ?? null;
  const after = event.state?.after ?? null;
  if (event.eventType === 'n') {
    const bl = before?.labels ?? [];
    const al = after?.labels ?? [];
    const here = [...new Set([...(event.labels ?? []), ...bl, ...al])].filter((l) => watched.labels.includes(l));
    if (event.operation !== 'u' || !before || !after) return here.length > 0;
    const changedLabels = [...al.filter((l) => !bl.includes(l)), ...bl.filter((l) => !al.includes(l))];
    if (changedLabels.some((l) => watched.labels.includes(l))) return true;
    const keys = changedKeys(before.properties, after.properties);
    return here.length > 0 && keys.length > 0 && reads(here, keys);
  }
  if (event.eventType === 'r') {
    if (!watched.types.includes(event.type)) return false;
    if (event.operation !== 'u' || !before || !after) return true;
    const keys = changedKeys(before.properties, after.properties);
    return keys.length > 0 && reads([event.type], keys);
  }
  return false;
}

/** Starts following an endpoint from now. */
export async function startFollowing(recipesDir, endpoint, source) {
  const status = await cdcStatus(source);
  if (!status.available) throw new UsageError(status.message);
  const watched = await watchedOf(recipesDir, endpoint);
  if (watched && !watched.labels.length && !watched.types.length) throw new UsageError(`/sparql/${endpoint} is built from no accepted entry of its mapping: nothing to follow. Accept the mapping first.`);
  const [{ id }] = await source.run('CALL db.cdc.current() YIELD id RETURN id');
  return updateRegistry(recipesDir, (r) => {
    r.follow ??= {};
    r.follow[endpoint] = { cursor: id, since: new Date().toISOString(), watched, changes: 0, syncs: 0, lastChange: null, lastSync: null, state: 'idle' };
  });
}

export async function stopFollowing(recipesDir, endpoint) {
  return updateRegistry(recipesDir, (r) => { if (r.follow) delete r.follow[endpoint]; });
}

/**
 * Looks once at the changes since each followed endpoint's cursor; rebuilds the
 * endpoints whose sources changed. Returns what it did, per endpoint.
 */
export async function syncOnce(recipesDir, { source, n20s, onStep, writer = null, allowWrite = false, now = () => new Date().toISOString() } = {}) {
  const registry = await readRegistry(recipesDir);
  const out = [];
  for (const [endpoint, f] of Object.entries(registry.follow ?? {})) {
    if (!registry.publications?.[endpoint]) { await stopFollowing(recipesDir, endpoint); continue; }
    let rows;
    let restarted = false;
    try {
      rows = await source.run('CALL db.cdc.query($from) YIELD id, txId, event, metadata RETURN id, txId, event, metadata.txMetadata AS txMetadata', { from: f.cursor });
    } catch (err) {
      // A cursor older than the retained log: start again from now, with a full rebuild.
      if (!/expired|too old|before the earliest|Invalid change identifier/i.test(err.message)) throw err;
      const [{ id }] = await source.run('CALL db.cdc.current() YIELD id RETURN id');
      rows = [];
      restarted = id;
    }
    const cursor = restarted || (rows.length ? rows[rows.length - 1].id : f.cursor);
    // What the publication's own recipe wrote back is its result, not a change to follow: skipping it ends the loop.
    // Only that recipe's transactions (owner recipe/step, exact recipe id); another recipe's writes are changes like any other.
    const recipeId = registry.publications[endpoint].recipe;
    const own = new Set(rows.filter((x) => ownTransaction(x.txMetadata, recipeId)).map((x) => Number(x.txId))).size;
    const noteOwn = (f) => { if (own) { f.ownSkipped = (f.ownSkipped ?? 0) + own; f.lastOwn = { at: now(), transactions: own }; } };
    const relevant = rows.filter((x) => !ownTransaction(x.txMetadata, recipeId) && touches(x.event, f.watched));
    const txs = [...new Set(relevant.map((x) => Number(x.txId)))];
    if (!relevant.length && !restarted) {
      if (cursor !== f.cursor || own) await updateRegistry(recipesDir, (r) => { if (r.follow?.[endpoint]) { r.follow[endpoint].cursor = cursor; noteOwn(r.follow[endpoint]); } });
      out.push({ endpoint, changes: 0, ...(own ? { own } : {}) });
      continue;
    }
    const change = { at: now(), events: relevant.length, transactions: txs.length, ...(restarted ? { restarted: true } : {}) };
    await updateRegistry(recipesDir, (r) => {
      if (!r.follow?.[endpoint]) return;
      Object.assign(r.follow[endpoint], { cursor, state: 'syncing', lastChange: change, changes: (r.follow[endpoint].changes ?? 0) + relevant.length });
      noteOwn(r.follow[endpoint]);
    });
    const t0 = Date.now();
    let sync;
    try {
      const { run } = await republish(recipesDir, endpoint, { source, n20s, onStep, writer, allowWrite });
      const failed = run.steps.find((s) => s.status === 'error');
      const writes = writeOutcomes(run);
      sync = { at: now(), ok: run.ok, ms: Date.now() - t0, graph: run.publications?.find((p) => p.as === endpoint)?.graph ?? null, ...(failed ? { error: `${failed.id}: ${failed.error}` } : {}),
        ...(writes.length ? { writes, as: writer?.user ?? null } : {}) };
    } catch (err) {
      sync = { at: now(), ok: false, ms: Date.now() - t0, error: err.message };
    }
    await updateRegistry(recipesDir, (r) => {
      if (!r.follow?.[endpoint]) return;
      Object.assign(r.follow[endpoint], { state: sync.ok ? 'idle' : 'failed', lastSync: sync, syncs: (r.follow[endpoint].syncs ?? 0) + 1 });
    });
    out.push({ endpoint, changes: relevant.length, transactions: txs.length, sync });
  }
  return out;
}

/**
 * Follows the endpoints of a recipes directory in the background: one look
 * every intervalMs, one rebuild at a time. Each argument is a function, read
 * at every look: the studio changes its directory, source and n20s-server.
 * @param {{recipesDir: () => string|string[]|null, openSource: () => (null|(() => object)), n20s: () => object|null, intervalMs?: number}} o
 */
export function follower({ recipesDir, openSource, n20s, openWriter = () => null, intervalMs = 1500, onSync = () => {}, onError = () => {} }) {
  let stopped = false;
  let timer = null;
  let running = false;
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const dirs = [recipesDir()].flat().filter(Boolean);
      const open = openSource();
      const client = n20s();
      const followed = [];
      for (const dir of new Set(dirs)) {
        try { if (Object.keys((await readRegistry(dir)).follow ?? {}).length) followed.push(dir); } catch { /* no registry */ }
      }
      if (followed.length && open && client) {
        const source = open();
        // A publication whose recipe writes back rebuilds only with a write connection (serve --write, or the studio's).
        const openW = openWriter();
        const writer = openW ? openW() : null;
        try {
          for (const dir of followed) for (const r of await syncOnce(dir, { source, n20s: client, writer, allowWrite: !!writer })) if (r.sync) onSync({ ...r, dir });
        } finally {
          await source.close();
          await writer?.close();
        }
      }
    } catch (err) {
      onError(err);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }
  timer = setTimeout(tick, intervalMs);
  return { stop() { stopped = true; clearTimeout(timer); }, tick };
}
