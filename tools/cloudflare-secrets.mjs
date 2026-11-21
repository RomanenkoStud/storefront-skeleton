import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdtemp, chmod, writeFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { prepareProductionConfig, validateDeploymentEnvironment, customerAuthSecrets, missingCustomerAuth, prepareStagingConfig, validateStagingEnvironment, stagingCustomerAuthSecrets, missingStagingCustomerAuth, staffAuthSecrets, missingStaffAuth, analyticsSecrets } from './cloudflare-config.mjs';

const warnMissingCustomerAuth = env => warnMissing(missingCustomerAuth(env), env, 'Customer');

async function warnMissing(missing, env, subject) {
  if (!missing.length) return;
  const message = `${subject} sign-in values are missing or invalid: ${missing.join(', ')}. The Worker may answer 503 on ${subject.toLowerCase().includes('staff') ? 'staff' : 'customer'} sign-in unless the value is already bound in Cloudflare. Names only; deployment continues.`;
  console.warn(`::warning::${message}`);
  if (env.GITHUB_STEP_SUMMARY) {
    try { await appendFile(env.GITHUB_STEP_SUMMARY, `WARNING: ${message}\n`); } catch { /* summary is best effort */ }
  }
}

/** Staging deploy: only STAGING_* inputs, never MYDROP_API_KEY, production secrets or the production token.
 * The secrets file holds only configured staging customer and staff authentication secrets. */
export async function deployStaging(env = process.env, spawnProcess = spawn, { prepareConfig = prepareStagingConfig } = {}) {
  validateStagingEnvironment(env);
  await prepareConfig(env);
  await warnMissing(missingStagingCustomerAuth(env), env, 'Staging customer');
  await warnMissing(missingStaffAuth(env, 'STAGING_'), env, 'Staging staff');
  const secrets = { ...stagingCustomerAuthSecrets(env), ...staffAuthSecrets(env, 'STAGING_'), ...analyticsSecrets(env, 'STAGING_') };
  const childEnv = { ...env, CLOUDFLARE_API_TOKEN: env.STAGING_CLOUDFLARE_API_TOKEN, WRANGLER_SEND_METRICS: 'false' };
  return runWranglerDeploy('wrangler.staging.json', secrets, childEnv, spawnProcess);
}

/** Upload secret bindings atomically with the Worker version.
 * Wrangler reopens --secrets-file by path, so a spawned stdin socket cannot be
 * used. Keep the file in a private temporary directory and remove it on every
 * completion path; secret values never appear in argv or application output.
 */
export async function deployProduction(env = process.env, spawnProcess = spawn, { prepareConfig = prepareProductionConfig } = {}) {
  validateDeploymentEnvironment(env);
  await prepareConfig(env);
  await warnMissingCustomerAuth(env);
  await warnMissing(missingStaffAuth(env), env, 'Staff');
  return runWranglerDeploy('wrangler.production.json', { MYDROP_API_KEY: env.MYDROP_API_KEY, ...customerAuthSecrets(env), ...staffAuthSecrets(env), ...analyticsSecrets(env) }, { ...env, WRANGLER_SEND_METRICS: 'false' }, spawnProcess);
}

async function runWranglerDeploy(configPath, secrets, childEnv, spawnProcess) {
  const directory = await mkdtemp(join(tmpdir(), 'storefront-skeleton-deploy-'));
  try {
    await chmod(directory, 0o700);
    const secretsPath = join(directory, 'secrets.json');
    await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
    return await new Promise((resolveResult, reject) => {
      let child;
      try {
        child = spawnProcess('npx', ['--no-install', 'wrangler', 'deploy', '--config', configPath, '--secrets-file', secretsPath], {
          stdio: 'inherit', env: childEnv,
        });
      } catch {
        reject(new Error('Unable to start the Cloudflare deployment process.'));
        return;
      }
      child.once('error', () => reject(new Error('Unable to start the Cloudflare deployment process.')));
      child.once('close', code => resolveResult(code ?? 1));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] || '--check';
    if (mode === '--check') {
      validateDeploymentEnvironment();
      console.log('Required production secrets and settings are present. No remote changes made.');
    } else if (mode === '--staging-check') {
      validateStagingEnvironment();
      console.log('Required staging secrets and settings are present. No remote changes made.');
    } else if (mode === '--staging-deploy') {
      process.exitCode = await deployStaging();
    } else if (mode === '--deploy') {
      process.exitCode = await deployProduction();
    } else {
      throw new Error('Use cloudflare-secrets.mjs --check, --deploy, --staging-check or --staging-deploy.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
