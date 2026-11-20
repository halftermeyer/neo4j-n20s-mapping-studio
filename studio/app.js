// n20s-mapping studio: review AI proposals on a drawing of the LPG ontology.
// Plain DOM and SVG; the server holds the mapping file and does the checking.

import { $, kids, fill, h, s, api, toast, tid } from './dom.js';
import { showRecipes } from './recipes.js';
import { showBench } from './bench-tab.js';
import { showProject } from './project-tab.js';
import { showDesign } from './design-tab.js';
import { showConnections } from './connections-tab.js';

let S = null;            // state from /api/state
let selected = null;     // element key, for instance "relationships/r:0"
let filter = 'review';
let editing = null;      // { path, kind } while an edit form is open
let view = null;         // graph pan and zoom: { x, y, k }
let oracle = null;       // last oracle run
let tab = { '/recipes': 'recipes', '/bench': 'bench', '/project': 'project', '/design': 'design', '/connections': 'connections' }[location.pathname] ?? 'mapping';

function setTab(t) {
  tab = t;
  history.replaceState(null, '', t === 'mapping' ? `/${selected ? `#${selected}` : ''}` : `/${t}`);
  document.querySelector('main').hidden = t !== 'mapping';
  $('recipes-view').hidden = t !== 'recipes';
  $('bench-view').hidden = t !== 'bench';
  $('project-view').hidden = t !== 'project';
  $('design-view').hidden = t !== 'design';
  $('connections-view').hidden = t !== 'connections';
  $('oracle').hidden = true;
  renderTop();
  if (t === 'recipes') showRecipes($('recipes-view'));
  if (t === 'bench') showBench($('bench-view'));
  if (t === 'project') showProject($('project-view'));
  if (t === 'design') showDesign($('design-view'));
  if (t === 'connections') showConnections($('connections-view'));
  // Other tabs change the mapping (the design conversation proposes it): read it again.
  if (t === 'mapping' && S) api('/api/state').then((state) => { S = state; render(); }).catch((err) => toast(err.message, true));
}

async function act(fn, done) {
  try {
    const next = await fn();
    if (next?.items) S = next;
    editing = null;
    render();
    if (done) toast(typeof done === 'function' ? done(next) : done);
  } catch (err) {
    toast(err.message, true);
  }
}

// Model helpers ---------------------------------------------------------------------------
const statusOf = (e) => e?.meta?.status ?? 'accepted';
const nodeLabel = (id) => S.lpg.nodes[id]?.labels?.identifier ?? S.lpg.nodes[id]?.label ?? id;
const relOf = (id) => S.lpg.relationships[id];
const itemOf = (key) => S.items.find((i) => i.key === key);
const entryOf = (key) => { const [section, id] = key.split('/'); return S.mapping[section]?.[id]; };
const labelToNode = () => Object.fromEntries(Object.entries(S.lpg.nodes).map(([id, n]) => [n.labels?.identifier ?? n.label, id]));

function ancestors(id) {
  const byLabel = labelToNode();
  const out = [];
  let frontier = [id];
  while (frontier.length) {
    const next = [];
    for (const n of frontier) {
      for (const l of S.lpg.nodes[n]?.labels?.implied ?? []) {
        const a = byLabel[l];
        if (a && !out.includes(a) && a !== id) { out.push(a); next.push(a); }
      }
    }
    frontier = next;
  }
  return out;
}
const live = (e) => e && statusOf(e) !== 'rejected';
function effective(id) {
  let subject = null;
  const classes = [];
  for (const n of [id, ...ancestors(id)]) {
    const e = S.mapping.nodes?.[n];
    if (!live(e) || e.ignore) continue;
    if (!subject && e.subject) subject = { template: e.subject, from: n };
    for (const c of e.classes ?? []) if (!classes.some((x) => x.c === c)) classes.push({ c, from: n });
  }
  return { subject, classes };
}
function aliasOf(id, pid) {
  const p = S.lpg.nodes[id]?.properties?.[pid];
  if (!p) return null;
  for (const a of [...ancestors(id)].reverse()) {
    for (const [qid, q] of Object.entries(S.lpg.nodes[a].properties ?? {})) {
      if ((q.name ?? qid) === (p.name ?? pid) && (q.type ?? null) === (p.type ?? null)) return { owner: a, pid: qid };
    }
  }
  return null;
}
const placeholders = (t) => [...(t ?? '').matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
const termOf = (curie) => S.catalog.terms.find((t) => t.curie === curie);
function category(item) {
  if (!item || item.status === 'undecided') return 'undecided';
  if (item.status === 'proposed') return item.safe ? 'safe' : 'review';
  if (item.status === 'accepted') return 'accepted';
  if (item.status === 'rejected') return 'rejected';
  return 'ignored';
}
const COLORS = { accepted: '#2e7d32', safe: '#1565c0', review: '#e65100', rejected: '#c62828', ignored: '#9e9e9e', undecided: '#ffffff' };
const CAT_TEXT = { accepted: 'accepted', safe: 'proposed, safe', review: 'to review', rejected: 'rejected', ignored: 'left out', undecided: 'undecided' };

// Rendering -------------------------------------------------------------------------------
function render() {
  renderTop();
  renderQueue();
  renderGraph();
  renderPanel();
  if (!$('oracle').hidden) renderOracle();
}

function renderTop() {
  const cov = S.check.coverage;
  const bar = (name, b) => {
    const decided = ['mapped', 'ignored', 'deferred', 'subject', 'inherited'].reduce((n, k) => n + (b[k] ?? 0), 0);
    const seg = (n, color) => (n ? h('span', { style: `width:${(100 * n) / b.total}%;background:${color}` }) : null);
    return h('div', { class: 'covitem', title: JSON.stringify(b) },
      `${name} ${decided}/${b.total}${b.proposed ? ` · ${b.proposed} proposed` : ''}`,
      h('div', { class: 'bar' }, seg(decided, COLORS.accepted), seg(b.proposed ?? 0, COLORS.safe)));
  };
  const safe = S.items.filter((i) => i.safe).length;
  fill($('top'), 
    h('h1', {}, S.title ?? 'n20s-mapping studio'),
    h('div', { class: 'tabs top-tabs' },
      h('button', { class: tab === 'project' ? 'on' : '', onclick: () => setTab('project'), 'data-testid': 'tab-project' }, 'Project'),
      h('button', { class: tab === 'design' ? 'on' : '', onclick: () => setTab('design'), 'data-testid': 'tab-design' }, 'Design'),
      h('button', { class: tab === 'mapping' ? 'on' : '', onclick: () => setTab('mapping'), 'data-testid': 'tab-mapping' }, 'Mapping'),
      h('button', { class: tab === 'recipes' ? 'on' : '', onclick: () => setTab('recipes'), 'data-testid': 'tab-recipes' }, 'Recipes'),
      h('button', { class: tab === 'bench' ? 'on' : '', onclick: () => setTab('bench'), 'data-testid': 'tab-bench' }, 'Bench'),
      h('button', { class: tab === 'connections' ? 'on' : '', onclick: () => setTab('connections'), 'data-testid': 'tab-connections' }, 'Connections')),
    h('span', { class: 'file mono', title: S.file }, S.project ? `${S.project.mapping} · ${S.file.split('/').pop()}` : S.file.split('/').pop()),
    h('div', { class: 'cov' },
      bar('node kinds', cov.nodes), bar('node properties', cov.nodeProperties),
      bar('relationships', cov.relationships), bar('rel. properties', cov.relationshipProperties)),
    h('span', { class: `chip ${S.check.summary.errors ? 'error' : 'accepted'}` }, `check: ${S.check.summary.errors} errors, ${S.check.summary.warnings} warnings`),
    h('button', {
      class: 'primary', disabled: !safe, 'data-testid': 'accept-safe',
      title: 'Proposed, identical in every pass, confidence ≥ 0.95, no check finding',
      onclick: () => confirm(`Accept the ${safe} safe elements?`) && act(() => api('/api/accept-safe', {}), `${safe} elements accepted`),
    }, `Accept safe (${safe})`),
    h('button', { 'data-testid': 'oracle-toggle', onclick: () => { $('oracle').hidden = !$('oracle').hidden; renderOracle(); } }, 'Oracle'),
  );
}

function renderQueue() {
  const groups = {
    review: (i) => (i.status === 'proposed' && !i.safe) || i.status === 'rejected' || i.status === 'undecided',
    safe: (i) => i.safe,
    done: (i) => ['accepted', 'ignored', 'deferred'].includes(i.status),
    all: () => true,
  };
  const names = { review: 'To review', safe: 'Safe', done: 'Decided', all: 'All' };
  const list = S.items.filter(groups[filter]);
  fill($('queue'), 
    h('div', { class: 'tabs' }, Object.keys(groups).map((g) => h('button', {
      class: g === filter ? 'on' : '', onclick: () => { filter = g; renderQueue(); }, 'data-testid': `queue-filter-${g}`,
    }, `${names[g]} ${S.items.filter(groups[g]).length}`))),
    list.length ? list.map((i) => h('div', {
      class: `qitem${i.key === selected ? ' sel' : ''}`,
      style: `border-left-color:${COLORS[category(i)] === '#ffffff' ? '#ccc' : COLORS[category(i)]}`,
      onclick: () => select(i.key), 'data-testid': `queue-${tid(i.key)}`,
    },
    h('div', { class: 'name' }, i.label),
    h('div', { class: 'meta' },
      h('span', { class: `chip ${category(i)}` }, CAT_TEXT[category(i)]),
      [...new Set(i.reasons.map((r) => r.code))].map((c) => h('span', { class: `chip ${c}` }, c)),
      i.confidence !== null ? ` conf. ${i.confidence}` : ''))) : h('div', { class: 'empty', style: 'padding:20px;color:#888' }, 'Nothing here.'),
  );
}

function select(key) {
  selected = key;
  history.replaceState(null, '', `#${key}`);
  editing = null;
  renderQueue();
  renderGraph();
  renderPanel();
}

// Graph -------------------------------------------------------------------------------------
const R = 46;
let layout = null;
/**
 * The layout drawn in the modeling tool (extensions.display), with nodes that
 * sit too close pushed apart: the drawing stays recognizable, labels get room.
 */
function positions() {
  if (layout) return layout;
  const ids = Object.keys(S.lpg.nodes);
  const pos = {};
  ids.forEach((id, i) => {
    const d = S.lpg.nodes[id].extensions?.display;
    pos[id] = d && Number.isFinite(d.x) ? { x: d.x * 2, y: d.y * 2 } : { x: 400 * Math.cos((2 * Math.PI * i) / ids.length), y: 400 * Math.sin((2 * Math.PI * i) / ids.length) };
  });
  const home = Object.fromEntries(ids.map((id) => [id, { ...pos[id] }]));
  const MIN = 230;
  for (let it = 0; it < 400; it++) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos[ids[i]];
        const b = pos[ids[j]];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist >= MIN) continue;
        if (dist < 1) { dx = 1; dy = 0; dist = 1; }
        const push = (MIN - dist) / 2;
        a.x -= (dx / dist) * push; a.y -= (dy / dist) * push;
        b.x += (dx / dist) * push; b.y += (dy / dist) * push;
      }
    }
    for (const id of ids) { pos[id].x += (home[id].x - pos[id].x) * 0.02; pos[id].y += (home[id].y - pos[id].y) * 0.02; }
  }
  layout = pos;
  return pos;
}

