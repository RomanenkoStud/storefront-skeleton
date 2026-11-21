import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname } from 'node:path';
import { productionConfig, stagingConfig, validateDeploymentEnvironment, STAGING_NP_CATALOG_BUCKET_NAME } from '../../tools/cloudflare-config.mjs';
import { deployStaging } from '../../tools/cloudflare-secrets.mjs';

const base = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const prodEnv = { CLOUDFLARE_API_TOKEN: 'prod-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), MYDROP_API_KEY: 'prod-mydrop', CLOUDFLARE_D1_DATABASE_ID: '12345678-1234-1234-1234-123456789abc', CF_ACCESS_TEAM_NAME: 'test-team', CF_ACCESS_AUD: 'b'.repeat(64) };
const env = {
  STAGING_CLOUDFLARE_API_TOKEN: 'staging-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  STAGING_D1_DATABASE_ID: 'abcdef12-1234-1234-1234-123456789abc', CLOUDFLARE_D1_DATABASE_ID: prodEnv.CLOUDFLARE_D1_DATABASE_ID,
  CF_ACCESS_TEAM_NAME: 'test-team', STAGING_CF_ACCESS_AUD: 'c'.repeat(64), CF_ACCESS_AUD: 'b'.repeat(64),
};
const fresh = () => structuredClone(base);
const bad = (patch, pattern, baseOverride) => assert.throws(() => stagingConfig(baseOverride ?? fresh(), { ...env, ...patch }), pattern);

test('env.staging only adds the committed block; assets match top level except run_worker_first', () => {
  assert.deepEqual(Object.keys(base.env), ['staging']);
  const { env: _ignored, ...top } = base;
  assert.equal(top.name, 'lorem-store');
  assert.deepEqual(top.triggers.crons, ['*/5 * * * *']);
  const { run_worker_first: topFirst, ...topAssets } = base.assets;
  const { run_worker_first: stagingFirst, ...stagingAssets } = base.env.staging.assets;
  assert.deepEqual(stagingAssets, topAssets);
  assert.ok(Array.isArray(topFirst));
  assert.equal(stagingFirst, true);
  assert.equal(base.env.staging.vars.AUTH_DEV_BYPASS, undefined);
  assert.equal(base.env.staging.routes, undefined);
  assert.equal(base.env.staging.d1_databases[0].database_name, 'lorem-store-staging');
});

test('staging generator output is flat, staging-only and metric-free', () => {
  const config = stagingConfig(fresh(), env);
  assert.equal(config.env, undefined);
  assert.equal(config.name, 'lorem-store-staging');
  assert.equal(config.main, 'apps/api/src/index.js');
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.triggers, { crons: [] });
  assert.equal(config.send_metrics, false);
  assert.equal(config.account_id, env.CLOUDFLARE_ACCOUNT_ID);
  assert.equal(config.assets.run_worker_first, true);
  assert.deepEqual(config.d1_databases, [{ binding: 'DB', database_name: 'lorem-store-staging', database_id: env.STAGING_D1_DATABASE_ID, migrations_dir: 'migrations' }]);
  assert.deepEqual(config.vars, { APP_ENV: 'staging', OIDC_REDIRECT_ORIGINS: 'https://staging.example.com', ADMIN_HOST: 'staging.example.com', CF_ACCESS_TEAM_NAME: 'test-team', CF_ACCESS_AUD: 'c'.repeat(64) });
  assert.equal(config.r2_buckets, undefined);
  assert.ok(!JSON.stringify(config).includes(prodEnv.CLOUDFLARE_D1_DATABASE_ID));
  assert.ok(!JSON.stringify(config).includes('b'.repeat(64)));
});

