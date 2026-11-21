import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = readFileSync('.github/workflows/card-thumbnails.yml', 'utf8').replace(/\r\n/g, '\n').replace(/^\s*#.*\n/gm, ''); // full-line comments are prose
const jobsBlock = text.slice(text.indexOf('\njobs:\n') + 6);
const jobs = Object.fromEntries([...jobsBlock.matchAll(/^  ([a-z][a-z-]*):\n((?:(?:    .*)?\n)+)/gm)].map(m => [m[1], m[2]]));

test('triggers: nightly schedule plus workflow_dispatch with environment, limit and dry_run; nothing else', () => {
  const onBlock = /^on:\n((?:  .*\n)+)/m.exec(text)[1];
  assert.match(onBlock, /^  schedule:\n    - cron: '40 1 \* \* \*'\n  workflow_dispatch:\n    inputs:\n/);
  for (const forbidden of ['push:', 'pull_request', 'pull_request_target', 'workflow_call', 'workflow_run', 'release:', 'issue_comment']) assert.ok(!text.includes(forbidden), forbidden);
  const inputs = onBlock.slice(onBlock.indexOf('inputs:\n') + 8);
  assert.deepEqual([...inputs.matchAll(/^      (\w+):$/gm)].map(m => m[1]), ['environment', 'limit', 'dry_run']);
  assert.match(inputs, /environment:[^]*type: choice\n        options:\n          - production\n          - staging\n        default: production/);
  assert.match(inputs, /dry_run:[^]*type: boolean\n        default: false/);
});

test('exactly one production and one staging job; production is the only one the schedule reaches', () => {
  assert.deepEqual(Object.keys(jobs), ['production', 'staging']);
  assert.match(jobs.production, /^    if: github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'schedule' \|\| inputs\.environment == 'production'\)$/m);
  assert.match(jobs.staging, /^    if: github\.ref == 'refs\/heads\/main' && github\.event_name == 'workflow_dispatch' && inputs\.environment == 'staging'$/m);
  assert.match(text, /^permissions:\n  contents: read\njobs:/m);
  assert.ok(!/^\s+[a-z-]+: write$/m.test(text));
  for (const [name, body] of Object.entries(jobs)) {
    assert.match(body, /^    permissions:\n      contents: read\n/m, name);
    assert.match(body, /^    timeout-minutes: \d+$/m, name);
    assert.match(body, new RegExp(`^    concurrency:\\n      group: card-thumbnails-${name}\\n      cancel-in-progress: false$`, 'm'), name);
  }
});

test('every action is pinned to a full commit SHA', () => {
  const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map(m => m[1]);
  assert.equal(uses.length, 4);
  for (const u of uses) assert.match(u, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/, u);
});

test('deploy tokens are never referenced; no tracing; no environment dumps', () => {
  assert.ok(!/(^|[^_A-Z])CLOUDFLARE_API_TOKEN/.test(text.replace(/THUMBS_CLOUDFLARE_API_TOKEN/g, '')), 'no deploy token name');
  assert.ok(!/secrets\.(STAGING_)?CLOUDFLARE_API_TOKEN/.test(text));
  assert.ok(!/set\s+-[a-z]*x/.test(text) && !/--debug|ACTIONS_STEP_DEBUG|xtrace|printenv/.test(text));
  const allowed = new Set(['CLOUDFLARE_ACCOUNT_ID', 'THUMBS_CLOUDFLARE_API_TOKEN', 'STAGING_THUMBS_CLOUDFLARE_API_TOKEN']);
  for (const [, name] of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) assert.ok(allowed.has(name), name);
  assert.ok(!/secrets\.GITHUB_TOKEN/.test(text));
});

test('each job reads only its own environment token, database id and bucket, and passes the matching --env', () => {
  const expected = {
    production: { token: 'THUMBS_CLOUDFLARE_API_TOKEN', db: 'CLOUDFLARE_D1_DATABASE_ID', bucket: 'CLOUDFLARE_R2_BUCKET', flag: '--env prod' },
    staging: { token: 'STAGING_THUMBS_CLOUDFLARE_API_TOKEN', db: 'STAGING_D1_DATABASE_ID', bucket: 'STAGING_R2_BUCKET', flag: '--env staging' },
  };
  for (const [name, body] of Object.entries(jobs)) {
    const e = expected[name];
    const secrets = [...new Set([...body.matchAll(/secrets\.(\w+)/g)].map(m => m[1]))].sort();
    assert.deepEqual(secrets, ['CLOUDFLARE_ACCOUNT_ID', e.token].sort(), name);
    assert.deepEqual([...body.matchAll(/vars\.(\w+)/g)].map(m => m[1]), [e.db, e.bucket], name);
    assert.match(body, new RegExp(`THUMBS_CLOUDFLARE_API_TOKEN: \\$\\{\\{ secrets\\.${e.token} \\}\\}`), name);
    assert.ok(body.includes(`args="${e.flag}"`), name);
    assert.equal(body.includes('--env staging'), name === 'staging');
  }
});

test('a missing token is detected in an early gate step; every later step runs only when the gate says ready', () => {
  for (const [name, body] of Object.entries(jobs)) {
    const steps = body.slice(body.indexOf('    steps:\n') + 11).split(/\n      - /).map(x => x.trim().replace(/^- /, ''));
    assert.equal(steps.length, 5, name);
    const [gate, ...rest] = steps;
    assert.match(gate, /^name: Check configuration\n\s+id: gate\n/, name);
    assert.match(gate, /if \[ -z "\$THUMBS_CLOUDFLARE_API_TOKEN" \] \|\| \[ -z "\$CLOUDFLARE_ACCOUNT_ID" \]; then\n[^\n]*::notice::[^\n]*\n[^\n]*GITHUB_STEP_SUMMARY[^\n]*\n\s*echo "ready=false" >> "\$GITHUB_OUTPUT"\n\s*else\n\s*echo "ready=true" >> "\$GITHUB_OUTPUT"\n\s*fi/, name);
    assert.ok(!gate.includes('exit 1') && !/node |npm /.test(gate), 'the gate never fails and runs no project code');
    for (const step of rest) assert.match(step, /if: steps\.gate\.outputs\.ready == 'true'/, `${name}: ${step.slice(0, 40)}`);
    assert.ok(rest[2].includes('npm ci'), name);
  }
});

test('the script step validates limit, takes inputs only through env, and runs the tool last', () => {
  for (const [name, body] of Object.entries(jobs)) {
    const [envBlock, run] = body.split(/\n        run: \|\n/).slice(-2);
    assert.ok(!/\$\{\{/.test(run), `${name}: inputs reach the script only through env`);
    assert.match(envBlock, /LIMIT: \$\{\{ inputs\.limit \}\}\n\s+DRY_RUN: \$\{\{ inputs\.dry_run \}\}/);
    assert.match(run, /\*\[!0-9\]\*\) echo "::error::limit must be a whole number"; exit 1;;/);
    assert.match(run, /if \[ "\$DRY_RUN" = "true" \]; then args="\$args --dry-run"; fi\n\s*node tools\/card-thumbnails\.mjs \$args\n*$/);
  }
});
