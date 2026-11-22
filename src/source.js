// A Cypher source reached over Bolt: Relate (`relate serve --bolt`) or Neo4j / Aura.
// One adapter for both, with the official driver. Values come back as plain
// JSON, temporal values in their XSD lexical form. A path instead of a URL opens
// a source snapshot (see snapshot.js).
import fs from 'node:fs';
import neo4j from 'neo4j-driver';
import { snapshotSource } from './snapshot.js';

const SCHEMES = new Set(['bolt:', 'bolt+s:', 'bolt+ssc:', 'neo4j:', 'neo4j+s:', 'neo4j+ssc:']);

/** True for a Bolt URL (bolt://, neo4j://, neo4j+s://…); anything else is a snapshot path. */
export function isSourceUrl(s) {
  try { return SCHEMES.has(new URL(s).protocol); } catch { return false; }
}

const hostOf = (s) => { try { return new URL(s).hostname; } catch { return null; } };

/** The source used when none is given: N20S_SOURCE, else NEO4J_URI (Aura credentials file). */
export const defaultSource = (env = process.env) => env.N20S_SOURCE || env.NEO4J_URI || null;

/**
 * Splits a source URL into driver URL, credentials and database, in this order:
 * - user:password@ and ?database= in the URL (convenient locally);
 * - NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE, the names of an Aura
 *   credentials file, only for the server NEO4J_URI names, so they are never
 *   sent to another server;
 * - N20S_SOURCE_USER, N20S_SOURCE_PASSWORD, N20S_SOURCE_DATABASE.
 */
export function parseSourceUrl(url, env = process.env, { prefix = 'N20S_SOURCE', own = false } = {}) {
  if (!isSourceUrl(url)) throw new Error(`Not a source URL: ${String(url).replace(/\/\/[^@/]*@/, '//***@')}`);
  const u = new URL(url);
  const aura = env.NEO4J_URI && hostOf(env.NEO4J_URI) === u.hostname
    ? { user: env.NEO4J_USERNAME, password: env.NEO4J_PASSWORD, database: env.NEO4J_DATABASE }
    : {};
  const mine = { user: env[`${prefix}_USER`], password: env[`${prefix}_PASSWORD`], database: env[`${prefix}_DATABASE`] };
  // own: the prefixed variables come before the Aura credentials file (a dedicated writer, not the admin of the file).
  const [first, second] = own && mine.user ? [mine, aura] : [aura, mine];
  const user = decodeURIComponent(u.username) || first.user || second.user || null;
  const password = decodeURIComponent(u.password) || (own && mine.user ? mine.password : first.password ?? second.password) || '';
  const database = u.searchParams.get('database') || first.database || second.database || null;
  u.username = '';
  u.password = '';
  u.searchParams.delete('database');
  return { url: u.toString().replace(/\/$/, ''), user, password, database };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function fraction(nanos) {
  return nanos ? '.' + String(nanos).padStart(9, '0').replace(/0+$/, '') : '';
}
function offset(seconds) {
  if (seconds === 0) return 'Z';
  const sign = seconds < 0 ? '-' : '+';
  const s = Math.abs(seconds);
  return `${sign}${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`;
}
const num = (v) => (neo4j.isInt(v) ? v.toNumber() : Number(v));

/** XSD lexical form of a Neo4j temporal value, or null when the value is not temporal. */
export function temporalToXsd(v) {
  if (neo4j.isDateTime(v)) {
    if (v.timeZoneOffsetSeconds === undefined || v.timeZoneOffsetSeconds === null) {
      // Zone id without a known offset: the instant in UTC.
      const iso = v.toStandardDate().toISOString().slice(0, 19);
      return `${iso}${fraction(num(v.nanosecond))}Z`;
    }
    const date = `${pad(num(v.year), 4)}-${pad(num(v.month))}-${pad(num(v.day))}`;
    const time = `${pad(num(v.hour))}:${pad(num(v.minute))}:${pad(num(v.second))}${fraction(num(v.nanosecond))}`;
    return `${date}T${time}${offset(num(v.timeZoneOffsetSeconds))}`;
  }
  if (neo4j.isLocalDateTime(v)) {
    return `${pad(num(v.year), 4)}-${pad(num(v.month))}-${pad(num(v.day))}T${pad(num(v.hour))}:${pad(num(v.minute))}:${pad(num(v.second))}${fraction(num(v.nanosecond))}`;
  }
  if (neo4j.isDate(v)) return `${pad(num(v.year), 4)}-${pad(num(v.month))}-${pad(num(v.day))}`;
  if (neo4j.isTime(v)) return `${pad(num(v.hour))}:${pad(num(v.minute))}:${pad(num(v.second))}${fraction(num(v.nanosecond))}${offset(num(v.timeZoneOffsetSeconds))}`;
  if (neo4j.isLocalTime(v)) return `${pad(num(v.hour))}:${pad(num(v.minute))}:${pad(num(v.second))}${fraction(num(v.nanosecond))}`;
  if (neo4j.isDuration(v)) return v.toString();
  return null;
}

/** Converts driver values to plain JSON. Nodes and relationships become n20s rows. */
export function toPlain(v) {
  if (v === null || v === undefined) return null;
  if (neo4j.isInt(v)) return v.inSafeRange() ? v.toNumber() : v.toString();
  const t = temporalToXsd(v);
  if (t !== null) return t;
  if (neo4j.isPoint(v)) return v.toString();
  if (neo4j.isNode(v)) return { ...toPlain(v.properties), _labels: [...v.labels], _elementId: v.elementId };
  if (neo4j.isRelationship(v)) return { ...toPlain(v.properties), _type: v.type, _elementId: v.elementId };
  if (neo4j.isPath(v)) return v.segments.flatMap((s, i) => (i === 0 ? [toPlain(s.start)] : []).concat([toPlain(s.relationship), toPlain(s.end)]));
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
  return v;
}

/**
 * @param {string} url bolt://, neo4j://, neo4j+s://… (see parseSourceUrl), or the path of a snapshot file
 * @param {{database?: string, user?: string, password?: string}} [options] override the URL and the environment
 */
export function openSource(url, { database, user: givenUser, password: givenPassword, readOnly = false } = {}) {
  if (!isSourceUrl(url)) {
    let snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(String(url).replace(/^file:(\/\/)?/, ''), 'utf8'));
    } catch (err) {
      throw new Error(`Not a Bolt URL and not a readable snapshot file: ${String(url).replace(/\/\/[^@/]*@/, '//***@')} (${err.message})`);
    }
    return snapshotSource(snapshot, url);
  }
  const parsed = parseSourceUrl(url);
  const clean = parsed.url;
  const user = givenUser ?? parsed.user;
  const password = givenPassword ?? parsed.password;
  const driver = neo4j.driver(clean, user ? neo4j.auth.basic(user, password) : undefined, { userAgent: 'n20s-mapping/0.1' });
  const db = database ?? parsed.database ?? undefined;
  return {
    url: clean,
    /** Runs a statement. A single `row` column is unwrapped; otherwise each record becomes an object. */
    async run(cypher, params = {}) {
      // readOnly: read transactions; Neo4j refuses a write in them, so the source of a recipe can never change the database.
      const res = await driver.executeQuery(cypher, params, { ...(db ? { database: db } : {}), ...(readOnly ? { routing: neo4j.routing.READ } : {}) });
      return res.records.map((rec) => (rec.keys.length === 1 && rec.keys[0] === 'row' ? toPlain(rec.get('row')) : toPlain(rec.toObject())));
    },
    async agent() {
      const info = await driver.getServerInfo();
      return info.agent;
    },
    /** The database this source reads (null: the user's home database). */
    database: db ?? null,
    /** Runs a statement on the system database (database options, users, roles). */
    async system(cypher, params = {}) {
      const res = await driver.executeQuery(cypher, params, { database: 'system' });
      return res.records.map((rec) => toPlain(rec.toObject()));
    },
    close: () => driver.close(),
  };
}

