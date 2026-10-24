import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPaths, readJson, writeJson } from './config.js';
import { VERSION } from './version.js';

// The questionnaire shows the installed version and, when npm has a newer one,
// offers a one-click update. The update waits until this Sphinx process exits,
// so a check in progress never runs on half-replaced files.
export const PACKAGE = 'sphinx-understand';
const CACHE_MS = 12 * 3600 * 1000;
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const cacheFile = env => path.join(getPaths(env).home, 'version.json');
const parts = version => String(version).split('-')[0].split('.').map(Number);

/** True when `latest` is a higher x.y.z release than `current`. */
export function isNewer(latest, current) {
  if (!/^\d+\.\d+\.\d+$/.test(String(latest))) return false;
  const [a, b] = [parts(latest), parts(current)];
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > (b[index] || 0);
  return false;
}

/** The latest published version, cached for 12 hours. Never throws; null when unknown. */
export async function latestVersion({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (env.SPHINX_UPDATE_CHECK === '0') return null;
  const cached = await readJson(cacheFile(env), null).catch(() => null);
  if (cached && now - Date.parse(cached.checkedAt) < CACHE_MS) return cached.latest ?? null;
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${PACKAGE}/latest`, { signal: AbortSignal.timeout(4000), headers: { accept: 'application/json' } });
    const latest = response.ok ? (await response.json())?.version : null;
    if (typeof latest !== 'string') return null;
    await writeJson(cacheFile(env), { latest, checkedAt: new Date(now).toISOString() }).catch(() => {});
    return latest;
  } catch { return null; }
}

/** How this copy was installed, and so how to update it. Linked checkouts update with git. */
export async function updatePlan({ root = PACKAGE_ROOT } = {}) {
  const real = await realpath(root).catch(() => root);
  if (!real.split(path.sep).includes('node_modules')) return { manager: null, note: 'This is a linked development copy. Update it with git pull.' };
  if (/[\\/](?:\.pnpm|pnpm)[\\/]/.test(real)) return { manager: 'pnpm', command: ['pnpm', 'add', '-g', `${PACKAGE}@latest`] };
  if (/[\\/]\.bun[\\/]/.test(real)) return { manager: 'bun', command: ['bun', 'add', '-g', `${PACKAGE}@latest`] };
  return { manager: 'npm', command: ['npm', 'install', '-g', `${PACKAGE}@latest`] };
}

/** What the questionnaire shows. Never throws. */
export async function updateStatus({ env = process.env, fetchImpl, root } = {}) {
  const latest = await latestVersion({ env, fetchImpl });
  const available = !!latest && isNewer(latest, VERSION);
  const plan = available ? await updatePlan({ root }).catch(() => ({ manager: null })) : null;
  return { current: VERSION, latest, available, ...(plan ? { command: plan.command?.join(' ') ?? null, note: plan.note ?? null } : {}) };
}

const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Install the latest version once process `waitFor` exits. Output goes to
 * update.log in Sphinx's data directory. Resolves false if it cannot start.
 */
export async function scheduleUpdate({ command, waitFor = process.pid, env = process.env, spawnImpl = spawn } = {}) {
  if (!Array.isArray(command) || !command.length) return false;
  const log = path.join(getPaths(env).home, 'update.log');
  const script = `while kill -0 ${Number(waitFor)} 2>/dev/null; do sleep 1; done; { date; ${command.map(shellQuote).join(' ')}; echo "exit $?"; } >> ${shellQuote(log)} 2>&1`;
  try {
    const child = spawnImpl('/bin/sh', ['-c', script], { env, detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    child.unref();
    return true;
  } catch { return false; }
}
