// Bench tab: saved requests against the published endpoints and APIs, and
// against recipes before publication; send one, see what it answers and
// whether it answers as expected, time it, compare.
import { fill, h, s, api, toast } from './dom.js';
import { send, benchmark, httpRequest } from './bench.js';

const KINDS = {
  query: { text: 'query API', color: '#2e7d32', help: 'published: /query/<api>' },
  sparql: { text: 'SPARQL', color: '#00695c', help: 'published: /sparql/<endpoint>' },
  recipe: { text: 'draft recipe', color: '#e65100', help: 'not published: /run/<recipe>' },
};
const targetKind = (r) => ['query', 'sparql', 'recipe'].find((k) => r?.target?.[k]) ?? 'query';
const base = () => `${location.origin}/`;

let root = null;
let data = null;           // GET /api/bench
let selected = null;       // id of the request in the editor, or null for a new one
let draft = null;          // the request being edited
let responses = {};        // id -> last response
let benches = {};          // id -> last benchmark
let history = [];
let comparing = false;
let busy = '';
const settings = { iterations: 30, concurrency: 4, warmup: 2 };

export async function showBench(container) {
  root = container;
  await load();
  if (!draft) pick(data.bench.requests?.[0]?.id ?? null);
  render();
}

async function load() {
  try { data = await api('/api/bench'); } catch (err) { toast(err.message, true); data = { bench: { requests: [] }, problems: [], targets: { apis: [], endpoints: [], recipes: [] } }; }
}

function pick(id) {
  selected = id;
  comparing = false;
  const r = data.bench.requests?.find((x) => x.id === id);
  draft = r ? structuredClone(r) : { id: '', title: '', target: { query: data.targets.apis[0]?.name ?? '' }, params: {}, expect: { status: 200 } };
}

function render() {
  fill(root,
    h('aside', { class: 'flist' },
      h('div', { class: 'fhead' }, h('div', { class: 'row', style: 'justify-content:space-between' }, 'Bench',
        h('button', { onclick: () => { pick(null); render(); } }, '+ New request')),
        h('div', { class: 'mono', style: 'color:#888;font-weight:400' }, data.file)),
      h('div', { class: 'row', style: 'padding:8px;gap:6px;border-bottom:1px solid var(--line)' },
        h('button', { class: 'primary', disabled: !!busy, onclick: runAll }, 'Send all'),
        h('button', { disabled: !!busy, onclick: benchAll }, 'Benchmark all')),
      data.problems.length ? h('div', { class: 'fail', style: 'padding:8px' }, data.problems.map((p) => h('div', {}, p))) : null,
      (data.bench.requests ?? []).map((r) => {
        const res = responses[r.id];
        const ok = res ? res.checks.every((c) => c.ok) : null;
        return h('div', { class: `qitem${selected === r.id && !comparing ? ' sel' : ''}`, onclick: () => { pick(r.id); render(); } },
          h('div', { class: 'name' }, h('span', { class: 'dot', style: `background:${ok === null ? '#ccc' : ok ? '#2e7d32' : '#c62828'}` }), ' ', r.id),
          h('div', { class: 'meta' }, h('span', { class: 'chip', style: `background:${KINDS[targetKind(r)].color};color:#fff` }, KINDS[targetKind(r)].text), ` ${Object.values(r.target)[0]}`,
            res ? ` · ${res.status} · ${res.ms} ms` : '', benches[r.id] ? ` · p50 ${benches[r.id].stats.p50} ms` : ''));
      })),
    h('section', { class: 'fmain' }, comparing ? compareView() : [editor(), benchBox()]),
    h('aside', { class: 'fpanel' }, responseView()),
  );
}

