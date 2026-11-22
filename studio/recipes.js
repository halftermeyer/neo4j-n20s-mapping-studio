// Recipes tab: a recipe as a sequence of steps on named n20s graphs. Each step
// feeds a graph, changes it, or asks it; the page shows the state of the graph
// after each step and what it holds, and lets you build the recipe from scratch.
import { fill, h, api, toast, tid } from './dom.js';

const ROLE = {
  feed: { icon: '＋', text: 'feeds', color: '#1565c0' },
  change: { icon: '⟳', text: 'changes', color: '#6a1b9a' },
  ask: { icon: '?', text: 'asks', color: '#2e7d32' },
  publish: { icon: '⇪', text: 'publishes', color: '#00695c' },
  write: { icon: '⤓', text: 'writes back from', color: '#b71c1c' },
};
const KIND = {
  build: { text: 'build', color: '#6a1b9a', help: 'writes a persistent graph, usually to publish it' },
  precomputed: { text: 'precomputed', color: '#00695c', help: 'only reads published graphs or remote stores: nothing is projected per call' },
  lazy: { text: 'lazy', color: '#1565c0', help: 'scopes ephemeral graphs on each run: only what the question needs' },
  hybrid: { text: 'hybrid', color: '#e65100', help: 'scopes on demand and reads published graphs or remote stores' },
};
const kindChip = (k) => (k ? h('span', { class: 'chip', style: `background:${KIND[k].color};color:#fff`, title: KIND[k].help }, KIND[k].text) : null);
const TYPE_TEXT = {
  scope: 'Cypher scope, projected through the mapping', rows: 'Cypher rows through a template', triples: 'static triples (ontology, shapes)',
  infer: 'forward inference, materialized', construct: 'SPARQL CONSTRUCT, added to the graph', update: 'SPARQL update',
  query: 'SPARQL', validate: 'SHACL validation', explain: 'explanation of a statement', publish: 'serve a persistent graph as a SPARQL endpoint',
  write: 'write what a query found back into Neo4j: a label, a relationship or a property the LPG ontology declares as inferred',
};
const ROLE_OF = { scope: 'feed', rows: 'feed', triples: 'feed', infer: 'change', construct: 'change', update: 'change', query: 'ask', validate: 'ask', explain: 'ask', publish: 'publish', write: 'write' };
const EDITABLE = {
  scope: ['cypher', 'params'], rows: ['cypher', 'params', 'template'], triples: ['files', 'turtle'], infer: ['profile', 'rules'],
  query: ['sparql', 'decode', 'profile', 'rules'], construct: ['from', 'sparql'], update: ['sparql'], validate: ['profile', 'rules'],
  explain: ['s', 'p', 'o', 'profile', 'rules'], publish: ['as', 'gate', 'description'],
  write: ['from', 'label', 'relationship', 'property', 'retract', 'gate', 'decode'],
};
const MULTILINE = ['cypher', 'sparql', 'rules', 'turtle', 'params', 'decode', 'template', 'files', 'gate', 'label', 'relationship', 'property'];
const PROFILES = ['', 'RDFS', 'OWL_MICRO', 'OWL_MINI', 'OWL'];
const HELP = {
  cypher: 'Recipe parameters and the keys of params are $name. A scope returns nodes or paths; the mapping projects them.',
  params: 'Cypher parameters of this step, one per line: name: $param, or name: $step.column (a result of an earlier step)',
  decode: 'One per line: column: node:<node id> (its key), or column: any (key and kind)',
  files: 'One file per line, relative to the recipe file: ontologies, shapes (Turtle, N-Triples, N-Quads)',
  template: 'n20s template (JSON or YAML): subject and triples, prefixed names allowed',
  sparql: 'Prefixes of the mapping are declared. {{<node id>|$x}} gives IRIs, {{literal|$x}} literals.',
  rules: 'Jena rules; prefixed names of the mapping work.',
  profile: 'With a profile or rules, the reasoning is done for this step only (backward); infer materializes it (forward).',
  as: 'Endpoint name: served as /sparql/<name>, pointed at this run\'s graph once the run goes through.',
  gate: 'Validate steps, one per line: if one found violations, nothing is published and the endpoint keeps its graph.',
  from: 'Graph the CONSTRUCT reads (a published one, for instance); what it builds goes into this step\'s graph.',
  description: 'Shown with the endpoint.',
  label: 'node: <column decoded node:<id>>, add: <label declared as inferred by this step>',
  relationship: 'from: <column>, type: <TYPE declared as inferred by this step>, to: <column>',
  property: 'node: <column>, set: <property declared as inferred by this step>, value: <column>',
  retract: 'scope (default): what is no longer found is removed on the scoped nodes only; all: everywhere (refused when the scope is partial)',
};

let root = null;
let list = null;
let current = null;     // POST /api/recipe
let run = null;
let selected = null;
let params = {};
let running = false;
let patch = null;        // POST /api/ontology-patch: what the LPG ontology must declare for the writes
let republished = null;  // the last Re-publish of an endpoint: { endpoint, run }
let written = null;      // POST /api/graphs/written: what the write steps hold in Neo4j now

/** One line per write step: what it wrote, or that nothing changed. */
const writeLines = (writes, as) => writes.map((w) => h('div', { class: w.error ? 'warnline' : w.written ? 'okline' : 'hint', 'data-testid': `write-line-${w.step}` },
  w.error ? `${w.step}: ${w.error}`
    : `${w.step} — ${w.kind === 'label' ? `:${w.name} on ${w.on}` : w.kind === 'relationship' ? w.name : `${w.on}.${w.name}`}: ${w.written ? `+${w.added} −${w.removed}, written${as ? ` as ${as}` : ''}` : `unchanged, nothing written${w.counters ? ` (counters ${Object.values(w.counters).reduce((a, b) => a + b, 0) === 0 ? 'all at 0' : JSON.stringify(w.counters)})` : ''}`}`));
let creating = false;
let addingParam = false;
let editingGraph = null; // graph key being edited, or '' for a new one
let graphs = null;       // GET /api/graphs: the graphs of n20s-server and of the registry
let view = null;         // { kind: 'graph' | 'endpoint' | 'api', name } shown in the panel instead of a step
let apis = [];           // GET /query: the query APIs
let apiValues = {};
let apiResult = null;
let editingApi = false;
let sparqlText = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 20';
let sparqlResult = null;
let cdc = null;
let apiCalls = 0;         // answers so far, for the demo recorder: api-result-<n>, sparql-result-<n>
let sparqlAsks = 0;           // GET /api/cdc: can a publication follow the database?
let followTimer = null;   // refreshes the endpoint list while a publication follows the database

const STATUS_TEXT = {
  stable: 'built by a recipe that finished, from the mapping and LPG ontology as they are now',
  stale: 'something changed since the build: rebuild it',
  incomplete: 'the last build stopped on an error',
  missing: 'recorded but not in n20s-server (restarted?): rebuild it',
  unknown: 'not built by a recipe of this directory',
  other: 'built elsewhere in the project (another mapping, the oracle)',
};

async function loadGraphs() {
  try { graphs = await api('/api/graphs'); } catch (err) { graphs = { graphs: [], endpoints: [], can: false, error: err.message }; }
  try { apis = graphs.can ? (await api('/query')).apis : []; } catch { apis = []; }
  watchFollowing();
}

