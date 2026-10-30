import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { terminalCommand, launchCheckpointTerminal, checkpointTerminalStatus, waitForCheckpointTerminal, runCheckpointTerminal, createTerminalEnvironmentBridge, readTerminalEnvironment, claimCheckpointDialog, finishCheckpointDialog } from '../src/terminal-launch.js';
import { terminalHandoff } from '../src/lifecycle-integrations.js';

const ID = 'a'.repeat(64);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "sphinx terminal ' "));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'state'), repoRoot = path.join(base, 'repo'); await mkdir(repoRoot);
  const env = { HOME: base, SPHINX_USER_HOME: base, SPHINX_HOME: home, DISPLAY: ':9', PATH: '/does-not-exist' };
  const request = { id: ID, token: randomUUID(), repoRoot, createdAt: Date.now() };
  const recordFile = path.join(home, 'terminals', `${ID}.json`);
  const options = { request, env, platform: 'linux', environmentBridge: null, findExecutable: async name => name === 'xterm' ? '/test/xterm' : null };
  return { base, home, repoRoot, env, request, recordFile, options };
}

test('macOS launch uses a constant AppleScript and shell-quotes all paths without executing substitutions', async t => {
  const f = await fixture(t), token = randomUUID();
  const worker = path.join(f.base, "worker $literal ' quoted.mjs");
  await writeFile(worker, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),home:process.env.SPHINX_HOME}));');
  const recordFile = path.join(f.base, "$(printf INJECTED) `printf INJECTED` ' \" record.json");
  const home = path.join(f.base, "home $(printf INJECTED) ' \"");
  const command = await terminalCommand({ recordFile, token, home, platform: 'darwin', env: {}, workerPath: worker });
  assert.equal(command.command, '/usr/bin/osascript');
  assert.doesNotMatch(command.args[1], /INJECTED|record\.json|worker/);
  assert.match(command.args[1], /do script \(item 1 of argv\)/);
  assert.doesNotMatch(command.args[1], /activate|frontmost|minimiz/i);
  // Execute only the generated shell command against a harmless fixture, never
  // the AppleScript or any desktop terminal program.
  const actual = JSON.parse(execFileSync('/bin/sh', ['-c', command.shellCommand], { encoding: 'utf8', env: {} }));
  assert.deepEqual(actual, { args: [recordFile, token], home });
});

test('Linux terminal detection requires a desktop, uses argument arrays, and never invokes a shell', async () => {
  const common = { recordFile: `/state/${ID}.json`, token: randomUUID(), home: '/state', platform: 'linux' };
  const findExecutable = async name => name === 'konsole' ? '/usr/bin/konsole' : null;
  const result = await terminalCommand({ ...common, env: { WAYLAND_DISPLAY: 'wayland-1' }, findExecutable });
  assert.equal(result.command, '/usr/bin/konsole');
  assert.deepEqual(result.args.slice(0, 2), ['--separate', '-e']);
  assert.equal(result.args.at(-2), common.recordFile);
  assert.equal(result.args.at(-1), common.token);
  assert.equal(await terminalCommand({ ...common, env: {}, findExecutable }), null);
  assert.equal(await terminalCommand({ ...common, env: { DISPLAY: ':1', SSH_CONNECTION: 'remote' }, findExecutable }), null);
  assert.equal(await terminalCommand({ ...common, env: { DISPLAY: ':1', CI: 'true' }, findExecutable }), null);
});

test('concurrent Git requests launch one terminal and do not put credentials in arguments or state', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { ...f.options, env: { ...f.env, OPENROUTER_API_KEY: 'PRIVATE-KEY' }, launch: async command => { calls++; assert.doesNotMatch(JSON.stringify(command), /PRIVATE-KEY/); await new Promise(resolve => setTimeout(resolve, 10)); return true; } };
  const results = await Promise.all([launchCheckpointTerminal(options), launchCheckpointTerminal(options)]);
  assert.equal(calls, 1);
  assert.ok(results.some(result => result.status === 'opened'));
  assert.ok(results.some(result => ['busy', 'already-open'].includes(result.status)));
  assert.doesNotMatch(await readFile(f.recordFile, 'utf8'), /PRIVATE-KEY|OPENROUTER/);
  assert.equal((await launchCheckpointTerminal(options)).status, 'already-open');
  assert.equal(calls, 1);
});

