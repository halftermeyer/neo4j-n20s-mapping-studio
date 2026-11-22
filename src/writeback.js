// Write-back: a recipe step that writes what reasoning found back into Neo4j,
// as names the LPG ontology declares as inferred (a label, a relationship type,
// a property). It never creates nodes, and it only ever touches its own names.
//
//   - id: mark
//     type: write
//     from: tainted                          # a query or construct step
//     label: { node: version, add: Tainted } # or relationship: {from, type, to}, property: {node, set, value}, cypher:
//     retract: scope                         # (default) or all
//     gate: [check]                          # default: every validate step before it; closed
//
// The LPG ontology declares what is written, and by whom:
//   labels.optional + labels.extensions.custom.inferredBy: { <label>: {recipe, step} }
//   relationship extensions.custom.inferredBy: {recipe, step} | {shared: true}
//   node property extensions.custom.inferredBy: {recipe, step}
//   relationship properties createdBy, createdAt with extensions.custom.provenance: true
//   a node WriteLedger with extensions.custom.technical: true
//
// Each run computes the delta in one write transaction: it locks the step's
// ledger (MERGE on the unique owner), reads the current extension of the name,
// and sends only what changes; an unchanged result rolls back and writes nothing.
// The transaction carries {app: 'n20s', owner: 'recipe/step', run}, so change
// data capture can tell the writes of a recipe from those of the application.
//
// Browser-safe: the connection is passed in.
import { indexLpg } from './lpg.js';
import { resolve, isCompiled } from './resolve.js';
import { parseTemplate } from './iri.js';

export const LEDGER = 'WriteLedger';
export const LEDGER_PROPERTIES = ['owner', 'kind', 'name', 'on', 'firstRun', 'firstAt', 'lastRun', 'lastAt', 'lock', 'adoptedAt'];
/** The constraint an administrator creates once: the tool never changes the schema. */
export const LEDGER_CONSTRAINT = `CREATE CONSTRAINT write_ledger_owner IF NOT EXISTS FOR (l:${LEDGER}) REQUIRE l.owner IS UNIQUE`;
export const WRITE_FORMS = ['label', 'relationship', 'property', 'cypher'];
export const PROVENANCE = ['createdBy', 'createdAt'];
const APP = 'n20s';
/** proposedBy.name of the mapping entries left out because they are written back. */
export const WRITE_BACK_TOOL = 'write-back';

export const ownerOf = (recipe, step) => `${recipe.id}/${step.id}`;
export const formOf = (step) => WRITE_FORMS.filter((f) => step?.[f] !== undefined);
/** Transaction metadata of a write: what change data capture shows. */
export const txMetadata = (owner, run) => ({ app: APP, owner, run });
/** A transaction written by this recipe (exact recipe id: taint is not taint-writeback). */
export const ownTransaction = (meta, recipeId) => meta?.app === APP && String(meta?.owner ?? '').split('/')[0] === recipeId;

const quote = (name) => '`' + String(name).replaceAll('`', '``') + '`';
const custom = (x) => x?.extensions?.custom ?? {};
const sameOwner = (by, recipe, step) => by && by.recipe === recipe.id && by.step === step.id;

// The ontology -------------------------------------------------------------------------------

/** What the LPG ontology declares for write-back: inferred names, provenance, the ledger. */
export function writeDeclarations(lpgDoc) {
  const labels = [];
  const relationships = [];
  const properties = [];
  const technical = [];
  for (const [id, n] of Object.entries(lpgDoc?.nodes ?? {})) {
    const by = custom(n.labels).inferredBy ?? {};
    for (const l of n.labels?.optional ?? []) if (by[l]) labels.push({ node: id, label: l, inferredBy: by[l] });
    for (const [pid, p] of Object.entries(n.properties ?? {})) if (custom(p).inferredBy) properties.push({ node: id, property: pid, name: p.name ?? pid, inferredBy: custom(p).inferredBy });
    if (custom(n).technical) technical.push({ node: id, label: n.labels?.identifier ?? n.label });
  }
  for (const [id, r] of Object.entries(lpgDoc?.relationships ?? {})) {
    const by = custom(r).inferredBy;
    if (!by) continue;
    const provenance = Object.entries(r.properties ?? {}).filter(([, p]) => custom(p).provenance).map(([pid, p]) => ({ property: pid, name: p.name ?? pid }));
    relationships.push({ relationship: id, type: r.type, from: r.from?.node, to: r.to?.node, inferredBy: by, provenance });
  }
  const ledger = technical.find((t) => t.label === LEDGER) ?? null;
  return { labels, relationships, properties, technical, ledger };
}

/** Mapping paths that must stay out of the mapping: inferred, provenance, technical. With why. */
export function writtenPaths(lpgDoc) {
  const d = writeDeclarations(lpgDoc);
  const by = (x) => (x.shared ? 'shared inferred name' : `inferred by ${x.recipe}/${x.step}`);
  const out = new Map();
  for (const r of d.relationships) out.set(`relationships/${r.relationship}`, `${r.type} is ${by(r.inferredBy)}: written back by a recipe, not ingested.`);
  for (const p of d.properties) out.set(`nodes/${p.node}/properties/${p.property}`, `${p.name} is ${by(p.inferredBy)}: written back by a recipe, not ingested.`);
  for (const t of d.technical) out.set(`nodes/${t.node}`, `${t.label} is technical (write-back bookkeeping), not data.`);
  return out;
}

/**
 * The LPG ontology without what is written back: inferred labels, relationships
 * and properties, provenance, technical nodes. What a mapping maps from, and
 * what a model sees when it proposes one.
 */