function renderGraph() {
  const svgEl = $('graph');
  const pos = positions();
  const g = s('g', { id: 'world' });
  const defs = s('defs');
  for (const [cat, color] of Object.entries(COLORS)) {
    defs.append(s('marker', { id: `arrow-${cat}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
      s('path', { d: 'M0,0 L10,5 L0,10 z', fill: cat === 'undecided' ? '#78909c' : color })));
  }

  // Implied labels: dashed, from the subtype to the kind it implies.
  for (const id of Object.keys(S.lpg.nodes)) {
    for (const a of ancestors(id).slice(0, 1)) {
      const [p, q] = [pos[id], pos[a]];
      g.append(s('line', { class: 'implied', x1: p.x, y1: p.y, x2: q.x, y2: q.y }));
    }
  }

  // Relationships: parallel ones bend apart, self loops go above the node.
  const groups = {};
  for (const [id, r] of Object.entries(S.lpg.relationships)) {
    const k = [r.from.node, r.to.node].sort().join('|');
    (groups[k] ??= []).push(id);
  }
  for (const [k, ids] of Object.entries(groups)) {
    ids.forEach((id, i) => {
      const r = relOf(id);
      const key = `relationships/${id}`;
      const cat = category(itemOf(key));
      const color = cat === 'undecided' ? '#78909c' : COLORS[cat];
      const a = pos[r.from.node];
      const b = pos[r.to.node];
      let d;
      let lx;
      let ly;
      if (r.from.node === r.to.node) {
        const w = 36 + 18 * i;
        const top = a.y - R - 60 - 26 * i;
        d = `M${a.x - 14},${a.y - R + 4} C${a.x - w},${top} ${a.x + w},${top} ${a.x + 14},${a.y - R + 4}`;
        lx = a.x;
        ly = top + 8;
      } else {
        const off = (i - (ids.length - 1) / 2) * 46 * (r.from.node < r.to.node ? 1 : -1);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const mx = (a.x + b.x) / 2 + nx * off;
        const my = (a.y + b.y) / 2 + ny * off;
        const start = { x: a.x + ((mx - a.x) / Math.hypot(mx - a.x, my - a.y)) * R, y: a.y + ((my - a.y) / Math.hypot(mx - a.x, my - a.y)) * R };
        const end = { x: b.x + ((mx - b.x) / Math.hypot(mx - b.x, my - b.y)) * (R + 2), y: b.y + ((my - b.y) / Math.hypot(mx - b.x, my - b.y)) * (R + 2) };
        d = `M${start.x},${start.y} Q${mx},${my} ${end.x},${end.y}`;
        lx = (start.x + 2 * mx + end.x) / 4;
        ly = (start.y + 2 * my + end.y) / 4;
      }
      const w = r.type.length * 7.4 + 14;
      g.append(s('g', { class: `edge${selected === key ? ' sel' : ''}`, onclick: (e) => { e.stopPropagation(); select(key); } },
        s('path', { class: 'hit', d }),
        s('path', { class: 'line', d, stroke: color, 'marker-end': `url(#arrow-${cat})`, 'stroke-dasharray': cat === 'ignored' ? '5 4' : null }),
        s('rect', { x: lx - w / 2, y: ly - 10, width: w, height: 20, rx: 10, fill: '#fff', stroke: color }),
        s('text', { x: lx, y: ly + 0.5, fill: cat === 'ignored' ? '#777' : '#1d2530' }, r.type)));
    });
  }

  for (const id of Object.keys(S.lpg.nodes)) {
    const key = `nodes/${id}`;
    const cat = category(itemOf(key));
    const p = pos[id];
    const label = nodeLabel(id);
    const dark = !['undecided', 'ignored'].includes(cat);
    g.append(s('g', { class: `node${selected === key ? ' sel' : ''}`, onclick: (e) => { e.stopPropagation(); select(key); } },
      s('circle', { cx: p.x, cy: p.y, r: R, fill: COLORS[cat] }),
      s('text', { x: p.x, y: p.y, fill: dark ? '#fff' : '#1d2530', style: label.length > 11 ? 'font-size:11px' : null }, label)));
  }

  fill(svgEl, defs, g);
  if (!view) {
    const xs = Object.values(pos).map((p) => p.x);
    const ys = Object.values(pos).map((p) => p.y);
    const box = { x: Math.min(...xs) - 90, y: Math.min(...ys) - 110, w: Math.max(...xs) - Math.min(...xs) + 180, h: Math.max(...ys) - Math.min(...ys) + 200 };
    const { width, height } = svgEl.getBoundingClientRect();
    const k = Math.min(width / box.w, height / box.h);
    view = { k, x: (width - box.w * k) / 2 - box.x * k, y: (height - box.h * k) / 2 - box.y * k };
  }
  g.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  fill($('legend'), ...Object.entries(CAT_TEXT).map(([c, t]) => h('span', {}, h('i', { style: `background:${COLORS[c]}` }), t)),
    h('span', {}, '- - - implies'));
}