test('failed or headless launches are retained once and only a new Git attempt retries', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { ...f.options, launch: async () => { calls++; throw new Error('PRIVATE ERROR'); } };
  assert.equal((await launchCheckpointTerminal(options)).status, 'unavailable');
  assert.equal((await launchCheckpointTerminal(options)).status, 'suppressed');
  assert.equal(calls, 1);
  assert.doesNotMatch(await readFile(f.recordFile, 'utf8'), /PRIVATE ERROR/);
  assert.equal((await launchCheckpointTerminal({ ...options, request: { ...f.request, token: randomUUID() }, launch: async () => { calls++; return true; } })).status, 'opened');
  assert.equal(calls, 2);
  const other = { ...f.request, id: 'b'.repeat(64), token: randomUUID() };
  assert.equal((await launchCheckpointTerminal({ ...f.options, request: other, env: { ...f.env, DISPLAY: '' }, launch: () => { throw new Error('must not launch'); } })).status, 'unavailable');
});

test('live workers and their surviving CLI children deduplicate; interrupted workers require a fresh attempt', async t => {
  const f = await fixture(t);
  await launchCheckpointTerminal({ ...f.options, launch: async () => true });
  const record = await json(f.recordFile);
  await writeFile(f.recordFile, JSON.stringify({ ...record, status: 'running', pid: 100, childPid: 101 }));
  assert.equal((await checkpointTerminalStatus({ id: ID, env: f.env, isAlive: pid => pid === 101 })).status, 'running');
  assert.equal((await launchCheckpointTerminal({ ...f.options, isAlive: pid => pid === 101, launch: () => { throw new Error('duplicate'); } })).status, 'already-open');
  assert.equal((await checkpointTerminalStatus({ id: ID, env: f.env, isAlive: () => false })).status, 'interrupted');
  assert.equal((await launchCheckpointTerminal({ ...f.options, isAlive: () => false, launch: () => { throw new Error('same attempt'); } })).status, 'suppressed');
  assert.equal((await launchCheckpointTerminal({ ...f.options, request: { ...f.request, token: randomUUID() }, isAlive: () => false, launch: async () => true })).status, 'opened');
});

test('worker runs exact check ID/cwd in an inherited TTY and records only completion status', async t => {
  const f = await fixture(t);
  await launchCheckpointTerminal({ ...f.options, launch: async () => true });
  const record = await json(f.recordFile); let captured;
  const result = await runCheckpointTerminal({ recordFile: f.recordFile, token: record.token, env: f.env, isTTY: true, spawnImpl: (command, args, options) => {
    captured = { command, args, options };
    const child = new EventEmitter(); child.pid = 1234567;
    setImmediate(() => child.emit('exit', 0));
    return child;
  } });
  assert.deepEqual(result, { status: 'passed', code: 0 });
  assert.equal(captured.command, process.execPath);
  assert.deepEqual(captured.args, [record.cliPath, 'check', '--id', ID]);
  assert.equal(captured.options.cwd, f.repoRoot);
  assert.equal(captured.options.stdio, 'inherit');
  assert.equal(captured.options.env.SPHINX_HOME, f.home);
  assert.equal((await json(f.recordFile)).status, 'passed');
  assert.equal((await launchCheckpointTerminal({ ...f.options, launch: () => { throw new Error('passed receipt'); } })).status, 'passed');
  assert.equal((await runCheckpointTerminal({ recordFile: f.recordFile, token: record.token, env: f.env, isTTY: true })).status, 'ignored');
});

