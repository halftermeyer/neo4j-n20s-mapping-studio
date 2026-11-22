// Checks a mapping against its LPG ontology, its target ontologies and its lock.
// Pure: no file access, so the same code runs in a browser (the studio) and in the CLI.
import Ajv2020Module from 'ajv/dist/2020.js';
import mappingSchema from '../schema/n20s-mapping-0.1.schema.json' with { type: 'json' };
import specSchema from '../vendor/ontology-graph-spec-1.1.0.schema.json' with { type: 'json' };
import { indexLpg, contentHash, defaultDatatype, datatypeCompatible, xsdDerivesFrom } from './lpg.js';
import { expand, expandTemplate, parseTemplate, ambiguousSeparator, shorten, N20S_PLACEHOLDER_NAME } from './iri.js';
import { diffLock } from './lock.js';
import { writtenPaths, WRITE_BACK_TOOL } from './writeback.js';
import { resolve, statusOf as status, isActive as active } from './resolve.js';

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDFS_LITERAL = 'http://www.w3.org/2000/01/rdf-schema#Literal';
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

let validators;
function getValidators() {
  if (!validators) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validators = { mapping: ajv.compile(mappingSchema), spec: ajv.compile(specSchema) };
  }
  return validators;
}

const entries = (o) => Object.entries(o ?? {});

