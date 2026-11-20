import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { run, codes, find, baseDoc, lockFor } from './helpers.js';

describe('lineage -> PROV example', () => {
  test('is clean, fully decided, and has no drift against its own lock', async () => {
    const res = await run();
    assert.deepEqual(res.findings, []);
    assert.equal(res.ok, true);
    assert.deepEqual(res.coverage.undecided, []);
    assert.equal(res.coverage.nodes.total, 13);
    assert.equal(res.coverage.relationships.total, 17);
  });

  test('without a lock, only says so', async () => {
    const res = await run({ lock: 'none' });
    assert.deepEqual(codes(res), ['drift.no-lock']);
  });

  test('qualified subject from the start node only is fine when the start side is capped at one (WAS_GENERATED_BY)', async () => {
    const res = await run();
    assert.equal(find(res, 'qualified.not-unique').length, 0);
  });
});

describe('schema and references', () => {
  test('rejects unknown fields and datatype with a value table', async () => {
    const res = await run({ mapping: (m) => {
      m.nodes.run.properties.startedAt = { predicat: 'prov:startedAtTime' };
      m.relationships.used.properties.role.datatype = 'xsd:string';
    } });
    assert.ok(codes(res).every((c) => c === 'schema.invalid'));
    assert.ok(res.findings.some((f) => f.path === 'nodes/run/properties/startedAt'));
    assert.ok(res.findings.some((f) => f.path === 'relationships/used/properties/role'));
  });

  test('unknown node, relationship and property ids', async () => {
    const res = await run({ mapping: (m) => {
      m.nodes.datasett = { classes: ['prov:Entity'] };
      m.relationships['use'] = { predicate: 'prov:used' };
      m.nodes['dataset-version'].properties.generatedAT = { predicate: 'prov:generatedAtTime' };
    } });
    assert.equal(find(res, 'ref.unknown-node', 'nodes/datasett').length, 1);
    assert.equal(find(res, 'ref.unknown-relationship', 'relationships/use').length, 1);
    assert.equal(find(res, 'ref.unknown-property', 'nodes/dataset-version/properties/generatedAT').length, 1);
  });

  test('mapping for another LPG ontology', async () => {
    const res = await run({ mapping: (m) => { m.lpgOntology.id = 'other'; } });
    assert.equal(find(res, 'ref.ontology-id').length, 1);
  });

  test('invalid LPG ontology', async () => {
    const res = await run({ doc: (d) => { d.nodes.run.colour = 'blue'; } });
    assert.ok(find(res, 'lpg.schema-invalid', 'lpg/nodes/run').length >= 1);
  });

  test('undeclared prefix', async () => {
    const res = await run({ mapping: (m) => { m.nodes.entity.classes = ['provo:Entity']; } });
    assert.equal(find(res, 'iri.unknown-prefix', 'nodes/entity/classes/0').length, 1);
  });
});

describe('subjects', () => {
  test('adjacent placeholders and unreserved separators cannot be parsed back', async () => {
    const res = await run({ mapping: (m) => {
      m.nodes.entity.subject = 'lin:entity/{id}{id}';
      m.relationships.used.qualified.subject = 'lin:usage/{start.id}-{end.id}';
    } });
    assert.equal(find(res, 'subject.not-invertible', 'nodes/entity/subject').length, 1);
    assert.equal(find(res, 'subject.not-invertible', 'relationships/used/qualified/subject').length, 1);
  });

  test('a subtype with its own, different subject conflicts with the inherited one', async () => {
    const res = await run({ mapping: (m) => { m.nodes.dataset.subject = 'lin:dataset/{id}'; } });
    assert.equal(find(res, 'subject.conflict', 'nodes/dataset').length, 1);
  });

  test('the same pattern on unrelated kinds is flagged', async () => {
    const res = await run({ mapping: (m) => { m.nodes.activity.subject = 'lin:entity/{id}'; } });
    assert.equal(find(res, 'subject.shared-pattern').length, 1);
  });

  test('unknown, optional and non-identifying placeholders', async () => {
    const res = await run({ mapping: (m) => {
      m.nodes.entity.subject = 'lin:entity/{uid}';
      m.nodes.agent.subject = 'lin:agent/{name}';
    } });
    assert.equal(find(res, 'subject.unknown-placeholder', 'nodes/entity/subject').length, 1);
    assert.equal(find(res, 'subject.optional-placeholder', 'nodes/agent/subject').length, 1);
    assert.equal(find(res, 'subject.not-unique', 'nodes/agent/subject').length, 1);
  });

  test('without a subject, a kind and its relationships cannot be emitted', async () => {
    const res = await run({ mapping: (m) => { delete m.nodes.agent.subject; } });
    assert.equal(find(res, 'subject.missing', 'nodes/agent').length, 1);
    assert.equal(find(res, 'subject.missing', 'nodes/person').length, 1);
    assert.ok(find(res, 'rel.endpoint-no-subject', 'relationships/was-associated-with').length >= 1);
  });

  test('a qualified subject from the start node only, without a cap, collapses relationships', async () => {
    const res = await run({ mapping: (m) => { m.relationships['was-attributed-to'].qualified.subject = 'lin:attribution/{start.id}'; } });
    assert.equal(find(res, 'qualified.not-unique', 'relationships/was-attributed-to').length, 1);
  });

  test('database names that are not n20s placeholders', async () => {
    const res = await run({ doc: (d) => { d.nodes.dataset.properties.name.name = 'dataset name'; } });
    assert.equal(find(res, 'compile.placeholder-name', 'nodes/dataset/properties/name').length, 1);
  });
});

