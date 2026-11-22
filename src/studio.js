// The studio: a local web page to review proposals, served by the CLI.
// The mapping file stays the only state: every decision is written to it at
// once (YAML comments kept), and every request reads it again, so an edit made
// in a text editor shows up on reload.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.js';
import { loadFiles, variantsPathFor, loadRecipe, recordRecipeRun, graphsReport, publishedResolver, republish, unpublishEndpoint, specPathFor, chatPathFor, readSpec, writeSpec, readChat, appendChat, UsageError } from './node.js';
import { designTurn, decideItem, scopeOf, elementNames, specFindings, specCheckRequest, recipeDraftRequest, recipeFromDraft, draftProblems, compareAnswers } from './design.js';
import { decisionsText } from './propose.js';
import { CATALOG } from './catalog.js';
import { readTargetsSummary } from './workspace.js';
import { endpoints } from './endpoints.js';
import { readProject, projectStatus, introspectSource, fetchTarget, newMapping, addToProject, addTargetToMapping } from './workspace.js';
import { BENCH_FORMAT, checkBench } from './bench.js';
import { checkRecipe, recipeOutline, recipeKind, runRecipe, writesBack, RECIPE_FORMAT, STEP_TYPES, LIFECYCLES } from './recipe.js';
import YAML from 'yaml';
import { reviewItems, applyDecision, acceptSafe } from './review.js';
import { proposePasses, EXTRA_TERMS, acceptAll } from './propose.js';
import { compile } from './compile.js';
import { project } from './project.js';
import { runOracle, oracleEvidence } from './oracle.js';
import { shorten } from './iri.js';
import { qualifiedSubject } from './prepare.js';
import { openSource as openBolt } from './source.js';
import { sourceValues, readRegistry, writerFromEnv, writePatchFiles, freshnessOf } from './node.js';
import { resolveWrite } from './writeback.js';
import { n20sClient } from './n20s.js';
import { makeProvider, listModels } from './providers.js';
import { envFileRisk, writeEnvFile } from './settings.js';
import { cdcStatus, startFollowing, stopFollowing, follower } from './follow.js';

const STATIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../studio');
const FILES = {
  '/': ['index.html', 'text/html'], '/recipes': ['index.html', 'text/html'], '/bench': ['index.html', 'text/html'], '/project': ['index.html', 'text/html'], '/design': ['index.html', 'text/html'], '/connections': ['index.html', 'text/html'], '/connections-tab.js': ['connections-tab.js', 'text/javascript'],
  '/app.js': ['app.js', 'text/javascript'], '/dom.js': ['dom.js', 'text/javascript'], '/recipes.js': ['recipes.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'], '/bench-tab.js': ['bench-tab.js', 'text/javascript'], '/project-tab.js': ['project-tab.js', 'text/javascript'], '/design-tab.js': ['design-tab.js', 'text/javascript'],
  // The bench engine is the one the CLI uses.
  '/bench.js': ['../src/bench.js', 'text/javascript'],
};
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const DATATYPES = ['string', 'boolean', 'integer', 'long', 'int', 'decimal', 'double', 'float', 'date', 'dateTime', 'dateTimeStamp', 'time', 'duration', 'anyURI'];

/** Classes and properties of the targets, as the edit forms offer them. */
function catalogOf(targets, prefixes) {
  const curie = (iri) => shorten(iri, prefixes);
  const terms = [...(targets?.terms() ?? []), ...EXTRA_TERMS].map((t) => ({
    curie: curie(t.iri), iri: t.iri, kind: t.kind, label: t.label,
    text: [t.definition, t.comment].filter(Boolean).join(' '),
    domains: (t.domains ?? []).map(curie), ranges: (t.ranges ?? []).map(curie), parents: (t.parents ?? []).map(curie),
  }));
  return { terms, datatypes: DATATYPES.map((d) => curie(XSD + d)) };
}

/** The prefix generated IRIs use: the one of the root subjects. */
function inferPrefix(mapping) {
  for (const e of Object.values(mapping.nodes ?? {})) {
    const m = /^([A-Za-z][\w-]*):/.exec(e?.subject ?? '');
    if (m) return m[1];
  }
  return null;
}

/** Step fields the page edits, and how a value from the page becomes the value in the file (undefined removes the field). */
const text = (v) => (v === null || v === undefined || String(v).trim() === '' ? undefined : String(v));
const structured = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return undefined;
  if (typeof v === 'object') return v;
  try { return YAML.parse(String(v)); } catch (err) { throw new UsageError(`Not YAML or JSON: ${err.message}`); }
};
const STEP_FIELDS = {
  title: text, cypher: text, sparql: text, rules: text, turtle: text, profile: text, s: text, p: text, o: text, graph: text,
  as: text, description: text, from: text, retract: text,
  label: structured, relationship: structured, property: structured,
  gate: (v) => { const l = (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/)).map((x) => String(x).trim()).filter(Boolean); return l.length ? l : undefined; },
  decode: structured, params: structured, template: structured,
  files: (v) => { const l = (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => String(x).trim()).filter(Boolean); return l.length ? l : undefined; },
};

/** A YAML node for a value; multi-line strings as literal blocks. */
function node(doc, v) {
  const n = doc.createNode(v);
  const blocks = (x) => {
    if (YAML.isScalar(x) && typeof x.value === 'string' && x.value.includes('\n')) x.type = 'BLOCK_LITERAL';
    if (YAML.isMap(x) || YAML.isSeq(x)) for (const it of x.items) blocks(YAML.isPair(it) ? it.value : it);
  };
  blocks(n);
  return n;
}

function indexOf(steps, id) {
  const i = steps.findIndex((x) => x.id === id);
  if (i < 0) throw new UsageError(`No step ${id}.`);
  return i;
}
const nextId = (steps, type) => { let n = 1; while (steps.some((x) => x.id === `${type}-${n}`)) n++; return `${type}-${n}`; };

