// File-system layer for Node: reads the mapping, the LPG ontology, targets, rule files and the lock.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { check } from './check.js';
import { buildLock } from './lock.js';
import { indexLpg, contentHash } from './lpg.js';
import { indexTargets, formatFromPath } from './targets.js';
import { compile } from './compile.js';
import { proposePasses, acceptAll } from './propose.js';
import { emptyRegistry, recordRun, retire, provenance, graphStatuses, publicationStatuses, unpublish } from './graphs.js';
import { runRecipe } from './recipe.js';
import { emptySpec } from './design.js';

export class UsageError extends Error {}

export function variantsPathFor(mappingFile) {
  return mappingFile.replace(/\.(ya?ml|json)$/i, '') + '.variants.json';
}

export function lockPathFor(mappingFile) {
  return mappingFile.replace(/\.(ya?ml|json)$/i, '') + '.lock.json';
}

export async function readMapping(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    throw new UsageError(`Cannot read the mapping ${file}: ${err.message}`);
  }
  if (/\.json$/i.test(file)) return { data: JSON.parse(text), kind: 'json' };
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new UsageError(`${file}: ${doc.errors[0].message}`);
  return { data: doc.toJS(), kind: 'yaml', doc };
}

/** Reads a mapping file and what it points to: LPG ontology, targets, rule files, lock. */
export async function loadFiles(mappingFile, options) {
  return load(mappingFile, options);
}

