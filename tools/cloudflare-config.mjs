import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Validate without printing values or making any network/Cloudflare changes. */
export function validateDeploymentEnvironment(env = process.env) {
  for (const key of ['CLOUDFLARE_API_TOKEN', 'MYDROP_API_KEY']) {
    if (typeof env[key] !== 'string' || !env[key].trim() || /[\r\n]/.test(env[key])) {
      throw new Error(`Set repository secret ${key} before deploying, including the first deployment.`);
    }
  }
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) {
    throw new Error('Set repository secret CLOUDFLARE_ACCOUNT_ID to the production account ID.');
  }
  const database = env.CLOUDFLARE_D1_DATABASE_ID;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(database || '') || /^0{8}-/.test(database)) {
    throw new Error('Set CLOUDFLARE_D1_DATABASE_ID to the provisioned production D1 UUID.');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.CF_ACCESS_TEAM_NAME || '') || !/^[a-f0-9]{64}$/i.test(env.CF_ACCESS_AUD || '')) {
    throw new Error('Configure CF_ACCESS_TEAM_NAME and the catalog Access application CF_ACCESS_AUD.');
  }
  if (env.CLOUDFLARE_R2_BUCKET && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.CLOUDFLARE_R2_BUCKET)) {
    throw new Error('Invalid CLOUDFLARE_R2_BUCKET name.');
  }
  if (!blank(env.NP_CATALOG_BUCKET)) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.NP_CATALOG_BUCKET)) throw new Error('Invalid NP_CATALOG_BUCKET name.');
    if (String(env.NP_CATALOG_BUCKET).toLowerCase() === String(env.CLOUDFLARE_R2_BUCKET || '').toLowerCase()) throw new Error('NP_CATALOG_BUCKET must differ from CLOUDFLARE_R2_BUCKET.');
  }
  if (env.CATALOG_PRODUCTION_URL) {
    let url;
    try { url = new URL(env.CATALOG_PRODUCTION_URL); } catch { throw new Error('Invalid CATALOG_PRODUCTION_URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('CATALOG_PRODUCTION_URL must be an HTTPS site origin without credentials, query or path.');
    }
  }
}

const present = value => typeof value === 'string' && !!value.trim() && !/[\r\n]/.test(value);
export const DEFAULT_OIDC_REDIRECT_ORIGINS = 'https://example.com';

/** Customer sign-in inputs are optional at deploy time: the Worker fails closed
 * (503 on customer sign-in endpoints) when they are absent, so a missing value
 * must warn, never block the existing production deploy. Names only, no values. */
export function customerAuthSecrets(env = process.env) {
  const secrets = {};
  for (const key of ['GOOGLE_CLIENT_SECRET', 'CUSTOMER_AUTH_HMAC_KEY', 'TELEGRAM_CLIENT_SECRET']) {
    if (present(env[key])) secrets[key] = env[key];
  }
  return secrets;
}

const blank = value => value === undefined || value === null || (typeof value === 'string' && !value.trim());

/** Names only: a value that is unset/blank is "missing", one with CR/LF is "invalid". */
export function missingCustomerAuth(env = process.env) {
  const missing = [];
  const report = (key, kind) => missing.push(`${key} (${kind}${blank(env[key]) ? '' : ', invalid'})`);
  if (!present(env.GOOGLE_CLIENT_ID)) report('GOOGLE_CLIENT_ID', 'variable');
  for (const key of ['GOOGLE_CLIENT_SECRET', 'CUSTOMER_AUTH_HMAC_KEY']) if (!present(env[key])) report(key, 'secret');
  // TELEGRAM_CLIENT_SECRET is optional (pending decision) and never reported as missing.
  return missing;
}

/** Value-based so other generators (staging) never pull production env keys.
 * Default only when unset or blank; any other value is always validated. */
export function validateOrigins(value) {
  if (blank(value)) return DEFAULT_OIDC_REDIRECT_ORIGINS;
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid OIDC_REDIRECT_ORIGINS.');
  const origins = value.split(',').map(item => item.trim()).filter(Boolean);
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('Invalid OIDC_REDIRECT_ORIGINS.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin !== origin) {
      throw new Error('OIDC_REDIRECT_ORIGINS must be comma-separated HTTPS origins without credentials, path, query or trailing slash.');
    }
  }
  if (!origins.length) throw new Error('Invalid OIDC_REDIRECT_ORIGINS.');
  return origins.join(',');
}

