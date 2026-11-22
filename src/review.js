// Review of proposals: a queue of elements ranked by risk, and the decisions a
// reviewer takes (accept, reject with a comment, edit). Pure, like check().
//
// What makes an element risky comes from the propose evaluation on lineage:
// decisions that change between passes are right far less often than stable
// ones; check warnings (domain, range, kind) point at wrong meanings such as
// prov:hadMember between datasets and columns; mapping a relationship that the
// source does not assert is the costly mistake (DEPENDS_ON). Structure cannot
// see it: DEPENDS_ON -> prov:wasDerivedFrom fits the domain and the range, and
// the model may propose it the same way every time with full confidence. So a
// mapped relationship is safe only when an oracle check passed with that very
// decision projected whose SPARQL uses a term the decision emits (a predicate
// or class of its templates in the compiled plan) and whose Cypher reads that
// relationship with its ends ((:Tick)-[:ABOUT]->(:Metric) is not
// (:Rollup)-[:ABOUT]->(:Metric), though both emit sosa:observedProperty);
// and leaving an element out is not safe when a check whose Cypher reads that
// element failed.
import { indexLpg } from './lpg.js';
import { statusOf } from './resolve.js';
import { entryFingerprint, readsRelationship } from './oracle.js';

export const SAFE_CONFIDENCE = 0.95;
const LOW_CONFIDENCE = 0.8;

const keyOf = (path) => path.split('/').slice(0, 2).join('/');

/**
 * @param {{mapping: object, lpgDoc: object, result: object, variants?: object|null, oracle?: object|null}} input
 *        result is check() on the mapping; variants comes from proposePasses();
 *        oracle is oracleEvidence() of the last oracle run
 * @returns {Array<object>} one item per node kind and relationship type, the riskiest first
 */
