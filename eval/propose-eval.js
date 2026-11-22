#!/usr/bin/env node
// Evaluates `propose` on an evaluation set, with a hand-made mapping as gold.
//
//   node eval/propose-eval.js --set examples/sensors [--passes 3]
//                             [--conditions full,no-descriptions,gold-nodes,open-terms]
//                             [--model gemini-2.5-flash] [--replay] [--dotenv .env]
//                             [--gold-answers] [--answers <mapping>] [--fingerprints]
//
// A set is a directory with an eval.yaml manifest:
//   format: n20s-eval-set/0.1
//   id, name, lpg (Aura export), gold (mapping), alternatives (optional: other
//   decisions counted as right), oracle, seed (Cypher), prefix (of generated IRIs),
//   traps (elements to follow in the report, with what should catch them), and
//   frozen: the SHA-256 of the files decided before any model saw the set; the
//   evaluation refuses to run when one of them changed.
//
// Conditions:
//   full             the Aura export as is, descriptions included (normal use)
//   no-descriptions  labels, types, properties and constraints only
//   gold-nodes       node kinds decided by the gold, relationships proposed
//                    (separates relationship errors from inherited node errors)
//   open-terms       as full, without term lists in the answer schema: the model
//                    may invent terms, and the check must catch them
//
// --answers <mapping> answers another mapping instead (alternatives, traps):
// a test of the evaluation, never a result.
// The report records the fingerprints of the set's files and of src/, the
// prompt version and the model. --fingerprints prints them and stops.
//
// Each run starts from the gold header (prefixes, targets) with no entries, so
// the model sees neither the gold decisions nor the oracle. Answers are recorded
// in eval/recordings/<model>/; --replay re-runs from them without a model.
// With RELATE_BIN and N20S_JAR set, each run is also projected (proposals
// accepted in a copy) and checked with the oracle; value tables then use the
// values of the seed data.
//
// --gold-answers replaces the model with one that answers the gold: a check of
// the evaluation itself (everything should agree and the oracle should pass).
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  propose, acceptAll, compile, project, runOracle, n20sClient, indexTargets, expand,
  geminiProvider, recordingProvider, replayProvider, functionProvider, PROMPT_VERSION,
  reviewItems, variantsOf, oracleEvidence, readsRelationship, indexLpg,
} from '../src/index.js';
import { openSource, splitStatements, sourceValues, loadFiles } from '../src/node.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const { values: opt } = parseArgs({
  options: {
    set: { type: 'string', default: 'examples/lineage' },
    passes: { type: 'string', default: '3' },
    conditions: { type: 'string', default: 'full,no-descriptions,gold-nodes' },
    model: { type: 'string', default: 'gemini-2.5-flash' },
    replay: { type: 'boolean', default: false },
    dotenv: { type: 'string' },
    'gold-answers': { type: 'boolean', default: false },
    answers: { type: 'string' },
    fingerprints: { type: 'boolean', default: false },
  },
});
if (opt.answers) opt['gold-answers'] = true;
if (opt['gold-answers']) opt.model = opt.answers ? `answers-${path.basename(opt.answers).replace(/\.ya?ml$/, '')}` : 'gold-answers';
if (opt.dotenv) process.loadEnvFile(opt.dotenv);