test('a window that passed for another Git attempt answers an earlier destination or a fallback, but a waiting push opens its own window to ask', async t => {
  const f = await fixture(t);
  await launchCheckpointTerminal({ ...f.options, request: { ...f.request, delivery: 'hook', more: true }, launch: async () => true });
  // That earlier destination's window passed, and never asked whether to continue, after these requests were queued.
  await writeFile(f.recordFile, JSON.stringify({ ...await json(f.recordFile), status: 'passed', finishedAt: Date.now() + 1000 }));
  const queued = { ...f.request, token: randomUUID(), delivery: 'hook' };
  assert.equal((await launchCheckpointTerminal({ ...f.options, request: { ...queued, more: true }, launch: () => { throw new Error('must not launch'); } })).status, 'passed');
  assert.equal((await launchCheckpointTerminal({ ...f.options, request: { ...f.request, token: randomUUID() }, launch: () => { throw new Error('must not launch'); } })).status, 'passed', 'a fallback check has nothing waiting to continue');
  let launches = 0;
  assert.equal((await launchCheckpointTerminal({ ...f.options, request: queued, launch: async () => { launches++; return true; } })).status, 'opened');
  const own = await json(f.recordFile);
  assert.equal(launches, 1); assert.equal(own.presentationToken, queued.token); assert.equal(own.waitingGit, true); assert.equal(own.more, undefined);
  // A stop typed in another window still stops a waiting push.
  await writeFile(f.recordFile, JSON.stringify({ ...own, status: 'stopped', finishedAt: Date.now() + 1000 }));
  assert.equal((await launchCheckpointTerminal({ ...f.options, request: { ...queued, token: randomUUID() }, launch: () => { throw new Error('must not launch'); } })).status, 'stopped');
});

test('worker records a stopped check when the interview exits 4', async t => {
  const f = await fixture(t);
  await launchCheckpointTerminal({ ...f.options, launch: async () => true });
  const record = await json(f.recordFile);
  const result = await runCheckpointTerminal({ recordFile: f.recordFile, token: record.token, env: f.env, isTTY: true, spawnImpl: (_command, _args, _options) => {
    const child = new EventEmitter(); child.pid = 7654321;
    setImmediate(() => child.emit('exit', 4));
    return child;
  } });
  assert.deepEqual(result, { status: 'stopped', code: 4 });
  assert.equal((await json(f.recordFile)).status, 'stopped');
  assert.equal((await launchCheckpointTerminal({ ...f.options, launch: () => { throw new Error('stopped receipt'); } })).status, 'stopped');
});

test('worker refuses piped input and mismatched tokens, preserving an incomplete checkpoint', async t => {
  const f = await fixture(t);
  await launchCheckpointTerminal({ ...f.options, launch: async () => true });
  const record = await json(f.recordFile);
  assert.equal((await runCheckpointTerminal({ recordFile: f.recordFile, token: randomUUID(), env: f.env, isTTY: true })).status, 'ignored');
  assert.equal((await runCheckpointTerminal({ recordFile: f.recordFile, token: record.token, env: f.env, isTTY: false, spawnImpl: () => { throw new Error('must not run'); } })).status, 'unavailable');
  assert.equal((await json(f.recordFile)).status, 'unavailable');
});

test('terminal waiting reports completion without polling the coding model and stops on stale startup', async t => {
  const f = await fixture(t);
  await launchCheckpointTerminal({ ...f.options, launch: async () => true });
  const record = await json(f.recordFile);
  assert.equal((await checkpointTerminalStatus({ id: ID, env: f.env, now: record.createdAt + 31000 })).status, 'interrupted');
  let polls = 0;
  assert.equal(await waitForCheckpointTerminal({ id: ID, env: f.env, readStatus: async () => ({ status: ++polls === 3 ? 'passed' : 'running' }), wait: async () => {} }), 'passed');
  assert.equal(polls, 3);
  assert.equal(await waitForCheckpointTerminal({ id: ID, env: f.env, timeoutMs: 0 }), 'pending');
});