function schemaMessages(errors) {
  // if/then/else produce a summary error on top of the real one; keep the real ones.
  return errors
    .filter((e) => e.keyword !== 'if')
    .map((e) => {
      const extra = e.params?.additionalProperty ? `: "${e.params.additionalProperty}"`
        : e.params?.allowedValues ? `: ${e.params.allowedValues.join(', ')}` : '';
      return { path: e.instancePath.replace(/^\//, '') || '(root)', message: `${e.message}${extra}` };
    });
}

/**
 * @param {object} input
 * @param {object} input.mapping        parsed mapping file
 * @param {object} input.lpgDoc         parsed spec document
 * @param {object|null} [input.targets] result of indexTargets(), or null
 * @param {Array<{namespace: string, location: string|null, error?: string}>} [input.targetStatus]
 * @param {Record<string, {found: boolean, sha256?: string}>} [input.artifactInfo] local rule and shape files
 * @param {object|null} [input.lock]    parsed lock file, or null
 */
export async function check({ mapping, lpgDoc, targets = null, targetStatus = [], artifactInfo = {}, lock = null }) {
  const findings = [];
  const add = (severity) => (code, path, message, data) => findings.push({ severity, code, path, message, ...(data ? { data } : {}) });
  const error = add('error');
  const warn = add('warning');
  const info = add('info');
  const done = (extra = {}) => {
    findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.path.localeCompare(b.path));
    const count = (s) => findings.filter((f) => f.severity === s).length;
    const summary = { errors: count('error'), warnings: count('warning'), infos: count('info') };
    return { ok: summary.errors === 0, summary, findings, ...extra };
  };

  const v = getValidators();
  if (!v.mapping(mapping)) {
    for (const m of schemaMessages(v.mapping.errors)) error('schema.invalid', m.path, m.message);
    return done();
  }
  if (!v.spec(lpgDoc)) {
    for (const m of schemaMessages(v.spec.errors).slice(0, 20)) {
      error('lpg.schema-invalid', `lpg/${m.path}`, `The LPG ontology does not follow the Ontology Graph Spec 1.1.0: ${m.message}.`);
    }
  }

  const idx = indexLpg(lpgDoc);
  const hash = await contentHash(lpgDoc);
  const P = mapping.prefixes;
  const short = (iri) => shorten(iri, P);
  const list = (iris) => iris.map(short).join(', ') || 'nothing';
  const nodeEntries = mapping.nodes ?? {};
  const relEntries = mapping.relationships ?? {};

  // Header ------------------------------------------------------------------
  if (mapping.lpgOntology.id !== lpgDoc.id) {
    error('ref.ontology-id', 'lpgOntology/id', `The mapping is for "${mapping.lpgOntology.id}", the document is "${lpgDoc.id}".`);
  }
  if (String(mapping.lpgOntology.version) !== String(lpgDoc.version)) {
    warn('drift.version-changed', 'lpgOntology/version', `The mapping was locked against version ${mapping.lpgOntology.version}; the document is version ${lpgDoc.version}. Review the drift findings, then run lock.`);
  }
  for (const n of idx.nodes.values()) {
    const missing = idx.unresolvedImplied(n.id);
    if (missing.length) warn('lpg.unresolved-implied', `lpg/nodes/${n.id}`, `Implied label(s) ${missing.join(', ')} match no node of the document: subjects and classes cannot be inherited through them.`);
  }

  // Targets -----------------------------------------------------------------
  for (const t of targetStatus) {
    if (t.error) error('target.load-failed', 'targets', `Cannot load ${t.location} (${t.namespace}): ${t.error}`);
    else if (!t.location) info('target.unchecked', 'targets', `No file for ${t.namespace}: its terms are not checked.`);
  }
  for (const f of targets?.failed ?? []) error('target.load-failed', 'targets', `Cannot parse the ontology for ${f.namespace}: ${f.error}`);

  // Classes and predicates outside the targets are fine only from the RDF core vocabularies (rdf, rdfs, owl, xsd).
  const STANDARD = ['http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'http://www.w3.org/2000/01/rdf-schema#', 'http://www.w3.org/2002/07/owl#', 'http://www.w3.org/2001/XMLSchema#'];
  const declared = (iri) => !!(iri && targets?.namespaceOf(iri) && targets.isDeclared(iri));
  /** Expands a reference and checks it against the targets. */
  function iriOf(ref, path, role) {
    const r = expand(ref, P);
    if (r.error) {
      error('iri.unknown-prefix', path, `Prefix "${r.prefix}" is not declared.`);
      return null;
    }
    const ns = targets?.namespaceOf(r.iri);
    if (ns) {
      if (!targets.isDeclared(r.iri)) error('target.unknown-term', path, `${short(r.iri)} is not declared in ${ns}.`);
      else if (role === 'class' && !targets.isClass(r.iri)) error('target.not-a-class', path, `${short(r.iri)} is not a class.`);
      else if (role === 'property' && !targets.isProperty(r.iri)) error('target.not-a-property', path, `${short(r.iri)} is not a property.`);
    } else if (targets && ['class', 'property'].includes(role) && !STANDARD.some((n) => r.iri.startsWith(n))) {
      // A class or predicate from a vocabulary that is no target (qudt:unit when only SOSA is): nothing says it exists.
      error('target.unknown-term', path, `${short(r.iri)} is in no target ontology (targets: ${targets.namespaces?.join(', ') ?? 'none'}).`);
    }
    return r.iri;
  }
  // rdfs:domain and rdfs:range entail; schema:domainIncludes and rangeIncludes (SOSA) only suggest:
  // a softer warning with its own code, when the classes match none of the suggested ones.
  // `node` is the node kind whose classes are checked: the conflict may come from its typing rather than
  // from the predicate, so the finding names it (data.node) and the review credits that decision too.
  const typing = (node, side, expected, classes) => (node ? { node, side, expected: expected.map(short), typed: classes.map(short) } : undefined);
  function checkDomain(pred, classes, path, node = null) {
    if (!declared(pred)) return;
    const d = targets.satisfies(targets.domains(pred), classes);
    if (d.ok === false) warn('target.domain', path, `The domain of ${short(pred)} is ${list(d.expected)}; the subject is typed ${list(classes)}.`, typing(node, 'domain', d.expected, classes));
    const di = targets.satisfies(targets.domainIncludes?.(pred) ?? [], classes);
    if (di.ok === false) warn('target.domain-includes', path, `${short(pred)} is meant for ${list(di.expected)} (schema:domainIncludes); the subject is typed ${list(classes)}.`, typing(node, 'domain', di.expected, classes));
  }
  function checkRange(pred, classes, path, node = null) {
    if (!declared(pred)) return;
    const r = targets.satisfies(targets.ranges(pred), classes);
    if (r.ok === false) warn('target.range', path, `The range of ${short(pred)} is ${list(r.expected)}; the object is typed ${list(classes)}.`, typing(node, 'range', r.expected, classes));
    const ri = targets.satisfies(targets.rangeIncludes?.(pred) ?? [], classes);
    if (ri.ok === false) warn('target.range-includes', path, `${short(pred)} is meant to point to ${list(ri.expected)} (schema:rangeIncludes); the object is typed ${list(classes)}.`, typing(node, 'range', ri.expected, classes));
  }

  // Subjects and classes, with inheritance through implied labels ------------
  const { ownSubject, subjectSources, effectiveSubject, effectiveClasses } = resolve(mapping, idx, active);

  for (const n of idx.nodes.values()) {
    const templates = [...new Set(subjectSources(n.id).map((s) => ownSubject.get(s)))];
    if (templates.length > 1) {
      error('subject.conflict', `nodes/${n.id}`, `Nodes of kind "${n.id}" would get several IRIs: ${subjectSources(n.id).map((s) => `${s} uses ${ownSubject.get(s)}`).join('; ')}. Keep one subject per hierarchy.`);
    }
  }
  const byTemplate = new Map();
  for (const [id, t] of ownSubject) byTemplate.set(t, [...(byTemplate.get(t) ?? []), id]);
  for (const [t, ids] of byTemplate) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i], ids[j]];
      if (!idx.ancestors(a).includes(b) && !idx.ancestors(b).includes(a)) {
        warn('subject.shared-pattern', `nodes/${b}/subject`, `"${a}" and "${b}" both use ${t} and do not imply one another. Their uniqueness constraints are separate, so two nodes with the same values would become one resource.`);
      }
    }
  }

  function checkPlaceholderName(name, path) {
    if (!name.split('.').every((s) => N20S_PLACEHOLDER_NAME.test(s))) {
      warn('compile.placeholder-name', path, `Database name "${name}" is not a valid n20s placeholder; the scope query must alias it.`);
    }
  }

  function checkTemplateHead(template, path) {
    const r = expandTemplate(template, P);
    if (r.error) error('iri.unknown-prefix', path, `Prefix "${r.prefix}" is not declared.`);
    const { parts, placeholders } = parseTemplate(template);
    const amb = ambiguousSeparator(parts);
    if (amb) {
      error('subject.not-invertible', path, amb.separator
        ? `{${amb.before}} and {${amb.after}} are separated by "${amb.separator}", which values can also contain: the IRI cannot be parsed back into values.`
        : `{${amb.before}} and {${amb.after}} are adjacent: the IRI cannot be parsed back into values.`);
    }
    return placeholders;
  }

  function checkNodeSubject(nodeId, template, path) {
    const placeholders = checkTemplateHead(template, path);
    for (const ph of placeholders) {
      const f = ph.includes('.') ? null : idx.findNodeProperty(nodeId, ph);
      if (!f) {
        error('subject.unknown-placeholder', path, `{${ph}} is not a property id of "${nodeId}" or of a node it implies.`);
        continue;
      }
      if (!idx.isRequired(nodeId, ph)) warn('subject.optional-placeholder', path, `{${ph}} is not required on "${nodeId}": nodes without it are silently left out of the projection.`);
      checkPlaceholderName(f.prop.name, path);
    }
    const phs = new Set(placeholders);
    if (!idx.uniqueSets(nodeId).some((s) => s.length && s.every((k) => phs.has(k)))) {
      warn('subject.not-unique', path, `No uniqueness or key constraint covers {${placeholders.join('}, {')}}: distinct nodes may get the same IRI.`);
    }
  }

  function checkQualifiedSubject(rel, template, path) {
    const placeholders = checkTemplateHead(template, path);
    const used = { start: [], end: [] };
    for (const ph of placeholders) {
      const m = /^(start|end)\.([^.]+)$/.exec(ph);
      if (m) {
        const nodeId = m[1] === 'start' ? rel.from : rel.to;
        const f = idx.findNodeProperty(nodeId, m[2]);
        if (!f) { error('subject.unknown-placeholder', path, `{${ph}}: "${nodeId}" has no property "${m[2]}".`); continue; }
        used[m[1]].push(m[2]);
        if (!idx.isRequired(nodeId, m[2])) warn('subject.optional-placeholder', path, `{${ph}} is not required on "${nodeId}": relationships whose ${m[1]} node lacks it are left out.`);
        checkPlaceholderName(f.prop.name, path);
      } else if (!ph.includes('.') && rel.props.has(ph)) {
        if (!rel.props.get(ph).mustExist) warn('subject.optional-placeholder', path, `{${ph}} is not required on "${rel.id}": relationships without it are left out.`);
        checkPlaceholderName(rel.props.get(ph).name, path);
      } else {
        error('subject.unknown-placeholder', path, `{${ph}}: use {start.<property id>}, {end.<property id>} or a property id of "${rel.id}".`);
      }
    }
    const covers = (nodeId, keys) => idx.uniqueSets(nodeId).some((s) => s.length && s.every((k) => keys.includes(k)));
    for (const end of ['start', 'end']) {
      const nodeId = end === 'start' ? rel.from : rel.to;
      if (used[end].length && !covers(nodeId, used[end])) {
        warn('subject.not-unique', path, `The ${end} values {${used[end].map((k) => `${end}.${k}`).join('}, {')}} do not identify a "${nodeId}" node.`);
      }
    }
    const s = used.start.length > 0;
    const e = used.end.length > 0;
    if (s && !e && !(rel.fromMax !== null && rel.fromMax <= 1)) {
      warn('qualified.not-unique', path, `Only start-node values: several ${rel.type} relationships from one "${rel.from}" node would share one resource. The LPG ontology does not cap them at one per start node.`);
    } else if (e && !s && !(rel.toMax !== null && rel.toMax <= 1)) {
      warn('qualified.not-unique', path, `Only end-node values: several ${rel.type} relationships to one "${rel.to}" node would share one resource. The LPG ontology does not cap them at one per end node.`);
    } else if (!s && !e) {
      warn('qualified.not-unique', path, `The subject uses neither start nor end values: unrelated relationships may share one resource.`);
    }
  }

  function checkPropertyMapping(pe, prop, path, subjectClasses, node = null) {
    const pred = iriOf(pe.predicate, `${path}/predicate`, 'property');
    const emitsIri = !!pe.values || pe.kind === 'iri';
    if (declared(pred)) {
      if (!emitsIri && targets.isObjectProperty(pred) && !targets.isDatatypeProperty(pred)) {
        warn('target.kind-mismatch', `${path}/predicate`, `${short(pred)} is an object property, but this entry emits a literal.`);
      }
      if (emitsIri && targets.isDatatypeProperty(pred) && !targets.isObjectProperty(pred)) {
        warn('target.kind-mismatch', `${path}/predicate`, `${short(pred)} is a datatype property, but this entry emits an IRI.`);
      }
      checkDomain(pred, subjectClasses, `${path}/predicate`, node);
    }
    if (!emitsIri) {
      let dt = null;
      if (pe.datatype) {
        dt = iriOf(pe.datatype, `${path}/datatype`, 'datatype');
        if (dt && datatypeCompatible(prop.type, dt) === false) {
          warn('datatype.incompatible', `${path}/datatype`, `${short(dt)} does not fit the Neo4j type ${prop.type}.`);
        }
      } else {
        dt = defaultDatatype(prop.type);
        if (!dt && prop.type) warn('datatype.no-default', path, `No default datatype for the Neo4j type ${prop.type}: set one, or reshape the value in the scope query.`);
      }
      if (dt && declared(pred)) {
        const xsdRanges = targets.ranges(pred).filter((r) => r.iri && (r.iri.startsWith(XSD) || r.iri === RDFS_LITERAL));
        if (xsdRanges.length && !xsdRanges.some((r) => r.iri === RDFS_LITERAL || xsdDerivesFrom(dt, r.iri))) {
          warn('target.range', `${path}${pe.datatype ? '/datatype' : ''}`, `The range of ${short(pred)} is ${list(xsdRanges.map((r) => r.iri))}; this entry writes ${short(dt)}${pe.datatype ? '' : ' (default for ' + prop.type + ')'}.`);
        }
      }
    }
    if (pe.values) {
      for (const [value, ref] of entries(pe.values)) {
        iriOf(ref, `${path}/values/${value}`, 'any');
        if (prop.oneOf && !prop.oneOf.includes(value)) {
          error('values.unknown-value', `${path}/values/${value}`, `"${value}" is not one of ${prop.oneOf.join(', ')}: it never occurs.`);
        }
      }
      const missing = (prop.oneOf ?? []).filter((v) => !Object.hasOwn(pe.values, v));
      if (missing.length) warn('values.uncovered', `${path}/values`, `${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no entry: ${missing.length > 1 ? 'they emit' : 'it emits'} nothing.`);
    }
    checkPlaceholderName(prop.name, path);
  }

  // Nodes --------------------------------------------------------------------
  for (const [id, e] of entries(nodeEntries)) {
    const base = `nodes/${id}`;
    if (!idx.nodes.has(id)) {
      // Left out as written back, and gone from the export: reported once, below (write.undeclared).
      if (e?.meta?.proposedBy?.name !== WRITE_BACK_TOOL) error('ref.unknown-node', base, `No node "${id}" in ${lpgDoc.id} v${lpgDoc.version}.`);
      continue;
    }
    if (!active(e)) continue;
    if (e.subject) checkNodeSubject(id, e.subject, `${base}/subject`);
    (e.classes ?? []).forEach((c, i) => iriOf(c, `${base}/classes/${i}`, 'class'));
    const emits = (e.classes?.length ?? 0) > 0 || Object.values(e.properties ?? {}).some(active);
    if (emits && !effectiveSubject(id)) {
      error('subject.missing', base, `"${id}" has no subject and inherits none: nothing it maps can be emitted.`);
    }
    const classes = effectiveClasses(id);
    for (const [pid, pe] of entries(e.properties)) {
      const path = `${base}/properties/${pid}`;
      const found = idx.findNodeProperty(id, pid);
      if (!found) { if (pe?.meta?.proposedBy?.name !== WRITE_BACK_TOOL) error('ref.unknown-property', path, `"${id}" has no property "${pid}", own or implied.`); continue; }
      if (active(pe)) checkPropertyMapping(pe, found.prop, path, classes, id);
    }
  }

  // Relationships --------------------------------------------------------------
  for (const [id, e] of entries(relEntries)) {
    const base = `relationships/${id}`;
    const rel = idx.rels.get(id);
    if (!rel) {
      if (e?.meta?.proposedBy?.name !== WRITE_BACK_TOOL) error('ref.unknown-relationship', base, `No relationship "${id}" in ${lpgDoc.id} v${lpgDoc.version}.`);
      continue;
    }
    if (!active(e)) continue;
    for (const [end, nodeId] of [['start', rel.from], ['end', rel.to]]) {
      if (!idx.nodes.has(nodeId)) error('lpg.unknown-endpoint', base, `The ${end} node "${nodeId}" of "${id}" is not in the document.`);
      else if (!effectiveSubject(nodeId)) error('rel.endpoint-no-subject', base, `The ${end} node kind "${nodeId}" has no subject, own or inherited: this relationship cannot be emitted.`);
    }
    const reverse = e.direction === 'reverse';
    const [subjectNode, objectNode] = reverse ? [rel.to, rel.from] : [rel.from, rel.to];
    const subjectClasses = effectiveClasses(subjectNode);
    const objectClasses = effectiveClasses(objectNode);
    if (e.predicate) {
      const pred = iriOf(e.predicate, `${base}/predicate`, 'property');
      if (declared(pred) && targets.isDatatypeProperty(pred) && !targets.isObjectProperty(pred)) {
        warn('target.kind-mismatch', `${base}/predicate`, `${short(pred)} is a datatype property; a relationship needs an object property.`);
      }
      checkDomain(pred, subjectClasses, `${base}/predicate`, subjectNode);
      checkRange(pred, objectClasses, `${base}/predicate`, objectNode);
    }
    let qualifiedClasses = [];
    if (e.qualified) {
      const q = e.qualified;
      const qp = `${base}/qualified`;
      checkQualifiedSubject(rel, q.subject, `${qp}/subject`);
      const cls = iriOf(q.class, `${qp}/class`, 'class');
      if (cls) qualifiedClasses = [cls];
      const link = iriOf(q.link, `${qp}/link`, 'property');
      checkDomain(link, subjectClasses, `${qp}/link`, subjectNode);
      checkRange(link, qualifiedClasses, `${qp}/link`);
      const target = iriOf(q.target, `${qp}/target`, 'property');
      checkDomain(target, qualifiedClasses, `${qp}/target`);
      checkRange(target, objectClasses, `${qp}/target`, objectNode);
    }
    for (const [pid, pe] of entries(e.properties)) {
      const path = `${base}/properties/${pid}`;
      const prop = rel.props.get(pid);
      if (!prop) { error('ref.unknown-property', path, `"${id}" has no property "${pid}".`); continue; }
      if (!active(pe)) continue;
      if (!e.qualified) {
        error('rel.property-without-qualified', path, `A relationship property needs a qualified pattern to attach to; without one it has no subject.`);
        continue;
      }
      checkPropertyMapping(pe, prop, path, qualifiedClasses);
    }
  }

  // Write-back -------------------------------------------------------------------
  // Names a recipe writes back (inferred), their provenance and the ledger are not data to ingest.
  const written = writtenPaths(lpgDoc);
  const entryAt = (p) => {
    const [section, id, , pid] = p.split('/');
    const e = (section === 'nodes' ? nodeEntries : relEntries)[id];
    return pid ? e?.properties?.[pid] : e;
  };
  for (const [p, why] of written) {
    const e = entryAt(p);
    if (e && active(e)) error('mapping.inferred-mapped', p, `${why} Mapping it would project back what reasoning wrote: ignore it.`);
  }
  // Left out by propose because the ontology declared them written back, and the ontology no longer does: an export that lost its declarations.
  const lost = [];
  for (const [section, list] of [['nodes', nodeEntries], ['relationships', relEntries]]) {
    for (const [id, e] of Object.entries(list)) {
      if (e?.meta?.proposedBy?.name === WRITE_BACK_TOOL && !written.has(`${section}/${id}`)) lost.push(`${section}/${id}`);
      for (const [pid, pe] of Object.entries(e?.properties ?? {})) if (pe?.meta?.proposedBy?.name === WRITE_BACK_TOOL && !written.has(`${section}/${id}/properties/${pid}`)) lost.push(`${section}/${id}/properties/${pid}`);
    }
  }
  if (lost.length) {
    error('write.undeclared', 'lpgOntology', `The LPG ontology no longer declares ${lost.length} written-back element${lost.length === 1 ? '' : 's'} the mapping leaves out (${lost.join(', ')}): the export lost its write-back declarations. Run \`n20s-mapping write-patch\` (or Ontology patch in the studio), apply it, and re-apply it in the Aura ontology.`, { paths: lost });
  }

  // Rule and shape files -------------------------------------------------------
  for (const [kind, refs] of [['rules', mapping.rules], ['shapes', mapping.shapes]]) {
    (refs ?? []).forEach((ref, i) => {
      const path = `${kind}/${i}`;
      const a = artifactInfo[ref.location];
      if (!a) info('artifact.unchecked', path, `${ref.location} is not a local file: not checked.`);
      else if (!a.found) error('artifact.missing', path, `${ref.location} does not exist.`);
      else if (ref.sha256 && a.sha256 !== ref.sha256) error('artifact.hash-mismatch', path, `${ref.location} has changed since its sha256 was recorded.`);
    });
  }

  // Drift --------------------------------------------------------------------------
  if (lock) diffLock(lock, idx, hash, mapping, { error, warn, info });
  else info('drift.no-lock', 'lock', 'No lock file: run lock to record the LPG ontology this mapping was checked against.');

  // Coverage -------------------------------------------------------------------------
  const coverage = computeCoverage(idx, nodeEntries, relEntries, effectiveSubject);
  return done({ coverage, lpg: { id: idx.id, version: String(idx.version), contentHash: hash } });
}