// The set ------------------------------------------------------------------------------
const SET = path.resolve(ROOT, opt.set);
const read = (f) => fs.readFileSync(path.join(SET, f), 'utf8');
const manifest = YAML.parse(read('eval.yaml'));
if (manifest.format !== 'n20s-eval-set/0.1') throw new Error(`${opt.set}/eval.yaml: expected format n20s-eval-set/0.1.`);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** The fingerprint of a directory: every file, by relative path, in order. */
function treeHash(dir) {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(dir);
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(`${path.relative(dir, f)}\0${sha256(fs.readFileSync(f))}\n`);
  return { sha256: h.digest('hex'), files: files.length };
}
const loaded = await loadFiles(path.join(SET, manifest.gold), { lpg: path.join(SET, manifest.lpg) });
const gold = YAML.parse(read(manifest.gold));
const lpgDoc = loaded.lpgDoc;
const targets = loaded.targets;
const oracle = YAML.parse(read(manifest.oracle));
const alternatives = manifest.alternatives ? YAML.parse(read(manifest.alternatives)).alternatives ?? {} : {};
const setFiles = Object.fromEntries([
  ['lpg', manifest.lpg], ['gold', manifest.gold], ['alternatives', manifest.alternatives], ['oracle', manifest.oracle], ['seed', manifest.seed],
  ...(gold.targets ?? []).map((t, i) => [`target${i ? i + 1 : ''}`, t.location]),
].filter(([, f]) => f).map(([k, f]) => [k, { file: f, sha256: sha256(fs.readFileSync(path.join(SET, f))) }]));
/** The commit the evaluation runs from, and whether the tree differs from it (results and recordings aside). */
function commitOf() {
  try {
    const hash = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const branch = execFileSync('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', '.'], { encoding: 'utf8' }).split('\n').filter((l) => l && !/ (eval\/results|eval\/recordings)\//.test(l));
    return { hash, branch, dirty: dirty.length > 0, changed: dirty.slice(0, 20) };
  } catch { return null; }
}
const fingerprints = { set: manifest.id, files: setFiles, src: treeHash(path.join(ROOT, 'src')), promptVersion: PROMPT_VERSION, model: opt.model, commit: commitOf() };
if (opt.fingerprints) { console.log(JSON.stringify(fingerprints, null, 1)); process.exit(0); }
// Decided before any model saw the set: a change means a new set, not a new run.
for (const [k, want] of Object.entries(manifest.frozen ?? {})) {
  const got = setFiles[k]?.sha256;
  if (got !== want) throw new Error(`${opt.set}: ${k} (${setFiles[k]?.file}) changed since it was frozen (${want.slice(0, 12)}, now ${got?.slice(0, 12)}). Freeze it again only with the person who validated it.`);
}
// --answers <mapping>: a model that answers this mapping instead of the gold (to test the evaluation: alternatives, traps).
const answering = opt.answers ? YAML.parse(fs.readFileSync(path.resolve(opt.answers), 'utf8')) : gold;
const P = gold.prefixes;
const iri = (ref) => expand(ref, P).iri ?? ref;
const PREFIX = manifest.prefix;

const CONDITIONS = {
  full: { descriptions: true, start: () => ({ ...gold, nodes: {}, relationships: {} }) },
  'no-descriptions': { descriptions: false, start: () => ({ ...gold, nodes: {}, relationships: {} }) },
  'gold-nodes': { descriptions: true, start: () => ({ ...gold, nodes: structuredClone(gold.nodes), relationships: {} }) },
  'open-terms': { descriptions: true, openTerms: true, start: () => ({ ...gold, nodes: {}, relationships: {} }) },
};

// Services for the oracle ----------------------------------------------------------
const { RELATE_BIN, N20S_JAR } = process.env;
const procs = [];
let source = null;
let n20s = null;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
async function waitFor(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { return await fn(); } catch (err) { last = err; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} did not start: ${last?.message}`);
}
async function startServices() {
  const [bolt, http, n20sPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const password = randomBytes(12).toString('hex');
  procs.push(spawn(RELATE_BIN, ['serve', '-d', ':memory:', '--bolt', String(bolt), '--http', String(http), '--auth', `neo4j:${password}`], { stdio: 'ignore' }));
  procs.push(spawn('java', ['-jar', N20S_JAR], { env: { ...process.env, PORT: String(n20sPort) }, stdio: 'ignore' }));
  process.env.N20S_SOURCE_USER = 'neo4j';
  process.env.N20S_SOURCE_PASSWORD = password;
  source = openSource(`bolt://127.0.0.1:${bolt}`);
  n20s = n20sClient(`http://127.0.0.1:${n20sPort}`);
  await waitFor(() => source.agent(), 'relate serve');
  await waitFor(() => n20s.version(), 'n20s-server');
  for (const statement of splitStatements(read('seed.cypher'))) await source.run(statement);
}

// Comparison with the gold -----------------------------------------------------------
// Descriptive metadata kept as a label or comment where the gold leaves it out:
// an acceptable variant, not a false map (decided with Pierre, 2026-11-19).
const ANNOTATIONS = ['http://www.w3.org/2000/01/rdf-schema#label', 'http://www.w3.org/2000/01/rdf-schema#comment'];
const decisionOf = (e) => (!e ? 'none' : e.ignore ? (e.ignore.deferred ? 'defer' : 'ignore') : 'map');

/** Every decision of the gold: node kinds, relationship types, and the properties it lists. */
function units() {
  const out = [];
  for (const section of ['nodes', 'relationships']) {
    for (const [id, e] of Object.entries(gold[section])) {
      out.push({ path: `${section}/${id}`, section, id });
      for (const pid of Object.keys(e.properties ?? {})) out.push({ path: `${section}/${id}/properties/${pid}`, section, id, pid });
    }
  }
  return out;
}

