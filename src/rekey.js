// Moves a mapping (and an oracle) from one export of an LPG ontology to another
// export of the same model whose ids differ: nodes are matched by label,
// relationships by type and end labels, properties by database name. A model
// rebuilt in the modeling tool, or exported by another tool, gets new ids.
import { indexLpg } from './lpg.js';

/**
 * @returns {{mapping: object, unmatched: string[]}} unmatched lists the paths
 * that have no counterpart in the new document; they are left out.
 */
export function rekeyMapping(mapping, fromDoc, toDoc) {
  const k = keyMaps(indexLpg(fromDoc), indexLpg(toDoc));
  const out = structuredClone(mapping);
  out.lpgOntology = { ...out.lpgOntology, id: toDoc.id, version: String(toDoc.version) };
  out.nodes = {};
  out.relationships = {};
  const unmatched = [];

  for (const [id, e] of Object.entries(mapping.nodes ?? {})) {
    const nid = k.node(id);
    if (!nid) { unmatched.push(`nodes/${id}`); continue; }
    const ne = structuredClone(e);
    if (ne.subject) ne.subject = ne.subject.replace(/\{([^{}]+)\}/g, (m, ph) => `{${k.nodeProp(id, ph) ?? ph}}`);
    if (ne.properties) ne.properties = rekeyProps(ne.properties, (p) => k.nodeProp(id, p), `nodes/${id}`, unmatched);
    out.nodes[nid] = ne;
  }
  for (const [id, e] of Object.entries(mapping.relationships ?? {})) {
    const rid = k.rel(id);
    if (!rid) { unmatched.push(`relationships/${id}`); continue; }
    const re = structuredClone(e);
    if (re.qualified?.subject) {
      re.qualified.subject = re.qualified.subject.replace(/\{([^{}]+)\}/g, (m, ph) => {
        const [, end, p] = /^(start|end)\.(.+)$/.exec(ph) ?? [];
        return `{${end ? `${end}.${k.endProp(id, end, p) ?? p}` : k.relProp(id, ph) ?? ph}}`;
      });
    }
    if (re.properties) re.properties = rekeyProps(re.properties, (p) => k.relProp(id, p), `relationships/${id}`, unmatched);
    out.relationships[rid] = re;
  }
  return { mapping: out, unmatched };
}

/** Rewrites the node ids of {{node|value}} and of decode specs. */
export function rekeyOracle(oracle, fromDoc, toDoc) {
  const k = keyMaps(indexLpg(fromDoc), indexLpg(toDoc));
  const out = structuredClone(oracle);
  for (const c of out.checks ?? []) {
    if (c.sparql) c.sparql = c.sparql.replace(/\{\{([^|}]+)\|/g, (m, id) => `{{${k.node(id) ?? id}|`);
    for (const [col, spec] of Object.entries(c.decode ?? {})) {
      const [kind, arg] = spec.split(/:(.*)/s);
      if (kind === 'node') c.decode[col] = `node:${k.node(arg) ?? arg}`;
      if (kind === 'values') {
        const [section, id, , prop] = arg.split('/');
        const eid = section === 'nodes' ? k.node(id) : k.rel(id);
        const pid = section === 'nodes' ? k.nodeProp(id, prop) : k.relProp(id, prop);
        c.decode[col] = `values:${section}/${eid ?? id}/properties/${pid ?? prop}`;
      }
    }
  }
  return out;
}

function rekeyProps(props, keyOf, base, unmatched) {
  const out = {};
  for (const [pid, pe] of Object.entries(props)) {
    const np = keyOf(pid);
    if (!np) { unmatched.push(`${base}/properties/${pid}`); continue; }
    out[np] = pe;
  }
  return out;
}

function keyMaps(from, to) {
  const node = (id) => {
    const label = from.nodes.get(id)?.label;
    return label ? to.labelToNode.get(label) ?? null : null;
  };
  /** Property of a node (own or implied) by database name; an alias resolves to the inherited property. */
  const propByName = (nodeId, name) => {
    for (const id of [nodeId, ...to.ancestors(nodeId)]) {
      for (const p of to.nodes.get(id).props.values()) {
        if (p.name === name) return to.aliasOf(id, p.id)?.prop.id ?? p.id;
      }
    }
    return null;
  };
  const nodeProp = (nodeId, propId) => {
    const nid = node(nodeId);
    const name = from.findNodeProperty(nodeId, propId)?.prop.name;
    return nid && name ? propByName(nid, name) : null;
  };
  const rel = (id) => {
    const r = from.rels.get(id);
    if (!r) return null;
    const label = (n) => from.nodes.get(n)?.label;
    const match = [...to.rels.values()].filter((x) => x.type === r.type
      && to.nodes.get(x.from)?.label === label(r.from) && to.nodes.get(x.to)?.label === label(r.to));
    return match.length === 1 ? match[0].id : null;
  };
  const relProp = (relId, propId) => {
    const rid = rel(relId);
    const name = from.rels.get(relId)?.props.get(propId)?.name;
    if (!rid || !name) return null;
    return [...to.rels.get(rid).props.values()].find((p) => p.name === name)?.id ?? null;
  };
  const endProp = (relId, end, propId) => {
    const r = from.rels.get(relId);
    return r ? nodeProp(end === 'start' ? r.from : r.to, propId) : null;
  };
  return { node, nodeProp, rel, relProp, endProp };
}