export async function showRecipes(container) {
  root = container;
  if (!list) {
    try { list = await api('/api/recipes'); } catch (err) { toast(err.message, true); return; }
    if (list.recipes[0] && !current) await open(list.recipes.find((f) => !f.error)?.file);
  }
  await loadGraphs();
  render();
}

async function open(file) {
  if (!file) return;
  view = null;
  try {
    current = await api('/api/recipe', { file });
    run = null;
    selected = current.recipe.steps[0]?.id ?? null;
    params = Object.fromEntries(Object.entries(current.recipe.params ?? {}).map(([k, d]) => [k, d?.default ?? '']));
  } catch (err) {
    toast(err.message, true);
  }
  render();
}

async function change(path, body, done) {
  try {
    current = await api(path, { file: current.file, ...body });
    const entry = list.recipes.find((f) => f.file === current.file);
    if (entry) Object.assign(entry, { steps: current.recipe.steps.length, title: current.recipe.title ?? current.recipe.id });
    if (done) toast(done);
  } catch (err) {
    toast(err.message, true);
  }
  render();
}

function render() {
  fill(root,
    h('aside', { class: 'flist' },
      h('div', { class: 'fhead' }, h('div', { class: 'row', style: 'justify-content:space-between' }, 'Recipes', h('button', { onclick: () => { creating = true; render(); } }, '+ New recipe')),
        h('div', { class: 'mono', style: 'color:#888;font-weight:400' }, list.dir.split('/').slice(-3).join('/'))),
      creating ? newRecipeForm() : null,
      list.recipes.length ? list.recipes.map((f) => h('div', {
        class: `qitem${current?.file === f.file ? ' sel' : ''}`, onclick: () => open(f.file), 'data-testid': `recipe-${tid(f.id ?? f.file)}`,
      }, h('div', { class: 'name' }, f.title ?? f.file),
      h('div', { class: 'meta' }, f.error ? h('span', { class: 'chip error' }, f.error) : [kindChip(f.kind), ` ${f.steps} steps · ${f.file}`,
        f.api ? h('span', { class: 'chip', title: 'query API' }, `/query/${f.api}`) : ''])))
        : h('div', { style: 'padding:14px;color:#888' }, 'No *.recipe.yaml in this directory.'),
      services()),
    current ? h('section', { class: 'fmain' }, header(), graphsBar(), sequence(), trace()) : h('section', { class: 'fmain' }, h('div', { style: 'padding:30px;color:#888' }, 'Select a recipe.')),
    h('aside', { class: 'fpanel' }, view?.kind === 'graph' ? graphPanel() : view?.kind === 'endpoint' ? endpointPanel() : view?.kind === 'api' ? apiPanel() : current ? stepPanel() : null),
  );
}

const show = (kind, name) => {
  view = { kind, name }; sparqlResult = null; apiResult = null; render();
  if (kind === 'endpoint') api('/api/cdc').then((c) => { cdc = c; render(); }).catch((err) => { cdc = { available: false, message: err.message }; render(); });
};

/** While a publication follows the database, its state (syncing, rebuilt) is refreshed every two seconds. */
function watchFollowing() {
  const following = graphs?.endpoints?.some((e) => e.follow);
  if (following && !followTimer && root?.isConnected !== false) {
    followTimer = setInterval(async () => {
      if (!root || root.hidden || !root.isConnected) return;
      // Graphs come and go (a run's ephemeral graphs): their names are part of what is shown.
      const shown = () => JSON.stringify([graphs?.endpoints?.map((e) => [e.graph, e.follow?.state, e.follow?.syncs, e.follow?.ownSkipped]), graphs?.graphs?.map((g) => g.name)]);
      const before = shown();
      await loadGraphs();
      if (shown() !== before) render();
      if (!graphs?.endpoints?.some((e) => e.follow)) { clearInterval(followTimer); followTimer = null; }
    }, 2000);
  }
}
const at = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');

/** Follow the database: available only when Change Data Capture is on, in FULL mode. */
function followBox(e) {
  const f = e.follow;
  const toggle = async (on) => {
    try { graphs = await api('/api/graphs/follow', { endpoint: e.endpoint, on }); toast(on ? `/sparql/${e.endpoint} follows the database` : `/sparql/${e.endpoint} no longer follows the database`); watchFollowing(); } catch (err) { toast(err.message, true); }
    render();
  };
  if (f) {
    const s = f.lastSync;
    return h('div', { class: 'follow on', 'data-testid': 'follow-box' },
      h('div', { class: 'row', style: 'justify-content:space-between' },
        h('b', {}, '⟲ Follows the database'),
        h('span', { class: `chip ${f.state === 'syncing' ? 'g-stale' : f.state === 'failed' ? 'g-incomplete' : 'g-stable'}`, 'data-testid': `follow-state-${f.state}` }, f.state === 'syncing' ? 'rebuilding…' : f.state === 'failed' ? 'last rebuild failed' : 'in sync')),
      h('div', { class: 'hint' }, `Since ${at(f.since)}: every committed transaction that touches ${f.watched ? [...f.watched.labels, ...f.watched.types].join(', ') : 'the database'} rebuilds the graph, checks it, and swaps it in.`),
      f.lastChange ? h('div', { 'data-testid': 'follow-last-change' }, `Last change ${at(f.lastChange.at)}: ${f.lastChange.transactions ?? 0} transaction(s), ${f.lastChange.events} change(s)`) : h('div', { class: 'hint' }, 'No change yet.'),
      s ? h('div', { 'data-testid': `follow-sync-${f.syncs}`, class: s.ok ? 'okline' : 'warnline' }, s.ok ? `Rebuilt ${at(s.at)} in ${(s.ms / 1000).toFixed(1)} s: now serving ${s.graph}` : `Rebuild failed ${at(s.at)}, the endpoint kept its graph: ${s.error}`) : null,
      s?.writes?.length ? h('div', { 'data-testid': 'follow-writes' }, h('div', { class: 'hint' }, 'Written back into Neo4j by this rebuild:'), writeLines(s.writes, s.as)) : null,
      f.ownSkipped ? h('div', { class: 'hint', 'data-testid': 'follow-own' }, `Its own writes, seen by change data capture and skipped: ${f.ownSkipped} transaction(s)${f.lastOwn ? `, last ${at(f.lastOwn.at)}` : ''}.`) : null,
      h('button', { onclick: () => toggle(false), 'data-testid': 'follow-off' }, 'Stop following'));
  }
  const ok = cdc?.available;
  return h('div', { class: 'follow', 'data-testid': 'follow-box' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, 'Follow the database'),
      cdc ? h('span', { class: `chip ${ok ? 'g-stable' : 'g-incomplete'}`, title: cdc.message }, `CDC ${cdc.mode}`) : h('span', { class: 'chip' }, 'CDC …')),
    h('div', { class: 'hint' }, 'Rebuild this graph whenever a transaction commits a change to what it is built from (Change Data Capture).'),
    cdc && !ok ? h('div', { class: 'warnline', 'data-testid': 'cdc-off' }, cdc.message) : null,
    h('button', { class: 'primary', disabled: !ok, title: ok ? '' : (cdc?.message ?? ''), onclick: () => toggle(true), 'data-testid': 'follow-on' }, 'Follow the database'));
}
const section = (title, extra) => h('div', { class: 'fhead', style: 'border-top:1px solid var(--line);margin-top:6px' }, h('div', { class: 'row', style: 'justify-content:space-between' }, title, extra));