// Editor -----------------------------------------------------------------------------------------------
function editor() {
  const kind = targetKind(draft);
  const t = data.targets;
  const names = { query: t.apis.map((a) => a.name), sparql: t.endpoints.map((e) => e.name), recipe: t.recipes.map((r) => r.id) }[kind];
  const declared = kind === 'query' ? t.apis.find((a) => a.name === draft.target.query)?.params
    : kind === 'recipe' ? t.recipes.find((r) => r.id === draft.target.recipe)?.params : null;
  const set = (fn) => (e) => { fn(e.target.value); render(); };
  let preview;
  try { const r = httpRequest(draft, base()); preview = `${r.method} ${r.url}${r.body ? `\n\n${r.body}` : ''}`; } catch (err) { preview = err.message; }

  const typeSel = h('select', { onchange: set((v) => { draft.target = { [v]: { query: t.apis[0]?.name, sparql: t.endpoints[0]?.name, recipe: t.recipes[0]?.id }[v] ?? '' }; draft.params = {}; if (v === 'sparql') draft.sparql ??= 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10'; }) },
    Object.entries(KINDS).map(([k, x]) => h('option', { value: k, selected: k === kind }, `${x.text} — ${x.help}`)));
  const nameSel = h('select', { onchange: set((v) => { draft.target = { [kind]: v }; draft.params = {}; }) },
    names.length ? names.map((n) => h('option', { value: n, selected: n === draft.target[kind] }, n)) : h('option', { value: '' }, '(none available)'));
  const expect = draft.expect ?? {};
  const num = (k) => h('input', { value: expect[k] ?? '', style: 'width:80px', oninput: (e) => { draft.expect = { ...draft.expect }; if (e.target.value === '') delete draft.expect[k]; else draft.expect[k] = Number(e.target.value); } });
  const contains = h('input', { value: expect.contains ? JSON.stringify(expect.contains) : '', placeholder: '[{"agent": "Alice"}]', class: 'mono',
    onchange: (e) => { try { draft.expect = { ...draft.expect }; if (e.target.value.trim()) draft.expect.contains = JSON.parse(e.target.value); else delete draft.expect.contains; } catch { toast('contains: a JSON list of objects', true); } } });

  return h('div', { class: 'beditor' },
    h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
      h('label', { class: 'ffield' }, h('span', {}, 'id'), h('input', { value: draft.id, oninput: (e) => { draft.id = e.target.value; }, style: 'width:180px' })),
      h('label', { class: 'ffield', style: 'flex:1' }, h('span', {}, 'title'), h('input', { value: draft.title ?? '', oninput: (e) => { draft.title = e.target.value; } }))),
    h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;margin-top:6px' },
      h('label', { class: 'ffield' }, h('span', {}, 'target'), typeSel),
      h('label', { class: 'ffield' }, h('span', {}, kind === 'sparql' ? 'endpoint' : kind === 'recipe' ? 'recipe' : 'API'), nameSel)),
    kind === 'sparql'
      ? h('label', { class: 'ffield' }, h('span', {}, 'SPARQL'), h('textarea', { class: 'mono', rows: 6, spellcheck: 'false', oninput: (e) => { draft.sparql = e.target.value; } }, draft.sparql ?? ''))
      : h('div', { class: 'ffield' }, h('span', {}, 'parameters'),
        Object.keys(declared ?? {}).length ? h('table', { class: 'props' }, Object.entries(declared).map(([k, d]) => h('tr', {},
          h('th', { title: d?.description ?? '' }, `${k}${d?.type ? ` (${d.type})` : ''}`),
          h('td', {}, h('input', { value: draft.params?.[k] ?? '', placeholder: d?.default !== undefined ? `default: ${d.default}` : 'required', oninput: (e) => { draft.params = { ...draft.params }; if (e.target.value === '') delete draft.params[k]; else draft.params[k] = e.target.value; } })))))
          : h('div', { style: 'color:#888' }, 'No parameters.')),
    h('div', { class: 'ffield' }, h('span', {}, 'expect'),
      h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' }, 'status', num('status'), 'rows', num('rows'), 'min', num('minRows'), 'max', num('maxRows'), 'ms ≤', num('maxMs')),
      h('div', { class: 'row', style: 'gap:6px;margin-top:4px' }, 'contains', contains)),
    h('pre', { class: 'stmt', style: 'margin-top:8px' }, preview),
    h('div', { class: 'row', style: 'gap:6px;margin-top:6px' },
      h('button', { class: 'primary', disabled: !!busy, onclick: () => sendOne(draft) }, 'Send'),
      h('button', { onclick: save }, selected ? 'Save' : 'Save to the collection'),
      selected ? h('button', { onclick: () => { selected = null; draft = { ...structuredClone(draft), id: `${draft.id}-copy` }; render(); } }, 'Duplicate') : null,
      selected ? h('button', { class: 'bad', onclick: remove }, 'Delete') : null,
      kind === 'recipe' ? h('span', { style: 'color:#888' }, 'A draft recipe runs through /run: the studio has it, serve needs --run.') : null));
}

async function save() {
  if (!draft.id) return toast('Give the request an id.', true);
  const request = Object.fromEntries(Object.entries(draft).filter(([k, v]) => v !== '' && v !== undefined && !(k === 'params' && !Object.keys(v ?? {}).length) && !(k === 'sparql' && targetKind(draft) !== 'sparql')));
  try {
    data = await api('/api/bench/save', { request, previous: selected });
    selected = draft.id;
    toast(`Saved ${draft.id} in ${data.file}`);
  } catch (err) { toast(err.message, true); }
  render();
}

async function remove() {
  if (!confirm(`Delete ${selected} from the collection?`)) return;
  try { data = await api('/api/bench/delete', { id: selected }); delete responses[selected]; pick(data.bench.requests?.[0]?.id ?? null); } catch (err) { toast(err.message, true); }
  render();
}

async function sendOne(item) {
  busy = 'send';
  render();
  const r = await send(item, base());
  const id = item.id || '(unsaved)';
  responses[id] = r;
  history = [{ id, status: r.status, ms: r.ms, ok: r.checks.every((c) => c.ok), at: new Date().toLocaleTimeString() }, ...history].slice(0, 20);
  busy = '';
  render();
}

async function runAll() {
  busy = 'all';
  render();
  for (const r of data.bench.requests ?? []) responses[r.id] = await send(r, base());
  busy = '';
  const failed = (data.bench.requests ?? []).filter((r) => !responses[r.id].checks.every((c) => c.ok));
  toast(failed.length ? `${failed.length} request${failed.length > 1 ? 's' : ''} do not answer as expected: ${failed.map((r) => r.id).join(', ')}` : `All ${data.bench.requests.length} requests answer as expected`, failed.length > 0);
  render();
}

// Benchmark ---------------------------------------------------------------------------------------------
function benchBox() {
  const b = benches[draft.id || '(unsaved)'];
  const field = (k, label) => h('label', { class: 'row', style: 'gap:4px' }, label, h('input', { value: settings[k], style: 'width:64px', oninput: (e) => { settings[k] = Math.max(k === 'warmup' ? 0 : 1, Number(e.target.value) || 0); } }));
  return h('div', { class: 'bbox' },
    h('h3', {}, 'Benchmark'),
    h('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap' }, field('iterations', 'iterations'), field('concurrency', 'concurrency'), field('warmup', 'warm-up'),
      h('button', { disabled: !!busy, onclick: async () => {
        busy = 'bench';
        const id = draft.id || '(unsaved)';
        const progress = h('span', { style: 'color:#666' });
        render();
        root.querySelector('.bbox')?.append(progress);
        benches[id] = await benchmark(draft, base(), { ...settings, onProgress: (n, total) => { progress.textContent = ` ${n}/${total}`; } });
        busy = '';
        render();
      } }, busy === 'bench' ? 'Running…' : 'Run benchmark')),
    b ? [statsTable([[draft.id || '(unsaved)', b]]), histogram(b)] : h('div', { style: 'color:#888;margin-top:6px' }, 'Warm-up calls are not measured. A sample counts as an error when its status is not the expected one.'));
}

