// The named graphs that outlive a run: where each one comes from, and whether
// it can be trusted as it is. A registry records every build of a persistent
// graph (recipe, run, time, parameters, mapping and LPG ontology hashes, source);
// comparing it with what n20s-server holds now tells, per graph:
//   stable      built by a recipe that finished, from the mapping and LPG
//               ontology as they are now, with the size it had when built;
//   stale       the mapping or the LPG ontology changed since, or the size did
//               (something else wrote to it): rebuild it;
//   incomplete  the last build stopped on an error;
//   missing     recorded, but not in n20s-server (n20s-server keeps graphs in
//               memory: a restart empties it);
//   unknown     in n20s-server, recorded nowhere.
// Browser-safe: the registry is a plain object; files are in node.js.
import { contentHash } from './lpg.js';

export const REGISTRY_FORMAT = 'n20s-graphs/0.1';

export const emptyRegistry = () => ({ format: REGISTRY_FORMAT, graphs: {} });

/**
 * What identifies the mapping and the LPG ontology a graph was built from. The
 * mapping counts by its compiled plan (row queries and templates): a review that
 * changes no triple does not make a graph stale.
 */
export async function provenance({ mapping, lpgDoc, plan }) {
  return {
    mapping: { id: mapping.id, contentHash: await contentHash({ units: plan.units }) },
    lpg: { id: lpgDoc.id, version: String(lpgDoc.version), contentHash: await contentHash(lpgDoc) },
  };
}

/**
 * Records the persistent graphs a run wrote and the endpoints it published.
 * Graphs it only read are left as they were recorded. Returns the new registry.
 */
export function recordRun(registry, run, { file, provenance: prov, source = null, n20s = null }) {
  const out = structuredClone(registry ?? emptyRegistry());
  out.format = REGISTRY_FORMAT;
  out.graphs ??= {};
  out.publications ??= {};
  const at = new Date().toISOString();
  for (const g of Object.values(run.graphs)) {
    if (g.lifecycle !== 'persistent' || !g.written) continue;
    const before = out.graphs[g.name];
    out.graphs[g.name] = {
      recipe: run.recipe, file, runId: run.runId, at, params: run.params,
      start: g.start, status: run.ok ? 'complete' : 'incomplete', triples: g.triples,
      ...(g.versioned ? { base: g.base } : {}),
      ...prov, source, n20s,
      // A recipe that adds to a graph (start: reuse) builds on what was there.
      ...(g.start === 'reuse' && before ? { basedOn: { recipe: before.recipe, runId: before.runId, at: before.at } } : {}),
    };
  }
  for (const p of run.publications ?? []) {
    const previous = out.publications[p.as];
    out.publications[p.as] = {
      graph: p.graph, base: p.base, recipe: run.recipe, file, runId: run.runId, at, params: run.params,
      description: p.description, gate: p.gate, ...(previous && previous.graph !== p.graph ? { replaced: { graph: previous.graph, at: previous.at } } : {}),
    };
  }
  return out;
}

/**
 * Graphs to drop after a run: the version an endpoint served before it was
 * swapped, and the versions of a versioned graph that no endpoint serves
 * (older ones, and this run's own when the run failed or did not publish it
 * and a newer one exists). Returns the registry without them.
 */
export function retire(registry, run) {
  const out = structuredClone(registry);
  const served = new Set(Object.values(out.publications ?? {}).map((p) => p.graph));
  const drop = new Set();
  for (const g of Object.values(run.graphs)) {
    if (!g.versioned) continue;
    for (const [name, e] of Object.entries(out.graphs ?? {})) {
      if (e.base !== g.base || served.has(name)) continue;
      // The new version stays when the run went through: something may publish it later.
      if (name === g.name && run.ok) continue;
      drop.add(name);
    }
  }
  for (const name of drop) delete out.graphs[name];
  return { registry: out, drop: [...drop] };
}

/**
 * Status of every graph known to the registry or present in n20s-server.
 * @param {object} registry
 * @param {Array<{graphName: string, tripleCount: number}>} live  n20s list()
 * @param {Record<string, object>} current  provenance() now, by recipe file
 */
export function graphStatuses(registry, live, current = {}) {
  const sizes = new Map(live.map((g) => [g.graphName, g.tripleCount]));
  const out = [];
  for (const [name, e] of Object.entries(registry?.graphs ?? {})) {
    const reasons = [];
    let status;
    const now = current[e.file];
    if (!sizes.has(name)) status = 'missing';
    else if (e.status === 'incomplete') status = 'incomplete';
    else {
      if (now && now.mapping.contentHash !== e.mapping?.contentHash) reasons.push('the mapping changed since the build');
      if (now && now.lpg.contentHash !== e.lpg?.contentHash) reasons.push(`the LPG ontology changed since the build (built from v${e.lpg?.version}, now v${now.lpg.version})`);
      if (!now) reasons.push(`recipe ${e.file} is gone`);
      if (sizes.get(name) !== e.triples) reasons.push(`${sizes.get(name)} triples now, ${e.triples} when built`);
      status = reasons.length ? 'stale' : 'stable';
    }
    out.push({ name, status, reasons, triples: sizes.get(name) ?? null, built: e, endpoints: endpointsOf(registry, name) });
  }
  for (const [name, n] of sizes) {
    if (registry?.graphs?.[name]) continue;
    // A kept ephemeral graph says so in its name.
    const kept = /^recipe-/.test(name);
    out.push({ name, status: 'unknown', reasons: [kept ? 'an ephemeral graph kept after its run (--keep)' : 'not built by a recipe of this directory'], triples: n, built: null, endpoints: [] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const endpointsOf = (registry, graph) => Object.entries(registry?.publications ?? {}).filter(([, p]) => p.graph === graph).map(([n]) => n);

/** Published endpoints, with the status of the graph each one serves. */
export function publicationStatuses(registry, statuses) {
  const byName = new Map(statuses.map((g) => [g.name, g]));
  return Object.entries(registry?.publications ?? {}).map(([endpoint, p]) => {
    const g = byName.get(p.graph);
    return { endpoint, graph: p.graph, status: g?.status ?? 'missing', reasons: g?.reasons ?? ['the graph is not in n20s-server'], triples: g?.triples ?? null, published: p };
  }).sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}

/** Removes an endpoint. Returns the registry and the graph it served, to drop when nothing else serves it. */
export function unpublish(registry, endpoint) {
  const out = structuredClone(registry);
  const p = out.publications?.[endpoint];
  if (!p) return { registry: out, graph: null };
  delete out.publications[endpoint];
  const stillServed = Object.values(out.publications).some((x) => x.graph === p.graph);
  return { registry: out, graph: stillServed ? null : p.graph };
}
