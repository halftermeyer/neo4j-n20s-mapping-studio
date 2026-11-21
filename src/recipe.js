// Recipes: an ordered list of steps that feed, change, ask or publish named n20s graphs.
//
// A recipe declares the graphs it works on and their lifecycle:
//   ephemeral   built during the run under a name unique to the run, dropped
//               at the end (a question answered in a reasoning window: only
//               what the question needs is projected, never the whole LPG);
//   persistent  a fixed name that outlives the run: one recipe builds or
//               refreshes it (start: rebuild) or adds to it (start: reuse).
//               versioned: true builds a new version on every run
//               (<name>--<run>), so that a publish step can swap a published
//               endpoint to it once it is complete and valid;
//   published   a read-only reference to what an endpoint serves now: the
//               precomputed part of a recipe that also scopes lazily;
//   remote      a SPARQL endpoint outside (the client's triple store), read
//               only with construct ... from: its triples join the Cypher-scoped
//               ones in a working graph, and are reasoned over with them.
// Steps run in order. Each one feeds a graph (scope projected through the
// mapping, rows through a template, static triples, construct from another
// graph), changes it (forward inference, construct, update), asks it (SPARQL,
// SHACL, explain; with on-the-fly reasoning when a profile or rules are given)
// or publishes it as a SPARQL endpoint, behind validation gates. Data passing
// is the exception: $step.column hands the result of a step to a later one, to
// follow up on what reasoning found. Every statement sent is kept in a trace
// that replays the run (REASONING-CONTRACT.md, sections 2 and 6).
//
// A recipe can also declare an api: it is then served as a parametrized query
// (/query/<name>), run on each call.
//
// Browser-safe: files come through a read function, the source and n20s are
// passed in.
import { Parser as N3Parser, Writer as N3Writer } from 'n3';
import { indexLpg } from './lpg.js';
import { remoteOf as defaultRemote, isEnvName, shownUrl } from './remote.js';
import { resolve, isCompiled } from './resolve.js';
import { expand, shorten, fillTemplate, matchTemplate, parseTemplate } from './iri.js';
import { formatFromPath } from './targets.js';

export const RECIPE_FORMAT = 'n20s-recipe/0.1';
export const STEP_TYPES = ['scope', 'rows', 'triples', 'infer', 'query', 'construct', 'update', 'validate', 'explain', 'publish'];
/** What a step does to its graph. A construct from another graph feeds its own. */
export const STEP_ROLES = {
  scope: 'feed', rows: 'feed', triples: 'feed', infer: 'change', construct: 'change', update: 'change',
  query: 'ask', validate: 'ask', explain: 'ask', publish: 'publish',
};
export const roleOf = (step) => (step?.type === 'construct' && step.from ? 'feed' : STEP_ROLES[step?.type] ?? null);
export const LIFECYCLES = ['ephemeral', 'persistent', 'published', 'remote'];
export const PARAM_TYPES = ['string', 'integer', 'number', 'boolean', 'list'];
const NAME = /^[A-Za-z][\w.-]*$/;

const REQUIRED = {
  scope: ['cypher'], rows: ['cypher', 'template'], triples: [], infer: [], query: ['sparql'],
  construct: ['sparql'], update: ['sparql'], validate: [], explain: ['s', 'p', 'o'], publish: ['as'],
};
const DEFAULT_GRAPHS = { work: { lifecycle: 'ephemeral' } };

/** The graphs of a recipe: as declared, or one ephemeral graph named work. */
export const graphsOf = (recipe) => (recipe?.graphs && Object.keys(recipe.graphs).length ? recipe.graphs : DEFAULT_GRAPHS);
/** The graph a step works on: its own, or the only graph, or work. */
export const graphOf = (recipe, step) => step?.graph ?? (Object.keys(graphsOf(recipe)).length === 1 ? Object.keys(graphsOf(recipe))[0] : 'work');
const lifecycleOf = (g) => g?.lifecycle ?? 'ephemeral';

/**
 * What a recipe computes ahead and what on demand:
 *   build        writes a persistent graph (to publish, or for other recipes);
 *   precomputed  only reads published graphs;
 *   lazy         only scopes ephemeral graphs, on each run;
 *   hybrid       reads published graphs and scopes ephemeral ones.
 */
export function recipeKind(recipe) {
  const graphs = graphsOf(recipe);
  const steps = recipe?.steps ?? [];
  const used = new Set(steps.flatMap((s) => [graphOf(recipe, s), ...(s.from ? [s.from] : [])]));
  const writes = steps.some((s) => ['feed', 'change'].includes(roleOf(s)) && lifecycleOf(graphs[graphOf(recipe, s)]) === 'persistent');
  if (writes) return 'build';
  // A remote store is read like a published graph: precomputed elsewhere.
  const lcs = new Set([...used].map((k) => (lifecycleOf(graphs[k]) === 'remote' ? 'published' : lifecycleOf(graphs[k]))));
  if (lcs.has('published') && lcs.has('ephemeral')) return 'hybrid';
  if (lcs.has('published')) return 'precomputed';
  return 'lazy';
}

