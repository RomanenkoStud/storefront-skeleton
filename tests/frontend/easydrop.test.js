import assert from 'node:assert/strict';
import {build} from 'vite';
import {renderToStaticMarkup} from 'react-dom/server';
import React from 'react';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
// Bundle the JSX component to a temp ESM file inside the scratch dir (not the repo).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cache = join(root, 'node_modules/.cache'); mkdirSync(cache, {recursive:true});
const dir = mkdtempSync(join(cache, 'easydrop-test-'));
try {
  const entry = join(dir, 'entry.jsx');
  writeFileSync(entry, `export * from '${resolve(root,'apps/web/src/EasyDrop.jsx').replaceAll('\\','/')}';`);
  await build({root:dir,configFile:false,logLevel:'silent',esbuild:{jsx:'automatic'},ssr:{noExternal:true},build:{ssr:entry,outDir:dir,emptyOutDir:false,rollupOptions:{output:{format:'cjs',entryFileNames:'out.cjs'}}}});
  const m = (await import(pathToFileURL(join(dir,'out.cjs')).href)).default;
  const html = el => renderToStaticMarkup(el);
  const easy = {id:'s1',name:'ED',provider:'easydrop',url:'easydrop:s1',feed:{configured:true,keyLast4:'5678',updatedAt:'2026-01-02T10:00:00Z'}};
  const my = {id:'s2',name:'MD',provider:'mydrop',url:'https://mydrop.com.ua/x',feed:null};
  let out1 = html(React.createElement(m.SupplierSource,{supplier:easy}));
  assert.match(out1,/••••5678/); assert.doesNotMatch(out1,/<a /); assert.doesNotMatch(out1,/easydrop:s1/);
  assert.match(html(React.createElement(m.SupplierSource,{supplier:{...easy,feed:{configured:false,keyLast4:null,updatedAt:null}}})),/не налаштовано/);
  assert.doesNotMatch(html(React.createElement(m.SupplierSource,{supplier:{...easy,feed:{configured:true}}})),/••••/);
  assert.match(html(React.createElement(m.SupplierSource,{supplier:my})),/<a href="https:\/\/mydrop.com.ua\/x"/);
  assert.doesNotMatch(html(React.createElement(m.SupplierSource,{supplier:{...my,url:'javascript:alert(1)'}})),/<a /);
  assert.match(html(React.createElement(m.ProviderBadge,{supplier:easy})),/EasyDrop/);
  assert.match(html(React.createElement(m.ProviderBadge,{supplier:my})),/MyDrop/);
  const replace = html(React.createElement(m.ReplaceFeedForm,{supplier:easy,busy:false,onReplace(){}}));
  for (const markup of [replace, html(React.createElement(m.AddEasyDropForm,{busy:false,onAdd(){}}))]) {
    assert.doesNotMatch(markup,/type="password"/);
    for (const a of [/class="secret-input"/,/autoComplete="off"|autocomplete="off"/,/spellCheck="false"|spellcheck="false"/,/data-1p-ignore/,/data-lpignore="true"/,/data-bwignore/,/maxLength="200"|maxlength="200"/]) assert.match(markup,a);
  }
  assert.doesNotMatch(html(React.createElement(m.ProviderBadge,{supplier:easy})),/aria-label/); assert.doesNotMatch(replace,/name="connectionId"/);
  // Form submit: trims, clears the link on success and on 409 failure, rethrows the server message.
  const mk = (name,link) => ({elements:{name:name===null?undefined:{value:name},feedUrl:{value:link}}});
  let sent; const ok = mk('  Shop ','  https://easydrop.one/prom-export?key=12345678&pid=1  ');
  await m.submitFeedForm(ok, async body => {sent = body;});
  assert.deepEqual(sent,{name:'Shop',feedUrl:'https://easydrop.one/prom-export?key=12345678&pid=1'});
  assert.equal(ok.elements.feedUrl.value,'');
  const bad = mk('Shop','https://easydrop.one/prom-export?key=12345678&pid=1');
  await assert.rejects(()=>m.submitFeedForm(bad, async()=>{throw Object.assign(new Error('This EasyDrop link is already used by another supplier'),{status:409});}),/already used by another supplier/);
  assert.equal(bad.elements.feedUrl.value,'');
  console.log('EasyDrop supplier UI tests passed');
} finally { rmSync(dir,{recursive:true,force:true}); }
await import('./manual-product.test.js'); // runs in the npm test chain via this file