/** A step to start from, written for the mapping of the recipe. */
function skeleton(type, f) {
  const nodes = Object.entries(f.lpgDoc.nodes ?? {});
  const [nid, n] = nodes.find(([id]) => f.mapping.nodes?.[id]?.subject) ?? nodes[0] ?? ['n', {}];
  const label = n.labels?.identifier ?? n.label ?? 'Label';
  const prefix = Object.keys(f.mapping.prefixes ?? {}).find((p) => /^https?:/.test(f.mapping.prefixes[p]) && !/w3\.org/.test(f.mapping.prefixes[p])) ?? 'ex';
  switch (type) {
    case 'scope': return { title: `${label} nodes and their neighbours`, cypher: `MATCH p = (n:${label})-[*0..1]-()\nRETURN p\nLIMIT 25\n` };
    case 'rows': return { title: 'Computed rows', cypher: `MATCH (n:${label})\nRETURN {id: n.id} AS row\n`, template: { subject: `${prefix}:thing/{id}`, triples: [] } };
    case 'triples': return { title: 'Static triples', turtle: '# Turtle. The prefixes of the mapping and of the recipe are declared.\n' };
    case 'infer': return { title: 'Inference', profile: 'RDFS' };
    case 'query': return { title: 'Question', sparql: 'SELECT ?s ?p ?o WHERE {\n  ?s ?p ?o\n}\nLIMIT 25\n', decode: { s: 'any' } };
    case 'construct': return { title: 'Derived triples', sparql: 'CONSTRUCT { ?s ?p ?o } WHERE {\n  ?s ?p ?o\n}\nLIMIT 10\n' };
    case 'update': return { title: 'Change the window', sparql: 'DELETE WHERE { ?s <urn:example:nothing> ?o }\n' };
    case 'validate': return { title: 'SHACL validation' };
    case 'explain': return { title: 'Why', s: `{{${nid}|value}}`, p: 'rdf:type', o: 'prov:Entity', profile: 'RDFS' };
    case 'publish': {
      const g = Object.entries(f.recipe.graphs ?? {}).find(([, x]) => x?.lifecycle === 'persistent');
      const gates = (f.recipe.steps ?? []).filter((x) => x.type === 'validate').map((x) => x.id);
      return { title: 'Serve it as a SPARQL endpoint', ...(g ? { graph: g[0] } : {}), as: g?.[1]?.name ?? 'endpoint', ...(gates.length ? { gate: gates } : {}) };
    }
    case 'write': {
      // The last query before it, and its first node column.
      const q = [...(f.recipe.steps ?? [])].reverse().find((x) => x.type === 'query');
      const col = Object.entries(q?.decode ?? {}).find(([, d]) => String(d).startsWith('node:'))?.[0] ?? 'node';
      return { title: 'Write back what the query found', ...(q ? { from: q.id } : {}), label: { node: col, add: 'Inferred' } };
    }
    default: return {};
  }
}

/**
 * @param {object} o
 * @param {string} [o.mappingFile]       the mapping to open, or:
 * @param {string} [o.projectFile]       a project (n20s-project.yaml): its mappings can be switched in the Project tab
 * @param {string} [o.mappingId]         the mapping of the project to open first
 * @param {string} [o.lpg]
 * @param {number} [o.port=4321]   0 picks a free port
 * @param {string} o.reviewer      written to meta.reviewedBy
 * @param {string} [o.oracleFile]
 * @param {() => object} [o.openSource]  for the oracle
 * @param {object} [o.n20s]               n20sClient, for the oracle
 * @param {() => object} [o.provider]     for proposing again; null disables it
 * @param {(q: object) => Promise<string[]|null>} [o.valuesOf]
 * @param {string} [o.prefix]
 * @param {string} [o.recipesDir]         recipes (*.recipe.yaml) shown in the Recipes tab; default <mapping dir>/recipes
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
/** Targets the conversation can talk about: the mapping's (or the project's) and the catalog's. */
async function designTargetsOf(l, projectFile) {
  const out = [];
  if (projectFile) {
    for (const t of await readTargetsSummary(projectFile)) out.push({ ...t, inProject: true });
  } else {
    for (const t of l.mapping.targets ?? []) {
      const prefix = Object.entries(l.mapping.prefixes ?? {}).find(([, ns]) => ns === t.namespace)?.[0] ?? t.namespace;
      out.push({ id: prefix, prefix, namespace: t.namespace, title: t.namespace, inProject: true });
    }
  }
  for (const c of CATALOG) if (!out.some((t) => t.namespace === c.namespace)) out.push({ id: c.id, prefix: c.prefix, namespace: c.namespace, title: c.title, description: c.description, inProject: false });
  return out;
}