/** A conflict with a concurrent transaction, worth running the transaction again. */
const transient = (err) => neo4j.isRetryableError?.(err) || /write-write conflict|deadlock|TransientError/i.test(`${err?.code ?? ''} ${err?.message ?? ''}`);

/** The write connection: N20S_WRITE (or the given URL), credentials as for a source, N20S_WRITE_* first. */
export const defaultWriter = (env = process.env) => env.N20S_WRITE || null;

/**
 * A connection that writes: reads with run(), writes only through transaction(),
 * whose metadata Neo4j keeps (and change data capture shows).
 * @returns {{url: string, run: Function, transaction: (work: (tx) => Promise<{commit: boolean}>, o?: {metadata?: object}) => Promise<object>, close: Function}}
 */
export function openWriter(url, { env = process.env, user: givenUser, password: givenPassword, database: givenDb } = {}) {
  const parsed = parseSourceUrl(url, env, { prefix: 'N20S_WRITE', own: true });
  const user = givenUser ?? parsed.user;
  const password = givenPassword ?? parsed.password;
  const driver = neo4j.driver(parsed.url, user ? neo4j.auth.basic(user, password) : undefined, { userAgent: 'n20s-mapping/0.1 (write)' });
  const db = givenDb ?? parsed.database ?? undefined;
  const plain = (r) => r.records.map((rec) => toPlain(rec.toObject()));
  return {
    url: parsed.url,
    user,
    async run(cypher, params = {}) { return plain(await driver.executeQuery(cypher, params, { ...(db ? { database: db } : {}), routing: neo4j.routing.READ })); },
    /**
     * work(tx) gets tx.run(cypher, params) -> {rows, counters}; it returns {commit}: false rolls back (nothing written).
     * A transient conflict with a concurrent transaction (a deadlock, or a write-write conflict on servers that
     * refuse rather than wait) runs the whole work again, which reads again what the other one committed.
     */
    async transaction(work, { metadata = {}, attempts = 5 } = {}) {
      for (let attempt = 1; ; attempt += 1) {
        const session = driver.session({ ...(db ? { database: db } : {}), defaultAccessMode: neo4j.session.WRITE });
        let tx = null;
        try {
          tx = await session.beginTransaction({ metadata });
          const out = await work({
            async run(cypher, params = {}) {
              const r = await tx.run(cypher, params);
              return { rows: plain(r), counters: r.summary.counters.updates() };
            },
          });
          if (out?.commit) await tx.commit(); else await tx.rollback();
          return out;
        } catch (err) {
          await tx?.rollback().catch(() => {});
          if (attempt >= attempts || !transient(err)) throw err;
          await new Promise((r) => setTimeout(r, 50 * attempt + Math.random() * 100));
        } finally {
          await session.close();
        }
      }
    },
    close: () => driver.close(),
  };
}

/** Splits a Cypher script: statements end with ; at the end of a line. Comment-only chunks are skipped. */
export function splitStatements(script) {
  return script
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.split('\n').some((l) => l.trim() && !l.trim().startsWith('//')));
}
