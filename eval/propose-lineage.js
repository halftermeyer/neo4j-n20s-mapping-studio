#!/usr/bin/env node
// Evaluates `propose` on the lineage example, with the hand-made mapping as gold.
//
//   node eval/propose-lineage.js [--passes 3] [--conditions full,no-descriptions,gold-nodes]
//                                [--model gemini-2.5-flash] [--replay] [--dotenv .env]
//                                [--gold-answers]
//
// Conditions:
//   full             the Aura export as is, descriptions included (normal use)
//   no-descriptions  labels, types, properties and constraints only
//   gold-nodes       node kinds decided by the gold, relationships proposed
//                    (separates relationship errors from inherited node errors)
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
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  propose, acceptAll, compile, project, runOracle, n20sClient, indexTargets, expand,
  geminiProvider, recordingProvider, replayProvider, functionProvider, PROMPT_VERSION,
} from '../src/index.js';
import { openSource, splitStatements, sourceValues } from '../src/node.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.resolve(HERE, '../examples/lineage');
const read = (f) => fs.readFileSync(path.join(EXAMPLE, f), 'utf8');

const { values: opt } = parseArgs({
  options: {
    passes: { type: 'string', default: '3' },
    conditions: { type: 'string', default: 'full,no-descriptions,gold-nodes' },
    model: { type: 'string', default: 'gemini-2.5-flash' },
    replay: { type: 'boolean', default: false },
    dotenv: { type: 'string' },
    'gold-answers': { type: 'boolean', default: false },
  },
});
if (opt['gold-answers']) opt.model = 'gold-answers';
if (opt.dotenv) process.loadEnvFile(opt.dotenv);

const gold = YAML.parse(read('lineage-prov.aura.mapping.yaml'));
const lpgDoc = JSON.parse(read('aura-export.json'));
const oracle = YAML.parse(read('oracle.aura.yaml'));
const targets = indexTargets([{ namespace: 'http://www.w3.org/ns/prov#', text: read('targets/prov.nq'), format: 'N-Quads' }]);
const P = gold.prefixes;
const iri = (ref) => expand(ref, P).iri ?? ref;

const CONDITIONS = {
  full: { descriptions: true, start: () => ({ ...gold, nodes: {}, relationships: {} }) },
  'no-descriptions': { descriptions: false, start: () => ({ ...gold, nodes: {}, relationships: {} }) },
  'gold-nodes': { descriptions: true, start: () => ({ ...gold, nodes: structuredClone(gold.nodes), relationships: {} }) },
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

function compare(m) {
  return units().map((u) => {
    const g = lookup(gold, u);
    const p = lookup(m, u);
    const confidence = p.meta?.confidence ?? null;
    let outcome;
    let detail = {};
    if (p.decision === 'none') outcome = 'missing';
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
  const g = gold[section][id] ?? {};
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

// Runs ----------------------------------------------------------------------------------
const version = PROMPT_VERSION.replace('/', '-');
const recDir = path.join(HERE, 'recordings', opt.model, version);
const outDir = path.join(HERE, 'results', `${opt.model}-${version}-${new Date().toISOString().slice(0, 10)}`);
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
        mapping: c.start(), lpgDoc, targets, provider, prefix: 'lin', descriptions: c.descriptions,
        valuesOf: withOracle ? sourceValues(source) : null,
      });
      const ms = Date.now() - t0;
      if (!opt.replay && !opt['gold-answers']) fs.writeFileSync(recFile, JSON.stringify(provider.recording, null, 1) + '\n');
      fs.writeFileSync(path.join(outDir, `${condition}-${pass}.mapping.yaml`), YAML.stringify(res.mapping, { lineWidth: 0 }));

      const comparison = compare(res.mapping);
      let oracleResults = null;
      let compileProblems = [];
      if (withOracle) {
        const accepted = acceptAll(res.mapping);
        const { plan, problems } = await compile(accepted, lpgDoc);
        compileProblems = problems;
        const graph = `eval-${condition}-${pass}`;
        await project({ plan, source, n20s, graph });
        oracleResults = (await runOracle({ oracle, mapping: accepted, lpgDoc, source, n20s, graph }))
          .map((r) => ({ id: r.id, status: r.status, ...(r.error ? { error: r.error } : {}), ...(r.status === 'fail' ? { onlyCypher: r.onlyCypher, onlySparql: r.onlySparql, inBoth: r.inBoth } : {}) }));
      }
      const tokens = res.calls.reduce((t, x) => ({ input: t.input + (x.usage?.input ?? 0), output: t.output + (x.usage?.output ?? 0), thinking: t.thinking + (x.usage?.thinking ?? 0) }), { input: 0, output: 0, thinking: 0 });
      runs.push({
        condition, pass, ms, tokens, calls: res.calls.length,
        invalid: res.calls.filter((x) => x.errors.length).map((x) => ({ element: x.element, errors: x.errors })),
        completed: res.completed,
        repaired: res.repaired.map((r) => ({ element: r.element, findings: r.findings, flippedToIgnore: r.before?.decision === 'map' && r.after?.decision !== 'map' })),
        dropped: res.dropped, notes: res.notes,
        check: { summary: res.result.summary, findings: res.result.findings.filter((f) => f.severity !== 'info').map((f) => `${f.severity} ${f.code} ${f.path}`) },
        compileProblems, oracle: oracleResults, comparison,
      });
    }
  }
} finally {
  await source?.close();
  for (const p of procs) p.kill();
}

