// A remote SPARQL endpoint a recipe reads from: the client's own triple store
// (Fuseki, GraphDB, Neptune, any SPARQL 1.1 Protocol service). Its triples are
// pulled with a CONSTRUCT into the recipe's working graph, next to the triples
// scoped from Neo4j, and reasoned over together. Nothing is ever written to it.
//
// The recipe names the endpoint and the environment variables that hold its
// credentials, never the credentials themselves:
//   graphs:
//     client: { lifecycle: remote, sparql: "${CLIENT_KG_SPARQL}", user: CLIENT_KG_USER, password: CLIENT_KG_PASSWORD }
// Browser-safe: fetch and n3 only.
import { Parser } from 'n3';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const isEnvName = (s) => ENV_NAME.test(String(s ?? ''));

/** The endpoint URL with ${VAR} taken from the environment; a missing variable is an error that names it. */
export function expandUrl(url, env = globalThis.process?.env ?? {}) {
  return String(url).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => {
    if (env[name] === undefined || env[name] === '') throw new Error(`The remote endpoint needs ${name} in the environment.`);
    return env[name];
  });
}

/** A URL as it may be shown or traced: no credentials, no query string. */
export const shownUrl = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return String(url).replace(/\/\/[^@/]*@/, '//'); } };

const escape = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

/** An n3 term in the (s, p, o) convention of n20s: IRIs bare, _:label, literals quoted with their language or datatype. */
function termOf(t, bnode) {
  if (t.termType === 'NamedNode') return t.value;
  if (t.termType === 'BlankNode') return `_:${bnode(t.value)}`;
  if (t.termType === 'Literal') {
    const lex = `"${escape(t.value)}"`;
    if (t.language) return `${lex}@${t.language}`;
    if (t.datatype && t.datatype.value !== XSD_STRING) return `${lex}^^<${t.datatype.value}>`;
    return lex;
  }
  throw new Error(`Unexpected term ${t.termType} from the remote endpoint.`);
}

/**
 * @param {{url: string, user?: string|null, password?: string|null, fetch?: Function, timeoutMs?: number}} o
 * @returns {{url: string, construct: (query: string, o?: {bnodePrefix?: string}) => Promise<Array<{subject: string, predicate: string, object: string}>>}}
 */
export function remoteSparql({ url, user = null, password = null, fetch = globalThis.fetch, timeoutMs = 60000 }) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/n-triples' };
  if (user) headers.authorization = `Basic ${btoa(`${user}:${password ?? ''}`)}`;
  return {
    url: shownUrl(url),
    async construct(query, { bnodePrefix = 'r' } = {}) {
      const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams({ query }).toString(), signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (!res.ok) throw new Error(`${shownUrl(url)} answered ${res.status}: ${text.slice(0, 300)}`);
      // Blank nodes of the remote store keep their identity within one answer, never across answers or with local ones.
      const labels = new Map();
      const bnode = (v) => { if (!labels.has(v)) labels.set(v, `${bnodePrefix}${labels.size}`); return labels.get(v); };
      return new Parser({ format: 'N-Triples' }).parse(text).map((q) => ({ subject: termOf(q.subject, bnode), predicate: termOf(q.predicate, bnode), object: termOf(q.object, bnode) }));
    },
  };
}

/** The client of a remote graph declaration, credentials read from the environment variables it names. */
export function remoteOf(g, env = globalThis.process?.env ?? {}) {
  const read = (name) => {
    if (!name) return null;
    if (env[name] === undefined) throw new Error(`The remote endpoint needs ${name} in the environment.`);
    return env[name];
  };
  return remoteSparql({ url: expandUrl(g.sparql, env), user: read(g.user), password: read(g.password) });
}