export function withoutWriteBack(lpgDoc) {
  const d = writeDeclarations(lpgDoc);
  if (!d.labels.length && !d.relationships.length && !d.properties.length && !d.technical.length) return lpgDoc;
  const doc = structuredClone(lpgDoc);
  for (const t of d.technical) delete doc.nodes[t.node];
  for (const r of d.relationships) delete doc.relationships[r.relationship];
  for (const p of d.properties) delete doc.nodes[p.node]?.properties?.[p.property];
  for (const n of Object.values(doc.nodes ?? {})) {
    const by = n.labels?.extensions?.custom?.inferredBy;
    if (!by) continue;
    n.labels.optional = (n.labels.optional ?? []).filter((l) => !by[l]);
    if (!n.labels.optional.length) delete n.labels.optional;
    delete n.labels.extensions.custom.inferredBy;
    if (!Object.keys(n.labels.extensions.custom).length) delete n.labels.extensions.custom;
    if (!Object.keys(n.labels.extensions).length) delete n.labels.extensions;
  }
  return doc;
}

// Resolving a write step ----------------------------------------------------------------------

/**
 * What a write step writes, resolved against the LPG ontology and the mapping:
 * the declared name, the node kinds it is on, and how to find a node from a key.
 * Returns {target, findings, missing}: missing lists what the ontology lacks (for the patch).
 */