/** What is published (SPARQL endpoints, query APIs) and the graphs of n20s-server. */
function services() {
  if (!graphs) return null;
  if (!graphs.can) return [section('Published'), h('div', { style: 'padding:10px 12px;color:#888' }, 'No n20s-server (--n20s).')];
  const is = (kind, name) => view?.kind === kind && view.name === name;
  return [
    section('SPARQL endpoints', h('button', { class: 'mini', onclick: async () => { await loadGraphs(); render(); } }, 'refresh')),
    graphs.endpoints.length ? graphs.endpoints.map((e) => h('div', { class: `qitem${is('endpoint', e.endpoint) ? ' sel' : ''}`, onclick: () => show('endpoint', e.endpoint), 'data-testid': `endpoint-${tid(e.endpoint)}` },
      h('div', { class: 'name mono', style: 'font-size:12px' }, `/sparql/${e.endpoint}`),
      h('div', { class: 'meta' }, h('span', { class: `chip g-${e.status}`, title: STATUS_TEXT[e.status] }, e.status), e.follow ? h('span', { class: 'chip', title: 'Follows the database (CDC)' }, '⟲ follows') : '', e.triples !== null ? ` ${e.triples} triples` : '', ` · ${e.published.recipe}`)))
      : h('div', { style: 'padding:8px 12px;color:#888' }, 'None: a publish step publishes a persistent graph.'),
    section('Query APIs'),
    apis.length ? apis.map((a) => h('div', { class: `qitem${is('api', a.name) ? ' sel' : ''}`, 'data-testid': `api-${tid(a.name)}`, onclick: () => { apiValues = Object.fromEntries(Object.entries(a.params).map(([k, d]) => [k, d.default ?? ''])); show('api', a.name); } },
      h('div', { class: 'name mono', style: 'font-size:12px' }, `/query/${a.name}`),
      h('div', { class: 'meta' }, kindChip(a.kind), ` ${a.recipe}`)))
      : h('div', { style: 'padding:8px 12px;color:#888' }, 'None: a recipe declares api: { name } to be served.'),
    section('In-memory RDF graphs'),
    graphs.graphs.length ? graphs.graphs.map((g) => h('div', { class: `qitem${is('graph', g.name) ? ' sel' : ''}`, onclick: () => show('graph', g.name) },
      h('div', { class: 'name mono', style: 'font-size:12px' }, g.name),
      h('div', { class: 'meta' }, h('span', { class: `chip g-${g.status}`, title: STATUS_TEXT[g.status] }, g.status), g.triples !== null ? ` ${g.triples} triples` : '',
        g.endpoints.length ? h('span', { class: 'chip' }, `serves ${g.endpoints.join(', ')}`) : '', g.built ? ` · ${g.built.recipe}` : '')))
      : h('div', { style: 'padding:8px 12px;color:#888' }, 'None.'),
  ];
}

/** Where a graph comes from, and a console on it. */
function provenanceTable(b, triples) {
  return h('table', { class: 'props', style: 'margin-top:8px' },
    [['recipe', `${b.recipe} (${b.file})`], ['built', `${b.at.replace('T', ' ').slice(0, 19)} · run ${b.runId}${b.start ? ` · start: ${b.start}` : ''}`],
      ...(triples !== undefined ? [['triples', `${triples ?? '—'} now, ${b.triples} when built`]] : []),
      ['parameters', Object.keys(b.params ?? {}).length ? JSON.stringify(b.params) : '—'], ['mapping', `${b.mapping?.id} · ${b.mapping?.contentHash?.slice(0, 12)}`],
      ['LPG ontology', `${b.lpg?.id} v${b.lpg?.version} · ${b.lpg?.contentHash?.slice(0, 12)}`], ['source', b.source?.url ?? '—'],
      ...(b.basedOn ? [['added to', `${b.basedOn.recipe} run ${b.basedOn.runId}`]] : [])].map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { class: 'mono' }, v))));
}

function sparqlConsole(ask, hint) {
  const query = h('textarea', { class: 'mono', rows: 5, spellcheck: 'false', 'data-testid': 'sparql-input', oninput: (e) => { sparqlText = e.target.value; } }, sparqlText);
  return [
    h('h3', {}, 'SPARQL'),
    h('div', { class: 'term' }, hint),
    query,
    h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'primary', 'data-testid': 'sparql-ask', onclick: async () => {
      sparqlResult = null; render();
      try { sparqlResult = await ask(sparqlText); } catch (err) { sparqlResult = { error: err.message }; }
      sparqlAsks++;
      render();
    } }, 'Ask')),
    sparqlResult ? h('div', { 'data-testid': `sparql-result-${sparqlAsks}` }, sparqlView(sparqlResult)) : null,
  ];
}

function graphPanel() {
  const g = graphs?.graphs.find((x) => x.name === view.name);
  if (!g) return h('div', { class: 'empty' }, 'This graph is gone.');
  const recipeFile = g.built && list.recipes.find((r) => r.file === g.built.file)?.file;
  return [
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { class: 'mono', style: 'font-size:14px' }, g.name), h('button', { class: 'mini', onclick: () => { view = null; render(); } }, 'close')),
    h('div', {}, h('span', { class: `chip g-${g.status}` }, g.status), ' ', STATUS_TEXT[g.status]),
    g.reasons.length ? h('ul', { style: 'margin:6px 0;padding-left:18px;color:#8a4b00' }, g.reasons.map((r) => h('li', {}, r))) : null,
    g.endpoints.length ? h('div', { style: 'margin-top:6px' }, 'Serves ', g.endpoints.map((e) => h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); show('endpoint', e); } }, `/sparql/${e} `))) : h('div', { style: 'margin-top:6px;color:#666' }, 'Not published.'),
    g.built ? provenanceTable(g.built, g.triples) : null,
    h('div', { class: 'actions', style: 'display:flex;gap:6px;margin-top:10px' },
      recipeFile ? h('button', { onclick: () => open(recipeFile) }, 'Open the recipe') : null,
      h('button', { class: 'bad', disabled: g.endpoints.length > 0, title: g.endpoints.length ? 'Unpublish it first' : '', onclick: async () => {
        if (!confirm(`Drop ${g.name} from n20s-server?`)) return;
        try { graphs = await api('/api/graphs/drop', { name: g.name }); view = null; toast(`Dropped ${g.name}`); } catch (err) { toast(err.message, true); }
        render();
      } }, 'Drop')),
    g.triples !== null ? sparqlConsole(async (q) => ({ rows: (await api('/api/graphs/query', { name: g.name, sparql: q })).rows }), 'The studio asks any graph of n20s-server; only published ones are served to others.') : null,
  ];
}

