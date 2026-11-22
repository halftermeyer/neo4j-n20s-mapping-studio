// Oracle: the same question in Cypher on the LPG and in SPARQL on the projection.
import { indexLpg } from './lpg.js';
import { resolve, isCompiled, statusOf } from './resolve.js';
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

/** The parameter cases of a check: cases: [{params}], or its params, or none. */
export const casesOf = (c) => (Array.isArray(c?.cases) && c.cases.length ? c.cases.map((x) => x?.params ?? {}) : [c?.params ?? {}]);

const IRIREF_FORBIDDEN = /[<>"{}|^`\\\u0000- ]/;
const sparqlLiteral = (v) => `"${String(v).replace(/[\\"]/g, (ch) => `\\${ch}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;

/** {{<node id>|value}}, {{iri|value}}, {{literal|value}} in a check's SPARQL; a value $name comes from the case's params. */
function fillPlaceholders(text, params, d) {
  return String(text).replace(/\{\{([^|}]+)\|([^}]+)\}\}/g, (_, kind, expr) => {
    const e = expr.trim();
    let v = e;
    if (e.startsWith('$')) {
      if (!(e.slice(1) in params)) throw new Error(`${e} has no value in this case.`);
      v = params[e.slice(1)];
    }
    if (kind === 'literal') return sparqlLiteral(v);
    if (kind === 'iri') {
      if (IRIREF_FORBIDDEN.test(String(v))) throw new Error(`${v} cannot be an IRI.`);
      return String(v);
    }
    return d.iriOf(kind, v);
  });
}

/**
 * Runs each check in Cypher on the source and in SPARQL on the projection, once
 * per parameter case. A check passes when every case does. nonEmpty says
 * whether the Cypher answered something in at least one case: two empty
 * answers are equal, and prove nothing.
 * @param {{oracle: object, mapping: object, lpgDoc: object, source: object, n20s: object, graph: string}} args
 */
