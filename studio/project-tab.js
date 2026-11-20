// Project tab: the head of the pipeline. LPG sources on the left, RDF targets
// on the right, the mappings between them in the middle, each with how it
// stands downstream (coverage, check, drift, recipes, endpoints).
import { fill, h, api, toast } from './dom.js';

let root = null;
let data = null;    // GET /api/project
let form = null;    // 'source' | 'target' | 'mapping' while a form is open
let busy = '';

export async function showProject(container) {
  root = container;
  await load();
  render();
}

async function load() {
  try { data = await api('/api/project'); } catch (err) { toast(err.message, true); data = { project: null }; }
}

async function act(path, body, done) {
  busy = path;
  render();
  try {
    data = await api(path, body);
    if (done) toast(typeof done === 'function' ? done(data) : done);
  } catch (err) { toast(err.message, true); }
  busy = '';
  render();
}

const chip = (text, color, title) => h('span', { class: 'chip', style: color ? `background:${color};color:#fff` : null, title }, text);
const ORIGIN = { aura: '#018bff', enterprise: '#1565c0', export: '#455a64', introspection: '#6a1b9a', file: '#455a64', url: '#00695c', catalog: '#2e7d32' };

function render() {
  if (!data.project) {
    fill(root, h('div', { class: 'pempty' },
      h('h2', {}, 'No project'),
      h('p', {}, 'The studio was started on a mapping file. A project names the LPG ontologies (exported from Aura or Enterprise, or introspected from the database), the RDF target ontologies (files, URLs, catalog) and the mappings between them.'),
      h('pre', { class: 'stmt' }, 'n20s-mapping studio examples/lineage/n20s-project.yaml')));
    return;
  }
  const p = data.project;
  fill(root,
    h('div', { class: 'phead' }, h('h2', {}, p.name), h('span', { class: 'mono', style: 'color:#888' }, p.file),
      p.problems.length ? h('div', { class: 'fail' }, p.problems.map((x) => h('div', {}, x))) : null),
    h('div', { class: 'pcols' },
      h('section', { class: 'pcol' }, h('h3', {}, 'LPG ontologies'), p.sources.map(sourceCard),
        form === 'source' ? sourceForm() : h('button', { onclick: () => { form = 'source'; render(); } }, '+ source')),
      h('div', { class: 'parrow' }, '→'),
      h('section', { class: 'pcol wide' }, h('h3', {}, 'Mappings'), p.mappings.map(mappingCard),
        form === 'mapping' ? mappingForm() : h('button', { class: 'primary', onclick: () => { form = 'mapping'; render(); } }, '+ New mapping')),
      h('div', { class: 'parrow' }, '←'),
      h('section', { class: 'pcol' }, h('h3', {}, 'RDF targets'), p.targets.map(targetCard),
        form === 'target' ? targetForm() : h('button', { onclick: () => { form = 'target'; render(); } }, '+ target'))));
}

function sourceCard(s) {
  const d = s.doc;
  return h('div', { class: 'pcard' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, s.id), chip(s.origin, ORIGIN[s.origin])),
    h('div', { class: 'mono', style: 'color:#666' }, s.file),
    d ? [
      h('div', {}, `${d.name ?? d.id} · version ${d.version}`),
      h('div', {}, `${d.nodes} node kinds · ${d.relationships} relationship types`),
      h('div', { class: d.described ? '' : 'warnline', title: 'Descriptions are what helps the AI most' }, `descriptions: ${d.described}/${d.elements}`,
        d.described ? '' : ' — the design conversation will bring the meaning'),
      h('div', { class: 'plabels' }, d.labels.slice(0, 14).map((l) => h('span', { class: 'chip' }, l)), d.labels.length > 14 ? ` +${d.labels.length - 14}` : ''),
    ] : h('div', { class: 'warnline' }, s.introspect ? 'Not introspected yet.' : 'The file is not there.'),
    s.lock?.introspectedAt ? h('div', { style: 'color:#888;font-size:11px' }, `introspected ${s.lock.introspectedAt.replace('T', ' ').slice(0, 16)} from ${s.lock.agent ?? s.lock.url}`) : null,
    s.introspect ? h('button', { disabled: !!busy || !data.can.introspect, title: data.can.introspect ? '' : 'Start the studio with --source', onclick: () => act('/api/project/introspect', { source: s.id }, (r) => {
      const x = r.introspected;
      return `${s.id}: ${x.nodes} node kinds, ${x.relationships} relationship types${x.previous ? (x.changed ? ` — the structure changed (${x.previous} → ${x.version})` : ' — unchanged') : ''}`;
    }) }, busy === '/api/project/introspect' ? 'Introspecting…' : s.doc ? 'Introspect again' : 'Introspect') : null);
}

