import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { productionConfig, stagingConfig, staffAuthSecrets, missingStaffAuth } from '../../tools/cloudflare-config.mjs';
import { deployProduction } from '../../tools/cloudflare-secrets.mjs';

const env = { CLOUDFLARE_API_TOKEN:'synthetic-token',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),MYDROP_API_KEY:'synthetic-test-key',CLOUDFLARE_D1_DATABASE_ID:'12345678-1234-1234-1234-123456789abc',CF_ACCESS_TEAM_NAME:'test-team',CF_ACCESS_AUD:'b'.repeat(64) };
const options = { prepareConfig: async () => {} };

for (const outcome of ['success','nonzero','signal','spawn-error','sync-error']) {
  test(`deployment secret file is private, readable by path and removed after ${outcome}`, async () => {
    let path;
    const spawn = (command,args,config) => {
      assert.equal(command,'npx');assert.equal(config.stdio,'inherit');
      path = args[args.indexOf('--secrets-file')+1];
      assert.notEqual(path,'/dev/stdin');assert.ok(!args.includes(env.MYDROP_API_KEY));
      if (process.platform !== 'win32') assert.equal(statSync(dirname(path)).mode & 0o777,0o700);
      if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777,0o600);
      assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),{MYDROP_API_KEY:env.MYDROP_API_KEY});
      assert.equal(config.env.WRANGLER_SEND_METRICS,'false');
      if(outcome==='sync-error')throw new Error('synthetic spawn failure');
      const child=new EventEmitter();
      queueMicrotask(()=>{if(outcome==='spawn-error')child.emit('error',new Error('synthetic spawn failure'));else child.emit('close',outcome==='success'?0:outcome==='signal'?null:7);});
      return child;
    };
    if(outcome.endsWith('error'))await assert.rejects(deployProduction(env,spawn,options),/Unable to start/);
    else assert.equal(await deployProduction(env,spawn,options),outcome==='success'?0:outcome==='signal'?1:7);
    assert.ok(path);assert.equal(existsSync(path),false);assert.equal(existsSync(dirname(path)),false);
    assert.equal(env.WRANGLER_SEND_METRICS,undefined);
  });
}

test('missing deployment secret fails before preparing configuration or spawning Wrangler', async () => {
 let prepared=false,spawned=false;
 await assert.rejects(deployProduction({...env,MYDROP_API_KEY:''},()=>{spawned=true;},{prepareConfig:async()=>{prepared=true;}}),/MYDROP_API_KEY/);
 assert.equal(prepared,false);assert.equal(spawned,false);
});

const auth = { GOOGLE_CLIENT_ID:'fake-client-id.apps.example', GOOGLE_CLIENT_SECRET:'fake-google-secret-xyz', CUSTOMER_AUTH_HMAC_KEY:'fake-hmac-key-abc', TELEGRAM_CLIENT_SECRET:'fake-telegram-secret' };

async function runDeploy(testEnv) {
  let secrets, args;
  const logs = [], realWarn = console.warn, realLog = console.log;
  console.warn = (...a) => logs.push(a.join(' ')); console.log = (...a) => logs.push(a.join(' '));
  try {
    const spawn = (command, a) => {
      args = a; secrets = JSON.parse(readFileSync(a[a.indexOf('--secrets-file') + 1], 'utf8'));
      const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 0)); return child;
    };
    await deployProduction(testEnv, spawn, options);
  } finally { console.warn = realWarn; console.log = realLog; }
  return { secrets, args, logs };
}

