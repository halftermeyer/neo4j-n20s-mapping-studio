// Index of a Neo4j Ontology Graph Spec document (the LPG ontology).

/**
 * @typedef {object} LpgProperty
 * @property {string} id       property id (the key in the spec document)
 * @property {string} name     database name (`name`, or the id)
 * @property {string|undefined} type
 * @property {string[]|null} oneOf
 * @property {boolean} mustExist
 * @property {boolean} unique
 * @property {boolean} key
 */

function indexProperties(props = {}) {
  const out = new Map();
  for (const [id, p] of Object.entries(props ?? {})) {
    out.set(id, {
      id,
      name: p?.name ?? id,
      type: p?.type,
      oneOf: Array.isArray(p?.one_of) ? p.one_of : null,
      mustExist: p?.must_exist === true,
      unique: p?.unique === true,
      key: p?.key === true,
    });
  }
  return out;
}

export function indexLpg(doc) {
  const nodes = new Map();
  const labelToNode = new Map();
  for (const [id, n] of Object.entries(doc.nodes ?? {})) {
    const label = n.label ?? n.labels?.identifier ?? null;
    const node = {
      id,
      label,
      implied: [...(n.labels?.implied ?? [])],
      props: indexProperties(n.properties),
      constraints: Object.values(n.constraints ?? {}).map((c) => ({ type: c.type, properties: [...(c.properties ?? [])] })),
    };
    nodes.set(id, node);
    if (label) labelToNode.set(label, id);
  }

  const rels = new Map();
  for (const [id, r] of Object.entries(doc.relationships ?? {})) {
    rels.set(id, {
      id,
      type: r.type ?? null,
      from: r.from?.node ?? null,
      to: r.to?.node ?? null,
      fromMax: maxPerNode(r.from),
      toMax: maxPerNode(r.to),
      props: indexProperties(r.properties),
    });
  }

  const ancestorCache = new Map();
  /** Node ids implied by a node, transitively, nearest first. */
  function ancestors(nodeId) {
    if (ancestorCache.has(nodeId)) return ancestorCache.get(nodeId);
    const out = [];
    const seen = new Set([nodeId]);
    let frontier = [nodeId];
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        for (const label of nodes.get(id)?.implied ?? []) {
          const a = labelToNode.get(label);
          if (a && !seen.has(a)) { seen.add(a); out.push(a); next.push(a); }
        }
      }
      frontier = next;
    }
    ancestorCache.set(nodeId, out);
    return out;
  }

  /** Implied labels that no node of the document declares. */
  function unresolvedImplied(nodeId) {
    return (nodes.get(nodeId)?.implied ?? []).filter((l) => !labelToNode.has(l));
  }

  /** Property of a node or of a node it implies, nearest first. */
  function findNodeProperty(nodeId, propId) {
    for (const id of [nodeId, ...ancestors(nodeId)]) {
      const p = nodes.get(id)?.props.get(propId);
      if (p) return { prop: p, owner: id };
    }
    return null;
  }

  /**
   * The inherited property this one stands for: same database name and type on
   * a node this kind implies, the most general first. Modeling tools repeat
   * inherited properties on subtypes, sometimes under a new id; in the database
   * they are one property. Null when the property is not an alias.
   */
  function aliasOf(nodeId, propId) {
    const p = nodes.get(nodeId)?.props.get(propId);
    if (!p) return null;
    for (const id of [...ancestors(nodeId)].reverse()) {
      for (const q of nodes.get(id).props.values()) {
        if (q.name === p.name && (q.type ?? null) === (p.type ?? null)) return { owner: id, prop: q };
      }
    }
    return null;
  }

  /** True when every node of this kind is guaranteed to have the property. */
  function isRequired(nodeId, propId) {
    for (const id of [nodeId, ...ancestors(nodeId)]) {
      const n = nodes.get(id);
      const p = n?.props.get(propId);
      if (p && (p.mustExist || p.key)) return true;
      if (n?.constraints.some((c) => (c.type === 'KEY' || c.type === 'EXISTS') && c.properties.includes(propId))) return true;
    }
    return false;
  }

  /** Property sets that identify a node of this kind (unique, key, KEY and UNIQUE constraints). */
  function uniqueSets(nodeId) {
    const sets = [];
    for (const id of [nodeId, ...ancestors(nodeId)]) {
      const n = nodes.get(id);
      if (!n) continue;
      for (const p of n.props.values()) if (p.unique || p.key) sets.push([p.id]);
      for (const c of n.constraints) if (c.type === 'KEY' || c.type === 'UNIQUE') sets.push(c.properties);
    }
    return sets;
  }

  return { id: doc.id, version: doc.version, nodes, rels, labelToNode, ancestors, unresolvedImplied, findNodeProperty, aliasOf, isRequired, uniqueSets };
}

function maxPerNode(end) {
  if (!end) return null;
  if (Number.isInteger(end.count)) return end.count;
  if (Number.isInteger(end.max_count)) return end.max_count;
  return null;
}