export async function runOracle({ oracle, mapping, lpgDoc, source, n20s, graph }) {
  const d = decoders(mapping, lpgDoc);
  const results = [];
  for (const c of oracle.checks) {
    if (c.expressible === false) { results.push({ id: c.id, status: 'not-expressible', reason: c.reason }); continue; }
    try {
      const decode = Object.fromEntries(Object.entries(c.decode ?? {}).map(([col, spec]) => [col, d.decoder(spec)]));
      const cases = [];
      for (const params of casesOf(c)) {
        const sparql = (oracle.prefixes ?? '') + fillPlaceholders(c.sparql, params, d);
        const [cy, sp] = await Promise.all([source.run(c.cypher, params), n20s.query(graph, sparql)]);
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
        cases.push({ params, status: ok ? 'pass' : 'fail', empty: a.length === 0, ...detail });
      }
      const failed = cases.find((x) => x.status !== 'pass');
      const { params: _p, status: _s, empty: _e, ...first } = failed ?? cases[0];
      results.push({
        id: c.id, status: failed ? 'fail' : 'pass', mode: c.mode ?? 'equal', ...first, notExported: c.notExported,
        nonEmpty: cases.some((x) => !x.empty), ...(c.cases ? { cases } : {}),
      });
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
export function oracleEvidence({ oracle, results, mapping, lpgDoc, plan, withProposals, at = new Date().toISOString(), oracleSha256 = null }) {
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
  const byId = new Map(results.map((r) => [r.id, r]));
  return {
    format: 'n20s-oracle-evidence/0.3', at, withProposals, ...(oracleSha256 ? { oracle: oracleSha256 } : {}),
    checks: oracle.checks.map((c) => ({
      id: c.id, status: status.get(c.id) ?? 'not-run', fingerprint: checkFingerprint(c), nonEmpty: byId.get(c.id)?.nonEmpty ?? null,
      terms: c.expressible === false ? [] : [...sparqlTerms(c, oracle.prefixes)], reads: cypherReads(c),
    })),
    decisions,
  };
}

// Validated checks and coverage ---------------------------------------------------------------

/** FNV-1a, 64 bits as hex: a fingerprint, not a secret. Browser-safe and synchronous. */
function fnv(text) {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(text)) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

/** What a check asks, fingerprinted: a check edited after its validation is to validate again. */
export const checkFingerprint = (c) => fnv(JSON.stringify(sorted({
  mode: c.mode ?? 'equal', columns: c.columns ?? [], decode: c.decode ?? {}, cypher: String(c.cypher ?? '').trim(),
  sparql: String(c.sparql ?? '').trim(), params: c.params ?? null, cases: c.cases ?? null,
})));

/** Whether what a check's Cypher reads includes an element of the LPG ontology (a label it implies counts), or a property of one. */
export function readsElement(reads, lpgDoc, path) {
  const idx = indexLpg(lpgDoc);
  const [section, id, , pid] = path.split('/');
  if (section === 'relationships') {
    const r = idx.rels.get(id);
    return pid ? reads.props.includes(`${r?.type}.${r?.props.get(pid)?.name}`) : readsRelationship(reads, lpgDoc, id);
  }
  const ls = new Set([idx.nodes.get(id)?.label]);
  for (const n of idx.nodes.values()) if (idx.ancestors(n.id).includes(id)) ls.add(n.label);
  if (!pid) return reads.labels.some((l) => ls.has(l));
  const name = idx.findNodeProperty(id, pid)?.prop.name;
  return [...ls].some((l) => reads.props.includes(`${l}.${name}`));
}

/**
 * Every decision of a mapping (element and property entries, not rejected),
 * with the terms it puts in the RDF: classes of a node kind, the predicate of a
 * property, what the compiled plan emits for a relationship (qualified forms
 * included). Left-out decisions have none.
 * @param {object} plan  compiled from the mapping as projected (proposals accepted, to see them)
 */
export function decisionTerms(mapping, lpgDoc, plan = null, evidence = null) {
  const P = mapping.prefixes ?? {};
  const iri = (x) => (x ? expand(x, P).iri : null);
  // Without a plan, what the last oracle run says the decision emitted (when it ran with this very decision).
  const emitted = plan ? emittedTerms(plan) : Object.fromEntries(Object.entries(evidence?.decisions ?? {}).filter(([, d]) => d.terms).map(([k, d]) => [k, d.terms]));
  const out = new Map();
  const add = (path, entry, status, terms) => out.set(path, { path, section: path.split('/')[0], entry, status, kind: entry.ignore ? 'left-out' : 'mapped', terms: new Set(entry.ignore ? [] : terms.filter(Boolean)) });
  for (const section of ['nodes', 'relationships']) {
    for (const [id, e] of Object.entries(mapping[section] ?? {})) {
      if (!e || statusOf(e) === 'rejected') continue;
      const path = `${section}/${id}`;
      const fresh = evidence?.decisions?.[path]?.fingerprint === undefined || plan || evidence.decisions[path].fingerprint === entryFingerprint(e);
      const own = section === 'nodes' ? (e.classes ?? []).map(iri) : ((fresh && emitted[path]) || [iri(e.predicate), iri(e.qualified?.class), iri(e.qualified?.link), iri(e.qualified?.target)]);
      if (e.ignore || own.length || section === 'relationships' || e.classes) add(path, e, statusOf(e), own);
      if (e.ignore) continue;
      for (const [pid, pe] of Object.entries(e.properties ?? {})) {
        if (!pe || statusOf(pe) === 'rejected') continue;
        add(`${path}/properties/${pid}`, pe, pe.meta?.status ?? statusOf(e), [iri(pe.predicate)]);
      }
    }
  }
  return out;
}

/** The decisions a check's SPARQL relies on: those that emit a term it uses, with their fingerprint and status now. */
export function reliesOf(check, { mapping, lpgDoc, plan, prefixes = '' }) {
  const terms = sparqlTerms(check, prefixes);
  return [...decisionTerms(mapping, lpgDoc, plan).values()]
    .filter((d) => [...d.terms].some((t) => terms.has(t)))
    .map((d) => ({ path: d.path, fingerprint: entryFingerprint(d.entry), status: d.status }));
}

/** Column names a Cypher statement returns (its last RETURN): aliases, and plain variables. */
export function returnColumns(cypher) {
  const text = String(cypher ?? '').replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
  const i = text.search(/\bRETURN\b(?![\s\S]*\bRETURN\b)/i);
  if (i < 0) return [];
  const body = text.slice(i).replace(/^RETURN\s+(DISTINCT\s+)?/i, '').split(/\b(ORDER\s+BY|SKIP|LIMIT)\b/i)[0];
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  parts.push(cur);
  return parts.map((x) => x.trim()).map((x) => /\bAS\s+`?([A-Za-z_]\w*)`?\s*$/i.exec(x)?.[1] ?? (/^[A-Za-z_]\w*$/.test(x) ? x : null)).filter(Boolean);
}

/**
 * An oracle check from a competency question drafted as a recipe, with the
 * direct Cypher a person validated. The SPARQL is the recipe's question:
 * {{kind|$param}} placeholders stay, filled per case; prefixes it needs that the
 * oracle does not declare are added to it. Throws when it cannot be a check.
 * @param {{recipe: object, cypher: string, cases: Array<{params: object}>, id: string, question: string, mapping: object, oraclePrefixes?: string}} a
 */
export function checkFromDraft({ recipe, cypher, cases = [], id, question, mapping, oraclePrefixes = '' }) {
  const q = [...(recipe.steps ?? [])].reverse().find((s) => s.type === 'query');
  if (!q) throw new Error('The recipe has no query step: nothing to compare with the Cypher.');
  if (q.profile || q.rules || q.rulesFiles) throw new Error(`Step ${q.id} reasons (profile or rules): an oracle check asks the projection as it is. Write the question without reasoning, or keep it as a recipe.`);
  const selected = [...String(q.sparql).replace(/WHERE[\s\S]*$/i, '').matchAll(/[?$](\w+)/g)].map((m) => m[1]);
  const columns = returnColumns(cypher).filter((c) => selected.includes(c));
  if (!columns.length) throw new Error(`The Cypher returns ${returnColumns(cypher).join(', ') || 'nothing named'} and the SPARQL selects ${selected.join(', ') || 'nothing'}: they need a column in common.`);
  const decode = {};
  for (const col of columns) {
    const spec = q.decode?.[col];
    if (spec === 'any') throw new Error(`decode ${col}: any is not a check decoder; decode it as node:<node id>.`);
    if (spec) decode[col] = spec;
  }
  const used = new Set([...String(cypher).matchAll(/\$([A-Za-z_]\w*)/g), ...String(q.sparql).matchAll(/\{\{[^|}]+\|\s*\$([A-Za-z_]\w*)/g)].map((m) => m[1]));
  for (const p of used) {
    if (recipe.params?.[p]?.type === 'list') throw new Error(`$${p} is a list: an oracle case takes single values.`);
    for (const c of cases) if (!(p in (c.params ?? {}))) throw new Error(`A case has no value for $${p}.`);
  }
  // Placeholders: node and iri ones inside <…>, as the oracle writes them; literal ones as they are.
  const body = String(q.sparql).trim().replace(/<?\{\{([^|}]+)\|([^}]+)\}\}>?/g, (_, kind, expr) => (kind === 'literal' ? `{{literal|${expr}}}` : `<{{${kind}|${expr}}}>`));
  const declared = new Set([...String(oraclePrefixes).matchAll(/PREFIX\s+([\w.-]*):/gi)].map((m) => m[1]));
  const P = { ...(mapping?.prefixes ?? {}), ...(recipe.prefixes ?? {}) };
  const need = Object.entries(P).filter(([p]) => !declared.has(p) && new RegExp(`(?<![\\w?$:<])${p.replace(/[.-]/g, '\\$&')}:`).test(body.replace(/<[^>]*>/g, ' ')));
  const sparql = `${need.map(([p, ns]) => `PREFIX ${p}: <${ns}>`).join('\n')}${need.length ? '\n' : ''}${body}\n`;
  const kept = cases.map((c) => ({ params: Object.fromEntries(Object.entries(c.params ?? {}).filter(([k]) => used.has(k))) }));
  return {
    id, source: question, mode: 'equal', columns, ...(Object.keys(decode).length ? { decode } : {}),
    cypher: `${String(cypher).trim()}\n`, sparql,
    ...(used.size ? { cases: kept } : {}),
  };
}

/**
 * Which validated checks cover which decision, from the oracle file and the
 * evidence of its last run.
 *   covered   the check's SPARQL uses a term the decision emits AND its Cypher
 *             reads the element (a relationship with its ends); it counts when
 *             it passed with this very decision, its Cypher answered something,
 *             it is validated as it is (or written by hand), and it was not
 *             drafted from this decision while the decision was only proposed
 *             (shown as drafted from it once accepted);
 *   suspected a check whose SPARQL uses a term the decision emits failed with
 *             it: blame is wider than coverage;
 *   read by   for a decision to leave something out: the checks whose Cypher reads it.
 * @param {{oracle: object|null, evidence: object|null, mapping: object, lpgDoc: object, plan?: object|null, lpgHash?: string|null}} a
 */
export function coverage({ oracle, evidence = null, mapping, lpgDoc, plan = null, lpgHash = null }) {
  const idx = indexLpg(lpgDoc);
  const byId = new Map((evidence?.checks ?? []).map((c) => [c.id, c]));
  // Without the oracle file, the checks as the evidence recorded them (written by hand, as far as it knows).
  const raw = oracle ? oracle.checks.filter((c) => c.expressible !== false)
    : (evidence?.checks ?? []).filter((c) => c.status !== 'not-expressible').map((ev) => ({ id: ev.id, fromEvidence: ev }));
  const checks = raw.map((c) => {
    const fingerprint = c.fromEvidence ? null : checkFingerprint(c);
    const ev = byId.get(c.id);
    const same = !!ev && (!ev.fingerprint || !fingerprint || ev.fingerprint === fingerprint);
    const validation = !c.validated ? 'by hand'
      : c.validated.fingerprint !== fingerprint ? 'to revalidate: changed since it was validated'
        : lpgHash && c.validated.lpg && c.validated.lpg !== lpgHash ? 'to revalidate: the LPG ontology changed' : 'validated';
    return {
      id: c.id, source: c.source ?? null, check: c,
      terms: c.fromEvidence ? new Set(c.fromEvidence.terms ?? []) : sparqlTerms(c, oracle.prefixes), reads: c.fromEvidence ? c.fromEvidence.reads : cypherReads(c),
      status: same ? ev.status : 'not-run', nonEmpty: same ? ev.nonEmpty ?? null : null, validation,
      relies: new Map((c.validated?.relies ?? []).map((r) => [r.path, r])),
    };
  });
  const label = (path) => {
    const [section, id, , pid] = path.split('/');
    const base = section === 'nodes' ? idx.nodes.get(id)?.label : (() => { const r = idx.rels.get(id); return r ? `(${idx.nodes.get(r.from)?.label})-[:${r.type}]->(${idx.nodes.get(r.to)?.label})` : id; })();
    if (!pid) return base;
    const p = section === 'nodes' ? idx.findNodeProperty(id, pid)?.prop : idx.rels.get(id)?.props.get(pid);
    return `${base}.${p?.name ?? pid}`;
  };
  const decisions = [];
  for (const d of decisionTerms(mapping, lpgDoc, plan, evidence).values()) {
    // Statuses count only from a run that projected this very decision.
    const ev = evidence?.decisions?.[d.path];
    const ranWith = !!ev && ev.fingerprint === entryFingerprint(d.entry);
    const covering = [];
    const suspects = [];
    const readBy = [];
    for (const k of checks) {
      const status = ranWith ? k.status : 'not-run';
      const reads = readsElement(k.reads, lpgDoc, d.path);
      if (d.kind === 'left-out') { if (reads) readBy.push({ id: k.id, status }); continue; }
      const uses = [...k.terms].some((t) => d.terms.has(t));
      if (uses && ['fail', 'error'].includes(status)) suspects.push(k.id);
      if (!uses || !reads) continue;
      const r = k.relies.get(d.path);
      const draftedFrom = !!r && r.fingerprint === entryFingerprint(d.entry);
      const why = status === 'not-run' ? (ev ? 'not run with this decision' : 'not run yet')
        : status !== 'pass' ? (status === 'fail' ? 'fails' : 'error')
          : k.nonEmpty === false ? 'its Cypher answers nothing: two empty answers prove nothing'
            : k.validation.startsWith('to revalidate') ? k.validation
              : draftedFrom && d.status === 'proposed' ? 'drafted from this decision while it is proposed: accept it first' : null;
      covering.push({ id: k.id, status, counts: !why, why, draftedFrom });
    }
    decisions.push({
      path: d.path, section: d.section, label: label(d.path), kind: d.kind, status: d.status, terms: [...d.terms],
      covering, counted: covering.filter((c) => c.counts).map((c) => c.id), suspects, readBy,
    });
  }
  return {
    decisions,
    checks: checks.map((k) => ({ id: k.id, source: k.source, status: k.status, nonEmpty: k.nonEmpty, validation: k.validation, cases: k.check.cases?.length ?? 1, terms: [...k.terms] })),
    summary: {
      mapped: decisions.filter((d) => d.kind === 'mapped').length,
      covered: decisions.filter((d) => d.kind === 'mapped' && d.counted.length).length,
      suspected: decisions.filter((d) => d.suspects.length).length,
    },
  };
}