test('lifecycle claims successful launches, retains failures, and returns outcome only', async () => {
  const requests = [{ id: ID, token: randomUUID(), repoRoot: '/repo' }, { id: 'b'.repeat(64), token: randomUUID(), repoRoot: '/repo' }], claimed = [];
  const result = await terminalHandoff({ cwd: '/repo', env: {}, listRequests: async () => requests, launch: async ({ request }) => ({ status: request.id === ID ? 'opened' : 'unavailable' }), claimRequest: async request => { claimed.push(request.id); return true; }, waitForResult: async () => 'passed' });
  assert.deepEqual(claimed, [ID]);
  assert.match(result, /could not open a desktop terminal/);
  assert.doesNotMatch(result, /aaaaaa|bbbbb/);
});

test('terminal state rejects symlinked directories before attempting desktop launch', async t => {
  const f = await fixture(t), outside = path.join(f.base, 'outside');
  await mkdir(f.home); await mkdir(outside); await symlink(outside, path.join(f.home, 'terminals'));
  await assert.rejects(launchCheckpointTerminal({ ...f.options, launch: () => { throw new Error('must not launch'); } }), /symlinked/);
});

test('one-shot environment channel authenticates, forwards only provider settings, and leaves no credential file', async t => {
  const token = randomUUID();
  const bridge = await createTerminalEnvironmentBridge({ OPENROUTER_API_KEY: 'PRIVATE-ONLY-IN-MEMORY', CODEX_HOME: '/custom/codex', PATH: '/custom/bin', CODEX_THREAD_ID: 'DO-NOT-INHERIT', UNRELATED_SECRET: 'DO-NOT-INHERIT' }, token);
  t.after(() => bridge.close());
  assert.equal((await stat(path.dirname(bridge.socketPath))).mode & 0o777, 0o700);
  assert.equal((await stat(bridge.socketPath)).mode & 0o777, 0o600);
  await assert.rejects(readTerminalEnvironment(bridge.socketPath, randomUUID()), /Invalid|closed/);
  const values = await readTerminalEnvironment(bridge.socketPath, token);
  assert.deepEqual(values, { OPENROUTER_API_KEY: 'PRIVATE-ONLY-IN-MEMORY', CODEX_HOME: '/custom/codex', PATH: '/custom/bin' });
  await assert.rejects(readTerminalEnvironment(bridge.socketPath, token));
  await bridge.close();
  await assert.rejects(stat(path.dirname(bridge.socketPath)), { code: 'ENOENT' });
});

test('worker receives env-only provider keys through IPC without persisting them in launch state', async t => {
  const f = await fixture(t); let bridge, captured;
  const environmentBridge = async (...args) => { bridge = await createTerminalEnvironmentBridge(...args); return bridge; };
  await launchCheckpointTerminal({ ...f.options, env: { ...f.env, OPENROUTER_API_KEY: 'PRIVATE-KEY' }, environmentBridge, launch: async () => true });
  t.after(() => bridge.close());
  const record = await json(f.recordFile);
  assert.doesNotMatch(await readFile(f.recordFile, 'utf8'), /PRIVATE-KEY|OPENROUTER_API_KEY/);
  await runCheckpointTerminal({ recordFile: f.recordFile, token: record.token, env: f.env, isTTY: true, spawnImpl: (_command, _args, options) => {
    captured = options.env;
    const child = new EventEmitter(); setImmediate(() => child.emit('exit', 1)); return child;
  } });
  assert.equal(captured.OPENROUTER_API_KEY, 'PRIVATE-KEY');
  assert.doesNotMatch(await readFile(f.recordFile, 'utf8'), /PRIVATE-KEY|OPENROUTER_API_KEY/);
  assert.equal((await json(f.recordFile)).status, 'pending');
});

