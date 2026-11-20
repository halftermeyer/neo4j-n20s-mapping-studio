// Small DOM helpers shared by the studio tabs.
export const $ = (id) => document.getElementById(id);
/** A data-testid from any key (for the demo recorder and browser tests): relationships/r:6 → relationships-r-6. */
export const tid = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '-');
const SVGNS = 'http://www.w3.org/2000/svg';

/** Children as nodes: nested arrays flattened, null, undefined and false left out. */
export const kids = (xs) => xs.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
  .map((c) => (c instanceof Node ? c : document.createTextNode(String(c))));
export const fill = (el, ...children) => el.replaceChildren(...kids(children));

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids(children));
  return el;
}
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...kids(children));
  return el;
}

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}
export function toast(text, err = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = err ? 'err' : '';
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, err ? 8000 : 3500);
}
