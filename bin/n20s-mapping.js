#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkFiles, lockFiles, compileFiles, proposeFiles, sourceValues, variantsPathFor, loadRecipe, recordRecipeRun, graphsReport, registryPathFor, publishedResolver, republish, unpublishEndpoint, readOracle, readQueryArg, UsageError,
  openSource, splitStatements, defaultSource, writerFromEnv, writePatchFiles, adoptStep, freshnessOf, evidencePathFor, oraclePathFor, loadFiles,
} from '../src/node.js';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { recordingProvider, replayProvider, makeProvider, aiSettingsFromEnv, PROVIDERS } from '../src/providers.js';
import { connectionSettings } from '../src/settings.js';
import { follower, startFollowing, stopFollowing } from '../src/follow.js';
import { startStudio } from '../src/studio.js';
import { runRecipe, checkRecipe } from '../src/recipe.js';
import { serveEndpoints } from '../src/serve.js';
import { send, benchmark, checkBench } from '../src/bench.js';
import { readProject, projectStatus, introspectSource, fetchTarget, PROJECT_FORMAT } from '../src/workspace.js';
import { formatText } from '../src/report.js';
import { n20sClient } from '../src/n20s.js';
import { project, compareSources } from '../src/project.js';
import { runOracle, oracleEvidence, coverage } from '../src/oracle.js';
import { acceptAll } from '../src/propose.js';
import { compile } from '../src/compile.js';
import { contentHash } from '../src/lpg.js';
import { takeSnapshot } from '../src/snapshot.js';

