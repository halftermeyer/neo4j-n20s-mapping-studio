// Plain-text report for terminals and CI logs.

const LABEL = { error: 'ERROR  ', warning: 'WARNING', info: 'INFO   ' };
const DECIDED = ['mapped', 'subject', 'inherited', 'ignored', 'deferred'];
const PENDING = ['proposed', 'undecided'];

function bucketLine(name, b) {
  const decided = DECIDED.reduce((s, k) => s + (b[k] ?? 0), 0);
  const parts = [...DECIDED, ...PENDING].filter((k) => b[k]).map((k) => `${k} ${b[k]}`);
  return `  ${name.padEnd(24)} ${String(decided).padStart(3)}/${String(b.total).padEnd(4)} ${parts.join(' · ')}`;
}

export function formatText(res, { verbose = true } = {}) {
  const out = [];
  if (res.files) out.push(`n20s-mapping check  ${res.files.mapping}`);
  if (res.lpg) out.push(`  LPG ontology  ${res.lpg.id} v${res.lpg.version}  (content ${res.lpg.contentHash.slice(0, 12)})`);
  if (res.targetInfo) out.push(`  Targets       ${res.targetInfo.namespaces.join(', ')}  (${res.targetInfo.triples} triples)`);
  if (res.files) out.push(`  Lock          ${res.files.lock ?? 'none'}`);
  out.push('');

  const shown = res.findings.filter((f) => verbose || f.severity !== 'info');
  for (const f of shown) {
    out.push(`${LABEL[f.severity]}  ${f.code}  ${f.path}`);
    out.push(`         ${f.message}`);
  }
  if (shown.length) out.push('');

  if (res.coverage) {
    const c = res.coverage;
    out.push('Coverage (decided/total)');
    out.push(bucketLine('node kinds', c.nodes));
    out.push(bucketLine('node properties', c.nodeProperties));
    out.push(bucketLine('relationship types', c.relationships));
    out.push(bucketLine('relationship properties', c.relationshipProperties));
    if (c.proposed.length) out.push(`  Awaiting review: ${c.proposed.join(', ')}`);
    out.push(`  Undecided: ${c.undecided.length ? c.undecided.join(', ') : 'none'}`);
    out.push('');
  }
  const s = res.summary;
  out.push(`${s.errors} error(s), ${s.warnings} warning(s), ${s.infos} info.`);
  return out.join('\n');
}
