// End to end, without Neo4j and without a plugin: Relate (relate serve --bolt)
// holds the LPG, n20s-server builds the PROV graph, and the oracle compares
// SPARQL on the projection with Cypher on the LPG.
//
// Skipped unless RELATE_BIN (the relate CLI) and N20S_JAR (n20s-server jar,
// Java 21 on the PATH) are set:
//   RELATE_BIN=~/bin/relate N20S_JAR=.../n20s-server-1.1.0-SNAPSHOT.jar npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import YAML from 'yaml';
import { compile, check, project, compareSources, n20sClient, runOracle, propose, acceptAll, functionProvider } from '../src/index.js';
import { openSource, splitStatements, sourceValues } from '../src/node.js';
import { ROOT, EXAMPLE, baseMapping, baseDoc, prov, lockFor, auraDoc, auraGold, auraBlank, goldAnswer } from './helpers.js';

const { RELATE_BIN, N20S_JAR } = process.env;

function javaMajor() {
  const r = spawnSync('java', ['-version'], { encoding: 'utf8' });
  const m = /version "(\d+)/.exec(r.stderr ?? '');
  return m ? Number(m[1]) : 0;
}
const skip = !RELATE_BIN || !N20S_JAR ? 'set RELATE_BIN and N20S_JAR to run'
  : !fs.existsSync(RELATE_BIN) ? `RELATE_BIN not found: ${RELATE_BIN}`
  : !fs.existsSync(N20S_JAR) ? `N20S_JAR not found: ${N20S_JAR}`
  : javaMajor() < 21 ? 'n20s-server needs Java 21 on the PATH'
  : false;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function waitFor(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { return await fn(); } catch (err) { last = err; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} did not start: ${last?.message}`);
}

const procs = [];
let source;
let n20s;
let boltUrl;
let neo4jPassword;

before(async () => {
  if (skip) return;
  const [bolt, http, n20sPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const password = randomBytes(12).toString('hex');
  neo4jPassword = password;
  boltUrl = `bolt://127.0.0.1:${bolt}`;
  procs.push(spawn(RELATE_BIN, ['serve', '-d', ':memory:', '--bolt', String(bolt), '--http', String(http), '--auth', `neo4j:${password}`], { stdio: 'ignore' }));
  procs.push(spawn('java', ['-jar', N20S_JAR], { env: { ...process.env, PORT: String(n20sPort) }, stdio: 'ignore' }));

  process.env.N20S_SOURCE_USER = 'neo4j';
  process.env.N20S_SOURCE_PASSWORD = password;
  source = openSource(`bolt://127.0.0.1:${bolt}`);
  n20s = n20sClient(`http://127.0.0.1:${n20sPort}`);
  await waitFor(() => source.agent(), 'relate serve');
  await waitFor(() => n20s.version(), 'n20s-server', 60000);

  const seed = fs.readFileSync(path.join(EXAMPLE, 'seed.cypher'), 'utf8');
  for (const statement of splitStatements(seed)) await source.run(statement);
});

after(async () => {
  await source?.close();
  for (const p of procs) p.kill();
});

const oracle = YAML.parse(fs.readFileSync(path.join(EXAMPLE, 'oracle.yaml'), 'utf8'));
const byId = (results) => Object.fromEntries(results.map((r) => [r.id, r]));