test('staging google client id, R2 and ignored production overrides', () => {
  const config = stagingConfig(fresh(), {
    ...env, STAGING_GOOGLE_CLIENT_ID: ' staging-client.apps.example ', STAGING_R2_BUCKET: 'lorem-store-media-staging', CLOUDFLARE_R2_BUCKET: 'prod-media',
    GOOGLE_CLIENT_ID: 'prod-client', OIDC_REDIRECT_ORIGINS: 'https://example.com', ADMIN_HOST: 'evil.example', GOOGLE_CLIENT_SECRET: 'x', CUSTOMER_AUTH_HMAC_KEY: 'y', TELEGRAM_CLIENT_SECRET: 'z', MYDROP_API_KEY: 'k', AUTH_DEV_BYPASS: 'true',
  });
  assert.equal(config.vars.GOOGLE_CLIENT_ID, 'staging-client.apps.example');
  assert.equal(config.vars.OIDC_REDIRECT_ORIGINS, 'https://staging.example.com');
  assert.equal(config.vars.ADMIN_HOST, 'staging.example.com');
  assert.equal(config.vars.AUTH_DEV_BYPASS, undefined);
  assert.deepEqual(config.r2_buckets, [{ binding: 'MEDIA', bucket_name: 'lorem-store-media-staging' }]);
  assert.ok(!JSON.stringify(config).includes('prod-media'));
});

test('NP_CATALOG binds only when its variable is set, in staging and production', () => {
  const np = { STAGING_NP_CATALOG_BUCKET: STAGING_NP_CATALOG_BUCKET_NAME, NP_CATALOG_BUCKET: 'prod-np' };
  assert.equal(STAGING_NP_CATALOG_BUCKET_NAME, 'lorem-store-np-catalog-staging');
  assert.equal(stagingConfig(fresh(), env).r2_buckets, undefined, 'unset: no binding, Worker falls back to MEDIA');
  assert.deepEqual(stagingConfig(fresh(), { ...env, ...np }).r2_buckets, [{ binding: 'NP_CATALOG', bucket_name: STAGING_NP_CATALOG_BUCKET_NAME }]);
  const both = stagingConfig(fresh(), { ...env, ...np, STAGING_R2_BUCKET: 'lorem-store-media-staging', CLOUDFLARE_R2_BUCKET: 'prod-media' });
  assert.deepEqual(both.r2_buckets.map(b => b.binding), ['MEDIA', 'NP_CATALOG']);
  assert.ok(!JSON.stringify(both).includes('prod-np'));
  bad({ ...np, STAGING_NP_CATALOG_BUCKET: 'other-bucket' }, /exactly lorem-store-np-catalog-staging/);
  bad({ STAGING_NP_CATALOG_BUCKET: STAGING_NP_CATALOG_BUCKET_NAME }, /NP_CATALOG_BUCKET/);
  bad({ STAGING_NP_CATALOG_BUCKET: STAGING_NP_CATALOG_BUCKET_NAME, NP_CATALOG_BUCKET: STAGING_NP_CATALOG_BUCKET_NAME }, /differ/);
  const prod = { ...prodEnv, CLOUDFLARE_R2_BUCKET: 'prod-media' };
  assert.equal(productionConfig(base, prod).r2_buckets.length, 1);
  assert.deepEqual(productionConfig(base, { ...prod, NP_CATALOG_BUCKET: 'prod-np' }).r2_buckets, [{ binding: 'MEDIA', bucket_name: 'prod-media' }, { binding: 'NP_CATALOG', bucket_name: 'prod-np' }]);
  assert.doesNotThrow(() => validateDeploymentEnvironment({ ...prod, NP_CATALOG_BUCKET: 'prod-np' }));
  assert.throws(() => validateDeploymentEnvironment({ ...prod, NP_CATALOG_BUCKET: 'Bad_Name' }), /Invalid NP_CATALOG_BUCKET/);
  assert.throws(() => validateDeploymentEnvironment({ ...prod, NP_CATALOG_BUCKET: 'prod-media' }), /must differ/);
});

