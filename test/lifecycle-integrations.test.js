import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserHandoff, cursorAgentHook, cursorCheckpointIds, terminalHandoff, registerOpenCodeIntegration, TERMINAL_GUIDANCE } from '../src/lifecycle-integrations.js';

test('Cursor SessionStart uses documented context/env fields and never installs a model questionnaire', async () => {
  const output = await cursorAgentHook({ input: { hook_event_name: 'sessionStart', session_id: 'conversation-123' }, env: {} });
  assert.equal(output.additional_context, TERMINAL_GUIDANCE);
  assert.deepEqual(output.env, { SPHINX_CURSOR_SESSION: 'conversation-123' });
  assert.match(output.additional_context, /own terminal/);
  assert.match(output.additional_context, /browser/);
  assert.match(output.additional_context, /Never run the interview/);
  assert.match(output.additional_context, /keeps the original Git operation waiting/);
  assert.match(output.additional_context, /they confirm whether that same operation should continue/);
  assert.match(output.additional_context, /handles fallback requests only/);
  assert.match(output.additional_context, /verify that the original Git operation has exited with a Sphinx blocking failure before retrying/);
  assert.match(output.additional_context, /If the human passes and then stops the push or commit, or Git stops waiting before they choose, do not retry it unless they ask\. Stopping is their decision; a retry reopens the questionnaire and interrupts them with the same choice\./);
  assert.match(output.additional_context, /waits up to 25 minutes, but the host may cancel the shell sooner/);
  assert.match(output.additional_context, /supported yielding or background execution; do not terminate or duplicate/);
  assert.deepEqual(await cursorAgentHook({ input: { hook_event_name: 'sessionStart' }, env: { SPHINX_EVALUATOR: '1' } }), {});
});

test('browser handoff reuses one page, returns status only, and always closes its listener', async () => {
  const requests = [{ token: 'one', id: 'a'.repeat(64), repoRoot: '/repo' }, { token: 'two', id: 'b'.repeat(64), repoRoot: '/repo' }];
  const presented = [], claimed = []; let created = 0, closed = 0;
  const options = { cwd: '/repo', host: 'opencode', env: {}, listRequests: async () => requests,
    claimRequest: async request => { claimed.push(request.id); return true; },
    createInterview: () => { created++; return { present: async ({ request }) => { presented.push(request.id); return { status: 'passed', feedback: 'PRIVATE HUMAN ANSWER' }; }, close: async () => { closed++; } }; },
  };
  const result = await browserHandoff(options);
  assert.equal(created, 1); assert.equal(closed, 1);
  assert.deepEqual(presented, requests.map(request => request.id)); assert.deepEqual(claimed, presented);
  assert.match(result, /2 Sphinx checkpoint\(s\) completed directly in the human’s browser/);
  assert.match(result, /Never duplicate a waiting operation/); assert.doesNotMatch(result, /PRIVATE|aaaaa|bbbbb/);
  assert.equal(await browserHandoff({ ...options, env: { SPHINX_EVALUATOR: '1' }, listRequests: () => assert.fail('must skip') }), null);
});

test('browser fallback preserves unavailable work and consumes a paused presentation without reopening it', async () => {
  for (const status of ['unavailable', 'pending']) {
    let claimed = 0, closed = 0;
    const result = await browserHandoff({ env: {}, listRequests: async () => [{ id: 'a'.repeat(64), token: 'one', repoRoot: '/repo' }],
      claimRequest: async () => { claimed++; return true; },
      createInterview: () => ({ present: async () => ({ status }), close: async () => { closed++; } }),
    });
    assert.equal(claimed, status === 'pending' ? 1 : 0); assert.equal(closed, 1);
    assert.match(result, status === 'pending' ? /paused or incomplete/ : /own terminal/);
  }
});

test('pausing a browser fallback consumes the listed batch so unrelated tools do not open its next checkpoint', async () => {
  const requests = [{ id: 'a'.repeat(64), token: 'one', repoRoot: '/repo' }, { id: 'b'.repeat(64), token: 'two', repoRoot: '/repo' }];
  let queued = [...requests], created = 0, closed = 0;
  const presented = [], claimed = [];
  const options = { env: {}, listRequests: async () => [...queued],
    claimRequest: async request => { claimed.push(request.token); queued = queued.filter(item => item.token !== request.token); return true; },
    createInterview: () => { created++; return {
      present: async ({ request }) => { presented.push(request.token); return { status: 'pending' }; },
      close: async () => { closed++; },
    }; },
  };
  assert.match(await browserHandoff(options), /paused or incomplete/);
  assert.deepEqual(presented, ['one']);
  assert.deepEqual(claimed, ['one', 'two']); assert.deepEqual(queued, []);
  assert.equal(await browserHandoff(options), null);
  assert.deepEqual(presented, ['one']); assert.equal(created, 1); assert.equal(closed, 1);
});

