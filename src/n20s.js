// Client for n20s-server (the n20s reasoning sidecar), over HTTP.

export function n20sClient(baseUrl = globalThis.process?.env?.N20S_URL ?? 'http://localhost:7474') {
  const base = baseUrl.replace(/\/$/, '');
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Error(`n20s ${method} ${path}: ${res.status} ${data?.error ?? text}`);
    return data;
  }
  const g = (name) => `/graph/${encodeURIComponent(name)}`;
  return {
    url: base,
    version: () => call('GET', '/version'),
    list: () => call('GET', '/graph'),
    drop: (graph) => call('DELETE', g(graph)),
    projectTemplate: (graph, template, rows, ifExists = 'append') => call('POST', `${g(graph)}/projectTemplate`, { template, rows, ifExists }),
    addTurtle: (graph, turtle, ifExists = 'append') => call('POST', `${g(graph)}/turtle`, Array.isArray(turtle) ? { turtles: turtle, ifExists } : { turtle, ifExists }),
    /** Triples as {s, p, o} terms (construct output feeds it as is). */
    addTriples: (graph, triples, ifExists = 'append') => call('POST', `${g(graph)}/triples?ifExists=${ifExists}`, triples),
    queryWithRules: async (graph, sparql, rules, profile = '', { terms = false } = {}) => ((await call('POST', `${g(graph)}/queryWithRules`, { sparql, rules, profile, ...(terms ? { terms } : {}) })) ?? []).map((r) => r.row ?? r),
    construct: (graph, sparql) => call('POST', `${g(graph)}/construct`, { sparql }),
    update: (graph, update) => call('POST', `${g(graph)}/update`, { update }),
    infer: (graph, profile, rules) => (rules ? call('POST', `${g(graph)}/inferWithRules`, { rules, profile: profile ?? '' }) : call('POST', `${g(graph)}/infer`, { profile })),
    validate: (graph, rules, profile) => (rules || profile ? call('POST', `${g(graph)}/validateWithRules`, { rules: rules ?? '', profile: profile ?? '' }) : call('POST', `${g(graph)}/validate`)),
    explain: (graph, s, p, o, rules, profile) => call('POST', `${g(graph)}/explain`, { s, p, o, rules: rules ?? '', profile: profile ?? '' }),
    turtle: (graph) => call('GET', `${g(graph)}/turtle`),
    /**
     * SELECT query; returns plain rows. With terms, values are (s, p, o) terms:
     * IRIs bare, blank nodes _:label, literals quoted with their datatype or language.
     */
    async query(graph, sparql, profile = '', { terms = false } = {}) {
      const res = await call('POST', `${g(graph)}/query`, { sparql, profile, ...(terms ? { terms } : {}) });
      return (res ?? []).map((r) => r.row ?? r);
    },
  };
}
