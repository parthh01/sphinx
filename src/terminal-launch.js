import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, chmod, lstat, mkdir, mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { getPaths, readJson, writeJson } from './config.js';

const WORKER = fileURLToPath(new URL('./terminal-worker.js', import.meta.url));
export const CLI = fileURLToPath(new URL('../bin/sphinx.js', import.meta.url));
const ID = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9-]{36}$/;
const STARTUP_MS = 30000;
const FORWARDED_ENV = ['PATH', 'HOME', 'SPHINX_USER_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
const GIT_CONTEXT = ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'];
const gitContext = env => Object.fromEntries(GIT_CONTEXT.filter(key => typeof env[key] === 'string' && path.isAbsolute(env[key]) && !env[key].includes('\0')).map(key => [key, env[key]]));
const withoutGitContext = env => Object.fromEntries(Object.entries(env).filter(([key]) => !GIT_CONTEXT.includes(key) && key !== 'GIT_CONFIG' && !key.startsWith('GIT_CONFIG_') && !['SPHINX_WAITING_GIT', 'SPHINX_MORE_CHECKS'].includes(key)));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const live = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const fileFor = (id, env) => {
  if (!ID.test(id)) throw new Error('Invalid checkpoint terminal ID.');
  return path.join(getPaths(env).home, 'terminals', `${id}.json`);
};

/** One-shot local IPC keeps provider credentials out of argv and launch files. */
export async function createTerminalEnvironmentBridge(env, token, { operationGitEnv } = {}) {
  const values = Object.fromEntries(FORWARDED_ENV.filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
  if (operationGitEnv) Object.assign(values, gitContext(operationGitEnv));
  const directory = await mkdtemp(path.join(tmpdir(), 'sphinx-term-'));
  try { await chmod(directory, 0o700); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const socketPath = path.join(directory, 'env.sock');
  let timer, closed = false;
  const clients = new Set();
  const server = createServer(socket => {
    clients.add(socket); let input = '';
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 512) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      let supplied; try { supplied = JSON.parse(input).token; } catch { socket.destroy(); return; }
      if (supplied !== token || closed) { socket.destroy(); return; }
      closed = true; clearTimeout(timer); server.close();
      socket.end(JSON.stringify(values));
      socket.once('close', () => { rm(directory, { recursive: true, force: true }).catch(() => {}); });
    });
  });
  const close = async () => {
    closed = true; clearTimeout(timer);
    for (const client of clients) client.destroy();
    await new Promise(resolve => { try { server.close(() => resolve()); } catch { resolve(); } });
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  }
  catch (error) { await close(); throw error; }
  server.unref();
  timer = setTimeout(() => { close().catch(() => {}); }, STARTUP_MS + 5000); timer.unref();
  return { socketPath, close };
}

