// An LPG ontology read from the database itself, when no modeling tool exported
// one: labels, implied labels, properties with their types, relationship types
// with their ends, constraints. Plain Cypher and the db.schema procedures, so
// it runs on Relate, Neo4j and Aura.
//
// What the data shows, not what the model means: there are no descriptions
// (the design conversation brings the meaning), implied labels are labels that
// always come with another one, and a root label without a uniqueness
// constraint gets one when the data shows an id-like property unique and
// always present; the constraint says it is observed, not enforced.
import { contentHash } from './lpg.js';

const SPEC = 'https://neo4j.com/docs/ontology-graph-spec/1.1.0/schema.json';
const slug = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
const q = (name) => '`' + String(name).replaceAll('`', '``') + '`';
/** "ZONED DATETIME NOT NULL" -> "ZONED DATETIME", "LIST<STRING NOT NULL> NOT NULL" -> "LIST<STRING>". */
const specType = (t) => String(t ?? '').replace(/\s+NOT NULL/g, '').trim() || 'STRING';
const idLike = (name) => /^(id|uuid|key|uri|iri)$/i.test(name) || /Id$/.test(name);

/**
 * @param {{run: (cypher: string, params?: object) => Promise<object[]>, agent?: () => Promise<string>}} source
 * @param {{id: string, name?: string}} o
 * @returns {Promise<{doc: object, notes: string[]}>}
 */