test('lineage -> PROV: the projection answers the lineage questions like the LPG', { skip, timeout: 120000 }, async () => {
  assert.match(await source.agent(), /^Relate\//);
  const [{ nodes }] = await source.run('MATCH (n) RETURN count(n) AS nodes');
  assert.equal(nodes, 64);

  const { plan, problems } = await compile(baseMapping, baseDoc);
  assert.deepEqual(problems, []);
  const res = await project({ plan, source, n20s, graph: 'lineage' });
  assert.equal(res.triples, 445);

  const counts = Object.fromEntries((await n20s.query('lineage', 'SELECT ?t (COUNT(?s) AS ?n) WHERE { ?s a ?t } GROUP BY ?t'))
    .map((r) => [r.t.replace('http://www.w3.org/ns/prov#', ''), Number(r.n)]));
  assert.deepEqual(counts, { Entity: 50, Activity: 8, Agent: 6, Usage: 14, Derivation: 18, Generation: 7, Association: 9, Attribution: 8, Invalidation: 1, Plan: 5, Person: 3, SoftwareAgent: 2, Organization: 1 });

  const [time] = await n20s.query('lineage', 'SELECT ?t WHERE { ?s <http://www.w3.org/ns/prov#generatedAtTime> ?t } LIMIT 1');
  assert.match(time.t, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/, 'xsd:dateTime with seconds, no [zone]');

  const results = await runOracle({ oracle, mapping: baseMapping, lpgDoc: baseDoc, source, n20s, graph: 'lineage' });
  for (const r of results) {
    if (['q36-point-in-time', 'q39-runs-per-job-version'].includes(r.id)) assert.equal(r.status, 'not-expressible', r.id);
    else assert.equal(r.status, 'pass', JSON.stringify(r));
  }
  // Every comparison has rows to compare.
  for (const r of results.filter((x) => x.status === 'pass')) assert.ok((r.rows ?? r.cypherRows) > 0, r.id);
});

test('DEPENDS_ON mapped to prov:wasDerivedFrom passes the checks and fails the oracle', { skip, timeout: 120000 }, async () => {
  const wrong = structuredClone(baseMapping);
  wrong.relationships['depends-on'] = { predicate: 'prov:wasDerivedFrom' };

  const structural = await check({ mapping: wrong, lpgDoc: baseDoc, targets: prov, lock: await lockFor(baseDoc) });
  assert.equal(structural.summary.errors, 0, 'the structural checks cannot see the wrong meaning');

  const { plan } = await compile(wrong, baseDoc);
  await project({ plan, source, n20s, graph: 'lineage-wrong' });
  const r = byId(await runOracle({ oracle, mapping: wrong, lpgDoc: baseDoc, source, n20s, graph: 'lineage-wrong' }));
  assert.equal(r['q34-potential-not-asserted'].status, 'fail');
  assert.deepEqual(r['q34-potential-not-asserted'].inBoth, ['["demo:lineage:v2:dsv:ref.dq_rules@2"]']);
  assert.equal(r['q34-asserted-inputs'].status, 'fail');
  assert.equal(r['q33-upstream-asserted-sources'].status, 'fail');
});

test('compare: the same source twice gives the same rows for every unit', { skip, timeout: 60000 }, async () => {
  const { plan } = await compile(baseMapping, baseDoc);
  const res = await compareSources({ plan, a: source, b: source });
  assert.ok(res.every((u) => u.same), JSON.stringify(res.filter((u) => !u.same)));
});

const auraOracle = YAML.parse(fs.readFileSync(path.join(EXAMPLE, 'oracle.aura.yaml'), 'utf8'));
const expectOracle = (results) => {
  for (const r of results) {
    if (['q36-point-in-time', 'q39-runs-per-job-version'].includes(r.id)) assert.equal(r.status, 'not-expressible', r.id);
    else assert.equal(r.status, 'pass', JSON.stringify(r));
  }
};

test('Aura export: the moved gold projects the same graph and passes the moved oracle', { skip, timeout: 120000 }, async () => {
  const { plan, problems } = await compile(auraGold, auraDoc);
  assert.deepEqual(problems, []);
  assert.equal((await project({ plan, source, n20s, graph: 'lineage-aura' })).triples, 445);
  expectOracle(await runOracle({ oracle: auraOracle, mapping: auraGold, lpgDoc: auraDoc, source, n20s, graph: 'lineage-aura' }));
});

test('propose: gold answers, accepted, with generated subjects and value tables from the source, pass the oracle', { skip, timeout: 120000 }, async () => {
  const res = await propose({ mapping: auraBlank(), lpgDoc: auraDoc, targets: prov, provider: functionProvider(goldAnswer(auraGold)), prefix: 'lin', valuesOf: sourceValues(source) });
  assert.equal(res.result.summary.errors, 0);
  assert.deepEqual(res.mapping.relationships['r:0'].properties['p:48'].values, { config: 'lin:role/config', input: 'lin:role/input' }, 'the values of the data: config is in no description, lookup in no row');
  const accepted = acceptAll(res.mapping);
  const { plan, problems } = await compile(accepted, auraDoc);
  assert.deepEqual(problems, []);
  await project({ plan, source, n20s, graph: 'lineage-proposed' });
  expectOracle(await runOracle({ oracle: auraOracle, mapping: accepted, lpgDoc: auraDoc, source, n20s, graph: 'lineage-proposed' }));
});

test('studio: the oracle panel projects the accepted entries and asks the questions', { skip, timeout: 120000 }, async () => {
  const { startStudio } = await import('../src/studio.js');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-studio-e2e-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const studio = await startStudio({
    mappingFile: path.join(dir, 'lineage-prov.aura.mapping.yaml'), port: 0, reviewer: 'test',
    oracleFile: path.join(dir, 'oracle.aura.yaml'), openSource: () => ({ run: (q, p) => source.run(q, p), close: async () => {} }), n20s,
  });
  try {
    const res = await fetch(new URL('/api/oracle', studio.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.triples, 445);
    expectOracle(data.results);
  } finally {
    await studio.close();
  }
});

test('DEPENDS_ON mapped to prov:wasInfluencedBy, or to a qualified Influence alone, passes the wasDerivedFrom check and fails the influence check', { skip, timeout: 120000 }, async () => {
  const variants = {
    'lineage-influence': { predicate: 'prov:wasInfluencedBy' },
    'lineage-influence-qualified': { qualified: { subject: 'lin:influence/{start.p:0}/{end.p:0}', class: 'prov:Influence', link: 'prov:qualifiedInfluence', target: 'prov:influencer' } },
  };
  for (const [graph, entry] of Object.entries(variants)) {
    const wrong = structuredClone(auraGold);
    wrong.relationships['r:2'] = entry;
    const structural = await check({ mapping: wrong, lpgDoc: auraDoc, targets: prov });
    assert.equal(structural.summary.errors, 0, `${graph}: the structural checks let it through`);
    const { plan } = await compile(wrong, auraDoc);
    await project({ plan, source, n20s, graph });
    const r = byId(await runOracle({ oracle: auraOracle, mapping: wrong, lpgDoc: auraDoc, source, n20s, graph }));
    assert.equal(r['q34-potential-not-asserted'].status, 'pass', `${graph}: not a wasDerivedFrom`);
    assert.equal(r['q34-potential-no-influence'].status, 'fail', graph);
    assert.deepEqual(r['q34-potential-no-influence'].inBoth, ['["demo:lineage:v2:dsv:ref.dq_rules@2"]'], graph);
  }
});

test('recipes: ephemeral graphs answer the lineage questions without projecting the graph, then are dropped', { skip, timeout: 120000 }, async () => {
  const { loadRecipe } = await import('../src/node.js');
  const { runRecipe } = await import('../src/recipe.js');
  const run = async (name, params, opts = {}) => {
    const f = await loadRecipe(path.join(EXAMPLE, 'recipes', name));
    const r = await runRecipe({ ...f, params, source, n20s, ...opts });
    assert.ok(r.ok, JSON.stringify(r.steps.filter((s) => s.status !== 'ok')));
    return { r, s: Object.fromEntries(r.steps.map((s) => [s.id, s])) };
  };

  // 1. q33 in a graph of 6 nodes.
  let { r, s } = await run('1-upstream-sources.recipe.yaml');
  assert.equal(s.chain.result.nodes, 6);
  assert.deepEqual([s.chain.state.triples, s.chain.state.delta, s.sources.state.delta], [32, 32, 0], 'the graph after each step');
  assert.deepEqual(s.sources.result.rows.map((x) => x.source).sort(), ['demo:lineage:v2:dsv:raw.customers@7', 'demo:lineage:v2:dsv:raw.orders@42']);
  assert.deepEqual([r.graphs.work.lifecycle, r.graphs.work.kept], ['ephemeral', false]);

  // 2. No influence without the ontology; RDFS with PROV-O gives them. Inspection lists what the graph holds.
  ({ s } = await run('2-influences.recipe.yaml', {}, { inspect: true }));
  assert.deepEqual(s['without-ontology'].result.rows, []);
  assert.deepEqual(s.influences.result.rows.map((x) => `${x.influence_kind} ${x.influence}`).sort(), [
    'DatasetVersion demo:lineage:v2:dsv:stg.customers@5', 'DatasetVersion demo:lineage:v2:dsv:stg.orders@17', 'Run demo:lineage:v2:run:1002']);
  assert.equal(s['prov-o'].state.delta, 1664);
  assert.ok(s.neighbourhood.state.classes.some((c) => c.term === 'prov:Entity' && c.n === 4), JSON.stringify(s.neighbourhood.state.classes));
  assert.equal(s['without-ontology'].state.classes, undefined, 'asking does not change the graph: nothing to inspect');

  // 3. A rule, a shape, a violation decoded to the LPG node, and its derivation.
  ({ s } = await run('3-tainted-versions.recipe.yaml'));
  assert.deepEqual(s.check.result.rows.map((x) => [x.node, x.key]), [['DatasetVersion', 'demo:lineage:v2:dsv:mart.revenue@8']]);
  assert.deepEqual(s.why.result.rows.map((x) => [x.depth, x.kind, x.rule]), [[0, 'derived', 'tainted'], [1, 'asserted', null], [1, 'asserted', null], [1, 'asserted', null]]);
  assert.match(s.why.result.rows[2].fact, /^Run\(demo:lineage:v2:run:989\) prov:used DatasetVersion\(demo:lineage:v2:dsv:stg.orders@16\)$/);

  // 4. SPARQL results become the Cypher parameter of a second scope.
  ({ s } = await run('4-owners-to-notify.recipe.yaml'));
  assert.deepEqual(s['owners-scope'].statements[0].params.versions, ['demo:lineage:v2:dsv:mart.revenue@8']);
  assert.deepEqual(s.owners.result.rows.map((x) => `${x.agent} ${x.role.split('/').pop()}`).sort(), ['Alice owner', 'Data Platform team steward']);
  ({ s } = await run('4-owners-to-notify.recipe.yaml', { name: 'raw.customers' }));
  assert.deepEqual(s.owners.result.rows, []);

  // keep: the ephemeral graph stays, under its run name.
  ({ r } = await run('1-upstream-sources.recipe.yaml', {}, { keep: true }));
  assert.ok((await n20s.list()).some((g) => g.graphName === r.graphs.work.name));
  await n20s.drop(r.graphs.work.name);

  assert.ok(!(await n20s.list()).some((g) => g.graphName.startsWith('recipe-')), 'ephemeral graphs dropped');
});

test('publish: a versioned graph is built, validated, published; a failing gate keeps the previous version; precomputed and hybrid recipes read it', { skip, timeout: 120000 }, async () => {
  const { loadRecipe, recordRecipeRun, publishedResolver, readRegistry, republish, unpublishEndpoint } = await import('../src/node.js');
  const { runRecipe } = await import('../src/recipe.js');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-publish-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const recipes = path.join(dir, 'recipes');
  const run = async (name, edit = (r) => r) => {
    const file = path.join(recipes, name);
    const f = await loadRecipe(file);
    f.recipe = edit(f.recipe);
    const r = await runRecipe({ ...f, source, n20s, resolvePublished: publishedResolver(recipes) });
    const recorded = await recordRecipeRun(file, r, f, { source: { url: 'test' }, n20s });
    return { r, recorded, s: Object.fromEntries(r.steps.map((x) => [x.id, x])) };
  };
  const live = async () => (await n20s.list()).map((g) => g.graphName).filter((n) => n.startsWith('lineage-prov-kg'));

  let { r, recorded, s } = await run('5-lineage-kg.recipe.yaml');
  assert.ok(r.ok, JSON.stringify(r.steps.filter((x) => x.status !== 'ok')));
  assert.deepEqual(s.check.result.conforms, true);
  assert.deepEqual(s.unshape.state.delta, -5, 'the shapes are not published');
  const first = r.publications[0].graph;
  assert.match(first, /^lineage-prov-kg--/);
  assert.deepEqual(recorded.published, ['lineage']);
  assert.deepEqual(await live(), [first]);

  // Precomputed: reads what the endpoint serves, no projection, no reasoning.
  ({ r, s } = await run('6-ask-lineage-kg.recipe.yaml'));
  assert.equal(r.kind, 'precomputed');
  assert.equal(r.graphs.kg.name, first);
  assert.equal(s.influences.result.rows.length, 3);
  // Hybrid: taint scoped on demand, ownership copied from the published graph.
  ({ r, s } = await run('7-owners-hybrid.recipe.yaml'));
  assert.equal(r.kind, 'hybrid');
  assert.deepEqual(s.attributions.result.added, 47);
  assert.deepEqual(s.owners.result.rows.map((x) => x.agent).sort(), ['Alice', 'Data Platform team']);
  assert.equal(r.graphs.work.kept, false);

  // A gate that fails: nothing published, the endpoint keeps serving the first version, the new one goes.
  ({ r, recorded } = await run('5-lineage-kg.recipe.yaml', (rec) => {
    const shapes = rec.steps.find((x) => x.id === 'shapes');
    shapes.turtle = shapes.turtle.replace('$this prov:wasDerivedFrom $this', '$this prov:wasDerivedFrom ?other');
    return rec;
  }));
  assert.equal(r.ok, false);
  assert.match(r.steps.find((x) => x.status === 'error').error, /^Not published: check found \d+ violations/);
  assert.equal((await readRegistry(recipes)).publications.lineage.graph, first);
  assert.deepEqual(await live(), [first]);

  // Re-publish: same recipe, same parameters, a new version swapped in, the old one dropped.
  const again = await republish(recipes, 'lineage', { source: { url: 'test', run: (q, p) => source.run(q, p) }, n20s });
  assert.ok(again.run.ok);
  const second = again.run.publications[0].graph;
  assert.notEqual(second, first);
  assert.deepEqual(again.recorded.dropped, [first]);
  assert.deepEqual(await live(), [second]);

  await unpublishEndpoint(recipes, 'lineage', { n20s });
  assert.deepEqual(await live(), [], 'a version nothing serves is dropped');
  await assert.rejects(run('6-ask-lineage-kg.recipe.yaml'), /Endpoint lineage is not published/);
});

test('follow: a transaction on what a publication is built from rebuilds it and swaps it in (CDC scripted over Relate)', { skip, timeout: 120000 }, async () => {
  const { loadRecipe, recordRecipeRun, publishedResolver, readRegistry } = await import('../src/node.js');
  const { runRecipe } = await import('../src/recipe.js');
  const { startFollowing, syncOnce } = await import('../src/follow.js');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-follow-e2e-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const recipes = path.join(dir, 'recipes');
  const file = path.join(recipes, '5-lineage-kg.recipe.yaml');
  const f = await loadRecipe(file);
  const first = await runRecipe({ ...f, source, n20s, resolvePublished: publishedResolver(recipes) });
  await recordRecipeRun(file, first, f, { source: { url: 'test' }, n20s });
  const served = async () => (await readRegistry(recipes)).publications.lineage.graph;
  const g1 = await served();

  // Relate has no Change Data Capture: the CDC procedures are scripted, the data is real.
  const events = [{ id: 'c0' }];
  const cdc = { ...source, async run(cypher, params) {
    if (/db\.cdc\.current/.test(cypher)) return [{ id: events[events.length - 1].id }];
    if (/db\.cdc\.query/.test(cypher)) return events.slice(events.findIndex((e) => e.id === params.from) + 1);
    return source.run(cypher, params);
  }, system: async () => [{ options: { txLogEnrichment: 'FULL' } }] };
  await startFollowing(recipes, 'lineage', cdc);

  const iri = 'https://example.org/lineage/entity/demo%3Afollow%3Anew';
  const ask = async (g) => (await n20s.query(g, `SELECT ?c WHERE { <${iri}> a ?c }`)).length > 0;
  assert.equal(await ask(g1), false);
  await source.run("CREATE (:Dataset:Entity {id: 'demo:follow:new', name: 'new dataset', createdAt: datetime('2026-11-20T10:00:00Z')})");
  try {
    events.push({ id: 'c1', txId: 42, event: { eventType: 'n', operation: 'c', labels: ['Dataset', 'Entity'] } });
    const [res] = await syncOnce(recipes, { source: cdc, n20s });
    assert.equal(res.changes, 1);
    assert.ok(res.sync.ok, JSON.stringify(res.sync));
    const g2 = await served();
    assert.notEqual(g2, g1, 'a new version is served');
    assert.equal(await ask(g2), true, 'the new dataset is in the published graph');
    assert.ok(!(await n20s.list()).some((g) => g.graphName === g1), 'the previous version is dropped');
    const follow = (await readRegistry(recipes)).follow.lineage;
    assert.equal(follow.cursor, 'c1');
    assert.equal(follow.syncs, 1);
    assert.equal(follow.state, 'idle');
  } finally {
    await source.run("MATCH (n {id: 'demo:follow:new'}) DETACH DELETE n");
  }
});

test('three sources: the taint scoped from Neo4j, owners from the published KG, classification and catalog from a client Fuseki, OWL over all', { skip: skip || (!process.env.FUSEKI_JAR && 'set FUSEKI_JAR to run'), timeout: 180000 }, async () => {
  const { loadRecipe, recordRecipeRun, publishedResolver } = await import('../src/node.js');
  const { runRecipe } = await import('../src/recipe.js');
  const { remoteOf } = await import('../src/remote.js');
  const os = await import('node:os');
  const port = await freePort();
  // FUSEKI_BASE: Fuseki keeps its run files there, not in the working directory.
  const fuseki = spawn('java', ['-jar', process.env.FUSEKI_JAR, '--port', String(port), '--update', '--file', path.join(ROOT, 'demo/client-kg/client.ttl'), '/client'],
    { stdio: 'ignore', env: { ...process.env, FUSEKI_BASE: fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-fuseki-')) } });
  procs.push(fuseki);
  await waitFor(() => fetch(`http://127.0.0.1:${port}/$/ping`).then((r) => { if (!r.ok) throw new Error(); }), 'fuseki', 60000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-mixed-'));
  fs.cpSync(path.join(ROOT, 'demo/project'), dir, { recursive: true });
  const recipes = path.join(dir, 'lineage/recipes');
  // The published lineage KG the recipe reads the owners from.
  const kgFile = path.join(recipes, '5-lineage-kg.recipe.yaml');
  const kg = await loadRecipe(kgFile);
  const built = await runRecipe({ ...kg, source, n20s, resolvePublished: publishedResolver(recipes) });
  assert.ok(built.ok, JSON.stringify(built.steps.filter((x) => x.status !== 'ok')));
  await recordRecipeRun(kgFile, built, kg, { source: { url: 'test' }, n20s });
  const f = await loadRecipe(path.join(recipes, '8-personal-data-alert.recipe.yaml'));
  const env = { CLIENT_KG_SPARQL: `http://127.0.0.1:${port}/client/query` };
  const alert = async (name) => {
    const r = await runRecipe({ ...f, params: { name }, source, n20s, remote: (g) => remoteOf(g, env), resolvePublished: publishedResolver(recipes) });
    assert.ok(r.ok, JSON.stringify(r.steps.filter((x) => x.status !== 'ok')));
    assert.equal(r.steps.find((x) => x.id === 'classification').statements[0].remote, env.CLIENT_KG_SPARQL, 'the trace says where the triples came from');
    return r.steps.find((x) => x.id === 'alert').result.rows;
  };
  assert.deepEqual(await alert('raw.customers'), [], 'nothing tainted downstream of raw.customers yet');
  assert.deepEqual(await alert('raw.orders'), [], 'tainted, but the catalog says it holds amounts only: not personal');
  await source.run("MATCH (v:DatasetVersion {id: 'demo:lineage:v2:dsv:raw.customers@7'}) SET v.invalidatedAt = datetime('2026-11-06T09:30:00Z')");
  try {
    // Nobody tagged stg.customers as personal: OWL classifies it from "holds an email address".
    assert.deepEqual(await alert('raw.customers'), [{ dataset: 'stg.customers', owner: 'Alice', dpo: 'Jane Doe' }]);
    // The client's store changes without us: the next call sees it.
    const res = await fetch(`http://127.0.0.1:${port}/client/update`, { method: 'POST', headers: { 'content-type': 'application/sparql-update' },
      body: 'PREFIX ex: <https://client.example.org/governance#> PREFIX cat: <https://client.example.org/catalog/> INSERT DATA { cat:mart-revenue ex:holds [ a ex:EmailAddress ] }' });
    assert.ok(res.ok);
    assert.deepEqual(await alert('raw.orders'), [{ dataset: 'mart.revenue', owner: 'Alice', dpo: 'Omar Haddad' }]);
  } finally {
    await source.run("MATCH (v:DatasetVersion {id: 'demo:lineage:v2:dsv:raw.customers@7'}) REMOVE v.invalidatedAt");
  }
});

test('serve: /sparql on published endpoints only (SELECT, ASK, CONSTRUCT, read-only), /query APIs lazy, precomputed, hybrid; /run only when allowed', { skip, timeout: 120000 }, async () => {
  const { serveEndpoints } = await import('../src/serve.js');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-serve-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const recipes = path.join(dir, 'recipes');
  const openSrc = () => ({ url: 'test', run: (q, p) => source.run(q, p), close: async () => {} });
  const dev = await serveEndpoints({ recipesDir: recipes, n20s, openSource: openSrc, port: 0, allowRun: true });
  const prod = await serveEndpoints({ recipesDir: recipes, n20s, openSource: openSrc, port: 0 });
  const get = async (server, p, init) => { const r = await fetch(new URL(p, server.url), init); return { status: r.status, headers: r.headers, text: await r.text() }; };
  try {
    assert.deepEqual(JSON.parse((await get(prod, '/sparql')).text).endpoints, [], 'nothing published yet');
    assert.equal((await get(prod, '/run/lineage-kg', { method: 'POST' })).status, 404, '/run is off by default');
    assert.equal((await get(dev, '/run/lineage-kg')).status, 405, 'a run is never a GET');
    assert.equal((await get(dev, '/run/lineage-kg', { method: 'POST', body: '{}' })).status, 415, 'nor a form post');
    let r = await get(dev, '/run/lineage-kg', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 200, r.text);
    const listed = JSON.parse((await get(prod, '/sparql')).text).endpoints;
    assert.deepEqual(listed.map((e) => [e.endpoint, e.status, e.triples]), [['/sparql/lineage', 'stable', 3833]]);

    const q = encodeURIComponent('PREFIX prov: <http://www.w3.org/ns/prov#>\nSELECT ?plan WHERE { ?plan a prov:Plan } ORDER BY ?plan LIMIT 2');
    r = await get(prod, `/sparql/lineage?query=${q}`);
    assert.equal(r.headers.get('content-type'), 'application/sparql-results+json; charset=utf-8');
    assert.equal(r.headers.get('x-n20s-graph-status'), 'stable');
    assert.match(r.headers.get('x-n20s-graph'), /^lineage-prov-kg--/);
    const res = JSON.parse(r.text);
    assert.deepEqual(res.head.vars, ['plan']);
    assert.equal(res.results.bindings[0].plan.type, 'uri');
    r = await get(prod, '/sparql/lineage', { method: 'POST', headers: { 'content-type': 'application/sparql-query' }, body: 'ASK { ?x <http://www.w3.org/ns/prov#wasInfluencedBy> ?y }' });
    assert.deepEqual(JSON.parse(r.text), { head: {}, boolean: true }, 'the materialized closure');
    r = await get(prod, '/sparql/lineage', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `query=${encodeURIComponent('CONSTRUCT { ?s <urn:label> ?l } WHERE { ?s a <http://www.w3.org/ns/prov#Agent> ; <http://www.w3.org/2000/01/rdf-schema#label> ?l } LIMIT 1')}` });
    assert.match(r.text, /^<https:\/\/example\.org\/lineage\/agent\/[^>]+> <urn:label> "[^"]+" \.\n$/);
    r = await get(prod, '/sparql/lineage', { method: 'POST', headers: { 'content-type': 'application/sparql-update' }, body: 'INSERT DATA { <urn:a> <urn:b> <urn:c> }' });
    assert.equal(r.status, 400);
    assert.equal((await get(prod, `/sparql/${JSON.parse((await get(prod, '/sparql')).text).endpoints[0].graph}?query=x`)).status, 404, 'graphs are served by endpoint name only');

    const apis = JSON.parse((await get(prod, '/query')).text).apis;
    assert.deepEqual(apis.map((a) => [a.name, a.kind]).sort(), [['influences', 'precomputed'], ['owners', 'hybrid'], ['owners-to-notify', 'lazy']]);
    r = JSON.parse((await get(prod, '/query/owners-to-notify?name=raw.orders')).text);
    assert.deepEqual([r.kind, r.result.step, r.result.rows.map((x) => x.agent).sort()], ['lazy', 'owners', ['Alice', 'Data Platform team']]);
    r = JSON.parse((await get(prod, '/query/owners', { method: 'POST', body: JSON.stringify({ name: 'raw.customers' }) })).text);
    assert.deepEqual([r.kind, r.result.rows], ['hybrid', []]);
    r = JSON.parse((await get(prod, '/query/influences?version=demo:lineage:v2:dsv:mart.revenue@9')).text);
    assert.deepEqual([r.kind, r.result.columns, r.result.rows.length], ['precomputed', ['influence', 'influence_kind'], 3]);
    assert.equal((await get(prod, '/query/influences?nope=1')).status, 400);
    assert.equal((await get(prod, '/query/nope')).status, 404);

    // The example collection: every request answers as expected, against serve --run (the draft recipe needs /run).
    const { send, benchmark } = await import('../src/bench.js');
    const bench = YAML.parse(fs.readFileSync(path.join(recipes, 'bench.yaml'), 'utf8'));
    for (const item of bench.requests) {
      const res = await send(item, dev.url);
      assert.ok(res.checks.every((c) => c.ok), `${item.id}: ${JSON.stringify(res.checks.filter((c) => !c.ok))}`);
    }
    const draft = await send(bench.requests.find((x) => x.id === 'tainted-draft'), prod.url);
    assert.equal(draft.status, 404, 'a draft recipe is not served without --run');
    const b = await benchmark(bench.requests.find((x) => x.id === 'influences'), prod.url, { iterations: 6, concurrency: 3, warmup: 1 });
    assert.deepEqual([b.stats.count, b.stats.errors], [6, 0]);
    assert.ok(b.stats.p50 > 0 && b.rps > 0);
  } finally {
    await dev.close();
    await prod.close();
    for (const g of await n20s.list()) if (g.graphName.startsWith('lineage-prov-kg')) await n20s.drop(g.graphName);
  }
});

test('introspection: the lineage graph read back from Relate as an LPG ontology the checker accepts', { skip, timeout: 60000 }, async () => {
  const { introspect } = await import('../src/introspect.js');
  const { doc, notes } = await introspect({ run: (q, p) => source.run(q, p), agent: () => source.agent() }, { id: 'lineage-db' });
  assert.equal(Object.keys(doc.nodes).length, 13);
  assert.equal(Object.keys(doc.relationships).length, 17);
  assert.deepEqual(doc.nodes['dataset-version'].labels, { identifier: 'DatasetVersion', implied: ['Entity'] });
  assert.deepEqual(Object.keys(doc.nodes.entity.properties), ['id']);
  assert.ok(Object.values(doc.nodes.entity.constraints).some((c) => c.type === 'UNIQUE' && c.extensions.custom.observed), 'observed uniqueness');
  assert.deepEqual([doc.relationships.used.from.node, doc.relationships.used.to.node, Object.keys(doc.relationships.used.properties)], ['run', 'dataset-version', ['role']]);
  assert.ok(notes.some((n) => /Run is taken to imply Activity/.test(n)));
  const again = await introspect({ run: (q, p) => source.run(q, p) }, { id: 'lineage-db' });
  assert.equal(again.doc.version, doc.version, 'the version follows the structure');
  const res = await check({ mapping: { format: 'n20s-mapping/0.1', id: 'x', lpgOntology: { id: 'lineage-db', version: doc.version }, targets: [], strategy: 'template', prefixes: {}, nodes: {}, relationships: {} }, lpgDoc: doc, targets: null });
  assert.equal(res.summary.errors, 0, JSON.stringify(res.findings.filter((f) => f.severity === 'error')));
});

test('design: a drafted recipe is tried and cross-checked against its direct Cypher answer', { skip, timeout: 60000 }, async () => {
  const { startStudio } = await import('../src/studio.js');
  const { functionProvider } = await import('../src/providers.js');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-draft-e2e-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const provider = () => functionProvider(() => ({ id: 'invalidated-inputs', title: 'Invalidated inputs', params: [],
    cypher: 'MATCH p = (v:DatasetVersion)-[:WAS_GENERATED_BY]->(r:Run)-[:USED]->(i:DatasetVersion) WHERE i.invalidatedAt IS NOT NULL RETURN p',
    sparql: 'SELECT DISTINCT ?version WHERE { ?version prov:wasGeneratedBy ?r . ?r prov:used ?i . ?i prov:invalidatedAtTime ?t }', decode: [{ column: 'version', node: 'n:0' }],
    answerCypher: 'MATCH (v:DatasetVersion)-[:WAS_GENERATED_BY]->(:Run)-[:USED]->(i:DatasetVersion) WHERE i.invalidatedAt IS NOT NULL RETURN DISTINCT v.id AS version', explanation: '.' }), { model: 'test' });
  const studio = await startStudio({ mappingFile: path.join(dir, 'lineage-prov.aura.mapping.yaml'), port: 0, reviewer: 'P', provider, n20s, openSource: () => ({ url: 'test', run: (q, p) => source.run(q, p), close: async () => {} }) });
  const call = async (p, body) => (await (await fetch(new URL(p, studio.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json());
  try {
    await call('/api/design/decide', { action: 'edit', item: { kind: 'question', text: 'Which versions did a run write after reading an invalidated version?' } });
    const d = (await call('/api/design/draft', { id: 'i1' })).drafted;
    assert.deepEqual([d.tried.ok, d.tried.rows, d.tried.compare.agree], [true, 1, true]);
    assert.match(fs.readFileSync(path.join(dir, 'recipes', d.file), 'utf8'), /It agrees with a direct Cypher answer \(1 rows/);
    assert.equal(YAML.parse(fs.readFileSync(path.join(dir, 'recipes', 'bench.yaml'), 'utf8')).requests.at(-1).expect.rows, 1);
  } finally {
    await studio.close();
  }
});

test('write-back: written as a delta, nothing when unchanged, retracted, collision then adopt, parallel runs (Relate)', { skip, timeout: 240000 }, async () => {
  const { loadRecipe, adoptStep, openWriter } = await import('../src/node.js');
  const { runRecipe } = await import('../src/recipe.js');
  const { LEDGER_CONSTRAINT } = await import('../src/writeback.js');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-writeback-'));
  fs.cpSync(path.join(ROOT, 'demo/project'), dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const file = path.join(dir, 'lineage/recipes/9-taint-writeback.recipe.yaml');
  const f = await loadRecipe(file);
  const writer = openWriter(boltUrl, { env: { N20S_WRITE_USER: 'neo4j', N20S_WRITE_PASSWORD: neo4jPassword } });
  const incident = "MATCH (v:DatasetVersion {id: 'demo:lineage:v2:dsv:raw.customers@7'}) SET v.invalidatedAt = datetime('2026-11-06T09:30:00Z')";
  const run = (recipe = f.recipe) => runRecipe({ ...f, recipe, source, n20s, writer, allowWrite: true });
  const step = (r, id) => r.steps.find((s) => s.id === id);
  const expected = async () => (await source.run(`MATCH (v:DatasetVersion)-[:WAS_GENERATED_BY]->(:Run)-[:USED]->(i:DatasetVersion)
    WHERE i.invalidatedAt IS NOT NULL RETURN DISTINCT v.id AS v, i.id AS i ORDER BY v, i`)).map((r) => `${r.v} <- ${r.i}`);
  const written = async () => (await source.run('MATCH (v:Tainted)-[r:READS_TAINTED_INPUT]->(i) RETURN v.id AS v, i.id AS i ORDER BY v, i')).map((r) => `${r.v} <- ${r.i}`);
  const tainted = async () => (await source.run('MATCH (v:Tainted) RETURN count(v) AS n'))[0].n;
  const ledgers = async () => source.run('MATCH (l:WriteLedger) RETURN l.owner AS owner, l.firstRun AS firstRun, l.lastRun AS lastRun, l.lock AS lock ORDER BY owner');
  try {
    // No constraint, no write: the administrator creates it, never the tool.
    let r = await run();
    assert.match(step(r, 'mark').error, /CREATE CONSTRAINT write_ledger_owner/);
    await source.run(LEDGER_CONSTRAINT);

    // 1. First run: the delta is everything; provenance on the relationships; one ledger per step.
    r = await run();
    assert.ok(r.ok, JSON.stringify(r.steps.filter((s) => s.status === 'error')));
    const want = await expected();
    assert.ok(want.length > 0, 'stg.orders@16 is invalidated in the seed');
    assert.deepEqual(await written(), want);
    assert.equal(step(r, 'mark').result.added, new Set(want.map((x) => x.split(' <- ')[0])).size);
    assert.equal(step(r, 'link').result.added, want.length);
    assert.equal(step(r, 'link').result.ledger, 'created');
    const [prov] = await source.run('MATCH ()-[r:READS_TAINTED_INPUT]->() RETURN r.createdBy AS by, r.createdAt IS NOT NULL AS at LIMIT 1');
    assert.deepEqual(prov, { by: `taint-writeback/link@${r.runId}`, at: true });
    assert.deepEqual((await ledgers()).map((l) => [l.owner, l.firstRun, l.lastRun, l.lock ?? null]), [['taint-writeback/link', r.runId, r.runId, null], ['taint-writeback/mark', r.runId, r.runId, null]]);
    const first = r.runId;

    // 2. Unchanged: nothing written, the ledger keeps the run that last wrote.
    r = await run();
    assert.ok(r.ok);
    for (const id of ['mark', 'link']) {
      assert.equal(step(r, id).result.written, false);
      assert.ok(Object.values(step(r, id).result.counters).every((v) => v === 0), JSON.stringify(step(r, id).result.counters));
    }
    assert.ok((await ledgers()).every((l) => l.lastRun === first));

    // 3. Another input invalidated: only the new facts are added.
    await source.run(incident);
    r = await run();
    const now = await expected();
    assert.ok(now.length > want.length);
    assert.deepEqual(await written(), now);
    assert.equal(step(r, 'link').result.added, now.length - want.length);
    assert.equal(step(r, 'link').result.removed, 0);

    // 4. The incident is undone: what is no longer true is retracted, on the scoped versions.
    await source.run("MATCH (v:DatasetVersion {id: 'demo:lineage:v2:dsv:raw.customers@7'}) REMOVE v.invalidatedAt");
    r = await run();
    assert.deepEqual(await written(), want);
    assert.equal(step(r, 'link').result.removed, now.length - want.length);

    // retract: all on a partial scope is refused.
    const partial = structuredClone(f.recipe);
    partial.steps.find((s) => s.id === 'lineage').cypher = "MATCH (n) WHERE n:Run OR (n:DatasetVersion AND n.id STARTS WITH 'demo:lineage:v2:dsv:stg.') RETURN n";
    partial.steps.find((s) => s.id === 'mark').retract = 'all';
    r = await run(partial);
    assert.match(step(r, 'mark').error, /retract: all needs a scope that covers every DatasetVersion/);

    // 5. The ledgers are gone, the facts are not: the first run refuses (collision) until adopt.
    await source.run('MATCH (l:WriteLedger) DELETE l');
    r = await run();
    assert.match(step(r, 'mark').error, /Collision: \d+ nodes already carry Tainted.*adopt/);
    const dry = await adoptStep(file, 'mark', { writer });
    assert.equal(dry.adopted, false);
    assert.equal(dry.facts, await tainted());
    await adoptStep(file, 'mark', { writer, yes: true });
    await adoptStep(file, 'link', { writer, yes: true });
    await assert.rejects(adoptStep(file, 'mark', { writer, yes: true }), /has a ledger already/);
    r = await run();
    assert.ok(r.ok, JSON.stringify(r.steps.filter((s) => s.status === 'error')));
    assert.equal(step(r, 'mark').result.written, false, 'adopted: nothing to change');

    // 6. Two runs at once, from scratch: one relationship per pair, one ledger per step.
    await source.run('MATCH (n:Tainted) REMOVE n:Tainted');
    await source.run('MATCH ()-[r:READS_TAINTED_INPUT]->() DELETE r');
    await source.run('MATCH (l:WriteLedger) DELETE l');
    const both = await Promise.all([run(), run()]);
    assert.ok(both.every((x) => x.ok), JSON.stringify(both.map((x) => x.steps.filter((s) => s.status === 'error'))));
    assert.deepEqual(await written(), want, 'no duplicate');
    assert.equal(both.filter((x) => step(x, 'link').result.written).length, 1, 'one wrote, the other found nothing to change');
    assert.deepEqual((await ledgers()).map((l) => l.owner), ['taint-writeback/link', 'taint-writeback/mark']);
  } finally {
    await source.run("MATCH (v:DatasetVersion {id: 'demo:lineage:v2:dsv:raw.customers@7'}) REMOVE v.invalidatedAt");
    await source.run('MATCH (n:Tainted) REMOVE n:Tainted');
    await source.run('MATCH ()-[r:READS_TAINTED_INPUT]->() DELETE r');
    await source.run('MATCH (l:WriteLedger) DELETE l');
    await source.run('DROP CONSTRAINT write_ledger_owner IF EXISTS');
    for (const g of await n20s.list()) if (g.graphName.startsWith('lineage-taint')) await n20s.drop(g.graphName);
    await writer.close();
  }
});

test('write-back: a scope with SET is refused by EXPLAIN; an xsd:dateTime written to a ZONED DATETIME property is unchanged on the second run (Relate)', { skip, timeout: 180000 }, async () => {
  const { loadRecipe, openWriter } = await import('../src/node.js');
  const { runRecipe } = await import('../src/recipe.js');
  const { LEDGER_CONSTRAINT } = await import('../src/writeback.js');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-writeback-prop-'));
  fs.cpSync(path.join(ROOT, 'demo/project'), dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  // An inferred ZONED DATETIME property on DatasetVersion, written by a step since.
  const exportFile = path.join(dir, 'lineage/aura-export.json');
  const doc = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  doc.nodes['n:4'].properties['p:90'] = { type: 'ZONED DATETIME', name: 'taintedSince', extensions: { custom: { inferredBy: { recipe: 'taint-writeback', step: 'since' } } } };
  fs.writeFileSync(exportFile, JSON.stringify(doc, null, 2));
  const file = path.join(dir, 'lineage/recipes/9-taint-writeback.recipe.yaml');
  const recipe = YAML.parse(fs.readFileSync(file, 'utf8'));
  recipe.steps.splice(recipe.steps.findIndex((x) => x.id === 'publish'), 0,
    { id: 'since-q', type: 'query', sparql: 'SELECT ?version (MIN(?at) AS ?since) WHERE { ?version lin:taintedBy ?i . ?i prov:invalidatedAtTime ?at } GROUP BY ?version', decode: { version: 'node:n:4' } },
    { id: 'since', type: 'write', from: 'since-q', property: { node: 'version', set: 'taintedSince', value: 'since', datatype: 'xsd:dateTime' } });
  fs.writeFileSync(file, YAML.stringify(recipe));
  const f = await loadRecipe(file);
  const writer = openWriter(boltUrl, { env: { N20S_WRITE_USER: 'neo4j', N20S_WRITE_PASSWORD: neo4jPassword } });
  const step = (r, id) => r.steps.find((s) => s.id === id);
  const run = (r = f.recipe) => runRecipe({ ...f, recipe: r, source, n20s, writer, allowWrite: true });
  try {
    await source.run(LEDGER_CONSTRAINT);
    // Relate does not enforce read transactions: EXPLAIN does it for the scope.
    const sneaky = structuredClone(f.recipe);
    sneaky.steps[0].cypher = 'MATCH (n:DatasetVersion) SET n.sneaky = true RETURN n';
    let r = await run(sneaky);
    assert.match(step(r, 'lineage').error, /^Not run: a scope step only reads, and this Cypher writes \(EXPLAIN gives query type rw\)/);
    assert.equal((await source.run('MATCH (n:DatasetVersion) WHERE n.sneaky IS NOT NULL RETURN count(n) AS n'))[0].n, 0);

    r = await run();
    assert.ok(r.ok, JSON.stringify(r.steps.filter((s) => s.status === 'error')));
    const since = step(r, 'since').result;
    assert.ok(since.written && since.added > 0, JSON.stringify(since));
    const [v] = await source.run('MATCH (v:DatasetVersion) WHERE v.taintedSince IS NOT NULL RETURN v.taintedSince.year AS year, v.taintedSince = datetime(\'2026-11-06T08:10:00Z\') AS same LIMIT 1');
    assert.deepEqual(v, { year: 2026, same: true }, 'stored as a ZONED DATETIME, not a string');

    r = await run();
    assert.equal(step(r, 'since').result.written, false, JSON.stringify(step(r, 'since').result));
    assert.ok(Object.values(step(r, 'since').result.counters).every((x) => x === 0));
  } finally {
    await source.run('MATCH (n:DatasetVersion) REMOVE n.taintedSince, n.sneaky');
    await source.run('MATCH (n:Tainted) REMOVE n:Tainted');
    await source.run('MATCH ()-[r:READS_TAINTED_INPUT]->() DELETE r');
    await source.run('MATCH (l:WriteLedger) DELETE l');
    await source.run('DROP CONSTRAINT write_ledger_owner IF EXISTS');
    for (const g of await n20s.list()) if (g.graphName.startsWith('lineage-taint')) await n20s.drop(g.graphName);
    await writer.close();
  }
});

test('competency question as a validated oracle check: suggested cases, tried, validated, run, covering USED; kept failing, it puts USED in doubt', { skip, timeout: 120000 }, async () => {
  const { startStudio } = await import('../src/studio.js');
  const { functionProvider } = await import('../src/providers.js');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-cq-e2e-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const provider = () => functionProvider(() => ({ id: 'run-inputs', title: 'Inputs of a run', params: [{ name: 'run', type: 'string', default: 'demo:lineage:v2:run:1002' }],
    cypher: 'MATCH p = (r:Run {id: $run})-[:USED]->(v:DatasetVersion) RETURN p',
    sparql: 'SELECT DISTINCT ?input WHERE { {{n:1|$run}} prov:used ?input }', decode: [{ column: 'input', node: 'n:0' }],
    answerCypher: 'MATCH (:Run {id: $run})-[:USED]->(v:DatasetVersion) RETURN DISTINCT v.id AS input', explanation: '.' }), { model: 'test' });
  const mappingFile = path.join(dir, 'lineage-prov.aura.mapping.yaml');
  const studio = await startStudio({ mappingFile, port: 0, reviewer: 'P', provider, n20s, openSource: () => ({ url: 'test', run: (q, p) => source.run(q, p), close: async () => {} }) });
  const post = async (p, body) => { const r = await fetch(new URL(p, studio.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  const get = async (p) => (await fetch(new URL(p, studio.url))).json();
  try {
    await post('/api/design/decide', { action: 'edit', item: { kind: 'question', text: 'Which versions did a given run read?' } });
    await post('/api/design/draft', { id: 'i1' });
    const q = await post('/api/design/cq', { id: 'i1' });
    assert.match(q.cypher, /RETURN DISTINCT v\.id AS input/);
    assert.equal(q.oracleFile, null, 'no oracle yet');

    // Values where the direct answer is not empty and changes.
    const { cases } = await post('/api/design/cq/suggest', { id: 'i1', cypher: q.cypher });
    assert.ok(cases.length >= 2, JSON.stringify(cases));
    const tried = (await post('/api/design/cq/try', { id: 'i1', cypher: q.cypher, cases })).cases;
    assert.ok(tried.every((t) => t.cypherRows > 0 && t.compare.agree), JSON.stringify(tried));
    const saved = (await post('/api/design/cq/validate', { id: 'i1', cypher: q.cypher, cases, action: 'validate' })).saved;
    assert.deepEqual([saved.id, saved.created], ['cq-i1', true]);
    const oracleFile = path.join(dir, saved.oracleFile);
    const check = YAML.parse(fs.readFileSync(oracleFile, 'utf8')).checks.find((c) => c.id === 'cq-i1');
    assert.equal(check.cases.length, cases.length);
    assert.deepEqual(check.validated.relies.map((r) => r.path), ['relationships/r:0']);

    // Before any run, it covers nothing; after one, it covers USED (drafted from it, accepted).
    let cov = await get('/api/coverage');
    let used = cov.decisions.find((d) => d.path === 'relationships/r:0');
    assert.deepEqual(used.counted, []);
    assert.equal((await post('/api/oracle', { withProposals: false })).results.find((r) => r.id === 'cq-i1').status, 'pass');
    cov = await get('/api/coverage');
    used = cov.decisions.find((d) => d.path === 'relationships/r:0');
    assert.ok(used.counted.includes('cq-i1'), JSON.stringify(used));
    assert.equal(used.covering.find((c) => c.id === 'cq-i1').draftedFrom, true);

    // A direct Cypher that disagrees (generated instead of used): validate is refused; kept failing, the check fails and blames USED.
    const wrong = 'MATCH (:Run {id: $run})<-[:WAS_GENERATED_BY]-(v:DatasetVersion) RETURN DISTINCT v.id AS input';
    const t2 = (await post('/api/design/cq/try', { id: 'i1', cypher: wrong, cases })).cases;
    assert.ok(t2.some((t) => t.compare?.agree === false), JSON.stringify(t2));
    const refused = await post('/api/design/cq/validate', { id: 'i1', cypher: wrong, cases, action: 'validate' });
    assert.equal(refused.status, 400);
    assert.match(refused.error, /redraft the SPARQL, or keep the check failing/);
    assert.equal((await post('/api/design/cq/validate', { id: 'i1', cypher: wrong, cases, action: 'keep-failing' })).saved.kept, true);
    assert.equal((await post('/api/oracle', { withProposals: false })).results.find((r) => r.id === 'cq-i1').status, 'fail');
    used = (await get('/api/coverage')).decisions.find((d) => d.path === 'relationships/r:0');
    assert.ok(used.suspects.includes('cq-i1'), JSON.stringify(used));
  } finally {
    await studio.close();
  }
});

test('design: a draft whose try fails (a Cypher error) is repaired once, with the error', { skip, timeout: 60000 }, async () => {
  const { startStudio } = await import('../src/studio.js');
  const { functionProvider } = await import('../src/providers.js');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-draft-fail-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  const asked = [];
  const answer = (scope) => ({ id: 'invalidated', title: 'Invalidated', params: [], cypher: scope,
    sparql: 'SELECT DISTINCT ?version WHERE { ?version prov:wasInvalidatedBy ?r }', decode: [{ column: 'version', node: 'n:0' }],
    answerCypher: 'MATCH (v:DatasetVersion)-[:WAS_INVALIDATED_BY]->(:Run) RETURN DISTINCT v.id AS version', explanation: '.' });
  const provider = () => functionProvider((req) => { asked.push(req.user); return asked.length === 1
    ? answer('MATCH (v:DatasetVersion) WHERE (v)-[:WAS_INVALIDATED_BY]->(r:Run) RETURN v, r')
    : answer('MATCH p = (v:DatasetVersion)-[:WAS_INVALIDATED_BY]->(:Run) RETURN p'); }, { model: 'test' });
  const studio = await startStudio({ mappingFile: path.join(dir, 'lineage-prov.aura.mapping.yaml'), port: 0, reviewer: 'P', provider, n20s, openSource: () => ({ url: 'test', run: (q, p) => source.run(q, p), close: async () => {} }) });
  const call = async (p, body) => (await (await fetch(new URL(p, studio.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json());
  try {
    await call('/api/design/decide', { action: 'edit', item: { kind: 'question', text: 'Which versions were invalidated?' } });
    const d = (await call('/api/design/draft', { id: 'i1' })).drafted;
    assert.equal(asked.length, 2, 'one repair call');
    assert.match(asked[1], /Running the recipe failed: .*r/);
    assert.deepEqual([d.tried.ok, d.tried.compare.agree], [true, true]);
  } finally {
    await studio.close();
  }
});
