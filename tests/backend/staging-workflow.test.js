import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = readFileSync('.github/workflows/staging.yml', 'utf8').replace(/\r\n/g, '\n');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

test('staging workflow deploys pushes to the staging branch only, with minimal permissions and serialized runs', () => {
  const onBlock = /^on:\n((?:  .*\n)+)/m.exec(text)[1];
  assert.equal(onBlock, '  push:\n    branches: [staging]\n  workflow_dispatch:\n');
  for (const trigger of ['workflow_call', 'on: workflow_run', 'schedule:', 'release:', 'pull_request']) assert.ok(!text.includes(trigger), trigger);
  assert.match(text, /permissions:\n  contents: read\nconcurrency:/);
  assert.ok(!/^\s+[a-z-]+: write$/m.test(text));
  assert.match(text, /concurrency:\n  group: cloudflare-staging\n  cancel-in-progress: false/);
});

test('staging workflow never reuses ci.yml, deploy.yml or production deployment', () => {
  assert.ok(!/uses:\s*\.\/\.github\/workflows/.test(text));
  assert.ok(!/cloudflare-production|wrangler\.production\.json|--deploy\b|prepareProductionConfig|--env\b/.test(text));
  assert.ok(!/node tools\/cloudflare-config\.mjs\s*$/m.test(text));
  assert.ok(!/cloudflare-secrets\.mjs --deploy/.test(text));
});

