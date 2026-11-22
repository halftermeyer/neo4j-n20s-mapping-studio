#!/usr/bin/env node
// The lineage set: node eval/propose-lineage.js [options] is
// node eval/propose-eval.js --set examples/lineage [options].
process.argv.splice(2, 0, '--set', 'examples/lineage');
await import('./propose-eval.js');