/** Structural findings on a recipe, before running it. */
export function checkRecipe(recipe, { mapping = null } = {}) {
  const findings = [];
  const err = (path, message) => findings.push({ severity: 'error', path, message });
  if (recipe?.format !== RECIPE_FORMAT) err('format', `Expected format ${RECIPE_FORMAT}.`);
  if (!recipe?.id) err('id', 'A recipe needs an id.');
  const graphs = graphsOf(recipe);
  const names = new Map();
  for (const [key, g] of Object.entries(graphs)) {
    const path = `graphs/${key}`;
    if (!/^[A-Za-z][\w-]*$/.test(key)) err(path, 'A graph key starts with a letter and has letters, digits, - and _ only.');
    const lc = lifecycleOf(g);
    if (!LIFECYCLES.includes(lc)) err(path, `Unknown lifecycle ${lc}; use ${LIFECYCLES.join(', ')}.`);
    if (lc === 'persistent') {
      if (!g.name || !NAME.test(g.name)) err(path, 'A persistent graph needs a name (a letter, then letters, digits, ., - and _): the name it keeps in n20s-server.');
      else if (names.has(g.name)) err(path, `Graph name ${g.name} is used by ${names.get(g.name)} too.`);
      else names.set(g.name, key);
      if (g.versioned) {
        if (g.start && g.start !== 'rebuild') err(path, 'A versioned graph is built anew on every run: start is rebuild.');
      } else if (!['rebuild', 'reuse'].includes(g.start)) {
        err(path, 'A persistent graph needs start: rebuild (emptied when the run starts) or reuse (kept as it is), or versioned: true.');
      }
    } else if (lc === 'published') {
      if (!g.endpoint || !NAME.test(g.endpoint)) err(path, 'A published graph names the endpoint it reads: endpoint: <name>.');
      if (g.name || g.start || g.versioned) err(path, 'A published graph has an endpoint only: it reads whatever the endpoint serves now.');
    } else if (lc === 'remote') {
      if (typeof g.sparql !== 'string' || !/^(https?:\/\/|\$\{)/.test(g.sparql)) err(path, 'A remote graph names its SPARQL endpoint: sparql: https://… (${VAR} takes it from the environment).');
      else if (/\/\/[^/@]*:[^/@]*@/.test(g.sparql)) err(path, 'No credentials in the URL: user and password name environment variables.');
      for (const f of ['user', 'password']) if (g[f] !== undefined && !isEnvName(g[f])) err(path, `${f} names an environment variable (for instance CLIENT_KG_${f.toUpperCase()}), not a value.`);
      if (g.name || g.start || g.versioned || g.endpoint) err(path, 'A remote graph has sparql, user and password only.');
    } else if (g?.name || g?.start || g?.versioned || g?.endpoint) {
      err(path, 'An ephemeral graph has no name, start, versioned or endpoint: it lives for one run.');
    }
  }
  for (const [k, d] of Object.entries(recipe?.params ?? {})) {
    if (d?.type && !PARAM_TYPES.includes(d.type)) err(`params/${k}`, `Unknown type ${d.type}; use ${PARAM_TYPES.join(', ')}.`);
  }
  const steps = Array.isArray(recipe?.steps) ? recipe.steps : [];
  if (!steps.length) err('steps', 'A recipe needs steps.');
  const seen = new Map();
  const endpoints = new Set();
  steps.forEach((s, i) => {
    const path = `steps/${s?.id ?? i}`;
    if (!s?.id) err(`steps/${i}`, 'A step needs an id.');
    else if (seen.has(s.id)) err(path, `Step id ${s.id} is used twice.`);
    if (!STEP_TYPES.includes(s?.type)) { err(path, `Unknown step type ${s?.type}; use ${STEP_TYPES.join(', ')}.`); return; }
    for (const f of REQUIRED[s.type]) if (s[f] === undefined) err(path, `${/^[aeiou]/.test(s.type) ? 'An' : 'A'} ${s.type} step needs ${f}.`);
    if (s.type === 'triples' && !s.files && !s.turtle) err(path, 'A triples step needs files or turtle.');
    if (s.type === 'scope' && !mapping) err(path, 'A scope step needs the mapping of the recipe.');
    const key = graphOf(recipe, s);
    if (!(key in graphs)) err(path, `Graph ${key} is not declared in graphs.`);
    const role = roleOf(s);
    if (['feed', 'change'].includes(role) && lifecycleOf(graphs[key]) === 'published') err(path, `Graph ${key} is published: read it, or construct from it into another graph.`);
    if (lifecycleOf(graphs[key]) === 'remote') err(path, `Graph ${key} is a remote store: nothing runs on it; construct from it into a graph of the recipe.`);
    if (s.from !== undefined) {
      if (s.type !== 'construct') err(path, 'from is for construct steps: they copy from another graph.');
      else if (!(s.from in graphs)) err(path, `Graph ${s.from} is not declared in graphs.`);
      else if (s.from === key) err(path, 'A construct from its own graph is a plain construct: leave from out.');
    }
    if (s.type === 'publish') {
      if (lifecycleOf(graphs[key]) !== 'persistent') err(path, `Only a persistent graph can be published; ${key} is ${lifecycleOf(graphs[key])}.`);
      if (s.as !== undefined && !NAME.test(String(s.as))) err(path, 'as names the endpoint: a letter, then letters, digits, ., - and _.');
      else if (endpoints.has(s.as)) err(path, `Endpoint ${s.as} is published twice.`);
      endpoints.add(s.as);
      for (const g of s.gate ?? []) {
        if (!seen.has(g)) err(path, `Gate ${g} is not a step that runs before.`);
        else if (seen.get(g) !== 'validate') err(path, `Gate ${g} is not a validate step.`);
      }
    }
    for (const ref of references(s)) {
      if (ref.step && !seen.has(ref.step)) err(path, `$${ref.step}.${ref.column} refers to a step that does not run before it.`);
      if (!ref.step && !(ref.name in (recipe.params ?? {}))) err(path, `$${ref.name} is not a parameter of the recipe.`);
    }
    // In Cypher, $name is a recipe parameter or a parameter the step defines.
    for (const m of String(s.cypher ?? '').matchAll(/\$([A-Za-z_]\w*)/g)) {
      if (!(m[1] in (recipe.params ?? {})) && !(m[1] in (s.params ?? {}))) err(path, `$${m[1]} in the Cypher is neither a recipe parameter nor in params.`);
    }
    if (s?.id) seen.set(s.id, s.type);
  });
  if (recipe?.api !== undefined) {
    const a = recipe.api;
    if (!a || !NAME.test(String(a.name ?? ''))) err('api', 'An api needs a name: a letter, then letters, digits, ., - and _.');
    if (a?.result !== undefined && !['query', 'validate', 'explain'].includes(seen.get(a.result))) err('api', `api.result ${a.result} is not a query, validate or explain step.`);
    if (a?.result === undefined && ![...seen.values()].some((t) => ['query', 'validate', 'explain'].includes(t))) err('api', 'An api returns what an asking step found: the recipe has none.');
  }
  return findings;
}

/**
 * $param and $step.column references of a step: in params values, in s, p, o,
 * and in {{kind|expr}} placeholders. Cypher has its own $parameters, and
 * SPARQL may use $ for variables, so their text is not scanned.
 */
export function references(step) {
  const exprs = [...Object.values(step?.params ?? {}), ...['s', 'p', 'o'].map((k) => step?.[k])].filter((x) => typeof x === 'string');
  for (const text of [step?.sparql, step?.s, step?.p, step?.o].filter((x) => typeof x === 'string')) {
    for (const m of text.matchAll(/\{\{[^|}]+\|([^}]+)\}\}/g)) exprs.push(m[1].trim());
  }
  const out = [];
  for (const e of exprs) {
    const m = /^\$([A-Za-z_][\w-]*)(?:\.([A-Za-z_][\w-]*))?(\[\d+\])?$/.exec(e.trim());
    if (m) out.push(m[2] ? { step: m[1], column: m[2] } : { name: m[1] });
  }
  for (const g of step?.gate ?? []) out.push({ step: g, column: 'conforms' });
  return out;
}