function lookup(m, u) {
  const e = m[u.section]?.[u.id];
  if (!u.pid) return { decision: decisionOf(e), entry: e, meta: e?.meta };
  if (e?.ignore) return { decision: decisionOf(e), entry: e, meta: e.meta, viaElement: true };
  const pe = e?.properties?.[u.pid];
  return { decision: decisionOf(pe), entry: pe, meta: pe?.meta };
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const relatedClass = (a, b) => targets.closure(a).has(b) || targets.closure(b).has(a);
const relatedProp = (a, b) => targets.propertyClosure(a).has(b) || targets.propertyClosure(b).has(a);

/** Terms of two mapped entries: exact, related (sub/super term), or different. */
function compareTerms(u, g, p) {
  if (u.section === 'nodes' && !u.pid) {
    const gc = (g.classes ?? []).map(iri);
    const pc = (p.classes ?? []).map(iri);
    if (sameSet(gc, pc)) return { terms: 'exact' };
    const ok = gc.length === pc.length && gc.every((c) => pc.some((x) => relatedClass(c, x)));
    return { terms: ok ? 'related' : 'different', goldTerms: gc.map((c) => shortTerm(c)).join(', ') || '(none)', proposedTerms: pc.map((c) => shortTerm(c)).join(', ') || '(none)' };
  }
  if (u.pid) {
    const gp = iri(g.predicate);
    const pp = iri(p.predicate);
    const kind = (e) => (e.values ? 'values' : e.kind === 'iri' ? 'iri' : 'literal');
    const detail = { goldTerms: `${g.predicate} (${kind(g)})`, proposedTerms: `${p.predicate} (${kind(p)})` };
    if (gp === pp && kind(g) === kind(p)) return { terms: 'exact' };
    if (gp === pp || relatedProp(gp, pp)) return { terms: 'related', ...detail };
    return { terms: 'different', ...detail };
  }
  const sig = (e) => [e.predicate ? iri(e.predicate) : null, e.direction ?? 'forward', e.qualified ? [iri(e.qualified.class), iri(e.qualified.link), iri(e.qualified.target)].join(' ') : null];
  const [gs, ps] = [sig(g), sig(p)];
  const detail = { goldTerms: describeRel(g), proposedTerms: describeRel(p) };
  if (JSON.stringify(gs) === JSON.stringify(ps)) return { terms: 'exact' };
  const predOk = gs[0] === ps[0] || (gs[0] && ps[0] && relatedProp(gs[0], ps[0]));
  return { terms: predOk && gs[1] === ps[1] ? 'related' : 'different', ...detail };
}
const shortTerm = (i) => Object.entries(P).reduce((s, [k, ns]) => (s.startsWith(ns) ? `${k}:${s.slice(ns.length)}` : s), i);
const describeRel = (e) => [e.predicate, e.direction === 'reverse' ? '(reverse)' : '', e.qualified ? `qualified ${e.qualified.class}` : ''].filter(Boolean).join(' ') || '(nothing)';

/** Whether a proposal is one of the alternatives the set lists for this decision. */
function isAlternative(u, p) {
  for (const a of alternatives[u.path] ?? []) {
    const d = decisionOf(a);
    if (d !== p.decision) continue;
    if (d !== 'map') return true;
    if (compareTerms(u, a, p.entry).terms === 'exact') return true;
  }
  return false;
}

function compare(m) {
  return units().map((u) => {
    const g = lookup(gold, u);
    const p = lookup(m, u);
    const confidence = p.meta?.confidence ?? null;
    let outcome;
    let detail = {};
    if (p.decision === 'none') outcome = 'missing';
    else if (!(g.decision === p.decision && (g.decision !== 'map' || compareTerms(u, g.entry, p.entry).terms === 'exact')) && isAlternative(u, p)) outcome = 'alternative';
    else if (g.decision === 'map' && p.decision === 'map') {
      detail = compareTerms(u, g.entry, p.entry);
      outcome = detail.terms === 'exact' ? 'agree' : detail.terms;
    } else if (g.decision === p.decision) outcome = 'agree';
    else if (g.decision !== 'map' && p.decision !== 'map') outcome = 'ignore-vs-defer';
    else if (g.decision !== 'map' && u.pid && ANNOTATIONS.includes(iri(p.entry.predicate)) && !p.entry.values) outcome = 'acceptable';
    else outcome = g.decision === 'map' ? 'false-ignore' : 'false-map';
    if (outcome === 'false-map' || outcome === 'acceptable') detail = { proposedTerms: u.pid ? `${p.entry.predicate}` : (u.section === 'nodes' ? (p.entry.classes ?? []).join(', ') : describeRel(p.entry)) };
    if (outcome === 'false-ignore') detail = { goldTerms: u.pid ? `${g.entry.predicate}` : (u.section === 'nodes' ? (g.entry.classes ?? []).join(', ') : describeRel(g.entry)) };
    return { path: u.path, unit: u.pid ? 'property' : u.section === 'nodes' ? 'node' : 'relationship', gold: g.decision, proposed: p.decision, outcome, confidence, ...detail };
  });
}

function labelOf(p) {
  const [section, id, , pid] = p.split('/');
  if (section === 'nodes') {
    const n = lpgDoc.nodes[id];
    return pid ? `${n.labels.identifier}.${n.properties[pid].name}` : n.labels.identifier;
  }
  const r = lpgDoc.relationships[id];
  return pid ? `${r.type}.${r.properties[pid].name}` : r.type;
}

/** The gold decision for a request, in the answer format of propose. */
function goldAnswer(req) {
  const [section, id] = req.element.split('/');
  const g = answering[section]?.[id] ?? {};
  const dec = (e) => (e?.ignore ? { decision: e.ignore.deferred ? 'defer' : 'ignore', reason: e.ignore.reason } : { decision: 'map' });
  const answer = { ...dec(g), rationale: 'gold', confidence: 1 };
  if (!g.ignore) {
    if (g.classes) answer.classes = g.classes;
    if (g.predicate) answer.predicate = g.predicate;
    if (g.direction) answer.direction = g.direction;
    if (g.qualified) answer.qualified = { class: g.qualified.class, link: g.qualified.link, target: g.qualified.target };
  }
  answer.properties = [];
  for (const pid of req.schema.properties.properties?.items.properties.id.enum ?? []) {
    const pe = g.properties?.[pid];
    const pa = { ...(pe ? dec(pe) : { decision: 'ignore', reason: 'Not in the gold.' }), rationale: 'gold', confidence: 1 };
    if (pe && !pe.ignore) {
      pa.predicate = pe.predicate;
      if (pe.datatype) pa.datatype = pe.datatype;
      if (pe.values) { pa.asIris = true; pa.exampleValues = Object.keys(pe.values); }
    }
    answer.properties.push({ id: pid, ...pa });
  }
  return answer;
}

// Safety net ------------------------------------------------------------------------------
// A wrong decision is neither the gold nor an alternative (nor an acceptable annotation). By severity:
//   false assertion  the RDF says something the source does not (a false map, another term, an extra class);
//   omission         the RDF misses something the gold says (a false ignore, a missing class or qualified form);
//   benign           ignore instead of defer, or a qualified form on top of the gold's predicate.
// The safety net and Accept safe are measured on false assertions and omissions.
const WRONG = new Set(['related', 'different', 'false-map', 'false-ignore', 'ignore-vs-defer', 'missing']);
function severityOf(row, mapping) {
  if (row.outcome === 'ignore-vs-defer') return 'benign';
  if (row.outcome === 'false-ignore' || row.outcome === 'missing') return 'omission';
  if (row.outcome === 'false-map') return 'false assertion';
  const [section, id, , pid] = row.path.split('/');
  const entryIn = (m) => { const e = m[section]?.[id]; return pid ? e?.properties?.[pid] : e; };
  const [g, p] = [entryIn(gold), entryIn(mapping)];
  if (!g || !p) return 'false assertion';
  if (section === 'nodes' && !pid) {
    const [gc, pc] = [(g.classes ?? []).map(iri), (p.classes ?? []).map(iri)];
    if (pc.every((c) => gc.includes(c)) && pc.length < gc.length) return 'omission';
    return 'false assertion';
  }
  if (section === 'relationships' && !pid) {
    const same = iri(g.predicate ?? '') === iri(p.predicate ?? '') && (g.direction ?? 'forward') === (p.direction ?? 'forward') && g.predicate;
    if (same && !g.qualified && p.qualified) return 'benign';
    if (same && g.qualified && !p.qualified) return 'omission';
    return 'false assertion';
  }
  return 'false assertion';
}
const SERIOUS = new Set(['false assertion', 'omission']);
const idx = indexLpg(lpgDoc);
/** Whether the check caught a decision: a finding on the entry itself (an element's own fields, or a property). */
function caughtByCheck(row, findings) {
  const nodeId = row.unit === 'node' ? row.path.split('/')[1] : null;
  // A node kind's own fields, or a domain or range conflict elsewhere that comes from its typing (data.node).
  const own = row.unit === 'property' ? (f) => f.path === row.path || f.path.startsWith(`${row.path}/`)
    : (f) => f.path === row.path || (f.path.startsWith(`${row.path}/`) && !f.path.startsWith(`${row.path}/properties/`)) || (nodeId && f.data?.node === nodeId);
  return findings.filter((f) => f.severity !== 'info' && own(f)).map((f) => f.code);
}
/** The IRIs a decision uses: classes, predicate, qualified class, link and target, value IRIs. */
function termsOf(entry) {
  if (!entry || entry.ignore) return [];
  const out = [...(entry.classes ?? []), entry.predicate, entry.qualified?.class, entry.qualified?.link, entry.qualified?.target, ...Object.values(entry.values ?? {})];
  return out.filter(Boolean).map(iri);
}
/**
 * The failing oracle checks that caught a decision: their Cypher reads the
 * element (a relationship with its ends, a label, a Label.property) and their
 * SPARQL asks about a term of the proposal or of the gold for it. A check that
 * fails for another reason, or that never asks about these terms, is not counted.
 */
function caughtByOracle(row, mapping, evidence) {
  if (!evidence) return [];
  const failing = evidence.checks.filter((c) => c.status === 'fail' || c.status === 'error');
  const [section, id, , pid] = row.path.split('/');
  const node = section === 'nodes' ? idx.nodes.get(id) : null;
  const rel = section === 'relationships' ? idx.rels.get(id) : null;
  const labels = node ? new Set([node.label, ...[...idx.nodes.values()].filter((n) => idx.ancestors(n.id).includes(id)).map((n) => n.label)]) : null;
  const reads = (c) => {
    if (rel && !pid) return readsRelationship(c.reads, lpgDoc, id);
    if (rel) return c.reads.props.includes(`${rel.type}.${rel.props.get(pid)?.name}`);
    if (!pid) return c.reads.labels.some((l) => labels.has(l));
    const name = node.props.get(pid)?.name;
    return [...labels].some((l) => c.reads.props.includes(`${l}.${name}`));
  };
  const entryIn = (m) => { const e = m[section]?.[id]; return pid ? (e?.ignore ? null : e?.properties?.[pid]) : e; };
  const terms = new Set([...termsOf(entryIn(mapping)), ...termsOf(entryIn(gold))]);
  return failing.filter((c) => reads(c) && c.terms.some((t) => terms.has(t))).map((c) => c.id);
}
function safetyNet(comparison, mapping, findings, evidence) {
  return comparison.filter((x) => WRONG.has(x.outcome)).map((x) => {
    const check = caughtByCheck(x, findings);
    const oracle = caughtByOracle(x, mapping, evidence);
    return { path: x.path, label: labelOf(x.path), outcome: x.outcome, severity: severityOf(x, mapping), proposed: x.proposedTerms ?? x.proposed, check, oracle,
      caught: check.length && oracle.length ? 'both' : check.length ? 'check' : oracle.length ? 'oracle' : 'neither' };
  });
}
/** What Accept safe would accept after an oracle run on the proposals, and how much of it is wrong. */
function acceptSafePrecision(run, variants) {
  const items = reviewItems({ mapping: run.mapping, lpgDoc, result: run.result, variants, oracle: run.evidence });
  const wrongAt = new Map(run.comparison.filter((x) => WRONG.has(x.outcome) && SERIOUS.has(severityOf(x, run.mapping))).map((x) => [x.path, x]));
  const safe = items.filter((i) => i.safe);
  const wrong = safe.filter((i) => i.proposed.some((p) => wrongAt.has(p)));
  return { safe: safe.length, entries: safe.reduce((n, i) => n + i.proposed.length, 0), wrong: wrong.length,
    wrongItems: wrong.map((i) => ({ key: i.key, label: i.label, entries: i.proposed.filter((p) => wrongAt.has(p)).map((p) => `${labelOf(p)} ${wrongAt.get(p).outcome}`) })) };
}

// Runs ----------------------------------------------------------------------------------
const version = PROMPT_VERSION.replace('/', '-');
const recDir = path.join(HERE, 'recordings', manifest.id, opt.model, version);
// A replay re-reads recorded answers with the code of now: its report goes next to the run's, never over it.
const outDir = path.join(HERE, 'results', `${manifest.id}-${opt.model}-${version}-${new Date().toISOString().slice(0, 10)}${opt.replay ? '-replay' : ''}`);
fs.mkdirSync(recDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const withOracle = !!(RELATE_BIN && N20S_JAR);
if (withOracle) await startServices();
else console.error('RELATE_BIN and N20S_JAR not set: no oracle, value tables from the model examples.');

const runs = [];
try {
  for (const condition of opt.conditions.split(',')) {
    const c = CONDITIONS[condition];
    if (!c) throw new Error(`Unknown condition ${condition}`);
    for (let pass = 1; pass <= Number(opt.passes); pass++) {
      const recFile = path.join(recDir, `${condition}-${pass}.json`);
      const provider = opt['gold-answers'] ? recordingProvider(functionProvider(goldAnswer, { name: 'gold', model: 'gold-answers' }))
        : opt.replay ? replayProvider(JSON.parse(fs.readFileSync(recFile, 'utf8')))
          : recordingProvider(geminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: opt.model }));
      console.error(`${condition} pass ${pass}`);
      const t0 = Date.now();
      const res = await propose({
        mapping: c.start(), lpgDoc, targets, provider, prefix: PREFIX, descriptions: c.descriptions, openTerms: !!c.openTerms,
        valuesOf: withOracle ? sourceValues(source) : null,
      });
      const ms = Date.now() - t0;
      if (!opt.replay && !opt['gold-answers']) fs.writeFileSync(recFile, JSON.stringify(provider.recording, null, 1) + '\n');
      fs.writeFileSync(path.join(outDir, `${condition}-${pass}.mapping.yaml`), YAML.stringify(res.mapping, { lineWidth: 0 }));

      const comparison = compare(res.mapping);
      let oracleResults = null;
      let compileProblems = [];
      let evidence = null;
      if (withOracle) {
        // The oracle run on the proposals, as the studio does before Accept safe.
        const accepted = acceptAll(res.mapping);
        const { plan, problems } = await compile(accepted, lpgDoc);
        compileProblems = problems;
        const graph = `eval-${condition}-${pass}`;
        await project({ plan, source, n20s, graph });
        const raw = await runOracle({ oracle, mapping: accepted, lpgDoc, source, n20s, graph });
        await n20s.drop(graph).catch(() => {});
        oracleResults = raw.map((r) => ({ id: r.id, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.status === 'fail' ? { onlyCypher: r.onlyCypher, onlySparql: r.onlySparql, inBoth: r.inBoth } : {}) }));
        evidence = oracleEvidence({ oracle, results: raw, mapping: accepted, lpgDoc, plan, withProposals: true });
      }
      const tokens = res.calls.reduce((t, x) => ({ input: t.input + (x.usage?.input ?? 0), output: t.output + (x.usage?.output ?? 0), thinking: t.thinking + (x.usage?.thinking ?? 0) }), { input: 0, output: 0, thinking: 0 });
      runs.push({
        condition, pass, ms, tokens, calls: res.calls.length,
        invalid: res.calls.filter((x) => x.errors.length).map((x) => ({ element: x.element, errors: x.errors })),
        completed: res.completed,
        repaired: res.repaired.map((r) => ({ element: r.element, findings: r.findings, flippedToIgnore: r.before?.decision === 'map' && r.after?.decision !== 'map' })),
        dropped: res.dropped, notes: res.notes,
        check: { summary: res.result.summary, findings: res.result.findings.filter((f) => f.severity !== 'info').map((f) => `${f.severity} ${f.code} ${f.path}`) },
        // What happened to each trap: the decision, and what the check said about it.
        traps: (manifest.traps ?? []).map((t) => {
          const x = comparison.find((y) => y.path === t.path);
          return { path: t.path, label: t.label ?? labelOf(t.path), proposed: x?.proposed, proposedTerms: x?.proposedTerms ?? null, outcome: x?.outcome,
            check: res.result.findings.filter((f) => f.severity !== 'info' && (f.path === t.path || f.path.startsWith(`${t.path}/`))).map((f) => f.code) };
        }),
        compileProblems, oracle: oracleResults, comparison,
        safetyNet: safetyNet(comparison, res.mapping, res.result.findings, evidence),
        // Kept for Accept safe, computed once the passes of the condition are in; not in the report.
        _work: { mapping: res.mapping, result: res.result, evidence, comparison },
      });
    }
    // Accept safe needs the variants of all the passes of the condition.
    const these = runs.filter((r) => r.condition === condition);
    const variants = variantsOf(these.map((r) => r._work.mapping), lpgDoc);
    for (const r of these) r.acceptSafe = r._work.evidence ? acceptSafePrecision(r._work, variants) : null;
  }
  for (const r of runs) delete r._work;
} finally {
  await source?.close();
  for (const p of procs) p.kill();
}

