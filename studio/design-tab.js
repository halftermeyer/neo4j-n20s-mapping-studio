// Design tab: the conversation with the AI that writes the specification of
// the mapping. The AI proposes spec items; the person accepts, rejects (with a
// reason the AI then sees) or edits each one. Only accepted items count.
import { fill, h, api, toast, tid } from './dom.js';

const KIND_TEXT = {
  purpose: 'Purpose', include: 'In scope', exclude: 'Out of scope', principle: 'Principles', note: 'Notes on elements', question: 'Competency questions', target: 'Target ontologies',
};
const KIND_COLOR = { purpose: '#455a64', include: '#2e7d32', exclude: '#c62828', principle: '#6a1b9a', note: '#1565c0', question: '#00695c', target: '#e65100' };

let root = null;
let data = null;
let busy = false;
let editing = null;     // { pid } or { id } while an item is edited
let draft = '';
let scopeFilter = 'all';
let proposedCount = null;  // calls of the last "Propose the mapping from this spec", for the demo recorder
let cq = null;             // the question being validated as an oracle check: POST /api/design/cq, plus edits and tries

export async function showDesign(container) {
  root = container;
  await load();
  render();
  const log = root.querySelector('.dchat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

async function load() {
  try { data = await api('/api/design'); } catch (err) { toast(err.message, true); }
}

async function decide(body, done) {
  try { data = await api('/api/design/decide', body); editing = null; if (done) toast(done); } catch (err) { toast(err.message, true); }
  render();
}

const chip = (kind) => h('span', { class: 'chip', style: `background:${KIND_COLOR[kind]};color:#fff` }, kind);
const describe = (i) => [i.element ? h('b', { class: 'mono' }, i.element) : null, i.target ? h('b', { class: 'mono' }, i.target) : null, i.element || i.target ? ' ' : '', i.text ?? i.reason ?? ''];

function render() {
  if (!data) return;
  fill(root,
    h('aside', { class: 'dspec', 'data-testid': 'design-spec' }, specView()),
    h('section', { class: 'dchat' }, chatView()),
    h('aside', { class: 'fpanel' }, cq ? cqView() : scopeView()));
}

// The spec: accepted items by kind, rejected ones folded away -------------------------------------
function specView() {
  const items = data.spec.items ?? [];
  const accepted = items.filter((i) => i.status === 'accepted');
  const rejected = items.filter((i) => i.status === 'rejected');
  return [
    h('div', { class: 'fhead' }, 'Specification', h('div', { class: 'mono', style: 'color:#888;font-weight:400' }, data.specFile)),
    h('div', { style: 'padding:8px 12px;color:#555;font-size:12px' }, `${accepted.length} accepted item${accepted.length === 1 ? '' : 's'} · scope ${data.scope.mode} (${data.scope.counts.in} in, ${data.scope.counts.out} out, ${data.scope.counts.undecided} undecided)`),
    departures(),
    Object.keys(KIND_TEXT).map((k) => {
      const list = accepted.filter((i) => i.kind === k);
      if (!list.length) return null;
      return h('div', { class: 'dgroup' }, h('div', { class: 'dgroup-title', style: `color:${KIND_COLOR[k]}` }, KIND_TEXT[k]),
        list.map((i) => editing?.id === i.id ? itemForm(i, (item) => decide({ id: i.id, action: 'edit', item }, 'Saved')) : h('div', { class: 'ditem' },
          h('div', {}, describe(i)),
          i.kind === 'question' ? h('div', { style: 'margin-top:4px' }, i.recipe
            ? [h('a', { href: '/recipes', class: 'mono' }, `recipe ${i.recipe}`), ' ',
              i.check ? h('span', { class: 'chip accepted', title: 'A validated oracle check' }, `check ${i.check}`) : null, ' ',
              h('button', { class: 'mini primary', 'data-testid': `cq-open-${tid(i.id)}`, disabled: busy, title: 'Validate the direct Cypher answer on parameter cases: the question becomes an oracle check', onclick: () => openCq(i.id) }, i.check ? 'Check…' : 'Validate the Cypher')]
            : h('button', { class: 'mini primary', disabled: busy || !data.can.model, title: 'The model writes a recipe (Cypher scope, SPARQL query) that answers it; it is checked, saved as a draft, added to the bench, and tried', onclick: () => draftRecipe(i) }, 'Draft a recipe')) : null,
          h('div', { class: 'dmeta' }, i.by?.kind === 'ai' ? `proposed by ${i.by.model ?? 'AI'}, accepted by ${i.reviewedBy}` : `by ${i.by?.name ?? i.reviewedBy}`,
            h('span', {}, h('button', { class: 'mini', onclick: () => { editing = { id: i.id }; render(); } }, 'edit'),
              h('button', { class: 'mini bad', onclick: () => confirm('Remove this item from the spec?') && decide({ id: i.id, action: 'remove' }, 'Removed') }, '×'))))));
    }),
    !accepted.length ? h('div', { style: 'padding:12px;color:#888' }, 'Nothing yet. Tell the AI what the mapping is for, in the conversation; or add an item yourself.') : null,
    editing?.id === 'new' ? itemForm({ kind: 'principle' }, (item) => decide({ action: 'edit', item }, 'Added')) : h('div', { style: 'padding:8px 12px' }, h('button', { onclick: () => { editing = { id: 'new' }; render(); } }, '+ item')),
    rejected.length ? h('details', { style: 'padding:8px 12px' }, h('summary', { style: 'cursor:pointer;color:#888' }, `${rejected.length} rejected (the AI sees them)`),
      rejected.map((i) => h('div', { class: 'ditem rejected' }, chip(i.kind), ' ', describe(i), i.reviewComment ? h('div', { class: 'dmeta' }, `because: ${i.reviewComment}`) : null))) : null,
  ];
}

async function draftRecipe(i) {
  busy = true;
  render();
  try {
    data = await api('/api/design/draft', { id: i.id });
    const d = data.drafted;
    const t = d.tried;
    toast(d.findings.length ? `Drafted ${d.file}, with problems to fix: ${d.findings.map((f) => f.message).join('; ')}`
      : t ? (t.ok ? `Drafted ${d.file}: ${t.rows} row${t.rows === 1 ? '' : 's'} on a try${t.compare ? (t.compare.empty ? ', empty like the direct Cypher answer: not cross-checked' : t.compare.agree ? ', agrees with a direct Cypher answer' : `, does NOT agree with a direct Cypher answer${t.compare.error ? ` (${t.compare.error})` : ''}: check it`) : ''}${t.unaccepted ? ` (the run uses accepted entries only; ${t.unaccepted} are still proposed)` : ''}` : `Drafted ${d.file}; the try stopped: ${t.error}`)
        : `Drafted ${d.file} (not tried: no source or n20s-server)`, d.findings.length > 0 || (t && (!t.ok || (t.compare && t.compare.agree === false))));
  } catch (err) { toast(err.message, true); }
  busy = false;
  render();
}

/** Where the mapping departs from the spec: checked without a model, and by the last check against the spec. */
function departures() {
  const gaps = data.gaps ?? [];
  const checked = data.check?.findings ?? [];
  if (!gaps.length && !checked.length && !data.check) return null;
  return h('div', { class: 'dgroup' }, h('div', { class: 'dgroup-title', style: 'color:#c62828' }, 'Departures from the spec'),
    gaps.map((g) => h('div', { class: 'ditem' }, g.element ? h('b', { class: 'mono' }, g.element) : null, ' ', g.message,
      g.code === 'spec.target-missing' ? h('div', {}, h('button', { class: 'mini primary', onclick: async () => {
        try { data = await api('/api/design/add-target', { target: g.target }); toast(`${g.target} added to the mapping: propose again to use it`); } catch (err) { toast(err.message, true); }
        render();
      } }, `Add ${g.target} to the mapping`)) : null,
      ['spec.in-scope-left-out', 'spec.out-of-scope-mapped'].includes(g.code) ? h('div', {}, h('button', { class: 'mini primary', disabled: !data.can.model, onclick: async () => {
        try { await api('/api/propose', { key: g.path, comment: g.message }); data = await api('/api/design'); toast(`${g.element} proposed again, with this departure as the reason`); } catch (err) { toast(err.message, true); }
        render();
      } }, 'Propose again')) : null)),
    checked.map((f) => h('div', { class: 'ditem' }, h('span', { class: `chip ${f.severity === 'high' ? 'error' : 'warning'}` }, f.severity), ' ', h('b', { class: 'mono' }, f.element), ' ', f.problem, f.rule ? h('div', { class: 'dmeta' }, f.rule) : null)),
    data.check ? h('div', { class: 'dmeta' }, `checked ${data.check.at.replace('T', ' ').slice(0, 16)}${!checked.length ? ': the mapping follows the spec' : ''} · these also lead the review queue`) : null);
}

/** An item to write or correct. */
function itemForm(i, save) {
  const kind = h('select', {}, Object.keys(KIND_TEXT).map((k) => h('option', { value: k, selected: k === i.kind }, k)));
  const listId = `elements-${Math.random().toString(36).slice(2, 7)}`;
  const element = h('input', { value: i.element ?? '', placeholder: 'element: Label, TYPE, Label.property', list: listId });
  const target = h('select', {}, data.targets.map((t) => h('option', { value: t.id, selected: t.id === i.target }, `${t.title} (${t.id})${t.inProject ? '' : ' — catalog'}`)));
  const text = h('textarea', { rows: 2, placeholder: 'text' }, i.text ?? '');
  const reason = h('input', { value: i.reason ?? '', placeholder: 'reason' });
  const sync = () => {
    const k = kind.value;
    element.style.display = ['include', 'exclude', 'note'].includes(k) ? '' : 'none';
    target.style.display = k === 'target' ? '' : 'none';
    text.style.display = ['purpose', 'principle', 'note', 'question'].includes(k) ? '' : 'none';
    reason.style.display = ['include', 'exclude', 'target'].includes(k) ? '' : 'none';
  };
  kind.addEventListener('change', sync);
  sync();
  return h('div', { class: 'form', style: 'margin:6px 10px' }, kind, element, h('datalist', { id: listId }, data.names.map((n) => h('option', { value: n }))), target, text, reason,
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => {
        const k = kind.value;
        const item = { kind: k, ...(element.style.display === '' ? { element: element.value } : {}), ...(k === 'target' ? { target: target.value } : {}), ...(text.style.display === '' ? { text: text.value } : {}), ...(reason.style.display === '' && reason.value ? { reason: reason.value } : {}) };
        save(item);
      } }, 'Save'),
      h('button', { onclick: () => { editing = null; render(); } }, 'Cancel')));
}