function setupPanZoom() {
  const svgEl = $('graph');
  let drag = null;
  svgEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svgEl.getBoundingClientRect();
    const f = Math.exp(-e.deltaY * 0.0015);
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    view = { k: view.k * f, x: px - (px - view.x) * f, y: py - (py - view.y) * f };
    $('world').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  }, { passive: false });
  svgEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node, .edge')) return;
    drag = { x: e.clientX - view.x, y: e.clientY - view.y };
    svgEl.classList.add('panning');
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view = { ...view, x: e.clientX - drag.x, y: e.clientY - drag.y };
    $('world').setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  });
  window.addEventListener('pointerup', () => { drag = null; svgEl.classList.remove('panning'); });
}

// Panel ---------------------------------------------------------------------------------------
const termTitle = (curie) => { const t = termOf(curie); return t ? `${t.curie} (${t.kind})${t.text ? `: ${t.text}` : ''}` : curie; };
const T = (curie) => h('code', { title: termTitle(curie) }, curie);

function describe(key, e) {
  if (!e) return [h('div', { class: 'sentence' }, 'No decision yet.')];
  if (e.ignore) return [h('div', { class: 'sentence' }, h('b', {}, e.ignore.deferred ? 'Deferred' : 'Left out'), ': ', e.ignore.reason)];
  const [section, id] = key.split('/');
  if (section === 'nodes') {
    const eff = effective(id);
    const out = [];
    out.push(h('div', { class: 'sentence' }, `Each ${nodeLabel(id)} node becomes `, h('code', {}, eff.subject?.template ?? '(no subject)'),
      eff.subject && eff.subject.from !== id ? ` (from ${nodeLabel(eff.subject.from)})` : ''));
    const own = eff.classes.filter((c) => c.from === id);
    const inherited = eff.classes.filter((c) => c.from !== id);
    out.push(h('div', { class: 'sentence' }, 'typed ', own.length ? own.map((c, i) => [i ? ', ' : '', T(c.c)]) : '(no class of its own)',
      inherited.length ? [' and, inherited, ', inherited.map((c, i) => [i ? ', ' : '', T(c.c), ` (${nodeLabel(c.from)})`])] : ''));
    return out;
  }
  const r = relOf(id);
  const [a, b] = e.direction === 'reverse' ? [nodeLabel(r.to.node), nodeLabel(r.from.node)] : [nodeLabel(r.from.node), nodeLabel(r.to.node)];
  const out = [];
  if (e.predicate) out.push(h('div', { class: 'sentence' }, `a ${a} `, T(e.predicate), ` a ${b}${e.direction === 'reverse' ? ' (reversed)' : ''}`));
  if (e.qualified) {
    out.push(h('div', { class: 'sentence' }, '+ one ', T(e.qualified.class), ' per relationship, ', h('code', {}, e.qualified.subject ?? '')));
    out.push(h('div', { class: 'sentence' }, `  ${a} `, T(e.qualified.link), ` it; it `, T(e.qualified.target), ` ${b}`));
  }
  return out;
}

