// Oracle: the same question in Cypher on the LPG and in SPARQL on the projection.
import { indexLpg } from './lpg.js';
import { resolve, isCompiled } from './resolve.js';
import { fillTemplate, matchTemplate, parseTemplate, expand } from './iri.js';

function decoders(mapping, lpgDoc) {
  const idx = indexLpg(lpgDoc);
  const r = resolve(mapping, idx, isCompiled);
  const P = mapping.prefixes;
  const single = (nodeId) => {
    const s = r.effectiveSubject(nodeId);
    if (!s) throw new Error(`No subject for node "${nodeId}".`);
    const phs = parseTemplate(s.template).placeholders;
    if (phs.length !== 1) throw new Error(`The subject of "${nodeId}" has ${phs.length} placeholders; the oracle needs one.`);
    return { template: s.template, placeholder: phs[0] };
  };
  return {
    /** IRI of a node from its single subject value. */
    iriOf(nodeId, value) {
      const { template, placeholder } = single(nodeId);
      return fillTemplate(template, { [placeholder]: value }, P);
    },
    /** A function that turns a SPARQL value back into the LPG value. */
    decoder(spec) {
      const [kind, arg] = spec.split(/:(.*)/s);
      if (kind === 'node') {
        const { template, placeholder } = single(arg);
        return (v) => (v == null ? v : matchTemplate(template, v, P)?.[placeholder] ?? `<undecodable ${v}>`);
      }
      if (kind === 'values') {
        const [section, id, , prop] = arg.split('/');
        const table = mapping[section]?.[id]?.properties?.[prop]?.values;
        if (!table) throw new Error(`No value table at ${arg}.`);
        const reverse = Object.fromEntries(Object.entries(table).map(([value, ref]) => [expand(ref, P).iri, value]));
        return (v) => (v == null ? v : reverse[v] ?? `<unmapped ${v}>`);
      }
      throw new Error(`Unknown decode spec "${spec}".`);
    },
  };
}

const norm = (v) => (v === null || v === undefined ? null : String(v));
const key = (row, columns) => JSON.stringify(columns.map((c) => norm(row[c])));

/**
 * @param {{oracle: object, mapping: object, lpgDoc: object, source: object, n20s: object, graph: string}} args
 */
export async function runOracle({ oracle, mapping, lpgDoc, source, n20s, graph }) {
  const d = decoders(mapping, lpgDoc);
  const results = [];
  for (const c of oracle.checks) {
    if (c.expressible === false) { results.push({ id: c.id, status: 'not-expressible', reason: c.reason }); continue; }
    try {
      const sparql = (oracle.prefixes ?? '') + c.sparql.replace(/\{\{([^|}]+)\|([^}]+)\}\}/g, (_, nodeId, value) => d.iriOf(nodeId, value));
      const decode = Object.fromEntries(Object.entries(c.decode ?? {}).map(([col, spec]) => [col, d.decoder(spec)]));
      const [cy, sp] = await Promise.all([source.run(c.cypher), n20s.query(graph, sparql)]);
      const spDecoded = sp.map((row) => Object.fromEntries(c.columns.map((col) => [col, decode[col] ? decode[col](row[col]) : row[col]])));
      const a = [...new Set(cy.map((r) => key(r, c.columns)))].sort();
      const b = [...new Set(spDecoded.map((r) => key(r, c.columns)))].sort();
      let ok;
      let detail;
      if (c.mode === 'disjoint') {
        const both = a.filter((x) => b.includes(x));
        ok = a.length > 0 && both.length === 0;
        detail = { cypherRows: a.length, sparqlRows: b.length, inBoth: both };
      } else {
        const onlyCypher = a.filter((x) => !b.includes(x));
        const onlySparql = b.filter((x) => !a.includes(x));
        ok = onlyCypher.length === 0 && onlySparql.length === 0;
        detail = { rows: a.length, onlyCypher, onlySparql };
      }
      results.push({ id: c.id, status: ok ? 'pass' : 'fail', mode: c.mode ?? 'equal', ...detail, notExported: c.notExported });
    } catch (err) {
      results.push({ id: c.id, status: 'error', error: err.message });
    }
  }
  return results;
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * The IRIs a check's SPARQL uses (prefixed names expanded with the oracle's
 * prefixes and the query's own; `a` is rdf:type). Template placeholders
 * (<{{…}}>) are not terms.
 */