export function resolveWrite(recipe, step, { lpgDoc = null, mapping = null } = {}) {
  const findings = [];
  const missing = [];
  const path = `steps/${step.id}`;
  const err = (code, message) => findings.push({ severity: 'error', code, path, message });
  const warn = (code, message) => findings.push({ severity: 'warning', code, path, message });
  const forms = formOf(step);
  if (forms.length !== 1) {
    err('write.form', `A write step has one of ${WRITE_FORMS.join(', ')}${forms.length ? `, not ${forms.join(' and ')}` : ''}.`);
    return { target: null, findings, missing };
  }
  const form = forms[0];
  const owner = ownerOf(recipe, step);
  if (step.retract !== undefined && !['scope', 'all'].includes(step.retract)) err('write.retract', `retract is scope (the default: only on the nodes the recipe scoped) or all, not ${step.retract}.`);
  const source = (recipe.steps ?? []).find((s) => s.id === step.from);
  const decodeOf = (col) => (step.decode ?? {})[col] ?? source?.decode?.[col];
  const kindOf = (col) => {
    const spec = decodeOf(col);
    const m = /^node:(.+)$/.exec(String(spec ?? ''));
    if (!m) { err('write.keys', `Column ${col} is not decoded as a node: add decode: { ${col}: "node:<node id>" } to ${source?.type === 'construct' ? 'this step' : `step ${step.from}`}.`); return null; }
    return m[1];
  };
  if (form === 'cypher') {
    warn('write.free-cypher', 'Free Cypher: the tool cannot check what it writes, compute a delta or retract. It runs in the write transaction, with $rows, $owner and $run.');
    return { target: { form, owner, kind: 'cypher', name: null, on: null }, findings, missing };
  }
  if (!lpgDoc) return { target: null, findings, missing };
  const idx = indexLpg(lpgDoc);
  const d = writeDeclarations(lpgDoc);
  const labelOf = (id) => idx.nodes.get(id)?.label;
  // The key of a node kind: the one placeholder of its subject. Write steps find nodes by it.
  let r = null;
  const keyOf = (nodeId, col) => {
    if (!mapping) return { id: nodeId, label: labelOf(nodeId), keyLabel: labelOf(nodeId), key: null, column: col };
    r ??= resolve(mapping, idx, isCompiled);
    const s = r.effectiveSubject(nodeId);
    const phs = s ? parseTemplate(s.template).placeholders : [];
    if (phs.length !== 1) { err('write.keys', `${labelOf(nodeId)} needs an accepted subject with one key to be found from ${col}; it has ${s ? `${phs.length} placeholders` : 'none'}.`); return null; }
    const found = idx.findNodeProperty(nodeId, phs[0]);
    return { id: nodeId, label: labelOf(nodeId), keyLabel: labelOf(found?.owner ?? nodeId), key: found?.prop.name ?? phs[0], column: col, template: s.template };
  };
  // The decoded kind must have the same subject as the kind written: the key means the same node.
  const sameSubject = (col, decoded, written) => {
    if (!mapping || !decoded || !written || decoded === written.id) return;
    const a = r?.effectiveSubject(decoded)?.template;
    if (a && written.template && a !== written.template) err('write.keys', `Column ${col} is decoded as ${labelOf(decoded)} (${a}), but ${written.label} has subject ${written.template}: decode it as node:${written.id}.`);
  };
  const ledger = () => { if (!d.ledger) missing.push({ kind: 'ledger' }); };

  if (form === 'label') {
    const { node: col, add } = step.label ?? {};
    if (!col || !add) { err('write.form', 'label: { node: <column>, add: <Label> }.'); return { target: null, findings, missing }; }
    const decoded = kindOf(col);
    const decls = d.labels.filter((x) => x.label === add);
    const decl = decls.find((x) => x.node === decoded) ?? decls.find((x) => decoded && [decoded, ...idx.ancestors(decoded)].includes(x.node)) ?? (decls.length === 1 ? decls[0] : null);
    if (!decl) {
      const declared = Object.values(lpgDoc.nodes ?? {}).some((n) => (n.labels?.optional ?? []).includes(add));
      if (declared) err('write.owner', `${add} is an optional label of the ontology, not an inferred one: declare labels.extensions.custom.inferredBy.${add} = {recipe: ${recipe.id}, step: ${step.id}}.`);
      if (idx.labelToNode.has(add)) err('write.owner', `${add} is a node kind of the ontology: a write step never adds an identifying label.`);
      else missing.push({ kind: 'label', label: add, node: decoded, owner: { recipe: recipe.id, step: step.id } });
      ledger();
      return { target: null, findings, missing };
    }
    if (decl.inferredBy.shared) err('write.shared', `${add}: a label is never shared; one step owns it.`);
    else if (!sameOwner(decl.inferredBy, recipe, step)) err('write.owner', `${add} is inferred by ${decl.inferredBy.recipe}/${decl.inferredBy.step}, not ${owner}.`);
    const node = keyOf(decl.node, col);
    sameSubject(col, decoded, node);
    ledger();
    return { target: node && { form, owner, kind: 'label', name: add, on: node.label, node, retract: step.retract ?? 'scope' }, findings, missing };
  }

  if (form === 'relationship') {
    const { from: fc, type, to: tc } = step.relationship ?? {};
    if (!fc || !type || !tc) { err('write.form', 'relationship: { from: <column>, type: <TYPE>, to: <column> }.'); return { target: null, findings, missing }; }
    const [df, dt] = [kindOf(fc), kindOf(tc)];
    const decls = d.relationships.filter((x) => x.type === type);
    const fits = (x, decoded) => !decoded || [decoded, ...idx.ancestors(decoded)].includes(x) || idx.ancestors(x).includes(decoded);
    const decl = decls.find((x) => x.from === df && x.to === dt) ?? decls.find((x) => fits(x.from, df) && fits(x.to, dt)) ?? null;
    if (!decl) {
      if ([...idx.rels.values()].some((x) => x.type === type)) err('write.owner', `${type} is a relationship type of the ontology that no recipe infers: declare extensions.custom.inferredBy = {recipe: ${recipe.id}, step: ${step.id}} on it, if it is not ingested.`);
      else missing.push({ kind: 'relationship', type, from: df, to: dt, owner: step.owner ? { shared: true } : { recipe: recipe.id, step: step.id } });
      ledger();
      return { target: null, findings, missing };
    }
    const shared = !!decl.inferredBy.shared;
    if (shared && !step.owner) err('write.shared', `${type} is shared: the step names the owner it writes on each relationship (owner: <name>).`);
    if (!shared && step.owner) err('write.shared', `${type} is owned by one step: owner: is for shared names.`);
    if (!shared && !sameOwner(decl.inferredBy, recipe, step)) err('write.owner', `${type} is inferred by ${decl.inferredBy.recipe}/${decl.inferredBy.step}, not ${owner}.`);
    const prov = new Set(decl.provenance.map((p) => p.name));
    const lacking = PROVENANCE.filter((p) => !prov.has(p));
    if (lacking.length) missing.push({ kind: 'provenance', relationship: decl.relationship, names: lacking });
    if (shared && !Object.values(lpgDoc.relationships[decl.relationship].properties ?? {}).some((p) => (p.name ?? '') === 'owner')) missing.push({ kind: 'owner-property', relationship: decl.relationship });
    const from = keyOf(decl.from, fc);
    const to = keyOf(decl.to, tc);
    sameSubject(fc, df, from);
    sameSubject(tc, dt, to);
    ledger();
    return {
      target: from && to && { form, owner, kind: 'relationship', name: type, on: `${from.label}->${to.label}`, from, to, shared, writeOwner: step.owner ?? null, provenance: [...prov].filter((p) => PROVENANCE.includes(p)), retract: step.retract ?? 'scope' },
      findings, missing,
    };
  }

  // property
  const { node: col, set, value } = step.property ?? {};
  if (!col || !set || !value) { err('write.form', 'property: { node: <column>, set: <property name>, value: <column> }.'); return { target: null, findings, missing }; }
  const decoded = kindOf(col);
  const decl = d.properties.find((x) => x.name === set && (!decoded || [decoded, ...idx.ancestors(decoded)].includes(x.node))) ?? null;
  if (!decl) {
    const ingested = decoded && [decoded, ...idx.ancestors(decoded)].some((n) => [...idx.nodes.get(n)?.props.values() ?? []].some((p) => p.name === set));
    if (ingested) err('write.owner', `${set} is an ingested property of ${labelOf(decoded)}: a write step never overwrites data. Declare another property, inferred by ${owner}.`);
    else missing.push({ kind: 'property', node: decoded, name: set, owner: { recipe: recipe.id, step: step.id } });
    ledger();
    return { target: null, findings, missing };
  }
  if (decl.inferredBy.shared) err('write.shared', `${set}: no shared property in this version; one step owns it.`);
  else if (!sameOwner(decl.inferredBy, recipe, step)) err('write.owner', `${set} is inferred by ${decl.inferredBy.recipe}/${decl.inferredBy.step}, not ${owner}.`);
  const node = keyOf(decoded ?? decl.node, col);
  ledger();
  return { target: node && { form, owner, kind: 'property', name: set, on: node.label, node, value, retract: step.retract ?? 'scope' }, findings, missing };
}

/** The ontology lacks what the recipe writes: one actionable error for all of it. */
export function undeclaredFinding(recipeId, missing, path = 'steps') {
  if (!missing.length) return null;
  const what = [...new Set(missing.map(describeMissing))];
  return {
    severity: 'error', code: 'write.undeclared', path,
    message: `The LPG ontology does not declare what ${recipeId} writes back (${what.join('; ')}). An export from the Aura tool may have lost these declarations: run \`n20s-mapping write-patch\` (or Ontology patch in the studio), apply it, and re-apply it in the Aura ontology.`,
    data: { missing },
  };
}

