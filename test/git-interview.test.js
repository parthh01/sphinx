import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runGitCheckpointTerminal } from '../src/git-interview.js';

const id = 'd'.repeat(64);
const request = { id, token: randomUUID(), repoRoot: '/test/repo', delivery: 'hook', event: 'pre-push' };
const options = { request, env: { DISPLAY: ':7' }, platform: 'linux', timeoutMs: 1000 };

test('the Git hook waits for direct human terminal completion without changing queue or approving anything', async () => {
  let release, waiting, resolved = false;
  const begun = new Promise(resolve => { waiting = resolve; });
  const result = runGitCheckpointTerminal({ ...options, launch: async values => {
    assert.deepEqual(values.request, request); assert.equal(values.env, options.env); assert.ok(values.signal instanceof AbortSignal);
    return { status: 'opened', id };
  }, waitForResult: async values => {
    assert.equal(values.id, id); assert.ok(values.timeoutMs > 0 && values.timeoutMs <= 1000);
    waiting(); return new Promise(resolve => { release = resolve; });
  } }).then(value => { resolved = true; return value; });
  await begun; assert.equal(resolved, false);
  release('passed'); assert.deepEqual(await result, { status: 'passed', id });
});

test('a concurrent launch lock reuses its existing interview and terminal passed status is only forwarded to the gate', async () => {
  let calls = 0, waits = 0;
  const more = { ...request, more: true };
  const result = await runGitCheckpointTerminal({ ...options, request: more, launch: async () => ({ status: ++calls === 1 ? 'busy' : 'already-open' }), waitForResult: async () => { waits++; return 'passed'; } });
  assert.deepEqual(result, { status: 'passed', id }); assert.equal(calls, 2); assert.equal(waits, 1);
  // The last destination asks whether to continue; another window's pass never answered that, so its own window opens.
  calls = 0; waits = 0; const launched = [];
  const asked = await runGitCheckpointTerminal({ ...options, launch: async values => { launched.push(values.request); if (++calls > 4) throw new Error('relaunch loop'); return { status: calls === 1 ? 'already-open' : 'opened' }; }, waitForResult: async () => { waits++; return 'passed'; } });
  assert.deepEqual(asked, { status: 'passed', id }); assert.equal(calls, 2); assert.equal(waits, 2);
  assert.deepEqual(launched, [request, request]);
  const stoppedThere = await runGitCheckpointTerminal({ ...options, launch: async () => ({ status: 'already-open' }), waitForResult: async () => 'stopped' });
  assert.deepEqual(stoppedThere, { status: 'stopped', id }, 'a stop in that window still stops this push');
  const cached = await runGitCheckpointTerminal({ ...options, launch: async () => ({ status: 'passed' }), waitForResult: () => assert.fail('must not wait again') });
  assert.deepEqual(cached, { status: 'passed', id });
  const stopped = await runGitCheckpointTerminal({ ...options, launch: async () => ({ status: 'stopped' }), waitForResult: () => assert.fail('must not wait after stop') });
  assert.deepEqual(stopped, { status: 'stopped', id });
});

test('CI, SSH, missing Linux display, and evaluator contexts fail immediately without opening a terminal', async () => {
  for (const env of [{ CI: 'true', DISPLAY: ':1' }, { SSH_CONNECTION: 'remote', DISPLAY: ':1' }, { SSH_TTY: '/dev/pts/1', DISPLAY: ':1' }, {}, { SPHINX_EVALUATOR: '1', DISPLAY: ':1' }]) {
    const result = await runGitCheckpointTerminal({ ...options, env, launch: () => assert.fail('must not open terminal'), waitForResult: () => assert.fail('must not wait') });
    assert.deepEqual(result, { status: 'unavailable', id, reason: 'no-desktop' });
  }
});

test('launch failures, cancellation, missing statuses, and unfinished interviews never report passed', async () => {
  for (const status of ['unavailable', 'suppressed', 'skipped', undefined]) {
    const result = await runGitCheckpointTerminal({ ...options, launch: async () => ({ status }), waitForResult: () => assert.fail('must not wait') });
    assert.notEqual(result.status, 'passed');
  }
  const failed = await runGitCheckpointTerminal({ ...options, launch: async () => { throw new Error('PRIVATE ERROR'); } });
  assert.equal(failed.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE ERROR/);
  for (const status of ['pending', 'unavailable', 'interrupted', 'stopped', null, 'unknown']) {
    const result = await runGitCheckpointTerminal({ ...options, launch: async () => ({ status: 'opened' }), waitForResult: async () => status });
    assert.equal(result.status, ['pending', 'unavailable', 'interrupted', 'stopped'].includes(status) ? status : 'interrupted');
  }
});

test('one deadline bounds a launcher that never returns and does not kill any client', async () => {
  let launchSignal;
  const result = await runGitCheckpointTerminal({ ...options, timeoutMs: 5, launch: values => { launchSignal = values.signal; return new Promise(() => {}); }, waitForResult: () => assert.fail('must not wait') });
  assert.deepEqual(result, { status: 'pending', id, reason: 'timeout' });
  assert.equal(launchSignal.aborted, true);
});

test('the same deadline includes interview waiting even when a wait adapter ignores abort', async () => {
  let waitSignal;
  const result = await runGitCheckpointTerminal({ ...options, timeoutMs: 5, launch: async () => ({ status: 'opened' }), waitForResult: values => { waitSignal = values.signal; return new Promise(() => {}); } });
  assert.deepEqual(result, { status: 'pending', id, reason: 'timeout' }); assert.equal(waitSignal.aborted, true);
});

test('external cancellation bounds launch or wait, and a late launch completion cannot start more work', async () => {
  const before = new AbortController(); before.abort();
  assert.equal((await runGitCheckpointTerminal({ ...options, signal: before.signal, launch: () => assert.fail('already cancelled') })).reason, 'cancelled');
  const controller = new AbortController(); let release, waiting = false;
  const pending = runGitCheckpointTerminal({ ...options, signal: controller.signal, launch: () => new Promise(resolve => { release = resolve; }), waitForResult: () => { waiting = true; } });
  controller.abort(); assert.deepEqual(await pending, { status: 'pending', id, reason: 'cancelled' });
  release({ status: 'opened' }); await new Promise(resolve => setImmediate(resolve)); assert.equal(waiting, false);
});