test('staging generator fails closed on identity and input mistakes', () => {
  bad({ STAGING_CLOUDFLARE_API_TOKEN: '' }, /STAGING_CLOUDFLARE_API_TOKEN/);
  bad({ CLOUDFLARE_ACCOUNT_ID: 'short' }, /CLOUDFLARE_ACCOUNT_ID/);
  bad({ STAGING_D1_DATABASE_ID: '' }, /STAGING_D1_DATABASE_ID/);
  bad({ STAGING_D1_DATABASE_ID: 'not-a-uuid' }, /STAGING_D1_DATABASE_ID/);
  bad({ STAGING_D1_DATABASE_ID: '00000000-0000-0000-0000-000000000000' }, /STAGING_D1_DATABASE_ID/);
  bad({ STAGING_D1_DATABASE_ID: env.CLOUDFLARE_D1_DATABASE_ID.toUpperCase() }, /differ from the production D1/);
  bad({ CLOUDFLARE_D1_DATABASE_ID: '' }, /CLOUDFLARE_D1_DATABASE_ID/);
  bad({ CLOUDFLARE_D1_DATABASE_ID: undefined }, /CLOUDFLARE_D1_DATABASE_ID/);
  bad({ STAGING_CF_ACCESS_AUD: 'short' }, /64-character/);
  bad({ STAGING_CF_ACCESS_AUD: '' }, /64-character/);
  bad({ STAGING_CF_ACCESS_AUD: 'b'.repeat(64) }, /differ from the production CF_ACCESS_AUD/);
  bad({ CF_ACCESS_AUD: '' }, /CF_ACCESS_AUD/);
  bad({ CF_ACCESS_TEAM_NAME: '' }, /CF_ACCESS_TEAM_NAME/);
  bad({ STAGING_R2_BUCKET: 'other-bucket', CLOUDFLARE_R2_BUCKET: 'prod' }, /exactly lorem-store-media-staging/);
  bad({ STAGING_R2_BUCKET: 'lorem-store-media-staging' }, /CLOUDFLARE_R2_BUCKET/);
  bad({ STAGING_R2_BUCKET: 'lorem-store-media-staging', CLOUDFLARE_R2_BUCKET: 'lorem-store-media-staging' }, /differ/);
  bad({ STAGING_URL: 'https://example.com' }, /STAGING_URL/);
  bad({ STAGING_ADMIN_URL: 'https://staging-admin.example.com' }, /STAGING_ADMIN_URL/);
});

test('staging generator rejects an unsafe committed env.staging block', () => {
  const mutate = (fn, pattern) => { const b = fresh(); fn(b.env.staging); bad({}, pattern, b); };
  mutate(s => { s.name = 'lorem-store'; }, /env\.staging\.name/);
  mutate(s => { s.vars.APP_ENV = 'production'; }, /APP_ENV/);
  mutate(s => { s.vars.AUTH_DEV_BYPASS = 'true'; }, /AUTH_DEV_BYPASS/);
  mutate(s => { s.vars.OIDC_REDIRECT_ORIGINS = 'https://example.com'; }, /OIDC_REDIRECT_ORIGINS/);
  mutate(s => { s.vars.OIDC_REDIRECT_ORIGINS = 'https://staging.example.com,https://example.com'; }, /OIDC_REDIRECT_ORIGINS/);
  mutate(s => { s.vars.ADMIN_HOST = 'example.com'; }, /ADMIN_HOST/);
  mutate(s => { delete s.vars.ADMIN_HOST; }, /ADMIN_HOST/);
  mutate(s => { s.triggers = { crons: ['* * * * *'] }; }, /crons/);
  mutate(s => { delete s.triggers; }, /crons/);
  mutate(s => { s.workers_dev = true; }, /workers_dev/);
  mutate(s => { s.preview_urls = true; }, /preview_urls/);
  mutate(s => { s.assets.run_worker_first = ['/api/*']; }, /run_worker_first/);
  mutate(s => { s.d1_databases[0].database_name = 'lorem-store'; }, /D1 database/);
  mutate(s => { s.routes = ['example.com/*']; }, /not allowed/);
  mutate(s => { s.r2_buckets = [{ binding: 'MEDIA', bucket_name: 'lorem-store-media' }]; }, /not allowed/);
  const noBlock = fresh(); delete noBlock.env;
  bad({}, /env\.staging/, noBlock);
});