function describeMissing(m) {
  if (m.kind === 'ledger') return `the technical node ${LEDGER}`;
  if (m.kind === 'label') return `inferred label ${m.label}`;
  if (m.kind === 'relationship') return `inferred relationship ${m.type}`;
  if (m.kind === 'provenance') return `provenance ${m.names.join(', ')} on ${m.relationship}`;
  if (m.kind === 'owner-property') return `the owner property of shared ${m.relationship}`;
  return `inferred property ${m.name}`;
}

/**
 * Findings on the write steps of a recipe (write.*): what is written, by whom,
 * from what, behind which gate. Recipe-level rules (kind, api) included.
 */
export function checkWrites(recipe, { lpgDoc = null, mapping = null, kind = null } = {}) {
  const steps = recipe?.steps ?? [];
  const writes = steps.filter((s) => s?.type === 'write');
  if (!writes.length) return [];
  const findings = [];
  const missing = [];
  if (kind && kind !== 'build') findings.push({ severity: 'error', code: 'write.kind', path: 'steps', message: `Only a build recipe writes back (it builds a persistent graph); this one is ${kind}.` });
  if (recipe.api !== undefined) findings.push({ severity: 'error', code: 'write.kind', path: 'api', message: 'A recipe that writes back has no api: a query never writes.' });
  const names = new Map();
  const before = new Map();
  for (const s of steps) {
    if (s.type === 'write') {
      const path = `steps/${s.id}`;
      const src = before.get(s.from);
      if (!s.from) findings.push({ severity: 'error', code: 'write.from', path, message: 'A write step names the query or construct step whose rows it writes: from: <step>.' });
      else if (!src) findings.push({ severity: 'error', code: 'write.from', path, message: `from: ${s.from} is not a step that runs before.` });
      else if (!['query', 'construct'].includes(src.type)) findings.push({ severity: 'error', code: 'write.from', path, message: `from: ${s.from} is a ${src.type} step; a write reads the rows of a query or construct step.` });
      for (const g of s.gate ?? []) {
        if (!before.has(g)) findings.push({ severity: 'error', code: 'write.gate', path, message: `Gate ${g} is not a step that runs before.` });
        else if (before.get(g).type !== 'validate') findings.push({ severity: 'error', code: 'write.gate', path, message: `Gate ${g} is not a validate step.` });
      }
      const res = resolveWrite(recipe, s, { lpgDoc, mapping });
      findings.push(...res.findings);
      missing.push(...res.missing);
      if (res.target?.name) {
        const k = `${res.target.kind}|${res.target.name}|${res.target.on}|${res.target.writeOwner ?? ''}`;
        if (names.has(k)) findings.push({ severity: 'error', code: 'write.owner', path, message: `${res.target.name} is written by ${names.get(k)} too: one step per name.` });
        names.set(k, s.id);
        // The recipe reads, in its own scope, what it writes: its result depends on its last run.
        const reads = steps.filter((x) => ['scope', 'rows'].includes(x.type)).map((x) => String(x.cypher ?? ''));
        const re = new RegExp(`[:|]\\s*\`?${res.target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?\\b`);
        if (reads.some((c) => re.test(c))) findings.push({ severity: 'warning', code: 'write.reads-own', path, message: `The recipe's Cypher reads ${res.target.name}, which it writes: a run sees what the last run wrote.` });
      }
    }
    if (s?.id) before.set(s.id, s);
  }
  // One error for everything the ontology lacks, whatever the step.
  const seen = new Set();
  const uniq = missing.filter((m) => { const k = JSON.stringify(m.kind === 'ledger' ? { kind: 'ledger' } : m); if (seen.has(k)) return false; seen.add(k); return true; });
  const u = undeclaredFinding(recipe.id, uniq);
  if (u) findings.push(u);
  return findings;
}

// The patch of the ontology ------------------------------------------------------------------

const nextId = (used, prefix) => { let i = 0; while (used.has(`${prefix}:${i}`)) i += 1; used.add(`${prefix}:${i}`); return `${prefix}:${i}`; };

/**
 * What to add to the LPG ontology so that it declares what these recipes write:
 * inferred names, provenance properties, the WriteLedger node. Returns the
 * changes (to apply by hand in the Aura tool too) and the patched document.
 * @param {object} lpgDoc
 * @param {Array<{recipe: object}>} recipes  with their mapping, as loaded
 */
