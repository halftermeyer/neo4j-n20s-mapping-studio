// How entries apply to the LPG ontology: status, inherited subjects and classes.
import { expand } from './iri.js';

export const statusOf = (e) => e?.meta?.status ?? 'accepted';
/** Entries that are checked: accepted and proposed. */
export const isActive = (e) => !!e && !e.ignore && statusOf(e) !== 'rejected';
/** Entries that are compiled: accepted only. */
export const isCompiled = (e) => !!e && !e.ignore && statusOf(e) === 'accepted';

/**
 * @param {object} mapping
 * @param {ReturnType<import('./lpg.js').indexLpg>} idx
 * @param {(e: object) => boolean} include which entries count (isActive or isCompiled)
 */
export function resolve(mapping, idx, include = isActive) {
  const nodeEntries = mapping.nodes ?? {};
  const relEntries = mapping.relationships ?? {};
  const prefixes = mapping.prefixes ?? {};

  const ownSubject = new Map();
  for (const [id, e] of Object.entries(nodeEntries)) {
    if (idx.nodes.has(id) && include(e) && e.subject) ownSubject.set(id, e.subject);
  }
  /** Node kinds whose subject applies to this kind: itself, then the kinds it implies, nearest first. */
  const subjectSources = (nodeId) => [nodeId, ...idx.ancestors(nodeId)].filter((n) => ownSubject.has(n));
  const effectiveSubject = (nodeId) => {
    const s = subjectSources(nodeId)[0];
    return s ? { template: ownSubject.get(s), from: s } : null;
  };
  /** Expanded classes of this kind and of the kinds it implies. */
  const effectiveClasses = (nodeId) => {
    const out = new Set();
    for (const n of [nodeId, ...idx.ancestors(nodeId)]) {
      const e = nodeEntries[n];
      if (!include(e)) continue;
      for (const c of e.classes ?? []) {
        const r = expand(c, prefixes);
        if (r.iri) out.add(r.iri);
      }
    }
    return [...out];
  };

  return { nodeEntries, relEntries, prefixes, ownSubject, subjectSources, effectiveSubject, effectiveClasses };
}
