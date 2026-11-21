#!/usr/bin/env node
// The client's side of the demo: their triple store changes without us.
//
//   node demo/client-kg/client.mjs tx <name>   a SPARQL update the client's own tools
//                                               would make, printed as JSON: what ran,
//                                               what the store answered
//   node demo/client-kg/client.mjs count       triples in their store
//
// The store is the Fuseki that demo/demo.sh starts (CLIENT_KG_SPARQL, default
// http://127.0.0.1:3031/client/query); demo.sh start reloads client.ttl.
const QUERY = process.env.CLIENT_KG_SPARQL ?? 'http://127.0.0.1:3031/client/query';
const UPDATE = QUERY.replace(/\/query$/, '/update');

export const TX = {
  // The catalog team finds email addresses in the revenue mart: one more element it holds.
  'revenue-holds-emails': {
    app: 'Client data catalog',
    statement: `PREFIX ex:  <https://client.example.org/governance#>
PREFIX cat: <https://client.example.org/catalog/>
INSERT DATA {
  cat:mart-revenue ex:holds [ a ex:EmailAddress ] .
}`,
  },
};

async function count() {
  const res = await fetch(QUERY, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' }, body: new URLSearchParams({ query: 'SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }' }) });
  if (!res.ok) throw new Error(`${QUERY} answered ${res.status}`);
  return Number((await res.json()).results.bindings[0].n.value);
}

const [cmd, name] = process.argv.slice(2);
if (cmd === 'count') {
  console.log(await count());
} else if (cmd === 'tx' && TX[name]) {
  const t = TX[name];
  const before = await count();
  const t0 = Date.now();
  const res = await fetch(UPDATE, { method: 'POST', headers: { 'content-type': 'application/sparql-update' }, body: t.statement });
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.log(JSON.stringify({ name, app: t.app, statement: t.statement, committed: false, ms, error: `${res.status} ${(await res.text()).slice(0, 200)}` }));
  } else {
    const after = await count();
    console.log(JSON.stringify({ name, app: t.app, statement: t.statement, committed: true, ms, counters: { triplesAdded: after - before } }));
  }
} else {
  console.error(`demo/client-kg/client.mjs tx <${Object.keys(TX).join('|')}> | count`);
  process.exitCode = 2;
}