function statsTable(rows) {
  return h('table', { class: 'props', style: 'margin-top:8px' },
    h('tr', {}, ['request', 'n', 'errors', 'min', 'p50', 'p90', 'p95', 'p99', 'max', 'mean', 'req/s'].map((c) => h('th', {}, c))),
    rows.map(([id, b]) => h('tr', {}, [id, b.stats.count, b.stats.errors, b.stats.min, b.stats.p50, b.stats.p90, b.stats.p95, b.stats.p99, b.stats.max, b.stats.mean, b.rps].map((v, i) => h('td', { class: i ? 'mono' : '' }, v ?? '—')))));
}

/** Latency histogram of the samples (ms). */
function histogram(b) {
  const ms = b.samples.filter((x) => x.ok).map((x) => x.ms);
  if (!ms.length) return null;
  const lo = Math.min(...ms);
  const hi = Math.max(...ms);
  const bins = 20;
  const width = (hi - lo) / bins || 1;
  const counts = Array(bins).fill(0);
  for (const x of ms) counts[Math.min(bins - 1, Math.floor((x - lo) / width))]++;
  const W = 520;
  const H = 120;
  const max = Math.max(...counts);
  const bw = W / bins;
  const mark = (v, label, color, y) => { const x = ((v - lo) / (hi - lo || 1)) * W; return [s('line', { x1: x, x2: x, y1: 0, y2: H, stroke: color, 'stroke-dasharray': '4 3' }), s('text', { x: x + 3, y, fill: color, 'font-size': 11, 'paint-order': 'stroke', stroke: '#fff', 'stroke-width': 3 }, `${label} ${v}`)]; };
  return s('svg', { viewBox: `0 0 ${W} ${H + 18}`, width: '100%', style: 'max-width:560px;margin-top:8px' },
    counts.map((c, i) => s('rect', { x: i * bw + 1, y: H - (c / max) * H, width: bw - 2, height: (c / max) * H, fill: '#90caf9' })),
    mark(b.stats.p50, 'p50', '#1565c0', 12), mark(b.stats.p95, 'p95', '#e65100', 26),
    s('text', { x: 0, y: H + 14, 'font-size': 11, fill: '#666' }, `${lo} ms`), s('text', { x: W, y: H + 14, 'font-size': 11, fill: '#666', 'text-anchor': 'end' }, `${hi} ms`));
}

