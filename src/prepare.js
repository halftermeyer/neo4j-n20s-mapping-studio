// The deterministic part of a proposal: what follows from the LPG ontology
// alone, with no judgment to make. Subjects come from uniqueness constraints,
// qualified subjects from the end-node subjects, value-table IRIs from the
// values. A model is asked only for what needs judgment (classes, predicates,
// what to leave out), and is never asked to invent IRIs.
import { indexLpg } from './lpg.js';
import { resolve, isActive } from './resolve.js';
import { parseTemplate, iriEncode } from './iri.js';

export const TOOL = { kind: 'tool', name: 'n20s-mapping prepare' };

/** DatasetVersion -> dataset-version, wasDerivedFrom -> was-derived-from. */
export const slug = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

/**
 * Adds a subject to every root node kind (one that implies no other kind of
 * the document) that has none, from its smallest uniqueness constraint.
 * @returns {{mapping: object, added: string[], unresolved: Array<{node: string, reason: string}>}}
 */
export function prepareSubjects(mapping, lpgDoc, { prefix }) {
  if (!mapping.prefixes?.[prefix]) throw new Error(`Prefix "${prefix}" is not declared in the mapping.`);
  const idx = indexLpg(lpgDoc);
  const out = structuredClone(mapping);
  out.nodes ??= {};
  const added = [];
  const unresolved = [];
  const r = resolve(out, idx, isActive);
  for (const n of idx.nodes.values()) {
    if (idx.ancestors(n.id).length || r.effectiveSubject(n.id) || out.nodes[n.id]?.ignore) continue;
    const sets = idx.uniqueSets(n.id).filter((s) => s.length && s.every((p) => idx.isRequired(n.id, p)));
    if (!sets.length) {
      unresolved.push({ node: n.id, reason: 'no uniqueness or key constraint on required properties: the subject needs a person' });
      continue;
    }
    const best = [...sets].sort((a, b) => a.length - b.length)[0];
    out.nodes[n.id] = {
      ...out.nodes[n.id],
      subject: `${prefix}:${slug(n.label ?? n.id)}/${best.map((p) => `{${p}}`).join('/')}`,
      meta: { status: 'proposed', proposedBy: TOOL, confidence: 1, rationale: `From the uniqueness of ${best.map((p) => idx.nodes.get(n.id).props.get(p)?.name ?? p).join(', ')} on ${n.label}.` },
    };
    added.push(n.id);
  }
  return { mapping: out, added, unresolved };
}

/** Subject of the qualified resource of a relationship: the class name, then the start and end subject values. */
export function qualifiedSubject(mapping, lpgDoc, relId, classRef, { prefix }) {
  const idx = indexLpg(lpgDoc);
  const r = resolve(mapping, idx, isActive);
  const rel = idx.rels.get(relId);
  const local = String(classRef).split(/[:#/]/).pop();
  const values = (end, nodeId) => {
    const s = r.effectiveSubject(nodeId);
    return s ? parseTemplate(s.template).placeholders.map((p) => `{${end}.${p}}`) : [];
  };
  return [`${prefix}:${slug(local)}`, ...values('start', rel.from), ...values('end', rel.to)].join('/');
}

/** Value table: each value becomes <prefix>:<property name>/<value>, the value encoded like n20s does. */
export function valueTable(propName, values, { prefix }) {
  return Object.fromEntries([...new Set(values.map(String))].sort().map((v) => [v, `${prefix}:${slug(propName)}/${iriEncode(v)}`]));
}