export function exportPatch(lpgDoc, recipes, { mapping = null } = {}) {
  const doc = structuredClone(lpgDoc);
  doc.nodes ??= {};
  doc.relationships ??= {};
  const usedProps = new Set();
  for (const x of [...Object.values(doc.nodes), ...Object.values(doc.relationships)]) for (const pid of Object.keys(x.properties ?? {})) usedProps.add(pid);
  const usedNodes = new Set(Object.keys(doc.nodes));
  const usedRels = new Set(Object.keys(doc.relationships));
  const usedConstraints = new Set(Object.values(doc.nodes).flatMap((n) => Object.keys(n.constraints ?? {})));
  // New nodes are drawn to the right of the others.
  const xs = Object.values(doc.nodes).map((n) => n.extensions?.display?.x).filter(Number.isFinite);
  const ys = Object.values(doc.nodes).map((n) => n.extensions?.display?.y).filter(Number.isFinite);
  const changes = [];
  const prop = (name, type, ext) => ({ type, name, ...(ext ? { extensions: { custom: ext } } : {}) });
  for (const { recipe, mapping: m = mapping } of recipes) {
    for (const s of recipe.steps ?? []) {
      if (s.type !== 'write') continue;
      const { missing } = resolveWrite(recipe, s, { lpgDoc: doc, mapping: m });
      for (const x of missing) {
        if (x.kind === 'ledger') {
          if (Object.values(doc.nodes).some((n) => n.labels?.identifier === LEDGER)) continue;
          const id = nextId(usedNodes, 'n');
          const props = {};
          const types = { firstAt: 'ZONED DATETIME', lastAt: 'ZONED DATETIME', adoptedAt: 'ZONED DATETIME' };
          for (const name of LEDGER_PROPERTIES) props[nextId(usedProps, 'p')] = prop(name, types[name] ?? 'STRING');
          const ownerPid = Object.entries(props).find(([, p]) => p.name === 'owner')[0];
          doc.nodes[id] = {
            labels: { identifier: LEDGER }, properties: props,
            constraints: { [nextId(usedConstraints, 'c')]: { type: 'UNIQUE', properties: [ownerPid], name: 'write_ledger_owner' } },
            description: 'Write-back bookkeeping: one node per write step (owner recipe/step), locked by each run. Technical, never mapped.',
            extensions: { ...(xs.length ? { display: { x: Math.max(...xs) + 250, y: Math.max(...ys) } } : {}), custom: { technical: true } },
          };
          changes.push({ op: 'add-node', path: `nodes/${id}`, what: `technical node ${LEDGER} (owner unique)` });
        } else if (x.kind === 'label') {
          const n = doc.nodes[x.node];
          if (!n) continue;
          n.labels ??= {};
          n.labels.optional = [...new Set([...(n.labels.optional ?? []), x.label])];
          n.labels.extensions ??= {};
          n.labels.extensions.custom ??= {};
          n.labels.extensions.custom.inferredBy = { ...(n.labels.extensions.custom.inferredBy ?? {}), [x.label]: x.owner };
          changes.push({ op: 'add-label', path: `nodes/${x.node}/labels`, what: `optional label ${x.label} on ${n.labels.identifier}, inferred by ${x.owner.recipe}/${x.owner.step}` });
        } else if (x.kind === 'relationship') {
          if (!x.from || !x.to) continue;
          const id = nextId(usedRels, 'r');
          const props = {};
          props[nextId(usedProps, 'p')] = prop('createdBy', 'STRING', { provenance: true });
          props[nextId(usedProps, 'p')] = prop('createdAt', 'ZONED DATETIME', { provenance: true });
          if (x.owner.shared) props[nextId(usedProps, 'p')] = prop('owner', 'STRING');
          doc.relationships[id] = { type: x.type, from: { node: x.from }, to: { node: x.to }, properties: props, extensions: { custom: { inferredBy: x.owner } } };
          changes.push({ op: 'add-relationship', path: `relationships/${id}`, what: `${x.type} (${doc.nodes[x.from]?.labels?.identifier} -> ${doc.nodes[x.to]?.labels?.identifier}), inferred by ${x.owner.shared ? 'several steps (shared)' : `${x.owner.recipe}/${x.owner.step}`}, with createdBy, createdAt` });
        } else if (x.kind === 'provenance') {
          const r = doc.relationships[x.relationship];
          r.properties ??= {};
          for (const name of x.names) {
            const existing = Object.values(r.properties).find((p) => p.name === name);
            if (existing) { existing.extensions = { ...(existing.extensions ?? {}), custom: { ...(existing.extensions?.custom ?? {}), provenance: true } }; continue; }
            r.properties[nextId(usedProps, 'p')] = prop(name, name === 'createdAt' ? 'ZONED DATETIME' : 'STRING', { provenance: true });
          }
          changes.push({ op: 'add-properties', path: `relationships/${x.relationship}/properties`, what: `provenance ${x.names.join(', ')} on ${r.type}` });
        } else if (x.kind === 'owner-property') {
          const r = doc.relationships[x.relationship];
          r.properties ??= {};
          r.properties[nextId(usedProps, 'p')] = prop('owner', 'STRING');
          changes.push({ op: 'add-properties', path: `relationships/${x.relationship}/properties`, what: `owner on shared ${r.type}` });
        } else if (x.kind === 'property') {
          const n = doc.nodes[x.node];
          if (!n) continue;
          n.properties ??= {};
          n.properties[nextId(usedProps, 'p')] = prop(x.name, 'STRING', { inferredBy: x.owner });
          changes.push({ op: 'add-property', path: `nodes/${x.node}/properties`, what: `${x.name} on ${n.labels?.identifier}, inferred by ${x.owner.recipe}/${x.owner.step} (type STRING: adjust)` });
        }
      }
    }
  }
  return { changes, doc };
}

// Running a write ----------------------------------------------------------------------------

const deltaKeys = ['labelsAdded', 'labelsRemoved', 'relationshipsCreated', 'relationshipsDeleted', 'propertiesSet', 'nodesCreated', 'nodesDeleted'];
const sum = (a, b) => Object.fromEntries(deltaKeys.map((k) => [k, (a?.[k] ?? 0) + (b?.[k] ?? 0)]));
const zero = () => Object.fromEntries(deltaKeys.map((k) => [k, 0]));
const plainKey = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : v);

/** Whether the ledger constraint exists. Null when it cannot be read. */
export async function ledgerConstraint(writer) {
  try {
    const [r] = await writer.run(`SHOW CONSTRAINTS YIELD labelsOrTypes, properties, type
      WHERE labelsOrTypes = ['${LEDGER}'] AND properties = ['owner'] AND type IN ['UNIQUENESS', 'NODE_KEY', 'NODE_PROPERTY_UNIQUENESS']
      RETURN count(*) AS n`);
    return Number(r?.n ?? 0) > 0;
  } catch {
    return null;
  }
}

