// The design conversation: an AI and a person write the specification of a
// mapping together. The AI asks what the mapping is for and proposes spec
// items; the person accepts, rejects or edits each one; only accepted items
// make the spec, which then drives propose (scope, principles, notes) and seeds
// recipes and the bench (competency questions).
//
// A spec (<mapping>.spec.yaml):
//   format: n20s-spec/0.1
//   mapping: lineage-prov
//   items:
//     - { id: i1, kind: purpose, text: "Audit export of provenance…", status: accepted, by: { kind: ai, model: … }, from: m3 }
//     - { id: i2, kind: exclude, element: DEPENDS_ON, reason: "potential, not asserted", status: accepted, … }
//     - { id: i3, kind: principle, text: "Never assert a derivation no source asserts.", … }
//     - { id: i4, kind: note, element: WAS_DERIVED_FROM.runId, text: "join to the Run, by a rule", … }
//     - { id: i5, kind: question, text: "Which asserted sources are upstream of a version?", … }
//     - { id: i6, kind: target, target: prov, reason: "…", … }
// Elements are named as people see them: a node label, a relationship type,
// or Label.property / TYPE.property; they are resolved to the ids of the LPG
// ontology, so the spec survives an export that changes ids.
// Browser-safe: no files, the provider is passed in.
import { indexLpg } from './lpg.js';

export const SPEC_FORMAT = 'n20s-spec/0.1';
export const DESIGN_PROMPT_VERSION = 'design/2';
export const ITEM_KINDS = ['purpose', 'include', 'exclude', 'principle', 'note', 'question', 'target'];
const NEEDS = { purpose: ['text'], include: ['element'], exclude: ['element', 'reason'], principle: ['text'], note: ['element', 'text'], question: ['text'], target: ['target'] };

export const emptySpec = (mapping) => ({ format: SPEC_FORMAT, mapping, items: [] });

/** The elements of an LPG ontology by the names people use: labels, types, and their properties. */
export function elementNames(lpgDoc) {
  const idx = indexLpg(lpgDoc);
  const out = new Map();
  for (const n of idx.nodes.values()) {
    if (!n.label) continue;
    out.set(n.label, { section: 'nodes', id: n.id });
    for (const p of n.props.values()) if (!idx.aliasOf(n.id, p.id)) out.set(`${n.label}.${p.name}`, { section: 'nodes', id: n.id, property: p.id });
  }
  for (const r of idx.rels.values()) {
    if (!r.type) continue;
    const name = out.has(r.type) ? `${r.type}(${idx.nodes.get(r.from)?.label}→${idx.nodes.get(r.to)?.label})` : r.type;
    out.set(name, { section: 'relationships', id: r.id });
    for (const p of r.props.values()) out.set(`${name}.${p.name}`, { section: 'relationships', id: r.id, property: p.id });
  }
  return out;
}

/** Problems of a proposed item: missing fields, unknown element or target. */
export function itemProblems(item, { names, targets = [] }) {
  const out = [];
  if (!ITEM_KINDS.includes(item?.kind)) return [`unknown kind ${item?.kind}`];
  for (const f of NEEDS[item.kind]) if (!String(item[f] ?? '').trim()) out.push(`${item.kind} needs ${f}`);
  if (item.element && !names.has(item.element)) out.push(`${item.element} is not an element of the LPG ontology`);
  // A property can be left out (it is never published); scope is otherwise decided for node kinds and relationship types.
  if (item.kind === 'include' && item.element && names.get(item.element)?.property) out.push('scope is decided for node kinds and relationship types; a property goes in a note, or is excluded');
  if (item.kind === 'target' && item.target && !targets.some((t) => t.id === item.target)) out.push(`${item.target} is not a known target`);
  return out;
}

/**
 * Where each node kind and relationship type stands in the accepted spec:
 * in, out (with the reason), or undecided; with the mode it implies.
 */