function targetCard(t) {
  return h('div', { class: 'pcard' },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', {}, t.title), chip(t.origin, ORIGIN[t.origin])),
    h('div', { class: 'mono', style: 'color:#666' }, `${t.prefix}: ${t.namespace}`),
    t.description ? h('div', { style: 'color:#555;font-size:12px' }, t.description) : null,
    t.exists && t.terms ? [
      h('div', {}, `${t.terms.classes} classes · ${t.terms.properties} properties`),
      h('div', { class: 'plabels' }, t.terms.sample.map((c) => h('span', { class: 'chip' }, c))),
    ] : h('div', { class: 'warnline' }, t.origin === 'file' ? 'The file is not there.' : 'Not fetched yet.'),
    t.lock?.sha256 ? h('div', { style: 'color:#888;font-size:11px' }, `pinned ${t.lock.sha256.slice(0, 12)} · fetched ${t.lock.fetchedAt.replace('T', ' ').slice(0, 16)}`) : null,
    t.origin !== 'file' ? h('div', { class: 'row', style: 'gap:6px' },
      h('button', { disabled: !!busy, onclick: () => act('/api/project/fetch', { target: t.id }, (r) => `${t.id}: ${r.fetched.triples} triples, ${r.fetched.terms} terms`) }, t.exists ? 'Fetch again' : 'Fetch'),
      t.exists ? h('button', { disabled: !!busy, title: 'Accept a document that changed since it was pinned', onclick: () => act('/api/project/fetch', { target: t.id, repin: true }, 'Re-pinned') }, 'Re-pin') : null) : null);
}

function mappingCard(m) {
  const active = data.active === m.id;
  const c = m.coverage;
  const pct = (n) => (c && c.total ? `${(100 * n) / c.total}%` : '0');
  return h('div', { class: `pcard${active ? ' active' : ''}` },
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('b', { style: 'font-size:14px' }, m.id), active ? chip('open', '#018bff') : null),
    h('div', {}, h('span', { class: 'chip' }, m.source), ' → ', m.targets.map((t) => h('span', { class: 'chip' }, t))),
    h('div', { class: 'mono', style: 'color:#666' }, m.file),
    m.exists ? [
      c ? [h('div', { class: 'bar', style: 'width:100%;margin-top:6px' }, h('span', { style: `width:${pct(c.decided)};background:#2e7d32` }), h('span', { style: `width:${pct(c.proposed)};background:#1565c0` })),
        h('div', { style: 'font-size:12px;color:#555' }, `${c.decided}/${c.total} decided${c.proposed ? ` · ${c.proposed} proposed, to review` : ''}`)] : null,
      m.check ? h('div', { style: 'font-size:12px' }, chip(`check ${m.check.errors} E · ${m.check.warnings} W`, m.check.errors ? '#c62828' : null),
        m.check.drift.length ? chip('drift', '#e65100', m.check.drift.join('\n')) : null,
        m.sourceMatches === false ? chip('other LPG file', '#e65100', 'The mapping points to another LPG file than its source in the project') : null) : null,
      h('div', { style: 'font-size:12px;margin-top:4px' },
        chip(m.specExists ? 'spec' : 'no spec yet', m.specExists ? '#2e7d32' : null, 'The specification comes from the design conversation (next step)'),
        m.recipes ? ` ${m.recipeCount} recipes` : '', m.bench ? ' · bench' : '',
        (m.endpoints ?? []).map((e) => chip(`/sparql/${e.endpoint}`, e.status === 'served' ? '#00695c' : '#e65100', e.status))),
    ] : h('div', { class: 'warnline' }, m.error ?? 'The file is not there.'),
    h('div', { class: 'row', style: 'gap:6px;margin-top:6px' },
      h('button', { class: active ? '' : 'primary', disabled: !!busy || !m.exists, onclick: async () => {
        try { await api('/api/project/open', { mapping: m.id }); location.href = '/'; } catch (err) { toast(err.message, true); }
      } }, active ? 'Review it' : 'Open'),
      active ? h('button', { onclick: () => { location.href = '/recipes'; } }, 'Recipes') : null));
}