// Report --------------------------------------------------------------------------------
const report = { model: opt.model, promptVersion: PROMPT_VERSION, date: new Date().toISOString(), withOracle, runs };
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1) + '\n');
fs.writeFileSync(path.join(outDir, 'report.md'), markdown(report));
console.log(markdown(report));
console.error(`Wrote ${outDir}`);

function markdown(rep) {
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
  const lines = [`# propose on lineage: ${rep.model}, prompt ${rep.promptVersion}`, '', `${rep.date}. Gold: examples/lineage/lineage-prov.aura.mapping.yaml.`, ''];
  const byCond = Object.groupBy(rep.runs, (r) => r.condition);
  lines.push('| condition | pass | agree | agree or acceptable | related | different | false map | false ignore | ignore/defer | missing | DEPENDS_ON | check E/W | repaired | completed | dropped | oracle pass | tokens in/out | s |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [cond, rs] of Object.entries(byCond)) {
    for (const r of rs) {
      const cmp = r.comparison.filter((x) => cond !== 'gold-nodes' || x.path.startsWith('relationships/'));
      const n = (o) => cmp.filter((x) => x.outcome === o).length;
      const dep = r.comparison.find((x) => x.path === 'relationships/r:2');
      const orc = r.oracle ? `${r.oracle.filter((x) => x.status === 'pass').length}/${r.oracle.filter((x) => x.status !== 'not-expressible').length}` : '-';
      lines.push(`| ${cond} | ${r.pass} | ${n('agree')}/${cmp.length} (${pct(n('agree'), cmp.length)}) | ${pct(n('agree') + n('acceptable'), cmp.length)} | ${n('related')} | ${n('different')} | ${n('false-map')} | ${n('false-ignore')} | ${n('ignore-vs-defer')} | ${n('missing')} | ${dep.proposed}${dep.proposedTerms ? ` ${dep.proposedTerms}` : ''} | ${r.check.summary.errors}/${r.check.summary.warnings} | ${r.repaired.length} | ${r.completed?.length ?? 0} | ${r.dropped.length} | ${orc} | ${r.tokens.input}/${r.tokens.output + r.tokens.thinking} | ${Math.round(r.ms / 1000)} |`);
    }
  }
  lines.push('', 'Outcomes per decision: agree (same decision, same terms), acceptable (rdfs:label or rdfs:comment on a property the gold leaves out), related (sub/super term), different (other terms), false map (gold leaves it out, the proposal maps it), false ignore (gold maps it, the proposal leaves it out), ignore/defer (both leave it out, differently), missing (no answer). gold-nodes counts relationships only.', '');

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
      if (r.oracle) extra.push(`oracle: ${r.oracle.filter((x) => x.status !== 'pass' && x.status !== 'not-expressible').map((x) => `${x.id} ${x.status}${x.error ? ` (${x.error})` : ''}`).join(', ') || 'all expressible checks pass'}`);
      if (extra.length) lines.push(`Pass ${r.pass}:`, ...extra.map((e) => `- ${e}`), '');
    }
  }
  return lines.join('\n') + '\n';
}
