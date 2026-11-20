import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { openaiProvider, anthropicProvider, makeProvider, aiSettingsFromEnv, listModels } from '../src/providers.js';
import { connectionSettings, writeEnvFile, envFileRisk, parseEnv } from '../src/settings.js';
import { startStudio } from '../src/studio.js';
import { EXAMPLE } from './helpers.js';

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const reply = (status, body) => ({ status, ok: status < 300, statusText: '', json: async () => body });

test('openaiProvider: JSON schema answer, then without temperature and with json_object when the server refuses them', async () => {
  const sent = [];
  const answers = [
    reply(400, { error: { message: "Unsupported parameter: 'temperature'" } }),
    reply(400, { error: { message: 'response_format json_schema is not supported' } }),
    reply(200, { model: 'm-1', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
  ];
  const fetch = async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return answers.shift(); };
  const p = openaiProvider({ apiKey: 'k', model: 'm', baseUrl: 'http://x/v1/', fetch });
  const res = await p.complete({ system: 's', user: 'u', schema: SCHEMA });
  assert.deepEqual(res.json, { ok: true });
  assert.deepEqual(res.usage, { input: 7, output: 2, thinking: 0, cached: 0 });
  assert.equal(sent[0].url, 'http://x/v1/chat/completions');
  assert.equal(sent[0].init.headers.authorization, 'Bearer k');
  assert.equal(sent[0].body.response_format.type, 'json_schema');
  assert.equal(sent[0].body.temperature, 0);
  assert.equal(sent[1].body.temperature, undefined);
  assert.equal(sent[2].body.response_format.type, 'json_object');
  assert.match(sent[2].body.messages[1].content, /JSON Schema/);
});

test('anthropicProvider: the answer is the input of the forced answer tool', async () => {
  let body;
  let headers;
  const fetch = async (url, init) => {
    body = JSON.parse(init.body);
    headers = init.headers;
    return reply(200, { model: 'claude-x', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'answer', input: { ok: true } }], usage: { input_tokens: 9, output_tokens: 3 } });
  };
  const res = await anthropicProvider({ apiKey: 'k', model: 'claude-x', fetch }).complete({ system: 's', user: 'u', schema: SCHEMA });
  assert.deepEqual(res.json, { ok: true });
  assert.equal(headers['x-api-key'], 'k');
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'answer' });
  assert.deepEqual(body.tools[0].input_schema, SCHEMA);
  assert.equal(body.system, 's');
});

test('AI settings from the environment: the chosen provider, else the first key set', () => {
  assert.equal(aiSettingsFromEnv({}), null);
  assert.deepEqual(aiSettingsFromEnv({ ANTHROPIC_API_KEY: 'a' }), { provider: 'anthropic', apiKey: 'a', model: 'claude-sonnet-5-5', baseUrl: 'https://api.anthropic.com/v1' });
  assert.equal(aiSettingsFromEnv({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }).provider, 'gemini');
  assert.equal(aiSettingsFromEnv({ GEMINI_API_KEY: 'g', N20S_AI_PROVIDER: 'openai', OPENAI_API_KEY: 'o', N20S_AI_MODEL: 'gpt-x' }).model, 'gpt-x');
  assert.equal(aiSettingsFromEnv({ N20S_AI_PROVIDER: 'openai', N20S_AI_BASE_URL: 'http://localhost:11434/v1', N20S_AI_MODEL: 'llama' }).apiKey, null, 'a local server needs no key');
  assert.throws(() => makeProvider({ provider: 'gemini' }), /GEMINI_API_KEY/);
  assert.throws(() => makeProvider({ provider: 'nope', apiKey: 'x' }), /Unknown AI provider/);
});

test('env file: variables set, replaced and removed, other lines kept, owner-only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# keys\nGEMINI_API_KEY=old\nOTHER=1\nN20S_SOURCE_DATABASE=x\n');
  await writeEnvFile(file, { GEMINI_API_KEY: 'new value "q"', N20S_SOURCE_DATABASE: null, N20S_AI_MODEL: 'gemini-2.5-pro' });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text, '# keys\nGEMINI_API_KEY=\'new value "q"\'\nOTHER=1\nN20S_AI_MODEL=gemini-2.5-pro\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(parseEnv(text).filter((l) => l.key).map((l) => l.key), ['GEMINI_API_KEY', 'OTHER', 'N20S_AI_MODEL']);
  const saved = { ...process.env };
  try {
    process.loadEnvFile(file);
    assert.equal(process.env.GEMINI_API_KEY, 'new value "q"', 'Node reads back what was written');
  } finally {
    for (const k of ['GEMINI_API_KEY', 'OTHER', 'N20S_AI_MODEL']) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; }
  }
});

test('env file risk: refused when git would commit it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-git-'));
  const file = path.join(dir, '.env');
  assert.equal(await envFileRisk(file), null, 'outside a repository');
  execFileSync('git', ['init', '-q', dir]);
  assert.match(await envFileRisk(file), /not ignored/);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  assert.equal(await envFileRisk(file), null);
});