const NEEDS_CONSTRAINT = `Write-back needs a uniqueness constraint on ${LEDGER}.owner, which the tool never creates (it does not change the schema). Ask an administrator to run:\n  ${LEDGER_CONSTRAINT}`;

/** The Cypher of one write form. */
function cypherOf(t) {
  const q = quote;
  const match = (v, n, param) => `MATCH (${v}:${q(n.keyLabel)} {${q(n.key)}: ${param}})${n.keyLabel !== n.label ? ` WHERE ${v}:${q(n.label)}` : ''}`;
  if (t.kind === 'label') {
    const n = t.node;
    return {
      existing: `UNWIND $keys AS k ${match('n', n, 'k')} RETURN DISTINCT n.${q(n.key)} AS k`,
      current: `MATCH (n:${q(n.label)}:${q(t.name)}) ${t.scoped ? `WHERE n.${q(n.key)} IN $scope ` : ''}RETURN n.${q(n.key)} AS k`,
      add: `UNWIND $add AS k ${match('n', n, 'k')} SET n:${q(t.name)}`,
      remove: `UNWIND $remove AS k ${match('n', n, 'k')} REMOVE n:${q(t.name)}`,
      facts: `MATCH (n:${q(t.name)}) RETURN count(n) AS n`,
      total: `MATCH (n:${q(n.label)}) RETURN count(n) AS n`,
    };
  }
  if (t.kind === 'relationship') {
    const { from: a, to: b } = t;
    const own = t.shared ? 'r.owner = $owner' : null;
    const where = [t.scoped ? `a.${q(a.key)} IN $scope` : null, own].filter(Boolean);
    return {
      existingFrom: `UNWIND $keys AS k ${match('n', a, 'k')} RETURN DISTINCT n.${q(a.key)} AS k`,
      existingTo: `UNWIND $keys AS k ${match('n', b, 'k')} RETURN DISTINCT n.${q(b.key)} AS k`,
      current: `MATCH (a:${q(a.label)})-[r:${q(t.name)}]->(b:${q(b.label)}) ${where.length ? `WHERE ${where.join(' AND ')} ` : ''}RETURN a.${q(a.key)} AS a, b.${q(b.key)} AS b, count(r) AS n`,
      add: `UNWIND $add AS p ${match('a', a, 'p[0]')} ${match('b', b, 'p[1]')} CREATE (a)-[r:${q(t.name)}]->(b) SET r += $props${t.provenance.includes('createdAt') ? ', r.createdAt = datetime()' : ''}`,
      remove: `UNWIND $remove AS p ${match('a', a, 'p[0]')} ${match('b', b, 'p[1]')} MATCH (a)-[r:${q(t.name)}]->(b)${own ? ` WHERE ${own}` : ''} DELETE r`,
      facts: `MATCH ()-[r:${q(t.name)}]->() ${own ? `WHERE ${own} ` : ''}RETURN count(r) AS n`,
      total: `MATCH (n:${q(a.label)}) RETURN count(n) AS n`,
    };
  }
  const n = t.node;
  return {
    existing: `UNWIND $keys AS k ${match('n', n, 'k')} RETURN DISTINCT n.${q(n.key)} AS k`,
    current: `MATCH (n:${q(n.label)}) WHERE n.${q(t.name)} IS NOT NULL ${t.scoped ? `AND n.${q(n.key)} IN $scope ` : ''}RETURN n.${q(n.key)} AS k, n.${q(t.name)} AS v`,
    add: `UNWIND $add AS e ${match('n', n, 'e[0]')} SET n.${q(t.name)} = e[1]`,
    remove: `UNWIND $remove AS k ${match('n', n, 'k')} REMOVE n.${q(t.name)}`,
    facts: `MATCH (n) WHERE n.${q(t.name)} IS NOT NULL RETURN count(n) AS n`,
    total: `MATCH (n:${q(n.label)}) RETURN count(n) AS n`,
  };
}

/** What the rows ask for: keys, pairs or key -> value, with rows that cannot be written set aside. */
function wantedOf(t, rows) {
  const skipped = [];
  const ok = (v) => v !== null && v !== undefined && !(typeof v === 'string' && v.startsWith('<undecodable '));
  if (t.kind === 'label') {
    const keys = new Map();
    for (const r of rows) { const k = r[t.node.column]; if (ok(k)) keys.set(plainKey(k), k); else skipped.push(r); }
    return { wanted: keys, skipped };
  }
  if (t.kind === 'relationship') {
    const pairs = new Map();
    for (const r of rows) {
      const [a, b] = [r[t.from.column], r[t.to.column]];
      if (ok(a) && ok(b)) pairs.set(JSON.stringify([a, b]), [a, b]); else skipped.push(r);
    }
    return { wanted: pairs, skipped };
  }
  const values = new Map();
  const conflicts = [];
  for (const r of rows) {
    const [k, v] = [r[t.node.column], r[t.value]];
    if (!ok(k) || v === null || v === undefined) { skipped.push(r); continue; }
    const key = plainKey(k);
    if (values.has(key) && JSON.stringify(values.get(key)[1]) !== JSON.stringify(v)) conflicts.push(k);
    values.set(key, [k, v]);
  }
  if (conflicts.length) throw new Error(`Several values of ${t.name} for ${conflicts.slice(0, 5).join(', ')}: a property has one value per node.`);
  return { wanted: values, skipped };
}