function endpointPanel() {
  const e = graphs?.endpoints.find((x) => x.endpoint === view.name);
  if (!e) return h('div', { class: 'empty' }, 'Not published any more.');
  const p = e.published;
  const recipeFile = list.recipes.find((r) => r.file === p.file)?.file;
  const url = new URL(`/sparql/${e.endpoint}`, location.href).href;
  return [
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { class: 'mono', style: 'font-size:14px' }, `/sparql/${e.endpoint}`), h('button', { class: 'mini', onclick: () => { view = null; render(); } }, 'close')),
    h('div', {}, h('span', { class: `chip g-${e.status}` }, e.status), ' ', STATUS_TEXT[e.status]),
    e.reasons.length ? h('ul', { style: 'margin:6px 0;padding-left:18px;color:#8a4b00' }, e.reasons.map((r) => h('li', {}, r))) : null,
    followBox(e),
    p.description ? h('div', { class: 'desc', style: 'margin-top:8px' }, p.description) : null,
    h('table', { class: 'props', style: 'margin-top:8px' },
      [['URL', url], ['graph', `${e.graph}${e.triples !== null ? ` · ${e.triples} triples` : ''}`], ['published', `${p.at.replace('T', ' ').slice(0, 19)} by ${p.recipe} (run ${p.runId})`],
        ['gates', p.gate?.length ? p.gate.map((g) => `${g.step}: ${g.conforms ? 'conforms' : `${g.violations} violations`}`).join(', ') : 'none'],
        ['parameters', Object.keys(p.params ?? {}).length ? JSON.stringify(p.params) : '—'],
        ...(p.replaced ? [['replaced', `${p.replaced.graph} (published ${p.replaced.at.replace('T', ' ').slice(0, 19)})`]] : [])].map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { class: 'mono' }, v)))),
    h('div', { class: 'actions', style: 'display:flex;gap:6px;margin-top:10px;flex-wrap:wrap' },
      h('button', { class: 'primary', disabled: !list.can, title: 'Runs the recipe again with the same parameters: a new version, through its gates, swapped in', onclick: async () => {
        toast('Re-publishing…');
        try {
          const r = await api('/api/graphs/republish', { endpoint: e.endpoint });
          graphs = r; apis = graphs.can ? (await api('/query')).apis : apis;
          republished = { endpoint: e.endpoint, run: r.run };
          toast(r.run.ok ? `Re-published: ${r.run.graph} (${r.run.ms} ms)` : `Not re-published, the endpoint keeps its graph: ${r.run.error}`, !r.run.ok);
        } catch (err) { toast(err.message, true); }
        render();
      }, 'data-testid': 'republish' }, 'Re-publish'),
      recipeFile ? h('button', { onclick: () => open(recipeFile) }, 'Open the recipe') : null,
      list.recipes.find((r) => r.file === p.file)?.writes ? h('button', { 'data-testid': 'neo4j-now-show', title: 'What the write steps of this recipe hold in Neo4j now, read with Cypher', onclick: async () => {
        try { written = await api('/api/graphs/written', { endpoint: e.endpoint }); } catch (err) { toast(err.message, true); }
        render();
      } }, 'In Neo4j now') : null,
      h('button', { class: 'bad', onclick: async () => {
        if (!confirm(`Stop serving /sparql/${e.endpoint}?`)) return;
        try { graphs = await api('/api/graphs/unpublish', { endpoint: e.endpoint }); view = null; toast(`Unpublished /sparql/${e.endpoint}`); } catch (err) { toast(err.message, true); }
        render();
      } }, 'Unpublish')),
    republished?.endpoint === e.endpoint && republished.run.writes ? h('div', { class: 'follow', 'data-testid': 'republish-result' },
      h('b', {}, `Re-published ${republished.run.ok ? `in ${(republished.run.ms / 1000).toFixed(1)} s` : ': failed'}`), writeLines(republished.run.writes, republished.run.as)) : null,
    written?.endpoint === e.endpoint ? h('div', { class: 'follow', 'data-testid': 'neo4j-now' },
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, 'In Neo4j now'), h('button', { class: 'mini', onclick: () => { written = null; render(); } }, '×')),
      h('div', { class: 'hint' }, `Read with Cypher, as any application would: what ${written.recipe} wrote back.`),
      written.steps.map((x) => [h('div', { style: 'margin-top:6px' }, h('b', { class: 'mono' }, x.title), ` · ${x.count}`), table(x.rows)])) : null,
    e.status !== 'missing' ? sparqlConsole(async (q) => {
      const res = await fetch(`/sparql/${encodeURIComponent(e.endpoint)}?query=${encodeURIComponent(q)}`);
      const text = await res.text();
      if (!res.ok) return { error: JSON.parse(text).error };
      return res.headers.get('content-type').startsWith('application/sparql-results+json') ? JSON.parse(text) : { text };
    }, `Read-only, as others see it: GET ${url}?query=…`) : null,
  ];
}

function apiPanel() {
  const a = apis.find((x) => x.name === view.name);
  if (!a) return h('div', { class: 'empty' }, 'This API is gone.');
  const recipe = list.recipes.find((r) => r.id === a.recipe);
  const qs = () => new URLSearchParams(Object.entries(apiValues).filter(([, v]) => v !== '')).toString();
  const urlLine = h('div', { class: 'mono', style: 'word-break:break-all;margin-top:6px' });
  const refresh = () => { urlLine.textContent = `GET ${new URL(`/query/${a.name}`, location.href).href}${qs() ? `?${qs()}` : ''}`; };
  refresh();
  return [
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', { class: 'mono', style: 'font-size:14px' }, `/query/${a.name}`), h('button', { class: 'mini', onclick: () => { view = null; render(); } }, 'close')),
    h('div', {}, kindChip(a.kind), ' ', KIND[a.kind].help),
    a.description ? h('div', { class: 'desc', style: 'margin-top:8px' }, a.description) : null,
    h('h3', {}, 'Parameters'),
    Object.entries(a.params).length ? Object.entries(a.params).map(([k, d]) => h('label', { class: 'ffield', title: d.description ?? '' }, h('span', {}, `${k} (${d.type})`),
      h('input', { value: apiValues[k] ?? '', 'data-testid': `api-param-${tid(k)}`, oninput: (ev) => { apiValues[k] = ev.target.value; refresh(); } }))) : h('div', { style: 'color:#888' }, 'None.'),
    urlLine,
    h('div', { class: 'actions', style: 'display:flex;gap:6px;margin-top:10px' },
      h('button', { class: 'primary', disabled: !list.can, 'data-testid': 'api-call', onclick: async () => {
        apiResult = null; render();
        try {
          const res = await fetch(`/query/${encodeURIComponent(a.name)}${qs() ? `?${qs()}` : ''}`);
          apiResult = await res.json();
        } catch (err) { apiResult = { error: err.message }; }
        apiCalls++;
        render();
      } }, 'Call'),
      recipe ? h('button', { onclick: () => open(recipe.file) }, 'Open the recipe') : null),
    apiResult ? (apiResult.error && !apiResult.result ? h('div', { class: 'fail', style: 'margin-top:8px', 'data-testid': `api-result-${apiCalls}` }, apiResult.error) : h('div', { 'data-testid': `api-result-${apiCalls}` },
      h('div', { style: 'margin-top:8px;color:#555' }, `${apiResult.ok ? 'ok' : 'stopped'} · ${apiResult.ms} ms · ${apiResult.kind}${apiResult.result ? ` · ${apiResult.result.rows?.length ?? 0} rows from ${apiResult.result.step}` : ''}`),
      apiResult.error ? h('div', { class: 'fail' }, apiResult.error) : null,
      apiResult.result?.rows ? table(apiResult.result.rows, apiResult.result.columns) : null,
      h('details', {}, h('summary', { style: 'cursor:pointer;color:#666' }, 'JSON'), h('pre', { class: 'stmt' }, JSON.stringify(apiResult, null, 1))))) : null,
  ];
}

