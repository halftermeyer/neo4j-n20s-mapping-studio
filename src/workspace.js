// A project (workspace): the head of the pipeline. It names the LPG ontologies (exported
// from a modeling tool, or introspected from a database), the RDF target
// ontologies (files, URLs pinned by hash, or the catalog), and the mappings
// between them, each with its specification, recipes and bench.
//
//   format: n20s-project/0.1
//   sources:
//     lineage:    { file: aura-export.json, origin: aura }
//     lineage-db: { introspect: bolt://127.0.0.1:7688, file: introspected.json }
//   targets:
//     prov: { file: targets/prov.nq, namespace: "http://www.w3.org/ns/prov#", prefix: prov }
//     dcat: { catalog: dcat }
//     x:    { url: https://…/x.ttl, namespace: "…", prefix: x }
//   mappings:
//     lineage-prov: { source: lineage, targets: [prov], file: lineage-prov.mapping.yaml, recipes: recipes, spec: lineage-prov.spec.yaml }
//
// Paths are relative to the project file. Targets fetched from a URL or the
// catalog are kept under targets/ and pinned in n20s-project.lock.json, with the
// introspections (time, database, version).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { CATALOG, catalogEntry } from './catalog.js';
import { introspect } from './introspect.js';
import { indexTargets, formatFromPath } from './targets.js';
import { checkFiles, readRegistry, UsageError } from './node.js';
import { publicationStatuses, graphStatuses } from './graphs.js';
import { shorten } from './iri.js';

export const PROJECT_FORMAT = 'n20s-project/0.1';
const NAME = /^[A-Za-z][\w.-]*$/;

export const lockPathOf = (projectFile) => path.join(path.dirname(projectFile), 'n20s-project.lock.json');

export async function readProject(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (err) { throw new UsageError(`Cannot read the project ${file}: ${err.message}`); }
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new UsageError(`${file}: ${doc.errors[0].message}`);
  const project = doc.toJS() ?? {};
  let lock = { sources: {}, targets: {} };
  try { lock = { sources: {}, targets: {}, ...JSON.parse(await fs.readFile(lockPathOf(file), 'utf8')) }; } catch { /* first use */ }
  return { file, dir: path.dirname(file), doc, project, lock };
}

/** Structural findings on a project. */
export function checkProject(project) {
  const out = [];
  if (project?.format !== PROJECT_FORMAT) out.push(`format: expected ${PROJECT_FORMAT}.`);
  for (const [id, s] of Object.entries(project?.sources ?? {})) {
    if (!NAME.test(id)) out.push(`sources/${id}: an id starts with a letter and has letters, digits, ., - and _ only.`);
    if (!s?.file) out.push(`sources/${id}: a source needs a file (the export, or where the introspection is written).`);
  }
  for (const [id, t] of Object.entries(project?.targets ?? {})) {
    const kinds = ['file', 'url', 'catalog'].filter((k) => t?.[k]);
    if (kinds.length !== 1) out.push(`targets/${id}: a target has one of file, url, catalog.`);
    if (t?.catalog && !catalogEntry(t.catalog)) out.push(`targets/${id}: ${t.catalog} is not in the catalog (${CATALOG.map((c) => c.id).join(', ')}).`);
    if ((t?.file || t?.url) && !t.namespace) out.push(`targets/${id}: a target from a file or URL needs its namespace.`);
  }
  for (const [id, m] of Object.entries(project?.mappings ?? {})) {
    if (!project.sources?.[m?.source]) out.push(`mappings/${id}: source ${m?.source} is not declared.`);
    for (const t of m?.targets ?? []) if (!project.targets?.[t]) out.push(`mappings/${id}: target ${t} is not declared.`);
    if (!m?.file) out.push(`mappings/${id}: a mapping needs a file.`);
  }
  return out;
}

/** Namespace, prefix and file of a target, the catalog filled in. */
export function targetInfo(p, id) {
  const t = p.project.targets?.[id] ?? {};
  const c = t.catalog ? catalogEntry(t.catalog) : null;
  const file = t.file ?? `targets/${id}.ttl`;
  return {
    id, origin: t.catalog ? 'catalog' : t.url ? 'url' : 'file',
    namespace: t.namespace ?? c?.namespace, prefix: t.prefix ?? c?.prefix ?? id, url: t.url ?? c?.url ?? null,
    title: t.title ?? c?.title ?? id, description: t.description ?? c?.description ?? null,
    file, path: path.join(p.dir, file),
  };
}

async function exists(f) { try { await fs.access(f); return true; } catch { return false; } }
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function writeLock(p) {
  await fs.writeFile(lockPathOf(p.file), JSON.stringify(p.lock, null, 2) + '\n');
}