/**
 * Writes the rows of a step in one transaction, as a delta.
 * @param {object} a
 * @param {object} a.writer      openWriter(): run() and transaction()
 * @param {object} a.target      resolveWrite().target
 * @param {object[]} a.rows      rows with node columns decoded to keys
 * @param {string} a.run         run id
 * @param {Array|null} [a.scope] keys of the written kind the recipe scoped (retract: scope); null when it scoped none
 * @param {string|null} [a.cypher] free Cypher (form cypher)
 * @returns {Promise<object>} what changed, or that nothing did
 */
export async function runWrite({ writer, target: t, rows, run, scope = null, cypher = null }) {
  if (!writer?.transaction) throw new Error('No write connection: set N20S_WRITE (and N20S_WRITE_USER, N20S_WRITE_PASSWORD), a user with the fine-grained write privileges of this step.');
  const hasConstraint = await ledgerConstraint(writer);
  if (hasConstraint !== true) throw new Error(hasConstraint === null ? `${NEEDS_CONSTRAINT}\n(The write user could not list constraints: grant it SHOW CONSTRAINT.)` : NEEDS_CONSTRAINT);
  const owner = t.owner;
  const meta = txMetadata(owner, run);
  const out = { owner, kind: t.kind, name: t.name, on: t.on, rows: rows.length };
  try {
    return await transaction();
  } catch (err) {
    // A name the database has never seen: creating it is name management, which the writer does not have.
    if (/Creating new (property name|label|relationship type|node label)/i.test(err.message)) {
      throw new Error(`${err.message.split('\n')[0]} The writer has no right to create names: an administrator registers them once (create and delete a node that carries them: label ${t.name ?? ''}, ${LEDGER} and its properties${t.kind === 'relationship' ? `, ${PROVENANCE.join(', ')}` : ''}), or grants CREATE NEW NAME on the database.`);
    }
    throw err;
  }

  function transaction() {
  return writer.transaction(async (tx) => {
    let counters = zero();
    const exec = async (q, p = {}) => { const r = await tx.run(q, { owner, run, ...p }); counters = sum(counters, r.counters); return r.rows; };
    // 1. The ledger: does this step own its name already? (collision at the first run)
    const [{ n: ledgers }] = (await tx.run(`MATCH (l:${LEDGER} {owner: $owner}) RETURN count(l) AS n`, { owner })).rows;
    // 2. Lock it: a second run of the same step waits here until the first commits or rolls back.
    const lock = await tx.run(`MERGE (l:${LEDGER} {owner: $owner}) SET l.lock = $run RETURN l.firstRun AS firstRun`, { owner, run });
    const ledgerCounters = lock.counters;
    // A run that waited on the lock finds the ledger the other one committed: not a first run any more.
    const first = Number(ledgers) === 0 && (lock.rows[0]?.firstRun ?? null) === null;

    if (t.kind === 'cypher') {
      const before = counters;
      await exec(cypher, { rows });
      const changed = deltaKeys.some((k) => counters[k] !== before[k]);
      if (!changed) return { commit: false, ...out, written: false, counters, note: 'The Cypher changed nothing: rolled back, ledger untouched.' };
      await tx.run(`MATCH (l:${LEDGER} {owner: $owner}) SET l.kind = 'cypher', l.firstRun = coalesce(l.firstRun, $run), l.firstAt = coalesce(l.firstAt, datetime()), l.lastRun = $run, l.lastAt = datetime() REMOVE l.lock`, { owner, run });
      return { commit: true, ...out, written: true, counters, ledger: first ? 'created' : 'updated', metadata: meta };
    }

    const q = cypherOf({ ...t, scoped: t.retract === 'scope' });
    if (first) {
      const [{ n }] = await exec(q.facts);
      if (Number(n) > 0) {
        throw new Error(`Collision: ${Number(n)} ${t.kind === 'label' ? 'nodes already carry' : t.kind === 'relationship' ? 'relationships already have' : 'nodes already have'} ${t.name}, and no ${LEDGER} says that ${owner} wrote them. If they are this step's (a ledger that was deleted), take them over with: n20s-mapping adopt <recipe> ${owner.split('/')[1]} --yes. Otherwise rename what this step writes.`);
      }
    }
    if (t.retract === 'all') {
      const [{ n: total }] = await exec(q.total);
      const scoped = scope?.length ?? 0;
      if (scoped < Number(total)) throw new Error(`retract: all needs a scope that covers every ${t.kind === 'relationship' ? t.from.label : t.node.label} (${Number(total)} in the database, ${scoped} scoped): retract only on the scope (retract: scope), or scope them all.`);
    }
    const { wanted, skipped } = wantedOf(t, rows);
    const scopeKeys = (scope ?? []).map((k) => k);
    const warnings = [];
    if (skipped.length) warnings.push(`${skipped.length} row(s) without a decodable node or a value: not written.`);

    if (t.kind === 'relationship') {
      const pairs = [...wanted.values()];
      const ends = async (cy, keys) => new Set((await exec(cy, { keys })).map((r) => plainKey(r.k)));
      const aKeys = await ends(q.existingFrom, [...new Set(pairs.map((p) => p[0]))]);
      const bKeys = await ends(q.existingTo, [...new Set(pairs.map((p) => p[1]))]);
      const live = pairs.filter(([a, b]) => aKeys.has(plainKey(a)) && bKeys.has(plainKey(b)));
      const vanished = pairs.length - live.length;
      if (vanished) warnings.push(`${vanished} pair(s) whose nodes are no longer in the database: not written.`);
      const current = await exec(q.current, { scope: scopeKeys });
      const have = new Map(current.map((r) => [JSON.stringify([r.a, r.b]), r]));
      const dup = current.filter((r) => Number(r.n) > 1).length;
      if (dup) warnings.push(`${dup} pair(s) have the relationship more than once (written outside this step?): left as they are.`);
      const add = live.filter((p) => !have.has(JSON.stringify(p)));
      const want = new Set(live.map((p) => JSON.stringify(p)));
      const remove = current.filter((r) => !want.has(JSON.stringify([r.a, r.b])) && !(r.a === null || r.b === null)).map((r) => [r.a, r.b]);
      return finish({ add, remove, warnings, vanished, props: { ...(t.provenance.includes('createdBy') ? { createdBy: `${owner}@${run}` } : {}), ...(t.shared ? { owner: t.writeOwner } : {}) } });
    }

    const keys = t.kind === 'label' ? [...wanted.values()] : [...wanted.values()].map(([k]) => k);
    const existing = new Set((await exec(q.existing, { keys })).map((r) => plainKey(r.k)));
    const vanished = keys.filter((k) => !existing.has(plainKey(k))).length;
    if (vanished) warnings.push(`${vanished} node(s) no longer in the database: not written.`);
    const current = await exec(q.current, { scope: scopeKeys });
    if (t.kind === 'label') {
      const have = new Set(current.map((r) => plainKey(r.k)));
      const add = keys.filter((k) => existing.has(plainKey(k)) && !have.has(plainKey(k)));
      const remove = current.map((r) => r.k).filter((k) => !wanted.has(plainKey(k)));
      return finish({ add, remove, warnings, vanished });
    }
    const have = new Map(current.map((r) => [plainKey(r.k), r.v]));
    const add = [...wanted.values()].filter(([k, v]) => existing.has(plainKey(k)) && JSON.stringify(have.get(plainKey(k))) !== JSON.stringify(v));
    const remove = current.map((r) => r.k).filter((k) => !wanted.has(plainKey(k)));
    return finish({ add, remove, warnings, vanished });

    async function finish({ add, remove, warnings: w, vanished: gone, props = {} }) {
      const result = { ...out, added: add.length, removed: remove.length, vanished: gone, warnings: w, retract: t.retract, scope: t.retract === 'scope' ? scopeKeys.length : null };
      // Nothing changes: roll back, the lock with it. No transaction reaches the database, nor change data capture.
      if (!add.length && !remove.length) return { commit: false, ...result, written: false, counters: zero() };
      const before = counters;
      if (add.length) await exec(q.add, { add, props });
      if (remove.length) await exec(q.remove, { remove });
      const done = Object.fromEntries(deltaKeys.map((k) => [k, counters[k] - before[k]]));
      // The counters must say exactly what the delta said: anything else rolls back.
      const expected = t.kind === 'label' ? { labelsAdded: add.length, labelsRemoved: remove.length }
        : t.kind === 'relationship' ? { relationshipsCreated: add.length, relationshipsDeleted: remove.length }
          : { propertiesSet: add.length + remove.length };
      const off = Object.entries(expected).filter(([k, v]) => done[k] !== v);
      if (off.length || done.nodesCreated || done.nodesDeleted) {
        throw new Error(`The write did not match its delta (${off.map(([k, v]) => `${k} ${done[k]}, expected ${v}`).join(', ') || 'nodes changed'}): rolled back. Are keys of ${t.on} unique?`);
      }
      await tx.run(`MATCH (l:${LEDGER} {owner: $owner})
        SET l.kind = $kind, l.name = $name, l.on = $on, l.firstRun = coalesce(l.firstRun, $run), l.firstAt = coalesce(l.firstAt, datetime()), l.lastRun = $run, l.lastAt = datetime()
        REMOVE l.lock`, { owner, run, kind: t.kind, name: t.name, on: t.on });
      return { commit: true, ...result, written: true, counters: done, ledger: first ? 'created' : 'updated', ledgerLock: ledgerCounters, metadata: meta };
    }
  }, { metadata: meta });
  }
}

