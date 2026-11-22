#!/usr/bin/env node
// The database side of the demo, on the Neo4j (Aura Enterprise) instance of .env:
//
//   node demo/aura.mjs reset      the starting state: member directory loaded,
//                                 role rdf_partner and user partner, demo changes undone;
//                                 for write-back (recipe 9): the WriteLedger constraint,
//                                 role and user n20s_writer, nothing written back yet
//   node demo/aura.mjs status     what is there
//   node demo/aura.mjs tx <name>  one of the transactions the demo commits (TX below),
//                                 printed as JSON: what it ran and what the database said
//   node demo/aura.mjs teardown   removes the directory, what was written back, the
//                                 roles and the users
//
// Credentials come from .env (NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD). The
// partner's password is generated once and kept in .env as DEMO_PARTNER_PASSWORD;
// the writer's as N20S_WRITE_USER and N20S_WRITE_PASSWORD, which write-back reads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';
import { splitStatements } from '../src/source.js';
import { writeEnvFile, envFileRisk } from '../src/settings.js';
import { LEDGER_CONSTRAINT } from '../src/writeback.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = path.resolve(HERE, '../.env');
process.loadEnvFile(ENV);
const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env;
if (!NEO4J_URI) { console.error('No NEO4J_URI in .env'); process.exit(2); }
const DB = process.env.NEO4J_DATABASE || 'neo4j';

const LINEAGE = "demo:lineage:v2:dsv:raw.customers@7";

/** The transactions the demo commits, as another application would. */
export const TX = {
  // Act 1: a new member joins, knows Ana, joins the Graph Guild: one transaction.
  'leo-joins': {
    app: 'Member portal',
    cypher: `CREATE (leo:Member {id: 'leo', name: 'Leo Rossi', nick: 'leo',
                     email: 'leo@members.example', homepage: 'https://people.example.org/leo', birthday: '09-30'})
WITH leo
MATCH (ana:Member {id: 'ana'}), (g:Group {id: 'graph-guild'})
CREATE (leo)-[:KNOWS]->(ana), (leo)-[:MEMBER_OF]->(g)`,
  },
  // Act 1: another application registers Ana a second time with her email: refused, nothing written.
  'duplicate-ana': {
    app: 'CRM import',
    cypher: `CREATE (:Member {id: 'ana-silva-2', name: 'Ana S.', email: 'ana@members.example'})
WITH 1 AS one
MATCH (ben:Member {id: 'ben'})
SET ben.nick = 'overwritten'`,
  },
  // Act 2: an incident: the raw.customers load of November 5 was corrupt.
  'customers-incident': {
    app: 'Data quality monitor',
    cypher: `MATCH (v:DatasetVersion {id: '${LINEAGE}'})
SET v.invalidatedAt = datetime('2026-11-06T09:30:00Z')`,
  },
};

const UNDO = [
  "MATCH (m:Member) WHERE m.id IN ['leo', 'ana-silva-2'] DETACH DELETE m",
  "MATCH (m:Member {id: 'ben'}) SET m.nick = 'benno'",
  `MATCH (v:DatasetVersion {id: '${LINEAGE}'}) REMOVE v.invalidatedAt`,
  // Nothing written back yet: recipe 9 starts from an empty extension and no ledger.
  'MATCH (n:Tainted) REMOVE n:Tainted',
  'MATCH ()-[r:READS_TAINTED_INPUT]->() DELETE r',
  'MATCH (l:WriteLedger) DELETE l',
];