const USAGE = `Usage:
  n20s-mapping check   <mapping> [--lpg <file>] [--lock <file>] [--json] [--strict] [--quiet]
  n20s-mapping lock    <mapping> [--lpg <file>] [--lock <file>] [--force]
  n20s-mapping compile <mapping> [--out <file>] [--force]
  n20s-mapping propose <mapping> --out <file> --prefix <p> [--base-iri <iri>] [--provider <id>] [--model <id>] [--passes <n>]
                       [--source <url>] [--no-descriptions] [--record <f>] [--replay <f>]
                       [--open-terms] [--no-repair] [--json]
  n20s-mapping status  <project.yaml> [--n20s <url>] [--json]
  n20s-mapping introspect <project.yaml> <source> [--source <url>]
  n20s-mapping fetch   <project.yaml> <target> [--repin]
  n20s-mapping studio  <mapping | project.yaml> [--mapping <id>] [--port <n>] [--reviewer <name>] [--oracle <oracle.yaml>]
                       [--source <url>] [--n20s <url>] [--prefix <p>] [--provider <id>] [--model <id>] [--recipes <dir>]
                       [--record <f>] [--replay <f>] [--mask-hosts] [--title <text>]
  n20s-mapping recipe  <recipe.yaml> [--param name=value]... [--source <url>] [--n20s <url>]
                       [--keep] [--proposals] [--json] [--check] [--write]
  n20s-mapping write-patch <recipe.yaml | recipes dir> [--apply] [--out <admin.cypher>] [--json]
  n20s-mapping adopt   <recipe.yaml> <step> [--source <url>] [--yes]
  n20s-mapping graphs  [<recipes dir>] [--n20s <url>] [--json]
  n20s-mapping serve   [<recipes dir>] [--port <n>] [--host <addr>] [--source <url>] [--n20s <url>] [--run] [--write]
  n20s-mapping bench   <bench.yaml> [--url <base>] [--only <id>]... [--iterations <n>] [--concurrency <n>] [--json]
  n20s-mapping republish <endpoint> [--recipes <dir>] [--source <url>] [--n20s <url>] [--write]
  n20s-mapping follow  <endpoint> [--recipes <dir>] [--source <url>] [--off]
  n20s-mapping unpublish <endpoint> [--recipes <dir>] [--n20s <url>]
  n20s-mapping project <mapping> [--source <url>] [--n20s <url>] [--graph <name>] [--force]
  n20s-mapping compare <mapping> --source <url> [--source <url>]
  n20s-mapping snapshot <mapping> [--oracle <oracle.yaml>] [--source <url>] --out <file>
  n20s-mapping load    <file.cypher>... [--source <url>]
  n20s-mapping query   <sparql | file> --graph <name> [--n20s <url>] [--json]
  n20s-mapping oracle  <oracle.yaml> [--mapping <file>] [--source <url>] [--n20s <url>]
                       [--graph <name>] [--skip-project] [--proposals] [--evidence] [--json]
  n20s-mapping coverage <mapping> [--oracle <oracle.yaml>] [--uncovered] [--json]

check    Validates the mapping against its LPG ontology, its target ontologies
         and its lock file, and reports coverage.
lock     Records the current LPG ontology in the lock file and updates
         lpgOntology.version in the mapping. Refuses on check errors, unless --force.
compile  Compiles accepted entries into a projection plan (Cypher row queries
         and n20s templates). Refuses on check errors, unless --force.
propose  Asks an AI model for the undecided elements and writes the mapping with
         its proposals (meta.status: proposed) to --out; the input is not
         changed. Subjects come from uniqueness constraints, qualified and
         value IRIs from the --prefix namespace (--base-iri declares it). With
         --source, value tables use the distinct values found there (they are
         not sent to the model). The model: --provider gemini|anthropic|openai
         (or N20S_AI_PROVIDER, else the provider whose key is set:
         GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY), --model (or
         N20S_AI_MODEL); N20S_AI_BASE_URL for an OpenAI-compatible server
         (Mistral, OpenRouter, Ollama…). --record keeps the answers; --replay
         answers from such a file, without a model. The spec of the mapping
         (<mapping>.spec.yaml, or --spec) drives it: elements out of scope are
         left out with their reason, the purpose, principles and notes go
         into the prompt. --passes n (n > 1) runs
         n passes: the first is the proposal, the others are written to
         <out>.variants.json, which says how stable each decision is.
status   A project (n20s-project.yaml): its LPG sources, RDF targets and
         mappings, and how each stands (coverage, check, drift, endpoints).
introspect Reads the database of a source of the project into an LPG
         ontology document (labels, implied labels, properties, relationship
         types, constraints), written to the source's file.
fetch    Downloads a target of the project from its URL or the catalog into
         targets/, pinned by SHA-256 in n20s-project.lock.json (--repin
         accepts a changed document).
studio   Serves a local page (127.0.0.1) to review proposals on a drawing of the
         LPG ontology: accept, reject with a comment, edit, ask the model again
         (with a model), run the oracle (with --oracle, a source and
         n20s-server). The Connections tab connects to Neo4j, chooses the AI
         provider, its key and model, and n20s-server, while the studio runs;
         it can save them to the env file (--dotenv, default .env, which git
         must ignore). Every decision is written to the mapping file at once.
         Reads <mapping>.variants.json when propose --passes wrote one.
         The Recipes tab shows, builds and runs the recipes of --recipes
         (default <mapping dir>/recipes); running needs a source and n20s-server.
recipe   Runs a recipe: its steps in order on named n20s graphs (scopes
         projected through the mapping, static triples, inference, SPARQL,
         SHACL, explanations). Ephemeral graphs are dropped at the end (--keep
         keeps them); persistent ones stay. Prints each step's result; --json
         gives the full trace. --check only checks it. A recipe with write
         steps writes back into Neo4j only with --write, through the write
         connection (N20S_WRITE, else the source URL, with N20S_WRITE_USER and
         N20S_WRITE_PASSWORD); the source it reads is opened read-only.
write-patch What the LPG ontology must declare for the write steps of a
         recipe (or of the recipes of a directory): inferred labels,
         relationships and properties, provenance (createdBy, createdAt), the
         WriteLedger node. --apply writes them into the LPG ontology file;
         re-apply them in the Aura ontology too, an export would lose them.
         Also prints the script an administrator reviews and runs once (the
         WriteLedger constraint, the names the writer writes); --out saves it.
adopt    Takes over what a write step writes when its WriteLedger node is
         gone (a first run refuses to write over facts no ledger owns).
         Without --yes, says what would be adopted.
graphs   Lists the graphs of n20s-server and the persistent graphs built by the
         recipes of a directory (default .), with their status: stable, stale
         (the mapping or LPG ontology changed since the build, or the size
         did), incomplete, missing (n20s-server was restarted), unknown.
serve    Serves the recipes of a directory (default .) over HTTP:
         /sparql/<endpoint> is a read-only SPARQL 1.1 endpoint on the graph a
         recipe published under that name (SELECT, ASK, CONSTRUCT);
         /query/<api> runs a recipe that declares an api with the parameters of
         the query string or JSON body and returns its result; --run adds
         /run/<recipe> for any recipe (by POST), and --write lets /run and the
         followed endpoints write back. Listens on 127.0.0.1:7480 unless --host
         and --port say otherwise. Endpoints that follow the database are
         rebuilt when a committed transaction touches their sources.
follow   Makes an endpoint follow the database (--off stops it): Change Data
         Capture in FULL mode tells which transactions committed; one that
         touches the labels or types the publication is built from rebuilds
         it, through its gates, and swaps it in. serve and the studio do the
         following. Without CDC FULL, it says how to enable it.
bench    Sends the requests of a collection to a running serve (or studio),
         default http://127.0.0.1:7480, and checks what they answer. With
         --iterations, also times each one (latency percentiles, requests per
         second). Exit code 1 when a check fails.
republish Runs again the recipe that published an endpoint, with the same
         parameters: a new version, through its gates, swapped in.
unpublish Stops serving an endpoint (and drops its graph when it is a version
         nothing else serves).
project  Compiles, runs the row queries on the source and sends the rows to
         n20s-server, which builds the RDF graph (replaced if it exists).
compare  Runs every row query on two sources and reports the units whose rows
         differ (for instance Relate during design, Neo4j or Aura in production).
snapshot Saves the rows of every row query, and of the Cypher side of the
         oracle checks with --oracle, to a file. The file then works as a
         --source, for machines that cannot reach the database.
load     Runs a Cypher script on the source (statements end with ; at end of line).
query    Runs a SPARQL SELECT on an n20s graph.
oracle   Projects, then runs each check of the oracle file in Cypher on the
         source and in SPARQL on the projection, and compares the rows (once
         per parameter case). --proposals projects proposed entries too;
         --evidence records the run next to the mapping (<mapping>.oracle.json),
         as the studio does: the review and coverage read it.
coverage Which validated oracle checks cover each decision of a mapping (the
         check's SPARQL uses a term the decision emits, and its Cypher reads
         the element), which decisions none covers, and which a failing check
         puts in doubt. Reads the oracle file (--oracle, else the one next to
         the mapping) and the last recorded run.

Sources are reached over Bolt, the same way for Relate (relate serve --bolt)
and for Neo4j or Aura: bolt://host:port, neo4j://, neo4j+s://... A path to a
snapshot file is a source too.
  --dotenv    loads variables from a file, for instance the credentials file
              Aura gives you (variables already set win)
  --source    missing sources come from N20S_SOURCE, else NEO4J_URI
  user        user@ in the URL, NEO4J_USERNAME (for the NEO4J_URI server
              only), or N20S_SOURCE_USER
  password    the same with NEO4J_PASSWORD or N20S_SOURCE_PASSWORD; keep it
              out of files and URLs you share
  database    ?database=<name>, NEO4J_DATABASE (NEO4J_URI server only), or
              N20S_SOURCE_DATABASE
n20s-server: --n20s, default N20S_URL, else http://localhost:7474.
--graph defaults to the mapping id.

Exit codes: 0 ok, 1 errors or failed checks (or warnings with --strict), 2 usage, I/O or connection error.`;

const COMMANDS = ['check', 'lock', 'compile', 'propose', 'studio', 'status', 'introspect', 'fetch', 'recipe', 'write-patch', 'adopt', 'graphs', 'serve', 'bench', 'republish', 'unpublish', 'follow', 'project', 'compare', 'snapshot', 'load', 'query', 'oracle', 'coverage'];

