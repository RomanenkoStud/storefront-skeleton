import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scanCss, checkDesignTokens, listCssFiles, LEGACY_ALLOWLIST, ADMIN_CSS, TOKENS_FILE } from '../../tools/design-tokens-check.mjs';

// Scanner: hex colours.
for (const hex of ['#fff', '#ffff', '#d7f16c', '#D7F16C', '#d7f16c99']) {
  const found = scanCss(`.a{color:${hex}}`, 'x.css');
  assert.equal(found.length, 1, hex);
  assert.equal(found[0].rule, 'raw-hex');
  assert.equal(found[0].match, hex);
}
assert.equal(scanCss('.a{color:var(--lime)}').length, 0);
assert.equal(scanCss('.a{background:url(#grain)}').length, 0, 'url fragments are not colours');
assert.equal(scanCss('.a{color:#12345}').length, 0, 'five digits is not a colour');

// Scanner: px font sizes, including inside clamp(); other units pass.
assert.equal(scanCss('.a{font-size:11px}')[0].rule, 'px-font-size');
assert.equal(scanCss('.a{font-size: clamp(32px, 3.6vw, 52px) !important}')[0].rule, 'px-font-size');
assert.equal(scanCss('.a{font-size:var(--text-sm)}').length, 0);
assert.equal(scanCss('.a{font-size:1.2rem}').length, 0);
assert.equal(scanCss('.a{padding:11px;border:1px solid var(--line)}').length, 0, 'only font-size is policed');

// px in the font shorthand, case-insensitive, custom properties not matched, selectors and strings skipped.
assert.equal(scanCss('.a{font:600 14px Oswald}')[0].rule, 'px-font-size');
assert.equal(scanCss('.a{font:600 14px/1.2 Oswald}').length, 1);
assert.equal(scanCss('.a{font:600 var(--text-sm) Oswald}').length, 0);
assert.equal(scanCss('.a{FONT-SIZE:14PX}').length, 1, 'case-insensitive');
assert.equal(scanCss('.a{Font:600 14Px Oswald}').length, 1);
assert.equal(scanCss('.a{--x-font-size:14px}').length, 0, 'custom property names are not font-size');
assert.equal(scanCss('#fade{color:var(--ink-900)}\n#abc, #def:hover{margin:0}').length, 0, 'hex in selectors');
assert.equal(scanCss(".a::after{content:'#fff 11px';font-size:var(--text-sm)}").length, 0, 'strings are blanked');
assert.equal(scanCss('.a{background:url("x#fff.svg");color:#fff}').length, 1, 'url blanked, later hex still found');
assert.equal(scanCss('@media (min-width:900px){.a{color:#fff}}').length, 1, 'inside @media');

// Scanner: comments ignored, positions exact (file:line:column).
assert.equal(scanCss('/* color:#fff; font-size:11px */\n.a{color:var(--ink)}').length, 0);
assert.equal(scanCss('/* multi\nline #fff */ .a{}').length, 0);
const where = scanCss('/* c\nc */\n.a{\n  color: #abc;\n}', 'f.css');
assert.deepEqual(where.map((f) => [f.file, f.line, f.column]), [['f.css', 4, 10]]);

// Allowlist: legacy files may hold violations; any other storefront file is enforced.
const legacyResult = await checkDesignTokens('.');
assert.deepEqual(legacyResult.errors, [], 'the working tree passes the check');
assert.ok(legacyResult.files.includes('apps/web/src/streetwear.css'));
assert.ok(!legacyResult.files.includes(TOKENS_FILE), 'tokens.css is the one place raw values live');
const strict = await checkDesignTokens('.', { legacy: [] });
assert.ok(strict.errors.length > 0, 'with an empty allowlist the legacy files fail');
assert.ok(strict.errors.every((e) => /^apps\/web\/src\/.+\.css:\d+:\d+ /.test(e)), 'errors carry file:line:column');
const partial = await checkDesignTokens('.', { legacy: LEGACY_ALLOWLIST.filter((f) => !f.endsWith('announcement.css')) });
assert.ok(partial.errors.length > 0 && partial.errors.every((e) => e.startsWith('apps/web/src/landing/announcement.css:')), 'an unlisted file is enforced');
const stale = await checkDesignTokens('.', { legacy: [...LEGACY_ALLOWLIST, 'apps/web/src/nope.css'] });
assert.ok(stale.errors.some((e) => e.includes('nope.css')), 'allowlist entries must exist');