/** The relationship in the LPG (top) and the triples it becomes (bottom). */
function miniDiagram(id, e) {
  const r = relOf(id);
  const A = nodeLabel(r.from.node);
  const B = nodeLabel(r.to.node);
  const cut = (t, n = 18) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const W = 400;
  const H = e?.qualified ? 190 : 128;
  const box = (x, y, text, fill = '#fff') => [
    s('rect', { x: x - 60, y: y - 13, width: 120, height: 26, rx: 13, fill, stroke: '#37474f' }),
    s('text', { x, y: y + 4, 'text-anchor': 'middle' }, cut(text))];
  const arrow = (x1, y1, x2, y2, label, dx = 0, dy = -6, color = '#1565c0') => [
    s('line', { x1, y1, x2, y2, stroke: '#37474f', 'stroke-width': 1.4, 'marker-end': 'url(#mini-arrow)' }),
    label ? s('text', { x: (x1 + x2) / 2 + dx, y: (y1 + y2) / 2 + dy, 'text-anchor': 'middle', fill: color }, cut(label, 28)) : null];
  const parts = [
    s('defs', {}, s('marker', { id: 'mini-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#37474f' }))),
    s('text', { x: 8, y: 14, fill: '#66707c' }, 'LPG'),
    ...box(80, 34, A, '#eef3f8'), ...box(320, 34, B, '#eef3f8'),
    ...arrow(140, 34, 258, 34, `:${r.type}`, 0, -6, '#37474f'),
    s('line', { x1: 8, y1: 60, x2: W - 8, y2: 60, stroke: '#e0e3e7' }),
    s('text', { x: 8, y: 76, fill: '#66707c' }, 'RDF'),
  ];
  if (!e || e.ignore) {
    parts.push(s('text', { x: W / 2, y: 100, 'text-anchor': 'middle', fill: '#888' }, !e ? 'not decided yet' : e.ignore.deferred ? 'deferred: not exported for now' : 'not exported'));
  } else {
    const [sa, sb] = e.direction === 'reverse' ? [B, A] : [A, B];
    parts.push(...box(80, 100, sa), ...box(320, 100, sb));
    if (e.predicate) parts.push(...arrow(140, 100, 258, 100, e.predicate));
    if (e.qualified) {
      parts.push(...box(200, 165, e.qualified.class, '#fff8e1'));
      parts.push(...arrow(95, 113, 160, 152, e.qualified.link, -52, 4));
      parts.push(...arrow(240, 152, 305, 113, e.qualified.target, 52, 4));
    }
  }
  return s('svg', { class: 'mini', viewBox: `0 0 ${W} ${H}`, height: H }, ...parts);
}