/** Explicit --source options first, then the default source when more are needed. */
function sourceUrls(values, count) {
  const urls = [...(values.source ?? [])];
  const fallback = defaultSource();
  if (urls.length < count && fallback) urls.push(fallback);
  if (urls.length < count) {
    throw new UsageError(count === 1
      ? 'No source: pass --source <url>, or set N20S_SOURCE or NEO4J_URI (--dotenv <file> loads them from a file).'
      : `This command needs ${count} sources: --source options, completed by N20S_SOURCE or NEO4J_URI.`);
  }
  return urls.slice(0, count);
}

function printTable(rows, columns) {
  if (!rows.length) { console.log('(no rows)'); return; }
  const cols = columns ?? Object.keys(rows[0]);
  const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const width = cols.map((c) => Math.min(90, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))));
  const line = (vals) => vals.map((v, i) => v.slice(0, 90).padEnd(width[i])).join('  ').trimEnd();
  console.log(line(cols));
  console.log(width.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(cols.map((c) => cell(r[c]))));
}

/** One line for what a write step did. */
function writeLine(r) {
  const what = `${r.kind} ${r.name ?? ''}${r.on ? ` on ${r.on}` : ''}`;
  const warn = (r.warnings ?? []).length ? ` Warnings: ${r.warnings.join(' ')}` : '';
  if (!r.written) return `${what}: unchanged, nothing written (${r.rows} rows).${warn}`;
  return `${what}: +${r.added ?? 0} -${r.removed ?? 0}, committed as ${r.owner} (ledger ${r.ledger}).${warn}`;
}

function printProblems(problems) {
  for (const p of problems) console.error(`  compile  ${p.code.padEnd(24)} ${p.path}: ${p.message}`);
}