export function scopeOf(spec, lpgDoc) {
  const names = elementNames(lpgDoc);
  const accepted = (spec?.items ?? []).filter((i) => i.status === 'accepted');
  const elements = [...names].filter(([, e]) => !e.property).map(([name, e]) => {
    const inc = accepted.find((i) => i.kind === 'include' && i.element === name);
    const exc = accepted.find((i) => i.kind === 'exclude' && i.element === name);
    return { name, ...e, scope: exc ? 'out' : inc ? 'in' : 'undecided', reason: exc?.reason ?? inc?.reason ?? null };
  });
  const decided = elements.filter((e) => e.scope !== 'undecided');
  return {
    mode: !decided.length ? 'full' : elements.every((e) => e.scope !== 'out') ? 'full' : 'partial',
    elements,
    counts: { in: elements.filter((e) => e.scope === 'in').length, out: elements.filter((e) => e.scope === 'out').length, undecided: elements.filter((e) => e.scope === 'undecided').length },
  };
}

const SYSTEM = `You help a person design the mapping of a labeled property graph (LPG) ontology to RDF target ontologies. You do not write the mapping: you write its specification with the person, who validates every item.

Talk with the person: find out what the mapping is for, who will consume the RDF, which questions it must answer, what must never be asserted, what is out of scope. Ask one or two short questions at a time. Use what the LPG ontology says (labels, relationship types, properties, descriptions when there are any); when there are no descriptions, ask what the elements mean.

When something is clear enough, propose spec items in "proposals":
- purpose: what the mapping is for, in one or two sentences.
- include / exclude: a node label or relationship type in or out of scope, with the reason (exclude needs one). A property (Label.property) can be excluded too, when it must never be published; properties are never "included" one by one (they come with their element).
- principle: a rule the mapping follows (for instance: never assert a derivation no source asserts).
- note: what one element means or how to map it, for the person who reviews and for the model that will propose the mapping.
- question: a competency question the RDF must answer (a question of the business, such as "who owns the datasets a broken run fed?"); these become tests. Questions to the person go in "reply", never here.
- target: a target ontology to use (by its id in the list), and why.
Name elements exactly as listed (a label, a relationship type, Label.property or TYPE.property). Do not propose again what the person rejected unless they ask. Do not repeat accepted items. Propose what the person said and what follows directly from it: a few items per turn, not a note for every element. Keep "reply" short: what you understood, then your questions. Write "reply" and the texts of your proposals in the language the person writes in.`;

/** The request for one turn of the conversation. */
export function designRequest({ lpgDoc, spec, chat, message, targets = [] }) {
  const names = elementNames(lpgDoc);
  const idx = indexLpg(lpgDoc);
  const nodes = [...idx.nodes.values()].map((n) => ({
    label: n.label, implies: n.implied, description: lpgDoc.nodes[n.id]?.description ?? undefined, count: lpgDoc.nodes[n.id]?.extensions?.custom?.count,
    properties: [...n.props.values()].filter((p) => !idx.aliasOf(n.id, p.id)).map((p) => `${p.name}: ${p.type ?? '?'}${lpgDoc.nodes[n.id]?.properties?.[p.id]?.description ? ` (${lpgDoc.nodes[n.id].properties[p.id].description})` : ''}`),
  }));
  const rels = [...idx.rels.values()].map((r) => ({
    type: r.type, from: idx.nodes.get(r.from)?.label, to: idx.nodes.get(r.to)?.label, description: lpgDoc.relationships[r.id]?.description ?? undefined,
    properties: [...r.props.values()].map((p) => `${p.name}: ${p.type ?? '?'}${lpgDoc.relationships[r.id]?.properties?.[p.id]?.description ? ` (${lpgDoc.relationships[r.id].properties[p.id].description})` : ''}`),
  }));
  const items = (spec?.items ?? []).map((i) => `- [${i.status}] ${i.kind}${i.element ? ` ${i.element}` : ''}${i.target ? ` ${i.target}` : ''}: ${i.text ?? i.reason ?? ''}${i.status === 'rejected' && i.reviewComment ? ` (rejected because: ${i.reviewComment})` : ''}`);
  const history = (chat ?? []).slice(-16).map((m) => `${m.role === 'user' ? 'Person' : 'You'}: ${m.text}${m.proposals?.length ? `\n  (you proposed ${m.proposals.length} item${m.proposals.length > 1 ? 's' : ''})` : ''}`);
  const user = [
    `# LPG ontology: ${lpgDoc.name ?? lpgDoc.id}${lpgDoc.description ? `\n${lpgDoc.description}` : ''}`,
    `## Node kinds\n${JSON.stringify(nodes, null, 1)}`,
    `## Relationship types\n${JSON.stringify(rels, null, 1)}`,
    `# Target ontologies\n${targets.map((t) => `- ${t.id} (${t.prefix}: ${t.namespace})${t.inProject ? '' : ' [catalog, not in the project yet]'}: ${t.title}. ${t.description ?? ''}${t.sample?.length ? ` Classes include ${t.sample.join(', ')}.` : ''}`).join('\n')}`,
    `# Specification so far\n${items.join('\n') || '(empty)'}`,
    `# Conversation so far\n${history.join('\n') || '(this is the first message)'}`,
    `# The person says\n${message}`,
  ].join('\n\n');
  const schema = {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ITEM_KINDS },
            element: { type: 'string', enum: [...names.keys()] },
            target: { type: 'string', ...(targets.length ? { enum: targets.map((t) => t.id) } : {}) },
            text: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['kind'],
        },
      },
    },
    required: ['reply', 'proposals'],
  };
  return { element: 'design', system: SYSTEM, user, schema };
}