test('hook delivery privately preserves only normalized Git operation context and marks a waiting original Git invocation', async t => {
  const f = await fixture(t); let captured, bridge, launcherEnv;
  const operation = { GIT_INDEX_FILE: path.join(f.repoRoot, '.git', 'next-index.lock'), GIT_DIR: path.join(f.repoRoot, '.git'), GIT_WORK_TREE: f.repoRoot, GIT_COMMON_DIR: path.join(f.repoRoot, '.git') };
  const env = { ...f.env, ...operation, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'PRIVATE-GIT-HEADER' };
  await launchCheckpointTerminal({ ...f.options, env, request: { ...f.request, delivery: 'hook', event: 'pre-commit' }, environmentBridge: async (...args) => { bridge = await createTerminalEnvironmentBridge(...args); return bridge; }, launch: async (_command, values) => { launcherEnv = values.env; return true; } });
  t.after(() => bridge.close());
  const record = await json(f.recordFile);
  assert.equal(record.waitingGit, true);
  assert.doesNotMatch(await readFile(f.recordFile, 'utf8'), /next-index|GIT_|PRIVATE-GIT-HEADER/);
  for (const key of [...Object.keys(operation), 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) assert.equal(launcherEnv[key], undefined);
  await runCheckpointTerminal({ recordFile: f.recordFile, token: record.token, env: { ...f.env, GIT_INDEX_FILE: '/wrong/index', GIT_DIR: '/wrong/repo', GIT_WORK_TREE: '/wrong/tree', GIT_COMMON_DIR: '/wrong/common', GIT_CONFIG_VALUE_0: 'PRIVATE-AMBIENT' }, isTTY: true, spawnImpl: (_command, args, values) => {
    captured = values.env; assert.deepEqual(args.slice(-3), ['check', '--id', ID]);
    const child = new EventEmitter(); setImmediate(() => child.emit('exit', 0)); return child;
  } });
  for (const [key, value] of Object.entries(operation)) assert.equal(captured[key], value);
  assert.equal(captured.SPHINX_WAITING_GIT, '1'); assert.equal(captured.GIT_CONFIG_VALUE_0, undefined); assert.equal(captured.SPHINX_MORE_CHECKS, undefined);
});

test('an earlier destination of a waiting push tells its terminal check not to ask to continue yet', async t => {
  const f = await fixture(t); let captured, bridge;
  await launchCheckpointTerminal({ ...f.options, request: { ...f.request, delivery: 'hook', more: true }, environmentBridge: async (...args) => { bridge = await createTerminalEnvironmentBridge(...args); return bridge; }, launch: async () => true });
  t.after(() => bridge.close());
  const record = await json(f.recordFile);
  assert.equal(record.more, true);
  await runCheckpointTerminal({ recordFile: f.recordFile, token: record.token, env: f.env, isTTY: true, spawnImpl: (_command, _args, values) => {
    captured = values.env; const child = new EventEmitter(); setImmediate(() => child.emit('exit', 0)); return child;
  } });
  assert.equal(captured.SPHINX_WAITING_GIT, '1'); assert.equal(captured.SPHINX_MORE_CHECKS, '1');
});

test('normal after-tool delivery clears ambient Git context and cannot forward hook-only state', async t => {
  const f = await fixture(t); let bridge, captured;
  await launchCheckpointTerminal({ ...f.options, env: { ...f.env, GIT_INDEX_FILE: '/outside/index', GIT_DIR: '/outside/git', SPHINX_WAITING_GIT: '1' }, environmentBridge: async (...args) => { bridge = await createTerminalEnvironmentBridge(...args); return bridge; }, launch: async () => true });
  t.after(() => bridge.close()); const record = await json(f.recordFile); assert.equal(record.waitingGit, false);
  await runCheckpointTerminal({ recordFile: f.recordFile, token: record.token, env: { ...f.env, GIT_DIR: '/ambient/git', SPHINX_WAITING_GIT: '1', SPHINX_MORE_CHECKS: '1' }, isTTY: true, spawnImpl: (_command, _args, values) => {
    captured = values.env; const child = new EventEmitter(); setImmediate(() => child.emit('exit', 1)); return child;
  } });
  assert.equal(captured.GIT_INDEX_FILE, undefined); assert.equal(captured.GIT_DIR, undefined); assert.equal(captured.SPHINX_WAITING_GIT, undefined); assert.equal(captured.SPHINX_MORE_CHECKS, undefined);
});

test('an aborted hook launch never opens a GUI or persists a new terminal record', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(launchCheckpointTerminal({ ...f.options, signal: controller.signal, launch: () => assert.fail('must not launch') }), /abort/i);
  await assert.rejects(readFile(f.recordFile), { code: 'ENOENT' });
});