/** Copy of the document without layout data (extensions.display), with sorted keys. */
export function semanticContent(doc) {
  const strip = (v, parentKey) => {
    if (Array.isArray(v)) return v.map((x) => strip(x));
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (parentKey === 'extensions' && k === 'display') continue;
        out[k] = strip(v[k], k);
      }
      return out;
    }
    return v;
  };
  return strip(doc);
}

/** SHA-256 of the semantic content: moving nodes around in a modeling tool does not change it. */
export async function contentHash(doc) {
  const bytes = new TextEncoder().encode(JSON.stringify(semanticContent(doc)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the mapping depends on, per element. Stored in the lock file. */
export function fingerprints(idx) {
  const props = (m) => Object.fromEntries([...m.values()].map((p) => [p.id, {
    name: p.name,
    type: p.type ?? null,
    ...(p.oneOf ? { oneOf: p.oneOf } : {}),
  }]));
  const nodes = {};
  for (const n of idx.nodes.values()) nodes[n.id] = { label: n.label, implied: n.implied, properties: props(n.props) };
  const relationships = {};
  for (const r of idx.rels.values()) relationships[r.id] = { type: r.type, from: r.from, to: r.to, properties: props(r.props) };
  return { nodes, relationships };
}

/** Datatype the compiler uses when an entry gives none (n20s native typing for numbers and booleans). */
const DEFAULT_DATATYPE = {
  STRING: 'string', UUID: 'string',
  INTEGER: 'long', INTEGER32: 'int', INTEGER16: 'short', INTEGER8: 'byte',
  FLOAT: 'double', FLOAT32: 'float',
  BOOLEAN: 'boolean',
  DATE: 'date', 'LOCAL DATETIME': 'dateTime', 'ZONED DATETIME': 'dateTime',
  'LOCAL TIME': 'time', 'ZONED TIME': 'time',
  DURATION: 'duration',
};
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export function scalarType(type) {
  const m = /^LIST<(.+)>$/.exec(type ?? '');
  return m ? m[1] : type;
}

export function defaultDatatype(type) {
  const t = DEFAULT_DATATYPE[scalarType(type)];
  return t ? XSD + t : null;
}

/** XSD datatypes a property of this Neo4j type can be written as. */
const COMPATIBLE = {
  STRING: ['string', 'normalizedString', 'token', 'language', 'anyURI', 'Name', 'NCName'],
  UUID: ['string', 'normalizedString', 'token'],
  INTEGER: ['integer', 'long', 'int', 'short', 'byte', 'decimal', 'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte'],
  FLOAT: ['double', 'float', 'decimal'],
  BOOLEAN: ['boolean'],
  DATE: ['date'],
  'LOCAL DATETIME': ['dateTime'],
  'ZONED DATETIME': ['dateTime', 'dateTimeStamp'],
  'LOCAL TIME': ['time'],
  'ZONED TIME': ['time'],
  DURATION: ['duration', 'dayTimeDuration', 'yearMonthDuration'],
};
COMPATIBLE.INTEGER32 = COMPATIBLE.INTEGER16 = COMPATIBLE.INTEGER8 = COMPATIBLE.INTEGER;
COMPATIBLE.FLOAT32 = COMPATIBLE.FLOAT;

/** @returns {boolean|null} null when the Neo4j type has no XSD counterpart (POINT, VECTOR, ANY) or the datatype is not XSD */
export function datatypeCompatible(type, datatypeIri) {
  const allowed = COMPATIBLE[scalarType(type)];
  if (!allowed || !datatypeIri.startsWith(XSD)) return null;
  return allowed.includes(datatypeIri.slice(XSD.length));
}

/** XSD derivation, enough to compare a mapped datatype with an rdfs:range. */
const XSD_PARENT = {
  long: 'integer', int: 'long', short: 'int', byte: 'short',
  nonNegativeInteger: 'integer', positiveInteger: 'nonNegativeInteger',
  nonPositiveInteger: 'integer', negativeInteger: 'nonPositiveInteger',
  unsignedLong: 'nonNegativeInteger', unsignedInt: 'unsignedLong', unsignedShort: 'unsignedInt', unsignedByte: 'unsignedShort',
  integer: 'decimal',
  normalizedString: 'string', token: 'normalizedString', language: 'token', Name: 'token', NCName: 'Name',
  dateTimeStamp: 'dateTime',
  dayTimeDuration: 'duration', yearMonthDuration: 'duration',
};

export function xsdDerivesFrom(datatypeIri, rangeIri) {
  if (datatypeIri === rangeIri) return true;
  if (!datatypeIri.startsWith(XSD) || !rangeIri.startsWith(XSD)) return false;
  let t = datatypeIri.slice(XSD.length);
  const target = rangeIri.slice(XSD.length);
  while (XSD_PARENT[t]) {
    t = XSD_PARENT[t];
    if (t === target) return true;
  }
  return false;
}