function sparqlView(r) {
  if (r.error) return h('div', { class: 'fail', style: 'margin-top:6px' }, r.error);
  if (r.rows) return [h('div', { style: 'margin-top:6px;color:#555' }, `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}`), table(r.rows)];
  if (r.text !== undefined) return h('pre', { class: 'stmt' }, r.text || '(no triples)');
  if ('boolean' in r) return h('div', { style: 'margin-top:6px' }, h('b', {}, String(r.boolean)));
  const vars = r.head.vars;
  const cell = (t) => (!t ? '' : t.type === 'uri' ? t.value : t.type === 'bnode' ? `_:${t.value}` : t.value);
  return [h('div', { style: 'margin-top:6px;color:#555' }, `${r.results.bindings.length} row${r.results.bindings.length === 1 ? '' : 's'}`),
    h('table', { class: 'props' }, h('tr', {}, vars.map((v) => h('th', {}, v))), r.results.bindings.map((b) => h('tr', {}, vars.map((v) => h('td', { class: 'mono' }, cell(b[v]))))))];
}

function newRecipeForm() {
  const id = h('input', { placeholder: 'id, for instance stale-versions' });
  const title = h('input', { placeholder: 'title (optional)' });
  return h('div', { class: 'form', style: 'margin:8px' }, id, title, h('div', { class: 'row' },
    h('button', { class: 'primary', onclick: async () => {
      try {
        list = await api('/api/recipe/new', { id: id.value, title: title.value });
        creating = false;
        await open(list.created);
        toast(`Created ${list.created}`);
      } catch (err) { toast(err.message, true); }
    } }, 'Create'),
    h('button', { onclick: () => { creating = false; render(); } }, 'Cancel')));
}

function header() {
  const f = current.recipe;
  const inputs = Object.entries(f.params ?? {}).map(([k, d]) => h('label', { class: 'fparam', title: d?.description ?? '' },
    h('span', { class: 'row', style: 'justify-content:space-between' }, `$${k}`,
      h('span', {},
        h('button', { class: 'mini', title: 'Save this value as the default', onclick: () => change('/api/recipe/param', { name: k, value: params[k], description: d?.description }, `Default of $${k} saved`) }, 'set default'),
        h('button', { class: 'mini bad', title: 'Remove the parameter', onclick: () => confirm(`Remove $${k}?`) && change('/api/recipe/param', { name: k, remove: true }) }, '×'))),
    h('input', { value: params[k] ?? '', oninput: (e) => { params[k] = e.target.value; } })));
  if (addingParam) {
    const name = h('input', { placeholder: 'name' });
    const value = h('input', { placeholder: 'default value' });
    inputs.push(h('div', { class: 'fparam' }, h('span', {}, 'new parameter'), h('div', { class: 'row' }, name, value,
      h('button', { class: 'primary', onclick: async () => { addingParam = false; params[name.value] = value.value; await change('/api/recipe/param', { name: name.value, value: value.value }, `$${name.value} added`); } }, 'Add'),
      h('button', { onclick: () => { addingParam = false; render(); } }, '×'))));
  } else {
    inputs.push(h('button', { style: 'align-self:end', onclick: () => { addingParam = true; render(); } }, '+ parameter'));
  }
  const keep = h('input', { type: 'checkbox', style: 'width:auto' });
  return h('div', { class: 'fbar' },
    h('div', {}, h('b', { style: 'font-size:15px' }, f.title ?? f.id), ' ', kindChip(current.outline.kind),
      h('div', { style: 'color:#666' }, `mapping ${current.mapping}`), apiLine()),
    h('div', { class: 'fparams' }, inputs),
    h('label', { class: 'row', style: 'gap:4px;color:#666;white-space:nowrap', title: 'Keep the ephemeral graphs after the run (persistent graphs always stay)' }, keep, 'keep ephemeral graphs'),
    run ? h('span', { class: `chip ${run.ok ? 'accepted' : 'error'}`, 'data-testid': run.ok ? `run-ok-${current.recipe.id}` : `run-failed-${current.recipe.id}` }, run.ok ? `done in ${run.ms} ms` : 'stopped') : null,
    h('button', {
      class: 'primary', disabled: running || !list.can || current.findings.length > 0, 'data-testid': 'recipe-run',
      title: !list.can ? 'Start the studio with --source and n20s-server to run recipes' : '',
      onclick: async () => {
        running = true; render();
        try {
          run = await api('/api/recipe/run', { file: current.file, params, keep: keep.checked });
          // A recipe that writes back into Neo4j: say what it writes, and run it only once confirmed.
          if (run.confirm) {
            const what = run.confirm.writes.map((w) => `• ${w.step}: ${w.kind} ${w.name ?? '(free Cypher)'}${w.on ? ` on ${w.on}` : ''}${w.retract ? `, retracted on ${w.retract === 'all' ? 'every node' : 'the scoped nodes'}` : ''}`).join('\n');
            if (!confirm(`This recipe writes back into Neo4j, as ${run.confirm.writes[0]?.owner?.split('/')[0]}:\n${what}\n\nOnly what changed is written, in one transaction per step. Run it?`)) { run = null; running = false; render(); return; }
            run = await api('/api/recipe/run', { file: current.file, params, keep: keep.checked, confirmWrite: true });
          }
          await loadGraphs();
          const last = run.steps.at(-1);
          const published = (run.publications ?? []).map((p) => `/sparql/${p.as}`);
          toast(run.ok ? `Done in ${run.ms} ms${published.length ? `; published ${published.join(', ')}` : ''}` : `Stopped at ${last?.id}: ${last?.error}`, !run.ok);
        } catch (err) { toast(err.message, true); }
        running = false; render();
      },
    }, running ? 'Running…' : 'Run'),
    current.findings.length ? h('div', { class: 'fail', style: 'flex-basis:100%' }, current.findings.map((x) => h('div', {}, `${x.path}: ${x.message}`))) : null,
    f.steps.some((x) => x.type === 'write') ? h('button', { 'data-testid': 'ontology-patch', title: 'What the LPG ontology must declare for the write steps', onclick: () => showPatch(false) }, 'Ontology patch') : null,
    patch ? patchView() : null,
  );
}

async function showPatch(apply) {
  try { patch = await api('/api/ontology-patch', { apply }); } catch (err) { toast(err.message, true); return; }
  if (apply) { toast('Applied to the LPG ontology file: re-apply it in the Aura ontology too'); await open(current.file); return; }
  render();
}

/** The declarations to add to the LPG ontology, and the button that writes them to the export file. */
function patchView() {
  const changes = patch.patches.flatMap((p) => p.changes.map((c) => ({ ...c, file: p.lpgFile })));
  return h('div', { class: 'follow', style: 'flex-basis:100%', 'data-testid': 'patch-view' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, 'Ontology patch'), h('button', { class: 'mini', onclick: () => { patch = null; render(); } }, '×')),
    changes.length
      ? [h('div', { class: 'hint' }, 'The LPG ontology must declare what the recipes write back. Apply it to the export file, then make the same changes in the Aura ontology: an export without them fails check.'),
        table(changes.map((c) => ({ file: c.file, change: c.op, at: c.path, what: c.what })), ['file', 'change', 'at', 'what']),
        h('button', { class: 'primary', 'data-testid': 'patch-apply', onclick: () => confirm('Write these declarations into the LPG ontology file?') && showPatch(true) }, 'Apply to the export file')]
      : h('div', { class: 'okline' }, 'The LPG ontology declares everything the recipes write.'),
    patch.patches.map((p) => h('details', { style: 'margin-top:8px', 'data-testid': 'patch-script' },
      h('summary', { style: 'cursor:pointer' }, 'Admin script: review it, run it once as an administrator (the constraint, and the names the writer writes)'),
      h('pre', { class: 'stmt' }, p.script))));
}