// Forms -------------------------------------------------------------------------------------------------
function cancel() { return h('button', { onclick: () => { form = null; render(); } }, 'Cancel'); }

function sourceForm() {
  const id = h('input', { placeholder: 'id, for instance crm' });
  const kind = h('select', {}, [['aura', 'file exported from Aura'], ['enterprise', 'file exported from Enterprise Studio'], ['introspection', 'introspection of the database']].map(([v, t]) => h('option', { value: v }, t)));
  const file = h('input', { placeholder: 'file, relative to the project (for instance crm.json)' });
  const url = h('input', { placeholder: 'bolt:// URL (empty: the studio\'s source)' });
  const sync = () => { url.style.display = kind.value === 'introspection' ? '' : 'none'; };
  kind.addEventListener('change', sync);
  sync();
  return h('div', { class: 'form' }, id, kind, file, url, h('div', { class: 'row' },
    h('button', { class: 'primary', onclick: () => {
      const value = kind.value === 'introspection' ? { introspect: url.value || true, file: file.value } : { file: file.value, origin: kind.value };
      form = null;
      act('/api/project/add', { section: 'sources', id: id.value, value }, `Source ${id.value} added`);
    } }, 'Add'), cancel()));
}

function targetForm() {
  const taken = new Set(data.project.targets.map((t) => t.id));
  const kind = h('select', {}, [['catalog', 'from the catalog'], ['url', 'from a URL (Turtle, N-Triples)'], ['file', 'a file of the project']].map(([v, t]) => h('option', { value: v }, t)));
  const cat = h('select', {}, data.project.catalog.filter((c) => !taken.has(c.id)).map((c) => h('option', { value: c.id, title: c.description }, `${c.title} (${c.prefix})`)));
  const id = h('input', { placeholder: 'id' });
  const where = h('input', { placeholder: 'URL or file' });
  const ns = h('input', { placeholder: 'namespace, for instance https://example.org/onto#' });
  const prefix = h('input', { placeholder: 'prefix' });
  const sync = () => { const c = kind.value === 'catalog'; cat.style.display = c ? '' : 'none'; for (const x of [id, where, ns, prefix]) x.style.display = c ? 'none' : ''; };
  kind.addEventListener('change', sync);
  sync();
  return h('div', { class: 'form' }, kind, cat, id, where, ns, prefix, h('div', { class: 'row' },
    h('button', { class: 'primary', onclick: () => {
      form = null;
      if (kind.value === 'catalog') act('/api/project/add', { section: 'targets', id: cat.value, value: { catalog: cat.value } }, `Target ${cat.value} added: fetch it`);
      else act('/api/project/add', { section: 'targets', id: id.value, value: { [kind.value]: where.value, namespace: ns.value, prefix: prefix.value || id.value } }, `Target ${id.value} added`);
    } }, 'Add'), cancel()));
}

function mappingForm() {
  const p = data.project;
  const id = h('input', { placeholder: 'id, for instance lineage-dcat' });
  const source = h('select', {}, p.sources.filter((s) => s.exists).map((s) => h('option', { value: s.id }, s.id)));
  const boxes = p.targets.filter((t) => t.exists).map((t) => ({ t, box: h('input', { type: 'checkbox', style: 'width:auto' }) }));
  const base = h('input', { placeholder: 'base IRI of generated IRIs, for instance https://example.org/lineage/' });
  const prefix = h('input', { placeholder: 'its prefix, for instance lin', value: 'ex' });
  return h('div', { class: 'form' },
    h('b', {}, 'New mapping'), id,
    h('label', {}, 'from ', source),
    h('div', {}, 'to ', boxes.length ? boxes.map(({ t, box }) => h('label', { class: 'row', style: 'gap:4px;display:inline-flex;margin-right:10px' }, box, `${t.title} (${t.prefix})`)) : h('span', { class: 'warnline' }, 'no target with a file yet')),
    base, prefix,
    h('div', { style: 'color:#666;font-size:12px' }, 'The mapping starts empty. Next: the design conversation writes its specification with you, then propose fills it in for review.'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => {
        const targets = boxes.filter((b) => b.box.checked).map((b) => b.t.id);
        form = null;
        act('/api/project/mapping', { id: id.value, source: source.value, targets, baseIri: base.value, prefix: prefix.value }, (r) => `Created ${r.created.file}`);
      } }, 'Create'), cancel()));
}