describe('properties and values', () => {
  test('values outside one_of, and one_of values left out', async () => {
    const res = await run({ mapping: (m) => {
      m.nodes.run.properties.status = { predicate: 'lin:status', values: { DONE: 'lin:status/done', SUCCESS: 'lin:status/success' } };
    } });
    assert.equal(find(res, 'values.unknown-value', 'nodes/run/properties/status/values/DONE').length, 1);
    const uncovered = find(res, 'values.uncovered', 'nodes/run/properties/status');
    assert.equal(uncovered.length, 1);
    assert.match(uncovered[0].message, /RUNNING, FAILED, ABORTED, PARTIAL/);
  });

  test('a relationship property needs a qualified pattern', async () => {
    const res = await run({ mapping: (m) => { delete m.relationships.used.qualified; } });
    assert.equal(find(res, 'rel.property-without-qualified', 'relationships/used/properties/role').length, 1);
  });

  test('datatype that does not fit the Neo4j type', async () => {
    const res = await run({ mapping: (m) => { m.nodes['dataset-version'].properties.generatedAt.datatype = 'xsd:date'; } });
    assert.equal(find(res, 'datatype.incompatible').length, 1);
    assert.equal(find(res, 'target.range', 'nodes/dataset-version/properties/generatedAt').length, 1);
  });
});

describe('target ontology', () => {
  test('invented terms, and terms used in the wrong role', async () => {
    const res = await run({ mapping: (m) => {
      m.relationships['was-informed-by'].predicate = 'prov:wasTriggeredBy';
      m.nodes.run.properties.startedAt.predicate = 'prov:Activity';
      m.nodes['job-version'].classes = ['prov:used'];
    } });
    assert.equal(find(res, 'target.unknown-term', 'relationships/was-informed-by/predicate').length, 1);
    assert.equal(find(res, 'target.not-a-property', 'nodes/run/properties/startedAt/predicate').length, 1);
    assert.equal(find(res, 'target.not-a-class', 'nodes/job-version/classes/0').length, 1);
  });

  test('a relationship mapped in the wrong direction breaks domain and range', async () => {
    const res = await run({ mapping: (m) => { m.relationships.used.predicate = 'prov:wasGeneratedBy'; } });
    assert.equal(find(res, 'target.domain', 'relationships/used/predicate').length, 1);
    assert.equal(find(res, 'target.range', 'relationships/used/predicate').length, 1);
  });

  test('direction: reverse fixes it', async () => {
    const res = await run({ mapping: (m) => {
      m.relationships['was-generated-by'] = { predicate: 'prov:generated', direction: 'reverse' };
    } });
    assert.deepEqual(codes(res, 'warning'), []);
    assert.deepEqual(codes(res, 'error'), []);
  });

  test('a literal on an object property', async () => {
    const res = await run({ mapping: (m) => { m.nodes.agent.properties.name = { predicate: 'prov:wasAttributedTo' }; } });
    assert.equal(find(res, 'target.kind-mismatch', 'nodes/agent/properties/name').length, 1);
  });

  test('structural checks do not catch a wrong meaning: DEPENDS_ON as prov:wasDerivedFrom passes', async () => {
    // Entity -> Entity fits the domain and range. Only a test against the data
    // (query 34: potential vs asserted dependencies) can catch this one.
    const res = await run({ mapping: (m) => { m.relationships['depends-on'] = { predicate: 'prov:wasDerivedFrom' }; } });
    assert.deepEqual(res.findings, []);
  });
});

describe('coverage', () => {
  test('missing entries are undecided; proposed entries await review', async () => {
    const res = await run({ mapping: (m) => {
      delete m.relationships['run-of'];
      delete m.nodes.run.properties.status;
      m.relationships['was-informed-by'].meta = { status: 'proposed', proposedBy: { kind: 'ai', model: 'any-model', promptVersion: 'bridge-v1' }, confidence: 0.8 };
    } });
    assert.deepEqual(res.coverage.undecided.sort(), ['nodes/run/properties/status', 'relationships/run-of']);
    assert.deepEqual(res.coverage.proposed, ['relationships/was-informed-by']);
  });

  test('a rejected entry counts as no entry', async () => {
    const res = await run({ mapping: (m) => { m.relationships['run-of'] = { predicate: 'prov:used', meta: { status: 'rejected' } }; } });
    assert.deepEqual(res.coverage.undecided, ['relationships/run-of']);
    assert.deepEqual(res.findings, []);
  });
});

