import path from 'node:path';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson } from './config.js';

const PARTIAL_GRACE = 30000;
const RECOVERY_GRACE = 10000;

/** Read a lock file and decide whether its holder may still be running. */
async function lockState(file) {
  // Another process may have created its lock but not yet written the PID.
  const lock = await readJson(file, {}).catch(() => ({}));
  // A process can die after exclusive creation but before writing its PID.
  // Leave new partial locks alone; recover old orphaned ones on explicit retry.
  const info = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  let alive = !!info && Date.now() - info.mtimeMs < PARTIAL_GRACE;
  if (Number.isInteger(lock.pid) && lock.pid > 0) {
    try { process.kill(lock.pid, 0); alive = true; } catch (err) { alive = err.code !== 'ESRCH'; }
  }
  return { lock, alive, exists: !!info };
}

// Two waiters can both find the same orphaned lock. Removal happens only under a
// second exclusive file and after a fresh look, so a waiter never deletes a lock
// another one has just taken in its place. A lock that is already gone is left
// alone: a new one could appear before the unlink. Returns false while someone
// else recovers.
async function removeOrphan(file) {
  const guard = `${file}.recover`;
  let handle;
  try { handle = await open(guard, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Recovery takes milliseconds; an old guard belongs to a process that died during it.
    const orphaned = await stat(guard).then(info => Date.now() - info.mtimeMs > RECOVERY_GRACE).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
    if (orphaned) await unlink(guard).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return false;
  }
  try {
    const { alive, exists } = await lockState(file);
    if (exists && !alive) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return true;
  } finally { await handle.close(); await unlink(guard).catch(() => {}); }
}

/** Run `operation` with the lock record while holding an exclusive lock file. `busy` builds the error thrown once `deadline` passes; `onBusy` hears the holder's record on each wait. */
export async function withFileLock(file, operation, { signal, deadline = 0, busy, onBusy } = {}) {
  signal?.throwIfAborted();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const { lock, alive } = await lockState(file);
    if (alive) {
      if (deadline > Date.now()) {
        await onBusy?.(lock);
        await delay(Math.min(200, deadline - Date.now()), undefined, { signal });
        return withFileLock(file, operation, { signal, deadline, busy, onBusy });
      }
      throw busy();
    }
    if (!(await removeOrphan(file))) await delay(20, undefined, { signal });
    return withFileLock(file, operation, { signal, deadline, busy, onBusy });
  }
  const held = { pid: process.pid, createdAt: new Date().toISOString() };
  try {
    await handle.writeFile(JSON.stringify(held));
    return await operation(held);
  } finally { await handle.close(); await unlink(file).catch(() => {}); }
}