test('staging workflow references no production-only secrets or values', () => {
  for (const name of ['MYDROP_API_KEY', 'TELEGRAM_CLIENT_SECRET']) assert.ok(!text.includes(name), name);
  for (const forbidden of [/secrets\.CLOUDFLARE_API_TOKEN/, /secrets\.GOOGLE_CLIENT_SECRET/, /secrets\.CUSTOMER_AUTH_HMAC_KEY/, /vars\.GOOGLE_CLIENT_ID/, /vars\.OIDC_REDIRECT_ORIGINS/, /vars\.CATALOG_PRODUCTION_URL/, /\bGOOGLE_CLIENT_SECRET:/, /\bCUSTOMER_AUTH_HMAC_KEY:/]) {
    assert.ok(!forbidden.test(text), String(forbidden));
  }
  const allowed = new Set(['STAGING_CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'STAGING_GOOGLE_CLIENT_SECRET', 'STAGING_CUSTOMER_AUTH_HMAC_KEY', 'STAGING_GOOGLE_STAFF_CLIENT_SECRET', 'STAGING_STAFF_AUTH_HMAC_KEY', 'STAGING_CF_ANALYTICS_API_TOKEN', 'GITHUB_TOKEN']);
  for (const [, name] of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) assert.ok(allowed.has(name), name);
  const prodVars = new Set(['CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_R2_BUCKET', 'NP_CATALOG_BUCKET', 'CF_ACCESS_AUD', 'CF_ACCESS_TEAM_NAME']);
  for (const [, name] of text.matchAll(/vars\.([A-Z0-9_]+)/g)) assert.ok(name.startsWith('STAGING_') || prodVars.has(name), name);
});

test('staging workflow passes both NP catalog bucket variables to the config generator steps only', () => {
  assert.equal([...text.matchAll(/^ +STAGING_NP_CATALOG_BUCKET: \$\{\{ vars\.STAGING_NP_CATALOG_BUCKET \}\}$/gm)].length, 2);
  assert.equal([...text.matchAll(/^ +NP_CATALOG_BUCKET: \$\{\{ vars\.NP_CATALOG_BUCKET \}\}$/gm)].length, 2);
  assert.ok(!/NP_CATALOG_BUCKET: .*(R2_BUCKET|\|\|)/.test(text), 'no media bucket fallback');
});

test('staging workflow runs the required steps in order', () => {
  const order = ['Deploy only commits on refs/heads/staging', 'npm run check', 'npm test', 'npm run build', 'cloudflare-config.mjs --staging', 'deploy --dry-run --config wrangler.staging.json', "'d1', 'list', '--json'", 'wrangler r2 bucket info storefront-skeleton-media-staging', 'd1_migrations', 'd1 migrations apply DB --remote --config wrangler.staging.json', 'cloudflare-secrets.mjs --staging-deploy', 'cloudflareaccess.com'];
  let at = -1;
  for (const marker of order) { const next = text.indexOf(marker); assert.ok(next > at, marker); at = next; }
  assert.match(text, /ref: \$\{\{ needs\.gate\.outputs\.sha \}\}/);
});

test('staging gate refuses every ref except refs/heads/staging and pins the deployed sha', () => {
  assert.match(text, /DISPATCH_REF: \$\{\{ github\.ref \}\}/);
  assert.match(text, /if \[ "\$DISPATCH_REF" != "refs\/heads\/staging" \]; then[\s\S]*?exit 1/);
  assert.match(text, /DISPATCH_SHA: \$\{\{ github\.sha \}\}/);
  assert.ok(!/refs\/heads\/main/.test(text));
});

test('smoke checks are conditional, exact and treat 2xx as exposure', () => {
  assert.match(text, /STAGING_URL', 'https:\/\/staging\.example\.com'/);
  assert.match(text, /STAGING_ADMIN_URL', 'https:\/\/staging\.example\.com'/);
  assert.ok(text.includes("key === 'STAGING_ADMIN_URL' ? '/admin' : '/'"));
  assert.match(text, /is not set/);
  assert.match(text, /redirect: 'manual'/);
  assert.match(text, /\[302, 303\]/);
  assert.match(text, /host is exposed/);
});

test('production deploy waits for the staging-first gate, which holds no deployment credentials', () => {
  assert.match(ci, /deploy:\n    name: Deploy verified main to production\n    needs: \[verify, staging-gate\]/);
  const gate = /^  staging-gate:\n([\s\S]*?)^  deploy:/m.exec(ci)[1];
  assert.doesNotMatch(gate, /secrets\.|vars\.|CLOUDFLARE_/);
  assert.match(gate, /github\.event_name == 'pull_request' && github\.base_ref == 'main'/);
  assert.match(gate, /requirePromotion\(/);
  assert.match(gate, /requireOnStaging\(/);
  assert.match(ci, /permissions:\n  contents: read\n(?:  #.*\n)?  actions: read\n  pull-requests: read\n/);
  assert.ok(!/wrangler|cloudflare-secrets|staging\.json/.test(gate));
  const deploy = readFileSync('.github/workflows/deploy.yml', 'utf8');
  assert.match(deploy, /actions: read\n  pull-requests: read/);
  assert.ok(!/cloudflare-staging|wrangler\.staging\.json|--staging/.test(ci + deploy));
});


test('production deploy passes the Nova Post catalog bucket so cloudflare-config binds NP_CATALOG', () => {
  const [, deployJob] = ci.split(/^  deploy:\n/m);
  const jobEnv = /^    env:\n((?:      .*\n)+)/m.exec(deployJob)[1];
  assert.match(jobEnv, /^      NP_CATALOG_BUCKET: \$\{\{ vars\.NP_CATALOG_BUCKET \}\}$/m);
  assert.ok(!/STAGING_NP_CATALOG/.test(ci), 'production never reads the staging catalog bucket');
});

test('remote Cloudflare commands name the staging config and the first-deploy tolerance is exact', () => {
  assert.match(text, /'d1', 'list', '--json', '--config', 'wrangler\.staging\.json'/);
  assert.match(text, /r2 bucket info storefront-skeleton-media-staging --config wrangler\.staging\.json/);
  assert.match(text, /\/no such table: d1_migrations\/i/);
});

test('staging credentials are bound per step and never reach install, check, test or build', () => {
  const [, deployJob] = text.split(/^  deploy:\n/m);
  const jobEnv = /^    env:\n((?:      .*\n)+)/m.exec(deployJob)[1];
  assert.doesNotMatch(jobEnv, /secrets\.|STAGING_/);
  const steps = deployJob.split(/^      - /m).slice(1);
  const named = marker => steps.find(step => step.includes(marker));
  for (const marker of ['run: npm ci', 'run: npm run check', 'run: npm test', 'run: npm run build', 'deploy --dry-run --config wrangler.staging.json']) {
    const step = named(marker);
    assert.ok(step, marker);
    assert.doesNotMatch(step, /secrets\.|vars\.|STAGING_|CLOUDFLARE_/, marker);
  }
  const withSecrets = steps.filter(step => /secrets\./.test(step)).map(step => /name: (.*)/.exec(step)?.[1]);
  assert.deepEqual(withSecrets, [
    'Validate every staging input and write wrangler.staging.json',
    'Verify the staging D1 name resolves to STAGING_D1_DATABASE_ID',
    'Verify the staging R2 bucket exists',
    'Check staging migration history against this ref',
    'Apply staging migrations',
    'Deploy tested code, assets and staging secrets together',
  ]);
  assert.doesNotMatch(named('Access gate smoke checks'), /secrets\./);
  assert.match(named('--staging-deploy'), /STAGING_GOOGLE_CLIENT_SECRET[\s\S]*STAGING_CUSTOMER_AUTH_HMAC_KEY/);
});