test('a native dialog reserves the checkpoint before a direct Git terminal can open', async t => {
  const f = await fixture(t);
  const claim = await claimCheckpointDialog({ request: f.request, env: f.env });
  assert.equal(claim.status, 'claimed');assert.equal(claim.id, ID);
  const record = await json(f.recordFile);
  assert.equal(record.kind, 'native');assert.equal(record.status, 'running');assert.equal(record.pid, process.pid);
  assert.equal(record.cliPath, undefined);assert.equal(record.envSocket, undefined);
  const launched = await launchCheckpointTerminal({ ...f.options, launch: () => assert.fail('native form already owns this checkpoint') });
  assert.equal(launched.status, 'already-open');
  assert.equal((await claimCheckpointDialog({ request: { ...f.request, token: randomUUID() }, env: f.env })).status, 'busy');
  assert.equal((await runCheckpointTerminal({ recordFile: f.recordFile, token: claim.token, env: f.env, isTTY: true, spawnImpl: () => assert.fail('native record is not a CLI job') })).status, 'ignored');
  assert.deepEqual(await finishCheckpointDialog({ id: ID, token: claim.token, status: 'passed', env: f.env }), { status: 'passed', id: ID });
  assert.equal(await waitForCheckpointTerminal({ id: ID, env: f.env, timeoutMs: 20 }), 'passed');
});

test('a terminal launch reservation prevents a racing native dialog in both locked and starting states', async t => {
  const f = await fixture(t); let release, entered;
  const begun = new Promise(resolve => { entered = resolve; });
  const launching = launchCheckpointTerminal({ ...f.options, launch: async () => { entered(); await new Promise(resolve => { release = resolve; }); return true; } });
  await begun;
  assert.deepEqual(await claimCheckpointDialog({ request: f.request, env: f.env }), { status: 'busy', id: ID });
  release();await launching;
  assert.equal((await claimCheckpointDialog({ request: f.request, env: f.env })).status, 'busy');
  const record = await json(f.recordFile);assert.equal(record.kind, 'terminal');
  assert.equal((await finishCheckpointDialog({ id: ID, token: record.token, status: 'passed', env: f.env })).status, 'ignored');
  assert.equal((await json(f.recordFile)).status, 'starting');
});

test('native pause releases ownership; stale or wrong tokens cannot finish another interview', async t => {
  const f = await fixture(t);
  const first = await claimCheckpointDialog({ request: f.request, env: f.env });
  assert.equal((await finishCheckpointDialog({ id: ID, token: randomUUID(), status: 'passed', env: f.env })).status, 'ignored');
  assert.equal((await json(f.recordFile)).status, 'running');
  assert.equal((await finishCheckpointDialog({ id: ID, token: first.token, status: 'pending', env: f.env })).status, 'pending');
  assert.equal(await waitForCheckpointTerminal({ id: ID, env: f.env, timeoutMs: 20 }), 'pending');
  const second = await claimCheckpointDialog({ request: { ...f.request, token: randomUUID() }, env: f.env });
  assert.equal(second.status, 'claimed');assert.notEqual(second.token, first.token);
  assert.equal((await finishCheckpointDialog({ id: ID, token: first.token, status: 'passed', env: f.env })).status, 'ignored');
  assert.equal((await json(f.recordFile)).token, second.token);
  await finishCheckpointDialog({ id: ID, token: second.token, status: 'passed', env: f.env });
  assert.equal((await finishCheckpointDialog({ id: ID, token: second.token, status: 'pending', env: f.env })).status, 'ignored');
  assert.equal((await json(f.recordFile)).status, 'passed');
});

