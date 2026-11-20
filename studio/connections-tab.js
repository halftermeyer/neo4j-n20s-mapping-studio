// Connections tab: the Neo4j database, the AI provider (key and model) and
// n20s-server the studio works with. Passwords and keys go to the studio's
// process, and to the env file when asked; the page never gets them back.
import { fill, h, api, toast } from './dom.js';

let root = null;
let data = null;      // GET /api/settings
let models = null;    // models listed for the provider being chosen
let busy = '';
let last = {};        // what the last check of each connection found

export async function showConnections(container) {
  root = container;
  try { data = await api('/api/settings'); } catch (err) { toast(err.message, true); data = null; }
  render();
}

async function act(key, path, body, done) {
  busy = key;
  render();
  try {
    const res = await api(path, body);
    if (res.models) models = res.models;
    else {
      data = res;
      last[key] = res.checked;
    }
    if (done) toast(typeof done === 'function' ? done(res) : done);
  } catch (err) { toast(err.message, true); }
  busy = '';
  render();
}

const chip = (text, color, title) => h('span', { class: 'chip', style: color ? `background:${color};color:#fff` : null, title }, text);
const field = (label, input, hint) => h('label', {}, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
const ORIGIN = { environment: 'from the environment', 'command line': 'from the command line', studio: 'set here' };

function render() {
  if (!data) {
    fill(root, h('div', { class: 'pempty' }, h('h2', {}, 'Connections'), h('p', {}, 'This studio was started without connection settings.')));
    return;
  }
  fill(root,
    h('div', { class: 'phead' }, h('h2', {}, 'Connections'),
      h('span', { style: 'color:#666' }, 'Passwords and keys stay in the studio process; ', h('b', {}, 'Save'), ' writes them to ', h('span', { class: 'mono' }, data.envFile ?? '(no env file)'), ', never to a project file.'),
      data.envRisk ? h('div', { class: 'warnline' }, `Saving is off: ${data.envRisk}`) : null),
    h('div', { class: 'ccols' }, neo4jCard(), aiCard(), n20sCard()));
}

function saveBox() {
  return h('input', { type: 'checkbox', style: 'width:auto', disabled: !!data.envRisk || !data.envFile, title: data.envRisk ?? '' });
}

// Neo4j ---------------------------------------------------------------------------------------
function neo4jCard() {
  const n = data.neo4j;
  const url = h('input', { value: n?.url ?? '', placeholder: 'neo4j+s://xxxx.databases.neo4j.io or bolt://127.0.0.1:7687' });
  const user = h('input', { value: n?.user ?? '', placeholder: 'neo4j', autocomplete: 'off', 'data-testid': 'neo4j-user' });
  const password = h('input', { type: 'password', autocomplete: 'new-password', placeholder: n?.passwordSet ? 'unchanged (set)' : 'password', 'data-testid': 'neo4j-password' });
  const database = h('input', { value: n?.database ?? '', placeholder: 'default database' });
  const save = saveBox();
  const c = last.neo4j ?? n?.status;
  return h('section', { class: 'pcard ccard', 'data-testid': 'conn-neo4j' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h3', {}, 'Neo4j'),
      n ? chip(c?.agent ? 'connected' : ORIGIN[n.origin] ?? n.origin, c?.agent ? '#2e7d32' : '#607d8b') : chip('not connected', '#c62828')),
    h('p', { class: 'hint' }, 'The database the mapping reads: introspection, value tables, recipes, the oracle. Aura, Neo4j or Relate.'),
    n?.snapshot ? h('div', { class: 'warnline' }, `Reading a snapshot file: ${n.url}`) : null,
    field('URL', url), field('User', user), field('Password', password), field('Database', database),
    h('label', { class: 'row', style: 'gap:6px;display:flex' }, save, 'Save to the env file'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: !!busy, 'data-testid': 'neo4j-connect', onclick: () => act('neo4j', '/api/settings/neo4j',
        { url: url.value.trim(), user: user.value.trim(), password: password.value, database: database.value.trim(), save: save.checked },
        (r) => `Connected to ${r.checked.agent}: ${r.checked.nodes} nodes${r.checked.saved ? ' · saved' : ''}`) }, busy === 'neo4j' ? 'Connecting…' : 'Connect')),
    c?.agent ? h('div', { class: 'ok', 'data-testid': `neo4j-ok-${n?.user ?? ''}` }, `${n?.user ? `${n.user} · ` : ''}${c.agent}${c.nodes !== undefined ? ` · ${c.nodes} nodes` : ''}`) : null,
    h('div', { class: 'hint' }, 'Enables: introspection, value tables in proposals, recipes, oracle.'));
}

// AI ------------------------------------------------------------------------------------------
let chosen = null;    // provider id being edited