export function sparqlTerms(check, prefixes = '') {
  const text = `${prefixes ?? ''}\n${check.sparql ?? ''}`;
  const ns = { rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' };
  for (const m of text.matchAll(/PREFIX\s+([A-Za-z][\w.-]*)?:\s*<([^>]*)>/gi)) ns[m[1] ?? ''] = m[2];
  const body = String(check.sparql ?? '').replace(/PREFIX\s+[\w.-]*:\s*<[^>]*>/gi, '').replace(/<\{\{[^}]*\}\}>/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/(^|\s)#[^\n]*/g, '$1');
  const out = new Set();
  for (const m of body.matchAll(/<([^<>\s]+)>/g)) out.add(m[1]);
  for (const m of body.matchAll(/(?<![\w?$:<])([A-Za-z][\w.-]*)?:([A-Za-z_][\w.-]*[\w-]|[A-Za-z_])/g)) {
    if (ns[m[1] ?? ''] !== undefined) out.add(ns[m[1] ?? ''] + m[2]);
  }
  if (/(?:^|[\s;{(])a(?=\s)/.test(body)) out.add(RDF_TYPE);
  return out;
}

/**
 * What a check's Cypher reads: relationship types, node labels, and properties
 * (Label.prop, TYPE.prop) through bound variables or inline property maps. A
 * reading of the text, not a parser: enough for oracle queries; covers: adds
 * relationship types it misses.
 */
export function cypherReads(check) {
  // String literals out first: 'demo:lineage:v2:…' is not a property map.
  const cy = String(check.cypher ?? '').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
  const types = new Set(check.covers ?? []);
  const labels = new Set();
  const props = new Set();
  const vars = new Map();
  for (const m of cy.matchAll(/\[\s*([A-Za-z_]\w*)?\s*:\s*([A-Za-z_]\w*(?:\s*\|\s*:?\s*[A-Za-z_]\w*)*)\s*(\{[^}]*\})?/g)) {
    const ts = m[2].split('|').map((t) => t.replace(/^\s*:?\s*|\s*$/g, ''));
    for (const t of ts) types.add(t);
    if (m[1]) vars.set(m[1], ts[0]);
    for (const k of (m[3] ?? '').matchAll(/([A-Za-z_]\w*)\s*:/g)) props.add(`${ts[0]}.${k[1]}`);
  }
  for (const m of cy.matchAll(/\(\s*([A-Za-z_]\w*)?\s*((?::\s*[A-Za-z_]\w*\s*)+)(\{[^}]*\})?/g)) {
    const ls = [...m[2].matchAll(/:\s*([A-Za-z_]\w*)/g)].map((x) => x[1]);
    for (const l of ls) labels.add(l);
    if (m[1]) vars.set(m[1], ls[0]);
    for (const k of (m[3] ?? '').matchAll(/([A-Za-z_]\w*)\s*:/g)) for (const l of ls) props.add(`${l}.${k[1]}`);
  }
  for (const m of cy.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g)) if (vars.has(m[1])) props.add(`${vars.get(m[1])}.${m[2]}`);
  // Relationships with their ends: (a:Tick)-[:ABOUT]->(:Metric), (t)<-[:EMITS]-(g), labels through variables bound elsewhere.
  const nodeLabels = new Map();
  for (const m of cy.matchAll(/\(\s*([A-Za-z_]\w*)\s*((?::\s*[A-Za-z_]\w*\s*)+)/g)) nodeLabels.set(m[1], [...m[2].matchAll(/:\s*([A-Za-z_]\w*)/g)].map((x) => x[1]));
  const NODE = String.raw`\(\s*([A-Za-z_]\w*)?\s*((?::\s*[A-Za-z_]\w*\s*)*)(?:\{[^}]*\})?\s*\)`;
  const REL = String.raw`(<)?-\[\s*(?:[A-Za-z_]\w*)?\s*(?::\s*([A-Za-z_]\w*(?:\s*\|\s*:?\s*[A-Za-z_]\w*)*))?[^\]]*\]-(>)?`;
  const chain = new RegExp(`${NODE}\\s*${REL}\\s*${NODE}`, 'y');
  const ends = (v, ls) => { const own = [...(ls ?? '').matchAll(/:\s*([A-Za-z_]\w*)/g)].map((x) => x[1]); return own.length ? own : (v && nodeLabels.get(v)) || null; };
  const rels = [];
  for (let i = cy.indexOf('('); i >= 0; i = cy.indexOf('(', i + 1)) {
    chain.lastIndex = i;
    const m = chain.exec(cy);
    if (!m || !m[4]) continue;
    const [left, right] = [ends(m[1], m[2]), ends(m[6], m[7])];
    for (const t of m[4].split('|').map((x) => x.replace(/^\s*:?\s*|\s*$/g, ''))) {
      if (m[3] && !m[5]) rels.push({ type: t, from: right, to: left });
      else if (m[5] && !m[3]) rels.push({ type: t, from: left, to: right });
      else rels.push({ type: t, from: left, to: right }, { type: t, from: right, to: left });
    }
  }
  return { types: [...types], labels: [...labels], props: [...props], rels, covers: [...(check.covers ?? [])] };
}

/**
 * Whether what a check's Cypher reads includes one relationship kind of the
 * LPG ontology, with its ends: (:Tick)-[:ABOUT]->(:Metric) is not
 * (:Rollup)-[:ABOUT]->(:Metric). An end without a label counts only when the
 * type alone names one relationship kind; otherwise covers: must say which one
 * (TYPE(From→To), or TYPE for all kinds of that type).
 */
export function readsRelationship(reads, lpgDoc, relId) {
  const idx = indexLpg(lpgDoc);
  const r = idx.rels.get(relId);
  if (!r) return false;
  const label = (id) => idx.nodes.get(id)?.label;
  const named = `${r.type}(${label(r.from)}→${label(r.to)})`;
  const covers = (reads.covers ?? []).map((c) => String(c).replace(/\s+/g, '').replace('->', '→'));
  if (covers.includes(named) || covers.includes(r.type)) return true;
  const kinds = [...idx.rels.values()].filter((x) => x.type === r.type).length;
  const byLabel = new Map([...idx.nodes.values()].map((n) => [n.label, n.id]));
  // A label stands for its node kind and the kinds it implies: (:DatasetVersion) is an Entity too.
  const end = (labels, nodeId) => {
    if (!labels) return null;
    return labels.some((l) => byLabel.get(l) === nodeId || idx.ancestors(byLabel.get(l) ?? '').includes(nodeId));
  };
  return (reads.rels ?? []).some((x) => {
    if (x.type !== r.type) return false;
    const [f, t] = [end(x.from, r.from), end(x.to, r.to)];
    if (f === false || t === false) return false;
    return (f && t) || kinds === 1;
  });
}

/** The predicates and classes each unit of a compiled plan emits, by decision (nodes/<id>, relationships/<id>). */
export function emittedTerms(plan) {
  const out = {};
  for (const u of plan.units ?? []) {
    const terms = new Set();
    for (const t of u.templates ?? []) {
      for (const tr of t.triples ?? []) {
        const preds = typeof tr.predicate === 'string' ? [tr.predicate] : Object.values(tr.predicate?.map ?? {});
        for (const p of preds) if (p !== RDF_TYPE) terms.add(p);
        if (preds.includes(RDF_TYPE)) for (const c of typeof tr.object === 'string' ? [tr.object] : Object.values(tr.object?.map ?? {})) if (!/\{/.test(c)) terms.add(c);
      }
    }
    out[u.id] = [...terms];
  }
  return out;
}

/** Keys sorted, meta left out at every level (properties carry their own). */
const decisionOf = (v) => (Array.isArray(v) ? v.map(decisionOf) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter((k) => k !== 'meta').sort().map((k) => [k, decisionOf(v[k])])) : v);
/** A decision as the oracle saw it: the entry without who proposed or reviewed it, nor its status. */
export const entryFingerprint = (e) => (e ? JSON.stringify(decisionOf(e)) : null);

/**
 * What one oracle run says about the decisions it projected. Per check: its
 * status, the IRIs its SPARQL uses, what its Cypher reads. Per decision
 * (element or property entry, mapped or left out): its fingerprint, and for an
 * element the predicates and classes the compiled plan emits for it. The review
 * reads it (review.js):
 *   - a mapped relationship is safe only when a check whose SPARQL uses a term
 *     it emits passed with that very decision;
 *   - a decision to leave something out is not safe when a check whose Cypher
 *     reads it failed.
 * @param {{oracle: object, results: Array<object>, mapping: object, lpgDoc: object, plan: object, withProposals: boolean, at?: string}} o
 *        mapping and plan are the ones projected (accepted entries, or proposals too)
 */
export function oracleEvidence({ oracle, results, mapping, lpgDoc, plan, withProposals, at = new Date().toISOString() }) {
  const status = new Map(results.map((r) => [r.id, r.status]));
  const live = (e) => e && (withProposals ? e.meta?.status !== 'rejected' : (e.meta?.status ?? 'accepted') === 'accepted');
  const emitted = emittedTerms(plan);
  const decisions = {};
  for (const section of ['nodes', 'relationships']) {
    for (const [id, e] of Object.entries(mapping[section] ?? {})) {
      const key = `${section}/${id}`;
      if (live(e)) decisions[key] = { fingerprint: entryFingerprint(e), terms: emitted[key] ?? [] };
      if (e?.ignore) continue;
      for (const [pid, pe] of Object.entries(e?.properties ?? {})) if (live(pe)) decisions[`${key}/properties/${pid}`] = { fingerprint: entryFingerprint(pe) };
    }
  }
  return {
    format: 'n20s-oracle-evidence/0.2', at, withProposals,
    checks: oracle.checks.map((c) => ({ id: c.id, status: status.get(c.id) ?? 'not-run', terms: c.expressible === false ? [] : [...sparqlTerms(c, oracle.prefixes)], reads: cypherReads(c) })),
    decisions,
  };
}