/** The graphs of the recipe, their lifecycle, and their state after the run. */
/** The query API of the recipe: shown, declared, changed or removed. */
function apiLine() {
  const a = current.recipe.api;
  if (editingApi) {
    const asks = current.recipe.steps.filter((x) => ['query', 'validate', 'explain'].includes(x.type)).map((x) => x.id);
    const name = h('input', { value: a?.name ?? current.recipe.id, placeholder: 'name', style: 'width:150px' });
    const result = h('select', {}, h('option', { value: '' }, '(last asking step)'), asks.map((x) => h('option', { value: x, selected: a?.result === x }, x)));
    const desc = h('input', { value: a?.description ?? '', placeholder: 'description', style: 'width:220px' });
    return h('div', { class: 'row form', style: 'display:flex;flex-wrap:wrap;margin-top:4px' }, '/query/', name, 'returns', result, desc,
      h('button', { class: 'primary', onclick: async () => { editingApi = false; await change('/api/recipe/api', { name: name.value, result: result.value, description: desc.value }, `API /query/${name.value} declared`); await loadGraphs(); render(); } }, 'Save'),
      a ? h('button', { class: 'bad', onclick: async () => { editingApi = false; await change('/api/recipe/api', { remove: true }, 'API removed'); await loadGraphs(); render(); } }, 'Remove') : null,
      h('button', { onclick: () => { editingApi = false; render(); } }, 'Cancel'));
  }
  return h('div', { style: 'margin-top:2px' }, a
    ? [h('a', { href: '#', class: 'mono', onclick: (e) => { e.preventDefault(); const x = apis.find((y) => y.name === a.name); if (x) { apiValues = Object.fromEntries(Object.entries(x.params).map(([k, d]) => [k, d.default ?? ''])); show('api', a.name); } } }, `/query/${a.name}`),
      ` returns ${a.result ?? 'the last asking step'} `, h('button', { class: 'mini', onclick: () => { editingApi = true; render(); } }, 'edit')]
    : h('button', { class: 'mini', title: 'Serve this recipe as a parametrized query: /query/<name>, run on each call', onclick: () => { editingApi = true; render(); } }, '+ publish as API'));
}

function graphsBar() {
  const declared = current.recipe.graphs ?? {};
  const implicit = !Object.keys(declared).length;
  const after = run?.graphs ?? {};
  const chips = current.outline.graphs.map((g) => {
    const a = after[g.key];
    const titles = {
      persistent: 'Outlives the run, under a stable name: other recipes read it, a publish step serves it',
      published: 'Read-only: whatever the endpoint serves now (precomputed)',
      remote: 'A SPARQL endpoint outside (the client\'s triple store): read with construct … from, never written',
      ephemeral: 'Built for one run, then dropped (lazy)',
    };
    return h('div', { class: `gchip ${g.lifecycle}`, title: titles[g.lifecycle] },
      h('b', {}, g.key), ' ',
      h('span', { class: `chip ${g.lifecycle}` }, g.lifecycle),
      g.lifecycle === 'persistent' ? [' ', h('code', {}, g.name), g.versioned ? ' versioned' : ` start: ${g.start}`] : '',
      g.lifecycle === 'published' ? [' ', h('code', {}, `/sparql/${g.endpoint}`)] : '',
      g.lifecycle === 'remote' ? [' ', h('code', {}, g.sparql)] : '',
      a ? h('span', { style: 'color:#555' }, ` → ${a.triples} triples${a.lifecycle === 'ephemeral' ? (a.kept ? `, kept as ${a.name}` : ', dropped') : a.versioned ? ` in ${a.name}` : ''}`) : '',
      implicit ? h('span', { style: 'color:#888' }, ' (default)') : [
        h('button', { class: 'mini', onclick: () => { editingGraph = g.key; render(); } }, 'edit'),
        h('button', { class: 'mini bad', onclick: () => confirm(`Remove graph ${g.key}?`) && change('/api/recipe/graph', { key: g.key, remove: true }) }, '×')]);
  });
  return h('div', { class: 'gbar' }, h('span', { style: 'color:#666' }, 'Graphs'), chips,
    editingGraph !== null ? graphForm(editingGraph) : h('button', { onclick: () => { editingGraph = ''; render(); } }, '+ graph'));
}

function graphForm(key) {
  const g = current.recipe.graphs?.[key] ?? {};
  const k = h('input', { value: key, placeholder: 'key, for instance kg', disabled: !!key, style: 'width:110px' });
  const lc = h('select', {}, [['ephemeral', 'ephemeral (lazy, per run)'], ['persistent', 'persistent (built here)'], ['published', 'published (read an endpoint)'], ['remote', 'remote (a client SPARQL endpoint)']].map(([x, t]) => h('option', { value: x, selected: (g.lifecycle ?? 'ephemeral') === x }, t)));
  const name = h('input', { value: g.name ?? '', placeholder: 'name in n20s-server', style: 'width:170px' });
  const versioned = h('input', { type: 'checkbox', checked: !!g.versioned, style: 'width:auto' });
  const versionedLabel = h('label', { class: 'row', style: 'gap:4px', title: 'A new version on every run, swapped in by a publish step once valid' }, versioned, 'versioned');
  const start = h('select', {}, [['reuse', 'start: reuse (keep its content)'], ['rebuild', 'start: rebuild (empty it first)']].map(([v, t]) => h('option', { value: v, selected: (g.start ?? 'reuse') === v }, t)));
  const endpoint = h('select', {}, (graphs?.endpoints ?? []).map((e) => h('option', { value: e.endpoint, selected: g.endpoint === e.endpoint }, `/sparql/${e.endpoint}`)), h('option', { value: '' }, '(other: type it)'));
  const endpointText = h('input', { value: g.endpoint ?? '', placeholder: 'endpoint name', style: 'width:140px' });
  const sparql = h('input', { value: g.sparql ?? '', placeholder: 'SPARQL endpoint URL, or ${ENV_VAR}', style: 'width:240px' });
  const user = h('input', { value: g.user ?? '', placeholder: 'user: env variable name', style: 'width:150px' });
  const password = h('input', { value: g.password ?? '', placeholder: 'password: env variable name', style: 'width:170px' });
  const sync = () => {
    const p = lc.value === 'persistent';
    name.style.display = versionedLabel.style.display = p ? '' : 'none';
    start.style.display = p && !versioned.checked ? '' : 'none';
    endpoint.style.display = lc.value === 'published' ? '' : 'none';
    endpointText.style.display = lc.value === 'published' && !endpoint.value ? '' : 'none';
    for (const x of [sparql, user, password]) x.style.display = lc.value === 'remote' ? '' : 'none';
  };
  for (const x of [lc, versioned, endpoint]) x.addEventListener('change', sync);
  sync();
  return h('div', { class: 'row form', style: 'display:flex;flex-wrap:wrap' }, k, lc, name, versionedLabel, start, endpoint, endpointText, sparql, user, password,
    h('button', { class: 'primary', onclick: async () => {
      const key2 = k.value; editingGraph = null;
      await change('/api/recipe/graph', { key: key2, lifecycle: lc.value, name: name.value, start: start.value, versioned: versioned.checked, endpoint: endpoint.value || endpointText.value, sparql: sparql.value, user: user.value, password: password.value }, `Graph ${key2} saved`);
    } }, 'Save'),
    h('button', { onclick: () => { editingGraph = null; render(); } }, 'Cancel'));
}

