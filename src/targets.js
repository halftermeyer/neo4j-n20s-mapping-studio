// Target ontologies: which terms exist, what they are, domains, ranges and the class hierarchy.
import { Parser, Store } from 'n3';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';

const CLASS_TYPES = new Set([OWL + 'Class', RDFS + 'Class']);
const OBJECT_PROPERTY = OWL + 'ObjectProperty';
const DATATYPE_PROPERTY = OWL + 'DatatypeProperty';
const PROPERTY_TYPES = new Set([
  RDF + 'Property', OBJECT_PROPERTY, DATATYPE_PROPERTY, OWL + 'AnnotationProperty',
  OWL + 'FunctionalProperty', OWL + 'InverseFunctionalProperty', OWL + 'TransitiveProperty',
  OWL + 'SymmetricProperty', OWL + 'AsymmetricProperty', OWL + 'ReflexiveProperty', OWL + 'IrreflexiveProperty',
]);
const TOP_CLASSES = new Set([OWL + 'Thing', RDFS + 'Resource']);

export function formatFromPath(path) {
  const ext = path.toLowerCase().split('.').pop();
  return { ttl: 'Turtle', nt: 'N-Triples', nq: 'N-Quads', trig: 'TriG', n3: 'N3' }[ext] ?? null;
}

/**
 * Builds one index over all target ontologies. A source that fails to parse is
 * reported in `failed` and left out.
 * @param {Array<{namespace: string, text: string, format: string}>} sources
 */