// Report --------------------------------------------------------------------------------
const report = { set: manifest.id, name: manifest.name, model: opt.model, promptVersion: PROMPT_VERSION, date: new Date().toISOString(), fingerprints, withOracle,
  ...(opt.replay ? { replay: `answers replayed from ${path.relative(ROOT, recDir)}` } : {}), runs };
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1) + '\n');
fs.writeFileSync(path.join(outDir, 'report.md'), markdown(report));
console.log(markdown(report));
console.error(`Wrote ${outDir}`);

function markdown(rep) {
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
  const lines = [`# propose on ${rep.name}: ${rep.model}, prompt ${rep.promptVersion}`, '', `${rep.date}.`, '',
    '| fingerprint | file | SHA-256 |', '|---|---|---|',
    ...Object.entries(rep.fingerprints.files).map(([k, f]) => `| ${k} | ${f.file} | \`${f.sha256}\` |`),
    `| src | src/ (${rep.fingerprints.src.files} files) | \`${rep.fingerprints.src.sha256}\` |`, '',
    rep.fingerprints.commit ? `Commit \`${rep.fingerprints.commit.hash}\` on ${rep.fingerprints.commit.branch}${rep.fingerprints.commit.dirty ? `, **with uncommitted changes**: ${rep.fingerprints.commit.changed.join(', ')}` : ', clean'}. Prompt ${rep.promptVersion}, model ${rep.model}.` : `Prompt ${rep.promptVersion}, model ${rep.model}.`, ''];
  if (rep.fingerprints.commit) lines.splice(1, 0, '', `**Commit ${rep.fingerprints.commit.hash.slice(0, 12)}**${rep.fingerprints.commit.dirty ? ' (dirty)' : ''}${rep.replay ? ` — ${rep.replay}` : ''}`);
  const byCond = Object.groupBy(rep.runs, (r) => r.condition);
  lines.push('| condition | pass | agree | agree, alternative or acceptable | alternative | related | different | false map | false ignore | ignore/defer | missing | check E/W | repaired | completed | dropped | oracle pass | tokens in/out | s |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [cond, rs] of Object.entries(byCond)) {
    for (const r of rs) {
      const cmp = r.comparison.filter((x) => cond !== 'gold-nodes' || x.path.startsWith('relationships/'));
      const n = (o) => cmp.filter((x) => x.outcome === o).length;
      const orc = r.oracle ? `${r.oracle.filter((x) => x.status === 'pass').length}/${r.oracle.filter((x) => x.status !== 'not-expressible').length}` : '-';
      lines.push(`| ${cond} | ${r.pass} | ${n('agree')}/${cmp.length} (${pct(n('agree'), cmp.length)}) | ${pct(n('agree') + n('alternative') + n('acceptable'), cmp.length)} | ${n('alternative')} | ${n('related')} | ${n('different')} | ${n('false-map')} | ${n('false-ignore')} | ${n('ignore-vs-defer')} | ${n('missing')} | ${r.check.summary.errors}/${r.check.summary.warnings} | ${r.repaired.length} | ${r.completed?.length ?? 0} | ${r.dropped.length} | ${orc} | ${r.tokens.input}/${r.tokens.output + r.tokens.thinking} | ${Math.round(r.ms / 1000)} |`);
    }
  }
  lines.push('', '### Safety net', '',
    'Wrong decisions (neither gold nor alternative) by severity: false assertions, omissions, benign (ignore instead of defer, a qualified form on top). What caught the false assertions and omissions; Accept safe after an oracle run on the proposals: how many elements it would accept, how many of them hold a false assertion or an omission.', '',
    '| condition | pass | false assertions | omissions | benign | caught by check only | by oracle only | by both | by neither | Accept safe: elements (entries) | of which wrong | precision |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rep.runs) {
    const serious = r.safetyNet.filter((x) => SERIOUS.has(x.severity));
    const c = (k) => serious.filter((x) => x.caught === k).length;
    const sev = (k) => r.safetyNet.filter((x) => x.severity === k).length;
    const a = r.acceptSafe;
    lines.push(`| ${r.condition} | ${r.pass} | ${sev('false assertion')} | ${sev('omission')} | ${sev('benign')} | ${c('check')} | ${c('oracle')} | ${c('both')} | ${c('neither')} | ${a ? `${a.safe} (${a.entries})` : '-'} | ${a ? a.wrong : '-'} | ${a && a.safe ? pct(a.safe - a.wrong, a.safe) : '-'} |`);
  }
  if ((manifest.traps ?? []).length) {
    lines.push('', '### Traps', '', '| condition | pass | trap | expected | proposed | outcome | check |', '|---|---|---|---|---|---|---|');
    for (const r of rep.runs) for (const t of r.traps) {
      const want = (manifest.traps.find((x) => x.path === t.path) ?? {}).expect ?? '';
      lines.push(`| ${r.condition} | ${r.pass} | ${t.label} | ${want} | ${t.proposed}${t.proposedTerms ? ` ${t.proposedTerms}` : ''} | ${t.outcome} | ${t.check.join(', ') || '-'} |`);
    }
  }
  lines.push('', 'Outcomes per decision: agree (same decision, same terms), alternative (a decision the set lists as as good as the gold), acceptable (rdfs:label or rdfs:comment on a property the gold leaves out), related (sub/super term), different (other terms), false map (gold leaves it out, the proposal maps it), false ignore (gold maps it, the proposal leaves it out), ignore/defer (both leave it out, differently), missing (no answer). gold-nodes counts relationships only.', '');

  for (const [cond, rs] of Object.entries(byCond)) {
    lines.push(`## ${cond}`, '');
    // Stability: same decision and terms in every pass.
    const sig = (r, p) => { const x = r.comparison.find((y) => y.path === p); return JSON.stringify([x.proposed, x.proposedTerms ?? null, x.outcome]); };
    const paths = rs[0].comparison.map((x) => x.path);
    if (rs.length > 1) {
      const stable = paths.filter((p) => new Set(rs.map((r) => sig(r, p))).size === 1).length;
      lines.push(`Stability: ${stable}/${paths.length} decisions identical in all ${rs.length} passes.`, '');
    }
    // Calibration.
    const all = rs.flatMap((r) => r.comparison).filter((x) => x.confidence !== null && x.outcome !== 'missing');
    const buckets = [[0, 0.5], [0.5, 0.8], [0.8, 0.95], [0.95, 1.01]];
    lines.push('| confidence | decisions | agree |', '|---|---|---|');
    for (const [lo, hi] of buckets) {
      const b = all.filter((x) => x.confidence >= lo && x.confidence < hi);
      lines.push(`| ${lo}–${Math.min(hi, 1)} | ${b.length} | ${pct(b.filter((x) => x.outcome === 'agree').length, b.length)} |`);
    }
    lines.push('');
    // Disagreements, counted over passes.
    const dis = new Map();
    for (const r of rs) {
      for (const x of r.comparison.filter((y) => y.outcome !== 'agree')) {
        const key = `${x.path}|${x.outcome}|${x.proposed}|${x.proposedTerms ?? ''}`;
        const d = dis.get(key) ?? { ...x, passes: 0 };
        d.passes++;
        dis.set(key, d);
      }
    }
    if (dis.size) {
      lines.push('| element | outcome | gold | proposed | passes |', '|---|---|---|---|---|');
      for (const d of [...dis.values()].sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }))) {
        lines.push(`| ${labelOf(d.path)} | ${d.outcome} | ${d.goldTerms ?? d.gold} | ${d.proposedTerms ?? d.proposed} | ${d.passes}/${rs.length} |`);
      }
      lines.push('');
    }
    for (const r of rs) {
      const extra = [];
      if (r.invalid.length) extra.push(`invalid answers: ${r.invalid.map((x) => `${x.element} (${x.errors.join('; ')})`).join(', ')}`);
      if (r.repaired.length) extra.push(`repaired: ${r.repaired.map((x) => `${labelOf(x.element)} [${x.findings.join(', ')}]${x.flippedToIgnore ? ' map->ignore' : ''}`).join(', ')}`);
      if (r.completed?.length) extra.push(`predicate completed from the qualified form: ${r.completed.map((x) => `${labelOf(x.element)} ${x.predicate}${x.was ? ` (was ${x.was})` : ''}`).join(', ')}`);
      if (r.dropped.length) extra.push(`dropped: ${r.dropped.map((x) => labelOf(x.element)).join(', ')}`);
      if (r.check.findings.length) extra.push(`check: ${r.check.findings.join('; ')}`);
      if (r.compileProblems.length) extra.push(`compile: ${r.compileProblems.map((x) => `${x.code} ${x.path}`).join('; ')}`);
      const missed = r.safetyNet.filter((x) => x.caught === 'neither' && SERIOUS.has(x.severity));
      if (missed.length) extra.push(`false assertions and omissions caught by nothing: ${missed.map((x) => `${x.label} (${x.severity}, ${x.outcome}${x.proposed && x.proposed !== 'map' ? `: ${x.proposed}` : ''})`).join(', ')}`);
      const benign = r.safetyNet.filter((x) => x.severity === 'benign');
      if (benign.length) extra.push(`benign: ${benign.map((x) => `${x.label} (${x.outcome === 'ignore-vs-defer' ? 'ignore vs defer' : 'qualified form on top'})`).join(', ')}`);
      const caught = r.safetyNet.filter((x) => x.caught !== 'neither' && SERIOUS.has(x.severity));
      if (caught.length) extra.push(`wrong and caught: ${caught.map((x) => `${x.label} by ${[...x.check, ...x.oracle].join(', ')}`).join('; ')}`);
      if (r.acceptSafe?.wrong) extra.push(`Accept safe would accept wrong decisions: ${r.acceptSafe.wrongItems.map((x) => `${x.label} [${x.entries.join(', ')}]`).join('; ')}`);
      if (r.oracle) extra.push(`oracle: ${r.oracle.filter((x) => x.status !== 'pass' && x.status !== 'not-expressible').map((x) => `${x.id} ${x.status}${x.error ? ` (${x.error})` : ''}`).join(', ') || 'all expressible checks pass'}`);
      if (extra.length) lines.push(`Pass ${r.pass}:`, ...extra.map((e) => `- ${e}`), '');
    }
  }
  return lines.join('\n') + '\n';
}