test('an unavailable browser fallback preserves its whole batch for a later supported callback', async () => {
  const requests = [{ id: 'a'.repeat(64), token: 'one', repoRoot: '/repo' }, { id: 'b'.repeat(64), token: 'two', repoRoot: '/repo' }];
  let queued = [...requests], status = 'unavailable', closed = 0;
  const presented = [], claimed = [];
  const options = { env: {}, listRequests: async () => [...queued],
    claimRequest: async request => { claimed.push(request.token); queued = queued.filter(item => item.token !== request.token); return true; },
    createInterview: () => ({
      present: async ({ request }) => { presented.push(request.token); return { status }; },
      close: async () => { closed++; },
    }),
  };
  assert.match(await browserHandoff(options), /could not start a local browser questionnaire/);
  assert.deepEqual(queued, requests); assert.deepEqual(claimed, []); assert.deepEqual(presented, ['one']);
  status = 'passed';
  assert.match(await browserHandoff(options), /2 Sphinx checkpoint\(s\) completed/);
  assert.deepEqual(presented, ['one', 'one', 'two']);
  assert.deepEqual(claimed, ['one', 'two']); assert.deepEqual(queued, []); assert.equal(closed, 2);
});

test('Cursor post-tool hooks send only routing fields to queue inspection and handle failures safely', async () => {
  let captured;
  const handoff = async options => { captured = options; return 'Human terminal notice'; };
  const output = await cursorAgentHook({ env: {}, handoff, input: { hook_event_name: 'postToolUseFailure', tool_name: 'Shell', cwd: '/repo', conversation_id: 'conversation-7', tool_input: { command: 'PRIVATE COMMAND' }, tool_output: 'PRIVATE SOURCE', transcript_path: '/private/transcript' } });
  assert.deepEqual(output, { additional_context: 'Human terminal notice' });
  assert.deepEqual(captured, { cwd: '/repo', host: 'cursor', hostSession: 'conversation-7', env: {} });
  assert.deepEqual(await cursorAgentHook({ handoff: () => { throw new Error('must not inspect'); }, input: { hook_event_name: 'postToolUse', tool_name: 'Read' }, env: {} }), {});
  const failed = await cursorAgentHook({ input: { hook_event_name: 'postToolUse', tool_name: 'Shell' }, env: {}, handoff: () => { throw new Error('PRIVATE FAILURE'); } });
  assert.match(failed.additional_context, /sphinx doctor/); assert.doesNotMatch(failed.additional_context, /PRIVATE/);
});

test('Cursor cross-directory routing reads only exact Git-emitted checkpoint markers', async () => {
  const id = 'a'.repeat(64), second = 'b'.repeat(64);
  const marker = value => `Outside a supported agent, run sphinx check --id ${value} in your terminal.`;
  const tool_output = JSON.stringify({ exitCode: 1, stdout: `PRIVATE_SOURCE\n${marker(id)}\n`, stderr: `${marker(second)}\r\n${marker(id)}`, unrelated: marker('c'.repeat(64)) });
  assert.deepEqual(cursorCheckpointIds({ tool_output }), [id, second]);
  assert.deepEqual(cursorCheckpointIds({ error_message: `Command failed\n${marker(id)}` }), [id]);
  for (const payload of [
    marker(id), JSON.stringify({ stdout: `sphinx check --id ${id}` }),
    JSON.stringify({ stdout: marker(id.toUpperCase()) }),
    JSON.stringify({ stdout: `Quoted: ${marker(id)}` }),
    JSON.stringify({ transcript: marker(id) }),
    JSON.stringify({ stdout: marker(`${id}0`) }),
    JSON.stringify({ stdout: `${marker(id)}; execute unwanted command` }),
  ]) assert.deepEqual(cursorCheckpointIds({ tool_output: payload }), []);
  let inspected;
  const response = await cursorAgentHook({ input: { hook_event_name: 'postToolUse', tool_name: 'Shell', cwd: '/first-repository', conversation_id: 'cursor-session', tool_output, tool_input: { command: 'PRIVATE_COMMAND' } }, env: {},
    handoff: options => terminalHandoff({ ...options, listRequests: async value => { inspected = value; return []; } }),
  });
  assert.deepEqual(inspected, { cwd: '/first-repository', host: 'cursor', hostSession: 'cursor-session', checkpointIds: [id, second], env: {} });
  assert.deepEqual(response, {});
  assert.doesNotMatch(JSON.stringify(inspected), /PRIVATE_SOURCE|PRIVATE_COMMAND|exitCode|stdout|stderr/);
});

