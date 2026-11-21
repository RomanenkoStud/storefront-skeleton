// Storefront design-token check. Dependency-free.
// Fails on a raw hex colour or a px font-size in storefront CSS. Values live in apps/web/src/tokens.css only.
// Admin CSS (apps/web/src/styles.css) is out of scope.
import { readdir, readFile } from 'node:fs/promises';

export const TOKENS_FILE = 'apps/web/src/tokens.css';
export const CSS_ROOT = 'apps/web/src';
// Admin stylesheets are out of scope for now. Every other CSS file under CSS_ROOT (recursively) is storefront.
export const ADMIN_CSS = ['apps/web/src/styles.css'];

// LEGACY: storefront files that still hold raw hex colours or px font sizes and are not migrated yet.
// Phase 2 migrates them to tokens and EMPTIES this list. Do not add to it:
// any storefront CSS file that is not listed here is enforced immediately.
export const LEGACY_ALLOWLIST = [
  'apps/web/src/streetwear.css',
  'apps/web/src/featured-rail.css',
  'apps/web/src/landing/announcement.css',
  'apps/web/src/landing/card-caption.css',
  'apps/web/src/landing/page-ending.css',
  // wave-2 visual files, migrated in phase 2
  'apps/web/src/landing/header.css',
  'apps/web/src/landing/campaign.css',
  'apps/web/src/landing/posters.css',
  'apps/web/src/landing/delivery.css',
  'apps/web/src/delivery/np-picker.css',
];

// Blank comments, string literals and url(...) as units (one pass, so a quote inside a comment or a
// comment marker inside a string cannot confuse it). Newlines are kept so line numbers stay exact.
function blank(text) {
  const keep = (s) => s.replace(/[^\n]/g, ' ');
  return text.replace(/\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|url\([^)]*\)/gi, keep);
}

// Returns [{ file, line, column, rule, match }]. Pure: no filesystem access.
// Only declaration values are inspected, so hex-looking selectors (#abc, #fade) are never flagged.
export function scanCss(text, file = '<css>') {
  const clean = blank(text);
  const findings = [];
  const lineStarts = [0];
  for (let i = 0; i < clean.length; i += 1) if (clean[i] === '\n') lineStarts.push(i + 1);
  const locate = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, column: index - lineStarts[lo] + 1 };
  };
  // property: value, where the property name starts at a declaration boundary (so --x-font-size is its own name).
  for (const d of clean.matchAll(/(?<![\w-])(-{0,2}[\w-]+)\s*:([^;{}]*)/g)) {
    const prop = d[1].toLowerCase();
    const value = d[2];
    const valueStart = d.index + d[0].length - value.length;
    for (const m of value.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g)) {
      findings.push({ file, ...locate(valueStart + m.index), rule: 'raw-hex', match: m[0] });
    }
    // px sizes in font-size, and in the font shorthand (font: 600 14px/1.2 Oswald), case-insensitive.
    if ((prop === 'font-size' || prop === 'font') && /(?:\d|\.\d)[\d.]*px\b/i.test(value)) {
      findings.push({ file, ...locate(d.index), rule: 'px-font-size', match: `${prop}:${value.trim()}` });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

export function formatFinding(f) {
  const hint = f.rule === 'raw-hex' ? 'use a colour token from tokens.css' : 'use a type-scale token from tokens.css';
  return `${f.file}:${f.line}:${f.column} ${f.rule} ${f.match} (${hint})`;
}

async function walkCss(root, dir, out) {
  for (const entry of await readdir(`${root}/${dir}`, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walkCss(root, path, out);
    else if (entry.name.endsWith('.css')) out.push(path);
  }
  return out;
}

// Every CSS file under apps/web/src, split into storefront (scanned), admin (explicit list) and tokens.
export async function listCssFiles(root = '.') {
  const all = (await walkCss(root, CSS_ROOT, [])).sort();
  return {
    storefront: all.filter((f) => f !== TOKENS_FILE && !ADMIN_CSS.includes(f)),
    admin: all.filter((f) => ADMIN_CSS.includes(f)),
    all,
  };
}

async function listStorefrontFiles(root) {
  return (await listCssFiles(root)).storefront;
}

// Runs against the working tree. Returns { errors, notes, files }.
export async function checkDesignTokens(root = '.', { legacy = LEGACY_ALLOWLIST } = {}) {
  const errors = [];
  const notes = [];
  const files = await listStorefrontFiles(root);
  for (const file of files) {
    let text;
    try { text = await readFile(`${root}/${file}`, 'utf8'); } catch { continue; }
    const findings = scanCss(text, file);
    if (legacy.includes(file)) {
      if (!findings.length) notes.push(`${file} is clean: remove it from LEGACY_ALLOWLIST in tools/design-tokens-check.mjs`);
      continue;
    }
    for (const f of findings) errors.push(formatFinding(f));
  }
  for (const file of legacy) if (!files.includes(file)) errors.push(`LEGACY_ALLOWLIST names a missing or non-storefront file: ${file}`);
  return { errors, notes, files };
}

export async function runDesignTokensCheck(root = '.') {
  const { errors, notes, files } = await checkDesignTokens(root);
  for (const note of notes) console.warn(`design tokens: ${note}`);
  if (errors.length) throw new Error(`Design token check failed (raw hex or px font-size outside tokens.css):\n${errors.join('\n')}`);
  console.log(`Design tokens verified: ${files.length} storefront CSS files, ${LEGACY_ALLOWLIST.length} legacy exempt.`);
}
