// Compiles accepted entries into a projection plan for the n20s template engine.
// Each unit pairs a Cypher row query with the templates that consume its rows.
// Row queries return maps of plain values only (no node or relationship objects,
// no APOC, no GDS), so they give the same rows on Relate and on Neo4j.
import { indexLpg, contentHash, defaultDatatype } from './lpg.js';
import { expand, expandTemplate, parseTemplate } from './iri.js';
import { resolve, isCompiled } from './resolve.js';

export const PLAN_FORMAT = 'n20s-projection-plan/0.1';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const quote = (name) => '`' + String(name).replaceAll('`', '``') + '`';
const mapLiteral = (fields, variable) => `{${fields.map((f) => `${quote(f)}: ${variable}.${quote(f)}`).join(', ')}}`;
const entries = (o) => Object.entries(o ?? {});
const unique = (xs) => [...new Set(xs)];

/**
 * @returns {Promise<{plan: object, problems: Array<{code: string, path: string, message: string}>}>}
 * Problems are entries the compiler had to leave out. Run check() first: the
 * compiler assumes a mapping without errors.
 */
export async function compile(mapping, lpgDoc) {
  const idx = indexLpg(lpgDoc);
  const r = resolve(mapping, idx, isCompiled);
  const P = r.prefixes;
  const problems = [];
  const problem = (code, path, message) => problems.push({ code, path, message });
  const iri = (ref) => expand(ref, P).iri;

  /** Database name of a property of a node kind (own or implied). */
  const nodeDb = (nodeId, propId) => idx.findNodeProperty(nodeId, propId)?.prop.name ?? propId;

  /** Rewrites an IRI template into an n20s template: prefix expanded, placeholders renamed. */
  function toN20s(template, rename) {
    const head = expandTemplate(template, P).iri;
    return head.replace(/\{([^{}\s]+)\}/g, (_, ph) => `{${rename(ph)}}`);
  }

  /** Database names a node subject template needs. */
  const subjectFields = (nodeId) => {
    const s = r.effectiveSubject(nodeId);
    return s ? parseTemplate(s.template).placeholders.map((ph) => nodeDb(nodeId, ph)) : [];
  };
  /** The database name that identifies a node of this kind in its IRI, when the subject has one placeholder. */
  const keyOf = (nodeId) => { const f = subjectFields(nodeId); return f.length === 1 ? f[0] : null; };

  function propertyTriple(pe, prop, valuePath, path) {
    const predicate = iri(pe.predicate);
    if (pe.values) {
      return { predicate, object: { from: valuePath, map: Object.fromEntries(entries(pe.values).map(([v, ref]) => [v, iri(ref)])) }, kind: 'iri' };
    }
    // The value is the IRI: n20s uses a whole-placeholder value that is an absolute IRI as is.
    if (pe.kind === 'iri') return { predicate, object: `{${valuePath}}`, kind: 'iri' };
    const datatype = pe.datatype ? iri(pe.datatype) : defaultDatatype(prop.type);
    return { predicate, object: `{${valuePath}}`, ...(datatype ? { datatype } : {}) };
  }

  const units = [];

  // Nodes: one unit per kind with something to emit.
  for (const node of idx.nodes.values()) {
    const e = r.nodeEntries[node.id];
    if (!isCompiled(e)) continue;
    const path = `nodes/${node.id}`;
    const subject = r.effectiveSubject(node.id);
    const classes = (e.classes ?? []).map(iri);
    const props = entries(e.properties).filter(([, pe]) => isCompiled(pe));
    if (!classes.length && !props.length) continue;
    if (!subject) { problem('compile.no-subject', path, `"${node.id}" has no subject: left out.`); continue; }
    if (!node.label) { problem('compile.no-label', path, `"${node.id}" has no identifier label to match: left out.`); continue; }

    const triples = classes.map((c) => ({ predicate: RDF_TYPE, object: c, kind: 'iri' }));
    const fields = [...subjectFields(node.id)];
    for (const [pid, pe] of props) {
      const found = idx.findNodeProperty(node.id, pid);
      if (!found) continue;
      const t = propertyTriple(pe, found.prop, found.prop.name, `${path}/properties/${pid}`);
      if (t) { triples.push(t); fields.push(found.prop.name); }
    }
    const match = `MATCH (n:${quote(node.label)})`;
    const ret = `RETURN ${mapLiteral(unique(fields), 'n')} AS row`;
    units.push({
      id: path,
      cypher: `${match} ${ret}`,
      // For a scoped run: the clauses, and the key that identifies the matched node.
      scope: { match, return: ret, nodes: { n: { label: node.label, key: keyOf(node.id) } } },
      templates: [{ subject: toN20s(subject.template, (ph) => nodeDb(node.id, ph)), triples }],
    });
  }

  // Relationships: one unit per type, with the direct triple and the qualified pattern.
  for (const rel of idx.rels.values()) {
    const e = r.relEntries[rel.id];
    if (!isCompiled(e)) continue;
    const path = `relationships/${rel.id}`;
    const from = idx.nodes.get(rel.from);
    const to = idx.nodes.get(rel.to);
    const startSubject = r.effectiveSubject(rel.from);
    const endSubject = r.effectiveSubject(rel.to);
    if (!from?.label || !to?.label || !rel.type) { problem('compile.no-label', path, `"${rel.id}" has an end node or a type the compiler cannot match: left out.`); continue; }
    if (!startSubject || !endSubject) { problem('compile.no-subject', path, `An end node of "${rel.id}" has no subject: left out.`); continue; }

    const startFields = [...subjectFields(rel.from)];
    const endFields = [...subjectFields(rel.to)];
    const relFields = [];
    const startIri = toN20s(startSubject.template, (ph) => `_start.${nodeDb(rel.from, ph)}`);
    const endIri = toN20s(endSubject.template, (ph) => `_end.${nodeDb(rel.to, ph)}`);
    const reverse = e.direction === 'reverse';
    const [subjectIri, objectIri] = reverse ? [endIri, startIri] : [startIri, endIri];

    const main = { subject: subjectIri, triples: [] };
    if (e.predicate) main.triples.push({ predicate: iri(e.predicate), object: objectIri, kind: 'iri' });

    const templates = [main];
    if (e.qualified) {
      const q = e.qualified;
      const qualifiedIri = toN20s(q.subject, (ph) => {
        const m = /^(start|end)\.(.+)$/.exec(ph);
        if (m && m[1] === 'start') { const db = nodeDb(rel.from, m[2]); startFields.push(db); return `_start.${db}`; }
        if (m) { const db = nodeDb(rel.to, m[2]); endFields.push(db); return `_end.${db}`; }
        const db = rel.props.get(ph)?.name ?? ph;
        relFields.push(db);
        return db;
      });
      main.triples.push({ predicate: iri(q.link), object: qualifiedIri, kind: 'iri' });
      const qualified = { subject: qualifiedIri, triples: [
        { predicate: RDF_TYPE, object: iri(q.class), kind: 'iri' },
        { predicate: iri(q.target), object: objectIri, kind: 'iri' },
      ] };
      for (const [pid, pe] of entries(e.properties).filter(([, pe]) => isCompiled(pe))) {
        const prop = rel.props.get(pid);
        if (!prop) continue;
        const t = propertyTriple(pe, prop, prop.name, `${path}/properties/${pid}`);
        if (t) { qualified.triples.push(t); relFields.push(prop.name); }
      }
      templates.push(qualified);
    }
    if (!main.triples.length) templates.shift();

    const rowParts = [
      `_start: ${mapLiteral(unique(startFields), 's')}`,
      `_end: ${mapLiteral(unique(endFields), 't')}`,
      ...unique(relFields).map((f) => `${quote(f)}: r.${quote(f)}`),
    ];
    const match = `MATCH (s:${quote(from.label)})-[r:${quote(rel.type)}]->(t:${quote(to.label)})`;
    const ret = `RETURN {${rowParts.join(', ')}} AS row`;
    units.push({
      id: path,
      cypher: `${match} ${ret}`,
      scope: { match, return: ret, nodes: { s: { label: from.label, key: keyOf(rel.from) }, t: { label: to.label, key: keyOf(rel.to) } } },
      templates,
    });
  }

  const plan = {
    format: PLAN_FORMAT,
    mapping: mapping.id,
    strategy: mapping.strategy,
    lpgOntology: { id: idx.id, version: String(idx.version), contentHash: await contentHash(lpgDoc) },
    units,
  };
  if (mapping.strategy !== 'template') {
    problem('compile.strategy', 'strategy', `Only the template strategy is implemented; this plan uses templates for a "${mapping.strategy}" mapping.`);
  }
  return { plan, problems };
}