/** The steps, in the order they run, with the state of their graph after each one. */
function sequence() {
  const steps = current.outline.steps;
  const results = Object.fromEntries((run?.steps ?? []).map((x) => [x.id, x]));
  const multi = current.outline.graphs.length > 1;
  return h('div', { class: 'seq' },
    steps.length ? steps.map((st, i) => {
      const role = ROLE[st.role];
      const x = results[st.id];
      const step = current.recipe.steps[i];
      return h('div', { class: `scard${selected === st.id ? ' sel' : ''}${x?.status === 'error' ? ' err' : ''}`, onclick: () => { selected = st.id; view = null; render(); } },
        h('div', { class: 'snum', style: `background:${role.color}` }, i + 1),
        h('div', { class: 'sbody' },
          h('div', {}, h('span', { class: 'srole', style: `color:${role.color}` }, `${role.icon} ${role.text}`), ' ',
            multi || current.outline.graphs[0]?.lifecycle === 'persistent' ? h('span', { class: `chip ${current.outline.graphs.find((g) => g.key === st.graph)?.lifecycle}` }, st.graph) : '',
            ' ', h('b', {}, st.id), ' ', h('span', { class: 'chip' }, st.type),
            // Where a construct reads: another graph of the recipe, or a remote store.
            st.from ? [' from ', h('span', { class: `chip ${current.outline.graphs.find((g) => g.key === st.from)?.lifecycle ?? ''}`, title: current.outline.graphs.find((g) => g.key === st.from)?.sparql ?? '' }, st.from)] : '',
            ' ', h('span', { style: 'color:#555' }, step.title ?? '')),
          st.uses.length ? h('div', { class: 'suses' }, 'uses ', st.uses.map((u, j) => [j ? ', ' : '', h('a', { href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); selected = u.step; render(); } }, `$${u.step}.${u.column}`)])) : null),
        x ? h('div', { class: 'sstate' },
          x.status === 'error' ? h('span', { class: 'fail' }, 'error')
            : [h('div', {}, `${x.state.triples} triples`, x.state.delta ? h('b', { style: `color:${x.state.delta > 0 ? '#2e7d32' : '#c62828'}` }, ` ${x.state.delta > 0 ? '+' : ''}${x.state.delta}`) : h('span', { style: 'color:#999' }, ' unchanged')),
              h('div', { style: 'color:#555' }, summary(st.type, x.result))]) : null);
    }) : h('div', { style: 'color:#666;padding:6px 0' }, 'No step yet. A recipe usually starts by feeding a graph (a scope: Cypher picks the nodes), then asks it.'),
    h('div', { style: 'margin-top:10px' }, addStepBar(null, steps.length ? 'Add at the end' : 'Add the first step')));
}

function summary(type, r) {
  if (!r) return '';
  if (type === 'scope') return `${r.nodes} nodes in scope`;
  if (type === 'query') return `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}`;
  if (type === 'validate') return r.conforms ? 'conforms' : `${r.violations.length} violation${r.violations.length > 1 ? 's' : ''}`;
  if (type === 'explain') return `${r.rows.length} facts`;
  if (type === 'infer') return `${r.added} inferred (${r.profile || 'rules'})`;
  if (type === 'update') return `${r.inserted} inserted, ${r.deleted} deleted`;
  if (type === 'publish') return `→ /sparql/${r.as}`;
  if (type === 'construct') return `${r.added} added${r.triples !== r.added ? ` (${r.triples} pulled)` : ''}`;
  if (type === 'write') return r.written ? `+${r.added ?? 0} −${r.removed ?? 0} written` : 'unchanged, nothing written';
  return '';
}

function addStepBar(after = null, label = 'Add step') {
  const type = h('select', {}, Object.keys(TYPE_TEXT).map((t) => h('option', { value: t }, `${ROLE[ROLE_OF[t]].text}: ${t} — ${TYPE_TEXT[t]}`)));
  const id = h('input', { placeholder: 'id (optional)', style: 'width:140px' });
  return h('div', { class: 'row', style: 'gap:6px' }, type, id, h('button', { onclick: async () => {
    const before = current.recipe.steps.map((x) => x.id);
    await change('/api/recipe/step/add', { after, type: type.value, id: id.value });
    selected = current.recipe.steps.find((x) => !before.includes(x.id))?.id ?? selected;
    render();
  } }, label));
}

/** The run as a whole: graphs, time, and the full trace (every statement sent), to copy or replay. */
function trace() {
  if (!run) return h('div', { class: 'ftrace', style: 'color:#888' }, 'Not run yet. A run opens the ephemeral graphs, empties the persistent ones that start with rebuild, runs the steps in order, then drops the ephemeral graphs.');
  const json = JSON.stringify(run, null, 1);
  return h('div', { class: 'ftrace' },
    h('div', {}, h('b', {}, run.ok ? 'Run complete' : 'Run stopped'), ` · ${run.ms} ms · run ${run.runId}`,
      ' ', h('button', { onclick: () => navigator.clipboard.writeText(json).then(() => toast('Trace copied')) }, 'Copy trace')),
    run.setup.length ? h('div', { style: 'color:#666' }, run.setup.map((x) => `${x.call} ${x.graph} (${x.reason})`).join('; ')) : null,
    h('details', {}, h('summary', { style: 'cursor:pointer;color:#666' }, `Trace: ${run.steps.reduce((n, x) => n + x.statements.length, 0)} statements`), h('pre', { class: 'stmt', style: 'max-height:300px;overflow:auto' }, json)));
}

function stepPanel() {
  const step = current.recipe.steps.find((x) => x.id === selected);
  if (!step) return h('div', { class: 'empty' }, 'Select a step.');
  const result = run?.steps.find((x) => x.id === step.id);
  const i = current.recipe.steps.indexOf(step);
  const findings = current.findings.filter((f) => f.path === `steps/${step.id}`);
  const role = ROLE[current.outline.steps.find((x) => x.id === step.id)?.role ?? ROLE_OF[step.type]];
  return [
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, `${i + 1}. ${step.id}`),
      h('span', {},
        h('button', { class: 'mini', disabled: i === 0, title: 'Move up', onclick: () => change('/api/recipe/step/move', { step: step.id, delta: -1 }) }, '↑'),
        h('button', { class: 'mini', disabled: i === current.recipe.steps.length - 1, title: 'Move down', onclick: () => change('/api/recipe/step/move', { step: step.id, delta: 1 }) }, '↓'),
        h('button', { class: 'mini bad', title: 'Delete the step', onclick: () => confirm(`Delete step ${step.id}?`) && change('/api/recipe/step/delete', { step: step.id }, `Deleted ${step.id}`).then(() => { selected = current.recipe.steps[Math.min(i, current.recipe.steps.length - 1)]?.id ?? null; render(); }) }, 'Delete'))),
    h('div', {}, h('span', { class: 'srole', style: `color:${role.color}` }, `${role.icon} ${role.text} its graph`), ' — ', TYPE_TEXT[step.type]),
    findings.map((f) => h('div', { class: 'finding error' }, f.message)),
    field(step, 'title'),
    graphField(step),
    ...EDITABLE[step.type].map((f) => field(step, f)),
    h('h3', {}, 'Add a step after this one'),
    addStepBar(step.id, 'Add after'),
    h('h3', {}, 'Result'),
    result ? resultView(step, result) : h('div', { style: 'color:#888' }, 'Run the recipe to see it.'),
    result ? graphState(step, result) : null,
  ];
}