test('terminal handoff consumes only Git-created requests once, without reading or grading assessments', async () => {
  const requests = [{ token: 'one', id: 'a'.repeat(64), privateQuestion: 'NEVER SEND' }, { token: 'two', id: 'b'.repeat(64) }];
  const seen = new Set();
  const launched = [];
  const options = { cwd: '/repo', host: 'opencode', hostSession: 'ses_123', env: {}, listRequests: async () => requests, claimRequest: async request => { if (seen.has(request.token)) return false; seen.add(request.token); return true; }, launch: async ({ request }) => { launched.push(request.id); return { status: 'opened' }; }, waitForResult: async () => 'passed' };
  const notice = await terminalHandoff(options);
  assert.match(notice, /completed directly in its terminal window/);
  assert.match(notice, /fallback understanding check/);
  assert.match(notice, /does not resume an exited Git process/);
  assert.match(notice, /Before retrying, verify that the original Git operation has exited with a Sphinx blocking failure/);
  assert.match(notice, /Never duplicate a waiting operation or repeat a successful operation/);
  assert.deepEqual(launched, [requests[0].id, requests[1].id]);
  assert.doesNotMatch(notice, /NEVER SEND|aaaaa|bbbbb/);
  assert.equal(await terminalHandoff(options), null);
  assert.equal(await terminalHandoff({ ...options, env: { SPHINX_EVALUATOR: '1' }, listRequests: () => { throw new Error('must skip'); } }), null);
});

test('a terminal that fails after launch gives the human a manual fallback rather than an open-window claim', async () => {
  for (const status of ['unavailable', 'interrupted']) {
    let claimed = 0;
    const notice = await terminalHandoff({ cwd: '/repo', env: {},
      listRequests: async () => [{ id: 'a'.repeat(64), token: 'attempt' }],
      launch: async () => ({ status: 'opened' }), claimRequest: async () => { claimed++; return true; },
      waitForResult: async () => status,
    });
    assert.equal(claimed, 1);
    assert.match(notice, /remains pending/);
    assert.match(notice, /human can run `sphinx check` in their own terminal/);
    assert.match(notice, /Never duplicate a waiting operation/);
    assert.doesNotMatch(notice, /still open|completed directly/);
  }
});

test('OpenCode plugin tags shell sessions and supplies a one-time terminal notice through documented hooks', async () => {
  const calls = [], toasts = [];
  const hooks = registerOpenCodeIntegration({ directory: '/repo', client: { tui: { showToast: async value => toasts.push(value) } } }, { home: '/sphinx', env: {}, handoff: async value => { calls.push(value); return calls.length === 1 ? 'Run sphinx check in your own terminal.' : null; } });
  const shell = { env: { EXISTING: 'keep' } };
  await hooks['shell.env']({ sessionID: 'ses_123' }, shell);
  assert.deepEqual(shell.env, { EXISTING: 'keep', SPHINX_HOME: '/sphinx', SPHINX_OPENCODE_SESSION: 'ses_123' });
  const system = { system: ['Existing instructions'] };
  await hooks['experimental.chat.system.transform']({}, system);
  await hooks['experimental.chat.system.transform']({}, system);
  assert.deepEqual(system.system, ['Existing instructions', TERMINAL_GUIDANCE]);
  const result = { output: 'Original Git rejection', metadata: { code: 1 } };
  await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_123', args: { command: 'PRIVATE' } }, result);
  assert.match(result.output, /^Original Git rejection/); assert.match(result.output, /own terminal/);
  assert.deepEqual(result.metadata, { code: 1 });
  assert.deepEqual(calls[0], { cwd: '/repo', host: 'opencode', hostSession: 'ses_123', env: { SPHINX_HOME: '/sphinx' } });
  assert.equal(toasts.length, 1);
  await hooks['tool.execute.after']({ tool: 'bash', sessionID: 'ses_123' }, { output: 'Other output' });
  await hooks['tool.execute.after']({ tool: 'read' }, { output: 'PRIVATE FILE' });
  assert.equal(calls.length, 2); assert.equal(toasts.length, 1);
  assert.deepEqual(registerOpenCodeIntegration({}, { env: { SPHINX_EVALUATOR: '1' } }), {});
});

test('Cursor command entry emits clean protocol JSON with no transcript or shell content', () => {
  const file = fileURLToPath(new URL('../src/cursor-hook.js', import.meta.url));
  const env = { ...process.env, FORCE_COLOR: '1', SPHINX_EVALUATOR: '' }; delete env.NO_COLOR;
  const output = execFileSync(process.execPath, [file], { input: JSON.stringify({ hook_event_name: 'sessionStart', session_id: 'conv_1', tool_output: 'PRIVATE OUTPUT', transcript_path: '/private' }), env, encoding: 'utf8' });
  assert.equal(JSON.parse(output).env.SPHINX_CURSOR_SESSION, 'conv_1');
  assert.doesNotMatch(output, /PRIVATE|\u001b/);
  const broken = execFileSync(process.execPath, [file], { input: 'PRIVATE INVALID JSON', encoding: 'utf8' });
  assert.match(JSON.parse(broken).additional_context, /sphinx doctor/); assert.doesNotMatch(broken, /PRIVATE/);
});
