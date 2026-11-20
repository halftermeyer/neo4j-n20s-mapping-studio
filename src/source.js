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
export function parseSourceUrl(url, env = process.env) {
  if (!isSourceUrl(url)) throw new Error(`Not a source URL: ${String(url).replace(/\/\/[^@/]*@/, '//***@')}`);
  const u = new URL(url);
  const aura = env.NEO4J_URI && hostOf(env.NEO4J_URI) === u.hostname
    ? { user: env.NEO4J_USERNAME, password: env.NEO4J_PASSWORD, database: env.NEO4J_DATABASE }
    : {};
  const user = decodeURIComponent(u.username) || aura.user || env.N20S_SOURCE_USER || null;
  const password = decodeURIComponent(u.password) || aura.password || env.N20S_SOURCE_PASSWORD || '';
  const database = u.searchParams.get('database') || aura.database || env.N20S_SOURCE_DATABASE || null;
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
 * @param {{database?: string}} [options] overrides ?database= and the environment
 */
export function openSource(url, { database } = {}) {
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
  const { user, password } = parsed;
  const driver = neo4j.driver(clean, user ? neo4j.auth.basic(user, password) : undefined, { userAgent: 'n20s-mapping/0.1' });
  const db = database ?? parsed.database ?? undefined;
  return {
    url: clean,
    /** Runs a statement. A single `row` column is unwrapped; otherwise each record becomes an object. */
    async run(cypher, params = {}) {
      const res = await driver.executeQuery(cypher, params, db ? { database: db } : {});
      return res.records.map((rec) => (rec.keys.length === 1 && rec.keys[0] === 'row' ? toPlain(rec.get('row')) : toPlain(rec.toObject())));
    },
    async agent() {
      const info = await driver.getServerInfo();
      return info.agent;
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