/**
 * One turn: the person's message, the AI's reply and its proposals (checked),
 * as the two chat messages to append.
 */
export async function designTurn({ provider, lpgDoc, spec, chat, message, targets = [], now = () => new Date().toISOString() }) {
  const req = designRequest({ lpgDoc, spec, chat, message, targets });
  const res = await provider.complete(req);
  const names = elementNames(lpgDoc);
  const n = (chat?.length ?? 0) + 1;
  const proposals = (res.json?.proposals ?? []).map((p, i) => {
    const item = Object.fromEntries(Object.entries({ kind: p.kind, element: p.element, target: p.target, text: p.text, reason: p.reason }).filter(([, v]) => v !== undefined && v !== ''));
    return { pid: `m${n + 1}p${i + 1}`, ...item, problems: itemProblems(item, { names, targets }) };
  });
  return [
    { id: `m${n}`, role: 'user', text: message, at: now() },
    { id: `m${n + 1}`, role: 'assistant', text: String(res.json?.reply ?? ''), proposals, at: now(), model: provider.model, promptVersion: DESIGN_PROMPT_VERSION, usage: res.usage ?? null },
  ];
}

/**
 * Accepts, rejects or edits a proposal of the conversation, or a person's own
 * item: returns the new spec. Accepting an edited proposal records the person
 * as its author.
 */
export function decideItem(spec, { action, proposal = null, item = null, id = null, comment = null, by, model = null, at = new Date().toISOString(), names, targets = [] }) {
  const out = structuredClone(spec);
  out.items ??= [];
  const nextId = () => `i${out.items.reduce((m, x) => Math.max(m, Number(String(x.id).slice(1)) || 0), 0) + 1}`;
  if (action === 'remove') {
    out.items = out.items.filter((x) => x.id !== id);
    return out;
  }
  const source = item ?? proposal;
  const clean = Object.fromEntries(Object.entries(source ?? {}).filter(([k, v]) => ['kind', 'element', 'target', 'text', 'reason'].includes(k) && v !== undefined && v !== ''));
  if (action === 'accept' || action === 'edit') {
    const problems = itemProblems(clean, { names, targets });
    if (problems.length) throw new Error(problems.join('; '));
  }
  const edited = action === 'edit' || (proposal && item);
  const entry = {
    id: id ?? nextId(), ...clean,
    status: action === 'reject' ? 'rejected' : 'accepted',
    by: edited || !proposal ? { kind: 'human', name: by } : { kind: 'ai', model },
    reviewedBy: by, at,
    ...(proposal?.pid ? { from: proposal.pid } : {}),
    ...(comment ? { reviewComment: comment } : {}),
  };
  const at_ = out.items.findIndex((x) => x.id === entry.id || (proposal?.pid && x.from === proposal.pid));
  if (at_ >= 0) out.items[at_] = { ...out.items[at_], ...entry, id: out.items[at_].id };
  else out.items.push(entry);
  // An element is in or out of scope once: the latest accepted decision replaces the others.
  if (entry.status === 'accepted' && ['include', 'exclude'].includes(entry.kind)) {
    const keep = out.items[at_ >= 0 ? at_ : out.items.length - 1];
    out.items = out.items.filter((x) => x === keep || !(x.status === 'accepted' && ['include', 'exclude'].includes(x.kind) && x.element === entry.element));
  }
  return out;
}