/** The recipe as a sequence: each step with its role, its graph, and the earlier steps whose results it uses. */
export function recipeOutline(recipe) {
  const graphs = graphsOf(recipe);
  return {
    kind: recipeKind(recipe),
    api: recipe.api ?? null,
    graphs: Object.entries(graphs).map(([key, g]) => ({
      key, lifecycle: lifecycleOf(g), name: g?.name ?? null, start: g?.versioned ? 'rebuild' : g?.start ?? null,
      versioned: !!g?.versioned, endpoint: g?.endpoint ?? null,
      ...(lifecycleOf(g) === 'remote' ? { sparql: g.sparql ?? null, user: g.user ?? null, password: g.password ?? null } : {}),
    })),
    steps: (recipe.steps ?? []).map((s) => ({
      id: s.id, type: s.type, role: roleOf(s), graph: graphOf(recipe, s), from: s.from ?? null, title: s.title ?? null,
      uses: references(s).filter((r) => r.step), ...(s.type === 'publish' ? { as: s.as } : {}),
    })),
  };
}

/** Parameter values from strings (a query string) or JSON, by their declared type. */
export function coerceParams(recipe, given) {
  const out = {};
  const errors = [];
  for (const [k, v] of Object.entries(given ?? {})) {
    const def = recipe.params?.[k];
    if (!def) { errors.push(`Unknown parameter ${k}.`); continue; }
    const type = def.type ?? 'string';
    const s = typeof v === 'string' ? v.trim() : v;
    if (type === 'integer') { const n = Number(s); if (Number.isInteger(n)) out[k] = n; else errors.push(`${k}: not an integer.`); }
    else if (type === 'number') { const n = Number(s); if (s !== '' && Number.isFinite(n)) out[k] = n; else errors.push(`${k}: not a number.`); }
    else if (type === 'boolean') { if ([true, 'true', '1'].includes(s)) out[k] = true; else if ([false, 'false', '0'].includes(s)) out[k] = false; else errors.push(`${k}: true or false.`); }
    else if (type === 'list') out[k] = Array.isArray(s) ? s : String(s).startsWith('[') ? JSON.parse(s) : String(s).split(',').map((x) => x.trim()).filter(Boolean);
    else out[k] = typeof s === 'string' ? s : String(s);
  }
  return { params: out, errors };
}