async function benchAll() {
  comparing = true;
  busy = 'all';
  render();
  for (const r of data.bench.requests ?? []) {
    benches[r.id] = await benchmark(r, base(), settings);
    render();
  }
  busy = '';
  render();
}

function compareView() {
  const rows = (data.bench.requests ?? []).filter((r) => benches[r.id]).map((r) => [r.id, benches[r.id], r]);
  const max = Math.max(1, ...rows.map(([, b]) => b.stats.p95 ?? 0));
  return h('div', { class: 'beditor' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h3', { style: 'margin:0' }, `Compared: ${settings.iterations} iterations, concurrency ${settings.concurrency}${busy ? ' (running…)' : ''}`),
      h('button', { onclick: () => { comparing = false; render(); } }, 'Back to the editor')),
    statsTable(rows.map(([id, b]) => [id, b])),
    h('div', { style: 'margin-top:12px' }, rows.map(([id, b, r]) => h('div', { class: 'bbar' },
      h('span', { class: 'mono', style: 'width:150px;display:inline-block' }, id),
      h('span', { class: 'chip', style: `background:${KINDS[targetKind(r)].color};color:#fff;width:84px;text-align:center` }, KINDS[targetKind(r)].text),
      h('span', { class: 'track' },
        h('span', { class: 'p95', style: `width:${((b.stats.p95 ?? 0) / max) * 100}%` }),
        h('span', { class: 'p50', style: `width:${((b.stats.p50 ?? 0) / max) * 100}%` })),
      h('span', { class: 'mono', style: 'color:#555' }, ` p50 ${b.stats.p50} · p95 ${b.stats.p95} ms · ${b.rps} req/s${b.stats.errors ? ` · ${b.stats.errors} errors` : ''}`)))),
    h('div', { style: 'color:#888;margin-top:8px' }, 'Dark: p50, light: p95. Same question, different kinds: what precomputation buys.'));
}

// Response ----------------------------------------------------------------------------------------------
function responseView() {
  const r = responses[draft?.id || '(unsaved)'];
  return [
    h('h2', {}, 'Response'),
    !r ? h('div', { style: 'color:#888' }, busy === 'send' ? 'Sending…' : 'Send the request to see what it answers.') : [
      h('div', {}, h('span', { class: `chip ${r.status >= 200 && r.status < 300 ? 'accepted' : 'error'}` }, r.status || 'no answer'), ` ${r.ms} ms`, r.rows ? ` · ${r.rows.length} row${r.rows.length === 1 ? '' : 's'}` : ''),
      r.error ? h('div', { class: 'fail' }, r.error) : null,
      h('h3', {}, 'Checks'),
      r.checks.map((c) => h('div', { class: c.ok ? 'pass' : 'fail' }, `${c.ok ? '✓' : '✗'} ${c.name}`, c.ok ? '' : h('span', { style: 'font-weight:400' }, ` — got ${c.seen}`))),
      Object.keys(r.headers).length ? [h('h3', {}, 'Headers'), h('table', { class: 'props' }, Object.entries(r.headers).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { class: 'mono' }, v))))] : null,
      h('h3', {}, 'Body'),
      r.rows?.length ? table(r.rows.slice(0, 50)) : null,
      h('details', { open: !r.rows?.length }, h('summary', { style: 'cursor:pointer;color:#666' }, 'Raw'), h('pre', { class: 'stmt', style: 'max-height:320px;overflow:auto' }, typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 1))),
    ],
    history.length ? [h('h3', {}, 'History'), h('table', { class: 'props' }, history.map((x) => h('tr', {}, h('td', {}, x.at), h('td', { class: 'mono' }, x.id), h('td', { class: x.ok ? 'pass' : 'fail' }, x.status), h('td', { class: 'mono' }, `${x.ms} ms`))))] : null,
  ];
}

function table(rows) {
  const cols = Object.keys(rows[0]);
  const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return h('table', { class: 'props' }, h('tr', {}, cols.map((c) => h('th', {}, c))), rows.map((x) => h('tr', {}, cols.map((c) => h('td', { class: 'mono' }, cell(x[c]))))));
}