// The conversation ------------------------------------------------------------------------------------
function decisionOf(pid) {
  return (data.spec.items ?? []).find((i) => i.from === pid) ?? null;
}

function proposalCard(p) {
  const d = decisionOf(p.pid);
  if (editing?.pid === p.pid) return itemForm(p, (item) => decide({ pid: p.pid, action: 'edit', item }, 'Accepted as edited'));
  return h('div', { class: `dprop${d ? ` ${d.status}` : ''}` },
    h('div', {}, chip(p.kind), ' ', describe(p)),
    p.problems?.length ? h('div', { class: 'fail', style: 'font-size:12px' }, p.problems.join('; ')) : null,
    d ? h('div', { class: 'dmeta' }, d.status === 'accepted' ? `accepted${d.by?.kind === 'human' ? ' (edited)' : ''}` : `rejected${d.reviewComment ? `: ${d.reviewComment}` : ''}`)
      : h('div', { class: 'row', style: 'gap:6px' },
        h('button', { class: 'mini good', disabled: !!p.problems?.length, onclick: () => decide({ pid: p.pid, action: 'accept' }) }, 'Accept'),
        h('button', { class: 'mini bad', onclick: () => { const c = prompt('Why not? (the AI sees it)'); if (c !== null) decide({ pid: p.pid, action: 'reject', comment: c || undefined }); } }, 'Reject'),
        h('button', { class: 'mini', onclick: () => { editing = { pid: p.pid }; render(); } }, 'Edit')));
}