/**
 * Takes over a name whose ledger is gone: creates the ledger of the step, so
 * that the next run computes its delta against what is there. Explicit and
 * confirmed (yes); refuses when the step has a ledger already.
 */
export async function adopt({ writer, target: t, run, yes = false }) {
  const hasConstraint = await ledgerConstraint(writer);
  if (hasConstraint !== true) throw new Error(NEEDS_CONSTRAINT);
  const q = t.kind === 'cypher' ? null : cypherOf({ ...t, scoped: false });
  const [{ n: ledgers }] = await writer.run(`MATCH (l:${LEDGER} {owner: $owner}) RETURN count(l) AS n`, { owner: t.owner });
  if (Number(ledgers) > 0) throw new Error(`${t.owner} has a ledger already: nothing to adopt.`);
  const facts = q ? Number((await writer.run(q.facts, { owner: t.owner, run }))[0].n) : null;
  const what = { owner: t.owner, kind: t.kind, name: t.name, on: t.on, facts };
  if (!yes) return { ...what, adopted: false, message: `${facts ?? 'Some'} existing ${t.name ?? 'facts'} would become ${t.owner}'s: the next run retracts those it does not find. Confirm with --yes.` };
  return writer.transaction(async (tx) => {
    await tx.run(`CREATE (l:${LEDGER} {owner: $owner, kind: $kind, name: $name, on: $on, firstRun: $run, firstAt: datetime(), adoptedAt: datetime()})`, { owner: t.owner, kind: t.kind, name: t.name, on: t.on, run });
    return { commit: true, ...what, adopted: true };
  }, { metadata: { ...txMetadata(t.owner, run), adopt: true } });
}
