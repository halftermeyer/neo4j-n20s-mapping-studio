import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, PLAN_FORMAT, iriEncode, fillTemplate, matchTemplate, takeSnapshot, snapshotSource, SNAPSHOT_FORMAT } from '../src/index.js';
import { splitStatements, parseSourceUrl, defaultSource, temporalToXsd, toPlain } from '../src/node.js';
import neo4j from 'neo4j-driver';
import { baseMapping, baseDoc } from './helpers.js';

const PROV = 'http://www.w3.org/ns/prov#';
const LIN = 'https://example.org/lineage/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

async function compiled(mutate) {
  const m = structuredClone(baseMapping);
  mutate?.(m);
  return compile(m, structuredClone(baseDoc));
}
const unit = (plan, id) => plan.units.find((u) => u.id === id);

test('the lineage mapping compiles to one unit per mapped kind and type, with no problem', async () => {
  const { plan, problems } = await compiled();
  assert.deepEqual(problems, []);
  assert.equal(plan.format, PLAN_FORMAT);
  assert.equal(plan.mapping, 'lineage-prov');
  assert.equal(plan.lpgOntology.version, '3');
  assert.match(plan.lpgOntology.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(plan.units.length, 25);
  // Ignored and deferred relationships give no unit.
  for (const id of ['depends-on', 'has-column', 'has-column-version', 'run-of', 'had-plan']) assert.equal(unit(plan, `relationships/${id}`), undefined, id);
});

test('node units: row query on the identifier label, subject inherited from the base kind', async () => {
  const { plan } = await compiled();
  const run = unit(plan, 'nodes/run');
  assert.equal(run.cypher, 'MATCH (n:`Run`) RETURN {`id`: n.`id`, `startedAt`: n.`startedAt`, `endedAt`: n.`endedAt`} AS row');
  assert.equal(run.templates[0].subject, `${LIN}activity/{id}`);
  assert.deepEqual(run.templates[0].triples[0], { predicate: `${PROV}startedAtTime`, object: '{startedAt}', datatype: 'http://www.w3.org/2001/XMLSchema#dateTime' });
  const entity = unit(plan, 'nodes/entity');
  assert.deepEqual(entity.templates[0].triples, [{ predicate: RDF_TYPE, object: `${PROV}Entity`, kind: 'iri' }]);
});

test('relationship units: direct triple, qualified pattern and value table', async () => {
  const { plan } = await compiled();
  const u = unit(plan, 'relationships/was-associated-with');
  assert.equal(u.cypher, 'MATCH (s:`Run`)-[r:`WAS_ASSOCIATED_WITH`]->(t:`Agent`) RETURN {_start: {`id`: s.`id`}, _end: {`id`: t.`id`}, `role`: r.`role`} AS row');
  const [main, qualified] = u.templates;
  assert.equal(main.subject, `${LIN}activity/{_start.id}`);
  assert.deepEqual(main.triples.map((t) => t.predicate), [`${PROV}wasAssociatedWith`, `${PROV}qualifiedAssociation`]);
  assert.equal(qualified.subject, `${LIN}association/{_start.id}/{_end.id}`);
  const role = qualified.triples.find((t) => t.predicate === `${PROV}hadRole`);
  assert.deepEqual(role.object, { from: 'role', map: { executor: `${LIN}role/executor`, triggeredBy: `${LIN}role/triggeredBy` } });
  assert.equal(role.kind, 'iri');
});

test('direction reverse swaps subject and object', async () => {
  const { plan } = await compiled((m) => { m.relationships['acted-on-behalf-of'].direction = 'reverse'; });
  const t = unit(plan, 'relationships/acted-on-behalf-of').templates[0];
  assert.equal(t.subject, `${LIN}agent/{_end.id}`);
  assert.equal(t.triples[0].object, `${LIN}agent/{_start.id}`);
});

test('proposed entries are not compiled; rejected ones count as absent', async () => {
  const { plan } = await compiled((m) => {
    m.relationships['was-informed-by'].meta = { status: 'proposed' };
    m.nodes.run.properties.endedAt.meta = { status: 'rejected' };
  });
  assert.equal(unit(plan, 'relationships/was-informed-by'), undefined);
  assert.ok(!unit(plan, 'nodes/run').cypher.includes('endedAt'));
});

test('kind iri without a value table: the value is the IRI (one whole placeholder)', async () => {
  const { plan, problems } = await compiled((m) => { m.nodes.dataset.properties.namespace = { predicate: 'rdfs:seeAlso', kind: 'iri' }; });
  assert.deepEqual(problems, []);
  const t = unit(plan, 'nodes/dataset').templates.flatMap((x) => x.triples).find((x) => x.predicate.endsWith('seeAlso'));
  assert.equal(t.kind, 'iri');
  assert.match(t.object, /^\{[^{}]+\}$/);
});

test('canonical-bridge is reported: only templates are compiled', async () => {
  const { problems } = await compiled((m) => { m.strategy = 'canonical-bridge'; });
  assert.ok(problems.some((p) => p.code === 'compile.strategy'));
});

test('IRI encoding matches n20s, and templates fill and parse back', () => {
  assert.equal(iriEncode('demo:lineage:v2:dsv:raw.orders@7'), 'demo%3Alineage%3Av2%3Adsv%3Araw.orders%407');
  assert.equal(iriEncode('a b/c~d_é'), 'a%20b%2Fc~d_é');
  const P = { lin: LIN };
  const iri = fillTemplate('lin:usage/{start.id}/{end.id}', { 'start.id': 'run:1/2', 'end.id': 'dsv:x@3' }, P);
  assert.equal(iri, `${LIN}usage/run%3A1%2F2/dsv%3Ax%403`);
  assert.deepEqual(matchTemplate('lin:usage/{start.id}/{end.id}', iri, P), { 'start.id': 'run:1/2', 'end.id': 'dsv:x@3' });
  assert.equal(matchTemplate('lin:entity/{id}', `${LIN}activity/x`, P), null);
  assert.throws(() => fillTemplate('nope:{id}', { id: 1 }, P), /not declared/);
});

test('splitStatements: statements end with ; at end of line, a trailing comment alone is skipped', () => {
  const script = '// header\n\n// 03 nodes\nCREATE (:A {s: "x;y"});\n// 04\nMATCH (a:A)\nSET a.n = 1 ;  \n// trailing comment only\n';
  assert.deepEqual(splitStatements(script), ['// header\n\n// 03 nodes\nCREATE (:A {s: "x;y"})', '// 04\nMATCH (a:A)\nSET a.n = 1']);
});

test('source URLs: credentials and database from the URL or the environment', () => {
  assert.deepEqual(parseSourceUrl('bolt://neo4j:p%40ss@127.0.0.1:7688', {}), { url: 'bolt://127.0.0.1:7688', user: 'neo4j', password: 'p@ss', database: null });
  assert.deepEqual(
    parseSourceUrl('neo4j+s://abc.databases.neo4j.io?database=lineage', { N20S_SOURCE_USER: 'u', N20S_SOURCE_PASSWORD: 'secret' }),
    { url: 'neo4j+s://abc.databases.neo4j.io', user: 'u', password: 'secret', database: 'lineage' },
  );
  assert.throws(() => parseSourceUrl('not a url', {}), /Not a source URL/);
});

test('an Aura credentials file applies only to the server it names', () => {
  const env = { NEO4J_URI: 'neo4j+s://abc.databases.neo4j.io', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: 'aura', NEO4J_DATABASE: 'neo4j', N20S_SOURCE_PASSWORD: 'generic' };
  assert.deepEqual(parseSourceUrl('neo4j+s://abc.databases.neo4j.io', env), { url: 'neo4j+s://abc.databases.neo4j.io', user: 'neo4j', password: 'aura', database: 'neo4j' });
  // Another server never gets the Aura password.
  assert.deepEqual(parseSourceUrl('bolt://127.0.0.1:7688', env), { url: 'bolt://127.0.0.1:7688', user: null, password: 'generic', database: null });
  assert.equal(parseSourceUrl('bolt://relate:pw@127.0.0.1:7688', env).password, 'pw');
  assert.equal(defaultSource(env), 'neo4j+s://abc.databases.neo4j.io');
  assert.equal(defaultSource({ ...env, N20S_SOURCE: 'bolt://x' }), 'bolt://x');
});

test('snapshots: record a source, replay it, refuse a query it does not hold', async () => {
  const live = { url: 'bolt://x', run: async (cypher) => [{ q: cypher.length }], agent: async () => 'Neo4j/5', close: async () => {} };
  const { plan } = await compile(baseMapping, baseDoc);
  const oracle = { checks: [{ id: 'a', cypher: 'RETURN 1 AS x' }, { id: 'b', expressible: false }] };
  const snap = await takeSnapshot({ plan, source: live, oracle });
  assert.equal(snap.format, SNAPSHOT_FORMAT);
  assert.equal(snap.queries.length, plan.units.length + 1);
  assert.equal(snap.source.agent, 'Neo4j/5');
  const replay = snapshotSource(JSON.parse(JSON.stringify(snap)), 'snap.json');
  assert.deepEqual(await replay.run('  RETURN 1 AS x\n'), [{ q: 'RETURN 1 AS x'.length }]);
  await assert.rejects(replay.run('RETURN 2'), /does not hold this query/);
  assert.match(await replay.agent(), /^snapshot of Neo4j\/5/);
  assert.throws(() => snapshotSource({ queries: [] }), /not a source snapshot/);
});

test('temporal values become XSD lexical forms (n20s would drop zero seconds)', () => {
  const { DateTime, LocalDateTime, Date: D, Duration } = neo4j.types;
  assert.equal(temporalToXsd(new DateTime(2026, 11, 5, 21, 0, 0, 0, 0)), '2026-11-05T21:00:00Z');
  assert.equal(temporalToXsd(new DateTime(2026, 11, 5, 21, 0, 0, 500000000, 3600)), '2026-11-05T21:00:00.5+01:00');
  assert.equal(temporalToXsd(new LocalDateTime(2026, 1, 2, 3, 4, 5, 0)), '2026-01-02T03:04:05');
  assert.equal(temporalToXsd(new D(2026, 1, 2)), '2026-01-02');
  assert.equal(temporalToXsd(new Duration(0, 1, 30, 0)), 'P0M1DT30S');
  assert.equal(temporalToXsd('2026-01-02'), null);
  assert.deepEqual(toPlain({ n: neo4j.int(3), big: neo4j.int('9007199254740993'), xs: [neo4j.int(1)] }), { n: 3, big: '9007199254740993', xs: [1] });
});
