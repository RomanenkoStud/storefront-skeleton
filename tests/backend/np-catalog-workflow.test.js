import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = readFileSync('.github/workflows/np-catalog.yml', 'utf8').replace(/\r\n/g, '\n').replace(/^\s*#.*\n/gm, ''); // full-line comments are prose, not configuration
const jobsBlock = text.slice(text.indexOf('\njobs:\n') + 6);
const jobs = Object.fromEntries([...jobsBlock.matchAll(/^  ([a-z][a-z-]*):\n((?:(?:    .*)?\n)+)/gm)].map(m => [m[1], m[2]]));
const stepsOf = body => body.slice(body.indexOf('    steps:\n') + 11).split(/\n      - /).map((s, i) => (i ? `- ${s}` : s.replace(/^      - /, '- ')));

test('triggers are exactly schedule and workflow_dispatch', () => {
  const onBlock = /^on:\n((?:  .*\n)+)/m.exec(text)[1];
  assert.equal(onBlock, "  schedule:\n    - cron: '30 0 * * *'\n  workflow_dispatch:\n");
  for (const forbidden of ['push:', 'pull_request', 'pull_request_target', 'workflow_call', 'workflow_run', 'release:', 'issue_comment']) assert.ok(!text.includes(forbidden), forbidden);
  assert.ok(!/workflow_dispatch:\n\s+inputs:/.test(text), 'no dispatch inputs, so no force option');
  assert.ok(!/--force|force/i.test(text), 'the workflow has no force path');
});

test('exactly the production and staging jobs, each gated, read-only, time-boxed and serialized without cancelling', () => {
  assert.deepEqual(Object.keys(jobs), ['production', 'staging']);
  assert.match(text, /^permissions:\n  contents: read\njobs:/m);
  assert.ok(!/^\s+[a-z-]+: write$/m.test(text));
  for (const [name, body] of Object.entries(jobs)) {
    assert.match(body, /^    if: github\.ref == 'refs\/heads\/main'$/m, name);
    assert.match(body, /^    permissions:\n      contents: read\n/m, name);
    assert.match(body, /^    timeout-minutes: 15$/m, name);
    assert.match(body, new RegExp(`^    concurrency:\\n      group: np-catalog-${name}\\n      cancel-in-progress: false$`, 'm'), name);
  }
});

test('every action is pinned to a full commit SHA', () => {
  const uses = [...text.matchAll(/^\s*- uses: (\S+)/gm)].map(m => m[1]);
  assert.equal(uses.length, 4);
  for (const u of uses) { assert.match(u, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/, u); }
  assert.ok(!/uses:\s*\.\//.test(text));
});

test('deploy tokens are never referenced; no tracing; no printing of the environment', () => {
  assert.ok(!/CLOUDFLARE_API_TOKEN/.test(text));
  assert.ok(!/set\s+-[a-z]*x/.test(text) && !/--debug|ACTIONS_STEP_DEBUG|xtrace/.test(text));
  assert.ok(!/\b(env|printenv|export)\b\s*(\||$)/m.test(text.replace(/^\s*env:\s*$/gm, '')) && !/\bprintenv\b/.test(text));
  const allowed = new Set(['CLOUDFLARE_ACCOUNT_ID', 'NP_CATALOG_R2_ACCESS_KEY_ID', 'NP_CATALOG_R2_SECRET_ACCESS_KEY', 'STAGING_NP_CATALOG_R2_ACCESS_KEY_ID', 'STAGING_NP_CATALOG_R2_SECRET_ACCESS_KEY']);
  for (const [, name] of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) assert.ok(allowed.has(name), name);
  assert.ok(!/secrets\.GITHUB_TOKEN/.test(text));
});

test('secrets appear only in the env of the single script step; the skip check reads only that job\'s two dedicated secrets', () => {
  const expected = { production: ['NP_CATALOG_R2_ACCESS_KEY_ID', 'NP_CATALOG_R2_SECRET_ACCESS_KEY'], staging: ['STAGING_NP_CATALOG_R2_ACCESS_KEY_ID', 'STAGING_NP_CATALOG_R2_SECRET_ACCESS_KEY'] };
  for (const [name, body] of Object.entries(jobs)) {
    const steps = stepsOf(body), carrying = steps.filter(s => /secrets\./.test(s));
    assert.equal(carrying.length, 1, name);
    const step = carrying[0];
    assert.match(step, /node tools\/np-catalog-sync\.mjs/); assert.equal(steps.filter(s => s.includes('np-catalog-sync.mjs')).length, 1);
    const [envBlock, run] = step.split(/\n        run: \|\n/);
    assert.equal([...envBlock.matchAll(/secrets\./g)].length, [...step.matchAll(/secrets\./g)].length, 'no secret outside the env block');
    assert.ok(!/\$\{\{/.test(run), 'the script body interpolates no expression');
    const mapped = Object.fromEntries([...envBlock.matchAll(/^          (\w+): \$\{\{ secrets\.(\w+) \}\}$/gm)].map(m => [m[1], m[2]]));
    assert.deepEqual(mapped, { CLOUDFLARE_ACCOUNT_ID: 'CLOUDFLARE_ACCOUNT_ID', NP_CATALOG_R2_ACCESS_KEY_ID: expected[name][0], NP_CATALOG_R2_SECRET_ACCESS_KEY: expected[name][1] });
    const skip = /if \[ ([^\n]*) \]; then/.exec(run)[1];
    assert.equal(skip, '-z "$NP_CATALOG_R2_ACCESS_KEY_ID" ] || [ -z "$NP_CATALOG_R2_SECRET_ACCESS_KEY"');
    assert.match(run, /exit 0\n\s*fi\n\s*if \[ -z "\$NP_CATALOG_BUCKET" \]/); assert.match(run, /exit 0\n\s*fi\n\s*node tools\/np-catalog-sync\.mjs/);
    assert.match(run, /GITHUB_STEP_SUMMARY/);
  }
  assert.ok(/np-catalog-sync\.mjs --staging\n?$/.test(jobs.staging) && !/--staging/.test(jobs.production));
  assert.match(jobs.production, /NP_CATALOG_BUCKET: \$\{\{ vars\.NP_CATALOG_BUCKET \}\}\n/);
  assert.match(jobs.staging, /NP_CATALOG_BUCKET: \$\{\{ vars\.STAGING_NP_CATALOG_BUCKET \}\}\n/);
  assert.ok(!/R2_BUCKET|\|\|\s*vars\./.test(text.replace(/NP_CATALOG_R2_/g, '')), 'never falls back to the media bucket variables');
  for (const [name, body] of Object.entries(jobs)) {
    const run = body.split(/\n        run: \|\n/)[1];
    assert.match(run, /if \[ -z "\$NP_CATALOG_BUCKET" \]; then\n[^\n]*::notice::[^\n]*\n[^\n]*GITHUB_STEP_SUMMARY[^\n]*\n\s*exit 0\n\s*fi\n\s*node tools\/np-catalog-sync\.mjs/, `${name} skips with a notice when the bucket variable is missing`);
  }
});