export function staffAuthSecrets(env = process.env, prefix = '') {
  const secrets = {};
  for (const key of ['GOOGLE_STAFF_CLIENT_SECRET', 'STAFF_AUTH_HMAC_KEY']) {
    if (present(env[prefix + key])) secrets[key] = env[prefix + key];
  }
  return secrets;
}
export function missingStaffAuth(env = process.env, prefix = '') {
  const missing = [];
  for (const [key, kind] of [['GOOGLE_STAFF_CLIENT_ID', 'variable'], ['GOOGLE_STAFF_CLIENT_SECRET', 'secret'], ['STAFF_AUTH_HMAC_KEY', 'secret']]) {
    const value = env[prefix + key];
    const invalidKey = key === 'STAFF_AUTH_HMAC_KEY' && (typeof value !== 'string' || value.trim().length < 32 || value.trim() === String(env[prefix + 'CUSTOMER_AUTH_HMAC_KEY'] ?? '').trim());
    if (!present(value) || invalidKey) missing.push(`${prefix + key} (${kind}${blank(value) ? '' : ', invalid'})`);
  }
  return missing;
}

export function productionConfig(base, env = process.env) {
  validateDeploymentEnvironment(env);
  if ('DEV_STAFF_ROLE' in env || 'DEV_STAFF_ROLE' in (base.vars || {})) throw new Error('DEV_STAFF_ROLE is forbidden in production.');
  if (base.main !== 'apps/api/src/index.js' || !base.d1_databases?.some(binding => binding.binding === 'DB') || base.assets?.binding !== 'ASSETS') {
    throw new Error('Unexpected catalog Worker entry or database/assets bindings.');
  }
  const config = structuredClone(base);
  delete config.env;
  config.account_id = env.CLOUDFLARE_ACCOUNT_ID;
  config.d1_databases.find(binding => binding.binding === 'DB').database_id = env.CLOUDFLARE_D1_DATABASE_ID;
  // Replace development vars entirely; AUTH_DEV_BYPASS must never reach production.
  config.vars = { APP_ENV: 'production', CF_ACCESS_TEAM_NAME: env.CF_ACCESS_TEAM_NAME, CF_ACCESS_AUD: env.CF_ACCESS_AUD };
  // Validate overrides unconditionally so a bad value fails even before sign-in is configured.
  const origins = validateOrigins(env.OIDC_REDIRECT_ORIGINS);
  if (present(env.GOOGLE_CLIENT_ID)) {
    config.vars.GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID.trim();
    config.vars.OIDC_REDIRECT_ORIGINS = origins;
  }
  const staffOrigins = validateOrigins(env.STAFF_OIDC_REDIRECT_ORIGINS);
  if (present(env.GOOGLE_STAFF_CLIENT_ID)) {
    config.vars.GOOGLE_STAFF_CLIENT_ID = env.GOOGLE_STAFF_CLIENT_ID.trim();
    config.vars.STAFF_OIDC_REDIRECT_ORIGINS = staffOrigins;
  }
  delete config.r2_buckets;
  if (env.CLOUDFLARE_R2_BUCKET) config.r2_buckets = [{ binding: 'MEDIA', bucket_name: env.CLOUDFLARE_R2_BUCKET }];
  // Dedicated Nova Post snapshot bucket (ADR-0011). Unset: the Worker falls back to MEDIA (local/dev only).
  if (!blank(env.NP_CATALOG_BUCKET)) (config.r2_buckets ??= []).push({ binding: 'NP_CATALOG', bucket_name: env.NP_CATALOG_BUCKET });
  config.send_metrics = false;
  return config;
}