function propRows(key) {
  const [section, id] = key.split('/');
  const lpgEl = section === 'nodes' ? S.lpg.nodes[id] : relOf(id);
  const e = entryOf(key);
  const eff = section === 'nodes' ? effective(id) : null;
  const inSubject = placeholders(eff?.subject?.template);
  return Object.entries(lpgEl.properties ?? {}).map(([pid, p]) => {
    const path = `${key}/properties/${pid}`;
    const pe = e?.ignore ? null : e?.properties?.[pid];
    let what;
    let status;
    const alias = section === 'nodes' ? aliasOf(id, pid) : null;
    if (e?.ignore) { what = 'with the element'; status = { proposed: 'proposed', rejected: 'rejected' }[statusOf(e)] ?? 'ignored'; }
    else if (pe) {
      status = statusOf(pe);
      what = pe.ignore ? [`${pe.ignore.deferred ? 'deferred' : 'left out'}: `, h('span', { class: 'why' }, pe.ignore.reason)]
        : ['→ ', T(pe.predicate), pe.values ? ` as IRIs (${Object.keys(pe.values).join(', ')})` : pe.datatype ? ` ^^${pe.datatype}` : ''];
    } else if (inSubject.includes(pid) || (alias && inSubject.includes(alias.pid))) { what = 'in the IRI'; status = 'subject'; }
    else if (alias) { what = `same as ${nodeLabel(alias.owner)}.${p.name ?? pid}`; status = 'inherited'; }
    else if (section === 'nodes' && ancestors(id).some((a) => S.mapping.nodes?.[a]?.properties?.[pid])) { what = 'inherited'; status = 'inherited'; }
    else { what = 'undecided'; status = 'undecided'; }
    const cat = status === 'proposed' ? 'proposed' : status;
    const canEdit = !e?.ignore && e;
    return [
      h('tr', { class: alias && !pe ? 'alias' : '' },
        h('td', { title: p.description ?? '' }, h('b', {}, p.name ?? pid), h('div', { class: 'mono', style: 'color:#888' }, p.type ?? '')),
        h('td', {}, what, pe?.meta?.confidence !== undefined && status === 'proposed' ? h('div', { style: 'color:#888;font-size:11px' }, `conf. ${pe.meta.confidence}`) : ''),
        h('td', {}, h('span', { class: `chip ${cat}` }, status), S.variants?.elements[path] && !S.variants.elements[path].stable ? h('span', { class: 'chip unstable', title: 'Different in other passes' }, 'unstable') : ''),
        h('td', { class: 'act' },
          status === 'proposed' && pe ? [
            h('button', { title: 'Accept', onclick: () => act(() => api('/api/decide', { path, action: 'accept' })) }, '✓'),
            h('button', { title: 'Reject', class: 'bad', onclick: () => { const c = prompt('Why is this wrong? (sent to the model if you propose again)'); if (c !== null) act(() => api('/api/decide', { path, action: 'reject', comment: c || undefined })); } }, '✗'),
          ] : '',
          canEdit && !['subject', 'inherited'].includes(status) ? h('button', { title: 'Edit', onclick: () => { editing = { path, kind: 'property' }; renderPanel(); } }, '✎') : '')),
      editing?.path === path ? h('tr', {}, h('td', { colspan: 4 }, propertyForm(path, p, pe))) : null,
    ];
  });
}