const passesSel = h('select', { 'data-testid': 'design-passes', title: 'Several passes tell how stable each proposal is: the review uses it' }, [1, 3].map((n) => h('option', { value: n }, `${n} pass${n > 1 ? 'es' : ''}`)));

function chatView() {
  const pending = data.chat.flatMap((m) => (m.proposals ?? []).filter((p) => !decisionOf(p.pid) && !p.problems?.length));
  const input = h('textarea', { rows: 3, 'data-testid': 'design-input', placeholder: data.chat.length ? 'Answer, correct, ask…' : 'What is this mapping for? Who will use the RDF, for which questions? What must never be asserted?', oninput: (e) => { draft = e.target.value; } }, draft);
  const send = async () => {
    if (!draft.trim() || busy) return;
    busy = true;
    render();
    try { data = await api('/api/design/say', { message: draft }); draft = ''; } catch (err) { toast(err.message, true); }
    busy = false;
    render();
    const log = root.querySelector('.dchat-log');
    if (log) log.scrollTop = log.scrollHeight;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
  return [
    h('div', { class: 'dchat-head' }, h('b', {}, 'Design conversation'), ` · ${data.lpg.name ?? data.lpg.id}`,
      data.lpg.described === 0 ? h('span', { class: 'warnline' }, ' · no descriptions in the LPG ontology: tell the AI what the elements mean') : '',
      pending.length ? h('span', {}, ' · ', h('button', { class: 'mini good', 'data-testid': 'design-accept-pending', onclick: async () => { for (const p of pending) await api('/api/design/decide', { pid: p.pid, action: 'accept' }).then((x) => { data = x; }).catch((err) => toast(err.message, true)); render(); } }, `Accept the ${pending.length} pending`)) : null,
      h('div', { class: 'row', style: 'gap:6px;margin-top:6px;flex-wrap:wrap' },
        passesSel,
        h('button', { class: 'primary', 'data-testid': 'design-propose', disabled: busy || !data.can.model || !data.spec.items?.some((i) => i.status === 'accepted'), title: 'Out of scope elements are left out with their reason; the model proposes the others, guided by the purpose, the principles and the notes', onclick: async () => {
          busy = true; render();
          try {
            const r = await api('/api/design/propose', { passes: Number(passesSel.value) });
            proposedCount = r.calls;
            toast(`${r.calls} calls; ${r.outOfScope} elements left out as out of scope${r.dropped.length ? `; dropped: ${r.dropped.join(', ')}` : ''}. Review in the Mapping tab.`);
            data = await api('/api/design');
          } catch (err) { toast(err.message, true); }
          busy = false; render();
        } }, 'Propose the mapping from this spec'),
        h('button', { disabled: busy || !data.can.model, title: 'The model reads the spec and the mapping decisions, and lists where they part', onclick: async () => {
          busy = true; render();
          try { data = await api('/api/design/check', {}); toast(data.check.findings.length ? `${data.check.findings.length} departures from the spec` : 'The mapping follows the spec'); } catch (err) { toast(err.message, true); }
          busy = false; render();
        } }, 'Check the mapping against the spec'),
        proposedCount !== null ? h('span', { class: 'chip accepted', 'data-testid': 'design-proposed' }, `proposed (${proposedCount} calls): review it in the Mapping tab`) : null)),
    h('div', { class: 'dchat-log' },
      data.chat.length ? data.chat.map((m, i) => h('div', { class: `dmsg ${m.role}`, 'data-testid': `design-msg-${i + 1}` },
        h('div', { class: 'dwho' }, m.role === 'user' ? 'You' : `AI${m.model ? ` · ${m.model}` : ''}`),
        h('div', { class: 'dtext' }, m.text),
        (m.proposals ?? []).length ? h('div', { class: 'dprops' }, m.proposals.map(proposalCard)) : null))
        : h('div', { class: 'dempty' }, 'The AI asks what the mapping is for, proposes the purpose, the scope, principles, notes on elements, the questions the RDF must answer and the target ontologies. You accept, reject or edit each proposal: only what you accept goes into the specification.'),
      busy ? h('div', { class: 'dmsg assistant' }, h('div', { class: 'dwho' }, 'AI'), h('div', { class: 'dtext', style: 'color:#888' }, 'Thinking…')) : null),
    h('div', { class: 'dinput' }, input,
      h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { style: 'color:#888;font-size:11px' }, data.can.model ? '⌘/Ctrl + Enter to send' : 'No model: choose one in the Connections tab; you can still write the spec by hand.'),
        h('button', { class: 'primary', disabled: busy || !data.can.model, onclick: send, 'data-testid': 'design-send' }, busy ? 'Sending…' : 'Send'))),

  ];
}