/** The graph a step works on: one of the declared graphs. */
function graphField(step) {
  const keys = current.outline.graphs.map((g) => g.key);
  const now = current.outline.steps.find((x) => x.id === step.id)?.graph;
  const sel = h('select', {}, keys.map((k) => h('option', { value: k, selected: k === now }, `${k} (${current.outline.graphs.find((g) => g.key === k).lifecycle})`)));
  sel.addEventListener('change', () => change('/api/recipe/step', { step: step.id, field: 'graph', value: sel.value }, `${step.id} now works on ${sel.value}`));
  return h('label', { class: 'ffield' }, h('span', {}, 'graph'), sel);
}

/** What the step's graph holds after it: classes and predicates with their counts (asserted, not reasoned). */
function graphState(step, x) {
  // An asking step leaves the graph as it was: show the state after the last step that fed or changed it.
  let st = x.state;
  let from = step.id;
  if (!st.classes) {
    const earlier = run.steps.slice(0, run.steps.indexOf(x)).reverse().find((y) => y.graph === x.graph && y.state?.classes);
    if (earlier) { st = earlier.state; from = earlier.id; }
  }
  if (!st.classes) return null;
  const top = (l) => l.slice(0, 14).map((r) => h('tr', {}, h('td', { class: 'mono' }, r.term), h('td', { style: 'text-align:right' }, r.n)));
  return h('details', { style: 'margin-top:12px', open: ROLE_OF[step.type] !== 'ask' },
    h('summary', { style: 'cursor:pointer;color:#666' }, `Graph ${x.graph} after ${from === step.id ? 'this step' : `step ${from}`}: ${st.triples} triples, ${st.classes.length} classes, ${st.predicates.length} predicates`),
    h('div', { class: 'gstate' },
      h('table', { class: 'props' }, h('tr', {}, h('th', {}, 'class'), h('th', {}, 'instances')), top(st.classes)),
      h('table', { class: 'props' }, h('tr', {}, h('th', {}, 'predicate'), h('th', {}, 'triples')), top(st.predicates))));
}

function asText(name, v) {
  if (v === undefined || v === null) return '';
  if (name === 'files') return v.join('\n');
  if (name === 'template') return JSON.stringify(v, null, 2);
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x) : x}`).join('\n');
  return String(v);
}

function field(step, name) {
  const value = asText(name, step[name]);
  const input = name === 'profile'
    ? h('select', {}, PROFILES.map((p) => h('option', { value: p, selected: p === value }, p || '(none)')))
    : name === 'from'
      ? h('select', {}, h('option', { value: '' }, '(its own graph)'), current.outline.graphs.map((g) => h('option', { value: g.key, selected: g.key === value }, `${g.key} (${g.lifecycle})`)))
    : MULTILINE.includes(name)
      ? h('textarea', { class: 'mono', rows: Math.min(14, Math.max(name === 'cypher' || name === 'sparql' ? 4 : 2, value.split('\n').length + 1)), spellcheck: 'false' }, value)
      : h('input', { value });
  const save = h('button', { class: 'mini primary', style: 'display:none', onclick: () => change('/api/recipe/step', { step: step.id, field: name, value: input.value }, `Saved ${step.id}.${name}`) }, 'Save');
  input.addEventListener(['profile', 'from'].includes(name) ? 'change' : 'input', () => { save.style.display = input.value === value ? 'none' : ''; });
  return h('label', { class: 'ffield', title: HELP[name] ?? '' }, h('span', {}, name, save), input, HELP[name] && (MULTILINE.includes(name) || name === 'profile') ? h('div', { class: 'term' }, HELP[name]) : null);
}

function table(rows, columns) {
  if (!rows.length) return h('div', { style: 'color:#888' }, 'No rows.');
  const cols = columns ?? Object.keys(rows[0]);
  const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return h('table', { class: 'props' }, h('tr', {}, cols.map((c) => h('th', {}, c))), rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: 'mono' }, cell(r[c]))))));
}

function resultView(step, x) {
  const r = x.result ?? {};
  const statements = h('details', { style: 'margin-top:10px' }, h('summary', { style: 'cursor:pointer;color:#666' }, `${x.statements.length} statement${x.statements.length > 1 ? 's' : ''} sent (${x.ms} ms)`),
    x.statements.map((st) => h('pre', { class: 'stmt' }, st.text ? `${st.kind}${st.unit ? ` ${st.unit}` : ''}\n${st.text}${st.params && Object.keys(st.params).length ? `\nparams ${JSON.stringify(st.params)}` : ''}${st.profile ? `\nprofile ${st.profile}` : ''}${st.rules ? `\nrules ${st.rules}` : ''}` : JSON.stringify(st, null, 1))));
  if (x.status === 'error') return [h('div', { class: 'fail' }, x.error), statements];
  const state = h('div', { style: 'color:#555;margin-bottom:4px' }, `Graph ${x.graph}: ${x.state.triples} triples${x.state.delta ? ` (${x.state.delta > 0 ? '+' : ''}${x.state.delta})` : ', unchanged'}`);
  let body;
  switch (step.type) {
    case 'scope':
      body = [h('div', {}, `${r.nodes} nodes in scope, ${r.added} triples added`),
        h('div', {}, Object.entries(r.byLabel ?? {}).map(([l, n]) => h('span', { class: 'chip' }, `${l} ${n}`))),
        table(r.units ?? [], ['id', 'rows', 'added'])];
      break;
    case 'query': body = [h('div', {}, `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}`), table(r.rows)]; break;
    case 'validate':
      body = r.conforms ? h('div', { class: 'pass' }, 'Conforms.') : [h('div', { class: 'fail' }, `${r.violations.length} violation${r.violations.length > 1 ? 's' : ''}`), table(r.rows, ['node', 'key', 'severity', 'message'])];
      break;
    case 'explain':
      body = h('div', { class: 'explain' }, r.rows.map((t) => h('div', { style: `margin-left:${t.depth * 18}px` },
        h('span', { class: `chip ${t.kind === 'derived' ? 'review' : 'accepted'}` }, t.kind === 'derived' ? `derived by ${t.rule ?? 'the profile'}` : t.kind), ' ', h('span', { class: 'mono' }, t.fact))));
      break;
    case 'construct': body = [h('div', {}, `${r.triples} triples built, ${r.added} added`), table((r.sample ?? []).map((t) => ({ s: t.subject, p: t.predicate, o: t.object })))]; break;
    case 'write':
      body = [h('div', { class: r.written ? 'okline' : 'hint', 'data-testid': `write-${step.id}` }, r.written
        ? `${r.kind} ${r.name ?? ''}${r.on ? ` on ${r.on}` : ''}: +${r.added ?? 0} −${r.removed ?? 0}, committed as ${r.owner} (ledger ${r.ledger})`
        : `${r.kind} ${r.name ?? ''}${r.on ? ` on ${r.on}` : ''}: unchanged, nothing written (rolled back, no transaction reached the database)`),
      (r.warnings ?? []).map((w) => h('div', { class: 'warnline' }, w)),
      r.counters ? h('div', { class: 'mono', style: 'color:#666' }, Object.entries(r.counters).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'no change') : null];
      break;
    default: body = h('div', { class: 'mono' }, JSON.stringify(r));
  }
  return [state, body, statements];
}