export async function startStudio({ mappingFile = null, projectFile = null, mappingId = null, lpg, port = 4321, reviewer, oracleFile = null, openSource = null, n20s = null, provider = null, valuesOf = null, prefix = null, recipesDir = null, settings = null, followIntervalMs = 1500, title = 'n20s-mapping studio' }) {
  // With settings (the CLI), the connections come from them and the Connections tab changes them.
  function applySettings() {
    if (!settings) return;
    const neo = settings.neo4j;
    // Read-only: recipes, the oracle and introspection only read. Write-back has its own connection (writerFromEnv).
    const openOne = (u) => (u && u !== neo?.url ? openBolt(u, { readOnly: true }) : openBolt(neo.url, { user: neo.user ?? undefined, password: neo.password ?? undefined, database: neo.database ?? undefined, readOnly: true }));
    openSource = neo ? openOne : null;
    valuesOf = neo ? async (...a) => { const src = openOne(); try { return await sourceValues(src)(...a); } finally { await src.close(); } } : null;
    provider = settings.fixedProvider ? () => settings.fixedProvider
      : settings.ai ? () => (settings.wrapProvider ?? ((x) => x))(makeProvider(settings.ai)) : null;
    n20s = n20sClient(settings.n20sUrl ?? undefined);
  }
  applySettings();
  // Write-back goes through its own connection (N20S_WRITE_USER, N20S_WRITE_PASSWORD), when the environment has one:
  // a followed or re-published publication whose recipe writes back rebuilds through it.
  const writerOpener = () => (process.env.N20S_WRITE_USER ? () => writerFromEnv(settings?.neo4j?.url ?? null) : null);
  /** Saves the current settings of one kind to the env file, if git would not commit it. */
  async function saveSettings(which) {
    if (!settings.envFile) throw new UsageError('No env file to save to (--dotenv).');
    const risk = await envFileRisk(settings.envFile);
    if (risk) throw new UsageError(`Not saved: ${risk}`);
    const updates = settings.envUpdates(which);
    await writeEnvFile(settings.envFile, updates);
    for (const [k, v] of Object.entries(updates)) { if (v === null || v === undefined) delete process.env[k]; else process.env[k] = String(v); }
  }
  async function settingsView() {
    let n20sStatus;
    try { n20sStatus = { ok: true, ...(await n20s.version()) }; } catch (err) { n20sStatus = { ok: false, error: err.message }; }
    const shown = settings.describe();
    const risk = settings.envFile ? await envFileRisk(settings.envFile) : null;
    return { ...shown, n20s: { url: n20s.url, ...n20sStatus }, envRisk: risk ? risk.replaceAll(settings.envFile, shown.envFile) : null };
  }

  let variantsFile;
  let recipeDir;
  let specFile;
  let active = null;
  const oracleOption = oracleFile;
  const designTargets = (l) => designTargetsOf(l, projectFile);
  /** What the last oracle run said about each relationship decision, next to the mapping: the review gates "safe" on it. */
  const oracleEvidencePath = () => mappingFile.replace(/(\.mapping)?\.(ya?ml|json)$/i, '') + '.oracle.json';
  const specCheckPath = () => specFile.replace(/\.spec\.ya?ml$/i, '') + '.spec-check.json';
  /** The last check of the mapping against the spec, as review reasons. */
  async function aiSpecFindings() {
    try {
      const c = JSON.parse(await fs.readFile(specCheckPath(), 'utf8'));
      return c.findings.map((f) => ({ path: f.path, message: `${f.severity === 'high' ? 'Against the spec' : 'Check against the spec'}: ${f.problem}${f.rule ? ` (${f.rule})` : ''}` }));
    } catch { return []; }
  }
  /** The prefix of the base IRI a new mapping declares: the one that is no target and no standard vocabulary. */
  const baseOf = (mapping) => Object.entries(mapping.prefixes ?? {}).find(([p, ns]) => !['xsd', 'rdfs', 'rdf', 'owl'].includes(p) && !(mapping.targets ?? []).some((t) => t.namespace === ns))?.[0] ?? null;
  /** Opens a mapping of the project: the Mapping, Recipes and Bench tabs then work on it. */
  async function activate(id) {
    const p = await readProject(projectFile);
    const m = p.project.mappings?.[id];
    if (!m) throw new UsageError(`No mapping ${id} in ${projectFile}.`);
    mappingFile = path.join(p.dir, m.file);
    recipeDir = m.recipes ? path.join(p.dir, m.recipes) : path.join(path.dirname(mappingFile), 'recipes');
    variantsFile = variantsPathFor(mappingFile);
    specFile = m.spec ? path.join(p.dir, m.spec) : specPathFor(mappingFile);
    // An oracle may come with the mapping in the project; --oracle otherwise.
    oracleFile = m.oracle ? path.join(p.dir, m.oracle) : oracleOption;
    active = id;
  }
  if (projectFile) {
    const p = await readProject(projectFile);
    const first = mappingId ?? Object.keys(p.project.mappings ?? {})[0];
    if (!first) throw new UsageError(`${projectFile} has no mapping yet: add one in the Project tab, or start the studio on a mapping file.`);
    await activate(first);
  } else {
    variantsFile = variantsPathFor(mappingFile);
    recipeDir = recipesDir ?? path.join(path.dirname(mappingFile), 'recipes');
    specFile = specPathFor(mappingFile);
  }
  /** A recipe file of the recipes directory, by its name only. */
  const recipePath = (file) => {
    if (typeof file !== 'string' || !/^[\w.-]+\.recipe\.ya?ml$/.test(file)) throw new UsageError(`Not a recipe file name: ${file}`);
    return path.join(recipeDir, file);
  };
  /** Reads a recipe file as a YAML document, lets fn change it, writes it back, returns the recipe as the page sees it. */
  async function editRecipe(file, fn) {
    const p = recipePath(file);
    const doc = YAML.parseDocument(await fs.readFile(p, 'utf8'));
    await fn(doc, doc.toJS()?.steps ?? []);
    await fs.writeFile(p, doc.toString({ lineWidth: 0 }));
    return routes['POST /api/recipe']({ file });
  }

  async function state() {
    const l = await loadFiles(mappingFile, { lpg });
    const result = await check({ mapping: l.mapping, lpgDoc: l.lpgDoc, targets: l.targets, targetStatus: l.targetStatus, artifactInfo: l.artifactInfo, lock: l.lockData });
    let variants = null;
    try { variants = JSON.parse(await fs.readFile(variantsFile, 'utf8')); } catch { /* no passes recorded */ }
    let oracle = null;
    try { oracle = JSON.parse(await fs.readFile(oracleEvidencePath(), 'utf8')); } catch { /* the oracle has not run */ }
    const spec = await readSpec(specFile, l.mapping.id);
    const items = reviewItems({ mapping: l.mapping, lpgDoc: l.lpgDoc, result, variants, oracle, specFindings: [...specFindings(spec, l.mapping, l.lpgDoc), ...await aiSpecFindings(l)] });
    return { l, result, variants, items, spec };
  }

  async function save(l, mapping, keys) {
    if (l.m.kind === 'yaml') {
      for (const key of keys) {
        const [section, id] = key.split('/');
        if (mapping[section]?.[id] === undefined) l.m.doc.deleteIn([section, id]);
        else l.m.doc.setIn([section, id], l.m.doc.createNode(mapping[section][id]));
      }
      await fs.writeFile(mappingFile, l.m.doc.toString({ lineWidth: 0 }));
    } else {
      await fs.writeFile(mappingFile, JSON.stringify(mapping, null, 2) + '\n');
    }
  }

  async function view() {
    const s = await state();
    return {
      title,
      file: mappingFile,
      project: projectFile ? { file: projectFile, mapping: active } : null,
      reviewer,
      mapping: s.l.mapping,
      lpg: s.l.lpgDoc,
      check: { summary: s.result.summary, findings: s.result.findings, coverage: s.result.coverage },
      items: s.items,
      variants: s.variants,
      catalog: catalogOf(s.l.targets, s.l.mapping.prefixes ?? {}),
      can: { oracle: !!(oracleFile && openSource && n20s), propose: !!provider, recipes: !!(openSource && n20s) },
    };
  }

  const routes = {
    'GET /api/state': () => view(),

    // Connections: Neo4j, the AI provider, n20s-server. Passwords and keys are never sent back.
    'GET /api/settings': () => {
      if (!settings) throw new UsageError('Connections are set by the program that started the studio.');
      return settingsView();
    },
    'POST /api/settings/neo4j': async ({ url, user, password, database, save }) => {
      const next = settings.neo4jFrom({ url, user, password, database });
      const src = openBolt(next.url, { user: next.user ?? undefined, password: next.password ?? undefined, database: next.database ?? undefined });
      let agent;
      let nodes;
      try {
        agent = await src.agent();
        [{ nodes }] = await src.run('MATCH (n) RETURN count(n) AS nodes');
      } catch (err) {
        throw new UsageError(`Cannot connect to ${next.url}: ${err.message.split('\n')[0]}`);
      } finally {
        await src.close();
      }
      settings.setNeo4j(next, { agent, nodes });
      applySettings();
      if (save) await saveSettings('neo4j');
      return { ...(await settingsView()), checked: { agent, nodes, saved: !!save } };
    },
    'POST /api/settings/ai/models': async ({ provider: id, apiKey, baseUrl }) => {
      const cfg = settings.aiFrom({ provider: id, apiKey, baseUrl });
      try {
        return { models: await listModels(cfg) };
      } catch (err) {
        throw new UsageError(`Cannot list the models: ${err.message}`);
      }
    },
    'POST /api/settings/ai': async ({ provider: id, apiKey, model, baseUrl, save, test }) => {
      const cfg = settings.aiFrom({ provider: id, apiKey, model, baseUrl });
      let checked = { models: null };
      try {
        checked.models = (await listModels(cfg)).length;
      } catch (err) {
        throw new UsageError(`The key or the address is not accepted: ${err.message}`);
      }
      if (test) {
        const t0 = Date.now();
        try {
          const res = await makeProvider(cfg).complete({ system: 'You check that a connection works.', user: 'Answer with ok: true.', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, maxOutputTokens: 256 });
          checked = { ...checked, answered: res.json?.ok === true, ms: Date.now() - t0, model: res.model, usage: res.usage };
        } catch (err) {
          throw new UsageError(`${cfg.model} did not answer: ${err.message}`);
        }
      }
      settings.setAi(cfg, checked);
      applySettings();
      if (save) await saveSettings('ai');
      return { ...(await settingsView()), checked: { ...checked, saved: !!save } };
    },
    'POST /api/settings/n20s': async ({ url, save }) => {
      const client = n20sClient(url || undefined);
      let version;
      try { version = await client.version(); } catch (err) { throw new UsageError(`No n20s-server at ${client.url}: ${err.message}`); }
      settings.n20sUrl = client.url;
      applySettings();
      if (save) {
        if (!settings.envFile) throw new UsageError('No env file to save to (--dotenv).');
        await writeEnvFile(settings.envFile, { N20S_URL: client.url });
        process.env.N20S_URL = client.url;
      }
      return { ...(await settingsView()), checked: { version, saved: !!save } };
    },


    'POST /api/decide': async (body) => {
      const s = await state();
      const [section, id, , pid] = (body.path ?? '').split('/');
      // An edited qualified pattern without a subject gets the generated one.
      if (body.action === 'edit' && section === 'relationships' && !pid && body.entry?.qualified && !body.entry.qualified.subject) {
        const pfx = prefix ?? inferPrefix(s.l.mapping);
        if (!pfx) throw new UsageError('No prefix for generated IRIs: start the studio with --prefix.');
        body.entry.qualified = { subject: qualifiedSubject(s.l.mapping, s.l.lpgDoc, id, body.entry.qualified.class, { prefix: pfx }), ...body.entry.qualified };
      }
      const mapping = applyDecision(s.l.mapping, { ...body, reviewer });
      await save(s.l, mapping, [body.path.split('/').slice(0, 2).join('/')]);
      return view();
    },

    'POST /api/accept-safe': async () => {
      const s = await state();
      const mapping = acceptSafe(s.l.mapping, s.items, { reviewer, at: new Date().toISOString() });
      await save(s.l, mapping, s.items.filter((i) => i.safe).map((i) => i.key));
      return view();
    },

    // Proposes an element again: its proposed entries are rejected with the comment first, so the model sees why.
    'POST /api/propose': async ({ key, comment }) => {
      if (!provider) throw new UsageError('Proposing needs a model: choose one in the Connections tab.');
      const s = await state();
      let mapping = s.l.mapping;
      const item = s.items.find((i) => i.key === key);
      if (!item) throw new UsageError(`No element ${key}.`);
      for (const p of item.proposed) mapping = applyDecision(mapping, { path: p, action: 'reject', reviewer, comment });
      const pfx = prefix ?? inferPrefix(mapping);
      if (!pfx) throw new UsageError('No prefix for generated IRIs: start the studio with --prefix.');
      const res = await proposePasses({ mapping, lpgDoc: s.l.lpgDoc, targets: s.l.targets, provider: provider(), prefix: pfx, valuesOf, only: [key], spec: s.spec });
      await save(s.l, res.mapping, [key]);
      return { ...(await view()), log: { calls: res.calls.length, repaired: res.repaired.map((r) => r.element), dropped: res.dropped, notes: res.notes.filter((n) => n.path.startsWith(key)) } };
    },

    'GET /api/recipes': async () => {
      let files = [];
      try { files = (await fs.readdir(recipeDir)).filter((f) => /\.recipe\.ya?ml$/.test(f)).sort(); } catch { /* no recipes yet */ }
      const out = [];
      for (const file of files) {
        try {
          const recipe = YAML.parse(await fs.readFile(path.join(recipeDir, file), 'utf8'));
          const graphs = Object.values(recipe.graphs ?? {});
          out.push({ file, id: recipe.id, title: recipe.title ?? recipe.id, steps: recipe.steps?.length ?? 0, persistent: graphs.filter((g) => g?.lifecycle === 'persistent').map((g) => g.name), kind: recipeKind(recipe), api: recipe.api?.name ?? null, writes: writesBack(recipe) });
        } catch (err) {
          out.push({ file, error: err.message });
        }
      }
      return { dir: recipeDir, recipes: out, can: !!(openSource && n20s) };
    },

    'POST /api/recipe': async ({ file }) => {
      const f = await loadRecipe(recipePath(file));
      return { file, recipe: f.recipe, outline: recipeOutline(f.recipe), findings: checkRecipe(f.recipe, { mapping: f.mapping, lpgDoc: f.lpgDoc }), problems: f.problems, mapping: path.relative(recipeDir, f.mappingFile) };
    },

    'POST /api/recipe/new': async ({ id, title }) => {
      const fid = String(id ?? '').trim();
      if (!/^[A-Za-z][\w-]*$/.test(fid)) throw new UsageError('A recipe id starts with a letter and has letters, digits, - and _ only.');
      const file = `${fid}.recipe.yaml`;
      const p = recipePath(file);
      try { await fs.access(p); throw new UsageError(`${file} exists already.`); } catch (err) { if (err instanceof UsageError) throw err; }
      await fs.mkdir(recipeDir, { recursive: true });
      const doc = new YAML.Document({
        format: RECIPE_FORMAT, id: fid, title: title || fid,
        mapping: path.relative(recipeDir, mappingFile), graphs: { work: { lifecycle: 'ephemeral' } }, params: {}, steps: [],
      });
      doc.commentBefore = ' Created in the studio.';
      await fs.writeFile(p, doc.toString({ lineWidth: 0 }));
      return { ...(await routes['GET /api/recipes']()), created: file };
    },

    // Edits one field of one step; the rest of the file, comments included, is kept.
    'POST /api/recipe/step': async ({ file, step, field, value }) => {
      if (!STEP_FIELDS[field]) throw new UsageError(`Field ${field} cannot be edited here.`);
      return editRecipe(file, (doc, steps) => {
        const i = indexOf(steps, step);
        const v = STEP_FIELDS[field](value);
        if (v === undefined) doc.deleteIn(['steps', i, field]);
        else doc.setIn(['steps', i, field], node(doc, v));
      });
    },

    'POST /api/recipe/step/add': async ({ file, after = null, type, id }) => {
      if (!STEP_TYPES.includes(type)) throw new UsageError(`Unknown step type ${type}.`);
      const f = await loadRecipe(recipePath(file));
      return editRecipe(file, (doc, steps) => {
        const sid = String(id ?? '').trim() || nextId(steps, type);
        if (!/^[A-Za-z][\w-]*$/.test(sid)) throw new UsageError('A step id starts with a letter and has letters, digits, - and _ only.');
        if (steps.some((x) => x.id === sid)) throw new UsageError(`Step id ${sid} is used already.`);
        const at = after ? indexOf(steps, after) + 1 : steps.length;
        const seq = doc.get('steps', true) ?? doc.createNode([]);
        seq.flow = false;
        seq.items.splice(at, 0, node(doc, { id: sid, type, ...skeleton(type, f) }));
        doc.set('steps', seq);
      });
    },

    'POST /api/recipe/step/delete': async ({ file, step }) => editRecipe(file, (doc, steps) => {
      doc.get('steps', true).items.splice(indexOf(steps, step), 1);
    }),

    'POST /api/recipe/step/move': async ({ file, step, delta }) => editRecipe(file, (doc, steps) => {
      const i = indexOf(steps, step);
      const j = i + (delta < 0 ? -1 : 1);
      if (j < 0 || j >= steps.length) return;
      const items = doc.get('steps', true).items;
      [items[i], items[j]] = [items[j], items[i]];
    }),

    'POST /api/recipe/param': async ({ file, name, value, description, remove = false }) => editRecipe(file, (doc) => {
      if (!/^[A-Za-z_]\w*$/.test(String(name ?? ''))) throw new UsageError('A parameter name has letters, digits and _ only, and does not start with a digit.');
      if (remove) { doc.deleteIn(['params', name]); return; }
      if (!doc.get('params')) doc.set('params', doc.createNode({}));
      doc.get('params', true).flow = false;
      doc.setIn(['params', name], doc.createNode({ default: value ?? '', ...(description ? { description } : {}) }));
    }),

    // Declares, changes or removes a graph of the recipe.
    'POST /api/recipe/graph': async ({ file, key, lifecycle = 'ephemeral', name, start, versioned = false, endpoint, sparql, user, password, remove = false }) => editRecipe(file, (doc, steps) => {
      if (!/^[A-Za-z][\w-]*$/.test(String(key ?? ''))) throw new UsageError('A graph key starts with a letter and has letters, digits, - and _ only.');
      if (remove) {
        const users = steps.filter((x) => (x.graph ?? null) === key).map((x) => x.id);
        if (users.length) throw new UsageError(`Steps ${users.join(', ')} use graph ${key}.`);
        doc.deleteIn(['graphs', key]);
        return;
      }
      if (!LIFECYCLES.includes(lifecycle)) throw new UsageError(`Unknown lifecycle ${lifecycle}.`);
      // The first graph declared next to the implicit one keeps it: steps without a graph stay on work.
      const declared = doc.toJS()?.graphs ?? {};
      if (!Object.keys(declared).length && key !== 'work') {
        doc.set('graphs', doc.createNode({}));
        const w = doc.createNode({ lifecycle: 'ephemeral' });
        w.flow = true;
        doc.setIn(['graphs', 'work'], w);
      }
      if (!doc.get('graphs')) doc.set('graphs', doc.createNode({}));
      const g = lifecycle === 'persistent' ? (versioned ? { name, lifecycle, versioned: true } : { name, lifecycle, start: start ?? 'reuse' })
        : lifecycle === 'published' ? { lifecycle, endpoint }
        // A remote store: its URL, and the names of the environment variables that hold its credentials.
        : lifecycle === 'remote' ? { lifecycle, sparql, ...(user ? { user } : {}), ...(password ? { password } : {}) } : { lifecycle };
      const n = doc.createNode(g);
      n.flow = true;
      doc.setIn(['graphs', key], n);
    }),

    // Declares (or removes) the query API of a recipe: served as /query/<name>, run on each call.
    'POST /api/recipe/api': async ({ file, name, result, description, remove = false }) => editRecipe(file, (doc) => {
      if (remove) { doc.delete('api'); return; }
      if (!/^[A-Za-z][\w.-]*$/.test(String(name ?? ''))) throw new UsageError('An api name starts with a letter and has letters, digits, ., - and _ only.');
      doc.set('api', doc.createNode({ name, ...(result ? { result } : {}), ...(description ? { description } : {}) }));
    }),

    'POST /api/recipe/run': async ({ file, params = {}, keep = false, confirmWrite = false }) => {
      if (!openSource || !n20s) throw new UsageError('Running a recipe needs a source (--source) and n20s-server (--n20s).');
      const f = await loadRecipe(recipePath(file));
      // A recipe that writes back runs only once the person confirmed what it writes.
      const writes = f.recipe.steps.filter((x) => x.type === 'write').map((x) => ({ step: x.id, ...(resolveWrite(f.recipe, x, { lpgDoc: f.lpgDoc, mapping: f.mapping }).target ?? {}) }))
        .map((w) => ({ step: w.step, owner: w.owner, kind: w.kind, name: w.name, on: w.on, retract: w.retract ?? null }));
      if (writes.length && !confirmWrite) return { confirm: { writes } };
      let writer = null;
      if (writes.length) {
        try { writer = writerFromEnv(settings?.neo4j?.url ?? null); } catch (err) { throw new UsageError(`${err.message} Set them in the env file (--dotenv) and restart the studio.`); }
      }
      const source = openSource();
      try {
        const run = await runRecipe({ ...f, params, source, n20s, keep, inspect: true, resolvePublished: publishedResolver(recipeDir), writer, allowWrite: !!writer, freshness: freshnessOf(recipeDir, n20s) });
        const recorded = await recordRecipeRun(recipePath(file), run, f, { source: { url: source.url }, n20s });
        return { ...run, recorded };
      } finally {
        await source.close();
        await writer?.close();
      }
    },

    // What the LPG ontology must declare for the recipes that write back: shown, applied to the export file, to re-apply in Aura.
    'POST /api/ontology-patch': async ({ apply = false } = {}) => {
      const patches = await writePatchFiles(recipeDir, { apply });
      return { patches: patches.map((p) => ({ lpgFile: path.relative(path.dirname(mappingFile), p.lpgFile), recipes: p.recipes, changes: p.changes, applied: p.applied, script: p.script })) };
    },

    // The graphs of n20s-server and of the registry, with their status.
    'GET /api/graphs': async () => {
      if (!n20s) return { graphs: [], endpoints: [], can: false };
      const report = await graphsReport(recipeDir, n20s);
      // Not built here does not mean unknown: the oracle's projection, or the recipes of another mapping of the project.
      await refreshFollowDirs();
      const elsewhere = new Map();
      for (const [dir, id] of followOwners) {
        if (dir === recipeDir) continue;
        try { for (const name of Object.keys((await readRegistry(dir)).graphs ?? {})) elsewhere.set(name, id); } catch { /* no registry */ }
      }
      for (const g of report) {
        if (g.status !== 'unknown') continue;
        if (/^studio-(accepted|proposals)$/.test(g.name)) Object.assign(g, { status: 'other', reasons: ['the projection of the last oracle run'] });
        else if (elsewhere.has(g.name)) Object.assign(g, { status: 'other', reasons: [`built by the recipes of mapping ${elsewhere.get(g.name)}`] });
      }
      return { graphs: report, endpoints: report.endpoints, can: true };
    },

    'POST /api/graphs/drop': async ({ name }) => {
      if (!n20s) throw new UsageError('No n20s-server (--n20s).');
      if (typeof name !== 'string' || !/^[\w.-]+$/.test(name)) throw new UsageError(`Not a graph name: ${name}`);
      const report = await graphsReport(recipeDir, n20s);
      const serving = report.endpoints.filter((e) => e.graph === name).map((e) => e.endpoint);
      if (serving.length) throw new UsageError(`${name} is published as ${serving.join(', ')}: unpublish first.`);
      await n20s.drop(name);
      return routes['GET /api/graphs']();
    },

    'POST /api/graphs/republish': async ({ endpoint }) => {
      if (!openSource || !n20s) throw new UsageError('Re-publishing needs a source (--source) and n20s-server (--n20s).');
      const source = openSource();
      // A publication whose recipe writes back was confirmed when it was published; it re-publishes through the write connection.
      const open = writerOpener();
      const writer = open ? open() : null;
      try {
        const { run } = await republish(recipeDir, endpoint, { source, n20s, writer, allowWrite: !!writer });
        return { ...(await routes['GET /api/graphs']()), run: { ok: run.ok, ms: run.ms, error: run.steps.find((s) => s.status === 'error')?.error ?? null, graph: run.publications.find((p) => p.as === endpoint)?.graph ?? null } };
      } finally {
        await source.close();
        await writer?.close();
      }
    },

    // Change Data Capture: a publication can follow the database only when CDC is on, in FULL mode.
    'GET /api/cdc': async () => {
      if (!openSource) return { mode: 'unknown', available: false, message: 'No database connected (Connections tab).' };
      const source = openSource();
      try { return await cdcStatus(source); } finally { await source.close(); }
    },
    'POST /api/graphs/follow': async ({ endpoint, on }) => {
      await refreshFollowDirs();
      if (on) {
        if (!openSource) throw new UsageError('No database connected (Connections tab).');
        const source = openSource();
        try { await startFollowing(recipeDir, endpoint, source); } finally { await source.close(); }
      } else {
        await stopFollowing(recipeDir, endpoint);
      }
      return routes['GET /api/graphs']();
    },

    'POST /api/graphs/unpublish': async ({ endpoint }) => {
      if (!n20s) throw new UsageError('No n20s-server (--n20s).');
      await unpublishEndpoint(recipeDir, endpoint, { n20s });
      return routes['GET /api/graphs']();
    },

    // The studio's own console asks any graph a recipe built, published or not.
    'POST /api/graphs/query': async ({ name, sparql }) => {
      if (!n20s) throw new UsageError('No n20s-server (--n20s).');
      const report = await graphsReport(recipeDir, n20s);
      if (!report.some((g) => g.name === name && g.triples !== null)) throw new UsageError(`No graph ${name} in n20s-server.`);
      return { rows: await n20s.query(name, sparql) };
    },

    // The bench collection (bench.yaml next to the recipes) and what it can target.
    'GET /api/bench': async () => {
      const file = path.join(recipeDir, 'bench.yaml');
      let bench = { format: BENCH_FORMAT, requests: [] };
      try { bench = YAML.parse(await fs.readFile(file, 'utf8')) ?? bench; } catch (err) { if (err.code !== 'ENOENT') throw new UsageError(`Cannot read ${file}: ${err.message}`); }
      const recipes = (await routes['GET /api/recipes']()).recipes;
      const apis = [];
      const drafts = [];
      for (const r of recipes) {
        let params = {};
        try { params = (await loadRecipe(recipePath(r.file))).recipe.params ?? {}; } catch { continue; /* broken recipes show in the Recipes tab */ }
        if (r.api) apis.push({ name: r.api, recipe: r.id, kind: r.kind, params });
        drafts.push({ id: r.id, kind: r.kind, title: r.title, params });
      }
      const published = n20s ? (await graphsReport(recipeDir, n20s)).endpoints.map((e) => ({ name: e.endpoint, status: e.status })) : [];
      const rel = path.relative(process.cwd(), file);
      return { file: rel.startsWith('..') ? file : rel, bench, problems: checkBench(bench), targets: { apis, endpoints: published, recipes: drafts }, can: !!(openSource && n20s) };
    },

    // Adds or replaces a request (by id; previous renames it); comments of the file are kept.
    'POST /api/bench/save': async ({ request, previous = null }) => {
      const file = path.join(recipeDir, 'bench.yaml');
      let doc;
      try { doc = YAML.parseDocument(await fs.readFile(file, 'utf8')); } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        doc = new YAML.Document({ format: BENCH_FORMAT, requests: [] });
      }
      const all = doc.toJS()?.requests ?? [];
      const at = all.findIndex((r) => r.id === (previous ?? request?.id));
      const next = [...all];
      if (at >= 0) next[at] = request; else next.push(request);
      const problems = checkBench({ format: BENCH_FORMAT, requests: next });
      if (problems.length) throw new UsageError(problems.join(' '));
      if (!doc.get('requests')) doc.set('requests', doc.createNode([]));
      const seq = doc.get('requests', true);
      seq.flow = false;
      const n = doc.createNode(request);
      for (const k of ['target', 'params', 'expect']) { const x = n.get(k, true); if (x) x.flow = true; }
      if (at >= 0) seq.items[at] = n; else seq.items.push(n);
      await fs.writeFile(file, doc.toString({ lineWidth: 0 }));
      return routes['GET /api/bench']();
    },

    'POST /api/bench/delete': async ({ id }) => {
      const file = path.join(recipeDir, 'bench.yaml');
      const doc = YAML.parseDocument(await fs.readFile(file, 'utf8'));
      const i = (doc.toJS()?.requests ?? []).findIndex((r) => r.id === id);
      if (i < 0) throw new UsageError(`No request ${id}.`);
      doc.get('requests', true).items.splice(i, 1);
      await fs.writeFile(file, doc.toString({ lineWidth: 0 }));
      return routes['GET /api/bench']();
    },

    // The project: sources, targets, mappings and how they stand.
    'GET /api/project': async () => {
      if (!projectFile) return { project: null };
      const p = await readProject(projectFile);
      return { project: await projectStatus(p, { n20s }), active, can: { introspect: !!openSource, n20s: !!n20s } };
    },
    'POST /api/project/open': async ({ mapping }) => {
      if (!projectFile) throw new UsageError('The studio was started on a mapping file, not a project.');
      await activate(mapping);
      return routes['GET /api/project']();
    },
    'POST /api/project/introspect': async ({ source }) => {
      if (!openSource) throw new UsageError('Introspection needs a source (--source, N20S_SOURCE or NEO4J_URI).');
      const p = await readProject(projectFile);
      const res = await introspectSource(p, source, { openSource: (url) => openSource(url) });
      return { ...(await routes['GET /api/project']()), introspected: res };
    },
    'POST /api/project/fetch': async ({ target, repin = false }) => {
      const p = await readProject(projectFile);
      const res = await fetchTarget(p, target, { repin });
      return { ...(await routes['GET /api/project']()), fetched: res };
    },
    'POST /api/project/add': async ({ section, id, value }) => {
      await addToProject(await readProject(projectFile), section, id, value);
      return routes['GET /api/project']();
    },
    'POST /api/project/mapping': async (o) => {
      const res = await newMapping(await readProject(projectFile), o);
      return { ...(await routes['GET /api/project']()), created: res };
    },

    // The design conversation and the specification it writes.
    'GET /api/design': async () => {
      const l = await loadFiles(mappingFile, { lpg });
      const spec = await readSpec(specFile, l.mapping.id);
      const chat = await readChat(chatPathFor(specFile));
      const targets = await designTargets(l);
      let check = null;
      try { check = JSON.parse(await fs.readFile(specCheckPath(), 'utf8')); } catch { /* not checked yet */ }
      return {
        check, gaps: specFindings(spec, l.mapping, l.lpgDoc, { targets: await designTargets(l) }),
        specFile: path.relative(process.cwd(), specFile).startsWith('..') ? specFile : path.relative(process.cwd(), specFile), spec, chat, scope: scopeOf(spec, l.lpgDoc),
        names: [...elementNames(l.lpgDoc).keys()], targets, can: { model: !!provider },
        lpg: { id: l.lpgDoc.id, name: l.lpgDoc.name, described: [...Object.values(l.lpgDoc.nodes ?? {}), ...Object.values(l.lpgDoc.relationships ?? {})].filter((e) => e.description).length },
      };
    },
    'POST /api/design/say': async ({ message }) => {
      if (!provider) throw new UsageError('The conversation needs a model: choose one in the Connections tab.');
      if (!String(message ?? '').trim()) throw new UsageError('Say something.');
      const l = await loadFiles(mappingFile, { lpg });
      const spec = await readSpec(specFile, l.mapping.id);
      const chat = await readChat(chatPathFor(specFile));
      const turn = await designTurn({ provider: provider(), lpgDoc: l.lpgDoc, spec, chat, message, targets: await designTargets(l) });
      await appendChat(chatPathFor(specFile), turn);
      return routes['GET /api/design']();
    },
    // A proposal of the conversation (pid), or an item of the spec (id): accept, reject, edit, remove.
    'POST /api/design/decide': async ({ pid = null, id = null, action, item = null, comment = null }) => {
      const l = await loadFiles(mappingFile, { lpg });
      const spec = await readSpec(specFile, l.mapping.id);
      const chat = await readChat(chatPathFor(specFile));
      let proposal = null;
      let model = null;
      if (pid) {
        const m = chat.find((x) => x.proposals?.some((p) => p.pid === pid));
        if (!m) throw new UsageError(`No proposal ${pid}.`);
        proposal = m.proposals.find((p) => p.pid === pid);
        model = m.model;
      }
      const next = decideItem(spec, { action, proposal, item, id, comment, by: reviewer, model, names: elementNames(l.lpgDoc), targets: await designTargets(l) });
      await writeSpec(specFile, next);
      return routes['GET /api/design']();
    },

    // Proposes every undecided element of the mapping from its spec (passes > 1 also writes the variants).
    'POST /api/design/propose': async ({ passes = 1 }) => {
      if (!provider) throw new UsageError('Proposing needs a model: choose one in the Connections tab.');
      const s = await state();
      const pfx = prefix ?? inferPrefix(s.l.mapping) ?? baseOf(s.l.mapping);
      if (!pfx) throw new UsageError('No prefix for generated IRIs: start the studio with --prefix.');
      const res = await proposePasses({ mapping: s.l.mapping, lpgDoc: s.l.lpgDoc, targets: s.l.targets, provider: provider(), prefix: pfx, valuesOf, spec: s.spec, passes: Math.max(1, Math.min(5, Number(passes) || 1)) });
      await save(s.l, res.mapping, [...Object.keys(res.mapping.nodes ?? {}).map((id) => `nodes/${id}`), ...Object.keys(res.mapping.relationships ?? {}).map((id) => `relationships/${id}`)]);
      if (res.variants.passes > 1) await fs.writeFile(variantsFile, JSON.stringify(res.variants, null, 1) + '\n');
      return { calls: res.passes.reduce((n, p) => n + p.calls.length, 0), dropped: res.dropped.map((d) => d.element), outOfScope: Object.values(res.mapping.nodes).concat(Object.values(res.mapping.relationships)).filter((e) => e.meta?.proposedBy?.name === 'spec').length };
    },

    // Asks the model where the mapping departs from the principles, purpose and notes of the spec; kept next to the spec.
    // A competency question of the spec drafted as a recipe: checked, repaired once, written as a draft,
    // added to the bench, and run once when a source and n20s-server are there.
    'POST /api/design/draft': async ({ id }) => {
      if (!provider) throw new UsageError('Drafting needs a model: choose one in the Connections tab.');
      const s = await state();
      const item = (s.spec.items ?? []).find((i) => i.id === id && i.kind === 'question' && i.status === 'accepted');
      if (!item) throw new UsageError(`No accepted question ${id} in the spec.`);
      const model = provider();
      const request = recipeDraftRequest({ question: item.text, lpgDoc: s.l.lpgDoc, mapping: s.l.mapping, decisions: decisionsText(s.l.mapping, s.l.lpgDoc) });
      const mappingPath = path.relative(recipeDir, mappingFile);
      await fs.mkdir(recipeDir, { recursive: true });
      const canTry = !!(openSource && n20s);
      const unaccepted = [...Object.values(s.l.mapping.nodes ?? {}), ...Object.values(s.l.mapping.relationships ?? {})].filter((e) => e.meta?.status === 'proposed').length;

      /** Checks a draft, and when it can, runs it next to its direct Cypher answer. */
      const assess = async (answer) => {
        const recipe = recipeFromDraft(answer, { mappingPath, question: item.text });
        const findings = [...checkRecipe(recipe, { mapping: s.l.mapping }), ...draftProblems(recipe, s.l.lpgDoc, answer.answerCypher)];
        if (findings.length || !canTry) return { recipe, findings, tried: null };
        const tmp = path.join(recipeDir, `.draft-${process.pid}.recipe.yaml`);
        await fs.writeFile(tmp, YAML.stringify(recipe));
        const source = openSource();
        try {
          const f = await loadRecipe(tmp);
          const run = await runRecipe({ ...f, source, n20s, resolvePublished: publishedResolver(recipeDir) });
          const rows = run.steps.at(-1)?.result?.rows ?? [];
          const tried = { ok: run.ok, ms: run.ms, rows: run.ok ? rows.length : null, error: run.steps.find((x) => x.status === 'error')?.error ?? null, unaccepted };
          if (run.ok && answer.answerCypher) {
            try {
              const params = Object.fromEntries(Object.entries(recipe.params ?? {}).map(([k, d]) => [k, d?.default ?? '']));
              tried.compare = compareAnswers(rows, await source.run(answer.answerCypher, params));
            } catch (err) { tried.compare = { agree: false, error: `the direct Cypher fails: ${err.message.split('\n')[0]}` }; }
          }
          return { recipe, findings, tried };
        } finally {
          await source.close();
          await fs.rm(tmp, { force: true });
        }
      };

      let res = await model.complete(request);
      let a = await assess(res.json);
      const disagrees = (x) => x.tried?.compare && x.tried.compare.agree === false;
      if (a.findings.length || disagrees(a)) {
        const why = a.findings.length ? a.findings.map((f) => `- ${f.path}: ${f.message}`).join('\n')
          : a.tried.compare.error ? `- ${a.tried.compare.error}`
            : `- The recipe and your direct Cypher answer disagree on ${a.tried.compare.columns.join(', ')}: the recipe gives ${a.tried.compare.recipeRows} rows, the Cypher ${a.tried.compare.cypherRows}. Only in the recipe: ${a.tried.compare.onlyRecipe.join(' ') || 'none'}. Only in the Cypher: ${a.tried.compare.onlyCypher.join(' ') || 'none'}. Find which one misreads the question (direction of relationships, what the scope projects, the SPARQL pattern) and fix it.`;
        res = await model.complete({ ...request, user: `${request.user}\n\n# Your draft\n${JSON.stringify(res.json)}\n\n# What went wrong\n${why}\nDraft it again.` });
        a = await assess(res.json);
      }
      const { recipe, findings, tried } = a;
      let file = `${recipe.id}.recipe.yaml`;
      for (let n = 2; await fs.access(path.join(recipeDir, file)).then(() => true, () => false); n++) { recipe.id = `${recipe.id.replace(/-\d+$/, '')}-${n}`; file = `${recipe.id}.recipe.yaml`; }
      const verdict = !tried?.compare ? 'Not cross-checked.'
        : tried.compare.empty ? 'Both it and a direct Cypher answer are empty on the default parameters: not cross-checked.'
          : tried.compare.agree ? `It agrees with a direct Cypher answer (${tried.compare.cypherRows} rows on the default parameters).` : 'It does NOT agree with a direct Cypher answer: check it.';
      const head = `# Drafted by ${model.model} from the question ${item.id} of the spec: "${item.text}"\n# Review it before relying on it. ${verdict}\n# ${String(res.json?.explanation ?? '').replace(/\n/g, ' ')}\n${res.json?.answerCypher ? `# Direct Cypher answer: ${String(res.json.answerCypher).replace(/\s+/g, ' ')}\n` : ''}`;
      await fs.writeFile(path.join(recipeDir, file), head + YAML.stringify(recipe, { lineWidth: 0 }));
      // The question remembers its recipe; the bench gets a request for it.
      const spec = structuredClone(s.spec);
      spec.items.find((i) => i.id === id).recipe = file;
      await writeSpec(specFile, spec);
      await routes['POST /api/bench/save']({ request: { id: recipe.id, title: item.text, target: { recipe: recipe.id }, expect: { status: 200, ...(tried?.compare?.agree ? { rows: tried.compare.cypherRows } : {}) } } }).catch(() => null);
      return { ...(await routes['GET /api/design']()), drafted: { file, id: recipe.id, findings, explanation: res.json?.explanation ?? null, tried } };
    },

    // Adds a target the spec chose to the mapping (and to the project, fetched, when it comes from the catalog).
    'POST /api/design/add-target': async ({ target }) => {
      if (!projectFile) throw new UsageError('Adding a target needs a project: add it to the mapping file by hand.');
      await addTargetToMapping(await readProject(projectFile), active, target);
      return routes['GET /api/design']();
    },

    'POST /api/design/check': async () => {
      if (!provider) throw new UsageError('The check needs a model: choose one in the Connections tab.');
      const s = await state();
      const res = await provider().complete(specCheckRequest({ spec: s.spec, decisions: decisionsText(s.l.mapping, s.l.lpgDoc), lpgDoc: s.l.lpgDoc }));
      const names = elementNames(s.l.lpgDoc);
      const findings = (res.json?.findings ?? []).filter((f) => names.has(f.element)).map((f) => ({ ...f, path: `${names.get(f.element).section}/${names.get(f.element).id}` }));
      await fs.writeFile(specCheckPath(), JSON.stringify({ at: new Date().toISOString(), findings }, null, 1) + '\n');
      return { ...(await routes['GET /api/design']()), check: { findings } };
    },

    'POST /api/oracle': async ({ withProposals = false } = {}) => {
      if (!oracleFile || !openSource || !n20s) throw new UsageError('The oracle needs --oracle, a source and n20s-server.');
      const s = await state();
      const oracle = (await import('yaml')).default.parse(await fs.readFile(oracleFile, 'utf8'));
      const mapping = withProposals ? acceptAll(s.l.mapping) : s.l.mapping;
      const { plan, problems } = await compile(mapping, s.l.lpgDoc);
      const source = openSource();
      try {
        const graph = `studio-${withProposals ? 'proposals' : 'accepted'}`;
        const res = await project({ plan, source, n20s, graph });
        const results = await runOracle({ oracle, mapping, lpgDoc: s.l.lpgDoc, source, n20s, graph });
        await fs.writeFile(oracleEvidencePath(), JSON.stringify(oracleEvidence({ oracle, results, mapping, lpgDoc: s.l.lpgDoc, plan, withProposals }), null, 1) + '\n');
        return { withProposals, triples: res.triples, problems, results, checks: oracle.checks.map((c) => ({ id: c.id, source: c.source ?? null, reason: c.reason ?? null })) };
      } finally {
        await source.close();
      }
    },
  };

  // Built per request: the recipes directory follows the mapping opened in the project.
  const served = (req, url) => (n20s ? endpoints({ recipesDir: recipeDir, n20s, openSource, allowRun: true })(req, url) : null);
  const server = http.createServer(async (req, res) => {
    const send = (status, type, body, headers = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(body); };
    try {
      const url = new URL(req.url, 'http://localhost');
      // Before anything else: a page of another site cannot reach the studio through a name pointing here (DNS rebinding).
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(403, 'application/json', JSON.stringify({ error: 'Forbidden host' }));
      // /sparql/<graph>, /query/<api> and /run/<recipe>, as `n20s-mapping serve` offers them.
      const ep = await served(req, url);
      if (ep) return send(ep.status, `${ep.type}; charset=utf-8`, ep.body, ep.headers);
      if (req.method === 'GET' && FILES[url.pathname]) {
        const [file, type] = FILES[url.pathname];
        return send(200, `${type}; charset=utf-8`, await fs.readFile(path.resolve(STATIC, file)));
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(404, 'application/json', JSON.stringify({ error: 'Not found' }));
      // The page only: another site cannot post to the API without a preflight (JSON).
      if (req.method === 'POST' && !/^application\/json\b/.test(req.headers['content-type'] ?? '')) return send(415, 'application/json', JSON.stringify({ error: 'JSON only' }));
      let body = {};
      if (req.method === 'POST') {
        let text = '';
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 1e6) throw new UsageError('Request too large.');
        }
        body = text ? JSON.parse(text) : {};
      }
      send(200, 'application/json', JSON.stringify(await route(body)));
    } catch (err) {
      send(err instanceof UsageError || err instanceof SyntaxError || /^(No entry|Not an entry|An edit|Unknown action|No element)/.test(err.message) ? 400 : 500,
        'application/json', JSON.stringify({ error: err.message }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  // Publications that follow the database are rebuilt when a transaction touches their sources.
  // Every mapping of the project: a publication keeps following when another mapping is opened.
  let followDirs = [recipeDir];
  let followOwners = new Map();   // recipes directory → mapping id
  const refreshFollowDirs = async () => {
    if (!projectFile) { followDirs = [recipeDir]; return; }
    try {
      const p = await readProject(projectFile);
      followOwners = new Map(Object.entries(p.project.mappings ?? {}).map(([id, m]) => [m.recipes ? path.join(p.dir, m.recipes) : path.join(path.dirname(path.join(p.dir, m.file)), 'recipes'), id]));
      followDirs = [...followOwners.keys()];
    } catch { followDirs = [recipeDir]; }
  };
  await refreshFollowDirs();
  const following = follower({ recipesDir: () => followDirs, openSource: () => openSource, n20s: () => n20s, openWriter: writerOpener, intervalMs: followIntervalMs,
    onSync: (r) => console.error(`  ${r.endpoint}: ${r.transactions} transaction(s) → ${r.sync.ok ? `rebuilt as ${r.sync.graph} in ${r.sync.ms} ms` : `not rebuilt: ${r.sync.error}`}`),
    onError: (err) => console.error(`  following: ${err.message.split('\n')[0]}`) });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => { following.stop(); return new Promise((resolve) => server.close(() => resolve())); },
  };
}
