// IRIs, compact IRIs and IRI templates.

const CURIE = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/s;
const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const PLACEHOLDER = /\{([^{}\s]+)\}/g;
// RFC 3986 unreserved characters. n20s percent-encodes every other ASCII
// character of a value substituted into an IRI (non-ASCII passes through).
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Expands a compact IRI with the declared prefixes, or accepts an absolute IRI.
 * @returns {{iri: string} | {error: 'unknown-prefix', prefix: string}}
 */
export function expand(ref, prefixes = {}) {
  const m = CURIE.exec(ref);
  if (m && Object.hasOwn(prefixes, m[1])) return { iri: prefixes[m[1]] + m[2] };
  if (ABSOLUTE.test(ref) || /^(urn|mailto|tag):/i.test(ref)) return { iri: ref };
  return { error: 'unknown-prefix', prefix: m ? m[1] : ref };
}

/** Shortens an IRI with the first matching prefix, for messages. */
export function shorten(iri, prefixes = {}) {
  let best = null;
  for (const [p, ns] of Object.entries(prefixes)) {
    if (iri.startsWith(ns) && (!best || ns.length > best[1].length)) best = [p, ns];
  }
  return best ? `${best[0]}:${iri.slice(best[1].length)}` : `<${iri}>`;
}

/**
 * Splits an IRI template into fixed text and placeholders.
 * @returns {{parts: Array<{text: string} | {placeholder: string}>, placeholders: string[]}}
 */
export function parseTemplate(template) {
  const parts = [];
  const placeholders = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    parts.push({ placeholder: m[1] });
    placeholders.push(m[1]);
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return { parts, placeholders };
}

/**
 * An IRI built from a template can be parsed back into its values when every
 * two placeholders are separated by fixed text containing at least one
 * character that is always percent-encoded inside values (such as / # : @).
 * @returns {null | {after: string, before: string, separator: string}} the first ambiguous pair, or null
 */
export function ambiguousSeparator(parts) {
  for (let i = 0; i < parts.length; i++) {
    if (!('placeholder' in parts[i])) continue;
    const next = parts[i + 1];
    const afterNext = parts[i + 2];
    if (next && 'placeholder' in next) {
      return { before: parts[i].placeholder, after: next.placeholder, separator: '' };
    }
    if (next && afterNext && 'placeholder' in afterNext) {
      const safe = [...next.text].some((c) => c.charCodeAt(0) < 128 && !UNRESERVED.test(c));
      if (!safe) return { before: parts[i].placeholder, after: afterNext.placeholder, separator: next.text };
    }
  }
  return null;
}

/** Expands the prefix of a template's fixed head (templates start with a scheme or a prefix). */
export function expandTemplate(template, prefixes = {}) {
  const m = CURIE.exec(template);
  if (m && Object.hasOwn(prefixes, m[1])) return { iri: prefixes[m[1]] + m[2] };
  if (ABSOLUTE.test(template) || /^(urn|tag):/i.test(template)) return { iri: template };
  return { error: 'unknown-prefix', prefix: m ? m[1] : template };
}

/** Placeholder names n20s templates accept, per dotted segment. */
export const N20S_PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Percent-encodes a value exactly like the n20s template engine (R2RML IRI-safe, uppercase hex). */
export function iriEncode(value) {
  let out = '';
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0);
    if (cp > 127 || UNRESERVED.test(ch)) out += ch;
    else for (const b of new TextEncoder().encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Builds the IRI a template gives for these values (prefix expanded, values encoded). */
export function fillTemplate(template, values, prefixes = {}) {
  const head = expandTemplate(template, prefixes);
  if (head.error) throw new Error(`Prefix "${head.prefix}" is not declared.`);
  return head.iri.replace(PLACEHOLDER, (_, name) => {
    if (!(name in values)) throw new Error(`No value for {${name}}.`);
    return iriEncode(values[name]);
  });
}

/**
 * Parses an IRI back into the values of a template: the inverse of fillTemplate,
 * defined when the template is invertible. Returns null when the IRI does not match.
 */
export function matchTemplate(template, iri, prefixes = {}) {
  const head = expandTemplate(template, prefixes);
  if (head.error) throw new Error(`Prefix "${head.prefix}" is not declared.`);
  const { parts, placeholders } = parseTemplate(head.iri);
  const source = parts.map((p) => ('text' in p ? p.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '(.+?)')).join('');
  const m = new RegExp(`^${source}$`, 's').exec(iri);
  if (!m) return null;
  return Object.fromEntries(placeholders.map((name, i) => [name, decodeURIComponent(m[i + 1])]));
}