/**
 * Where the mapping departs from the accepted spec, without asking a model: an
 * element out of scope that is mapped, an element in scope that is left out.
 */
export function specFindings(spec, mapping, lpgDoc, { targets = [] } = {}) {
  const names = elementNames(lpgDoc);
  const out = [];
  // A target the spec chose but the mapping does not have: propose cannot use its terms.
  const have = new Set((mapping.targets ?? []).map((t) => t.namespace));
  for (const i of (spec?.items ?? []).filter((x) => x.status === 'accepted' && x.kind === 'target')) {
    const t = targets.find((x) => x.id === i.target);
    if (t && !have.has(t.namespace)) out.push({ code: 'spec.target-missing', path: 'targets', target: i.target, message: `The spec uses ${t.title ?? i.target} (${i.reason ?? 'no reason given'}), but the mapping has no such target: propose cannot use its terms.` });
  }
  for (const i of (spec?.items ?? []).filter((x) => x.status === 'accepted' && ['include', 'exclude'].includes(x.kind))) {
    const e = names.get(i.element);
    if (!e) continue;
    if (e.property) {
      const pe = mapping[e.section]?.[e.id]?.properties?.[e.property];
      if (i.kind === 'exclude' && pe && !pe.ignore && pe.meta?.status !== 'rejected') out.push({ code: 'spec.out-of-scope-mapped', path: `${e.section}/${e.id}/properties/${e.property}`, element: i.element, message: `${i.element} is out of scope in the spec (${i.reason}), but mapped.` });
      continue;
    }
    const entry = mapping[e.section]?.[e.id];
    if (!entry || entry.meta?.status === 'rejected') continue;
    if (i.kind === 'exclude' && !entry.ignore) out.push({ code: 'spec.out-of-scope-mapped', path: `${e.section}/${e.id}`, element: i.element, message: `${i.element} is out of scope in the spec (${i.reason}), but mapped.` });
    if (i.kind === 'include' && entry.ignore) out.push({ code: 'spec.in-scope-left-out', path: `${e.section}/${e.id}`, element: i.element, message: `${i.element} is in scope in the spec${i.reason ? ` (${i.reason})` : ''}, but left out: ${entry.ignore.reason}` });
  }
  return out;
}

const CHECK_SYSTEM = `You review an RDF mapping of an LPG ontology against its specification, which a person validated. List only real departures: a decision that contradicts a principle, the purpose or a note, or an element in scope that the purpose needs and the mapping leaves out. Name the element exactly as listed. Say nothing when the mapping follows the specification. Write in the language of the specification.`;

/** The request asking a model where a mapping departs from the principles, purpose and notes of its spec. */
export function specCheckRequest({ spec, decisions, lpgDoc }) {
  const accepted = (spec?.items ?? []).filter((i) => i.status === 'accepted');
  const names = [...elementNames(lpgDoc).keys()];
  return {
    element: 'spec-check',
    system: CHECK_SYSTEM,
    user: [
      `# Specification\n${accepted.map((i) => `- ${i.kind}${i.element ? ` ${i.element}` : ''}${i.target ? ` ${i.target}` : ''}: ${i.text ?? i.reason ?? ''}`).join('\n')}`,
      `# Mapping decisions\n${decisions}`,
    ].join('\n\n'),
    schema: {
      type: 'object',
      properties: { findings: { type: 'array', items: { type: 'object', properties: {
        element: { type: 'string', enum: names }, rule: { type: 'string' }, problem: { type: 'string' }, severity: { type: 'string', enum: ['high', 'low'] },
      }, required: ['element', 'problem', 'severity'] } } },
      required: ['findings'],
    },
  };
}