async function compiled(mappingFile, values) {
  const c = await compileFiles(mappingFile, { lpg: values.lpg, lock: values.lock, force: values.force });
  if (!c.compiled) {
    console.log(formatText(c.result, { verbose: false }));
    console.log('\nNot compiled: fix the errors above, or use --force.');
    return null;
  }
  if (c.problems.length) {
    console.error(`${c.problems.length} entr${c.problems.length === 1 ? 'y' : 'ies'} left out by the compiler:`);
    printProblems(c.problems);
    if (!values.force) { console.error('Not projected: fix the entries above, or use --force.'); return null; }
  }
  return c;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lpg: { type: 'string' },
      lock: { type: 'string' },
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      out: { type: 'string' },
      source: { type: 'string', multiple: true },
      n20s: { type: 'string' },
      graph: { type: 'string' },
      mapping: { type: 'string' },
      oracle: { type: 'string' },
      dotenv: { type: 'string' },
      'skip-project': { type: 'boolean', default: false },
      prefix: { type: 'string' },
      'base-iri': { type: 'string' },
      model: { type: 'string' },
      provider: { type: 'string' },
      record: { type: 'string' },
      replay: { type: 'string' },
      'no-descriptions': { type: 'boolean', default: false },
      'open-terms': { type: 'boolean', default: false },
      'no-repair': { type: 'boolean', default: false },
      passes: { type: 'string' },
      spec: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      run: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      url: { type: 'string' },
      only: { type: 'string', multiple: true },
      iterations: { type: 'string' },
      concurrency: { type: 'string' },
      reviewer: { type: 'string' },
      param: { type: 'string', multiple: true },
      keep: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      repin: { type: 'boolean', default: false },
      off: { type: 'boolean', default: false },
      'mask-hosts': { type: 'boolean', default: false },
      evidence: { type: 'boolean', default: false },
      uncovered: { type: 'boolean', default: false },
      title: { type: 'string' },
      recipes: { type: 'string' },
      proposals: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) { console.log(USAGE); return 0; }
  // Not --env-file: Node reads that flag itself, even after the script name.
  if (values.dotenv) {
    try { process.loadEnvFile(values.dotenv); } catch (err) { throw new UsageError(`Cannot read the env file ${values.dotenv}: ${err.message}`); }
  }
  if (!COMMANDS.includes(command) || (!args.length && !['graphs', 'serve'].includes(command))) throw new UsageError(USAGE);
  const first = args[0] ?? '.';

  if (command === 'check') {
    const res = await checkFiles(first, { lpg: values.lpg, lock: values.lock });
    console.log(values.json ? JSON.stringify(res, null, 2) : formatText(res, { verbose: !values.quiet }));
    return res.summary.errors > 0 || (values.strict && res.summary.warnings > 0) ? 1 : 0;
  }

  if (command === 'lock') {
    const r = await lockFiles(first, { lpg: values.lpg, lock: values.lock, force: values.force });
    if (!r.written) {
      console.log(formatText(r.result, { verbose: false }));
      console.log('\nNot locked: fix the errors above, or use --force.');
      return 1;
    }
    console.log(`Locked ${r.result.lpg.id} v${r.version} (content ${r.result.lpg.contentHash.slice(0, 12)}) in ${r.lockFile}${r.versionUpdated ? `; mapping header set to version ${r.version}` : ''}.`);
    return 0;
  }

  if (command === 'compile') {
    const c = await compileFiles(first, { lpg: values.lpg, lock: values.lock, force: values.force });
    if (!c.compiled) {
      console.log(formatText(c.result, { verbose: false }));
      console.log('\nNot compiled: fix the errors above, or use --force.');
      return 1;
    }
    const json = JSON.stringify(c.plan, null, 2) + '\n';
    if (values.out) {
      await fs.writeFile(values.out, json);
      const templates = c.plan.units.reduce((n, u) => n + u.templates.length, 0);
      console.error(`Wrote ${values.out}: ${c.plan.units.length} units, ${templates} templates.`);
    } else {
      process.stdout.write(json);
    }
    if (c.problems.length) {
      console.error(`${c.problems.length} entr${c.problems.length === 1 ? 'y' : 'ies'} left out:`);
      printProblems(c.problems);
      return 1;
    }
    return 0;
  }

  if (command === 'propose') {
    if (!values.out) throw new UsageError('propose needs --out <file>: the input mapping is not changed.');
    if (!values.prefix) throw new UsageError('propose needs --prefix <p>, the namespace of generated IRIs (add --base-iri <iri> if the mapping does not declare it).');
    let provider;
    if (values.replay) {
      try { provider = replayProvider(JSON.parse(await fs.readFile(values.replay, 'utf8'))); } catch (err) { throw new UsageError(`Cannot read the recording ${values.replay}: ${err.message}`); }
    } else {
      const ai = aiSettingsFromEnv(process.env, { provider: values.provider, model: values.model });
      if (!ai) throw new UsageError(`No AI provider: set ${Object.values(PROVIDERS).map((x) => x.keyVar).join(', ')} or N20S_AI_PROVIDER in the environment (--dotenv <file> loads them from a file).`);
      provider = makeProvider(ai);
    }
    if (values.record) provider = recordingProvider(provider);
    const source = values.source?.length ? openSource(values.source[0]) : null;
    try {
      const res = await proposeFiles(first, {
        lpg: values.lpg, out: values.out, prefix: values.prefix, baseIri: values['base-iri'], provider,
        passes: Math.max(1, Number(values.passes ?? 1) || 1), specFile: values.spec ?? null,
        descriptions: !values['no-descriptions'], openTerms: values['open-terms'], repair: !values['no-repair'],
        valuesOf: source ? sourceValues(source) : null,
        onProgress: (e) => { if (!values.json) console.error(`  ${e.pass > 1 || values.passes > 1 ? `pass ${e.pass}  ` : ''}${e.type.padEnd(6)} ${e.element}`); },
      });
      const variantsFile = res.variants.passes > 1 ? variantsPathFor(values.out) : null;
      if (variantsFile) await fs.writeFile(variantsFile, JSON.stringify(res.variants, null, 1) + '\n');
      const paths = Object.values(res.variants.elements);
      const head = `# Proposals by ${provider.name} ${provider.model} for ${first}.\n# Entries with meta.status: proposed are not compiled until a reviewer accepts them.\n`;
      await fs.writeFile(values.out, head + YAML.stringify(res.mapping, { lineWidth: 0 }));
      if (values.record) await fs.writeFile(values.record, JSON.stringify(provider.recording, null, 1) + '\n');
      const tokens = res.passes.flatMap((p) => p.calls).reduce((t, c) => ({ input: t.input + (c.usage?.input ?? 0), output: t.output + (c.usage?.output ?? 0) + (c.usage?.thinking ?? 0) }), { input: 0, output: 0 });
      if (values.json) {
        console.log(JSON.stringify({ out: values.out, variants: variantsFile, calls: res.passes.reduce((n, p) => n + p.calls.length, 0), tokens, subjects: res.subjects, repaired: res.repaired.map((r) => r.element), dropped: res.dropped, notes: res.notes, summary: res.result.summary, coverage: res.result.coverage }, null, 2));
      } else {
        console.log(`Wrote ${values.out}: ${res.passes.reduce((n, p) => n + p.calls.length, 0)} calls to ${provider.model}, ${tokens.input} tokens in, ${tokens.output} out.`);
        if (variantsFile) console.log(`${paths.filter((v) => v.stable).length}/${paths.length} decisions identical in all ${res.variants.passes} passes (${variantsFile}).`);
        if (res.subjects.length) console.log(`Subjects from uniqueness constraints: ${res.subjects.join(', ')}.`);
        if (res.repaired.length) console.log(`Repaired after check errors: ${res.repaired.map((r) => r.element).join(', ')}.`);
        for (const d of res.dropped) console.log(`Dropped ${d.element}, errors remained:\n    ${d.findings.join('\n    ')}`);
        for (const n of res.notes) console.log(`Note ${n.path}: ${n.message}`);
        console.log('');
        console.log(formatText(res.result, { verbose: false }));
      }
      return res.dropped.length || res.result.summary.errors ? 1 : 0;
    } finally {
      await source?.close();
    }
  }

  if (command === 'studio') {
    const url = values.source?.[0] ?? defaultSource();
    // The Connections tab changes them while the studio runs; secrets are saved only to the env file.
    // --replay answers from a recording (a reproducible demo); --record keeps every answer of the live model.
    let fixedProvider = null;
    if (values.replay) {
      try { fixedProvider = replayProvider(JSON.parse(await fs.readFile(values.replay, 'utf8'))); } catch (err) { throw new UsageError(`Cannot read the recording ${values.replay}: ${err.message}`); }
    }
    let recording = null;
    if (values.record) {
      try { recording = JSON.parse(await fs.readFile(values.record, 'utf8')); } catch { recording = null; }
    }
    const settings = connectionSettings({
      fixedProvider, maskHosts: values['mask-hosts'],
      sourceUrl: url, sourceOrigin: values.source ? 'command line' : 'environment',
      provider: values.provider ?? null, model: values.model ?? null,
      n20sUrl: values.n20s ?? process.env.N20S_URL ?? null,
      envFile: path.resolve(values.dotenv ?? '.env'),
    });
    if (values.record) {
      settings.wrapProvider = (inner) => {
        recording ??= { format: 'n20s-propose-recording/0.1', provider: inner.name, model: inner.model, calls: [] };
        const rec = recordingProvider(inner, recording);
        return { ...rec, async complete(req) { const res = await rec.complete(req); await fs.writeFile(values.record, JSON.stringify(recording, null, 1) + '\n'); return res; } };
      };
    }
    // A project file opens the project; any other file is a mapping.
    let isProject = false;
    try { isProject = YAML.parse(await fs.readFile(first, 'utf8'))?.format === PROJECT_FORMAT; } catch { /* the studio reports it */ }
    const studio = await startStudio({
      ...(isProject ? { projectFile: first, mappingId: values.mapping ?? null } : { mappingFile: first }),
      lpg: values.lpg,
      port: values.port !== undefined ? Number(values.port) : 4321,
      reviewer: values.reviewer ?? process.env.USER ?? 'reviewer',
      oracleFile: values.oracle ?? null,
      settings,
      ...(values.title ? { title: values.title } : {}),
      recipesDir: values.recipes ?? null,
      prefix: values.prefix ?? null,
    });
    console.log(`Studio on ${studio.url} for ${first}. Ctrl-C to stop.`);
    if (!settings.ai) console.log(`No AI provider: set one in the Connections tab (${studio.url}connections), or ${Object.values(PROVIDERS).map((x) => x.keyVar).join(', ')} in the environment.`);
    if (!settings.neo4j) console.log(`No Neo4j source: connect in the Connections tab (${studio.url}connections), or set N20S_SOURCE.`);
    if (!values.oracle) console.log('No --oracle: the oracle panel is off.');
    await new Promise((resolve) => process.once('SIGINT', resolve));
    await studio.close();
    return 0;
  }

  if (command === 'status') {
    const p = await readProject(first);
    const url = values.source?.[0] ?? defaultSource();
    const st = await projectStatus(p, { n20s: values.n20s || url ? n20sClient(values.n20s) : null });
    if (values.json) { console.log(JSON.stringify(st, null, 2)); return st.problems.length ? 1 : 0; }
    for (const x of st.problems) console.log(`ERROR  ${x}`);
    console.log(`${st.name} (${first})\n\nLPG sources`);
    printTable(st.sources.map((x) => ({ source: x.id, origin: x.origin, file: x.file, version: x.doc?.version ?? (x.exists ? '' : 'not there yet'), nodes: x.doc?.nodes ?? '', rels: x.doc?.relationships ?? '', described: x.doc ? `${x.doc.described}/${x.doc.elements}` : '' })));
    console.log('\nRDF targets');
    printTable(st.targets.map((x) => ({ target: x.id, origin: x.origin, namespace: x.namespace, file: x.exists ? x.file : `${x.file} (fetch it)`, classes: x.terms?.classes ?? '', properties: x.terms?.properties ?? '', pinned: x.lock?.sha256?.slice(0, 12) ?? '' })));
    console.log('\nMappings');
    printTable(st.mappings.map((x) => ({ mapping: x.id, source: x.source, targets: x.targets.join(', '), decided: x.coverage ? `${x.coverage.decided}/${x.coverage.total}` : '', proposed: x.coverage?.proposed ?? '',
      check: x.check ? `${x.check.errors} E, ${x.check.warnings} W` : x.error ?? 'no file', drift: x.check?.drift.length ? 'yes' : '', spec: x.specExists ? 'yes' : '', recipes: x.recipeCount ?? '', endpoints: (x.endpoints ?? []).map((e) => `${e.endpoint} ${e.status}`).join(', ') })));
    return st.problems.length ? 1 : 0;
  }

  if (command === 'introspect') {
    const p = await readProject(first);
    const id = args[1];
    if (!id) throw new UsageError('introspect <project.yaml> <source>');
    const url = values.source?.[0] ?? defaultSource();
    const res = await introspectSource(p, id, { openSource: (u) => { const x = u ?? url; if (!x) throw new UsageError('No source to introspect: --source, N20S_SOURCE or NEO4J_URI, or introspect: <url> in the project.'); return openSource(x); } });
    console.log(`${id}: ${res.nodes} node kinds, ${res.relationships} relationship types, version ${res.version}${res.previous ? (res.changed ? ` (was ${res.previous}: the structure changed)` : ' (unchanged)') : ''}.`);
    for (const n of res.notes) console.log(`  note: ${n}`);
    return 0;
  }

  if (command === 'fetch') {
    const p = await readProject(first);
    const id = args[1];
    if (!id) throw new UsageError('fetch <project.yaml> <target>');
    const res = await fetchTarget(p, id, { repin: values.repin });
    console.log(`${id}: ${res.url}, ${res.triples} triples, ${res.terms} terms, sha256 ${res.sha256.slice(0, 12)}.`);
    return 0;
  }

  if (command === 'recipe') {
    const f = await loadRecipe(first, { proposals: values.proposals });
    const findings = checkRecipe(f.recipe, { mapping: f.mapping, lpgDoc: f.lpgDoc });
    const errors = findings.filter((x) => x.severity === 'error');
    if (values.check || findings.length) for (const x of findings) console.log(`${x.severity.toUpperCase()}  ${x.path}: ${x.message}`);
    if (values.check || errors.length) {
      if (!findings.length) console.log(`${first}: ${f.recipe.steps.length} steps, no finding.`);
      return errors.length ? 1 : 0;
    }
    const params = {};
    for (const p of values.param ?? []) {
      const i = p.indexOf('=');
      if (i < 1) throw new UsageError(`--param ${p}: use name=value.`);
      params[p.slice(0, i)] = p.slice(i + 1);
    }
    const sourceUrl = sourceUrls(values, 1)[0];
    const writes = f.recipe.steps.some((s) => s.type === 'write');
    if (writes && !values.write) throw new UsageError(`${f.recipe.id} writes back into Neo4j: run it with --write (and a write connection: N20S_WRITE_USER, N20S_WRITE_PASSWORD).`);
    const writer = writes ? writerFromEnv(sourceUrl) : null;
    const source = openSource(sourceUrl, { readOnly: true });
    try {
      const n20s = n20sClient(values.n20s);
      const run = await runRecipe({ ...f, params, source, n20s, keep: values.keep, resolvePublished: publishedResolver(path.dirname(first)),
        writer, allowWrite: !!writer, freshness: freshnessOf(path.dirname(first), n20s),
        onStep: (e) => { if (!values.json && e.type === 'start') process.stderr.write(`  ${e.step} … `); if (!values.json && e.type === 'end') process.stderr.write(`${e.status}\n`); } });
      const recorded = await recordRecipeRun(first, run, f, { source: { url: source.url, agent: await source.agent().catch(() => null) }, n20s });
      if (values.json) { console.log(JSON.stringify(run, null, 2)); return run.ok ? 0 : 1; }
      for (const s of run.steps) {
        console.log(`\n${s.id} (${s.type} on ${s.graph}: ${s.state.triples} triples${s.state.delta ? `, ${s.state.delta > 0 ? '+' : ''}${s.state.delta}` : ''}; ${s.ms} ms)${s.status === 'error' ? `  ERROR ${s.error}` : ''}`);
        const r = s.result ?? {};
        const columns = { explain: ['depth', 'kind', 'rule', 'fact'], validate: ['node', 'key', 'severity', 'message'] }[s.type];
        if (s.type === 'validate' && r.conforms) console.log('conforms');
        else if (s.type === 'write') { if (s.status === 'ok') console.log(writeLine(r)); }
        else if (r.rows && s.type !== 'scope') printTable(r.rows, columns ?? (r.rows.length ? Object.keys(r.rows[0]) : undefined));
        else if (s.type === 'scope') console.log(`${r.nodes} nodes in scope, ${r.added} triples added (${(r.units ?? []).map((u) => `${u.id} ${u.rows}`).join(', ')})`);
        else if (s.status === 'ok') console.log(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'sample'))));
      }
      const fate = Object.entries(run.graphs).map(([k, g]) => `${k} (${g.lifecycle}${g.lifecycle === 'persistent' ? ` ${g.name}, ${g.triples} triples, kept` : g.kept ? `, kept as ${g.name}` : ', dropped'})`);
      console.log(`\n${run.ok ? 'Done' : 'Stopped'} in ${run.ms} ms. Graphs: ${fate.join('; ')}.`);
      if (recorded) {
        for (const e of recorded.published) console.log(`Published /sparql/${e} → ${run.publications.find((p) => p.as === e).graph}.`);
        if (recorded.dropped.length) console.log(`Dropped graphs nothing serves any more: ${recorded.dropped.join(', ')}.`);
        console.log(`Recorded in ${registryPathFor(path.dirname(first))}.`);
      }
      return run.ok ? 0 : 1;
    } finally {
      await source.close();
      await writer?.close();
    }
  }

  if (command === 'write-patch') {
    const patches = await writePatchFiles(first, { apply: values.apply });
    if (values.out) await fs.writeFile(values.out, patches.map((p) => p.script).join('\n'));
    if (values.json) { console.log(JSON.stringify(patches.map(({ doc, ...p }) => p), null, 2)); return 0; }
    if (!patches.length) { console.log(`${first}: no recipe writes back.`); return 0; }
    for (const p of patches) {
      console.log(`${p.lpgFile} (recipes ${p.recipes.join(', ')}):`);
      if (!p.changes.length) console.log('  declares everything they write.');
      for (const c of p.changes) console.log(`  ${c.op.padEnd(16)} ${c.path.padEnd(28)} ${c.what}`);
      if (p.changes.length) console.log(p.applied ? '  Applied. Re-apply these changes in the Aura ontology too: an export without them fails check.' : '  Not applied: --apply writes them into the file.');
      if (!values.out) console.log(`\nAdmin script (review it, run it once as an administrator; --out saves it):\n\n${p.script}`);
    }
    if (values.out) console.log(`Admin script written to ${values.out}: review it, run it once as an administrator (n20s-mapping load ${values.out}).`);
    return 0;
  }

  if (command === 'adopt') {
    const step = args[1];
    if (!step) throw new UsageError('adopt <recipe.yaml> <step> [--yes]');
    const writer = writerFromEnv(sourceUrls(values, 1)[0]);
    try {
      const r = await adoptStep(first, step, { writer, yes: values.yes });
      console.log(r.adopted ? `${r.owner} now owns ${r.name} on ${r.on} (${r.facts ?? '?'} existing). Its next run computes its delta against them.` : r.message);
      return 0;
    } finally {
      await writer.close();
    }
  }

  if (command === 'serve') {
    const url = values.source?.[0] ?? defaultSource();
    // --write: /run and the followed endpoints may write back, through the write connection only.
    const openW = values.write ? (() => { writerFromEnv(url).close(); return () => writerFromEnv(url); })() : null;
    const server = await serveEndpoints({
      recipesDir: first, n20s: n20sClient(values.n20s), openSource: url ? () => openSource(url, { readOnly: true }) : null,
      port: values.port !== undefined ? Number(values.port) : 7480, host: values.host ?? '127.0.0.1', allowRun: values.run,
      allowWrite: !!openW, openWriter: openW,
    });
    console.log(`Serving ${first} on ${server.url}: GET ${server.url}sparql lists the endpoints, GET ${server.url}query the query APIs${values.run ? `, GET ${server.url}run the recipes` : ''}${openW ? ' (recipes may write back)' : ''}. Ctrl-C to stop.`);
    if (!url) console.log('No source: /query and /run are off (--source, N20S_SOURCE or NEO4J_URI).');
    // Endpoints that follow the database (studio, or `follow`) are rebuilt when a transaction touches their sources.
    const client = n20sClient(values.n20s);
    const following = url ? follower({ recipesDir: () => first, openSource: () => () => openSource(url, { readOnly: true }), n20s: () => client, openWriter: () => openW,
      onSync: (r) => console.log(`${new Date().toISOString()} /sparql/${r.endpoint}: ${r.transactions} transaction(s) → ${r.sync.ok ? `rebuilt as ${r.sync.graph} in ${r.sync.ms} ms` : `not rebuilt (${r.sync.error}), the endpoint keeps its graph`}`),
      onError: (err) => console.error(`following: ${err.message.split('\n')[0]}`) }) : null;
    await new Promise((resolve) => process.once('SIGINT', resolve));
    following?.stop();
    await server.close();
    return 0;
  }

  if (command === 'graphs') {
    const report = await graphsReport(first, n20sClient(values.n20s));
    if (values.json) { console.log(JSON.stringify({ graphs: report, endpoints: report.endpoints }, null, 2)); return 0; }
    printTable(report.map((g) => ({
      graph: g.name, status: g.status, triples: g.triples ?? '', endpoints: g.endpoints.join(', '), recipe: g.built ? `${g.built.recipe} (${g.built.file})` : '',
      built: g.built?.at?.replace('T', ' ').slice(0, 19) ?? '', why: g.reasons.join('; '),
    })));
    if (report.endpoints.length) {
      console.log('');
      printTable(report.endpoints.map((e) => ({ endpoint: `/sparql/${e.endpoint}`, graph: e.graph, status: e.status, recipe: e.published.recipe, published: e.published.at.replace('T', ' ').slice(0, 19) })));
    }
    return report.some((g) => g.status !== 'stable') ? 1 : 0;
  }

  if (command === 'bench') {
    let bench;
    try { bench = YAML.parse(await fs.readFile(first, 'utf8')); } catch (err) { throw new UsageError(`Cannot read ${first}: ${err.message}`); }
    const problems = checkBench(bench);
    if (problems.length) { for (const p of problems) console.log(`ERROR  ${p}`); return 1; }
    const base = values.url ?? 'http://127.0.0.1:7480/';
    const items = bench.requests.filter((r) => !values.only || values.only.includes(r.id));
    const results = [];
    for (const item of items) {
      const r = await send(item, base);
      const b = values.iterations ? await benchmark(item, base, { iterations: Number(values.iterations), concurrency: Number(values.concurrency ?? 1) }) : null;
      results.push({ id: item.id, target: Object.entries(item.target).map(([k, v]) => `${k}:${v}`)[0], status: r.status, ms: r.ms, rows: r.rows?.length ?? null, checks: r.checks, error: r.error ?? (r.status >= 400 ? r.body?.error : undefined), bench: b && { stats: b.stats, rps: b.rps } });
    }
    const failed = results.filter((r) => r.checks.some((c) => !c.ok));
    if (values.json) { console.log(JSON.stringify({ base, results }, null, 2)); return failed.length ? 1 : 0; }
    printTable(results.map((r) => ({
      request: r.id, target: r.target, status: r.status, ms: r.ms, rows: r.rows ?? '',
      checks: r.checks.every((c) => c.ok) ? `ok (${r.checks.length})` : `FAIL ${r.checks.filter((c) => !c.ok).map((c) => `${c.name}: got ${c.seen}`).join('; ')}`,
    })));
    if (values.iterations) {
      console.log('');
      printTable(results.map((r) => ({ request: r.id, n: r.bench.stats.count, errors: r.bench.stats.errors, min: r.bench.stats.min, p50: r.bench.stats.p50, p95: r.bench.stats.p95, p99: r.bench.stats.p99, max: r.bench.stats.max, 'req/s': r.bench.rps })));
    }
    console.log(`\n${results.length - failed.length}/${results.length} requests answer as expected (${base}).`);
    return failed.length ? 1 : 0;
  }

  if (command === 'follow') {
    const dir = values.recipes ?? '.';
    if (values.off) { await stopFollowing(dir, first); console.log(`/sparql/${first} no longer follows the database.`); return 0; }
    const source = openSource(sourceUrls(values, 1)[0]);
    try {
      await startFollowing(dir, first, source);
      console.log(`/sparql/${first} follows the database from now on: serve (or the studio) rebuilds it when a transaction touches its sources.`);
      return 0;
    } finally {
      await source.close();
    }
  }

  if (command === 'republish') {
    const dir = values.recipes ?? '.';
    const url = sourceUrls(values, 1)[0];
    const source = openSource(url, { readOnly: true });
    const writer = values.write ? writerFromEnv(url) : null;
    try {
      const { run, recorded } = await republish(dir, first, { source, n20s: n20sClient(values.n20s), writer, allowWrite: !!writer, onStep: (e) => { if (e.type === 'end') console.error(`  ${e.step} ${e.status}`); } });
      if (!run.ok) {
        const failed = run.steps.find((s) => s.status === 'error');
        console.log(`Not re-published: ${failed?.id}: ${failed?.error} The endpoint still serves the previous version.`);
        return 1;
      }
      console.log(`Re-published /sparql/${first} → ${run.publications.find((p) => p.as === first)?.graph ?? '(not published by this run)'}${recorded?.dropped.length ? `; dropped ${recorded.dropped.join(', ')}` : ''}.`);
      return 0;
    } finally {
      await source.close();
      await writer?.close();
    }
  }

  if (command === 'unpublish') {
    const r = await unpublishEndpoint(values.recipes ?? '.', first, { n20s: n20sClient(values.n20s) });
    console.log(`Unpublished /sparql/${first}${r.dropped ? `; dropped ${r.dropped}` : ''}.`);
    return 0;
  }

  if (command === 'project') {
    const c = await compiled(first, values);
    if (!c) return 1;
    const graph = values.graph ?? c.mapping.id;
    const source = openSource(sourceUrls(values, 1)[0]);
    try {
      const n20s = n20sClient(values.n20s);
      const res = await project({ plan: c.plan, source, n20s, graph });
      if (values.json) { console.log(JSON.stringify({ agent: await source.agent(), ...res }, null, 2)); return 0; }
      printTable(res.units, ['id', 'rows', 'added']);
      console.log(`\n${res.triples} triples in graph "${graph}" on ${n20s.url} (source ${await source.agent()} at ${source.url}).`);
      return 0;
    } finally {
      await source.close();
    }
  }

  if (command === 'compare') {
    const c = await compiled(first, values);
    if (!c) return 1;
    const [ua, ub] = sourceUrls(values, 2);
    const a = openSource(ua);
    const b = openSource(ub);
    try {
      const [agentA, agentB] = await Promise.all([a.agent(), b.agent()]);
      const res = await compareSources({ plan: c.plan, a, b });
      if (values.json) { console.log(JSON.stringify({ a: { url: a.url, agent: agentA }, b: { url: b.url, agent: agentB }, units: res }, null, 2)); }
      else {
        console.log(`A: ${agentA} at ${a.url}\nB: ${agentB} at ${b.url}\n`);
        printTable(res.map((u) => ({ id: u.id, rowsA: u.rowsA, rowsB: u.rowsB, same: u.same ? 'yes' : 'NO' })));
        for (const u of res.filter((x) => !x.same)) {
          console.log(`\n${u.id}`);
          for (const x of u.onlyA) console.log(`  only A: ${x}`);
          for (const x of u.onlyB) console.log(`  only B: ${x}`);
        }
      }
      return res.every((u) => u.same) ? 0 : 1;
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }

  if (command === 'snapshot') {
    if (!values.out) throw new UsageError('snapshot needs --out <file>.');
    const c = await compiled(first, values);
    if (!c) return 1;
    const oracle = values.oracle ? (await readOracle(values.oracle)).oracle : null;
    const source = openSource(sourceUrls(values, 1)[0]);
    try {
      const snap = await takeSnapshot({ plan: c.plan, source, oracle });
      await fs.writeFile(values.out, JSON.stringify(snap, null, 1) + '\n');
      const rows = snap.queries.reduce((n, q) => n + q.rows.length, 0);
      console.log(`Wrote ${values.out}: ${snap.queries.length} queries, ${rows} rows, from ${snap.source.agent} at ${snap.source.url}.`);
      return 0;
    } finally {
      await source.close();
    }
  }

  if (command === 'load') {
    const source = openSource(sourceUrls(values, 1)[0]);
    try {
      let n = 0;
      for (const file of args) {
        let text;
        try { text = await fs.readFile(file, 'utf8'); } catch (err) { throw new UsageError(`Cannot read ${file}: ${err.message}`); }
        for (const statement of splitStatements(text)) { await source.run(statement); n++; }
      }
      const [{ nodes }] = await source.run('MATCH (n) RETURN count(n) AS nodes');
      console.log(`Ran ${n} statements on ${await source.agent()} at ${source.url}; ${nodes} nodes.`);
      return 0;
    } finally {
      await source.close();
    }
  }

  if (command === 'query') {
    if (!values.graph) throw new UsageError('query needs --graph <name>.');
    const rows = await n20sClient(values.n20s).query(values.graph, await readQueryArg(first));
    if (values.json) console.log(JSON.stringify(rows, null, 2));
    else printTable(rows);
    return 0;
  }

  if (command === 'coverage') {
    const l = await loadFiles(first);
    const oracleFile = values.oracle ?? oraclePathFor(first);
    let text;
    try { text = await fs.readFile(oracleFile, 'utf8'); } catch { throw new UsageError(`No oracle file ${oracleFile}: --oracle <file>.`); }
    const oracle = YAML.parse(text);
    let evidence = null;
    try { evidence = JSON.parse(await fs.readFile(evidencePathFor(first), 'utf8')); } catch { /* never run */ }
    const { plan } = await compile(acceptAll(l.mapping), l.lpgDoc);
    const cov = coverage({ oracle, evidence, mapping: l.mapping, lpgDoc: l.lpgDoc, plan, lpgHash: await contentHash(l.lpgDoc) });
    if (values.json) { console.log(JSON.stringify(cov, null, 2)); return 0; }
    const sha = createHash('sha256').update(text).digest('hex');
    console.log(`${oracleFile}: ${cov.checks.length} checks. ${evidence ? `Last run ${evidence.at}${evidence.withProposals ? ' (with proposals)' : ''}${evidence.oracle && evidence.oracle !== sha ? ', with another version of this file: run it again' : ''}.` : 'Never run: n20s-mapping oracle <file> --evidence.'}\n`);
    const rows = cov.decisions.filter((d) => d.kind === 'mapped' && (!values.uncovered || !d.counted.length || d.suspects.length));
    printTable(rows.map((d) => ({
      decision: d.label, status: d.status, 'covered by': d.counted.map((id) => `${id}${d.covering.find((c) => c.id === id)?.draftedFrom ? ' (drafted from it)' : ''}`).join(', '),
      'not counting': d.covering.filter((c) => !c.counts).map((c) => `${c.id}: ${c.why}`).join('; '), 'in doubt': d.doubts.filter((x) => !x.cleared).map((x) => `${x.id} (${x.level})`).join(', '),
    })));
    console.log(`\n${cov.summary.covered} of ${cov.summary.mapped} mapped decisions covered by a check that counts; ${cov.summary.suspected} in doubt.`);
    return 0;
  }

  // oracle
  const { oracle, mappingFile: fromOracle } = await readOracle(first);
  const mappingFile = values.mapping ?? fromOracle;
  if (!mappingFile) throw new UsageError('No mapping: set `mapping` in the oracle file or pass --mapping.');
  const c = await compiled(mappingFile, values);
  if (!c) return 1;
  // --proposals: proposed entries projected too, as the studio's "Run with proposals too".
  if (values.proposals) { const m = acceptAll(c.mapping); Object.assign(c, { mapping: m, plan: (await compile(m, c.lpgDoc)).plan }); }
  const graph = values.graph ?? c.mapping.id;
  const source = openSource(sourceUrls(values, 1)[0], { readOnly: true });
  try {
    const n20s = n20sClient(values.n20s);
    if (!values['skip-project']) await project({ plan: c.plan, source, n20s, graph });
    const results = await runOracle({ oracle, mapping: c.mapping, lpgDoc: c.lpgDoc, source, n20s, graph });
    if (values.evidence) {
      const sha = createHash('sha256').update(await fs.readFile(first, 'utf8')).digest('hex');
      await fs.writeFile(evidencePathFor(mappingFile), JSON.stringify(oracleEvidence({ oracle, results, mapping: c.mapping, lpgDoc: c.lpgDoc, plan: c.plan, withProposals: !!values.proposals, oracleSha256: sha }), null, 1) + '\n');
      if (!values.json) console.error(`Recorded in ${evidencePathFor(mappingFile)}.`);
    }
    if (values.json) console.log(JSON.stringify(results, null, 2));
    else {
      printTable(results.map((r) => ({
        check: r.id,
        status: r.status,
        rows: r.mode === 'disjoint' ? `${r.cypherRows} vs ${r.sparqlRows}` : r.rows ?? '',
        note: r.status === 'not-expressible' ? r.reason : r.error ?? '',
      })));
      for (const r of results.filter((x) => x.status === 'fail')) {
        console.log(`\n${r.id} (${r.mode})`);
        for (const x of r.onlyCypher ?? []) console.log(`  only in Cypher: ${x}`);
        for (const x of r.onlySparql ?? []) console.log(`  only in SPARQL: ${x}`);
        for (const x of r.inBoth ?? []) console.log(`  in both:        ${x}`);
      }
    }
    return results.some((r) => r.status === 'fail' || r.status === 'error') ? 1 : 0;
  } finally {
    await source.close();
  }
}

main().then((code) => { process.exitCode = code; }, (err) => {
  if (err instanceof UsageError) console.error(err.message);
  else console.error(process.env.N20S_DEBUG ? err.stack : `Error: ${err.message}`);
  process.exitCode = 2;
});