export async function introspect(source, { id, name = null } = {}) {
  const notes = [];
  const nodeProps = await source.run('CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes, mandatory RETURN nodeLabels, propertyName, propertyTypes, mandatory');
  const comboRows = await source.run('MATCH (n) RETURN labels(n) AS labels, count(*) AS n');
  const combos = new Map();
  for (const r of comboRows) {
    if (!r.labels.length) continue;
    const key = [...r.labels].sort().join(':');
    combos.set(key, { labels: [...r.labels].sort(), count: (combos.get(key)?.count ?? 0) + Number(r.n) });
  }
  const labels = [...new Set([...combos.values()].flatMap((c) => c.labels))].sort();

  // A label implies the labels that come with it on every node.
  const implied = new Map(labels.map((l) => {
    const withL = [...combos.values()].filter((c) => c.labels.includes(l));
    const common = withL.reduce((acc, c) => acc.filter((x) => c.labels.includes(x)), withL[0]?.labels ?? []);
    return [l, common.filter((x) => x !== l)];
  }));
  // Labels that always come together imply each other: the data cannot say which one is general.
  // One direction is kept (the later name is taken as the more specific), and a note says so.
  for (const l of labels) {
    for (const m of [...implied.get(l)]) {
      if (!implied.get(m).includes(l)) continue;
      const [general, specific] = [l, m].sort();
      implied.set(general, implied.get(general).filter((x) => x !== specific));
      notes.push(`${general} and ${specific} are always on the same nodes: ${specific} is taken to imply ${general}. Say otherwise in the design conversation if it is the other way round.`);
    }
  }
  const depth = (l) => implied.get(l)?.length ?? 0;
  /** The label that identifies a combination: the most specific one, implying all the others. */
  const identifier = (ls) => [...ls].sort((a, b) => depth(b) - depth(a)).find((l) => ls.every((x) => x === l || implied.get(l).includes(x))) ?? null;
  const counts = new Map(labels.map((l) => [l, [...combos.values()].filter((c) => c.labels.includes(l)).reduce((n, c) => n + c.count, 0)]));

  // Properties: a label owns those present in every combination it is in; a subtype only adds its own.
  const byCombo = new Map();
  for (const r of nodeProps) {
    if (!r.propertyName) continue;
    const key = [...r.nodeLabels].sort().join(':');
    if (!byCombo.has(key)) byCombo.set(key, new Map());
    byCombo.get(key).set(r.propertyName, { type: specType(r.propertyTypes?.[0]), types: (r.propertyTypes ?? []).map(specType), mandatory: !!r.mandatory });
  }
  const ownProps = new Map();
  for (const l of labels) {
    const keys = [...combos.keys()].filter((k) => combos.get(k).labels.includes(l));
    const sets = keys.map((k) => byCombo.get(k) ?? new Map());
    const names = sets.length ? [...sets[0].keys()].filter((p) => sets.every((m) => m.has(p))) : [];
    const inherited = new Set(implied.get(l).flatMap((a) => [...(ownProps.get(a)?.keys() ?? [])]));
    const own = new Map();
    for (const p of names) {
      if (inherited.has(p)) continue;
      const all = sets.map((m) => m.get(p));
      const types = [...new Set(all.flatMap((x) => x.types))];
      if (types.length > 1) notes.push(`${l}.${p} has several types (${types.join(', ')}): ${all[0].type} is kept.`);
      own.set(p, { type: all[0].type, mandatory: all.every((x) => x.mandatory) });
    }
    ownProps.set(l, own);
  }
  // General labels first, so that subtypes see what they inherit.
  const order = [...labels].sort((a, b) => depth(a) - depth(b));
  for (const l of order) {
    const inherited = new Set(implied.get(l).flatMap((a) => [...(ownProps.get(a)?.keys() ?? [])]));
    for (const p of [...ownProps.get(l).keys()]) if (inherited.has(p)) ownProps.get(l).delete(p);
  }

  // Constraints, as the database declares them.
  let constraints = [];
  try {
    constraints = await source.run('SHOW CONSTRAINTS YIELD type, labelsOrTypes, properties, name, entityType RETURN type, labelsOrTypes, properties, name, entityType');
  } catch (err) {
    notes.push(`No constraints read (${err.message.split('\n')[0]}).`);
  }
  const TYPES = { UNIQUENESS: 'UNIQUE', NODE_KEY: 'KEY', NODE_PROPERTY_EXISTENCE: 'EXISTS', RELATIONSHIP_UNIQUENESS: 'UNIQUE', RELATIONSHIP_KEY: 'KEY', RELATIONSHIP_PROPERTY_EXISTENCE: 'EXISTS', NODE_PROPERTY_TYPE: null, RELATIONSHIP_PROPERTY_TYPE: null };

  const nodes = {};
  let c = 0;
  for (const l of order) {
    const nid = slug(l);
    const props = Object.fromEntries([...ownProps.get(l)].map(([p, x]) => [p, { type: x.type, name: p }]));
    const cons = {};
    for (const k of constraints.filter((x) => x.entityType === 'NODE' && x.labelsOrTypes?.[0] === l && TYPES[x.type])) {
      cons[`c:${c++}`] = { type: TYPES[k.type], properties: k.properties, name: k.name };
    }
    for (const [p, x] of ownProps.get(l)) if (x.mandatory && !Object.values(cons).some((k) => k.type === 'EXISTS' && k.properties.includes(p))) {
      cons[`c:${c++}`] = { type: 'EXISTS', properties: [p], name: `${p}_${l}_observed`, extensions: { custom: { observed: true } } };
    }
    // A root label with no uniqueness gets the one the data shows on an id-like property.
    if (!implied.get(l).length && !Object.values(cons).some((k) => ['UNIQUE', 'KEY'].includes(k.type))) {
      for (const [p, x] of ownProps.get(l)) {
        if (!idLike(p) || !x.mandatory) continue;
        const [r] = await source.run(`MATCH (n:${q(l)}) RETURN count(n) AS n, count(DISTINCT n.${q(p)}) AS d`);
        if (Number(r.n) > 0 && Number(r.n) === Number(r.d)) {
          cons[`c:${c++}`] = { type: 'UNIQUE', properties: [p], name: `${p}_${l}_observed_unique`, extensions: { custom: { observed: true } } };
          notes.push(`${l}.${p} is unique in the data but no constraint enforces it: recorded as an observed uniqueness.`);
          break;
        }
      }
    }
    nodes[nid] = {
      labels: { identifier: l, ...(implied.get(l).length ? { implied: implied.get(l) } : {}) },
      properties: props,
      ...(Object.keys(cons).length ? { constraints: cons } : {}),
      extensions: { custom: { count: counts.get(l) } },
    };
  }

  // Relationships: the most specific labels every start (and end) node has.
  const rels = await source.run('MATCH (a)-[r]->(b) RETURN type(r) AS type, labels(a) AS f, labels(b) AS t, count(*) AS n');
  const relProps = await source.run('CALL db.schema.relTypeProperties() YIELD relType, propertyName, propertyTypes, mandatory RETURN relType, propertyName, propertyTypes, mandatory');
  const typeOf = (relType) => String(relType).replace(/^\[?:?`?|`?\]?$/g, '');
  const common = (lists) => {
    const inter = lists.reduce((acc, ls) => acc.filter((x) => ls.includes(x)), lists[0] ?? []);
    return [...inter].sort((a, b) => depth(b) - depth(a))[0] ?? null;
  };
  const relationships = {};
  for (const type of [...new Set(rels.map((r) => r.type))].sort()) {
    const rows = rels.filter((r) => r.type === type);
    let pairs = [[common(rows.map((r) => r.f)), common(rows.map((r) => r.t)), rows]];
    if (!pairs[0][0] || !pairs[0][1]) {
      // No label shared by all ends: one relationship kind per pair of identifier labels.
      const by = new Map();
      for (const r of rows) {
        const k = `${identifier(r.f)}|${identifier(r.t)}`;
        by.set(k, [...(by.get(k) ?? []), r]);
      }
      pairs = [...by].map(([k, rs]) => [...k.split('|'), rs]);
    }
    for (const [from, to, rs] of pairs) {
      const rid = pairs.length > 1 ? `${slug(type)}-${slug(from)}-${slug(to)}` : slug(type);
      const props = relProps.filter((p) => typeOf(p.relType) === type && p.propertyName);
      relationships[rid] = {
        type,
        from: { node: slug(from) },
        to: { node: slug(to) },
        ...(props.length ? { properties: Object.fromEntries(props.map((p) => [p.propertyName, { type: specType(p.propertyTypes?.[0]), name: p.propertyName }])) } : {}),
        extensions: { custom: { count: rs.reduce((n, r) => n + Number(r.n), 0) } },
      };
    }
  }

  let agent = null;
  try { agent = await source.agent?.(); } catch { /* snapshot sources have none */ }
  const doc = {
    schema: SPEC, version: '0', id, name: name ?? id,
    description: `Introspected from the database${agent ? ` (${agent})` : ''}: labels, properties, relationship types and constraints as the data shows them. No descriptions: the design conversation brings the meaning.`,
    nodes, relationships,
  };
  // The version follows the structure: introspecting an unchanged database gives the same version.
  doc.version = (await contentHash({ ...doc, version: '', description: '' })).slice(0, 12);
  return { doc, notes };
}