const DRAFT_SYSTEM = `You turn a competency question into a recipe of n20s-mapping: a Cypher scope that picks the nodes the question needs from the LPG, projected to RDF through the mapping, then a SPARQL query on that graph.

Rules:
- The scope Cypher returns nodes or paths (RETURN p, or RETURN n). Only the elements the mapping maps produce triples: scope what the SPARQL needs, no more. Use $name for parameters; every parameter you use is declared in params.
- The SPARQL is a SELECT on the projected graph. The prefixes of the mapping are declared for you. Use only the classes and predicates the mapping produces. What the question looks for is a SPARQL variable (?version). Cypher variables do not exist in SPARQL. To name the node a parameter gives, write {{<node id>|$name}} (the $ is required): it becomes the IRI of that node (node ids are listed with their subject).
- decode turns IRIs back into LPG keys: node:<node id> for a column holding nodes of that kind (or any of its subtypes), any when the kind varies.
- Prefer one or two parameters. Their default is a value the question names; you do not see the data, so when it names none, the default is the empty string (never a description) and the description says what to give. A question with no parameter is fine.
- decode names columns of the SELECT, without the ?.
- answerCypher answers the same question directly on the LPG, with the same parameters, and returns the same columns, as the LPG keys the decoded SPARQL gives (for instance RETURN DISTINCT v.id AS version). It is run next to the recipe: when both agree, the recipe is right; mind the direction of relationships (a derived version points to its source).
- title: the question, short. explanation: one or two sentences on how the recipe answers it, and what the RDF cannot say.`;

/** The request drafting a recipe for a competency question of the spec. */
export function recipeDraftRequest({ question, lpgDoc, mapping, decisions }) {
  const idx = indexLpg(lpgDoc);
  const nodes = [...idx.nodes.values()].map((n) => {
    const e = mapping.nodes?.[n.id];
    return `- ${n.id}: :${n.label}${n.implied.length ? ` (implies ${n.implied.join(', ')})` : ''}; properties ${[...n.props.values()].map((p) => `${p.name}${p.type ? `: ${p.type}` : ''}`).join(', ') || 'none'}${e?.subject ? `; subject ${e.subject}` : ''}`;
  });
  const rels = [...idx.rels.values()].map((r) => `- (:${idx.nodes.get(r.from)?.label})-[:${r.type}]->(:${idx.nodes.get(r.to)?.label})${r.props.size ? ` {${[...r.props.values()].map((p) => p.name).join(', ')}}` : ''}`);
  const prefixes = Object.entries(mapping.prefixes ?? {}).map(([p, ns]) => `${p}: <${ns}>`).join(', ');
  return {
    element: 'recipe-draft',
    system: DRAFT_SYSTEM,
    user: [
      `# Competency question\n${question}`,
      `# LPG node kinds (id: label; properties; subject IRI when it holds one)\n${nodes.join('\n')}`,
      `# LPG relationship types\n${rels.join('\n')}`,
      `# The mapping (what the RDF holds)\nPrefixes: ${prefixes}\n${decisions}`,
    ].join('\n\n'),
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'kebab-case id of the recipe' },
        title: { type: 'string' },
        params: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['string', 'integer', 'number', 'boolean', 'list'] }, default: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'default'] } },
        cypher: { type: 'string' },
        sparql: { type: 'string' },
        decode: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, node: { type: 'string', enum: ['any', ...idx.nodes.keys()] } }, required: ['column', 'node'] } },
        answerCypher: { type: 'string' },
        explanation: { type: 'string' },
      },
      required: ['id', 'title', 'params', 'cypher', 'sparql', 'answerCypher', 'explanation'],
    },
  };
}

/**
 * Relationship patterns of a Cypher query that go against the direction the
 * LPG ontology declares: (a:DatasetVersion)<-[:WAS_GENERATED_BY]-(r:Run) when
 * WAS_GENERATED_BY goes from DatasetVersion to Run. Labels come from the node
 * patterns, also of variables labelled earlier in the query.
 */
