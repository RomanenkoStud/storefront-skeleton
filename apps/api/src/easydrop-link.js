// EasyDrop prom-export link validation. Pure; error messages never contain the supplied value.
const HOST = 'easydrop.one', PATH = '/prom-export', DIGITS = /^[0-9]{1,30}$/, MAX_LENGTH = 200;
const INVALID = 'Use an EasyDrop link such as https://easydrop.one/prom-export?key=<digits> (optionally &pid=<digits>)';
export class EasyDropLinkError extends Error { constructor() { super(INVALID); this.name = 'EasyDropLinkError'; } }

export function parseEasyDropLink(value) {
  const bad = () => { throw new EasyDropLinkError(); };
  if (typeof value !== 'string' || !value || value.length > MAX_LENGTH) bad();
  // Reject whitespace/control chars, backslashes, fragments and percent-encoding before URL normalization can hide them.
  if (/[\s\u0000-\u001f\u007f-\u009f\\#%]/u.test(value)) bad();
  let url; try { url = new URL(value); } catch { bad(); }
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password || url.pathname !== PATH || url.hash) bad();
  if (!value.startsWith(`https://${HOST}${PATH}?`)) bad();
  const found = {};
  for (const pair of url.search.slice(1).split('&')) {
    const parts = pair.split('=');
    if (parts.length !== 2 || !['key', 'pid'].includes(parts[0]) || Object.hasOwn(found, parts[0]) || !DIGITS.test(parts[1])) bad();
    found[parts[0]] = parts[1];
  }
  if (!found.key) bad();
  // pid is optional: EasyDrop serves the feed by key alone.
  return { key: found.key, pid: found.pid ?? null };
}
export function buildEasyDropFeedUrl({ key, pid }) {
  if (!DIGITS.test(String(key)) || (pid != null && !DIGITS.test(String(pid)))) throw new EasyDropLinkError();
  return `https://${HOST}${PATH}?key=${key}${pid != null ? `&pid=${pid}` : ''}`;
}
// Short keys would leak too much of the secret; show nothing for them.
export const keyLast4 = key => (String(key).length >= 8 ? String(key).slice(-4) : null);