function renderPanel() {
  const panel = $('panel');
  if (!selected) {
    fill(panel, h('div', { class: 'empty' }, 'Select a node kind or a relationship type in the graph or in the list.',
      h('p', {}, 'Colors: ', Object.entries(CAT_TEXT).map(([c, t]) => h('span', { class: `chip ${c === 'review' ? 'review' : c === 'safe' ? 'safe' : c}` }, t)))));
    return;
  }
  const item = itemOf(selected);
  const [section, id] = selected.split('/');
  const e = entryOf(selected);
  const lpgEl = section === 'nodes' ? S.lpg.nodes[id] : relOf(id);
  const variants = S.variants ? Object.entries(S.variants.elements).filter(([p, v]) => (p === selected || p.startsWith(`${selected}/`)) && !v.stable) : [];
  const findings = S.check.findings.filter((f) => f.path === selected || f.path.startsWith(`${selected}/`));
  const proposedHere = item.proposed.length > 0;

  fill(panel, 
    h('h2', { 'data-testid': `panel-${tid(selected)}` }, item.label),
    h('div', {}, h('span', { class: `chip ${category(item)}` }, CAT_TEXT[category(item)]),
      [...new Set(item.reasons.map((r) => r.code))].map((c) => h('span', { class: `chip ${c}` }, c))),
    lpgEl.description ? h('div', { class: 'desc', style: 'margin-top:8px' }, lpgEl.description) : h('div', { class: 'desc', style: 'margin-top:8px;color:#999' }, 'No description in the LPG ontology. A description is what helps the model most.'),

    h('h3', {}, statusOf(e) === 'rejected' && e ? 'Rejected proposal' : 'Decision'),
    h('div', { style: statusOf(e) === 'rejected' && e ? 'text-decoration:line-through;color:#888' : null }, describe(selected, e)),
    statusOf(e) === 'rejected' && e ? h('div', { class: 'sentence' }, 'Undecided until the model proposes again or you edit it.') : null,
    section === 'relationships' ? miniDiagram(id, statusOf(e) === 'rejected' ? null : e) : null,
    e?.meta?.rationale ? h('div', { class: 'why', style: 'margin-top:6px' }, `“${e.meta.rationale}”`) : null,
    e?.meta ? h('div', { style: 'color:#888;font-size:11px;margin-top:3px' },
      [e.meta.proposedBy ? `by ${e.meta.proposedBy.kind}${e.meta.proposedBy.model ? ` ${e.meta.proposedBy.model}` : ''}${e.meta.proposedBy.name ? ` ${e.meta.proposedBy.name}` : ''}` : '',
        e.meta.confidence !== undefined ? `confidence ${e.meta.confidence}` : '',
        e.meta.reviewedBy ? `reviewed by ${e.meta.reviewedBy}` : '',
        e.meta.reviewComment ? `comment: ${e.meta.reviewComment}` : ''].filter(Boolean).join(' · ')) : null,

    h('div', { class: 'actions' },
      proposedHere ? h('button', { class: 'good', 'data-testid': 'accept', onclick: () => act(() => api('/api/decide', { path: selected, action: 'accept' }), 'Accepted') }, `Accept${item.proposed.length > 1 ? ` (${item.proposed.length} entries)` : ''}`) : null,
      proposedHere ? h('button', { class: 'bad', 'data-testid': 'reject', onclick: () => { editing = { path: selected, kind: 'reject' }; renderPanel(); } }, 'Reject…') : null,
      h('button', { 'data-testid': 'edit', onclick: () => { editing = { path: selected, kind: 'element' }; renderPanel(); } }, 'Edit'),
      S.can.propose && !proposedHere && item.status !== 'accepted' ? h('button', { onclick: () => act(() => api('/api/propose', { key: selected }), 'Proposed') }, 'Ask the model') : null),
    editing?.path === selected && editing.kind === 'reject' ? rejectForm() : null,
    editing?.path === selected && editing.kind === 'element' ? (section === 'nodes' ? nodeForm(id, e) : relForm(id, e)) : null,

    findings.length ? [h('h3', {}, 'Check'), findings.map((f) => h('div', { class: `finding ${f.severity}` }, `${f.code}: ${f.message}`))] : null,

    Object.keys(lpgEl.properties ?? {}).length ? [h('h3', {}, 'Properties'),
      h('table', { class: 'props' }, h('tr', {}, h('th', {}, 'property'), h('th', {}, 'decision'), h('th', {}, ''), h('th', {}, '')), propRows(selected))] : null,

    variants.length ? h('details', { style: 'margin-top:14px', 'data-testid': 'variants' },
      h('summary', { style: 'cursor:pointer;color:#e65100' }, `${variants.length} decision${variants.length > 1 ? 's differ' : ' differs'} between the ${S.variants.passes} passes`),
      variants.map(([p, v]) => h('div', {}, h('div', { class: 'mono', style: 'color:#888;margin-top:6px' }, p === selected ? '(element)' : propName(p)),
        v.variants.map((x) => h('div', { class: 'variant' }, `pass ${x.passes.join(', ')}: `, summarize(x.entry)))))) : null,
  );
}

function propName(path) {
  const [section, id, , pid] = path.split('/');
  const el = section === 'nodes' ? S.lpg.nodes[id] : relOf(id);
  return el.properties?.[pid]?.name ?? pid;
}
function summarize(e) {
  if (!e) return 'no answer';
  if (e.ignore) return `${e.ignore.deferred ? 'deferred' : 'left out'}: ${e.ignore.reason}`;
  return [e.classes?.length ? `classes ${e.classes.join(', ')}` : '', e.predicate ? `→ ${e.predicate}` : '', e.direction === 'reverse' ? '(reversed)' : '',
    e.qualified ? `qualified ${e.qualified.class}` : '', e.values ? `as IRIs` : '', e.datatype ? `^^${e.datatype}` : ''].filter(Boolean).join(' ') || 'mapped, no class of its own';
}

// Forms ----------------------------------------------------------------------------------------
const classes = () => S.catalog.terms.filter((t) => t.kind === 'class').map((t) => t.curie);
const properties = () => S.catalog.terms.filter((t) => t.kind !== 'class').map((t) => t.curie);
let listId = 0;
function termInput(value, options, placeholder) {
  const id = `terms-${listId++}`;
  const help = h('div', { class: 'term' }, value ? termTitle(value) : '');
  const input = h('input', { list: id, value: value ?? '', placeholder, oninput: () => { help.textContent = termOf(input.value) ? termTitle(input.value) : ''; } });
  return { input, el: h('div', {}, input, h('datalist', { id }, options.map((o) => h('option', { value: o }))), help) };
}
function decisionSelect(value) {
  return h('select', { 'data-testid': 'decision' }, ['map', 'ignore', 'defer'].map((d) => h('option', { value: d, selected: d === value }, d)));
}
const decisionOf = (e) => (!e ? 'map' : e.ignore ? (e.ignore.deferred ? 'defer' : 'ignore') : 'map');

