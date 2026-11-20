// Runs a projection plan: rows from a Cypher source, triples into an n20s graph.

const BATCH = 2000;

/**
 * @param {{plan: object, source: ReturnType<import('./source.js').openSource>, n20s: ReturnType<import('./n20s.js').n20sClient>, graph: string, params?: object}} args
 * @returns {Promise<{graph: string, triples: number, units: Array<{id: string, rows: number, added: number}>}>}
 */
export async function project({ plan, source, n20s, graph, params = {} }) {
  let first = true;
  let triples = 0;
  const units = [];
  for (const unit of plan.units) {
    const rows = await source.run(unit.cypher, params);
    let added = 0;
    for (const template of unit.templates) {
      for (let i = 0; i < Math.max(rows.length, first ? 1 : 0); i += BATCH) {
        const res = await n20s.projectTemplate(graph, template, rows.slice(i, i + BATCH), first ? 'replace' : 'append');
        first = false;
        added += res.added ?? 0;
        triples = res.triplesAfter ?? res.tripleCount ?? triples;
      }
    }
    units.push({ id: unit.id, rows: rows.length, added });
  }
  return { graph, triples, units };
}

const canonical = (rows) => rows.map((r) => JSON.stringify(sortKeys(r))).sort();
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/**
 * Runs every row query of a plan on two sources and reports the units whose
 * rows differ: the check to run before trusting Relate results on Neo4j or Aura.
 */
export async function compareSources({ plan, a, b, params = {} }) {
  const out = [];
  for (const unit of plan.units) {
    const [ra, rb] = await Promise.all([a.run(unit.cypher, params), b.run(unit.cypher, params)]);
    const ca = canonical(ra);
    const cb = canonical(rb);
    const onlyA = ca.filter((x) => !cb.includes(x));
    const onlyB = cb.filter((x) => !ca.includes(x));
    out.push({ id: unit.id, rowsA: ra.length, rowsB: rb.length, same: onlyA.length === 0 && onlyB.length === 0 && ra.length === rb.length, onlyA: onlyA.slice(0, 3), onlyB: onlyB.slice(0, 3) });
  }
  return out;
}
