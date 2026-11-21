import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { runDesignTokensCheck } from './design-tokens-check.mjs';
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !['dist', '__pycache__'].includes(entry.name)) await walk(path);
    else if (/\.(m?js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) throw new Error(`Syntax check failed: ${path}`);
    }
  }
}
await walk('apps/api');
await walk('tools');
await walk('packages/catalog');
const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
if (config.main !== 'apps/api/src/index.js' || config.assets.binding !== 'ASSETS') throw new Error('Unexpected Worker bindings.');
await runDesignTokensCheck();
console.log('Worker/scripts syntax and bindings verified. JSX is checked by the production build.');