export function indexTargets(sources) {
  const store = new Store();
  const failed = [];
  for (const s of sources) {
    try {
      store.addQuads(new Parser({ format: s.format }).parse(s.text));
    } catch (err) {
      failed.push({ namespace: s.namespace, error: err.message });
    }
  }
  const loaded = sources.filter((s) => !failed.some((f) => f.namespace === s.namespace));

  const typesOf = (iri) => new Set(store.getObjects(iri, RDF + 'type', null).map((o) => o.value));

  const listMembers = (head) => {
    const out = [];
    let node = head;
    for (let guard = 0; node && node.value !== RDF + 'nil' && guard < 1000; guard++) {
      const first = store.getObjects(node, RDF + 'first', null)[0];
      if (first) out.push(first.value);
      node = store.getObjects(node, RDF + 'rest', null)[0];
    }
    return out;
  };

  /** A domain or range: a named class, or a union of named classes. */
  const specs = (iri, predicate) => store.getObjects(iri, predicate, null).map((o) => {
    if (o.termType === 'NamedNode') return { iri: o.value };
    const union = store.getObjects(o, OWL + 'unionOf', null)[0];
    return union ? { union: listMembers(union) } : { opaque: true };
  });

  const superCache = new Map();
  /** The class and all its named superclasses. */
  function closure(classIri) {
    if (superCache.has(classIri)) return superCache.get(classIri);
    const seen = new Set([classIri]);
    const queue = [classIri];
    while (queue.length) {
      const c = queue.shift();
      for (const s of store.getObjects(c, RDFS + 'subClassOf', null)) {
        if (s.termType === 'NamedNode' && !seen.has(s.value)) { seen.add(s.value); queue.push(s.value); }
      }
    }
    superCache.set(classIri, seen);
    return seen;
  }

  const superPropCache = new Map();
  /** The property and all its named superproperties. */
  function propertyClosure(propIri) {
    if (superPropCache.has(propIri)) return superPropCache.get(propIri);
    const seen = new Set([propIri]);
    const queue = [propIri];
    while (queue.length) {
      const p = queue.shift();
      for (const s of store.getObjects(p, RDFS + 'subPropertyOf', null)) {
        if (s.termType === 'NamedNode' && !seen.has(s.value)) { seen.add(s.value); queue.push(s.value); }
      }
    }
    superPropCache.set(propIri, seen);
    return seen;
  }

  const inTargets = (iri) => loaded.some((s) => iri.startsWith(s.namespace));
  const literal = (iri, pred) => store.getObjects(iri, pred, null).filter((o) => o.termType === 'Literal');
  const english = (lits) => (lits.find((l) => !l.language || l.language.startsWith('en')) ?? lits[0])?.value ?? null;

  /**
   * Every class and property declared in a target namespace, with what a person
   * (or a model) needs to choose between them: label, comment, definition,
   * domains, ranges, parents, and the annotations of the target vocabulary
   * that point to other terms (PROV's qualifiedForm, for instance).
   */
  function terms() {
    const out = [];
    const subjects = new Set(store.getSubjects(RDF + 'type', null).filter((s) => s.termType === 'NamedNode').map((s) => s.value));
    for (const iri of [...subjects].filter(inTargets).sort()) {
      const types = typesOf(iri);
      const isClass = [...types].some((t) => CLASS_TYPES.has(t));
      const isProp = [...types].some((t) => PROPERTY_TYPES.has(t));
      if (!isClass && !isProp) continue;
      const definition = english(store.getQuads(iri, null, null).filter((q) => q.object.termType === 'Literal' && /[#/]definition$/.test(q.predicate.value)).map((q) => q.object));
      const links = {};
      for (const q of store.getQuads(iri, null, null)) {
        if (q.object.termType !== 'NamedNode' || !inTargets(q.predicate.value) || !inTargets(q.object.value)) continue;
        (links[q.predicate.value] ??= []).push(q.object.value);
      }
      const named = (pred) => store.getObjects(iri, pred, null).filter((o) => o.termType === 'NamedNode').map((o) => o.value);
      out.push({
        iri,
        kind: isClass ? 'class' : types.has(OBJECT_PROPERTY) ? 'objectProperty' : types.has(DATATYPE_PROPERTY) ? 'datatypeProperty' : 'property',
        label: english(literal(iri, RDFS + 'label')),
        comment: english(literal(iri, RDFS + 'comment')),
        definition,
        ...(isClass ? { parents: named(RDFS + 'subClassOf') } : {
          parents: named(RDFS + 'subPropertyOf'),
          domains: specs(iri, RDFS + 'domain').filter((d) => !d.opaque).flatMap((d) => d.iri ? [d.iri] : d.union),
          ranges: specs(iri, RDFS + 'range').filter((d) => !d.opaque).flatMap((d) => d.iri ? [d.iri] : d.union),
        }),
        links,
      });
    }
    return out;
  }

  return {
    namespaces: loaded.map((s) => s.namespace),
    failed,
    size: store.size,
    /** The namespace this IRI falls in, if it is one of the loaded targets. */
    namespaceOf: (iri) => loaded.map((s) => s.namespace).filter((ns) => iri.startsWith(ns)).sort((a, b) => b.length - a.length)[0] ?? null,
    isDeclared: (iri) => typesOf(iri).size > 0,
    isClass: (iri) => [...typesOf(iri)].some((t) => CLASS_TYPES.has(t)),
    isProperty: (iri) => [...typesOf(iri)].some((t) => PROPERTY_TYPES.has(t)),
    isObjectProperty: (iri) => typesOf(iri).has(OBJECT_PROPERTY),
    isDatatypeProperty: (iri) => typesOf(iri).has(DATATYPE_PROPERTY),
    domains: (iri) => specs(iri, RDFS + 'domain'),
    ranges: (iri) => specs(iri, RDFS + 'range'),
    closure,
    propertyClosure,
    terms,
    /**
     * Lenient check: satisfied when the classes entail at least one declared
     * domain (or range). Ontologies such as PROV-O declare several domains to
     * suit several OWL profiles, so requiring all of them would be wrong.
     * @returns {{ok: boolean|null, expected: string[]}} ok is null when nothing can be said
     */
    satisfies(declared, classIris) {
      const named = declared.filter((d) => !d.opaque);
      if (named.length === 0) return { ok: null, expected: [] };
      const expected = named.flatMap((d) => d.iri ? [d.iri] : d.union);
      if (expected.some((e) => TOP_CLASSES.has(e))) return { ok: true, expected };
      if (classIris.length === 0) return { ok: null, expected };
      const all = new Set(classIris.flatMap((c) => [...closure(c)]));
      const ok = named.some((d) => d.iri ? all.has(d.iri) : d.union.some((u) => all.has(u)));
      return { ok, expected };
    },
  };
}
