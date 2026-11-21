import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteSparql, remoteOf, expandUrl, shownUrl } from '../src/remote.js';
import { checkRecipe, recipeKind } from '../src/recipe.js';

const recipe = (graphs, steps) => ({ format: 'n20s-recipe/0.1', id: 'mix', graphs, steps });

test('remote graphs: an endpoint, credentials by environment variable name, read only with construct … from', () => {
  const ok = recipe({ work: {}, client: { lifecycle: 'remote', sparql: '${CLIENT_KG}', user: 'CLIENT_USER', password: 'CLIENT_PASSWORD' } }, [
    { id: 'pull', type: 'construct', graph: 'work', from: 'client', sparql: 'CONSTRUCT WHERE { ?s ?p ?o }' },
    { id: 'ask', type: 'query', graph: 'work', sparql: 'SELECT * WHERE { ?s ?p ?o }' },
  ]);
  assert.deepEqual(checkRecipe(ok), []);
  assert.equal(recipeKind(ok), 'hybrid', 'scoped here, precomputed elsewhere');
  const msgs = (r) => checkRecipe(r).map((f) => f.message);
  assert.match(msgs(recipe({ work: {}, client: { lifecycle: 'remote', sparql: 'https://u:secret@kg.example.org/q' } }, ok.steps)).join(), /No credentials in the URL/);
  assert.match(msgs(recipe({ work: {}, client: { lifecycle: 'remote', sparql: 'https://kg.example.org/q', password: 's3cr3t!' } }, ok.steps)).join(), /names an environment variable/);
  assert.match(msgs(recipe({ work: {}, client: { lifecycle: 'remote', sparql: 'https://kg.example.org/q' } }, [{ id: 'x', type: 'update', graph: 'client', sparql: 'CLEAR DEFAULT' }])).join(), /remote store: nothing runs on it/);
  assert.match(msgs(recipe({ work: {}, client: { lifecycle: 'remote' } }, ok.steps)).join(), /names its SPARQL endpoint/);
});

test('remote client: URL and credentials from the environment, never shown; terms in the n20s convention', async () => {
  assert.equal(expandUrl('${KG}/client/query', { KG: 'http://127.0.0.1:3030' }), 'http://127.0.0.1:3030/client/query');
  assert.throws(() => expandUrl('${KG}/q', {}), /needs KG in the environment/);
  assert.equal(shownUrl('https://kg.example.org/client/query?x=1'), 'https://kg.example.org/client/query');
  assert.throws(() => remoteOf({ sparql: 'https://kg/q', user: 'U', password: 'P' }, { U: 'me' }), /needs P/);

  let sent;
  const fetch = async (url, init) => {
    sent = { url, init };
    return { ok: true, status: 200, text: async () => [
      '<http://ex/a> <http://ex/p> "chat"@fr .',
      '<http://ex/a> <http://ex/n> "3"^^<http://www.w3.org/2001/XMLSchema#integer> .',
      '<http://ex/a> <http://ex/s> "say \\"hi\\""^^<http://www.w3.org/2001/XMLSchema#string> .',
      '_:b1 <http://ex/q> _:b1 .',
      '<http://ex/a> <http://ex/r> _:b2 .',
    ].join('\n') };
  };
  const r = remoteSparql({ url: 'https://kg.example.org/client/query', user: 'me', password: 'pw', fetch });
  const t = await r.construct('CONSTRUCT WHERE { ?s ?p ?o }', { bnodePrefix: 'pull_' });
  assert.equal(sent.init.headers.authorization, `Basic ${btoa('me:pw')}`);
  assert.equal(sent.init.headers.accept, 'application/n-triples');
  assert.match(sent.init.body, /^query=CONSTRUCT/);
  assert.deepEqual(t.map((x) => x.object), ['"chat"@fr', '"3"^^<http://www.w3.org/2001/XMLSchema#integer>', '"say \\"hi\\""', '_:pull_0', '_:pull_1']);
  assert.equal(t[3].subject, '_:pull_0', 'one blank node, one label');
  await assert.rejects(remoteSparql({ url: 'https://kg/q', fetch: async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }) }).construct('CONSTRUCT {} WHERE {}'), /answered 401/);
});
