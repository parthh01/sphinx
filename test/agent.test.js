import test from 'node:test';
import assert from 'node:assert/strict';
import { agentHook } from '../src/agent.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

for (const agent of ['codex', 'claude']) {
  test(`${agent} SessionStart distinguishes waiting Git from fallback forms without asking the coding model to interview`, async () => {
    const result = await agentHook({ agent, input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }), env: {} });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.hookSpecificOutput.hookEventName, 'SessionStart');
    const context = result.output.hookSpecificOutput.additionalContext;
    assert.match(context, /keeps the original Git operation waiting/);
    assert.match(context, /they confirm whether that same operation should continue/);
    assert.match(context, /Do not start a duplicate Git operation while it waits/);
    assert.match(context, /PostToolUse hook opens the same local browser questionnaire after the shell command exits/);
    assert.match(context, /This fallback does not resume an exited Git process/);
    assert.match(context, /verify that the original Git operation has exited with a Sphinx blocking failure before retrying/);
    assert.match(context, /Never duplicate a waiting operation or repeat a successful operation/);
    assert.match(context, /waits up to 25 minutes, but the host may cancel the shell sooner/);
    assert.match(context, /supported yielding or background execution; do not terminate or duplicate/);
    assert.match(context, /Only the outcome is returned to you/);
    assert.match(context, /Do not relay questions through chat/);
    assert.match(context, /Never answer on the human's behalf/);
    assert.match(context, /do not repeatedly retry/);
    assert.match(context, /If the human passes and then stops the push or commit, or Git stops waiting before they choose, do not retry it unless they ask\. Stopping is their decision; a retry reopens the questionnaire and interrupts them with the same choice\./);
    assert.match(context, /sphinx doctor/);
    assert.equal(context.includes('sphinx check --json'), false);
    assert.equal(context.includes('sphinx answer <session-id>'), false);
  });
}

test('agent hooks skip evaluator sessions and ignore unrelated lifecycle events', async () => {
  assert.deepEqual(await agentHook({ agent: 'codex', input: 'invalid', env: { SPHINX_EVALUATOR: '1' } }), { output: null, exitCode: 0 });
  assert.deepEqual(await agentHook({ agent: 'claude', event: 'Stop', input: '{}', env: {} }), { output: null, exitCode: 0 });
});

test('agent hooks reject malformed input and unsupported agents', async () => {
  await assert.rejects(agentHook({ agent: 'codex', input: 'not json', env: {} }), /valid JSON/);
  await assert.rejects(agentHook({ agent: 'unknown', input: '{}', env: {} }), /Unsupported agent/);
});

test('Claude session setup tags future shell commands without reading or replacing existing environment entries', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sphinx-agent-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session.sh');
  await writeFile(file, 'export EXISTING=value\n');
  const env = { CLAUDE_ENV_FILE: file };
  await agentHook({ agent: 'claude', input: { hook_event_name: 'SessionStart', session_id: 'test-session-123' }, env });
  const saved = await readFile(file, 'utf8');
  assert.ok(saved.startsWith('export EXISTING=value\n'));
  assert.match(saved, /export SPHINX_CLAUDE_SESSION='test-session-123'/);
  await agentHook({ agent: 'claude', input: { hook_event_name: 'SessionStart', session_id: "bad'; echo unsafe" }, env });
  assert.equal(await readFile(file, 'utf8'), saved, 'Unexpected session IDs cannot inject shell syntax');
  await agentHook({ agent: 'claude', input: { hook_event_name: 'SessionStart', session_id: 'evaluator' }, env: { ...env, SPHINX_EVALUATOR: '1' } });
  assert.equal(await readFile(file, 'utf8'), saved);
});

test('post-tool hooks need no MCP server: silent with nothing queued, and never fail the agent', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const home = await mkdtemp(path.join(tmpdir(), 'sphinx-post-'));
  try {
    for (const agent of ['claude', 'codex']) for (const event of agent === 'claude' ? ['PostToolUse', 'PostToolUseFailure'] : ['PostToolUse']) {
      const result = await agentHook({ agent, input: JSON.stringify({ hook_event_name: event, tool_name: 'Bash', cwd: home, session_id: 's1' }), env: { SPHINX_HOME: home, SPHINX_USER_HOME: home } });
      assert.deepEqual(result, { output: null, exitCode: 0 });
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