function aiCard() {
  const a = data.ai;
  const id = chosen ?? a?.provider ?? 'gemini';
  const p = data.providers.find((x) => x.id === id);
  const same = a?.provider === id;
  const provider = h('select', {}, data.providers.map((x) => h('option', { value: x.id, selected: x.id === id }, x.label)));
  provider.addEventListener('change', () => { chosen = provider.value; models = null; render(); });
  const key = h('input', { type: 'password', autocomplete: 'new-password',
    placeholder: (same && a.keySet) ? `unchanged (${ORIGIN[a.origin] ?? a.origin})` : p.keySetInEnv ? `unchanged (${p.keyVar} is set)` : p.keyOptional ? 'API key (none for a local server)' : `API key (${p.keyVar})` });
  const base = h('input', { value: same ? a.baseUrl : p.baseUrl, placeholder: p.baseUrl });
  const current = same ? a.model : p.model ?? '';
  const model = models
    ? h('select', {}, (models.some((m) => m.id === current) || !current ? [] : [h('option', { value: current, selected: true }, current)]),
      models.map((m) => h('option', { value: m.id, selected: m.id === current }, m.label && m.label !== m.id ? `${m.id} — ${m.label}` : m.id)))
    : h('input', { value: current, placeholder: 'model id: List the models to choose' });
  const save = saveBox();
  const c = last.ai ?? (same ? a.status : null);
  const body = (extra) => ({ provider: id, apiKey: key.value, baseUrl: base.value.trim(), model: model.value.trim(), save: save.checked, ...extra });
  return h('section', { class: 'pcard ccard', 'data-testid': 'conn-ai' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h3', {}, 'AI model'),
      a ? chip(`${a.provider} · ${a.model}`, '#1565c0', ORIGIN[a.origin] ?? a.origin) : chip('none', '#c62828')),
    h('p', { class: 'hint' }, 'The model that proposes mappings, talks in the Design tab, checks the spec and drafts recipes. Your provider, your key.'),
    a?.replay ? h('div', { class: 'warnline', 'data-testid': 'ai-replay' }, `Answers of ${a.model} replayed from a recording: the same run every time.`) : null,
    field('Provider', provider),
    field('API key', key, 'Sent to the provider only. Never shown again.'),
    id === 'openai' ? field('Address', base, 'OpenAI, or any compatible server: https://api.mistral.ai/v1, https://openrouter.ai/api/v1, http://localhost:11434/v1 (Ollama)…') : null,
    field('Model', model),
    h('label', { class: 'row', style: 'gap:6px;display:flex' }, save, 'Save to the env file'),
    h('div', { class: 'row' },
      h('button', { disabled: !!busy, onclick: () => act('models', '/api/settings/ai/models', body(), (r) => `${r.models.length} models`) }, busy === 'models' ? 'Listing…' : 'List the models'),
      h('button', { class: 'primary', disabled: !!busy, title: 'Checks the key (lists the models), then uses this model', onclick: () => act('ai', '/api/settings/ai', body(), (r) => `Using ${r.ai.provider} · ${r.ai.model}${r.checked.saved ? ' · saved' : ''}`) }, busy === 'ai' ? 'Checking…' : 'Use'),
      h('button', { disabled: !!busy, title: 'Use, and ask the model one tiny question', onclick: () => act('ai', '/api/settings/ai', body({ test: true }), (r) => `${r.checked.model} answered in ${r.checked.ms} ms`) }, 'Use and try')),
    c ? h('div', { class: 'ok' }, `key accepted${c.models ? ` · ${c.models} models` : ''}${c.answered !== undefined ? ` · ${c.answered ? 'answered' : 'answered oddly'} in ${c.ms} ms (${c.usage?.input ?? 0} + ${c.usage?.output ?? 0} tokens)` : ''}`) : null,
    h('div', { class: 'hint' }, 'Enables: propose, ask again, design conversation, spec check, recipe drafts.'));
}

// n20s-server ---------------------------------------------------------------------------------
function n20sCard() {
  const n = data.n20s;
  const url = h('input', { value: n.url, placeholder: 'http://localhost:7474' });
  const save = h('input', { type: 'checkbox', style: 'width:auto', disabled: !data.envFile });
  return h('section', { class: 'pcard ccard' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h3', { title: 'n20s-server' }, 'RDF engine'),
      chip(n.ok ? 'running' : 'not reachable', n.ok ? '#2e7d32' : '#c62828', n.ok ? `version ${n.version}` : n.error)),
    h('p', { class: 'hint', title: 'n20s-server, Java 21: PORT=7474 java -jar n20s-server.jar' }, 'Keeps the in-memory RDF graphs: projection, reasoning, SPARQL, published endpoints.'),
    field('URL', url),
    h('label', { class: 'row', style: 'gap:6px;display:flex' }, save, 'Save to the env file'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: !!busy, onclick: () => act('n20s', '/api/settings/n20s', { url: url.value.trim(), save: save.checked }, (r) => `n20s-server ${r.checked.version.version}`) }, busy === 'n20s' ? 'Checking…' : 'Use')),
    h('div', { class: 'hint' }, 'Enables: recipes, endpoints, oracle.'));
}