// Values ------------------------------------------------------------------------------------

/** IRIs of node kinds, and decoding back to LPG keys, through the subject templates. */
function subjects(mapping, lpgDoc) {
  const idx = indexLpg(lpgDoc);
  const r = resolve(mapping, idx, isCompiled);
  const P = mapping.prefixes ?? {};
  const single = (nodeId) => {
    const s = r.effectiveSubject(nodeId);
    if (!s) throw new Error(`No accepted subject for node kind ${nodeId}.`);
    const phs = parseTemplate(s.template).placeholders;
    if (phs.length !== 1) throw new Error(`The subject of ${nodeId} has ${phs.length} placeholders; recipes need one.`);
    return { template: s.template, placeholder: phs[0] };
  };
  const roots = [...new Set([...idx.nodes.keys()].map((id) => r.effectiveSubject(id)?.from).filter(Boolean))];
  // The most specific label seen for a key in a scope: an IRI only tells the kind that holds the subject (Entity).
  const seen = new Map();
  const depth = (label) => { const id = idx.labelToNode.get(label); return id ? idx.ancestors(id).length : -1; };
  return {
    remember(node) {
      const label = [...node._labels].sort((a, b) => depth(b) - depth(a))[0];
      for (const id of roots) {
        const key = parseTemplate(r.effectiveSubject(id).template).placeholders[0];
        const db = idx.findNodeProperty(id, key)?.prop.name ?? key;
        if (node._labels.includes(idx.nodes.get(id).label) && node[db] !== undefined) seen.set(`${id}|${node[db]}`, label);
      }
    },
    iri(nodeId, value) { const { template, placeholder } = single(nodeId); return fillTemplate(template, { [placeholder]: value }, P); },
    decode(nodeId, iri) { const { template, placeholder } = single(nodeId); return matchTemplate(template, iri, P)?.[placeholder] ?? null; },
    /** Any IRI of a projected node: its kind (the kind holding the subject) and key. */
    decodeAny(iri) {
      for (const id of roots) {
        const v = matchTemplate(r.effectiveSubject(id).template, iri, P);
        if (v) { const key = Object.values(v)[0]; return { node: id, label: seen.get(`${id}|${key}`) ?? idx.nodes.get(id).label, key }; }
      }
      return null;
    },
    prefixes: P,
  };
}

const sparqlLiteral = (v) => `"${String(v).replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/**
 * Builds a run context and returns the helpers that evaluate expressions:
 *   $name          a recipe parameter
 *   $step.column   the values of a column of a previous step (a list)
 *   anything else  itself
 */
function evaluator(params, outputs) {
  const value = (expr) => {
    if (typeof expr !== 'string') return expr;
    const m = /^\$([A-Za-z_][\w-]*)(?:\.([A-Za-z_][\w-]*))?(\[(\d+)\])?$/.exec(expr.trim());
    if (!m) return expr;
    const [, a, col, , index] = m;
    let v;
    if (col) {
      const out = outputs.get(a);
      if (!out) throw new Error(`$${a}.${col}: step ${a} has not run.`);
      v = (out.rows ?? []).map((row) => row[col]).filter((x) => x !== undefined && x !== null);
      v = [...new Set(v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)))].map((x) => { try { return typeof x === 'string' && x.startsWith('{') ? JSON.parse(x) : x; } catch { return x; } });
    } else {
      if (!(a in params)) throw new Error(`$${a} is not a parameter of the recipe.`);
      v = params[a];
    }
    if (index !== undefined) return asList(v)[Number(index)];
    return v;
  };
  return value;
}

/** Replaces {{kind|expr}} in SPARQL: IRIs of a node kind, `iri` values as IRIs, `literal` values as literals. Lists give several terms. */
function fillSparql(text, value, subj) {
  return text.replace(/\{\{([^|}]+)\|([^}]+)\}\}/g, (all, kind, expr) => {
    const vals = asList(value(expr.trim()));
    if (!vals.length) return kind === 'literal' ? '""' : '<urn:n20s:none>';
    return vals.map((v) => {
      if (kind === 'literal') return sparqlLiteral(v);
      if (kind === 'iri') return `<${expand(String(v), subj.prefixes).iri ?? v}>`;
      return `<${subj.iri(kind, v)}>`;
    }).join(' ');
  });
}

/** Prefixed names of the mapping in Jena rules become full IRIs (Jena rules take bare IRIs). */
function expandRules(rules, P) {
  if (!rules) return '';
  const names = Object.keys(P).sort((a, b) => b.length - a.length).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!names.length) return rules;
  return rules.replace(new RegExp(`(^|[\\s(,])(${names.join('|')}):([A-Za-z_][\\w.-]*[\\w-]|[A-Za-z_])`, 'g'), (m, pre, p, local) => (p === 'rdf' && local === 'type' ? m : `${pre}${P[p]}${local}`));
}

/** A term for explain: an expression, {{kind|expr}}, or a prefixed name. Literals are given as "lex" or "lex"^^<dt>. */
function term(expr, value, subj) {
  if (typeof expr !== 'string') return String(expr);
  if (/^\{\{.*\}\}$/.test(expr.trim())) return fillSparql(expr.trim(), value, subj).replace(/^<|>$/g, '');
  const v = value(expr);
  const first = Array.isArray(v) ? v[0] : v;
  if (typeof first !== 'string') return String(first);
  if (first.startsWith('"') || first.startsWith('_:')) return first;
  return expand(first, subj.prefixes).iri ?? first;
}

/** Nodes in a Cypher result (plain values: nodes carry _labels; paths are lists). */
function collectNodes(v, out = []) {
  if (Array.isArray(v)) { for (const x of v) collectNodes(x, out); return out; }
  if (v && typeof v === 'object') {
    if (Array.isArray(v._labels)) out.push(v);
    else for (const x of Object.values(v)) collectNodes(x, out);
  }
  return out;
}

const quote = (name) => '`' + String(name).replaceAll('`', '``') + '`';

/** Turtle for n20s from a file text: Turtle as is, other RDF syntaxes through N-Triples. */
function toTurtle(text, path) {
  const format = formatFromPath(path) ?? 'Turtle';
  if (format === 'Turtle') return text;
  const quads = new N3Parser({ format }).parse(text);
  const writer = new N3Writer({ format: 'N-Triples' });
  for (const q of quads) writer.addQuad(q.subject, q.predicate, q.object);
  let out;
  writer.end((e, r) => { out = r; });
  return out;
}

// Run ----------------------------------------------------------------------------------------------

/** Triple counts of the graphs n20s-server holds, by name. */
async function counts(n20s) {
  return new Map((await n20s.list()).map((g) => [g.graphName, g.tripleCount]));
}

/** Classes and predicates of a graph, with their counts: what the graph holds at this point of the recipe. */
const WELL_KNOWN = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#', owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#', sh: 'http://www.w3.org/ns/shacl#',
};

