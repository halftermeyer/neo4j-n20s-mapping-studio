// Source snapshots: the rows a source returned for a set of queries, saved to a
// file and replayed later as a source. Lets a machine that cannot reach a
// database (a CI job, a sandbox, a reviewer) compare, project and run the oracle
// on its data. Browser-safe: no file access here.
import { casesOf } from './oracle.js';

export const SNAPSHOT_FORMAT = 'n20s-source-snapshot/0.1';

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const queryKey = (cypher, params = {}) => JSON.stringify([cypher.trim(), sortKeys(params)]);

/** Wraps a source and keeps every distinct query it answers, with its rows. */
export function recordingSource(source) {
  const queries = [];
  const seen = new Set();
  return {
    url: source.url,
    queries,
    async run(cypher, params = {}) {
      const rows = await source.run(cypher, params);
      const key = queryKey(cypher, params);
      if (!seen.has(key)) { seen.add(key); queries.push({ cypher, params, rows }); }
      return rows;
    },
    agent: () => source.agent(),
    close: () => source.close(),
  };
}

/**
 * Runs the row queries of a plan, and the Cypher side of the oracle checks when
 * an oracle is given, and returns the snapshot.
 */
export async function takeSnapshot({ plan, source, oracle, params = {} }) {
  const rec = recordingSource(source);
  for (const unit of plan.units) await rec.run(unit.cypher, params);
  for (const c of oracle?.checks ?? []) if (c.expressible !== false && c.cypher) for (const p of casesOf(c)) await rec.run(c.cypher, p);
  return {
    format: SNAPSHOT_FORMAT,
    takenAt: new Date().toISOString(),
    source: { url: source.url, agent: await source.agent() },
    mapping: plan.mapping,
    lpgOntology: plan.lpgOntology,
    queries: rec.queries,
  };
}

/** A source that answers from a snapshot, and fails on a query it does not hold. */
export function snapshotSource(snapshot, label = 'snapshot') {
  if (snapshot?.format !== SNAPSHOT_FORMAT || !Array.isArray(snapshot.queries)) {
    throw new Error(`${label}: not a source snapshot (expected format ${SNAPSHOT_FORMAT}).`);
  }
  const byKey = new Map(snapshot.queries.map((q) => [queryKey(q.cypher, q.params), q.rows]));
  return {
    url: label,
    snapshot,
    async run(cypher, params = {}) {
      const rows = byKey.get(queryKey(cypher, params));
      if (!rows) throw new Error(`${label} does not hold this query (take the snapshot again): ${cypher.trim().split('\n')[0].slice(0, 100)}`);
      return structuredClone(rows);
    },
    agent: async () => `snapshot of ${snapshot.source?.agent ?? 'unknown'} (${snapshot.source?.url ?? '?'}, ${snapshot.takenAt ?? '?'})`,
    close: async () => {},
  };
}