async function load(mappingFile, { lpg, lock } = {}) {
  const dir = path.dirname(mappingFile);
  const m = await readMapping(mappingFile);
  const mapping = m.data;

  const lpgFile = lpg ?? (mapping?.lpgOntology?.location ? path.resolve(dir, mapping.lpgOntology.location) : null);
  if (!lpgFile) throw new UsageError('No LPG ontology: set lpgOntology.location in the mapping or pass --lpg.');
  let lpgDoc;
  try {
    lpgDoc = JSON.parse(await fs.readFile(lpgFile, 'utf8'));
  } catch (err) {
    throw new UsageError(`Cannot read the LPG ontology ${lpgFile}: ${err.message}`);
  }

  const sources = [];
  const targetStatus = [];
  for (const t of Array.isArray(mapping?.targets) ? mapping.targets : []) {
    if (!t?.location) { targetStatus.push({ namespace: t?.namespace, location: null }); continue; }
    const file = path.resolve(dir, t.location);
    const format = formatFromPath(file);
    try {
      if (!format) throw new Error('unknown extension; use .ttl, .nt, .nq or .trig');
      sources.push({ namespace: t.namespace, text: await fs.readFile(file, 'utf8'), format });
      targetStatus.push({ namespace: t.namespace, location: t.location });
    } catch (err) {
      targetStatus.push({ namespace: t.namespace, location: t.location, error: err.message });
    }
  }
  const targets = sources.length ? indexTargets(sources) : null;

  const artifactInfo = {};
  for (const ref of [...(mapping?.rules ?? []), ...(mapping?.shapes ?? [])]) {
    if (!ref?.location || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(ref.location)) continue;
    try {
      const buf = await fs.readFile(path.resolve(dir, ref.location));
      artifactInfo[ref.location] = { found: true, sha256: createHash('sha256').update(buf).digest('hex') };
    } catch {
      artifactInfo[ref.location] = { found: false };
    }
  }

  const lockFile = lock ?? lockPathFor(mappingFile);
  let lockData = null;
  try {
    lockData = JSON.parse(await fs.readFile(lockFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new UsageError(`Cannot read the lock ${lockFile}: ${err.message}`);
  }

  return { m, mapping, lpgDoc, lpgFile, targets, targetStatus, artifactInfo, lockFile, lockData };
}

/** Checks a mapping file. Paths in the mapping are relative to it. */
export async function checkFiles(mappingFile, options = {}) {
  const l = await load(mappingFile, options);
  const result = await check({ mapping: l.mapping, lpgDoc: l.lpgDoc, targets: l.targets, targetStatus: l.targetStatus, artifactInfo: l.artifactInfo, lock: l.lockData });
  return {
    ...result,
    files: { mapping: mappingFile, lpg: l.lpgFile, lock: l.lockData ? l.lockFile : null },
    targetInfo: l.targets ? { namespaces: l.targets.namespaces, triples: l.targets.size } : null,
  };
}

/**
 * Records the current LPG ontology in the lock file and sets lpgOntology.version
 * in the mapping (comments and layout of a YAML mapping are kept). Refuses when
 * the check reports errors, unless force is set.
 */
export async function lockFiles(mappingFile, { force = false, ...options } = {}) {
  const l = await load(mappingFile, options);
  const result = await check({ mapping: l.mapping, lpgDoc: l.lpgDoc, targets: l.targets, targetStatus: l.targetStatus, artifactInfo: l.artifactInfo, lock: l.lockData });
  if (!result.ok && !force) return { written: false, result };

  const lock = buildLock(indexLpg(l.lpgDoc), await contentHash(l.lpgDoc));
  await fs.writeFile(l.lockFile, JSON.stringify(lock, null, 2) + '\n');

  const version = String(l.lpgDoc.version);
  let versionUpdated = false;
  if (String(l.mapping?.lpgOntology?.version) !== version) {
    if (l.m.kind === 'yaml') {
      l.m.doc.setIn(['lpgOntology', 'version'], version);
      await fs.writeFile(mappingFile, l.m.doc.toString());
    } else {
      l.mapping.lpgOntology.version = version;
      await fs.writeFile(mappingFile, JSON.stringify(l.mapping, null, 2) + '\n');
    }
    versionUpdated = true;
  }
  return { written: true, lockFile: l.lockFile, version, versionUpdated, result };
}

/**
 * Checks then compiles a mapping file into a projection plan. Refuses when the
 * check reports errors, unless force is set (the compiler assumes a clean mapping).
 */
export async function compileFiles(mappingFile, { force = false, ...options } = {}) {
  const l = await load(mappingFile, options);
  const result = await check({ mapping: l.mapping, lpgDoc: l.lpgDoc, targets: l.targets, targetStatus: l.targetStatus, artifactInfo: l.artifactInfo, lock: l.lockData });
  if (!result.ok && !force) return { compiled: false, result };
  const { plan, problems } = await compile(l.mapping, l.lpgDoc);
  return { compiled: true, plan, problems, result, mapping: l.mapping, lpgDoc: l.lpgDoc };
}

/**
 * Proposes entries for the undecided elements of a mapping file (see propose.js).
 * Paths in the result are rebased so that it can be written to `out`.
 * @param {string} mappingFile
 * @param {object} options  provider, prefix, baseIri, passes, descriptions, openTerms, repair, valuesOf, only, onProgress, out, lpg
 */
export async function proposeFiles(mappingFile, { lpg, out, prefix, baseIri, specFile = null, ...options }) {
  const l = await load(mappingFile, { lpg });
  // The spec of the mapping, when there is one: scope, principles, notes.
  const spec = await readSpec(specFile ?? specPathFor(mappingFile), l.mapping.id);
  const mapping = structuredClone(l.mapping);
  mapping.prefixes = { ...mapping.prefixes };
  if (baseIri) {
    if (mapping.prefixes[prefix] && mapping.prefixes[prefix] !== baseIri) throw new UsageError(`Prefix "${prefix}" is already ${mapping.prefixes[prefix]}.`);
    mapping.prefixes[prefix] = baseIri;
  } else if (!mapping.prefixes[prefix]) {
    throw new UsageError(`Prefix "${prefix}" is not declared in the mapping: pass --base-iri <iri> to add it.`);
  }
  const res = await proposePasses({ mapping, lpgDoc: l.lpgDoc, targets: l.targets, prefix, spec, ...options });
  if (out) {
    const from = path.dirname(mappingFile);
    const to = path.dirname(out);
    const rebase = (p) => (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(p) || path.isAbsolute(p) ? p : path.relative(to, path.resolve(from, p)) || '.');
    const m = res.mapping;
    if (lpg) m.lpgOntology.location = path.relative(to, path.resolve(lpg));
    else if (m.lpgOntology?.location) m.lpgOntology.location = rebase(m.lpgOntology.location);
    for (const t of m.targets ?? []) if (t.location) t.location = rebase(t.location);
    for (const ref of [...(m.rules ?? []), ...(m.shapes ?? [])]) if (ref.location) ref.location = rebase(ref.location);
  }
  return { ...res, lpgDoc: l.lpgDoc };
}

/** Distinct values of a property on a source, for value tables; null when there are too many for a table. */
export function sourceValues(source, { max = 50 } = {}) {
  const q = (name) => '`' + String(name).replaceAll('`', '``') + '`';
  return async ({ section, label, property }) => {
    const cypher = section === 'nodes'
      ? `MATCH (x:${q(label)}) WHERE x.${q(property)} IS NOT NULL RETURN DISTINCT toString(x.${q(property)}) AS v LIMIT ${max + 1}`
      : `MATCH ()-[x:${q(label)}]->() WHERE x.${q(property)} IS NOT NULL RETURN DISTINCT toString(x.${q(property)}) AS v LIMIT ${max + 1}`;
    const rows = await source.run(cypher);
    return rows.length > max || rows.length === 0 ? null : rows.map((r) => r.v);
  };
}

/** Reads a recipe file and what it needs: its mapping, compiled (accepted entries), and a reader for its files. */
export async function loadRecipe(recipeFile, { proposals = false } = {}) {
  let recipe;
  try {
    recipe = YAML.parse(await fs.readFile(recipeFile, 'utf8'));
  } catch (err) {
    throw new UsageError(`Cannot read the recipe ${recipeFile}: ${err.message}`);
  }
  const dir = path.dirname(recipeFile);
  if (!recipe?.mapping) throw new UsageError(`${recipeFile}: no mapping.`);
  const mappingFile = path.resolve(dir, recipe.mapping);
  const l = await load(mappingFile);
  const mapping = proposals ? acceptAll(l.mapping) : l.mapping;
  const { plan, problems } = await compile(mapping, l.lpgDoc);
  return { recipe, mapping, mappingFile, lpgDoc: l.lpgDoc, plan, problems, read: (f) => fs.readFile(path.resolve(dir, f), 'utf8') };
}

/** The registry of persistent graphs, next to the recipes. */
export const registryPathFor = (recipesDir) => path.join(recipesDir, 'graphs.json');

export async function readRegistry(recipesDir) {
  try {
    return JSON.parse(await fs.readFile(registryPathFor(recipesDir), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyRegistry();
    throw new UsageError(`Cannot read ${registryPathFor(recipesDir)}: ${err.message}`);
  }
}

/**
 * Records what a run of this recipe file wrote and published, swaps endpoints
 * to their new graph, and drops the graphs nothing serves any more (the version
 * an endpoint served before, older or failed versions). Returns what changed.
 */
export async function recordRecipeRun(recipeFile, run, loaded, { source = null, n20s = null } = {}) {
  const wrote = Object.values(run.graphs).some((g) => g.lifecycle === 'persistent' && g.written);
  if (!wrote && !run.publications?.length) return null;
  const dir = path.dirname(recipeFile);
  const recorded = recordRun(await readRegistry(dir), run, {
    file: path.basename(recipeFile), provenance: await provenance(loaded), source, n20s: n20s?.url ?? null,
  });
  const { registry, drop } = retire(recorded, run);
  // The registry first: an endpoint must never point at a dropped graph.
  await writeRegistry(dir, registry);
  for (const name of drop) { try { await n20s?.drop(name); } catch { /* already gone */ } }
  return { registry, dropped: drop, published: (run.publications ?? []).map((p) => p.as) };
}

async function writeRegistry(dir, registry) {
  await fs.writeFile(registryPathFor(dir), JSON.stringify(registry, null, 2) + '\n');
}

/** Changes the registry of a directory in place: read, change, write. Returns the new registry. */
export async function updateRegistry(dir, change) {
  const registry = await readRegistry(dir);
  await change(registry);
  await writeRegistry(dir, registry);
  return registry;
}

/** The graph an endpoint of this recipes directory serves now, for recipes that read it (lifecycle: published). */
export const publishedResolver = (dir) => async (endpoint) => (await readRegistry(dir)).publications?.[endpoint]?.graph ?? null;

/** Status of the graphs of n20s-server and of the registry of a recipes directory, and of the endpoints. */
export async function graphsReport(recipesDir, n20s) {
  const registry = await readRegistry(recipesDir);
  const current = {};
  for (const file of new Set(Object.values(registry.graphs ?? {}).map((e) => e.file))) {
    try { current[file] = await provenance(await loadRecipe(path.join(recipesDir, file))); } catch { /* recipe gone or broken: reported as such */ }
  }
  const graphs = graphStatuses(registry, await n20s.list(), current);
  const endpoints = publicationStatuses(registry, graphs).map((e) => {
    const f = registry.follow?.[e.endpoint];
    return f ? { ...e, follow: { since: f.since, state: f.state, changes: f.changes, syncs: f.syncs, lastChange: f.lastChange, lastSync: f.lastSync, watched: f.watched } } : e;
  });
  return Object.assign(graphs, { endpoints });
}

/** Runs again the recipe that published an endpoint, with the parameters of that run: a new version, gated, swapped. */
export async function republish(recipesDir, endpoint, { source, n20s, onStep } = {}) {
  const p = (await readRegistry(recipesDir)).publications?.[endpoint];
  if (!p) throw new UsageError(`Endpoint ${endpoint} is not published from ${recipesDir}.`);
  const file = path.join(recipesDir, p.file);
  const loaded = await loadRecipe(file);
  const run = await runRecipe({ ...loaded, params: p.params ?? {}, source, n20s, resolvePublished: publishedResolver(recipesDir), onStep });
  const recorded = await recordRecipeRun(file, run, loaded, { source: { url: source.url }, n20s });
  return { run, recorded };
}

/** Stops serving an endpoint; drops its graph when it is a version nothing else serves. */
export async function unpublishEndpoint(recipesDir, endpoint, { n20s } = {}) {
  const before = await readRegistry(recipesDir);
  if (!before.publications?.[endpoint]) throw new UsageError(`Endpoint ${endpoint} is not published from ${recipesDir}.`);
  const { registry, graph } = unpublish(before, endpoint);
  let dropped = null;
  if (graph && registry.graphs?.[graph]?.base) {
    delete registry.graphs[graph];
    dropped = graph;
  }
  await writeRegistry(recipesDir, registry);
  if (dropped) { try { await n20s?.drop(dropped); } catch { /* already gone */ } }
  return { endpoint, dropped };
}

/** The specification of a mapping, and its design conversation, next to it unless the project says otherwise. */
export const specPathFor = (mappingFile) => mappingFile.replace(/(\.mapping)?\.(ya?ml|json)$/i, '') + '.spec.yaml';
export const chatPathFor = (specFile) => specFile.replace(/\.spec\.ya?ml$/i, '') + '.chat.jsonl';

export async function readSpec(file, mappingId) {
  try {
    return YAML.parse(await fs.readFile(file, 'utf8')) ?? emptySpec(mappingId);
  } catch (err) {
    if (err.code === 'ENOENT') return emptySpec(mappingId);
    throw new UsageError(`Cannot read the spec ${file}: ${err.message}`);
  }
}

export async function writeSpec(file, spec) {
  const head = '# Specification of the mapping, written in the design conversation: only accepted items count.\n';
  await fs.writeFile(file, head + YAML.stringify(spec, { lineWidth: 0 }));
}

export async function readChat(file) {
  try {
    return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new UsageError(`Cannot read the conversation ${file}: ${err.message}`);
  }
}

export async function appendChat(file, messages) {
  await fs.appendFile(file, messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
}

/** Reads an oracle file; its `mapping` key is relative to it. */
export async function readOracle(file) {
  let oracle;
  try {
    oracle = YAML.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`Cannot read the oracle ${file}: ${err.message}`);
  }
  if (!Array.isArray(oracle?.checks)) throw new UsageError(`${file}: no checks list.`);
  const mappingFile = oracle.mapping ? path.resolve(path.dirname(file), oracle.mapping) : null;
  return { oracle, mappingFile };
}

/** Reads a SPARQL query given inline or as a file path. */
export async function readQueryArg(arg) {
  if (/\b(SELECT|ASK|CONSTRUCT|DESCRIBE|PREFIX)\b/i.test(arg)) return arg;
  try {
    return await fs.readFile(arg, 'utf8');
  } catch (err) {
    throw new UsageError(`Not a query and not a readable file: ${arg} (${err.message})`);
  }
}

export { openSource, splitStatements, parseSourceUrl, isSourceUrl, defaultSource, temporalToXsd, toPlain } from './source.js';