test('customer auth secrets are bound through the secrets file when set, without warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-test-')), summary = join(dir, 'summary.md');
  try {
    const { secrets, args, logs } = await runDeploy({ ...env, ...auth, GITHUB_STEP_SUMMARY: summary });
    assert.deepEqual(secrets, { MYDROP_API_KEY: env.MYDROP_API_KEY, GOOGLE_CLIENT_SECRET: auth.GOOGLE_CLIENT_SECRET, CUSTOMER_AUTH_HMAC_KEY: auth.CUSTOMER_AUTH_HMAC_KEY, TELEGRAM_CLIENT_SECRET: auth.TELEGRAM_CLIENT_SECRET });
    for (const value of Object.values(auth)) assert.ok(!args.join(' ').includes(value));
    assert.ok(logs.every(line => !line.includes('Customer sign-in'))); assert.ok(!readFileSync(summary, 'utf8').includes('Customer sign-in'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing customer auth warns by name only, omits values and does not fail the deploy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'summary-test-')), summary = join(dir, 'summary.md');
  try {
    const { secrets, logs } = await runDeploy({ ...env, GOOGLE_CLIENT_ID: auth.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: auth.GOOGLE_CLIENT_SECRET, CUSTOMER_AUTH_HMAC_KEY: '  ', GITHUB_STEP_SUMMARY: summary });
    assert.deepEqual(secrets, { MYDROP_API_KEY: env.MYDROP_API_KEY, GOOGLE_CLIENT_SECRET: auth.GOOGLE_CLIENT_SECRET });
    const output = logs.join('\n') + readFileSync(summary, 'utf8');
    assert.match(output, /CUSTOMER_AUTH_HMAC_KEY/); assert.doesNotMatch(output, /GOOGLE_CLIENT_SECRET/);
    for (const value of [...Object.values(auth), env.MYDROP_API_KEY]) assert.ok(!output.includes(value));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('all customer auth values unset: only MYDROP secret, warning lists names', async () => {
  const { secrets, logs } = await runDeploy(env);
  assert.deepEqual(secrets, { MYDROP_API_KEY: env.MYDROP_API_KEY });
  const output = logs.join('\n');
  for (const name of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'CUSTOMER_AUTH_HMAC_KEY']) assert.match(output, new RegExp(name));
  assert.doesNotMatch(output, /TELEGRAM/);
});

test('production config carries auth vars and is otherwise unchanged', () => {
  const base = { main:'apps/api/src/index.js', d1_databases:[{binding:'DB',database_id:'x'}], assets:{binding:'ASSETS'}, vars:{AUTH_DEV_BYPASS:'true'} };
  const without = productionConfig(base, env);
  assert.deepEqual(without.vars, { APP_ENV:'production', CF_ACCESS_TEAM_NAME:env.CF_ACCESS_TEAM_NAME, CF_ACCESS_AUD:env.CF_ACCESS_AUD });
  const withAuth = productionConfig(base, { ...env, ...auth });
  assert.deepEqual(withAuth.vars, { ...without.vars, GOOGLE_CLIENT_ID: auth.GOOGLE_CLIENT_ID, OIDC_REDIRECT_ORIGINS: 'https://example.com' });
  assert.ok(!JSON.stringify(withAuth).includes(auth.GOOGLE_CLIENT_SECRET) && !JSON.stringify(withAuth).includes(auth.CUSTOMER_AUTH_HMAC_KEY));
  const { vars: _a, ...restA } = without, { vars: _b, ...restB } = withAuth; assert.deepEqual(restA, restB);
  assert.equal(productionConfig(base, { ...env, ...auth, OIDC_REDIRECT_ORIGINS: 'https://a.example, https://b.example' }).vars.OIDC_REDIRECT_ORIGINS, 'https://a.example,https://b.example');
  for (const bad of ['http://a.example', 'https://a.example/path', 'https://a.example/', 'nonsense']) {
    assert.throws(() => productionConfig(base, { ...env, ...auth, OIDC_REDIRECT_ORIGINS: bad }), /OIDC_REDIRECT_ORIGINS/);
  }
});

test('OIDC override: blank uses default, CR/LF and invalid values always throw without echo, even without a client id', () => {
  const base = { main:'apps/api/src/index.js', d1_databases:[{binding:'DB',database_id:'x'}], assets:{binding:'ASSETS'}, vars:{} };
  assert.equal(productionConfig(base, { ...env, ...auth, OIDC_REDIRECT_ORIGINS: '  ' }).vars.OIDC_REDIRECT_ORIGINS, 'https://example.com');
  for (const bad of ['https://a.example\nhttps://b.example', 'https://a.example\r', 'http://secret-host.example', 'https://secret-host.example/path', 'secret-nonsense', ',']) {
    for (const withClient of [{}, auth]) {
      try { productionConfig(base, { ...env, ...withClient, OIDC_REDIRECT_ORIGINS: bad }); assert.fail('expected throw'); }
      catch (error) { assert.match(error.message, /OIDC_REDIRECT_ORIGINS/); assert.ok(!error.message.includes('secret-host') && !error.message.includes('secret-nonsense') && !/[\r\n]/.test(error.message)); }
    }
  }
});

test('warning says missing or invalid, reports a newline secret by name only and never echoes values', async () => {
  const bad = 'fake-line\nbreak-value';
  const { secrets, logs } = await runDeploy({ ...env, ...auth, GOOGLE_CLIENT_SECRET: bad, GOOGLE_CLIENT_ID: 'fake-id\r' });
  assert.ok(!('GOOGLE_CLIENT_SECRET' in secrets));
  const output = logs.join('\n');
  assert.match(output, /missing or invalid/);
  assert.match(output, /may answer 503 on customer sign-in unless the value is already bound in Cloudflare/);
  assert.match(output, /GOOGLE_CLIENT_SECRET \(secret, invalid\)/);
  assert.match(output, /GOOGLE_CLIENT_ID \(variable, invalid\)/);
  assert.doesNotMatch(output, /CUSTOMER_AUTH_HMAC_KEY/);
  for (const value of ['fake-line', 'break-value', 'fake-id', auth.CUSTOMER_AUTH_HMAC_KEY]) assert.ok(!output.includes(value));
});

const staffAuth = { GOOGLE_STAFF_CLIENT_ID: 'staff-client', GOOGLE_STAFF_CLIENT_SECRET: 'staff-secret', STAFF_AUTH_HMAC_KEY: 's'.repeat(40) };
test('staff vars and secret bindings stay separate from customer auth', async () => {
  const base = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const config = productionConfig(base, { ...env, ...staffAuth });
  assert.equal(config.vars.GOOGLE_STAFF_CLIENT_ID, staffAuth.GOOGLE_STAFF_CLIENT_ID);
  assert.equal(config.vars.STAFF_OIDC_REDIRECT_ORIGINS, 'https://example.com');
  assert.ok(!JSON.stringify(config).includes(staffAuth.GOOGLE_STAFF_CLIENT_SECRET));
  const { secrets, args, logs } = await runDeploy({ ...env, ...auth, ...staffAuth });
  assert.equal(secrets.GOOGLE_STAFF_CLIENT_SECRET, staffAuth.GOOGLE_STAFF_CLIENT_SECRET);
  assert.equal(secrets.STAFF_AUTH_HMAC_KEY, staffAuth.STAFF_AUTH_HMAC_KEY);
  assert.equal(logs.length, 0);
  for (const secret of [staffAuth.GOOGLE_STAFF_CLIENT_SECRET, staffAuth.STAFF_AUTH_HMAC_KEY]) assert.ok(!args.join(' ').includes(secret));
});
test('missing or unsafe staff config warns without exposing values or blocking deployment', async () => {
  assert.equal(missingStaffAuth(staffAuth).length, 0);
  assert.match(missingStaffAuth({ ...staffAuth, STAFF_AUTH_HMAC_KEY: 'short-secret' }).join(), /STAFF_AUTH_HMAC_KEY/);
  assert.match(missingStaffAuth({ ...staffAuth, CUSTOMER_AUTH_HMAC_KEY: staffAuth.STAFF_AUTH_HMAC_KEY }).join(), /STAFF_AUTH_HMAC_KEY/);
  const { logs } = await runDeploy({ ...env, ...auth });
  assert.match(logs.join(), /GOOGLE_STAFF_CLIENT_ID/);
  assert.match(logs.join(), /STAFF_AUTH_HMAC_KEY/);
});
test('staging staff vars and secrets never fall back to production values', () => {
  const base = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  const staging = { ...env, ...staffAuth, STAGING_CLOUDFLARE_API_TOKEN:'staging-token', STAGING_D1_DATABASE_ID:'abcdef12-1234-1234-1234-123456789abc', STAGING_CF_ACCESS_AUD:'c'.repeat(64) };
  assert.deepEqual(staffAuthSecrets(staging, 'STAGING_'), {});
  assert.equal(stagingConfig(base, staging).vars.GOOGLE_STAFF_CLIENT_ID, undefined);
  const configured = { ...staging, STAGING_GOOGLE_STAFF_CLIENT_ID:'staging-staff', STAGING_GOOGLE_STAFF_CLIENT_SECRET:'staging-secret', STAGING_STAFF_AUTH_HMAC_KEY:'z'.repeat(40) };
  assert.equal(stagingConfig(base, configured).vars.STAFF_OIDC_REDIRECT_ORIGINS, 'https://staging.example.com');
  assert.equal(stagingConfig(base, configured).vars.GOOGLE_STAFF_CLIENT_ID, 'staging-staff');
  assert.deepEqual(staffAuthSecrets(configured, 'STAGING_'), { GOOGLE_STAFF_CLIENT_SECRET:'staging-secret', STAFF_AUTH_HMAC_KEY:'z'.repeat(40) });
  assert.throws(() => stagingConfig(base, { ...configured, DEV_STAFF_ROLE:'manager' }), /DEV_STAFF_ROLE/);
  assert.throws(() => productionConfig(base, { ...env, DEV_STAFF_ROLE:'owner' }), /DEV_STAFF_ROLE/);
});

// optional dashboard analytics secrets.
import { analyticsSecrets } from '../../tools/cloudflare-config.mjs';
test('analytics secrets: empty without a token; staging uses only staging identifiers', () => {
  const account = 'a'.repeat(32);
  assert.deepEqual(analyticsSecrets({ CLOUDFLARE_ACCOUNT_ID: account }), {});
  assert.deepEqual(analyticsSecrets({ CF_ANALYTICS_API_TOKEN: ' tok ', CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_D1_DATABASE_ID: 'prod-db', CLOUDFLARE_R2_BUCKET: 'prod-media' }),
    { CF_ANALYTICS_API_TOKEN: 'tok', INFRA_ACCOUNT_ID: account, INFRA_D1_DATABASE_ID: 'prod-db', INFRA_R2_BUCKET: 'prod-media' });
  const staging = analyticsSecrets({ STAGING_CF_ANALYTICS_API_TOKEN: 'stok', CF_ANALYTICS_API_TOKEN: 'prod-tok', CLOUDFLARE_ACCOUNT_ID: account, STAGING_D1_DATABASE_ID: 'stg-db', CLOUDFLARE_D1_DATABASE_ID: 'prod-db', STAGING_R2_BUCKET: 'lorem-store-media-staging', CLOUDFLARE_R2_BUCKET: 'prod-media' }, 'STAGING_');
  assert.deepEqual(staging, { CF_ANALYTICS_API_TOKEN: 'stok', INFRA_ACCOUNT_ID: account, INFRA_D1_DATABASE_ID: 'stg-db', INFRA_R2_BUCKET: 'lorem-store-media-staging' });
  assert.deepEqual(analyticsSecrets({ CF_ANALYTICS_API_TOKEN: 'prod-tok' }, 'STAGING_'), {}, 'staging never falls back to the production token');
});