function category(e) {
  if (!e) return null;
  const s = status(e);
  if (s !== 'accepted') return s === 'proposed' ? 'proposed' : null;
  return e.ignore ? (e.ignore.deferred ? 'deferred' : 'ignored') : 'mapped';
}

/**
 * Where each element of the LPG ontology stands. Decided: mapped, ignored,
 * deferred, subject (used in the IRI), inherited (handled through an implied
 * node). Pending: proposed (awaiting review), undecided.
 */
function computeCoverage(idx, nodeEntries, relEntries, effectiveSubject) {
  const counts = () => ({ total: 0 });
  const cov = { nodes: counts(), nodeProperties: counts(), relationships: counts(), relationshipProperties: counts(), undecided: [], proposed: [] };
  const tally = (bucket, cat, path) => {
    bucket.total++;
    bucket[cat] = (bucket[cat] ?? 0) + 1;
    if (cat === 'undecided') cov.undecided.push(path);
    if (cat === 'proposed') cov.proposed.push(path);
  };

  for (const n of idx.nodes.values()) {
    const e = nodeEntries[n.id];
    const subject = effectiveSubject(n.id);
    tally(cov.nodes, category(e) ?? (subject ? 'inherited' : 'undecided'), `nodes/${n.id}`);
    const inSubject = new Set(subject ? [...subject.template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]) : []);
    for (const p of n.props.values()) {
      const pe = e?.properties?.[p.id];
      // An alias (same database name and type as an inherited property) is that property.
      const ids = [p.id, idx.aliasOf(n.id, p.id)?.prop.id].filter(Boolean);
      let c = category(pe);
      if (!c && e?.ignore) c = category(e);
      if (!c && ids.some((id) => inSubject.has(id))) c = 'subject';
      if (!c && idx.ancestors(n.id).some((a) => ids.some((id) => category(nodeEntries[a]?.properties?.[id])))) c = 'inherited';
      tally(cov.nodeProperties, c ?? 'undecided', `nodes/${n.id}/properties/${p.id}`);
    }
  }
  for (const r of idx.rels.values()) {
    const e = relEntries[r.id];
    tally(cov.relationships, category(e) ?? 'undecided', `relationships/${r.id}`);
    for (const p of r.props.values()) {
      let c = category(e?.properties?.[p.id]);
      if (!c && e?.ignore) c = category(e);
      tally(cov.relationshipProperties, c ?? 'undecided', `relationships/${r.id}/properties/${p.id}`);
    }
  }
  return cov;
}
