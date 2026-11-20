// Connections of the studio: the Neo4j source and the AI provider, set from the
// environment at start and changed in the Connections tab. Secrets stay in this
// process, and in the env file when the person asks to save them there: they are
// never sent back to the page and never written to a project file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseSourceUrl, isSourceUrl } from './source.js';
import { PROVIDERS, aiSettingsFromEnv } from './providers.js';

const run = promisify(execFile);

/** Reads KEY=value lines; comments, blank lines and their order are kept for writing back. */
export function parseEnv(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    return m ? { key: m[1], line } : { key: null, line };
  });
}

/**
 * A value as Node's loadEnvFile reads it back: bare when it can be, else in
 * quotes it does not contain (Node has no escapes, except \n in double quotes).
 */
function quote(v) {
  if (/^[\w@%+=:,./-]*$/.test(v)) return v;
  if (!v.includes('\n')) for (const q of ["'", '"', '`']) if (!v.includes(q)) return `${q}${v}${q}`;
  if (!v.includes('"')) return `"${v.replace(/\n/g, '\\n')}"`;
  throw new Error('This value cannot be written to an env file (quotes and line breaks).');
}

/**
 * Sets variables in an env file, keeping every other line; null removes a
 * variable. The file is readable by its owner only.
 */
export async function writeEnvFile(file, updates) {
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const lines = parseEnv(text);
  const left = new Map(Object.entries(updates));
  const out = [];
  for (const l of lines) {
    if (l.key && left.has(l.key)) {
      const v = left.get(l.key);
      left.delete(l.key);
      if (v !== null && v !== undefined) out.push(`${l.key}=${quote(String(v))}`);
    } else out.push(l.line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of left) if (v !== null && v !== undefined) out.push(`${k}=${quote(String(v))}`);
  await fs.writeFile(file, out.join('\n') + '\n', { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/**
 * Why secrets must not go to this file, or null: a file git would commit
 * (tracked, or inside a repository and not ignored).
 */
export async function envFileRisk(file) {
  const dir = path.dirname(path.resolve(file));
  try {
    await run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree']);
  } catch {
    return null; // not in a repository, or no git
  }
  try {
    await run('git', ['-C', dir, 'ls-files', '--error-unmatch', path.basename(file)]);
    return `${file} is tracked by git: secrets saved there would be committed.`;
  } catch { /* not tracked */ }
  try {
    await run('git', ['-C', dir, 'check-ignore', '-q', path.basename(file)]);
    return null;
  } catch {
    return `${file} is not ignored by git: add it to .gitignore before saving secrets in it.`;
  }
}

/**
 * The studio's connections.
 * @param {{env?: object, sourceUrl?: string|null, sourceOrigin?: string, model?: string|null, provider?: string|null, n20sUrl?: string|null, envFile?: string|null}} o
 */
export function connectionSettings({ env = process.env, sourceUrl = null, sourceOrigin = 'environment', model = null, provider = null, n20sUrl = null, envFile = null, maskHosts = false, fixedProvider = null } = {}) {
  /** For screen recordings: the first label of a host is not shown (neo4j+s://••••••••.databases.neo4j.io). */
  const mask = (url) => (maskHosts && url ? String(url).replace(/^(\w[\w+.-]*:\/\/)([^.:/]+)/, (m, scheme, host) => (host === 'localhost' || /^\d+$/.test(host) ? m : `${scheme}${'•'.repeat(8)}`)) : url);
  let neo4j = null;
  if (sourceUrl && isSourceUrl(sourceUrl)) {
    const p = parseSourceUrl(sourceUrl, env);
    neo4j = { url: p.url, user: p.user, password: p.password, database: p.database, origin: sourceOrigin };
  } else if (sourceUrl) {
    neo4j = { url: sourceUrl, user: null, password: '', database: null, origin: sourceOrigin, snapshot: true };
  }
  const fromEnv = aiSettingsFromEnv(env, { provider, model });
  let ai = fromEnv ? { ...fromEnv, origin: 'environment' } : null;
  let status = { neo4j: null, ai: null };

  return {
    envFile,
    fixedProvider,
    get neo4j() { return neo4j; },
    get ai() { return ai; },
    n20sUrl,
    /** What the page may see: no password, no key. */
    describe() {
      return {
        // Shown relative: a home directory path says who runs it.
        envFile: envFile ? (path.relative(process.cwd(), envFile) || envFile) : null,
        neo4j: neo4j ? { url: mask(neo4j.url), user: neo4j.user, database: neo4j.database, passwordSet: !!neo4j.password, origin: neo4j.origin, snapshot: !!neo4j.snapshot, status: status.neo4j } : null,
        ai: fixedProvider ? { provider: fixedProvider.name, model: fixedProvider.model, keySet: false, keyVar: null, origin: 'replay', replay: true, status: null }
          : ai ? { provider: ai.provider, model: ai.model, baseUrl: ai.baseUrl, keySet: !!ai.apiKey, keyVar: PROVIDERS[ai.provider].keyVar, origin: ai.origin, status: status.ai } : null,
        n20s: { url: this.n20sUrl },
        providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, keyVar: p.keyVar, model: p.model, baseUrl: p.baseUrl, keyOptional: !!p.keyOptional,
          keySetInEnv: !!env[p.keyVar] })),
      };
    },
    /**
     * New Neo4j settings. An empty password keeps the one known for the same
     * server (set before, in the URL, or in the environment for that host).
     */
    neo4jFrom({ url, user, password, database }) {
      // The page shows a masked URL: given back unchanged, it means the current one.
      if (neo4j && url === mask(neo4j.url)) url = neo4j.url;
      if (!isSourceUrl(url)) throw new Error('A Bolt URL: bolt://, neo4j://, neo4j+s://…');
      const p = parseSourceUrl(url, env);
      const same = neo4j && neo4j.url === p.url;
      const who = user || p.user || (same ? neo4j.user : null);
      // A password known for this server is reused only for the same user.
      const known = (p.user === who && p.password) || (same && neo4j.user === who ? neo4j.password : '');
      return { url: p.url, user: who, password: password || known || '', database: database || p.database || null };
    },
    setNeo4j(next, checked) { neo4j = { ...next, origin: 'studio' }; status.neo4j = { ...checked, at: new Date().toISOString() }; },
    /** New AI settings; an empty key keeps the one known for the same provider. */
    aiFrom({ provider: id, apiKey, model: m, baseUrl }) {
      const p = PROVIDERS[id];
      if (!p) throw new Error(`Unknown AI provider ${id}.`);
      const key = apiKey || (ai?.provider === id ? ai.apiKey : null) || env[p.keyVar] || null;
      return { provider: id, apiKey: key, model: m || p.model, baseUrl: baseUrl || (ai?.provider === id ? ai.baseUrl : null) || p.baseUrl };
    },
    setAi(next, checked) { ai = { ...next, origin: 'studio' }; status.ai = { ...checked, at: new Date().toISOString() }; },
    /** Variables to save for the current settings. */
    envUpdates(which) {
      if (which === 'neo4j' && neo4j) {
        return { N20S_SOURCE: neo4j.url, N20S_SOURCE_USER: neo4j.user || null, N20S_SOURCE_PASSWORD: neo4j.password || null, N20S_SOURCE_DATABASE: neo4j.database || null };
      }
      if (which === 'ai' && ai) {
        const p = PROVIDERS[ai.provider];
        return { N20S_AI_PROVIDER: ai.provider, N20S_AI_MODEL: ai.model, N20S_AI_BASE_URL: ai.baseUrl !== p.baseUrl ? ai.baseUrl : null, ...(ai.apiKey ? { [p.keyVar]: ai.apiKey } : {}) };
      }
      return {};
    },
  };
}