function formShell(title, fields, build) {
  const err = h('div', { class: 'err' });
  return h('div', { class: 'form' }, h('b', {}, title), ...fields,
    err,
    h('div', { class: 'row' },
      h('button', { class: 'primary', 'data-testid': 'save-accepted', onclick: () => { try { build(); } catch (x) { err.textContent = x.message; } } }, 'Save as accepted'),
      h('button', { onclick: () => { editing = null; renderPanel(); } }, 'Cancel')));
}
function check(value, list, what) {
  if (value && !list.includes(value)) throw new Error(`${value} is not a ${what} of the target ontologies.`);
  return value || undefined;
}
function ignoreEntry(decision, reason) {
  if (!reason.trim()) throw new Error('Give the reason.');
  return { ignore: { reason: reason.trim(), ...(decision === 'defer' ? { deferred: true } : {}) } };
}
const save = (path, entry) => act(() => api('/api/decide', { path, action: 'edit', entry }), 'Saved');

function rejectForm() {
  const text = h('textarea', { rows: 3, placeholder: 'What is wrong? The model gets this if you propose again.', 'data-testid': 'reject-comment' });
  return h('div', { class: 'form' }, h('b', {}, 'Reject'), text, h('div', { class: 'row' },
    h('button', { class: 'bad', onclick: () => act(() => api('/api/decide', { path: selected, action: 'reject', comment: text.value || undefined }), 'Rejected') }, 'Reject'),
    S.can.propose ? h('button', { class: 'primary', 'data-testid': 'reject-ask', onclick: () => act(() => api('/api/propose', { key: selected, comment: text.value || undefined }), (r) => `Proposed again (${r.log.calls} call${r.log.calls > 1 ? 's' : ''})`) }, 'Reject and ask again') : null,
    h('button', { onclick: () => { editing = null; renderPanel(); } }, 'Cancel')));
}

function nodeForm(id, e) {
  const dec = decisionSelect(decisionOf(e));
  const own = (e && !e.ignore ? e.classes ?? [] : []);
  const inputs = [0, 1].map((i) => termInput(own[i], classes(), i ? 'another class (optional)' : 'class (optional when inherited)'));
  const reason = h('input', { value: e?.ignore?.reason ?? '', placeholder: 'reason, when left out or deferred' });
  return formShell(`Edit ${nodeLabel(id)}`, [h('label', {}, 'decision', dec), h('label', {}, 'classes', inputs.map((x) => x.el)), h('label', {}, 'reason', reason)], () => {
    if (dec.value !== 'map') return save(`nodes/${id}`, ignoreEntry(dec.value, reason.value));
    const cls = inputs.map((x) => check(x.input.value.trim(), classes(), 'class')).filter(Boolean);
    const entry = { ...(e?.subject ? { subject: e.subject } : {}), ...(cls.length ? { classes: [...new Set(cls)] } : {}) };
    return save(`nodes/${id}`, entry);
  });
}

function relForm(id, e) {
  const m = e && !e.ignore ? e : {};
  const dec = decisionSelect(decisionOf(e));
  const pred = termInput(m.predicate, properties(), 'predicate, start → end');
  pred.input.setAttribute('data-testid', 'rel-predicate');
  const dir = h('select', {}, ['forward', 'reverse'].map((d) => h('option', { value: d, selected: (m.direction ?? 'forward') === d }, d)));
  const q = h('input', { type: 'checkbox', checked: !!m.qualified, style: 'width:auto' });
  const qc = termInput(m.qualified?.class, classes(), 'class of the qualified resource');
  const ql = termInput(m.qualified?.link, properties(), 'link: subject → resource');
  const qt = termInput(m.qualified?.target, properties(), 'target: resource → object');
  const reason = h('input', { value: e?.ignore?.reason ?? '', placeholder: 'reason, when left out or deferred', 'data-testid': 'rel-reason' });
  return formShell(`Edit ${relOf(id).type}`, [
    h('label', {}, 'decision', dec), h('label', {}, 'predicate', pred.el), h('label', {}, 'direction', dir),
    h('label', {}, h('span', { class: 'row' }, q, 'qualified pattern (needed for relationship properties)'), qc.el, ql.el, qt.el),
    h('label', {}, 'reason', reason)], () => {
    if (dec.value !== 'map') return save(`relationships/${id}`, ignoreEntry(dec.value, reason.value));
    const entry = {};
    const p = check(pred.input.value.trim(), properties(), 'property');
    if (p) entry.predicate = p;
    if (dir.value === 'reverse') entry.direction = 'reverse';
    if (q.checked) {
      const qual = { class: check(qc.input.value.trim(), classes(), 'class'), link: check(ql.input.value.trim(), properties(), 'property'), target: check(qt.input.value.trim(), properties(), 'property') };
      if (!qual.class || !qual.link || !qual.target) throw new Error('A qualified pattern needs a class, a link and a target.');
      entry.qualified = { ...(m.qualified?.subject && m.qualified.class === qual.class ? { subject: m.qualified.subject } : {}), ...qual };
    }
    if (!entry.predicate && !entry.qualified) throw new Error('Give a predicate or a qualified pattern.');
    return save(`relationships/${id}`, entry);
  });
}