export const STAGING_NAME = 'lorem-store-staging';
export const STAGING_D1_NAME = 'lorem-store-staging';
export const STAGING_R2_BUCKET_NAME = 'lorem-store-media-staging';
export const STAGING_NP_CATALOG_BUCKET_NAME = 'lorem-store-np-catalog-staging';
export const STAGING_ORIGIN = 'https://staging.example.com';
export const STAGING_ADMIN_HOST = 'staging.example.com';
// Explicit allowlist of top-level keys staging may inherit. Everything else (every
// binding, vars, unknown future keys) is dropped and must be declared in env.staging.
export const STAGING_INHERITED_KEYS = ['main', 'compatibility_date', 'compatibility_flags', 'observability', 'limits'];
// Top-level binding-type keys that need an explicit staging decision. vars, d1_databases
// and r2_buckets are generated explicitly below.
export const STAGING_BINDING_KEYS = ['define', 'kv_namespaces', 'durable_objects', 'services', 'queues', 'secrets', 'vectorize', 'ai', 'browser', 'analytics_engine_datasets', 'hyperdrive', 'send_email', 'dispatch_namespaces', 'mtls_certificates', 'tail_consumers', 'unsafe', 'version_metadata', 'images', 'secrets_store_secrets', 'workflows', 'pipelines', 'migrations', 'containers', 'vpc_services', 'ratelimits'];
// Keys env.staging may replace on top of the allowlist.
const STAGING_OVERRIDE_KEYS = ['name', 'workers_dev', 'preview_urls', 'triggers', 'assets'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Staging inputs only; the production token, MyDrop key and production customer-auth values are never read. */
export function validateStagingEnvironment(env = process.env) {
  if (!present(env.STAGING_CLOUDFLARE_API_TOKEN)) {
    throw new Error('Set repository secret STAGING_CLOUDFLARE_API_TOKEN before deploying staging.');
  }
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '')) {
    throw new Error('Set repository secret CLOUDFLARE_ACCOUNT_ID to the account ID.');
  }
  const staging = env.STAGING_D1_DATABASE_ID;
  if (!UUID.test(staging || '') || /^0{8}-/.test(staging)) throw new Error('Set STAGING_D1_DATABASE_ID to the staging D1 UUID.');
  if (!present(env.CLOUDFLARE_D1_DATABASE_ID)) {
    throw new Error('Set CLOUDFLARE_D1_DATABASE_ID (production value, used only to prove staging differs).');
  }
  if (same(staging, env.CLOUDFLARE_D1_DATABASE_ID)) throw new Error('STAGING_D1_DATABASE_ID must differ from the production D1 UUID.');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.CF_ACCESS_TEAM_NAME || '')) throw new Error('Configure CF_ACCESS_TEAM_NAME.');
  if (!/^[a-f0-9]{64}$/i.test(env.STAGING_CF_ACCESS_AUD || '')) throw new Error('STAGING_CF_ACCESS_AUD must be a 64-character hex audience tag.');
  if (!present(env.CF_ACCESS_AUD)) throw new Error('Set CF_ACCESS_AUD (production value, used only to prove staging differs).');
  if (same(env.STAGING_CF_ACCESS_AUD, env.CF_ACCESS_AUD)) throw new Error('STAGING_CF_ACCESS_AUD must differ from the production CF_ACCESS_AUD.');
  if (!blank(env.STAGING_R2_BUCKET)) {
    if (env.STAGING_R2_BUCKET !== STAGING_R2_BUCKET_NAME) throw new Error(`STAGING_R2_BUCKET must be exactly ${STAGING_R2_BUCKET_NAME}.`);
    if (!present(env.CLOUDFLARE_R2_BUCKET)) throw new Error('Set CLOUDFLARE_R2_BUCKET (production value, used only to prove staging differs).');
    if (same(env.STAGING_R2_BUCKET, env.CLOUDFLARE_R2_BUCKET)) throw new Error('STAGING_R2_BUCKET must differ from the production bucket.');
  }
  if (!blank(env.STAGING_NP_CATALOG_BUCKET)) {
    if (env.STAGING_NP_CATALOG_BUCKET !== STAGING_NP_CATALOG_BUCKET_NAME) throw new Error(`STAGING_NP_CATALOG_BUCKET must be exactly ${STAGING_NP_CATALOG_BUCKET_NAME}.`);
    if (!present(env.NP_CATALOG_BUCKET)) throw new Error('Set NP_CATALOG_BUCKET (production value, used only to prove staging differs).');
    if (same(env.STAGING_NP_CATALOG_BUCKET, env.NP_CATALOG_BUCKET)) throw new Error('STAGING_NP_CATALOG_BUCKET must differ from the production NP catalog bucket.');
  }
  if (!blank(env.STAGING_URL) && env.STAGING_URL !== STAGING_ORIGIN) throw new Error(`STAGING_URL must be exactly ${STAGING_ORIGIN}.`);
  if (!blank(env.STAGING_ADMIN_URL) && env.STAGING_ADMIN_URL !== `https://${STAGING_ADMIN_HOST}`) throw new Error(`STAGING_ADMIN_URL must be exactly https://${STAGING_ADMIN_HOST}.`);
}

