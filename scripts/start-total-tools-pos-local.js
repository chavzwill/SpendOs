'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find(value => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function assertNode24() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error(`Node.js 24+ is required; found ${process.versions.node}`);
}

function temporaryPassword() {
  return `Local-${crypto.randomBytes(12).toString('base64url')}!9aA`;
}

function temporaryPin() {
  const blocked = new Set(['000000', '111111', '123456', '654321', '121212', '112233', '999999']);
  while (true) {
    const pin = String(crypto.randomInt(100000, 1000000));
    if (!blocked.has(pin) && !/^(\d)\1+$/.test(pin) &&
        !'01234567890'.includes(pin) && !'09876543210'.includes(pin)) return pin;
  }
}

function child(commandArgs, cwd, env) {
  return spawn(process.execPath, commandArgs, {
    cwd,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
}
async function waitFor(url, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error(`${label} did not become ready: ${lastError?.message || 'timeout'}`);
}

function runOnce(commandArgs, cwd, env) {
  return new Promise((resolve, reject) => {
    const proc = child(commandArgs, cwd, env);
    proc.once('error', reject);
    proc.once('exit', code => code === 0
      ? resolve()
      : reject(new Error(`${commandArgs.join(' ')} exited with code ${code}`)));
  });
}

async function main() {
  assertNode24();

  const posDir = path.resolve(argValue('pos-dir') || '');
  if (!posDir || !fs.existsSync(path.join(posDir, 'server.js'))) {
    throw new Error('Pass --pos-dir with the Total Tools POS checkout that contains server.js');
  }
  if (!fs.existsSync(path.join(posDir, 'scripts', 'deliver-spendos-outbox.js'))) {
    throw new Error('The selected POS checkout does not contain the SpendOS connector worker');
  }

  const spendosPort = Number(argValue('spendos-port', '4010'));
  const posPort = Number(argValue('pos-port', '33172'));
  const tenant = process.env.SPENDOS_TENANT_ID || 'total-tools';
  const apiKey = process.env.SPENDOS_API_KEY || crypto.randomBytes(32).toString('hex');
  const spendosDb = process.env.SPENDOS_DB || path.join(root, 'spendos.local-link.db');
  const isolatedPosDbPath = path.join(posDir, 'spendos-linked-pos.db');
  const defaultPosDb = `file:${isolatedPosDbPath.replace(/\\/g, '/')}`;
  const explicitPosDb = argValue('pos-db-url', process.env.TURSO_DATABASE_URL || '');
  const posDbUrl = explicitPosDb || defaultPosDb;
  const freshIsolatedPosDb = !explicitPosDb && !fs.existsSync(isolatedPosDbPath);
  const bootstrapUser = process.env.POS_BOOTSTRAP_ADMIN_USER || 'admin';
  const bootstrapPassword = process.env.POS_BOOTSTRAP_ADMIN_PASSWORD || temporaryPassword();
  const bootstrapPin = process.env.POS_BOOTSTRAP_ADMIN_PIN || temporaryPin();
  const spendosEnv = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(spendosPort),
    SPENDOS_TENANT_ID: tenant,
    SPENDOS_API_KEY: apiKey,
    SPENDOS_DB: spendosDb,
  };
  const posEnv = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(posPort),
    TURSO_DATABASE_URL: posDbUrl,
    SPENDOS_TENANT_ID: tenant,
    SPENDOS_INGEST_URL: `http://127.0.0.1:${spendosPort}/v1/events`,
    SPENDOS_API_KEY: apiKey,
    SPENDOS_OUTBOX_BATCH: process.env.SPENDOS_OUTBOX_BATCH || '25',
    SPENDOS_OUTBOX_MAX_ATTEMPTS: process.env.SPENDOS_OUTBOX_MAX_ATTEMPTS || '8',
  };

  if (freshIsolatedPosDb) {
    console.log('Preparing isolated POS database for first boot...');
    await runOnce(['scripts/production-credential-preflight.js'], posDir, {
      ...posEnv,
      NODE_ENV: 'production',
      TURSO_AUTH_TOKEN: '',
      POS_BOOTSTRAP_ADMIN_USER: bootstrapUser,
      POS_BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
      POS_BOOTSTRAP_ADMIN_PIN: bootstrapPin,
    });
    console.log(`Local POS first-boot user: ${bootstrapUser}`);
    console.log(`Temporary local password: ${bootstrapPassword}`);
    console.log(`Temporary local PIN: ${bootstrapPin}`);
    console.log('Change the temporary password through the POS after signing in.');
  }

  console.log('Starting Docker-free local SpendOS + Total Tools POS link...');
  console.log(`SpendOS: http://127.0.0.1:${spendosPort}`);
  console.log(`POS:     http://127.0.0.1:${posPort}`);
  console.log(`POS DB:  ${posDbUrl}`);
  console.log('The shared server key is generated in memory and is not printed or written to disk.');

  const spendos = child(['src/server.js'], root, spendosEnv);
  const children = [spendos];
  const stop = () => {
    for (const proc of children) {
      if (proc && !proc.killed) proc.kill();
    }
  };
  process.once('SIGINT', () => { stop(); process.exit(130); });
  process.once('SIGTERM', () => { stop(); process.exit(143); });

  try {
    await waitFor(`http://127.0.0.1:${spendosPort}/health`, 'SpendOS');
    const pos = child(['server.js'], posDir, posEnv);
    children.push(pos);
    await waitFor(`http://127.0.0.1:${posPort}/`, 'POS');
    await runOnce(['scripts/deliver-spendos-outbox.js'], posDir, posEnv);

    const statusResponse = await fetch(
      `http://127.0.0.1:${spendosPort}/v1/system/status?tenantId=${encodeURIComponent(tenant)}`,
      { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3000) }
    );
    if (!statusResponse.ok) {
      throw new Error(`SpendOS authenticated status check returned HTTP ${statusResponse.status}`);
    }

    console.log('');
    console.log('Local link is ready.');
    console.log('- Docker is not required for this development/integration path.');
    console.log('- POS worker configuration is live in the child process environment.');
    console.log('- Ctrl+C stops both services.');
    console.log('- Production still requires a persistent secret, TLS and the deployment prerequisites.');

    await new Promise((resolve, reject) => {
      for (const proc of children) {
        proc.once('error', reject);
        proc.once('exit', code => {
          if (code !== null && code !== 0) reject(new Error(`A linked service exited with code ${code}`));
        });
      }
    });
  } catch (error) {
    stop();
    throw error;
  }
}

main().catch(error => {
  console.error(`Local link failed: ${error.message}`);
  process.exitCode = 1;
});