async function inspectGraph(n20s, name, P) {
  const all = { ...WELL_KNOWN, ...P };
  const short = (x) => (String(x).startsWith('_:') ? '(blank node)' : shorten(x, all));
  const classes = await n20s.query(name, 'SELECT ?class (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a ?class } GROUP BY ?class ORDER BY DESC(?n)');
  const predicates = await n20s.query(name, 'SELECT ?predicate (COUNT(*) AS ?n) WHERE { ?s ?predicate ?o } GROUP BY ?predicate ORDER BY DESC(?n)');
  const num = (v) => Number(String(v).replace(/^"|"(\^\^.*)?$/g, ''));
  // Blank-node classes (OWL restrictions, unions) count together.
  const merge = (rows, col) => {
    const m = new Map();
    for (const r of rows) m.set(short(r[col]), (m.get(short(r[col])) ?? 0) + num(r.n));
    return [...m].map(([term, n]) => ({ term, n })).sort((a, b) => b.n - a.n);
  };
  return { classes: merge(classes, 'class'), predicates: merge(predicates, 'predicate') };
}

/**
 * @param {object} a
 * @param {object} a.recipe
 * @param {object} [a.params]       values of the recipe parameters (defaults from the recipe)
 * @param {object} a.mapping
 * @param {object} a.lpgDoc
 * @param {object} a.plan           compile() of the mapping
 * @param {{run: Function}} a.source
 * @param {object} a.n20s           n20sClient()
 * @param {(path: string) => Promise<string>} [a.read]  reads a file of the recipe (relative path)
 * @param {(endpoint: string) => Promise<string|null>} [a.resolvePublished]  the graph an endpoint serves now
 * @param {boolean} [a.keep=false]  keep the ephemeral graphs after the run (persistent ones always stay)
 * @param {boolean} [a.inspect=false] after each step that feeds or changes a graph, list its classes and predicates
 * @param {string} [a.runId]
 * @param {(e: object) => void} [a.onStep]
 */