export async function readTerminalEnvironment(socketPath, token) {
  if (!path.isAbsolute(socketPath) || !TOKEN.test(token)) throw new Error('Invalid terminal environment channel.');
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath); let input = '', ended = false;
    socket.setTimeout(5000, () => socket.destroy(new Error('Terminal environment channel timed out.')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ token })}\n`));
    socket.on('data', chunk => { input += chunk; if (Buffer.byteLength(input) > 512 * 1024) socket.destroy(new Error('Terminal environment channel exceeded its limit.')); });
    socket.once('error', reject);
    socket.once('close', () => { if (!ended) reject(new Error('Terminal environment channel closed.')); });
    socket.once('end', () => {
      ended = true;
      try {
        const values = JSON.parse(input);
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error();
        resolve({ ...Object.fromEntries(FORWARDED_ENV.filter(key => typeof values[key] === 'string').map(key => [key, values[key]])), ...gitContext(values) });
      } catch { reject(new Error('Invalid terminal environment response.')); }
    });
  });
}

async function executable(name, env) {
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const file = path.join(directory, name);
    try { await access(file, constants.X_OK); return file; } catch {}
  }
  return null;
}

/** Only fixed terminal programs and argument arrays. Paths never become code. */
export async function terminalCommand({ recordFile, token, home, platform = process.platform, env = process.env, findExecutable = executable, nodePath = process.execPath, workerPath = WORKER }) {
  if (!TOKEN.test(token) || !path.isAbsolute(recordFile) || !path.isAbsolute(home)) throw new Error('Invalid checkpoint terminal launch.');
  if (env.SSH_CONNECTION || env.SSH_TTY || (env.CI && env.CI !== 'false' && env.CI !== '0')) return null;
  const argv = [nodePath, workerPath, recordFile, token];
  if (platform === 'darwin') {
    const shellCommand = ['/usr/bin/env', `SPHINX_HOME=${home}`, ...argv].map(quote).join(' ');
    // The AppleScript program is constant; its sole argument is already quoted
    // for the user's shell. No repository path is interpolated into AppleScript.
    const script = 'on run argv\n  tell application "Terminal"\n    do script (item 1 of argv)\n  end tell\nend run';
    return { command: '/usr/bin/osascript', args: ['-e', script, '--', shellCommand], waitForExit: true, shellCommand };
  }
  if (platform !== 'linux' || (!env.DISPLAY && !env.WAYLAND_DISPLAY)) return null;
  for (const [name, prefix] of [['gnome-terminal', ['--']], ['konsole', ['--separate', '-e']], ['xfce4-terminal', ['--disable-server', '-x']], ['kitty', []], ['alacritty', ['-e']], ['xterm', ['-e']], ['x-terminal-emulator', ['-e']]]) {
    const command = await findExecutable(name, env);
    if (command) return { command, args: [...prefix, ...argv], waitForExit: false };
  }
  return null;
}

export async function spawnTerminal(command, { env = process.env, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    let child, finished = false, timer;
    const finish = started => { if (finished) return; finished = true; clearTimeout(timer); if (started) child?.unref(); resolve(started); };
    try { child = spawnImpl(command.command, command.args, { env, detached: !command.waitForExit, stdio: 'ignore' }); }
    catch { finish(false); return; }
    child.once('error', () => finish(false));
    child.once('exit', code => finish(code === 0));
    child.once('spawn', () => {
      timer = setTimeout(() => {
        if (command.waitForExit) { child.kill(); finish(false); }
        else finish(true);
      }, command.waitForExit ? 15000 : 300);
    });
  });
}

async function lock(file, operation) {
  const lockFile = `${file}.lock`;
  const directory = path.dirname(file);
  const directoryInfo = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (directoryInfo?.isSymbolicLink()) throw new Error('Refusing a symlinked checkpoint terminal directory.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readJson(lockFile, {}).catch(() => ({}));
    const recent = await lstat(lockFile).then(info => Date.now() - info.mtimeMs < STARTUP_MS).catch(() => false);
    if (live(previous.pid) || (!previous.pid && recent)) return { status: 'busy' };
    await unlink(lockFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return lock(file, operation);
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await operation(); }
  finally { await handle.close(); await unlink(lockFile).catch(() => {}); }
}

export async function checkpointTerminalStatus({ id, env = process.env, isAlive = live, now = Date.now() }) {
  const record = await readJson(fileFor(id, env), null);
  if (!record || record.id !== id || !TOKEN.test(record.token)) return null;
  let status = record.status;
  if (status === 'running' && !isAlive(record.pid) && !isAlive(record.childPid)) status = 'interrupted';
  if (status === 'starting' && now - record.createdAt > STARTUP_MS) status = 'interrupted';
  return { status, presentationToken: record.presentationToken, token: record.token, finishedAt: record.finishedAt, createdAt: record.createdAt };
}

/** Native dialogs and dedicated terminals reserve the same exact checkpoint. */
export async function claimCheckpointDialog({ request, env = process.env, pid = process.pid, isAlive = live, kind = 'native' } = {}) {
  if (!request || !ID.test(request.id) || !TOKEN.test(request.token) || !path.isAbsolute(request.repoRoot) || request.repoRoot.includes('\0') || !Number.isInteger(pid) || pid <= 0) throw new Error('Invalid native checkpoint reservation.');
  if (!['native', 'browser'].includes(kind)) throw new Error('Invalid checkpoint presentation kind.');
  if (env.SPHINX_EVALUATOR === '1') return { status: 'busy', id: request.id };
  const file = fileFor(request.id, env), home = getPaths(env).home;
  const result = await lock(file, async () => {
    const current = await checkpointTerminalStatus({ id: request.id, env, isAlive });
    if (['starting', 'running'].includes(current?.status)) return { status: 'busy', id: request.id };
    const token = randomUUID(), at = Date.now();
    await writeJson(file, { version: 1, id: request.id, token, presentationToken: request.token, repoRoot: request.repoRoot, home, kind, status: 'running', pid, createdAt: at, updatedAt: at });
    return { status: 'claimed', id: request.id, token };
  });
  return result.status === 'busy' ? { status: 'busy', id: request.id } : result;
}

/** Only the reservation owner can release a native dialog or report completion.
 * This status wakes waiters; the Git gate still requires its own valid receipt.
 */
export async function finishCheckpointDialog({ id, token, status, env = process.env } = {}) {
  if (!ID.test(id) || !TOKEN.test(token) || !['passed', 'pending'].includes(status)) throw new Error('Invalid native checkpoint completion.');
  const file = fileFor(id, env), deadline = Date.now() + 20000;
  let result;
  do {
    result = await lock(file, async () => {
      const current = await readJson(file, null);
      if (current?.version !== 1 || current.id !== id || current.token !== token || !['native', 'browser'].includes(current.kind) || current.status !== 'running') return { status: 'ignored', id };
      const at = Date.now();
      await writeJson(file, { ...current, status, updatedAt: at, finishedAt: at });
      return { status, id };
    });
    if (result.status === 'busy') await delay(50);
  } while (result.status === 'busy' && Date.now() < deadline);
  return result.status === 'busy' ? { status: 'busy', id } : result;
}

/** One window per exact assessment; only a new Git attempt retries a failed launch. */
export async function launchCheckpointTerminal({ request, env = process.env, platform = process.platform, cliPath = CLI, isAlive = live, launch = spawnTerminal, findExecutable = executable, environmentBridge = createTerminalEnvironmentBridge, signal } = {}) {
  signal?.throwIfAborted();
  if (env.SPHINX_EVALUATOR === '1') return { status: 'skipped' };
  if (!request || !ID.test(request.id) || !TOKEN.test(request.token) || !path.isAbsolute(request.repoRoot) || request.repoRoot.includes('\0') || !path.isAbsolute(cliPath)) throw new Error('Invalid queued checkpoint terminal request.');
  const file = fileFor(request.id, env), home = getPaths(env).home;
  return lock(file, async () => {
    signal?.throwIfAborted();
    const previous = await checkpointTerminalStatus({ id: request.id, env, isAlive });
    if (['starting', 'running'].includes(previous?.status)) return { status: 'already-open', id: request.id };
    // Another window's pass never answers whether this waiting push or commit continues
    // (it may not have asked, as an earlier destination's does not): its own window asks.
    const asks = request.delivery === 'hook' && !request.more;
    if ((previous?.status === 'stopped' || (previous?.status === 'passed' && !asks)) && request.createdAt <= previous.finishedAt) return { status: previous.status, id: request.id };
    if (previous?.presentationToken === request.token) return { status: 'suppressed', id: request.id };
    const record = { version: 1, id: request.id, token: randomUUID(), presentationToken: request.token, repoRoot: request.repoRoot, home, cliPath, kind: 'terminal', waitingGit: request.delivery === 'hook', ...(request.more ? { more: true } : {}), status: 'starting', createdAt: Date.now(), updatedAt: Date.now() };
    await writeJson(file, record);
    let bridge;
    let started = false;
    try {
      const command = await terminalCommand({ recordFile: file, token: record.token, home, platform, env, findExecutable });
      if (command && environmentBridge) { bridge = await environmentBridge(env, record.token, { ...(record.waitingGit ? { operationGitEnv: gitContext(env) } : {}) }); record.envSocket = bridge.socketPath; }
      await writeJson(file, record);
      signal?.throwIfAborted();
      if (command) started = await launch(command, { env: withoutGitContext(env) });
    } catch { /* Static status only; launcher errors can contain environment data. */ }
    // The worker may already have started while the terminal launcher exits.
    const current = await readJson(file, null);
    if (current?.token === record.token && current.status === 'starting' && !started) await writeJson(file, { ...record, status: 'unavailable', updatedAt: Date.now(), finishedAt: Date.now() });
    if (!started) await bridge?.close();
    return { status: started || current?.status === 'running' || current?.status === 'passed' ? 'opened' : 'unavailable', id: request.id };
  });
}

export async function waitForCheckpointTerminal({ id, env = process.env, timeoutMs = 25 * 60 * 1000, pollMs = 250, signal, readStatus = checkpointTerminalStatus, wait = delay } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const current = await readStatus({ id, env });
    if (!current || !['starting', 'running'].includes(current.status)) return current?.status || 'interrupted';
    await wait(Math.min(pollMs, deadline - Date.now()), undefined, { signal });
  }
  return 'pending';
}

/** Called only inside a terminal. The real CLI owns all answers and receipts. */
// A window opened just for this check closes when the check exits. Before an
// unfinished one closes, wait so its last message can be read.
async function pressEnter(output = process.stdout) {
  output.write('\nThe check did not finish; your progress is saved. Press Enter to close this window.');
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin });
  await new Promise(resolve => { rl.once('line', resolve); rl.once('close', resolve); });
  rl.close();
}

export async function runCheckpointTerminal({ recordFile, token, env = process.env, isTTY = !!process.stdin.isTTY, spawnImpl = spawn, pid = process.pid, pause = process.stdin.isTTY ? pressEnter : async () => {} } = {}) {
  const home = getPaths(env).home;
  const id = path.basename(recordFile || '', '.json');
  if (!ID.test(id) || !TOKEN.test(token) || path.resolve(recordFile) !== fileFor(id, env)) throw new Error('Invalid checkpoint terminal worker.');
  const record = await readJson(recordFile, null);
  if (!record || record.version !== 1 || record.kind === 'native' || record.token !== token || record.id !== id || record.home !== home || typeof record.repoRoot !== 'string' || !path.isAbsolute(record.repoRoot) || typeof record.cliPath !== 'string' || !path.isAbsolute(record.cliPath) || record.status !== 'starting') return { status: 'ignored', code: 1 };
  const running = { ...record, status: 'running', pid, updatedAt: Date.now() };
  let claimed;
  const claimDeadline = Date.now() + 20000;
  do {
    claimed = await lock(recordFile, async () => {
      const current = await readJson(recordFile, null);
      if (current?.token !== token || current.status !== 'starting') return { status: 'ignored' };
      await writeJson(recordFile, running);
      return { status: 'claimed' };
    });
    if (claimed.status === 'busy') await delay(50);
  } while (claimed.status === 'busy' && Date.now() < claimDeadline);
  if (claimed.status !== 'claimed') return { status: 'ignored', code: 1 };
  if (!isTTY) {
    await writeJson(recordFile, { ...running, status: 'unavailable', updatedAt: Date.now(), finishedAt: Date.now() });
    return { status: 'unavailable', code: 1 };
  }
  let providerEnv;
  try { providerEnv = record.envSocket ? await readTerminalEnvironment(record.envSocket, token) : {}; }
  catch {
    await writeJson(recordFile, { ...running, status: 'unavailable', updatedAt: Date.now(), finishedAt: Date.now() });
    return { status: 'unavailable', code: 1 };
  }
  let childWrite = Promise.resolve();
  const code = await new Promise(resolve => {
    let child;
    try { child = spawnImpl(process.execPath, [record.cliPath, 'check', '--id', id], { cwd: record.repoRoot, env: { ...withoutGitContext(env), ...providerEnv, SPHINX_HOME: home, ...(record.waitingGit ? { SPHINX_WAITING_GIT: '1', ...(record.more ? { SPHINX_MORE_CHECKS: '1' } : {}) } : {}) }, stdio: 'inherit' }); }
    catch { resolve(1); return; }
    child.once('error', () => resolve(1));
    child.once('exit', code => resolve(code ?? 1));
    // The worker remains alive through the interview. It stores the child PID
    // as well, so a surviving foreground interview still prevents a duplicate.
    if (Number.isInteger(child.pid)) { running.childPid = child.pid; childWrite = writeJson(recordFile, running).catch(() => {}); }
  });
  await childWrite;
  const result = { ...running, status: code === 0 ? 'passed' : code === 3 ? 'skipped' : code === 4 ? 'stopped' : 'pending', updatedAt: Date.now(), finishedAt: Date.now() };
  if ((await readJson(recordFile, null))?.token === token) await writeJson(recordFile, result);
  // Recorded first, so a waiting Git operation is not held by this prompt.
  if (result.status === 'pending' && isTTY) await pause();
  return { status: result.status, code };
}
