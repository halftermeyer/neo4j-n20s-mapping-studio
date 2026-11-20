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