// The write-back user of recipe 9: what it writes, and nothing else. No right on the schema.
const WRITER = 'n20s_writer';
const WRITER_ROLE = [
  `CREATE ROLE ${WRITER} IF NOT EXISTS`,
  `GRANT ACCESS ON DATABASE \`${DB}\` TO ${WRITER}`,
  // The constraint is checked, never created.
  `GRANT SHOW CONSTRAINT ON DATABASE \`${DB}\` TO ${WRITER}`,
  // Its ledger: one node per write step, locked by each run.
  `GRANT MATCH {*} ON GRAPH \`${DB}\` NODES WriteLedger TO ${WRITER}`,
  `GRANT CREATE ON GRAPH \`${DB}\` NODES WriteLedger TO ${WRITER}`,
  `GRANT SET PROPERTY {*} ON GRAPH \`${DB}\` NODES WriteLedger TO ${WRITER}`,
  // The versions, found by their id: nothing else of them is read.
  `GRANT TRAVERSE ON GRAPH \`${DB}\` NODES DatasetVersion TO ${WRITER}`,
  `GRANT READ {id} ON GRAPH \`${DB}\` NODES DatasetVersion TO ${WRITER}`,
  // The label it infers.
  `GRANT TRAVERSE ON GRAPH \`${DB}\` NODES Tainted TO ${WRITER}`,
  `GRANT SET LABEL Tainted ON GRAPH \`${DB}\` TO ${WRITER}`,
  `GRANT REMOVE LABEL Tainted ON GRAPH \`${DB}\` TO ${WRITER}`,
  // The relationship it infers, and its provenance.
  `GRANT MATCH {createdBy, createdAt} ON GRAPH \`${DB}\` RELATIONSHIPS READS_TAINTED_INPUT TO ${WRITER}`,
  `GRANT CREATE ON GRAPH \`${DB}\` RELATIONSHIPS READS_TAINTED_INPUT TO ${WRITER}`,
  `GRANT DELETE ON GRAPH \`${DB}\` RELATIONSHIPS READS_TAINTED_INPUT TO ${WRITER}`,
  `GRANT SET PROPERTY {createdBy, createdAt} ON GRAPH \`${DB}\` RELATIONSHIPS READS_TAINTED_INPUT TO ${WRITER}`,
];

const ROLE = [
  'CREATE ROLE rdf_partner IF NOT EXISTS',
  `GRANT ACCESS ON DATABASE \`${DB}\` TO rdf_partner`,
  `GRANT MATCH {*} ON GRAPH \`${DB}\` NODES Member, Group TO rdf_partner`,
  `GRANT MATCH {*} ON GRAPH \`${DB}\` RELATIONSHIPS KNOWS, MEMBER_OF TO rdf_partner`,
  // What partners must never read: the database enforces it, for every client.
  `DENY READ {birthday, email} ON GRAPH \`${DB}\` NODES Member TO rdf_partner`,
];

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD), { userAgent: 'n20s-mapping-demo/0.1' });
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (neo4j.isInt(x) ? x.toNumber() : x)));
const run = async (cypher, params = {}, database = DB) => (await driver.executeQuery(cypher, params, { database })).records.map((r) => plain(r.toObject()));

async function partnerPassword() {
  if (process.env.DEMO_PARTNER_PASSWORD) return process.env.DEMO_PARTNER_PASSWORD;
  const risk = await envFileRisk(ENV);
  if (risk) throw new Error(`Cannot keep the partner password: ${risk}`);
  const pw = crypto.randomBytes(18).toString('base64url');
  await writeEnvFile(ENV, { DEMO_PARTNER_PASSWORD: pw });
  return pw;
}

/** The writer's password, generated once, kept in .env with its user name: write-back reads them there. */
async function writerPassword() {
  if (process.env.N20S_WRITE_PASSWORD && process.env.N20S_WRITE_USER === WRITER) return process.env.N20S_WRITE_PASSWORD;
  const risk = await envFileRisk(ENV);
  if (risk) throw new Error(`Cannot keep the writer password: ${risk}`);
  const pw = crypto.randomBytes(18).toString('base64url');
  await writeEnvFile(ENV, { N20S_WRITE_USER: WRITER, N20S_WRITE_PASSWORD: pw });
  return pw;
}

async function reset() {
  // The lineage graph of act 2, once: the example's seed (MERGE, so loading it again changes nothing).
  const [{ n }] = await run('MATCH (e:Entity) RETURN count(e) AS n');
  if (!n) for (const s of splitStatements(fs.readFileSync(path.join(HERE, '../examples/lineage/seed.cypher'), 'utf8'))) await run(s);
  for (const q of UNDO) await run(q);
  for (const s of splitStatements(fs.readFileSync(path.join(HERE, 'data/people.cypher'), 'utf8'))) await run(s);
  for (const q of ROLE) await run(q, {}, 'system');
  const pw = await partnerPassword();
  const users = await run('SHOW USERS YIELD user RETURN collect(user) AS u', {}, 'system');
  if (!users[0].u.includes('partner')) await run('CREATE USER partner SET PASSWORD $pw CHANGE NOT REQUIRED', { pw }, 'system');
  await run('GRANT ROLE rdf_partner TO partner', {}, 'system');
  // Write-back: the schema is the administrator's (this script), never the tool's. The names the writer
  // writes are registered once here (a node created and deleted), so it needs no name-management right.
  await run(LEDGER_CONSTRAINT);
  await run(`CREATE (l:WriteLedger:Tainted {owner: '__names__', kind: '', name: '', on: '', firstRun: '', firstAt: datetime(), lastRun: '', lastAt: datetime(), lock: '', adoptedAt: datetime()})
    -[:READS_TAINTED_INPUT {createdBy: '', createdAt: datetime()}]->(l) WITH l DETACH DELETE l`);
  for (const q of WRITER_ROLE) await run(q, {}, 'system');
  const wpw = await writerPassword();
  // Created once with the password of .env (Neo4j refuses to set a password to the same value again).
  if (!users[0].u.includes(WRITER)) await run(`CREATE USER ${WRITER} SET PASSWORD $pw CHANGE NOT REQUIRED`, { pw: wpw }, 'system');
  await run(`GRANT ROLE ${WRITER} TO ${WRITER}`, {}, 'system');
  await status();
}