/** Downloads a target from its URL (or the catalog) into targets/, pinned; a second fetch must give the same bytes unless repin. */
export async function fetchTarget(p, id, { fetch = globalThis.fetch, repin = false } = {}) {
  const t = targetInfo(p, id);
  if (t.origin === 'file') throw new UsageError(`Target ${id} is a file: nothing to fetch.`);
  const res = await fetch(t.url, { headers: { accept: 'text/turtle, application/n-triples;q=0.9' } });
  if (!res.ok) throw new UsageError(`${t.url}: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = sha256(buf);
  const pinned = p.lock.targets?.[id]?.sha256 ?? p.project.targets[id]?.sha256;
  if (pinned && pinned !== hash && !repin) throw new UsageError(`${t.url} changed since it was pinned (${pinned.slice(0, 12)} → ${hash.slice(0, 12)}): fetch with repin to accept it.`);
  const idx = indexTargets([{ namespace: t.namespace, text: buf.toString('utf8'), format: formatFromPath(t.file) ?? 'Turtle' }]);
  if (idx.failed.length) throw new UsageError(`${t.url}: ${idx.failed[0].error}`);
  await fs.mkdir(path.dirname(t.path), { recursive: true });
  await fs.writeFile(t.path, buf);
  p.lock.targets = { ...p.lock.targets, [id]: { url: t.url, sha256: hash, file: t.file, fetchedAt: new Date().toISOString(), triples: idx.size } };
  await writeLock(p);
  return { id, url: t.url, sha256: hash, triples: idx.size, terms: idx.terms().length };
}

/** Reads a database into an LPG ontology document, written to the source's file. */
export async function introspectSource(p, id, { openSource }) {
  const s = p.project.sources?.[id];
  if (!s) throw new UsageError(`No source ${id}.`);
  if (!s.introspect) throw new UsageError(`Source ${id} is a file (${s.origin ?? 'export'}): nothing to introspect.`);
  const source = openSource(s.introspect === true ? null : s.introspect);
  try {
    const { doc, notes } = await introspect(source, { id: s.id ?? id, name: s.name ?? id });
    const file = path.join(p.dir, s.file);
    const before = await exists(file) ? JSON.parse(await fs.readFile(file, 'utf8')) : null;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(doc, null, 2) + '\n');
    let agent = null;
    try { agent = await source.agent(); } catch { /* none */ }
    p.lock.sources = { ...p.lock.sources, [id]: { introspectedAt: new Date().toISOString(), version: doc.version, agent, url: source.url ?? null } };
    await writeLock(p);
    return { id, version: doc.version, changed: before?.version !== doc.version, previous: before?.version ?? null, nodes: Object.keys(doc.nodes).length, relationships: Object.keys(doc.relationships).length, notes };
  } finally {
    await source.close();
  }
}

/** A new mapping between a source and targets: the file (header only) and its entry in the project. Comments of the project are kept. */
export async function newMapping(p, { id, source, targets, baseIri, prefix = 'ex', file = null, recipes = null }) {
  if (!NAME.test(id ?? '')) throw new UsageError('A mapping id starts with a letter and has letters, digits, ., - and _ only.');
  if (p.project.mappings?.[id]) throw new UsageError(`Mapping ${id} exists.`);
  const s = p.project.sources?.[source];
  if (!s) throw new UsageError(`No source ${source}.`);
  const lpgPath = path.join(p.dir, s.file);
  if (!await exists(lpgPath)) throw new UsageError(`Source ${source} has no file yet (${s.file})${s.introspect ? ': introspect it first' : ''}.`);
  const lpg = JSON.parse(await fs.readFile(lpgPath, 'utf8'));
  const infos = targets.map((t) => {
    if (!p.project.targets?.[t]) throw new UsageError(`No target ${t}.`);
    return targetInfo(p, t);
  });
  for (const t of infos) if (!await exists(t.path)) throw new UsageError(`Target ${t.id} has no file yet${t.origin !== 'file' ? ': fetch it first' : ''}.`);
  if (!baseIri || !/^https?:\/\/\S+[/#]$/.test(baseIri)) throw new UsageError('The base IRI of generated IRIs ends with / or #, for instance https://example.org/lineage/.');
  const rel = file ?? `${id}.mapping.yaml`;
  const mappingPath = path.join(p.dir, rel);
  if (await exists(mappingPath)) throw new UsageError(`${rel} exists.`);
  const fromMapping = (f) => path.relative(path.dirname(mappingPath), f);
  const mapping = {
    format: 'n20s-mapping/0.1', id, name: `${lpg.name ?? lpg.id} to ${infos.map((t) => t.title).join(', ')}`,
    lpgOntology: { id: lpg.id, version: String(lpg.version), location: fromMapping(lpgPath) },
    targets: infos.map((t) => ({ namespace: t.namespace, location: fromMapping(t.path) })),
    strategy: 'template',
    prefixes: { ...Object.fromEntries(infos.map((t) => [t.prefix, t.namespace])), xsd: 'http://www.w3.org/2001/XMLSchema#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#', [prefix]: baseIri },
    nodes: {}, relationships: {},
  };
  await fs.mkdir(path.dirname(mappingPath), { recursive: true });
  await fs.writeFile(mappingPath, `# Created from ${path.basename(p.file)}: ${source} to ${targets.join(', ')}.\n${YAML.stringify(mapping, { lineWidth: 0 })}`);
  if (!p.doc.get('mappings')) p.doc.set('mappings', p.doc.createNode({}));
  const entry = p.doc.createNode({ source, targets, file: rel, recipes: recipes ?? `recipes/${id}`, spec: rel.replace(/\.mapping\.ya?ml$/, '') + '.spec.yaml' });
  entry.flow = false;
  p.doc.setIn(['mappings', id], entry);
  await fs.writeFile(p.file, p.doc.toString({ lineWidth: 0 }));
  return { id, file: rel };
}

/** Everything the project page shows: sources, targets, mappings and how they stand. */
export async function projectStatus(p, { n20s = null } = {}) {
  const sources = [];
  for (const [id, s] of Object.entries(p.project.sources ?? {})) {
    const file = path.join(p.dir, s.file);
    const out = { id, origin: s.introspect ? 'introspection' : s.origin ?? 'export', file: s.file, introspect: s.introspect ?? null, lock: p.lock.sources?.[id] ?? null, exists: await exists(file) };
    if (out.exists) {
      try {
        const doc = JSON.parse(await fs.readFile(file, 'utf8'));
        const elements = [...Object.values(doc.nodes ?? {}), ...Object.values(doc.relationships ?? {})];
        out.doc = { id: doc.id, name: doc.name, version: String(doc.version), nodes: Object.keys(doc.nodes ?? {}).length, relationships: Object.keys(doc.relationships ?? {}).length,
          described: elements.filter((e) => e.description).length, elements: elements.length,
          labels: Object.values(doc.nodes ?? {}).map((n) => n.labels?.identifier ?? n.label).filter(Boolean) };
      } catch (err) { out.error = err.message; }
    }
    sources.push(out);
  }
  const targets = [];
  for (const id of Object.keys(p.project.targets ?? {})) {
    const t = targetInfo(p, id);
    const out = { ...t, path: undefined, exists: await exists(t.path), lock: p.lock.targets?.[id] ?? null };
    if (out.exists) {
      try {
        const idx = indexTargets([{ namespace: t.namespace, text: await fs.readFile(t.path, 'utf8'), format: formatFromPath(t.file) ?? 'Turtle' }]);
        const terms = idx.terms();
        out.terms = { classes: terms.filter((x) => x.kind === 'class').length, properties: terms.filter((x) => x.kind !== 'class').length, sample: terms.filter((x) => x.kind === 'class').slice(0, 12).map((x) => shorten(x.iri, { [t.prefix]: t.namespace })) };
      } catch (err) { out.error = err.message; }
    }
    targets.push(out);
  }
  const live = n20s ? await n20s.list().catch(() => null) : null;
  const mappings = [];
  for (const [id, m] of Object.entries(p.project.mappings ?? {})) {
    const file = path.join(p.dir, m.file);
    const out = { id, source: m.source, targets: m.targets ?? [], file: m.file, recipes: m.recipes ?? null, spec: m.spec ?? null, exists: await exists(file) };
    if (out.exists) {
      try {
        const res = await checkFiles(file);
        const cov = res.coverage;
        const sum = (b) => ({ total: b.total, decided: ['mapped', 'ignored', 'deferred', 'subject', 'inherited'].reduce((n, k) => n + (b[k] ?? 0), 0), proposed: b.proposed ?? 0 });
        const parts = [cov.nodes, cov.nodeProperties, cov.relationships, cov.relationshipProperties].map(sum);
        out.check = { errors: res.summary.errors, warnings: res.summary.warnings, drift: res.findings.filter((f) => f.code.startsWith('drift.') && f.severity !== 'info').map((f) => f.message) };
        out.coverage = { total: parts.reduce((n, x) => n + x.total, 0), decided: parts.reduce((n, x) => n + x.decided, 0), proposed: parts.reduce((n, x) => n + x.proposed, 0) };
        out.lpg = res.lpg;
        const src = p.project.sources?.[m.source];
        out.sourceMatches = !!src && path.resolve(res.files.lpg) === path.resolve(p.dir, src.file);
      } catch (err) { out.error = err.message; }
    }
    out.specExists = m.spec ? await exists(path.join(p.dir, m.spec)) : false;
    if (m.recipes) {
      const dir = path.join(p.dir, m.recipes);
      let files = [];
      try { files = (await fs.readdir(dir)).filter((f) => /\.recipe\.ya?ml$/.test(f)); } catch { /* none */ }
      out.recipeCount = files.length;
      out.bench = await exists(path.join(dir, 'bench.yaml'));
      if (live) {
        const reg = await readRegistry(dir);
        out.endpoints = publicationStatuses(reg, graphStatuses(reg, live, {})).map((e) => ({ endpoint: e.endpoint, status: e.status === 'stable' || e.status === 'stale' ? 'served' : e.status }));
      }
    }
    mappings.push(out);
  }
  return { file: p.file, name: p.project.name ?? path.basename(p.dir), problems: checkProject(p.project), sources, targets, mappings, catalog: CATALOG };
}

/** The targets of a project with what the design conversation needs to know of them. */
export async function readTargetsSummary(projectFile) {
  const p = await readProject(projectFile);
  const out = [];
  for (const id of Object.keys(p.project.targets ?? {})) {
    const t = targetInfo(p, id);
    let sample = [];
    if (await exists(t.path)) {
      try {
        const idx = indexTargets([{ namespace: t.namespace, text: await fs.readFile(t.path, 'utf8'), format: formatFromPath(t.file) ?? 'Turtle' }]);
        sample = idx.terms().filter((x) => x.kind === 'class').slice(0, 15).map((x) => shorten(x.iri, { [t.prefix]: t.namespace }));
      } catch { /* reported in the Project tab */ }
    }
    out.push({ id, prefix: t.prefix, namespace: t.namespace, title: t.title, description: t.description, sample });
  }
  return out;
}

/**
 * Adds a target to a mapping of the project: to the project entry, and to the
 * mapping file (targets and prefix). A catalog target not in the project yet is
 * added to it and fetched.
 */
export async function addTargetToMapping(p, mappingId, targetId, { fetch = globalThis.fetch } = {}) {
  const m = p.project.mappings?.[mappingId];
  if (!m) throw new UsageError(`No mapping ${mappingId}.`);
  if (!p.project.targets?.[targetId]) {
    if (!catalogEntry(targetId)) throw new UsageError(`No target ${targetId}, in the project or the catalog.`);
    await addToProject(p, 'targets', targetId, { catalog: targetId });
    p = await readProject(p.file);
  }
  const t = targetInfo(p, targetId);
  if (!await exists(t.path)) {
    await fetchTarget(p, targetId, { fetch });
    p = await readProject(p.file);
  }
  const targets = [...new Set([...(m.targets ?? []), targetId])];
  const entry = p.doc.getIn(['mappings', mappingId, 'targets'], true);
  if (entry) { entry.items = []; for (const x of targets) entry.add(x); } else p.doc.setIn(['mappings', mappingId, 'targets'], p.doc.createNode(targets));
  await fs.writeFile(p.file, p.doc.toString({ lineWidth: 0 }));
  const mappingPath = path.join(p.dir, m.file);
  const mdoc = YAML.parseDocument(await fs.readFile(mappingPath, 'utf8'));
  const mapping = mdoc.toJS();
  if (!(mapping.targets ?? []).some((x) => x.namespace === t.namespace)) {
    const node = mdoc.createNode({ namespace: t.namespace, location: path.relative(path.dirname(mappingPath), t.path) });
    if (!mdoc.get('targets')) mdoc.set('targets', mdoc.createNode([]));
    mdoc.get('targets', true).add(node);
  }
  if (!mapping.prefixes?.[t.prefix]) mdoc.setIn(['prefixes', t.prefix], t.namespace);
  await fs.writeFile(mappingPath, mdoc.toString({ lineWidth: 0 }));
  return { mapping: mappingId, target: targetId };
}

/** Adds a source or a target to the project file (comments kept). */
export async function addToProject(p, section, id, value) {
  if (!['sources', 'targets'].includes(section)) throw new UsageError(`Unknown section ${section}.`);
  if (!NAME.test(id ?? '')) throw new UsageError('An id starts with a letter and has letters, digits, ., - and _ only.');
  if (p.project[section]?.[id]) throw new UsageError(`${section}/${id} exists.`);
  const problems = checkProject({ ...p.project, [section]: { ...p.project[section], [id]: value } }).filter((x) => x.startsWith(`${section}/${id}`));
  if (problems.length) throw new UsageError(problems.join(' '));
  if (!p.doc.get(section)) p.doc.set(section, p.doc.createNode({}));
  const n = p.doc.createNode(value);
  n.flow = true;
  p.doc.setIn([section, id], n);
  await fs.writeFile(p.file, p.doc.toString({ lineWidth: 0 }));
}