// Coverage: every CSS file under apps/web/src is scanned, or explicitly admin, or tokens.css.
const css = await listCssFiles('.');
const covered = new Set([...legacyResult.files, ...ADMIN_CSS, TOKENS_FILE]);
for (const f of css.all) assert.ok(covered.has(f), `${f} is scanned or explicitly admin`);
assert.ok(css.all.includes('apps/web/src/delivery/np-picker.css') && legacyResult.files.includes('apps/web/src/delivery/np-picker.css'), 'subdirectories are walked');
assert.ok(LEGACY_ALLOWLIST.includes('apps/web/src/delivery/np-picker.css'));
assert.ok(!LEGACY_ALLOWLIST.includes('apps/web/src/landing/hero.css'), 'hero.css is token-clean');
for (const f of ADMIN_CSS) assert.ok(css.admin.includes(f));

// tokens.css: tokens only, parses, defines the required names.
const tokens = await readFile(TOKENS_FILE, 'utf8');
const stripped = tokens.replace(/\/\*[\s\S]*?\*\//g, '');
assert.equal((stripped.match(/\{/g) || []).length, 1, 'one rule');
assert.equal((stripped.match(/\}/g) || []).length, 1);
assert.match(stripped.trim(), /^:root\s*\{[\s\S]*\}$/, 'only a :root block');
const body = stripped.slice(stripped.indexOf('{') + 1, stripped.lastIndexOf('}'));
const defined = new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const required = [
  '--graphite-950', '--graphite-900', '--graphite-700', '--ink-900', '--ink-muted', '--cream-100', '--cream-200',
  '--cream-300', '--paper-0', '--line-200', '--moss-700', '--moss-500', '--moss-300', '--lime', '--danger', '--focus-light',
  '--brand-stroke-on-dark', '--brand-stroke-on-light', '--brand-fill-small',
  '--font-display', '--font-text', '--font-mono',
  '--text-2xs', '--text-xs', '--text-sm', '--text-md', '--text-lg', '--display-sm', '--display-md', '--display-lg', '--display-xl',
  '--space-1', '--space-5', '--space-9', '--gutter', '--band-max',
  '--radius-0', '--radius-pill', '--icon-stroke', '--icon-sm', '--icon-md', '--icon-lg', '--hit',
  '--dur-fast', '--dur-base', '--ease', '--z-sticky', '--z-overlay',
];
for (const name of required) assert.ok(defined.has(name), `tokens.css defines ${name}`);
assert.equal(defined.get('--lime'), '#d7f16c');
assert.equal(defined.get('--brand-stroke-on-dark'), '#f1f3ea');
assert.equal(defined.get('--brand-stroke-on-light'), '#1b201d');
// Every var(--x) used inside tokens.css resolves to a defined token.
for (const m of body.matchAll(/var\((--[a-z0-9-]+)\)/g)) assert.ok(defined.has(m[1]), `alias target ${m[1]}`);
// No-op guarantee: no token name is defined or read by any other CSS file (only new names may appear).
const NEW_TOKENS_ALREADY_USED = new Set([ // tokens intentionally adopted by other files
  // landing/hero.css
  '--cream-200', '--cream-300', '--graphite-800', '--graphite-900', '--gutter', '--hit', '--ink-900', '--lime', '--moss-500', '--paper-0',
  '--radius-0', '--radius-pill', '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--text-lg', '--text-2xs', '--text-sm', '--text-xs',
  '--tracking-caps', '--font-text',
  // cart/cart-moment.css
  '--ease',
  // landing/campaign-scenes.css
  '--graphite-700', '--graphite-950', '--moss-300',
  // landing/brand.css
  '--focus-light',
  // cart/checkout.css (buyer warning block)
  '--font-display', '--display-sm', '--icon-lg', '--leading-display',
  // cart/checkout.css
  '--line-200', '--ink-muted', '--tracking-button', '--border-1', '--cream-50', '--sage-200', '--text-md', '--danger', '--leading-text',
  // dashboard/dashboard.css
  '--cream-100', '--display-sm', '--font-mono', '--moss-700', '--warning',
]);
for (const f of css.all.filter((x) => x !== TOKENS_FILE)) {
  const other = (await readFile(f, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const name of defined.keys()) {
    if (NEW_TOKENS_ALREADY_USED.has(name)) continue;
    assert.ok(!new RegExp(`var\\(\\s*${name}\\s*[,)]`).test(other), `${f} reads ${name}, which tokens.css now defines`);
    assert.ok(!new RegExp(`(^|[{;\\s])${name}\\s*:`).test(other), `${f} defines ${name}, which tokens.css also defines`);
  }
}
console.log('design-tokens ok');
