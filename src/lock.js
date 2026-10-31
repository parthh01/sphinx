import path from 'node:path';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson } from './config.js';

/** Run `operation` while holding an exclusive lock file. `busy` builds the error thrown once `deadline` passes. */
export async function withFileLock(file, operation, { signal, deadline = 0, busy } = {}) {
  signal?.throwIfAborted();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Another process may have created its lock but not yet written the PID.
    const lock = await readJson(file, {}).catch(() => ({}));
    // A process can die after exclusive creation but before writing its PID.
    // Leave new partial locks alone; recover old orphaned ones on explicit retry.
    let alive = await stat(file).then(info => Date.now() - info.mtimeMs < 30000).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
    if (Number.isInteger(lock.pid) && lock.pid > 0) {
      try { process.kill(lock.pid, 0); alive = true; } catch (err) { alive = err.code !== 'ESRCH'; }
    }
    if (alive) {
      if (deadline > Date.now()) {
        await delay(Math.min(200, deadline - Date.now()), undefined, { signal });
        return withFileLock(file, operation, { signal, deadline, busy });
      }
      throw busy();
    }
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return withFileLock(file, operation, { signal, deadline, busy });
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await operation();
  } finally { await handle.close(); await unlink(file).catch(() => {}); }
}