test('connection settings: what the page sees has no password and no key', () => {
  const s = connectionSettings({
    env: { NEO4J_URI: 'neo4j+s://abc.databases.neo4j.io', NEO4J_USERNAME: 'neo4j', NEO4J_PASSWORD: 'secret-pw', GEMINI_API_KEY: 'secret-key' },
    sourceUrl: 'neo4j+s://abc.databases.neo4j.io',
  });
  const seen = JSON.stringify(s.describe());
  assert.ok(!seen.includes('secret'), seen);
  assert.equal(s.describe().neo4j.passwordSet, true);
  assert.equal(s.describe().ai.keySet, true);
  // An empty password keeps the known one for the same server, not for another.
  assert.equal(s.neo4jFrom({ url: 'neo4j+s://abc.databases.neo4j.io', user: '', password: '' }).password, 'secret-pw');
  assert.equal(s.neo4jFrom({ url: 'bolt://127.0.0.1:7687', user: 'neo4j', password: '' }).password, '');
  assert.equal(s.neo4jFrom({ url: 'neo4j+s://abc.databases.neo4j.io', user: 'partner', password: '' }).password, '', 'not the password of another user');
  assert.equal(s.aiFrom({ provider: 'gemini', apiKey: '' }).apiKey, 'secret-key');
});

test('studio Connections: AI settings checked against the provider, saved to an ignored env file, never sent back', async () => {
  // An OpenAI-compatible server, as Ollama or OpenRouter would be.
  const calls = [];
  const fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    calls.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer good-key') { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'bad key' } })); }
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'small' }, { id: 'large' }] }));
    res.end(JSON.stringify({ model: JSON.parse(body).model, choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}/v1`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-conn-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  const envFile = path.join(dir, '.env');
  const settings = connectionSettings({ env: {}, envFile, n20sUrl: 'http://127.0.0.1:9' });
  const studio = await startStudio({ mappingFile: path.join(dir, 'lineage-prov.aura.mapping.yaml'), port: 0, reviewer: 'Pierre', settings });
  const call = async (p, body, headers = { 'content-type': 'application/json' }) => {
    const res = await fetch(new URL(p, studio.url), body === undefined ? {} : { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json(), text: '' };
  };
  try {
    let { data } = await call('/api/settings');
    assert.equal(data.ai, null);
    assert.equal(data.neo4j, null);
    assert.equal(data.n20s.ok, false);
    assert.equal(data.envRisk, null);
    assert.ok(data.providers.some((p) => p.id === 'anthropic'));

    let r = await call('/api/settings/ai/models', { provider: 'openai', apiKey: 'wrong', baseUrl: base });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /bad key/);
    assert.ok(!r.data.error.includes('wrong'));

    r = await call('/api/settings/ai/models', { provider: 'openai', apiKey: 'good-key', baseUrl: base });
    assert.deepEqual(r.data.models.map((m) => m.id), ['large', 'small']);

    r = await call('/api/settings/ai', { provider: 'openai', apiKey: 'good-key', baseUrl: base, model: 'small', test: true, save: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ai.model, 'small');
    assert.equal(r.data.checked.answered, true);
    assert.equal(r.data.checked.saved, true);
    assert.ok(!JSON.stringify(r.data).includes('good-key'), 'the key is not sent back');
    const saved = fs.readFileSync(envFile, 'utf8');
    assert.match(saved, /^N20S_AI_PROVIDER=openai$/m);
    assert.match(saved, /^OPENAI_API_KEY=good-key$/m);
    assert.match(saved, /^N20S_AI_MODEL=small$/m);
    assert.ok(!fs.readFileSync(path.join(dir, 'lineage-prov.aura.mapping.yaml'), 'utf8').includes('good-key'));

    // The model is now the studio's: the review state says proposing is on.
    assert.equal((await call('/api/state')).data.can.propose, true);
    // An empty key keeps the one set: switching the model only.
    r = await call('/api/settings/ai', { provider: 'openai', apiKey: '', baseUrl: base, model: 'large' });
    assert.equal(r.data.ai.model, 'large');
    assert.equal(calls.filter((c) => c.auth !== 'Bearer good-key' && c.auth !== 'Bearer wrong').length, 0);

    // Neo4j that is not there: a clear error, nothing changed.
    r = await call('/api/settings/neo4j', { url: 'bolt://127.0.0.1:9', user: 'neo4j', password: 'pw' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Cannot connect/);
    assert.equal((await call('/api/settings')).data.neo4j, null);

    // Only the page: no form posts, no other host names.
    assert.equal((await call('/api/settings/ai', { provider: 'openai' }, { 'content-type': 'text/plain' })).status, 415);
    const other = await new Promise((resolve, reject) => http.get(new URL('/api/settings', studio.url), { headers: { host: 'evil.example' } }, resolve).on('error', reject));
    other.resume();
    assert.equal(other.statusCode, 403);
  } finally {
    await studio.close();
    await new Promise((r) => fake.close(r));
  }
});

test('studio Connections: saving is refused when git would commit the env file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n20s-conn-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (f) => !f.endsWith('graphs.json') });
  execFileSync('git', ['init', '-q', dir]);
  const settings = connectionSettings({ env: { GEMINI_API_KEY: 'k' }, envFile: path.join(dir, '.env') });
  const studio = await startStudio({ mappingFile: path.join(dir, 'lineage-prov.aura.mapping.yaml'), port: 0, reviewer: 'Pierre', settings });
  try {
    const data = await (await fetch(new URL('/api/settings', studio.url))).json();
    assert.match(data.envRisk, /not ignored/);
  } finally {
    await studio.close();
  }
});

test('listModels: the Gemini models that generate content', async () => {
  const fetch = async (url, init) => {
    assert.equal(init.headers['x-goog-api-key'], 'k');
    assert.ok(!url.includes('k&') && !url.includes('key='), 'the key is not in the URL');
    return reply(200, { models: [
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] });
  };
  assert.deepEqual(await listModels({ provider: 'gemini', apiKey: 'k', fetch }), [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }]);
});