export function cypherDirectionProblems(cypher, lpgDoc) {
  const idx = indexLpg(lpgDoc);
  const text = String(cypher ?? '');
  const labelOf = new Map();
  for (const m of text.matchAll(/\(\s*(\w+)\s*:\s*`?(\w+)`?/g)) labelOf.set(m[1], m[2]);
  const has = (label, nodeId) => { const n = idx.nodes.get(nodeId); return n && (n.label === label || [...idx.ancestors(nodeId)].some((a) => idx.nodes.get(a).label === label) || idx.nodes.get(idx.labelToNode.get(label))?.implied?.includes(n.label)); };
  const out = [];
  const node = '\\(\\s*(\\w*)\\s*(?::\\s*`?(\\w+)`?)?[^()]*\\)';
  const re = new RegExp(`${node}\\s*(<?)-\\[\\s*\\w*\\s*:\\s*([\\w|]+)[^\\]]*\\]-(>?)\\s*(?=${node})`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const [, av, al, left, types, right] = m;
    const rest = new RegExp(node, 'y');
    rest.lastIndex = re.lastIndex;
    const n2 = rest.exec(text);
    if (!n2) continue;
    const [, bv, bl] = n2;
    const a = al ?? labelOf.get(av);
    const b = bl ?? labelOf.get(bv);
    if (!a || !b || (left && right) || (!left && !right)) continue;
    const [from, to] = right ? [a, b] : [b, a];
    for (const type of types.split('|')) {
      const rels = [...idx.rels.values()].filter((r) => r.type === type);
      if (!rels.length) continue;
      const forward = rels.some((r) => has(from, r.from) && has(to, r.to));
      const backward = rels.some((r) => has(to, r.from) && has(from, r.to));
      if (!forward && backward) {
        const r = rels[0];
        out.push(`${type} goes from ${idx.nodes.get(r.from).label} to ${idx.nodes.get(r.to).label}, not from ${from} to ${to}: (${idx.nodes.get(r.from).label})-[:${type}]->(${idx.nodes.get(r.to).label}).`);
      }
    }
  }
  return [...new Set(out)];
}

/** What a drafted recipe gets wrong that the recipe check does not see: placeholders on anything but a parameter, relationships against their direction. */
export function draftProblems(recipe, lpgDoc = null, answerCypher = null) {
  const out = [];
  if (lpgDoc) {
    for (const st of recipe.steps ?? []) for (const p of cypherDirectionProblems(st.cypher, lpgDoc)) out.push({ path: `steps/${st.id}/cypher`, message: p });
    for (const p of cypherDirectionProblems(answerCypher, lpgDoc)) out.push({ path: 'answerCypher', message: p });
  }
  for (const st of recipe.steps ?? []) {
    const selected = new Set([...String(st.sparql ?? '').replace(/WHERE[\s\S]*$/i, '').matchAll(/[?$](\w+)/g)].map((m) => m[1]));
    for (const col of Object.keys(st.decode ?? {})) if (!selected.has(col)) out.push({ path: `steps/${st.id}/decode`, message: `decode ${col}: the SELECT has no ?${col}.` });
    for (const m of String(st.sparql ?? '').matchAll(/\{\{([^|}]+)\|([^}]+)\}\}/g)) {
      if (!m[2].trim().startsWith('$')) out.push({ path: `steps/${st.id}`, message: `{{${m[1]}|${m[2]}}}: a placeholder takes a $parameter; what the question looks for is a SPARQL variable (?x).` });
    }
  }
  return out;
}

/**
 * The recipe's answer next to the direct Cypher answer, on the columns both
 * have: they agree when they hold the same rows.
 */
export function compareAnswers(recipeRows, cypherRows) {
  const cols = recipeRows.length && cypherRows.length ? Object.keys(cypherRows[0]).filter((c) => c in recipeRows[0]) : Object.keys(cypherRows[0] ?? recipeRows[0] ?? {});
  const key = (r) => JSON.stringify(cols.map((c) => (r[c] === null || r[c] === undefined ? null : String(r[c]))));
  const a = new Set(recipeRows.map(key));
  const b = new Set(cypherRows.map(key));
  const onlyRecipe = [...a].filter((x) => !b.has(x));
  const onlyCypher = [...b].filter((x) => !a.has(x));
  // Two empty answers agree on nothing: the check says nothing then.
  if (!a.size && !b.size) return { columns: cols, agree: null, empty: true, recipeRows: 0, cypherRows: 0, onlyRecipe: [], onlyCypher: [] };
  return { columns: cols, agree: cols.length > 0 && !onlyRecipe.length && !onlyCypher.length, recipeRows: a.size, cypherRows: b.size, onlyRecipe: onlyRecipe.slice(0, 5), onlyCypher: onlyCypher.slice(0, 5) };
}

