#!/usr/bin/env node
// Builds the starting mapping of act 2: the lineage → PROV-O mapping as a
// reviewer left it, every decision accepted, except eight relationship types
// that the AI proposed again (three passes) and that are still to review.
//
//   node demo/prepare-lineage.mjs            asks the model (GEMINI_API_KEY in .env) and records the answers
//   node demo/prepare-lineage.mjs --replay   rebuilds the same file from demo/recordings/lineage-propose.json
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadFiles, variantsPathFor } from '../src/node.js';
import { proposePasses } from '../src/propose.js';
import { geminiProvider, recordingProvider, replayProvider } from '../src/providers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'project/lineage');
const GOLD = path.join(DIR, 'lineage-prov.gold.yaml');
const OUT = path.join(DIR, 'lineage-prov.mapping.yaml');
const RECORDING = path.join(HERE, 'recordings/lineage-propose.json');
const KEYS = ['r:2', 'r:6', 'r:7', 'r:8', 'r:9', 'r:10', 'r:11', 'r:15'];

process.loadEnvFile(path.join(HERE, '../.env'));
const replay = process.argv.includes('--replay');
const l = await loadFiles(GOLD);
const mapping = structuredClone(l.mapping);
for (const k of KEYS) delete mapping.relationships[k];
let provider = replay ? replayProvider(JSON.parse(await fs.readFile(RECORDING, 'utf8'))) : recordingProvider(geminiProvider({ apiKey: process.env.GEMINI_API_KEY, model: 'gemini-2.5-flash' }));
const res = await proposePasses({ mapping, lpgDoc: l.lpgDoc, targets: l.targets, provider, prefix: 'lin', only: KEYS.map((k) => `relationships/${k}`), passes: 3,
  onProgress: (e) => { if (e.type === 'ask') console.error(`  pass ${e.pass} ${e.element}`); } });
if (!replay) await fs.writeFile(RECORDING, JSON.stringify(provider.recording, null, 1) + '\n');
const head = `# Data lineage to PROV-O, as a reviewer left it: every decision accepted, except the\n# relationship types the AI proposed again (${provider.model}, three passes), still to review.\n`;
await fs.writeFile(OUT, head + YAML.stringify(res.mapping, { lineWidth: 0 }));
await fs.writeFile(variantsPathFor(OUT), JSON.stringify(res.variants, null, 1) + '\n');
for (const k of KEYS) {
  const e = res.mapping.relationships[k];
  const v = res.variants.elements[`relationships/${k}`];
  console.log(k, l.lpgDoc.relationships[k].type.padEnd(20), e?.ignore ? `ignore (${e.ignore.reason})` : `${e?.predicate ?? '?'}${e?.qualified ? ' + qualified' : ''}`, v?.stable ? 'stable' : 'UNSTABLE', e?.meta?.confidence);
}