export function reviewItems({ mapping, lpgDoc, result, variants = null, specFindings = [], oracle = null }) {
  const idx = indexLpg(lpgDoc);
  const findingsBy = new Map();
  for (const f of result.findings.filter((x) => x.severity !== 'info' && /^(nodes|relationships)\//.test(x.path))) {
    findingsBy.set(keyOf(f.path), [...(findingsBy.get(keyOf(f.path)) ?? []), f]);
  }
  // A domain or range conflict on a predicate may come from the typing of a node kind (data.node): Rig typed
  // sosa:Platform only, with ON -> sosa:hasFeatureOfInterest. The node kind's decision gets it too, with the fix.
  const typingBy = new Map();
  for (const f of result.findings.filter((x) => x.severity !== 'info' && x.data?.node)) {
    const key = `nodes/${f.data.node}`;
    typingBy.set(key, [...(typingBy.get(key) ?? []), f]);
  }
  const undecided = result.coverage?.undecided ?? [];
  // Whether a check's Cypher reads an element or a property (through a label it implies, too).
  const labelsOf = (nodeId) => {
    const out = new Set([idx.nodes.get(nodeId)?.label]);
    for (const n of idx.nodes.values()) if (idx.ancestors(n.id).includes(nodeId)) out.add(n.label);
    return out;
  };
  const readerOf = (path) => {
    const [section, id, , pid] = path.split('/');
    if (section === 'relationships') {
      const r = idx.rels.get(id);
      return pid ? (reads) => reads.props.includes(`${r?.type}.${r?.props.get(pid)?.name}`) : (reads) => readsRelationship(reads, lpgDoc, id);
    }
    const ls = labelsOf(id);
    if (!pid) return (reads) => reads.labels.some((l) => ls.has(l));
    const name = idx.nodes.get(id)?.props.get(pid)?.name;
    return (reads) => [...ls].some((l) => reads.props.includes(`${l}.${name}`));
  };

  const items = [];
  const add = (section, id, label) => {
    const key = `${section}/${id}`;
    const entry = mapping[section]?.[id];
    const entries = [
      ...(entry ? [{ path: key, entry }] : []),
      ...Object.entries(entry?.ignore ? {} : entry?.properties ?? {}).map(([pid, e]) => ({ path: `${key}/properties/${pid}`, entry: e })),
    ];
    const statuses = entries.map((x) => statusOf(x.entry));
    const proposed = entries.filter((x) => statusOf(x.entry) === 'proposed');
    const status = !entries.length ? 'undecided'
      : statuses.includes('proposed') ? 'proposed'
        : statuses.includes('rejected') ? 'rejected'
          : entry?.ignore ? (entry.ignore.deferred ? 'deferred' : 'ignored') : 'accepted';

    const reasons = [];
    const typing = section === 'nodes' ? (typingBy.get(key) ?? []).filter((f) => keyOf(f.path) !== key) : [];
    const findings = [...(findingsBy.get(key) ?? []), ...typing];
    // Where the mapping departs from the spec the person validated.
    for (const f of specFindings.filter((x) => x.path === key)) reasons.push({ code: 'spec', text: f.message });
    // Domain, range and kind warnings point at a doubtful meaning (prov:hadMember between a dataset and its columns).
    for (const f of findings) {
      if (typing.includes(f)) {
        const via = keyOf(f.path);
        const viaLabel = via.startsWith('relationships/') ? idx.rels.get(via.split('/')[1])?.type : idx.nodes.get(via.split('/')[1])?.label;
        reasons.push({ code: f.code === 'target.domain' || f.code === 'target.range' ? 'meaning' : 'warning', path: f.path, text: `${f.code} on ${viaLabel}: ${f.message}`,
          fix: `add ${f.data.expected.join(' or ')} to the classes of ${label}, or change the mapping of ${viaLabel}` });
        continue;
      }
      reasons.push({ code: f.severity === 'error' ? 'error' : /^target\.(domain|range|kind-mismatch)$/.test(f.code) ? 'meaning' : 'warning', path: f.path, text: `${f.code}: ${f.message}` });
    }
    const v = variants ? Object.entries(variants.elements).filter(([p]) => p === key || p.startsWith(`${key}/`)) : [];
    for (const [p, x] of v.filter(([, x]) => !x.stable)) {
      reasons.push({ code: 'unstable', path: p, text: `${x.variants.length} different proposals in ${variants.passes} passes` });
    }
    const confidences = proposed.map((x) => x.entry.meta?.confidence).filter((c) => typeof c === 'number');
    const confidence = confidences.length ? Math.min(...confidences) : null;
    if (confidence !== null && confidence < LOW_CONFIDENCE) reasons.push({ code: 'low-confidence', text: `confidence ${confidence}` });
    // What the oracle says about these very decisions (a run with the proposals projected).
    const ran = (c) => ['pass', 'fail', 'error'].includes(c.status);
    const seen = (path, e) => oracle?.decisions?.[path] && oracle.decisions[path].fingerprint === entryFingerprint(e) ? oracle.decisions[path] : null;
    let oraclePassed = false;
    if (section === 'relationships' && entry && !entry.ignore && statusOf(entry) === 'proposed') {
      reasons.push({ code: 'asserts', text: 'maps a relationship: check that the source asserts what the target term means' });
      // Covered: the check's SPARQL uses a predicate or class this decision emits, and its Cypher reads this
      // relationship with its ends (or names it in covers:). Reading the type alone is not enough.
      const d = seen(key, entry);
      const emits = new Set(d?.terms ?? []);
      const covering = d ? oracle.checks.filter((c) => ran(c) && c.terms.some((t) => emits.has(t)) && readsRelationship(c.reads, lpgDoc, id)) : [];
      const failed = covering.filter((c) => c.status !== 'pass');
      oraclePassed = covering.length > 0 && !failed.length;
      if (failed.length) reasons.push({ code: 'oracle', text: `the oracle fails with this decision: ${failed.map((c) => c.id).join(', ')}` });
      else if (!oraclePassed) {
        reasons.push({ code: 'unverified', text: !d ? 'not checked by the oracle with this decision yet (Oracle: run with proposals too)'
          : 'no oracle check reads this relationship (with its ends) and asks the RDF about the terms it emits: only a person can tell whether the source asserts it' });
      }
    }
    // Left out: a failing check whose Cypher reads what is left out says the RDF misses it.
    for (const x of proposed.filter((y) => y.entry.ignore)) {
      const d = seen(x.path, x.entry);
      if (!d) continue;
      const read = readerOf(x.path);
      const failed = oracle.checks.filter((c) => ['fail', 'error'].includes(c.status) && read(c.reads));
      if (failed.length) reasons.push({ code: 'oracle', path: x.path, text: `left out, but ${failed.map((c) => c.id).join(', ')} reads it and fails` });
    }
    const open = undecided.filter((p) => p === key || p.startsWith(`${key}/`));
    if (open.length && entries.length) reasons.push({ code: 'undecided', text: `${open.length} undecided` });

    const weight = { error: 5, oracle: 5, spec: 4, meaning: 4, warning: 3, unstable: 3, 'low-confidence': 2, asserts: 1, unverified: 1, undecided: 1 };
    const risk = reasons.reduce((n, r) => n + weight[r.code], 0);
    const safe = status === 'proposed' && !findings.length && !reasons.some((r) => r.code === 'spec') && v.length > 0 && v.every(([, x]) => x.stable)
      && proposed.every((x) => (x.entry.meta?.confidence ?? 0) >= SAFE_CONFIDENCE)
      // Stable and confident is not enough for a relationship that asserts something: the oracle must have passed with it.
      && (section !== 'relationships' || !entry || !!entry.ignore || statusOf(entry) !== 'proposed' || oraclePassed)
      && !reasons.some((r) => r.code === 'oracle');
    items.push({ key, section, id, label, status, risk, reasons, confidence, safe, proposed: proposed.map((x) => x.path) });
  };
  for (const n of idx.nodes.values()) add('nodes', n.id, n.label);
  for (const r of idx.rels.values()) add('relationships', r.id, `(${idx.nodes.get(r.from)?.label})-[:${r.type}]->(${idx.nodes.get(r.to)?.label})`);

  const order = { proposed: 0, rejected: 1, undecided: 2, accepted: 3, ignored: 3, deferred: 3 };
  return items.sort((a, b) => order[a.status] - order[b.status] || b.risk - a.risk || a.key.localeCompare(b.key, 'en', { numeric: true }));
}

function locate(mapping, path) {
  const [section, id, props, pid] = path.split('/');
  if (!['nodes', 'relationships'].includes(section) || !id || (props && props !== 'properties')) throw new Error(`Not an entry path: ${path}`);
  return { section, id, pid: pid ?? null };
}

/**
 * Applies a review decision and returns the new mapping.
 * @param {object} mapping
 * @param {{path: string, action: 'accept'|'reject'|'edit', reviewer: string, at?: string, comment?: string, entry?: object}} d
 *   accept on an element accepts its proposed properties too; edit replaces the entry
 *   (an element edit keeps the properties unless the entry gives them) and marks it accepted, by the reviewer
 */
export function applyDecision(mapping, { path, action, reviewer, at = new Date().toISOString(), comment, entry }) {
  const out = structuredClone(mapping);
  const { section, id, pid } = locate(out, path);
  out[section] ??= {};
  const element = out[section][id];
  const review = { reviewedBy: reviewer, reviewedAt: at, ...(comment ? { reviewComment: comment } : {}) };
  const target = pid ? element?.properties?.[pid] : element;

  if (action === 'accept' || action === 'reject') {
    if (!target) throw new Error(`No entry at ${path}.`);
    const status = action === 'accept' ? 'accepted' : 'rejected';
    target.meta = { ...target.meta, status, ...review };
    if (!pid && action === 'accept' && !element.ignore) {
      for (const pe of Object.values(element.properties ?? {})) {
        if (statusOf(pe) === 'proposed') pe.meta = { ...pe.meta, status, ...review };
      }
    }
    return out;
  }
  if (action === 'edit') {
    if (!entry || typeof entry !== 'object') throw new Error('An edit needs the new entry.');
    const meta = { status: 'accepted', proposedBy: { kind: 'human', name: reviewer }, ...review };
    if (pid) {
      if (!element || element.ignore) throw new Error(`No element entry to hold ${path}.`);
      element.properties ??= {};
      element.properties[pid] = { ...entry, meta };
    } else {
      const keep = !entry.ignore && !('properties' in entry) && element?.properties ? { properties: element.properties } : {};
      out[section][id] = { ...entry, ...keep, meta };
    }
    return out;
  }
  throw new Error(`Unknown action: ${action}`);
}

/** Accepts every safe item (proposed, stable over passes, confident, without findings). */
export function acceptSafe(mapping, items, { reviewer, at }) {
  return items.filter((i) => i.safe).reduce((m, i) => applyDecision(m, { path: i.key, action: 'accept', reviewer, at }), mapping);
}