// The scope, element by element -----------------------------------------------------------------------
function scopeView() {
  const s = data.scope;
  const list = s.elements.filter((e) => scopeFilter === 'all' || e.scope === scopeFilter);
  const set = (e, kind) => decide({ action: 'edit', item: { kind, element: e.name, ...(kind === 'exclude' ? { reason: prompt(`Why is ${e.name} out of scope?`) || 'out of scope' } : {}) } }, `${e.name} ${kind === 'include' ? 'in' : 'out of'} scope`);
  return [
    h('h2', {}, 'Scope'),
    h('div', { style: 'color:#555' }, `${s.mode === 'partial' ? 'Partial' : 'Full'} mapping: ${s.counts.in} in, ${s.counts.out} out, ${s.counts.undecided} undecided.`,
      h('div', { class: 'term' }, 'Out of scope elements will be left out with their reason, without asking the model; the coverage counts the scope only.')),
    h('div', { class: 'tabs', style: 'position:static;padding:8px 0' }, ['all', 'in', 'out', 'undecided'].map((f) => h('button', { class: f === scopeFilter ? 'on' : '', onclick: () => { scopeFilter = f; render(); } }, f))),
    h('table', { class: 'props' }, list.map((e) => h('tr', {},
      h('td', { class: 'mono' }, e.name, e.reason ? h('div', { style: 'color:#888;font-family:system-ui' }, e.reason) : null),
      h('td', {}, h('span', { class: `chip ${e.scope === 'in' ? 'accepted' : e.scope === 'out' ? 'rejected' : 'undecided'}` }, e.scope)),
      h('td', { class: 'act', style: 'white-space:nowrap' },
        e.scope !== 'in' ? h('button', { class: 'mini', title: 'In scope', onclick: () => set(e, 'include') }, 'in') : null,
        e.scope !== 'out' ? h('button', { class: 'mini bad', title: 'Out of scope', onclick: () => set(e, 'exclude') }, 'out') : null)))),
  ];
}