export async function runRecipe({ recipe, params = {}, mapping, lpgDoc, plan, source, n20s, read = null, resolvePublished = null, remote = defaultRemote, keep = false, inspect = false, runId = null, onStep = () => {} }) {
  const found = checkRecipe(recipe, { mapping });
  if (found.length) throw new Error(`The recipe has errors: ${found.map((f) => `${f.path}: ${f.message}`).join('; ')}`);
  const values = {};
  for (const [k, def] of Object.entries(recipe.params ?? {})) values[k] = k in params ? params[k] : def?.default;
  for (const k of Object.keys(params)) if (!(k in values)) throw new Error(`Unknown parameter ${k}.`);
  for (const [k, v] of Object.entries(values)) if (v === undefined) throw new Error(`No value for parameter ${k}.`);

  const id = runId ?? Math.random().toString(36).slice(2, 8);
  const t0 = Date.now();
  const declared = graphsOf(recipe);
  const graphs = {};
  const before = await counts(n20s);
  for (const [key, g] of Object.entries(declared)) {
    const lc = lifecycleOf(g);
    let name;
    if (lc === 'remote') {
      // Outside n20s: read with construct ... from, never written, never counted.
      const client = remote(g);
      graphs[key] = { name: null, lifecycle: lc, remote: client, url: client.url, existed: true, triplesBefore: 0, written: false };
      continue;
    }
    if (lc === 'persistent') name = g.versioned ? `${g.name}--${id}` : g.name;
    else if (lc === 'published') {
      name = resolvePublished ? await resolvePublished(g.endpoint) : null;
      if (!name) throw new Error(`Endpoint ${g.endpoint} is not published: run the recipe that publishes it.`);
      if (!before.has(name)) throw new Error(`Endpoint ${g.endpoint} serves ${name}, which is not in n20s-server (restarted?): re-publish it.`);
    } else name = `recipe-${recipe.id}-${id}-${key}`.replace(/[^\w.-]/g, '_');
    graphs[key] = {
      name, lifecycle: lc, start: lc === 'persistent' ? (g.versioned ? 'rebuild' : g.start) : null,
      ...(g.versioned ? { base: g.name, versioned: true } : {}), ...(lc === 'published' ? { endpoint: g.endpoint } : {}),
      existed: before.has(name), triplesBefore: before.get(name) ?? 0, written: false,
    };
  }
  // A persistent graph that starts from scratch is emptied first; the trace says so.
  const setup = [];
  // Ephemeral graphs exist from the start: a scope that finds nothing leaves an empty graph, and questions get no rows rather than an error.
  for (const g of Object.values(graphs)) if (g.lifecycle === 'ephemeral') await n20s.addTurtle(g.name, [''], 'append');
  for (const g of Object.values(graphs)) {
    if (g.lifecycle === 'persistent' && g.start === 'rebuild' && g.existed) {
      await n20s.drop(g.name);
      setup.push({ kind: 'n20s', call: 'drop', graph: g.name, reason: 'start: rebuild' });
      g.triplesBefore = 0;
    }
  }

  const subj = subjects(mapping, lpgDoc);
  subj.prefixes = { ...subj.prefixes, ...(recipe.prefixes ?? {}) };
  const prefixBlock = Object.entries(subj.prefixes).map(([p, ns]) => `PREFIX ${p}: <${ns}>`).join('\n');
  const outputs = new Map();
  const value = evaluator(values, outputs);
  const triples = Object.fromEntries(Object.entries(graphs).map(([k, g]) => [k, g.triplesBefore]));
  const steps = [];

  try {
    for (const step of recipe.steps) {
      const key = graphOf(recipe, step);
      const graph = graphs[key].name;
      const statements = [];
      const started = Date.now();
      const record = { id: step.id, type: step.type, role: roleOf(step), graph: key, graphName: graph, statements };
      onStep({ type: 'start', step: step.id });
      try {
        record.result = await runStep(step, { graph, graphs, statements, value, subj, prefixBlock, source, n20s, plan, values, read, outputs });
        record.status = 'ok';
      } catch (err) {
        record.status = 'error';
        record.error = err.message;
      }
      record.ms = Date.now() - started;
      // The state of the step's graph after it: size, change, and what it holds.
      const now = (await counts(n20s)).get(graph) ?? 0;
      record.state = { triples: now, delta: now - triples[key] };
      triples[key] = now;
      if (['feed', 'change'].includes(record.role) && record.status === 'ok') {
        graphs[key].written = true;
        if (inspect && now) record.state = { ...record.state, ...(await inspectGraph(n20s, graph, subj.prefixes)) };
      }
      outputs.set(step.id, record.result ?? {});
      steps.push(record);
      onStep({ type: 'end', step: step.id, status: record.status });
      if (record.status === 'error' && !step.continueOnError) break;
    }
  } finally {
    for (const [key, g] of Object.entries(graphs)) {
      g.triples = triples[key];
      if (g.lifecycle === 'ephemeral') {
        g.kept = keep;
        if (!keep) { try { await n20s.drop(g.name); } catch { /* never created */ } }
      } else {
        g.kept = true;
      }
    }
  }
  const ok = steps.every((s) => s.status === 'ok') && steps.length === recipe.steps.length;
  return {
    recipe: recipe.id, runId: id, params: values, ok, kind: recipeKind(recipe),
    graphs, setup, ms: Date.now() - t0, steps,
    // Endpoints to point at their new graph: only from a run that went through.
    publications: ok ? steps.filter((s) => s.type === 'publish').map((s) => s.result) : [],
  };
}

