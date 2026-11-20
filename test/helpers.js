import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { check, indexTargets, indexLpg, contentHash, buildLock } from '../src/index.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXAMPLE = path.join(ROOT, 'examples/lineage');

export const baseMapping = YAML.parse(fs.readFileSync(path.join(EXAMPLE, 'lineage-prov.mapping.yaml'), 'utf8'));
export const baseDoc = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'data-lineage-ontology.json'), 'utf8'));
export const prov = indexTargets([{
  namespace: 'http://www.w3.org/ns/prov#',
  text: fs.readFileSync(path.join(EXAMPLE, 'targets/prov.nq'), 'utf8'),
  format: 'N-Quads',
}]);

export async function lockFor(doc) {
  return buildLock(indexLpg(doc), await contentHash(doc));
}

/**
 * Runs check() on mutated copies of the example.
 * @param {{mapping?: (m: object) => void, doc?: (d: object) => void, lock?: 'base'|'none'|object}} opts
 */
export async function run({ mapping, doc, lock = 'base' } = {}) {
  const m = structuredClone(baseMapping);
  const d = structuredClone(baseDoc);
  mapping?.(m);
  doc?.(d);
  const l = lock === 'base' ? await lockFor(baseDoc) : lock === 'none' ? null : lock;
  return check({ mapping: m, lpgDoc: d, targets: prov, lock: l });
}

export const codes = (res, severity) => res.findings.filter((f) => !severity || f.severity === severity).map((f) => f.code);
export const find = (res, code, pathPrefix = '') => res.findings.filter((f) => f.code === code && f.path.startsWith(pathPrefix));

// The Aura export of the same model (ids n:0, r:0, p:0) and the gold moved onto it.
export const auraDoc = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'aura-export.json'), 'utf8'));
export const auraGold = YAML.parse(fs.readFileSync(path.join(EXAMPLE, 'lineage-prov.aura.mapping.yaml'), 'utf8'));
export const auraBlank = () => ({ ...structuredClone(auraGold), nodes: {}, relationships: {} });

/** A provider answer that repeats the gold decision for the requested element. */
export function goldAnswer(gold) {
  return (req) => {
    const [section, id] = req.element.split('/');
    const g = gold[section][id] ?? {};
    const dec = (e) => (e?.ignore ? { decision: e.ignore.deferred ? 'defer' : 'ignore', reason: e.ignore.reason } : { decision: 'map' });
    const answer = { ...dec(g), rationale: 'gold', confidence: 1 };
    if (!g.ignore) {
      if (g.classes) answer.classes = g.classes;
      if (g.predicate) answer.predicate = g.predicate;
      if (g.direction) answer.direction = g.direction;
      if (g.qualified) answer.qualified = { class: g.qualified.class, link: g.qualified.link, target: g.qualified.target };
    }
      answer.properties = [];
    for (const pid of req.schema.properties.properties?.items.properties.id.enum ?? []) {
      const pe = g.properties?.[pid];
      const pa = { ...(pe ? dec(pe) : { decision: 'ignore', reason: 'Not in the gold.' }), rationale: 'gold', confidence: 1 };
      if (pe && !pe.ignore) {
        pa.predicate = pe.predicate;
        if (pe.datatype) pa.datatype = pe.datatype;
        if (pe.values) { pa.asIris = true; pa.exampleValues = Object.keys(pe.values); }
      }
      answer.properties.push({ id: pid, ...pa });
    }
    return answer;
  };
}
