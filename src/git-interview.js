import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { CLI, launchCheckpointTerminal, waitForCheckpointTerminal } from './terminal-launch.js';

/** Collect human input in a separate terminal while the original Git hook waits.
 * The caller owns queue cleanup and must validate the receipt before returning 0.
 */
export async function runGitCheckpointTerminal({ request, env = process.env, signal, launch = launchCheckpointTerminal, waitForResult = waitForCheckpointTerminal, timeoutMs = 25 * 60 * 1000, platform = process.platform } = {}) {
  const result = (status, reason) => ({ status, id: request?.id, ...(reason ? { reason } : {}) });
  if (signal?.aborted) return result('pending', 'cancelled');
  if (env.SPHINX_EVALUATOR === '1' || env.SSH_CONNECTION || env.SSH_TTY || (env.CI && env.CI !== 'false' && env.CI !== '0') || !['darwin', 'linux'].includes(platform) || (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)) return result('unavailable', 'no-desktop');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return result('pending', 'timeout');
  const controller = new AbortController(), deadline = Date.now() + timeoutMs;
  let timer, stop, stopped;
  const interrupted = new Promise(resolve => {
    stop = reason => {
      if (stopped) return;
      stopped = reason; controller.abort(); resolve(result('pending', reason));
    };
  });
  const onAbort = () => stop('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  timer = setTimeout(() => stop('timeout'), timeoutMs);
  const operation = async () => {
    let started;
    try {
      // A concurrent Git invocation may own the short launch lock. Retrying a
      // busy lock reuses the existing window; it never starts another interview.
      do {
        controller.signal.throwIfAborted();
        started = await launch({ request, env, platform, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (started?.status === 'busy') await delay(Math.min(50, Math.max(1, deadline - Date.now())), undefined, { signal: controller.signal });
      } while (started?.status === 'busy');
    } catch { return stopped ? result('pending', stopped) : result('unavailable', 'launch-failed'); }
    if (started?.status === 'passed') return result('passed');
    if (started?.status === 'stopped') return result('stopped');
    if (!['opened', 'already-open'].includes(started?.status)) return result(started?.status === 'suppressed' ? 'pending' : 'unavailable');
    try {
      controller.signal.throwIfAborted();
      const status = await waitForResult({ id: request.id, env, timeoutMs: Math.max(1, deadline - Date.now()), signal: controller.signal });
      controller.signal.throwIfAborted();
      // A window opened for another Git attempt never asked this one whether to
      // continue. Once it passes, this one's own window asks (see launch).
      if (started.status === 'already-open' && status === 'passed' && request.delivery === 'hook' && !request.more) return await operation();
      return result(['passed', 'skipped', 'stopped', 'pending', 'unavailable', 'interrupted'].includes(status) ? status : 'interrupted');
    } catch { return stopped ? result('pending', stopped) : result('interrupted'); }
  };
  try { return await Promise.race([operation(), interrupted]); }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    // Stop any unfinished bookkeeping after timeout, without killing a terminal
    // or coding client. A human may still save progress in that window.
    controller.abort();
  }
}

/** Whether to ask in the terminal instead of the browser. `auto` uses the
 * browser only where Sphinx can open it in the background (local macOS). */
export function prefersTerminal(config, { env = process.env, platform = process.platform } = {}) {
  if (config.interface === 'terminal') return true;
  if (config.interface === 'browser') return false;
  return !!(env.SSH_CONNECTION || env.SSH_TTY) || platform !== 'darwin';
}

// The terminal Git was run from, if a person is looking at it. A coding
// agent's shell has no visible terminal, so its pipes never qualify.
function openVisibleTerminal(stderr = process.stderr) {
  if (!stderr.isTTY) return null;
  try { return openSync('/dev/tty', 'r+'); } catch { return null; }
}

/**
 * Ask in the terminal: inline in Git's own terminal when a person is there,
 * otherwise in a new terminal window. Resolves { status: 'unavailable' } when
 * neither is possible, so the caller can fall back to the browser.
 */
export async function runGitTerminalCheck({ request, env = process.env, signal, cwd = process.cwd(), openTty = openVisibleTerminal, spawnImpl = spawn, openWindow = runGitCheckpointTerminal } = {}) {
  const tty = openTty();
  if (tty === null) return openWindow({ request, env, signal });
  try {
    const code = await new Promise(resolve => {
      let child;
      try { child = spawnImpl(process.execPath, [CLI, 'check', '--id', request.id], { cwd, env: { ...env, SPHINX_WAITING_GIT: '1', ...(request.more ? { SPHINX_MORE_CHECKS: '1' } : {}) }, stdio: [tty, tty, tty] }); }
      catch { resolve(null); return; }
      const onAbort = () => child.kill('SIGINT');
      signal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', () => resolve(null));
      child.once('exit', exit => { signal?.removeEventListener('abort', onAbort); resolve(exit); });
    });
    return { id: request.id, status: code === 0 ? 'passed' : code === 3 ? 'skipped' : code === 4 ? 'stopped' : code === null ? 'unavailable' : 'pending' };
  } finally { try { closeSync(tty); } catch { /* Already closed. */ } }
}