// Validating a drafted question as an oracle check --------------------------------------------------
async function openCq(id) {
  try {
    const q = await api('/api/design/cq', { id });
    cq = { ...q, cases: q.cases ?? [{ params: { ...q.params } }], tried: null };
  } catch (err) { toast(err.message, true); }
  render();
}

async function cqCall(path, extra = {}) {
  busy = true;
  render();
  try { return await api(path, { id: cq.id, cypher: cq.cypher, cases: cq.cases, ...extra }); } catch (err) { toast(err.message, true); return null; } finally { busy = false; }
}

function cqView() {
  const names = [...new Set([...Object.keys(cq.params ?? {}), ...cq.cases.flatMap((c) => Object.keys(c.params ?? {}))])];
  const tried = cq.tried;
  const disagree = tried?.some((c) => c.compare?.agree === false || c.error);
  const answers = tried?.some((c) => c.cypherRows > 0);
  const save = (action, comment) => async () => {
    const id = cq.id;
    const r = await cqCall('/api/design/cq/validate', { action, comment });
    if (r) {
      data = r;
      if (r.saved) toast(`${r.saved.kept ? 'Kept failing' : 'Validated'}: check ${r.saved.id} in ${r.saved.oracleFile}${r.saved.created ? ' (created)' : ''}. Run the oracle to see what it covers.`);
      else toast('Drafted again: try it on the same cases.');
      cq = null;
      if (action === 'redraft') await openCq(id);
    }
    render();
  };
  return [
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', {}, 'Validate the Cypher'), h('button', { class: 'mini', onclick: () => { cq = null; render(); } }, '×')),
    h('div', { class: 'desc' }, cq.question),
    h('div', { class: 'hint' }, 'You validate the direct Cypher answer: it is the truth on the LPG. The recipe\'s SPARQL is what the check tests. Validate on two or three values where the answer is not empty and changes.'),
    cq.check ? h('div', { class: cq.check.current === false ? 'warnline' : 'okline' }, `Check ${cq.check.id}${cq.check.validated ? `, validated by ${cq.check.validated.by} ${cq.check.validated.at.slice(0, 10)}` : ''}${cq.check.current === false ? ': changed since, to validate again' : ''}`) : null,
    h('h3', {}, 'Direct Cypher (validated by you)'),
    h('textarea', { class: 'mono', rows: 6, 'data-testid': 'cq-cypher', oninput: (e) => { cq.cypher = e.target.value; cq.tried = null; } }, cq.cypher),
    h('h3', {}, 'Cases'),
    h('table', { class: 'props', 'data-testid': 'cq-cases' },
      h('tr', {}, names.map((n) => h('th', {}, `$${n}`)), h('th', {}, 'Cypher'), h('th', {}, 'recipe'), h('th', {}, ''), h('th', {}, '')),
      cq.cases.map((c, i) => {
        const t = tried?.[i];
        return h('tr', {},
          names.map((n) => h('td', {}, h('input', { value: c.params?.[n] ?? '', style: 'width:100%', oninput: (e) => { c.params = { ...c.params, [n]: e.target.value }; cq.tried = null; } }))),
          h('td', {}, t ? (t.error && t.cypherRows === undefined ? '—' : `${t.cypherRows} rows`) : ''),
          h('td', {}, t ? (t.recipeRows ?? '—') : ''),
          h('td', { class: t ? (t.error || t.compare?.agree === false ? 'fail' : t.cypherRows ? 'pass' : 'ne') : '' },
            t ? (t.error ?? (t.compare?.agree === false ? 'disagree' : t.cypherRows ? 'agree' : 'empty: proves nothing')) : ''),
          h('td', {}, h('button', { class: 'mini bad', disabled: cq.cases.length < 2, onclick: () => { cq.cases.splice(i, 1); cq.tried = null; render(); } }, '×')));
      })),
    h('div', { class: 'row', style: 'gap:6px;margin-top:6px' },
      h('button', { class: 'mini', onclick: () => { cq.cases.push({ params: { ...cq.params } }); cq.tried = null; render(); } }, '+ case'),
      h('button', { class: 'mini', 'data-testid': 'cq-suggest', disabled: busy, title: 'Values where the Cypher answers, and answers differently', onclick: async () => { const r = await cqCall('/api/design/cq/suggest'); if (r) { cq.cases = r.cases.map((c) => ({ params: c.params })); cq.tried = null; if (!r.cases.length) toast('No value found where the Cypher answers something.', true); } render(); } }, 'Suggest values'),
      h('button', { class: 'primary', 'data-testid': 'cq-try', disabled: busy || !cq.can.try, title: cq.can.try ? '' : 'Needs a source and n20s-server', onclick: async () => { const r = await cqCall('/api/design/cq/try'); if (r) cq.tried = r.cases; render(); } }, 'Try')),
    tried?.some((t) => t.compare && t.compare.agree === false) ? tried.filter((t) => t.compare?.agree === false).map((t) => h('div', { class: 'warnline' },
      `${JSON.stringify(t.params)}: only in the recipe ${t.compare.onlyRecipe.join(' ') || 'nothing'}; only in the Cypher ${t.compare.onlyCypher.join(' ') || 'nothing'}`)) : null,
    h('details', {}, h('summary', { style: 'cursor:pointer;color:#666' }, 'SPARQL of the recipe (under test)'), h('pre', { class: 'stmt' }, cq.sparql)),
    h('div', { class: 'row', style: 'gap:6px;margin-top:10px;flex-wrap:wrap' },
      !tried ? h('span', { class: 'hint' }, 'Try it on the cases first.')
        : !answers ? h('span', { class: 'warnline' }, 'The Cypher answers nothing in every case: two empty answers prove nothing. Choose other values.')
          : !disagree ? h('button', { class: 'primary', 'data-testid': 'cq-validate', disabled: busy, onclick: save('validate') }, 'Validate: save as an oracle check')
            : [h('button', { 'data-testid': 'cq-redraft', disabled: busy, title: 'The SPARQL is wrong: the model drafts it again, your Cypher is kept', onclick: () => { const why = prompt('What is wrong with the SPARQL? (optional)') ?? null; save('redraft', why)(); } }, 'Redraft the SPARQL'),
              h('button', { class: 'bad', 'data-testid': 'cq-keep-failing', disabled: busy, title: 'The mapping is wrong: the check is saved and fails, and blames the decisions it asks about', onclick: () => confirm('Save the check as it is? It will fail and put the decisions its SPARQL asks about in doubt.') && save('keep-failing')() }, 'Keep the check failing (the mapping is wrong)')]),
  ];
}