test('dead native owners can be replaced by another dialog or a terminal without trusting stale completion', async t => {
  const f = await fixture(t);
  const first = await claimCheckpointDialog({ request: f.request, env: f.env, pid: 12345 });
  const second = await claimCheckpointDialog({ request: { ...f.request, token: randomUUID() }, env: f.env, isAlive: () => false, pid: 23456 });
  assert.equal(second.status, 'claimed');assert.notEqual(second.token, first.token);
  let launches = 0;
  const terminal = await launchCheckpointTerminal({ ...f.options, request: { ...f.request, token: randomUUID() }, isAlive: () => false, launch: async () => { launches++;return true; } });
  assert.equal(terminal.status, 'opened');assert.equal(launches, 1);
  assert.equal((await finishCheckpointDialog({ id: ID, token: second.token, status: 'passed', env: f.env })).status, 'ignored');
  assert.equal((await json(f.recordFile)).kind, 'terminal');
});

test('simultaneous native claims choose one owner and finishing waits for a short conflicting lock', async t => {
  const f = await fixture(t);
  const claims = await Promise.all([claimCheckpointDialog({ request: f.request, env: f.env }), claimCheckpointDialog({ request: f.request, env: f.env })]);
  assert.equal(claims.filter(value => value.status === 'claimed').length, 1);assert.equal(claims.filter(value => value.status === 'busy').length, 1);
  const owner = claims.find(value => value.status === 'claimed');
  await writeFile(`${f.recordFile}.lock`, JSON.stringify({ pid: process.pid }));
  const finish = finishCheckpointDialog({ id: ID, token: owner.token, status: 'pending', env: f.env });
  await new Promise(resolve => setTimeout(resolve, 10));await rm(`${f.recordFile}.lock`);
  assert.equal((await finish).status, 'pending');assert.equal((await json(f.recordFile)).status, 'pending');
});

test('simultaneous duplicate terminal workers claim one interview atomically', async t => {
  const f = await fixture(t); let interviews = 0;
  await launchCheckpointTerminal({ ...f.options, launch: async () => true });
  const record = await json(f.recordFile);
  const options = { recordFile: f.recordFile, token: record.token, env: f.env, isTTY: true, spawnImpl: () => {
    interviews++;
    const child = new EventEmitter(); setTimeout(() => child.emit('exit', 0), 20); return child;
  } };
  const results = await Promise.all([runCheckpointTerminal(options), runCheckpointTerminal(options)]);
  assert.equal(interviews, 1);
  assert.deepEqual(results.map(result => result.status).sort(), ['ignored', 'passed']);
});

test('environment bridge failures remain recorded and do not repeat on unrelated hooks', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { ...f.options, launch: () => { throw new Error('must not launch'); }, environmentBridge: async () => { calls++; throw new Error('PRIVATE FAILURE'); } };
  assert.equal((await launchCheckpointTerminal(options)).status, 'unavailable');
  assert.equal((await launchCheckpointTerminal(options)).status, 'suppressed');
  assert.equal(calls, 1); assert.doesNotMatch(await readFile(f.recordFile, 'utf8'), /PRIVATE/);
});

test('an unfinished check keeps its window open until Enter, after recording the result', async t => {
  for (const [code, status, paused] of [[1, 'pending', true], [0, 'passed', false], [3, 'skipped', false]]) {
    const f = await fixture(t);
    await launchCheckpointTerminal({ ...f.options, launch: async () => true });
    const record = await json(f.recordFile); let recordedFirst;
    const result = await runCheckpointTerminal({ recordFile: f.recordFile, token: record.token, env: f.env, isTTY: true,
      pause: async () => { recordedFirst = (await json(f.recordFile)).status; },
      spawnImpl: () => { const child = new EventEmitter(); child.pid = 1234567; setImmediate(() => child.emit('exit', code)); return child; } });
    assert.equal(result.status, status);
    assert.equal(recordedFirst !== undefined, paused, `${status} ${paused ? 'waits' : 'closes'}`);
    if (paused) assert.equal(recordedFirst, 'pending', 'Git sees the result before the prompt');
  }
});