/** Dashboard analytics, optional. With a read-only "Account Analytics: Read" token the Worker reads
 * Cloudflare GraphQL usage for its own script, D1 database and media bucket. Everything is sent as Worker secrets so the
 * generated vars stay unchanged. Staging (prefix 'STAGING_') uses only staging identifiers. Empty without the token. */
export function analyticsSecrets(env = process.env, prefix = '') {
  const token = env[prefix + 'CF_ANALYTICS_API_TOKEN'];
  if (!present(token)) return {};
  const secrets = { CF_ANALYTICS_API_TOKEN: token.trim() };
  if (/^[0-9a-f]{32}$/.test(String(env.CLOUDFLARE_ACCOUNT_ID || '').trim())) secrets.INFRA_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID.trim();
  const database = prefix ? env.STAGING_D1_DATABASE_ID : env.CLOUDFLARE_D1_DATABASE_ID;
  if (present(database)) secrets.INFRA_D1_DATABASE_ID = database.trim();
  const bucket = prefix ? (present(env.STAGING_R2_BUCKET) ? STAGING_R2_BUCKET_NAME : null) : env.CLOUDFLARE_R2_BUCKET;
  if (present(bucket)) secrets.INFRA_R2_BUCKET = bucket.trim();
  return secrets;
}

/** Customer-auth inputs for staging (STAGING_* names only). Optional; names only, no values. */
export function stagingCustomerAuthSecrets(env = process.env) {
  const secrets = {};
  if (present(env.STAGING_GOOGLE_CLIENT_SECRET)) secrets.GOOGLE_CLIENT_SECRET = env.STAGING_GOOGLE_CLIENT_SECRET;
  if (present(env.STAGING_CUSTOMER_AUTH_HMAC_KEY)) secrets.CUSTOMER_AUTH_HMAC_KEY = env.STAGING_CUSTOMER_AUTH_HMAC_KEY;
  return secrets;
}
export function missingStagingCustomerAuth(env = process.env) {
  const missing = [];
  if (!present(env.STAGING_GOOGLE_CLIENT_ID)) missing.push('STAGING_GOOGLE_CLIENT_ID (variable)');
  for (const key of ['STAGING_GOOGLE_CLIENT_SECRET', 'STAGING_CUSTOMER_AUTH_HMAC_KEY']) if (!present(env[key])) missing.push(`${key} (secret)`);
  return missing;
}