async function runStep(step, c) {
  const { graph, statements, value, subj, prefixBlock, source, n20s } = c;
  const cypherParams = () => {
    const p = { ...c.values };
    for (const [k, expr] of Object.entries(step.params ?? {})) p[k] = value(expr);
    return p;
  };
  const sparqlOf = (text) => `${prefixBlock}\n${fillSparql(text, value, subj)}`;
  const rulesOf = async () => {
    const parts = [];
    if (step.rules) parts.push(step.rules);
    for (const f of asList(step.rulesFiles)) parts.push(await c.read(f));
    return expandRules(parts.join('\n'), subj.prefixes);
  };

  switch (step.type) {
    case 'scope': {
      const params = cypherParams();
      statements.push({ kind: 'cypher', text: step.cypher, params });
      const rows = await source.run(step.cypher, params);
      const nodes = collectNodes(rows);
      for (const n of nodes) subj.remember(n);
      // Keys of the scoped nodes, per label and key property.
      const keys = new Map();
      for (const n of nodes) {
        for (const label of n._labels) {
          for (const k of Object.keys(n)) {
            const key = `${label}|${k}`;
            if (!keys.has(key)) keys.set(key, new Set());
            keys.get(key).add(n[k]);
          }
        }
      }
      const keysFor = (spec) => (spec.key ? [...(keys.get(`${spec.label}|${spec.key}`) ?? [])] : null);
      let added = 0;
      const units = [];
      for (const unit of c.plan.units) {
        const vars = Object.entries(unit.scope.nodes);
        const lists = vars.map(([v, spec]) => [v, spec, keysFor(spec)]);
        if (lists.some(([, , l]) => l === null)) throw new Error(`${unit.id}: the subject of ${lists.find(([, , l]) => l === null)[1].label} has several placeholders; scopes need one.`);
        if (lists.some(([, , l]) => !l.length)) continue;
        const where = lists.map(([v, spec]) => `${v}.${quote(spec.key)} IN $scope_${v}`).join(' AND ');
        const cypher = `${unit.scope.match} WHERE ${where} ${unit.scope.return}`;
        const p = Object.fromEntries(lists.map(([v, , l]) => [`scope_${v}`, l]));
        statements.push({ kind: 'cypher', unit: unit.id, text: cypher, params: p });
        const unitRows = await source.run(cypher, p);
        let unitAdded = 0;
        if (unitRows.length) {
          for (const template of unit.templates) {
            const res = await n20s.projectTemplate(graph, template, unitRows, 'append');
            statements.push({ kind: 'n20s', call: 'projectTemplate', unit: unit.id, rows: unitRows.length });
            unitAdded += res.added ?? 0;
          }
        }
        added += unitAdded;
        units.push({ id: unit.id, rows: unitRows.length, added: unitAdded });
      }
      const byLabel = {};
      for (const n of nodes) { const l = n._labels.join(':'); byLabel[l] = (byLabel[l] ?? 0) + 1; }
      return { nodes: new Set(nodes.map((n) => JSON.stringify([n._labels, n._elementId ?? n.id]))).size, byLabel, units: units.filter((u) => u.rows), added };
    }

    case 'rows': {
      const params = cypherParams();
      statements.push({ kind: 'cypher', text: step.cypher, params });
      const rows = await source.run(step.cypher, params);
      const template = expandTemplateTerms(step.template, subj.prefixes);
      let added = 0;
      if (rows.length) {
        const res = await n20s.projectTemplate(graph, template, rows, 'append');
        statements.push({ kind: 'n20s', call: 'projectTemplate', template, rows: rows.length });
        added = res.added ?? 0;
      }
      return { rows: rows.length, added };
    }

    case 'triples': {
      const texts = [];
      for (const f of asList(step.files)) texts.push(toTurtle(await c.read(f), f));
      if (step.turtle) texts.push(`${Object.entries(subj.prefixes).map(([p, ns]) => `@prefix ${p}: <${ns}> .`).join('\n')}\n${step.turtle}`);
      const res = await n20s.addTurtle(graph, texts, 'append');
      statements.push({ kind: 'n20s', call: 'addTurtle', files: asList(step.files), inline: !!step.turtle });
      return { added: res.added ?? 0, triples: res.triplesAfter ?? null };
    }

    case 'infer': {
      const rules = await rulesOf();
      statements.push({ kind: 'n20s', call: rules ? 'inferWithRules' : 'infer', profile: step.profile ?? '', rules: rules || undefined });
      const res = await n20s.infer(graph, step.profile ?? '', rules || null);
      return { added: res.newTriples ?? 0, triples: res.triplesAfter ?? null, profile: step.profile ?? '' };
    }

    case 'query': {
      const sparql = sparqlOf(step.sparql);
      const rules = await rulesOf();
      statements.push({ kind: 'sparql', text: sparql, profile: step.profile ?? '', rules: rules || undefined });
      const raw = rules ? await n20s.queryWithRules(graph, sparql, rules, step.profile ?? '') : await n20s.query(graph, sparql, step.profile ?? '');
      // node:<id> gives the key of that kind; any gives the key and, in <column>_kind, the label of whatever kind matches.
      const decoders = Object.entries(step.decode ?? {}).map(([col, spec]) => {
        if (spec === 'any') return [col, (v, out) => { const d = v == null ? null : subj.decodeAny(v); out[`${col}_kind`] = d?.label ?? null; return d ? d.key : v; }];
        const [kind, arg] = String(spec).split(/:(.*)/s);
        if (kind !== 'node') throw new Error(`decode ${col}: use node:<node id> or any.`);
        return [col, (v) => (v == null ? v : subj.decode(arg, v) ?? `<undecodable ${v}>`)];
      });
      const rows = raw.map((r) => {
        const out = { ...r };
        for (const [col, d] of decoders) out[col] = d(r[col], out);
        return out;
      });
      return { rows, columns: rows.length ? Object.keys(rows[0]) : [], raw: decoders.length ? raw : undefined };
    }

    case 'construct': {
      const sparql = sparqlOf(step.sparql);
      // from: the CONSTRUCT reads another graph (a precomputed one, or a remote store) and feeds this one.
      const src = step.from ? c.graphs[step.from] : null;
      let triples;
      if (src?.lifecycle === 'remote') {
        statements.push({ kind: 'sparql', text: sparql, construct: true, remote: src.url });
        triples = await src.remote.construct(sparql, { bnodePrefix: `${step.id}_` });
      } else {
        const from = src ? src.name : graph;
        statements.push({ kind: 'sparql', text: sparql, construct: true, ...(step.from ? { from } : {}) });
        triples = await n20s.construct(from, sparql);
      }
      let added = 0;
      if (step.into !== false && triples.length) {
        const res = await n20s.addTriples(graph, triples.map((t) => ({ s: t.subject, p: t.predicate, o: t.object })), 'append');
        statements.push({ kind: 'n20s', call: 'addTriples', triples: triples.length });
        added = res.added ?? 0;
      }
      return { triples: triples.length, added, sample: triples.slice(0, 20) };
    }

    case 'update': {
      const sparql = sparqlOf(step.sparql);
      statements.push({ kind: 'sparql', text: sparql, update: true });
      const res = await n20s.update(graph, sparql);
      return { inserted: res.inserted ?? 0, deleted: res.deleted ?? 0 };
    }

    case 'validate': {
      const rules = await rulesOf();
      statements.push({ kind: 'n20s', call: rules || step.profile ? 'validateWithRules' : 'validate', profile: step.profile ?? '', rules: rules || undefined });
      const res = await n20s.validate(graph, rules || null, step.profile ?? null);
      const violations = res.filter((v) => v.focusNode !== null).map((v) => ({ ...v, lpg: subj.decodeAny(v.focusNode) }));
      return { conforms: violations.length === 0, violations, rows: violations.map((v) => ({ focusNode: v.focusNode, node: v.lpg?.label ?? null, key: v.lpg?.key ?? null, severity: v.severity, message: v.message, path: v.path, value: v.value })) };
    }

    case 'explain': {
      const [s, p, o] = ['s', 'p', 'o'].map((k) => term(step[k], value, subj));
      const rules = await rulesOf();
      statements.push({ kind: 'n20s', call: 'explain', s, p, o, profile: step.profile ?? '', rules: rules || undefined });
      const trace = await n20s.explain(graph, s, p, o, rules || null, step.profile ?? null);
      // Each fact in LPG terms: a projected node as Label(key), other IRIs as prefixed names, literals as they are.
      const show = (x) => {
        if (!x) return x;
        if (x.startsWith('"')) return x.replace(/\^\^<([^>]+)>$/, (m, dt) => `^^${shorten(dt, subj.prefixes)}`);
        const d = subj.decodeAny(x);
        return d ? `${d.label}(${d.key})` : shorten(x, subj.prefixes);
      };
      return {
        statement: { s, p, o },
        rows: trace.map((t) => ({
          step: t.step, depth: t.depth, kind: t.kind, rule: t.rule ?? null,
          fact: `${show(t.subject)} ${show(t.predicate)} ${show(t.object)}`,
          subject: t.subject, predicate: t.predicate, object: t.object,
          subjectLpg: subj.decodeAny(t.subject), objectLpg: t.object && !t.object.startsWith('"') ? subj.decodeAny(t.object) : null,
        })),
      };
    }

    case 'publish': {
      // Fail-closed: a validation gate that found violations stops the publication.
      const gate = (step.gate ?? []).map((g) => {
        const r = c.outputs.get(g) ?? {};
        return { step: g, conforms: r.conforms === true, violations: (r.violations ?? []).length };
      });
      const failed = gate.filter((g) => !g.conforms);
      if (failed.length) throw new Error(`Not published: ${failed.map((g) => `${g.step} found ${g.violations} violation${g.violations === 1 ? '' : 's'}`).join(', ')}.`);
      const g = Object.values(c.graphs).find((x) => x.name === graph);
      statements.push({ kind: 'publish', endpoint: step.as, graph });
      return { as: step.as, graph, base: g?.base ?? graph, description: step.description ?? null, gate };
    }

    default:
      throw new Error(`Unknown step type ${step.type}.`);
  }
}

/** Prefixed names in an inline n20s template (subject, predicates, IRI objects, datatypes) become full IRIs. */
function expandTemplateTerms(template, P) {
  const iri = (v) => (typeof v === 'string' ? expand(v, P).iri ?? v : v);
  const head = (t) => (typeof t === 'string' ? t.replace(/^([A-Za-z][\w-]*):(?!\/\/)/, (m, p) => (P[p] ? P[p] : m)) : t);
  return {
    ...template,
    subject: head(template.subject),
    triples: (template.triples ?? []).map((t) => ({
      ...t,
      predicate: iri(t.predicate),
      ...(t.datatype ? { datatype: iri(t.datatype) } : {}),
      ...(t.kind === 'iri' && typeof t.object === 'string' ? { object: head(t.object) } : {}),
    })),
  };
}
