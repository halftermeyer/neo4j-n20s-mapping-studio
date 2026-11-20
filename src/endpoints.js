// HTTP endpoints over the recipes of a directory:
//   /sparql/<endpoint>  SPARQL 1.1 Protocol, read-only, on the graph a recipe
//                       published under that name (a publish step): a
//                       precomputed graph, swapped to its new version only once
//                       complete and through its validation gates. n20s-server
//                       itself is not a SPARQL endpoint. SELECT and ASK answer
//                       application/sparql-results+json, CONSTRUCT
//                       application/n-triples. The status of the graph (stable,
//                       stale, incomplete) is in X-N20s-Graph-Status.
//   /sparql             the endpoints, with the status of their graph.
//   /query/<api>        a recipe that declares an api, run on each call with the
//                       parameters of the query string or JSON body (typed as
//                       the recipe declares them): its ephemeral graphs are
//                       scoped for the call (lazy), its published ones read as
//                       they are (precomputed). Returns what its result step found.
//   /query              the query APIs, their parameters and kind.
//   /run/<recipe>       any recipe (allowRun only: the studio, serve --run).
// Used by `n20s-mapping serve` and mounted in the studio.
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { loadRecipe, recordRecipeRun, graphsReport, publishedResolver, UsageError } from './node.js';
import { runRecipe, graphsOf, recipeKind, coerceParams } from './recipe.js';