describe('drift against the lock', () => {
  test('moving nodes in the modeling tool is not a change', async () => {
    const res = await run({ doc: (d) => { d.nodes.run.extensions.display.x += 120; } });
    assert.deepEqual(res.findings, []);
  });

  test('type change under a mapped property', async () => {
    const res = await run({ doc: (d) => {
      d.version = '4';
      d.nodes['dataset-version'].properties.generatedAt.type = 'STRING';
    } });
    assert.equal(find(res, 'drift.version-changed').length, 1);
    const w = find(res, 'drift.type-changed', 'nodes/dataset-version/properties/generatedAt');
    assert.equal(w.length, 1);
    assert.equal(w[0].severity, 'warning');
    assert.equal(find(res, 'datatype.incompatible').length, 1);
  });

  test('type change under an ignored property is information only', async () => {
    const res = await run({ doc: (d) => { d.nodes['dataset-version'].properties.validFrom.type = 'DATE'; } });
    assert.equal(find(res, 'drift.type-changed')[0].severity, 'info');
  });

  test('removed mapped property', async () => {
    const res = await run({ doc: (d) => { delete d.nodes.run.properties.endedAt; } });
    assert.equal(find(res, 'ref.unknown-property', 'nodes/run/properties/endedAt').length, 1);
    assert.equal(find(res, 'drift.property-removed', 'nodes/run/properties/endedAt').length, 1);
  });

  test('a node deleted and recreated in the modeling tool gets a new id', async () => {
    const res = await run({ doc: (d) => {
      d.nodes['job-version-2'] = d.nodes['job-version'];
      delete d.nodes['job-version'];
      d.relationships['version-of-job'].from.node = 'job-version-2';
      d.relationships['had-plan'].to.node = 'job-version-2';
    } });
    const r = find(res, 'drift.recreated', 'nodes/job-version');
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].data, { from: 'job-version', to: 'job-version-2' });
    assert.equal(find(res, 'ref.unknown-node', 'nodes/job-version').length, 1);
    assert.ok(res.coverage.undecided.includes('nodes/job-version-2/properties/codeRef'));
  });

  test('renamed label: the entry still applies', async () => {
    const res = await run({ doc: (d) => { d.nodes.dataset.labels.identifier = 'Asset'; } });
    assert.deepEqual(codes(res).sort(), ['drift.content-changed', 'drift.renamed']);
  });

  test('new node and relationship', async () => {
    const res = await run({ doc: (d) => {
      d.nodes.dashboard = { labels: { identifier: 'Dashboard', implied: ['Entity'] }, properties: { id: { type: 'STRING' } } };
      d.relationships.feeds = { type: 'FEEDS', from: { node: 'dataset' }, to: { node: 'dashboard' } };
    } });
    assert.equal(find(res, 'drift.added', 'nodes/dashboard').length, 1);
    assert.equal(find(res, 'drift.added', 'relationships/feeds').length, 1);
    assert.ok(res.coverage.undecided.includes('relationships/feeds'));
    assert.ok(!res.coverage.undecided.includes('nodes/dashboard'), 'inherits the Entity subject');
  });

  test('endpoints of a mapped relationship changed', async () => {
    const res = await run({ doc: (d) => { d.relationships.used.to.node = 'dataset'; } });
    assert.equal(find(res, 'drift.endpoints-changed', 'relationships/used')[0].severity, 'warning');
  });

  test('implied labels changed: the subject is no longer inherited', async () => {
    const res = await run({ doc: (d) => { d.nodes['column-version'].labels.implied = []; } });
    assert.equal(find(res, 'drift.implied-changed', 'nodes/column-version').length, 1);
    assert.equal(find(res, 'subject.missing', 'nodes/column-version').length, 1);
  });

  test('allowed values changed under a value table', async () => {
    const statusTable = (m) => {
      m.nodes.run.properties.status = { predicate: 'lin:status', values: Object.fromEntries(['RUNNING', 'SUCCESS', 'FAILED', 'ABORTED', 'PARTIAL'].map((v) => [v, `lin:status/${v}`])) };
    };
    const res = await run({ mapping: statusTable, doc: (d) => { d.nodes.run.properties.status.one_of.push('SKIPPED'); } });
    assert.equal(find(res, 'drift.values-changed', 'nodes/run/properties/status').length, 1);
    assert.match(find(res, 'values.uncovered')[0].message, /SKIPPED/);
  });

  test('a lock for another ontology', async () => {
    const other = await lockFor({ ...structuredClone(baseDoc), id: 'other' });
    const res = await run({ lock: other });
    assert.equal(find(res, 'drift.other-ontology').length, 1);
  });

  test('a lock older than the mapping header', async () => {
    const res = await run({ mapping: (m) => { m.lpgOntology.version = '2'; } });
    assert.equal(find(res, 'lock.stale').length, 1);
  });
});
