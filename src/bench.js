// Bench: saved requests against the published endpoints and APIs (and recipes
// not published yet), what each must answer, and how fast.
//
// A collection (bench.yaml, next to the recipes) holds requests:
//   target: { query: <api> }        GET /query/<api> with params (published API)
//   target: { sparql: <endpoint> }  POST /sparql/<endpoint> with the SPARQL (published endpoint)
//   target: { recipe: <id> }        POST /run/<id> with params (a recipe before it is
//                                   published: serve --run, or the studio)
//   expect: { status, rows, minRows, maxRows, contains: [{column: value}], maxMs }
// send() runs one request and checks it; benchmark() repeats it with a given
// concurrency and gives latency percentiles and throughput. Plain fetch: the
// same code runs in the CLI and in the studio page.

export const BENCH_FORMAT = 'n20s-bench/0.1';

/** Method, URL, headers and body of a request of the collection. */
export function httpRequest(item, base) {
  const t = item.target ?? {};
  const url = (p) => new URL(p, base.endsWith('/') ? base : `${base}/`).href;
  const params = item.params ?? {};
  if (t.query) {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])).toString();
    return { method: 'GET', url: url(`query/${encodeURIComponent(t.query)}${qs ? `?${qs}` : ''}`), headers: {}, body: null };
  }
  if (t.sparql) {
    return { method: 'POST', url: url(`sparql/${encodeURIComponent(t.sparql)}`), headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: item.sparql ?? '' };
  }
  if (t.recipe) {
    return { method: 'POST', url: url(`run/${encodeURIComponent(t.recipe)}`), headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) };
  }
  throw new Error(`${item.id}: target needs query, sparql or recipe.`);
}

/** Rows of a response, whatever the endpoint: API and recipe results, SPARQL JSON results. */
export function rowsOf(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.results?.bindings) return body.results.bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])));
  if ('boolean' in body) return [{ boolean: body.boolean }];
  if (body.result?.rows) return body.result.rows;
  return null;
}

/** Assertions of a request on a response: each with ok and what was seen. */
export function checkExpect(expect = {}, res) {
  const out = [];
  const rows = res.rows;
  const add = (name, ok, seen) => out.push({ name, ok, seen });
  add('status', res.status === (expect.status ?? 200), res.status);
  if (expect.rows !== undefined) add(`rows = ${expect.rows}`, rows?.length === expect.rows, rows?.length ?? null);
  if (expect.minRows !== undefined) add(`rows ≥ ${expect.minRows}`, (rows?.length ?? -1) >= expect.minRows, rows?.length ?? null);
  if (expect.maxRows !== undefined) add(`rows ≤ ${expect.maxRows}`, rows !== null && rows.length <= expect.maxRows, rows?.length ?? null);
  for (const want of expect.contains ?? []) {
    const ok = (rows ?? []).some((r) => Object.entries(want).every(([k, v]) => String(r[k]) === String(v)));
    add(`contains ${JSON.stringify(want)}`, ok, ok ? 'yes' : 'no');
  }
  if (expect.maxMs !== undefined) add(`≤ ${expect.maxMs} ms`, res.ms <= expect.maxMs, res.ms);
  return out;
}

/** Sends one request; never throws: a network error is a response with status 0. */
export async function send(item, base, { fetch = globalThis.fetch } = {}) {
  const req = httpRequest(item, base);
  const t0 = performance.now();
  try {
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body ?? undefined });
    const text = await r.text();
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    let body = text;
    try { body = JSON.parse(text); } catch { /* text, N-Triples */ }
    const headers = Object.fromEntries([...r.headers].filter(([k]) => /^(content-type|x-n20s-)/i.test(k)));
    const res = { status: r.status, ms, headers, body, rows: rowsOf(body), request: req };
    return { ...res, checks: checkExpect(item.expect, res) };
  } catch (err) {
    const res = { status: 0, ms: Math.round(performance.now() - t0), headers: {}, body: null, rows: null, request: req, error: err.message };
    return { ...res, checks: checkExpect(item.expect, res) };
  }
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

/** Latency statistics of a list of samples (ms). */
export function stats(samples) {
  const ok = samples.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  const round = (x) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    count: samples.length, errors: samples.filter((s) => !s.ok).length,
    min: round(ok[0] ?? null), p50: round(percentile(ok, 50)), p90: round(percentile(ok, 90)), p95: round(percentile(ok, 95)), p99: round(percentile(ok, 99)), max: round(ok.at(-1) ?? null),
    mean: round(ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null),
  };
}

/**
 * Repeats a request: warm-up calls first (not measured), then iterations with
 * at most `concurrency` in flight. A sample is ok when the status is the one
 * expected (assertions on content are for send()).
 */
export async function benchmark(item, base, { iterations = 20, concurrency = 1, warmup = 2, fetch = globalThis.fetch, onProgress = () => {} } = {}) {
  const want = item.expect?.status ?? 200;
  for (let i = 0; i < warmup; i++) await send(item, base, { fetch });
  const samples = [];
  let next = 0;
  const t0 = performance.now();
  const worker = async () => {
    while (next < iterations) {
      next++;
      const r = await send(item, base, { fetch });
      samples.push({ ms: r.ms, status: r.status, ok: r.status === want });
      onProgress(samples.length, iterations);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, iterations)) }, worker));
  const seconds = (performance.now() - t0) / 1000;
  return { id: item.id, iterations, concurrency, warmup, samples, stats: stats(samples), rps: Math.round((samples.length / seconds) * 10) / 10, seconds: Math.round(seconds * 100) / 100 };
}

/** Structural findings on a collection. */
export function checkBench(bench) {
  const out = [];
  if (bench?.format !== BENCH_FORMAT) out.push(`format: expected ${BENCH_FORMAT}.`);
  const ids = new Set();
  for (const [i, r] of (bench?.requests ?? []).entries()) {
    const at = r?.id ?? `#${i}`;
    if (!r?.id || !/^[A-Za-z][\w.-]*$/.test(r.id)) out.push(`${at}: an id starts with a letter and has letters, digits, ., - and _ only.`);
    else if (ids.has(r.id)) out.push(`${at}: id used twice.`);
    ids.add(r?.id);
    const kinds = ['query', 'sparql', 'recipe'].filter((k) => r?.target?.[k]);
    if (kinds.length !== 1) out.push(`${at}: target needs exactly one of query, sparql, recipe.`);
    if (r?.target?.sparql && !r.sparql) out.push(`${at}: a sparql target needs sparql.`);
  }
  return out;
}
