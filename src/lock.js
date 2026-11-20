// Lock file and drift between the locked LPG ontology and the current one.
import { fingerprints } from './lpg.js';

export const LOCK_FORMAT = 'n20s-mapping-lock/0.1';

export function buildLock(idx, hash) {
  return {
    format: LOCK_FORMAT,
    lpgOntology: { id: idx.id, version: String(idx.version), contentHash: hash },
    elements: fingerprints(idx),
  };
}

const status = (e) => e?.meta?.status ?? 'accepted';
const active = (e) => !!e && !e.ignore && status(e) !== 'rejected';
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameSet = (a = [], b = []) => same([...a].sort(), [...b].sort());

/**
 * Compares the lock with the current LPG ontology. Severity depends on whether
 * the mapping uses the changed element: a change under an active entry is a
 * warning, anything else is information.
 */
export function diffLock(lock, idx, hash, mapping, { error, warn, info }) {
  if (lock?.format !== LOCK_FORMAT) {
    error('lock.format', 'lock', `Unknown lock format "${lock?.format}"; expected ${LOCK_FORMAT}.`);
    return;
  }
  if (lock.lpgOntology?.id !== idx.id) {
    error('drift.other-ontology', 'lock', `The lock is for "${lock.lpgOntology?.id}", the document is "${idx.id}".`);
    return;
  }
  if (String(lock.lpgOntology.version) !== String(mapping.lpgOntology.version)) {
    warn('lock.stale', 'lock', `The lock is for version ${lock.lpgOntology.version} but the mapping says ${mapping.lpgOntology.version}: run lock.`);
  }
  if (lock.lpgOntology.contentHash === hash) return;

  info('drift.content-changed', 'lpgOntology', `The LPG ontology changed since the lock (version ${lock.lpgOntology.version}, now ${idx.version}). Layout-only changes do not count.`);

  const before = lock.elements ?? { nodes: {}, relationships: {} };
  const now = fingerprints(idx);

  for (const kind of ['nodes', 'relationships']) {
    const entries = mapping[kind] ?? {};
    const sig = (fp) => (kind === 'nodes' ? fp.label : fp.type);
    const what = kind === 'nodes' ? 'label' : 'type';
    const removed = Object.keys(before[kind] ?? {}).filter((id) => !(id in now[kind]));
    const added = Object.keys(now[kind]).filter((id) => !(id in (before[kind] ?? {})));
    const twins = new Set();

    for (const id of removed) {
      const twin = added.find((a) => !twins.has(a) && sig(now[kind][a]) === sig(before[kind][id]));
      if (twin && entries[id]) {
        twins.add(twin);
        warn('drift.recreated', `${kind}/${id}`, `"${id}" was removed and "${twin}" added with the same ${what} ${sig(before[kind][id])}: probably recreated, with a new id. Move the entry from "${id}" to "${twin}".`, { from: id, to: twin });
      } else {
        info('drift.removed', `${kind}/${id}`, `"${id}" was removed${entries[id] ? '; its entry no longer applies' : ''}.`);
      }
    }
    for (const id of added) {
      if (!twins.has(id)) info('drift.added', `${kind}/${id}`, `"${id}" is new${entries[id] ? '' : ' and has no entry yet'}.`);
    }

    for (const id of Object.keys(now[kind]).filter((k) => k in (before[kind] ?? {}))) {
      const o = before[kind][id];
      const c = now[kind][id];
      const path = `${kind}/${id}`;
      const used = active(entries[id]);
      if (sig(o) !== sig(c)) info('drift.renamed', path, `${what === 'label' ? 'Label' : 'Type'} ${sig(o)} is now ${sig(c)}. The entry still applies; recompile.`);
      if (kind === 'nodes' && !sameSet(o.implied, c.implied)) {
        warn('drift.implied-changed', path, `Implied labels changed from [${o.implied}] to [${c.implied}]: inherited subjects and classes may change.`);
      }
      if (kind === 'relationships' && (o.from !== c.from || o.to !== c.to)) {
        (used ? warn : info)('drift.endpoints-changed', path, `Endpoints changed from ${o.from} -> ${o.to} to ${c.from} -> ${c.to}: check the domain, the range and the qualified subject.`);
      }
      const op = o.properties ?? {};
      const cp = c.properties ?? {};
      const propEntries = entries[id]?.properties ?? {};
      for (const pid of Object.keys(op).filter((p) => !(p in cp))) {
        info('drift.property-removed', `${path}/properties/${pid}`, `Property "${pid}" was removed${propEntries[pid] ? '; its entry no longer applies' : ''}.`);
      }
      for (const pid of Object.keys(cp).filter((p) => !(p in op))) {
        info('drift.property-added', `${path}/properties/${pid}`, `Property "${pid}" is new${propEntries[pid] ? '' : ' and has no entry yet'}.`);
      }
      for (const pid of Object.keys(cp).filter((p) => p in op)) {
        const ppath = `${path}/properties/${pid}`;
        const pe = propEntries[pid];
        const pUsed = active(pe);
        if (op[pid].type !== cp[pid].type) {
          (pUsed ? warn : info)('drift.type-changed', ppath, `Type ${op[pid].type} is now ${cp[pid].type}${pUsed ? ': review the datatype of this entry' : ''}.`);
        }
        if (op[pid].name !== cp[pid].name) info('drift.property-renamed', ppath, `Database name ${op[pid].name} is now ${cp[pid].name}. The entry still applies; recompile.`);
        if (!same(op[pid].oneOf, cp[pid].oneOf) && pUsed && pe.values) {
          warn('drift.values-changed', ppath, `Allowed values changed from [${op[pid].oneOf ?? ''}] to [${cp[pid].oneOf ?? ''}]: review the value table.`);
        }
      }
    }
  }
}