/** A recipe from a drafted answer: one ephemeral graph, a scope, a query. */
export function recipeFromDraft(answer, { mappingPath, question }) {
  const slug = String(answer.id ?? 'question').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'question';
  const id = /^[a-z]/.test(slug) ? slug : `q-${slug}`;
  const coerce = (p) => (p.type === 'integer' || p.type === 'number' ? Number(p.default) : p.type === 'boolean' ? p.default === 'true' : p.default);
  return {
    format: 'n20s-recipe/0.1', id, title: answer.title ?? question, mapping: mappingPath,
    params: Object.fromEntries((answer.params ?? []).map((p) => [p.name, { ...(p.type && p.type !== 'string' ? { type: p.type } : {}), default: coerce(p), ...(p.description ? { description: p.description } : {}) }])),
    steps: [
      { id: 'scope', type: 'scope', title: 'What the question needs', cypher: String(answer.cypher ?? '').trim() + '\n' },
      { id: 'answer', type: 'query', title: answer.title ?? question, sparql: String(answer.sparql ?? '').trim() + '\n',
        ...(answer.decode?.length ? { decode: Object.fromEntries(answer.decode.map((d) => [d.column, d.node === 'any' ? 'any' : `node:${d.node}`])) } : {}) },
    ],
  };
}

/**
 * Parameter values worth validating a question on: where the direct Cypher
 * answers something, and answers differently from one value to the next. The
 * values come from the property each parameter is compared with ({prop: $p},
 * or x.prop = $p); the default first when it answers. One parameter varies at
 * a time, the others keep their default.
 * @param {{cypher: string, params: object, source: object, max?: number}} a  params: the defaults
 * @returns {Promise<Array<{params: object, rows: number}>>}
 */
export async function suggestCases({ cypher, params = {}, source, max = 3 }) {
  const run = async (p) => {
    if (typeof source.queryType === 'function' && await source.queryType(cypher, p) !== 'r') throw new Error('This Cypher writes: a direct answer only reads.');
    return source.run(cypher, p);
  };
  const names = [...new Set([...String(cypher).matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]))];
  if (!names.length) return [{ params: {}, rows: (await run({})).length }];
  const labels = new Map([...String(cypher).matchAll(/\(\s*([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)/g)].map((m) => [m[1], m[2]]));
  const candidates = async (name) => {
    const inline = new RegExp(`\\(\\s*\\w*\\s*:\\s*([A-Za-z_]\\w*)[^)]*?\\{[^}]*?\\b([A-Za-z_]\\w*)\\s*:\\s*\\$${name}\\b`).exec(cypher);
    const where = new RegExp(`\\b([A-Za-z_]\\w*)\\.([A-Za-z_]\\w*)\\s*=\\s*\\$${name}\\b`).exec(cypher);
    const [label, prop] = inline ? [inline[1], inline[2]] : where && labels.has(where[1]) ? [labels.get(where[1]), where[2]] : [null, null];
    if (!label) return [];
    return (await source.run(`MATCH (n:\`${label}\`) WHERE n.\`${prop}\` IS NOT NULL RETURN DISTINCT n.\`${prop}\` AS v ORDER BY v LIMIT 40`)).map((r) => r.v);
  };
  const out = [];
  const seen = new Set();
  const consider = async (p) => {
    if (out.length >= max) return;
    const rows = await run(p);
    const answer = JSON.stringify(rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => r[k]))).sort());
    if (!rows.length || seen.has(answer)) return;
    seen.add(answer);
    out.push({ params: p, rows: rows.length });
  };
  await consider({ ...params });
  for (const name of names) {
    for (const v of await candidates(name)) {
      if (out.length >= max) break;
      if (v === params[name]) continue;
      await consider({ ...params, [name]: v });
    }
  }
  return out;
}