/** Flat staging config: allowlisted inherited keys + env.staging + validated staging inputs. Never has `env`. */
export function stagingConfig(base, env = process.env) {
  validateStagingEnvironment(env);
  const overlay = base.env?.staging;
  if (!overlay || typeof overlay !== 'object') throw new Error('wrangler.jsonc has no env.staging block.');
  if (base.main !== 'apps/api/src/index.js' || base.assets?.binding !== 'ASSETS') throw new Error('Unexpected catalog Worker entry or assets binding.');
  for (const key of STAGING_BINDING_KEYS) {
    if (key in base && !(key in overlay)) throw new Error(`Top-level binding ${key} must be declared explicitly in env.staging.`);
  }
  const allowed = new Set([...STAGING_OVERRIDE_KEYS, ...STAGING_BINDING_KEYS, 'vars', 'd1_databases']);
  for (const key of Object.keys(overlay)) if (!allowed.has(key)) throw new Error(`env.staging key ${key} is not allowed.`);
  const config = {};
  for (const key of STAGING_INHERITED_KEYS) if (key in base) config[key] = structuredClone(base[key]);
  for (const key of Object.keys(overlay)) config[key] = structuredClone(overlay[key]);
  const vars = config.vars;
  if (config.name !== STAGING_NAME) throw new Error(`env.staging.name must be ${STAGING_NAME}.`);
  if (!vars || vars.APP_ENV !== 'staging') throw new Error('env.staging.vars.APP_ENV must be staging.');
  if ('DEV_STAFF_ROLE' in vars || 'DEV_STAFF_ROLE' in env) throw new Error('DEV_STAFF_ROLE is forbidden in staging.');
  if ('AUTH_DEV_BYPASS' in vars) throw new Error('env.staging.vars must not define AUTH_DEV_BYPASS.');
  if (validateOrigins(vars.OIDC_REDIRECT_ORIGINS) !== STAGING_ORIGIN || vars.OIDC_REDIRECT_ORIGINS !== STAGING_ORIGIN) throw new Error(`env.staging.vars.OIDC_REDIRECT_ORIGINS must be exactly ${STAGING_ORIGIN}.`);
  if (vars.STAFF_OIDC_REDIRECT_ORIGINS !== undefined && vars.STAFF_OIDC_REDIRECT_ORIGINS !== STAGING_ORIGIN) throw new Error('Invalid staging STAFF_OIDC_REDIRECT_ORIGINS.');
  if (vars.ADMIN_HOST !== STAGING_ADMIN_HOST) throw new Error(`env.staging.vars.ADMIN_HOST must be exactly ${STAGING_ADMIN_HOST}.`);
  if (!Array.isArray(config.triggers?.crons) || config.triggers.crons.length) throw new Error('env.staging.triggers.crons must be empty.');
  if (config.workers_dev !== false || config.preview_urls !== false) throw new Error('env.staging must set workers_dev and preview_urls to false.');
  if (config.assets?.binding !== 'ASSETS' || config.assets.run_worker_first !== true) throw new Error('env.staging.assets must keep the ASSETS binding with run_worker_first true.');
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1 || config.d1_databases[0].binding !== 'DB' || config.d1_databases[0].database_name !== STAGING_D1_NAME) {
    throw new Error(`env.staging must bind exactly one D1 database DB named ${STAGING_D1_NAME}.`);
  }
  config.d1_databases[0].database_id = env.STAGING_D1_DATABASE_ID;
  config.account_id = env.CLOUDFLARE_ACCOUNT_ID;
  config.vars = {
    APP_ENV: 'staging', OIDC_REDIRECT_ORIGINS: STAGING_ORIGIN, ADMIN_HOST: STAGING_ADMIN_HOST,
    CF_ACCESS_TEAM_NAME: env.CF_ACCESS_TEAM_NAME, CF_ACCESS_AUD: env.STAGING_CF_ACCESS_AUD,
  };
  if (present(env.STAGING_GOOGLE_CLIENT_ID)) config.vars.GOOGLE_CLIENT_ID = env.STAGING_GOOGLE_CLIENT_ID.trim();
  if (present(env.STAGING_GOOGLE_STAFF_CLIENT_ID)) {
    config.vars.GOOGLE_STAFF_CLIENT_ID = env.STAGING_GOOGLE_STAFF_CLIENT_ID.trim();
    config.vars.STAFF_OIDC_REDIRECT_ORIGINS = STAGING_ORIGIN;
  }
  delete config.r2_buckets;
  if (!blank(env.STAGING_R2_BUCKET)) config.r2_buckets = [{ binding: 'MEDIA', bucket_name: STAGING_R2_BUCKET_NAME }];
  if (!blank(env.STAGING_NP_CATALOG_BUCKET)) (config.r2_buckets ??= []).push({ binding: 'NP_CATALOG', bucket_name: STAGING_NP_CATALOG_BUCKET_NAME });
  config.send_metrics = false;
  return config;
}

export async function prepareStagingConfig(env = process.env) {
  const base = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  const config = stagingConfig(base, env);
  await writeFile('wrangler.staging.json', JSON.stringify(config, null, 2) + '\n');
  return config;
}

export async function prepareProductionConfig(env = process.env) {
  const base = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  const config = productionConfig(base, env);
  await writeFile('wrangler.production.json', JSON.stringify(config, null, 2) + '\n');
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--staging') {
      await prepareStagingConfig();
      console.log('Staging configuration validated and wrangler.staging.json written. No remote changes made.');
    } else {
      await prepareProductionConfig();
      console.log('Production configuration and required secrets validated. No remote changes made.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