test('a new top-level binding never silently reaches staging', () => {
  const withKv = fresh();
  withKv.kv_namespaces = [{ binding: 'PROD_KV', id: 'prodid' }];
  withKv.future_unknown_key = { secret: 'prod' };
  withKv.send_metrics = true;
  bad({}, /kv_namespaces must be declared explicitly/, withKv);
  withKv.env.staging.kv_namespaces = [{ binding: 'STAGE_KV', id: 'stageid' }];
  const config = stagingConfig(withKv, env);
  assert.deepEqual(config.kv_namespaces, [{ binding: 'STAGE_KV', id: 'stageid' }]);
  assert.equal(config.future_unknown_key, undefined);
  assert.equal(config.send_metrics, false);
  assert.ok(!JSON.stringify(config).includes('prodid'));
});

test('production generator strips env and its output is byte-identical to the pre-staging config', () => {
  const output = JSON.stringify(productionConfig(fresh(), prodEnv), null, 2);
  const legacy = fresh(); delete legacy.env;
  assert.equal(output, JSON.stringify(productionConfig(legacy, prodEnv), null, 2));
  assert.ok(!('env' in JSON.parse(output)));
  assert.ok(!output.includes('staging'));
});

function runStaging(testEnv) {
  const calls = [];
  const spawn = (command, args, config) => {
    const path = args[args.indexOf('--secrets-file') + 1];
    calls.push({ command, args, env: config.env, secrets: path === undefined ? undefined : JSON.parse(readFileSync(path, 'utf8')), mode: path && statSync(path).mode & 0o777, path });
    const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child;
  };
  return deployStaging(testEnv, spawn, { prepareConfig: async () => {} }).then(code => ({ code, call: calls[0] }));
}

test('staging deploy uses the staging config, staging token and only configured staging secrets', async () => {
  const { code, call } = await runStaging({ ...env, MYDROP_API_KEY: 'prod-mydrop', CLOUDFLARE_API_TOKEN: 'prod-token', GOOGLE_CLIENT_SECRET: 'prod-google', CUSTOMER_AUTH_HMAC_KEY: 'prod-hmac', TELEGRAM_CLIENT_SECRET: 'prod-tg', STAGING_GOOGLE_CLIENT_SECRET: 'staging-google', STAGING_CUSTOMER_AUTH_HMAC_KEY: 'staging-hmac' });
  assert.equal(code, 0);
  assert.deepEqual(call.args.slice(0, 5), ['--no-install', 'wrangler', 'deploy', '--config', 'wrangler.staging.json']);
  assert.ok(!call.args.includes('wrangler.production.json') && !call.args.includes('--env'));
  assert.deepEqual(call.secrets, { GOOGLE_CLIENT_SECRET: 'staging-google', CUSTOMER_AUTH_HMAC_KEY: 'staging-hmac' });
  if (process.platform !== 'win32') assert.equal(call.mode, 0o600);
  assert.equal(call.env.CLOUDFLARE_API_TOKEN, 'staging-token');
  assert.equal(call.env.WRANGLER_SEND_METRICS, 'false');
  assert.ok(!call.args.join(' ').includes('staging-hmac'));
  assert.equal(existsSync(call.path), false);
  assert.equal(existsSync(dirname(call.path)), false);
});

test('staging deploy never forwards production secrets when staging ones are absent', async () => {
  const { call } = await runStaging({ ...env, MYDROP_API_KEY: 'prod-mydrop', GOOGLE_CLIENT_SECRET: 'prod-google', CUSTOMER_AUTH_HMAC_KEY: 'prod-hmac' });
  assert.deepEqual(call.secrets, {});
});

test('staging deploy fails before preparing configuration without the staging token', async () => {
  let prepared = false;
  await assert.rejects(deployStaging({ ...env, STAGING_CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_API_TOKEN: 'prod-token' }, () => {}, { prepareConfig: async () => { prepared = true; } }), /STAGING_CLOUDFLARE_API_TOKEN/);
  assert.equal(prepared, false);
});

test('wrangler.staging.json is gitignored and migrations dir exists', () => {
  assert.match(readFileSync('.gitignore', 'utf8'), /^wrangler\.staging\.json$/m);
  assert.ok(readdirSync('migrations').length > 0);
});