const JSON_TYPE = 'application/json';
const SPARQL_JSON = 'application/sparql-results+json';
/** SPARQL comments: # at the start of a line or after a space (a # inside an IRI is not one). */
const uncomment = (q) => String(q).replace(/(^|\s)#[^\n]*/g, '$1');

const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * A value of an n20s query row asked with terms: true, as a SPARQL JSON results
 * term: "lex", "lex"@lang and "lex"^^<dt> are literals, _:label blank nodes,
 * anything else an IRI. Numbers and booleans (rows asked without terms) are
 * typed literals.
 */
export function sparqlTerm(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return { type: 'literal', value: String(v), datatype: XSD + (Number.isInteger(v) ? 'integer' : 'decimal') };
  if (typeof v === 'boolean') return { type: 'literal', value: String(v), datatype: `${XSD}boolean` };
  const s = String(v);
  if (s.startsWith('_:')) return { type: 'bnode', value: s.slice(2) };
  if (s.startsWith('"')) {
    const m = /^"([\s\S]*)"(?:@([\w-]+)|\^\^<([^>]+)>)?$/.exec(s);
    if (m) {
      const value = m[1].replace(/\\(["\\nrt])/g, (x, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c));
      return { type: 'literal', value, ...(m[2] ? { 'xml:lang': m[2] } : {}), ...(m[3] ? { datatype: m[3] } : {}) };
    }
  }
  return { type: 'uri', value: s };
}

/** The query form, after PREFIX and BASE declarations and comments. */
export function queryForm(q) {
  const body = uncomment(q).replace(/^\s*((PREFIX\s+[\w-]*:\s*<[^>]*>|BASE\s+<[^>]*>)\s*)*/i, '');
  return (/^\s*(SELECT|ASK|CONSTRUCT|DESCRIBE|INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD|WITH)\b/i.exec(body)?.[1] ?? '').toUpperCase();
}

/** Projected variables of a SELECT, in order; null for SELECT *. */
export function selectVars(q) {
  const m = /\bSELECT\s+(?:DISTINCT\s+|REDUCED\s+)?([\s\S]*?)\s*(?:WHERE\s*)?\{/i.exec(uncomment(q));
  if (!m || /^\*/.test(m[1].trim())) return null;
  const vars = [];
  for (const x of m[1].matchAll(/\(\s*[\s\S]*?\s+AS\s+[?$](\w+)\s*\)|[?$](\w+)/gi)) vars.push(x[1] ?? x[2]);
  return [...new Set(vars)];
}

const ntTerm = (t) => (t.startsWith('_:') || t.startsWith('"') ? t : `<${t}>`);

/**
 * @param {{recipesDir: string, n20s: object, openSource?: (() => object)|null, allowRun?: boolean}} o
 * @returns {(req: import('node:http').IncomingMessage, url: URL) => Promise<null | {status: number, type: string, body: string, headers?: object}>}
 *          null when the path is not one of these endpoints
 */
export function endpoints({ recipesDir, n20s, openSource = null, allowRun = false }) {
  const json = (status, data, headers) => ({ status, type: JSON_TYPE, body: JSON.stringify(data, null, 1), headers });
  const fail = (status, error) => json(status, { error });

  async function readBody(req) {
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 1e6) throw new UsageError('Request too large.');
    }
    return text;
  }

  async function recipes() {
    let files = [];
    try { files = (await fs.readdir(recipesDir)).filter((f) => /\.recipe\.ya?ml$/.test(f)).sort(); } catch { /* none */ }
    const out = [];
    for (const file of files) {
      try {
        const r = YAML.parse(await fs.readFile(path.join(recipesDir, file), 'utf8'));
        out.push({ id: r.id, file, title: r.title ?? r.id, params: r.params ?? {}, graphs: graphsOf(r), kind: recipeKind(r), api: r.api ?? null });
      } catch { /* broken files are the studio's business */ }
    }
    return out;
  }

  async function sparql(req, url, endpoint) {
    const report = await graphsReport(recipesDir, n20s);
    const e = report.endpoints.find((x) => x.endpoint === endpoint);
    if (!e) return fail(404, `No endpoint ${endpoint}: a recipe publishes it with a publish step. GET /sparql lists them.`);
    if (e.status === 'missing') return fail(404, `Endpoint ${endpoint} serves ${e.graph}, which is not in n20s-server (restarted?): re-publish it.`);
    const name = e.graph;
    const g = { status: e.status, built: e.published };
    let query = url.searchParams.get('query');
    if (req.method === 'POST') {
      const body = await readBody(req);
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
      if (type === 'application/sparql-query') query = body;
      else if (type === 'application/x-www-form-urlencoded') query = new URLSearchParams(body).get('query');
      else if (type === 'application/sparql-update' || new URLSearchParams(body).has('update')) return fail(400, 'Read-only endpoint: run a recipe to change a graph.');
    }
    if (!query) return fail(400, 'No query: GET ?query=… or POST application/sparql-query.');
    const headers = { 'X-N20s-Graph-Status': g.status, 'X-N20s-Graph': name, 'X-N20s-Graph-Published': `${g.built.recipe} ${g.built.at}` };
    const form = queryForm(query);
    if (form === 'SELECT') {
      const rows = await n20s.query(name, query, '', { terms: true });
      const vars = selectVars(query) ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const bindings = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, sparqlTerm(v)])));
      return { status: 200, type: SPARQL_JSON, body: JSON.stringify({ head: { vars }, results: { bindings } }), headers };
    }
    if (form === 'ASK') {
      const select = `${query.replace(/\bASK\s*(WHERE\s*)?(?=\{)/i, 'SELECT * WHERE ')} LIMIT 1`;
      const rows = await n20s.query(name, select);
      return { status: 200, type: SPARQL_JSON, body: JSON.stringify({ head: {}, boolean: rows.length > 0 }), headers };
    }
    if (form === 'CONSTRUCT') {
      const triples = await n20s.construct(name, query);
      return { status: 200, type: 'application/n-triples', body: triples.map((t) => `${ntTerm(t.subject)} ${ntTerm(t.predicate)} ${ntTerm(t.object)} .`).join('\n') + (triples.length ? '\n' : ''), headers };
    }
    if (['INSERT', 'DELETE', 'LOAD', 'CLEAR', 'CREATE', 'DROP', 'COPY', 'MOVE', 'ADD', 'WITH'].includes(form)) return fail(400, 'Read-only endpoint: run a recipe to change a graph.');
    return fail(400, `${form || 'This query form'} is not supported: SELECT, ASK and CONSTRUCT are.`);
  }

  async function readParams(req, url) {
    let params = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'trace'));
    if (req.method === 'POST') {
      const text = await readBody(req);
      if (text.trim()) params = { ...params, ...JSON.parse(text) };
    }
    return params;
  }

  /** Runs a recipe file and answers with what its result step found. */
  async function execute(r, given, url, resultStep = null) {
    if (!openSource) return fail(400, 'Running recipes needs a source (--source).');
    const file = path.join(recipesDir, r.file);
    const f = await loadRecipe(file);
    const { params, errors } = coerceParams(f.recipe, given);
    if (errors.length) return fail(400, errors.join(' '));
    const source = openSource();
    try {
      const run = await runRecipe({ ...f, params, source, n20s, resolvePublished: publishedResolver(recipesDir) });
      await recordRecipeRun(file, run, f, { source: { url: source.url }, n20s });
      const pick = resultStep
        ? run.steps.find((s) => s.id === resultStep && s.status === 'ok')
        : [...run.steps].reverse().find((s) => s.role === 'ask' && s.status === 'ok');
      const result = pick ? {
        step: pick.id, type: pick.type,
        ...(pick.type === 'validate' ? { conforms: pick.result.conforms } : {}),
        columns: pick.result.rows?.length ? Object.keys(pick.result.rows[0]).filter((k) => !['subjectLpg', 'objectLpg'].includes(k)) : (pick.result.columns ?? []),
        rows: pick.result.rows,
      } : null;
      const failed = run.steps.find((s) => s.status === 'error');
      return json(run.ok ? 200 : 422, {
        recipe: run.recipe, kind: run.kind, runId: run.runId, ok: run.ok, ms: run.ms, params: run.params,
        ...(failed ? { error: `${failed.id}: ${failed.error}` } : {}),
        result,
        ...(url.searchParams.has('trace') ? { trace: run } : {}),
      });
    } finally {
      await source.close();
    }
  }

  async function runOne(req, url, id) {
    const r = (await recipes()).find((x) => x.id === id);
    if (!r) return fail(404, `No recipe ${id}. GET /run lists them.`);
    return execute(r, await readParams(req, url), url);
  }

  async function queryApi(req, url, name) {
    const r = (await recipes()).find((x) => x.api?.name === name);
    if (!r) return fail(404, `No query API ${name}: a recipe declares it with api: { name }. GET /query lists them.`);
    return execute(r, await readParams(req, url), url, r.api.result ?? null);
  }

  return async function handle(req, url) {
    const p = url.pathname;
    try {
      if (p === '/sparql' && req.method === 'GET') {
        const report = await graphsReport(recipesDir, n20s);
        return json(200, { endpoints: report.endpoints.map((e) => ({
          endpoint: `/sparql/${e.endpoint}`, name: e.endpoint, status: e.status, reasons: e.reasons, graph: e.graph, triples: e.triples,
          recipe: e.published.recipe, published: e.published.at, description: e.published.description,
        })) });
      }
      let m = /^\/sparql\/([\w.-]+)$/.exec(p);
      if (m && (req.method === 'GET' || req.method === 'POST')) return await sparql(req, url, m[1]);
      if (p === '/query' && req.method === 'GET') {
        return json(200, { apis: (await recipes()).filter((r) => r.api).map((r) => ({
          endpoint: `/query/${r.api.name}`, name: r.api.name, description: r.api.description ?? r.title, kind: r.kind, recipe: r.id,
          params: Object.fromEntries(Object.entries(r.params).map(([k, d]) => [k, { type: d?.type ?? 'string', default: d?.default ?? null, description: d?.description ?? null }])),
        })) });
      }
      m = /^\/query\/([\w.-]+)$/.exec(p);
      if (m && (req.method === 'GET' || req.method === 'POST')) return await queryApi(req, url, m[1]);
      if (!allowRun) return null;
      if (p === '/run' && req.method === 'GET') return json(200, { recipes: (await recipes()).map((r) => ({ ...r, endpoint: `/run/${r.id}` })) });
      m = /^\/run\/([\w-]+)$/.exec(p);
      if (m && (req.method === 'GET' || req.method === 'POST')) return await runOne(req, url, m[1]);
      return null;
    } catch (err) {
      return fail(err instanceof UsageError || err instanceof SyntaxError ? 400 : /^n20s .*: 400/.test(err.message) ? 400 : 500, err.message);
    }
  };
}
