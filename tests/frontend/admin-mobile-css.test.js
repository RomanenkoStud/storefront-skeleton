// Guard for the mobile manager stylesheets. Dependency-free. The rules keep the mobile UI from ever touching desktop
// (1024px and up) or the storefront: every rule lives in the phone or tablet range, every selector starts with .admin-shell, no !important.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'apps/web/src/admin-mobile';
const FILES = ['base.css', 'catalog.css', 'editor.css', 'suppliers.css', 'orders.css', 'settings.css'];
const PHONE = [0, 639.98], TABLET = [640, 1023.98];

const strip = css => css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ');
function splitTop(text, separator) { // split on a character outside (), [] and strings
  const parts = []; let depth = 0, quote = '', start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === separator && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}
// Parses one level of CSS into [{ prelude, body|null }]. A statement without a block (an @import) has body null.
function parseBlocks(text) {
  const out = []; let depth = 0, quote = '', start = 0, open = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') { if (depth === 0) open = i; depth += 1; }
    else if (c === '}') { depth -= 1; assert.ok(depth >= 0, 'unbalanced }'); if (depth === 0) { out.push({ prelude: text.slice(start, open).trim(), body: text.slice(open + 1, i) }); start = i + 1; } }
    else if (c === ';' && depth === 0) { out.push({ prelude: text.slice(start, i).trim(), body: null }); start = i + 1; }
  }
  assert.equal(depth, 0, 'unbalanced {');
  assert.equal(text.slice(start).trim(), '', 'trailing text after the last block');
  return out;
}
// One media query (no commas): only `(min-width: N)` and `(max-width: N)` joined by `and`. Returns its [min, max] range.
function range(query) {
  let min = 0, max = Infinity;
  const features = query.split(/\s+and\s+/i).map(f => f.trim());
  for (const feature of features) {
    const m = /^\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)$/.exec(feature);
    assert.ok(m, `unsupported media feature "${feature}" in "${query}"`);
    if (m[1] === 'min') min = Math.max(min, Number(m[2])); else max = Math.min(max, Number(m[2]));
  }
  return [min, max];
}
const inside = ([min, max], [lo, hi]) => min >= lo && max <= hi && min <= max;
// A media prelude is allowed when EVERY comma-separated query lies inside the phone range or inside the tablet range.
function mediaAllowed(prelude) {
  const m = /^@media\s+([\s\S]+)$/.exec(prelude);
  if (!m) return false;
  return splitTop(m[1], ',').every(query => { const r = range(query); return inside(r, PHONE) || inside(r, TABLET); });
}
// Returns the selector lists of every style rule found, enforcing the media wrapper. `ranges` is the parent's allowed flag.
function checkRules(text, where, state, file) {
  for (const { prelude, body } of parseBlocks(text)) {
    assert.ok(body !== null, `${file}: statement outside a rule "${prelude}"`);
    if (prelude.startsWith('@')) {
      assert.ok(/^@media\s/.test(prelude), `${file}: only @media at-rules are allowed, found "${prelude}"`);
      if (!state.inMedia) assert.ok(mediaAllowed(prelude), `${file}: media query outside the phone/tablet ranges: ${prelude}`);
      else for (const q of splitTop(prelude.replace(/^@media\s+/, ''), ',')) range(q); // nested queries must be plain min/max-width
      checkRules(body, prelude, { inMedia: true, counter: state.counter }, file);
      continue;
    }
    assert.ok(state.inMedia, `${file}: rule outside @media: ${prelude}`);
    for (const selector of splitTop(prelude, ',')) {
      assert.ok(/^\.admin-shell(?![\w-])/.test(selector), `${file}: selector must start with .admin-shell: ${selector}`);
      state.counter.count += 1;
    }
  }
}

const present = readdirSync(DIR).filter(f => f.endsWith('.css')).sort();
assert.deepEqual(present, ['index.css', ...FILES].sort(), 'admin-mobile/ must hold index.css and the six task files, nothing else in CSS');

// index.css: exactly the six imports, in order, and no rules
const index = strip(readFileSync(join(DIR, 'index.css'), 'utf8'));
const imports = parseBlocks(index);
assert.deepEqual(imports.map(b => b.body), FILES.map(() => null), 'index.css must contain only @import statements');
assert.deepEqual(imports.map(b => b.prelude.replace(/\s+/g, ' ')), FILES.map(f => `@import './${f}'`), 'index.css must import the six files in order');

let total = 0;
for (const file of FILES) {
  const raw = readFileSync(join(DIR, file), 'utf8');
  const css = strip(raw);
  assert.ok(!/!\s*important/i.test(css), `${file}: !important is not allowed`);
  assert.ok(!/@import/i.test(css), `${file}: @import belongs in index.css`);
  const state = { inMedia: false, counter: { count: 0 } };
  checkRules(css, 'top', state, file);
  total += state.counter.count;
}
assert.ok(total > 20, 'base.css should define the foundation rules');

// The checker itself: it must reject each violation class (so a green run means something).
const reject = (css, label) => assert.throws(() => checkRules(strip(css), 'top', { inMedia: false, counter: { count: 0 } }, 'x.css'), undefined, label);
reject('.admin-shell a{color:red}', 'rule outside media');
reject('@media (max-width: 639.98px){a{color:red}}', 'selector without .admin-shell');
reject('@media (max-width: 639.98px){.admin-shell a, .other{color:red}}', 'one selector in a list without .admin-shell');
reject('@media (max-width: 700px){.admin-shell a{color:red}}', 'range wider than phone');
reject('@media (min-width: 640px){.admin-shell a{color:red}}', 'open-ended range');
reject('@media (min-width: 1024px){.admin-shell a{color:red}}', 'desktop range');
reject('@media (max-width: 639.98px), (min-width: 641px) and (max-width: 1200px){.admin-shell a{color:red}}', 'one bad alternative');
reject('@keyframes x{from{opacity:0}}', 'keyframes');
reject('@media print{.admin-shell a{color:red}}', 'non-width media');
const ok = css => { const state = { inMedia: false, counter: { count: 0 } }; checkRules(strip(css), 'top', state, 'x.css'); return state.counter.count; };
assert.equal(ok('@media (max-width: 639.98px){.admin-shell a,.admin-shell b:is(.x,.y){color:red}}'), 2);
assert.equal(ok('@media (min-width: 640px) and (max-width: 1023.98px){.admin-shell a{color:red}}'), 1);
assert.equal(ok('@media (max-width: 639.98px), (min-width: 640px) and (max-width: 1023.98px){.admin-shell a{color:red}}'), 1);
assert.equal(ok('@media (max-width: 639.98px){@media (max-width: 400px){.admin-shell a{color:red}}}'), 1);

console.log(`admin-mobile CSS guard passed: ${total} selectors in ${FILES.length} files, index.css imports in order`);