function propertyForm(path, p, pe) {
  const m = pe && !pe.ignore ? pe : {};
  const dec = decisionSelect(decisionOf(pe));
  const pred = termInput(m.predicate, properties(), 'predicate');
  const dt = h('select', {}, h('option', { value: '' }, '(default for the Neo4j type)'), S.catalog.datatypes.map((d) => h('option', { value: d, selected: m.datatype === d }, d)));
  const kind = h('select', {}, [['literal', 'a literal'], ['iri', 'an IRI (the value is a URL or an IRI)']].map(([v, t]) => h('option', { value: v, selected: (m.kind ?? 'literal') === v }, t)));
  kind.addEventListener('change', () => { dt.disabled = kind.value === 'iri'; });
  dt.disabled = kind.value === 'iri';
  const reason = h('input', { value: pe?.ignore?.reason ?? '', placeholder: 'reason, when left out or deferred' });
  return formShell(`Edit ${p.name ?? path.split('/').pop()}`, [
    h('label', {}, 'decision', dec), h('label', {}, 'predicate', pred.el),
    m.values ? h('div', { class: 'term' }, `value table kept: ${Object.entries(m.values).map(([k, v]) => `${k} → ${v}`).join(', ')}`) : [h('label', {}, 'the value is', kind), h('label', {}, 'datatype', dt)],
    h('label', {}, 'reason', reason)], () => {
    if (dec.value !== 'map') return save(path, ignoreEntry(dec.value, reason.value));
    const entry = { predicate: check(pred.input.value.trim(), properties(), 'property') };
    if (!entry.predicate) throw new Error('Give a predicate.');
    if (m.values) entry.values = m.values;
    else if (kind.value === 'iri') entry.kind = 'iri';
    else if (dt.value) entry.datatype = dt.value;
    return save(path, entry);
  });
}

// Oracle ------------------------------------------------------------------------------------------
function renderOracle() {
  const box = $('oracle');
  if (box.hidden) return;
  const run = (withProposals) => async () => {
    fill(box, h('div', {}, 'Projecting and asking the questions…'));
    try { oracle = await api('/api/oracle', { withProposals }); } catch (err) { oracle = { error: err.message }; }
    renderOracle();
  };
  const head = h('div', { class: 'row', style: 'display:flex;gap:8px;align-items:center;margin-bottom:6px' },
    h('b', {}, 'Oracle: the same questions in Cypher on the LPG and in SPARQL on the projection'),
    h('button', { disabled: !S.can.oracle, onclick: run(false), 'data-testid': 'oracle-run' }, 'Run on accepted entries'),
    h('button', { disabled: !S.can.oracle, onclick: run(true) }, 'Run with proposals too'),
    S.can.oracle ? '' : h('span', { style: 'color:#888' }, 'Start the studio with --oracle, --source and n20s-server to use it.'),
    h('button', { style: 'margin-left:auto', onclick: () => { box.hidden = true; } }, 'Close'));
  if (!oracle) return fill(box, head);
  if (oracle.error) return fill(box, head, h('div', { class: 'fail' }, oracle.error));
  const cls = { pass: 'pass', fail: 'fail', error: 'error', 'not-expressible': 'ne' };
  fill(box, head,
    h('div', { style: 'color:#666;margin-bottom:4px' }, `${oracle.withProposals ? 'Accepted and proposed' : 'Accepted'} entries: ${oracle.triples} triples.${oracle.problems.length ? ` Left out by the compiler: ${oracle.problems.map((p) => p.path).join(', ')}.` : ''}`),
    h('table', { 'data-testid': `oracle-results-${oracle.results.every((r) => r.status === 'pass' || r.status === 'not-expressible') ? 'pass' : 'fail'}` }, h('tr', {}, h('th', {}, 'check'), h('th', {}, 'result'), h('th', {}, 'details')),
      oracle.results.map((r) => h('tr', {},
        h('td', { class: 'mono' }, r.id),
        h('td', { class: cls[r.status] }, r.status),
        h('td', {}, r.status === 'not-expressible' ? r.reason
          : r.error ?? (r.status === 'pass' ? `${r.rows ?? `${r.cypherRows} vs ${r.sparqlRows}`} rows` : [
            ...(r.onlyCypher ?? []).slice(0, 4).map((x) => h('div', {}, 'missing in RDF: ', h('code', {}, x))),
            ...(r.onlySparql ?? []).slice(0, 4).map((x) => h('div', {}, 'extra in RDF: ', h('code', {}, x))),
            ...(r.inBoth ?? []).slice(0, 4).map((x) => h('div', {}, 'should not be in RDF: ', h('code', {}, x))),
          ]))))));
}

// Start ---------------------------------------------------------------------------------------------
setupPanZoom();
window.addEventListener('resize', () => { view = null; renderGraph(); });
// The layout depends on the document only: computed once per page.
api('/api/state').then((state) => {
  S = state;
  if (S.title) document.title = S.title;
  const linked = decodeURIComponent(location.hash.slice(1));
  selected = itemOf(linked) ? linked : S.items.find((i) => i.status === 'proposed' && !i.safe)?.key ?? null;
  render();
  if (tab !== 'mapping') setTab(tab);
}, (err) => toast(err.message, true));