async function status() {
  const [m] = await run('MATCH (m:Member) RETURN count(m) AS members');
  const [g] = await run('MATCH (g:Group) RETURN count(g) AS groups');
  const [k] = await run('MATCH (:Member)-[k:KNOWS]->(:Member) RETURN count(k) AS knows');
  const [d] = await run('MATCH (n:Entity) RETURN count(n) AS lineageEntities');
  const [i] = await run(`MATCH (v:DatasetVersion {id: '${LINEAGE}'}) RETURN v.invalidatedAt IS NOT NULL AS customersIncident`);
  const roles = await run("SHOW ROLES YIELD role WHERE role = 'rdf_partner' RETURN count(*) AS n", {}, 'system');
  const users = await run("SHOW USERS YIELD user, roles WHERE user = 'partner' RETURN roles", {}, 'system');
  const writer = await run(`SHOW USERS YIELD user, roles WHERE user = '${WRITER}' RETURN roles`, {}, 'system');
  const [wb] = await run('RETURN COUNT { (:Tainted) } AS tainted, COUNT { ()-[:READS_TAINTED_INPUT]->() } AS links, COUNT { (:WriteLedger) } AS ledgers');
  const [lc] = await run("SHOW CONSTRAINTS YIELD name WHERE name = 'write_ledger_owner' RETURN count(*) AS n");
  let cdc;
  try { await run('CALL db.cdc.current()'); cdc = (await run('SHOW DATABASES YIELD name, options WHERE name = $db RETURN options.txLogEnrichment AS m LIMIT 1', { db: DB }, 'system'))[0]?.m ?? 'on'; } catch (e) { cdc = /not currently enabled/.test(e.message) ? 'OFF' : 'unsupported'; }
  console.log(JSON.stringify({ ...m, ...g, ...k, ...d, ...(i ?? { customersIncident: null }), role: roles[0].n === 1, partner: users[0]?.roles ?? null, writer: writer[0]?.roles ?? null, writeBack: { ...wb, constraint: lc.n === 1 }, cdc }));
}

async function tx(name) {
  const t = TX[name];
  if (!t) throw new Error(`No transaction ${name}: ${Object.keys(TX).join(', ')}`);
  const t0 = Date.now();
  const session = driver.session({ database: DB });
  try {
    const summary = await session.executeWrite(async (w) => (await w.run(t.cypher)).summary);
    const c = summary.counters.updates();
    console.log(JSON.stringify({ name, app: t.app, cypher: t.cypher, committed: true, ms: Date.now() - t0, counters: Object.fromEntries(Object.entries(c).filter(([, v]) => v)) }));
  } catch (err) {
    console.log(JSON.stringify({ name, app: t.app, cypher: t.cypher, committed: false, ms: Date.now() - t0, error: err.gqlStatusDescription ?? err.message.split('\n')[0], code: err.code }));
  } finally {
    await session.close();
  }
}

async function teardown() {
  for (const q of UNDO) await run(q);
  await run('MATCH (n) WHERE n:Member OR n:Group DETACH DELETE n');
  for (const c of ['member_id', 'member_email', 'group_id', 'member_id_exists', 'group_id_exists']) await run(`DROP CONSTRAINT ${c} IF EXISTS`);
  await run('DROP USER partner IF EXISTS', {}, 'system');
  await run('DROP ROLE rdf_partner IF EXISTS', {}, 'system');
  await run(`DROP USER ${WRITER} IF EXISTS`, {}, 'system');
  await run(`DROP ROLE ${WRITER} IF EXISTS`, {}, 'system');
  await run('DROP CONSTRAINT write_ledger_owner IF EXISTS');
  await status();
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'reset') await reset();
  else if (cmd === 'status') await status();
  else if (cmd === 'tx') await tx(arg);
  else if (cmd === 'teardown') await teardown();
  else { console.error('demo/aura.mjs reset | status | tx <name> | teardown'); process.exitCode = 2; }
} finally {
  await driver.close();
}
