import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_CONFIG, saveConfig, loadConfig, policyHash } from '../src/config.js';
import { pushSnapshots, revalidateSnapshot } from '../src/git.js';
import { createSessionStore } from '../src/sessions.js';
import { queuePresentation, listPresentations } from '../src/presentations.js';
import { runNativeCheckpoint } from '../src/native-check.js';
import { checkpointTerminalStatus, claimCheckpointDialog, finishCheckpointDialog } from '../src/terminal-launch.js';

const exec = promisify(execFile);
const q = {
  id: 'retry', concept: 'idempotency', prompt: 'Could retrying after a timeout duplicate the order? Explain why.',
  choices: ['Yes', 'No'], expectedAnswer: 'ANSWER_KEY_PRIVATE', rationale: 'RUBRIC_PRIVATE',
  evidence: [{ path: 'worker.js', reason: 'The operation is repeated.' }],
};
const answer = response => ({ action: 'accept', content: { action: 'answer', response } });
test('evaluator subprocesses never consume presentation requests or launch recursive questionnaires', async () => {
  const result = await runNativeCheckpoint({ env: { SPHINX_EVALUATOR: '1' }, listRequests: async () => assert.fail('No queue access in an evaluator'), elicit: async () => assert.fail('No recursive form') });
  assert.equal(result.status, 'not-required');
});
async function fixture(t, { questions = [q], grade, validate, sourceLines = 1 } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'sphinx-native-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'repo');
  await mkdir(cwd);
  const env = { SPHINX_HOME: path.join(home, 'state'), SPHINX_USER_HOME: home };
  const config = structuredClone(DEFAULT_CONFIG);
  await saveConfig(config, env);
  const git = async (...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  })).stdout.trim();
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Sphinx test');
  await git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(cwd, 'worker.js'), 'export const order = () => insert();\n' + '// More change evidence.\n'.repeat(sourceLines - 1));
  await git('add', '--all');
  await git('commit', '-m', 'Initial source');
  const head = await git('rev-parse', 'HEAD');
  const [snapshot] = await pushSnapshots({ cwd, config, env, remote: 'origin', remoteUrl: 'https://example.invalid/repo',
    input: `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n` });
  let generated = 0;
  const graded = [];
  const check = async (current, settings) => {
    if (policyHash(await loadConfig(current.repoRoot, env)) !== policyHash(settings)
      || !(await revalidateSnapshot(current, settings, { env }))) throw new Error('Stale snapshot');
    await validate?.(current, settings);
  };
  const store = createSessionStore({ env, validate: check,
    generate: async (_snapshot, _config, { beforeCall }) => { await beforeCall(); generated++; return { questions: structuredClone(questions) }; },
    grade: async request => { await request.beforeCall(); graded.push(request); return grade ? grade(request, graded.length) : { verdict: 'correct', feedback: 'FEEDBACK_PRIVATE', followUp: null }; },
  });
  const session = await store.ensure(snapshot, config);
  await queuePresentation(session, { env });
  const run = options => runNativeCheckpoint({ cwd, env, host: 'codex', supportsForm: true, store, ...options });
  return { cwd, env, config, git, snapshot, session, store, graded, generated: () => generated, run };
}

test('native forms complete each concept while tool results contain only status and counters', async t => {
  const second = { ...q, id: 'atomic', concept: 'atomicity', prompt: 'Could one of the two writes survive a failure?' };
  const f = await fixture(t, { questions: [q, second], sourceLines: 81 });
  const forms = [];
  const result = await f.run({ elicit: async form => { forms.push(form); return answer('HUMAN_RESPONSE_PRIVATE'); } });
  assert.equal(result.status, 'passed');
  assert.equal(result.completed, 2);
  assert.equal(result.calls, 3);
  assert.equal(result.checkpoints[0].usage.limit, null);
  assert.equal(forms.length, 2);
  assert.match(forms[0].message, /Could retrying/);
  assert.match(forms[0].message, /0 tokens/);
  assert.doesNotMatch(forms[0].message, /model calls/);
  assert.ok(forms[0].message.includes(`Repository: ${f.snapshot.repoRoot}`));
  assert.match(forms[0].message, /Options:\n- Yes\n- No/);
  assert.match(forms[1].message, /FEEDBACK_PRIVATE/, 'Feedback the grader wrote is shown');
  assert.deepEqual(forms[0].requestedSchema.properties.action.enum, ['answer', 'learn', 'dispute', 'pause']);
  assert.doesNotMatch(JSON.stringify(forms), /ANSWER_KEY_PRIVATE|RUBRIC_PRIVATE/);
  assert.doesNotMatch(JSON.stringify(result), /question|answer|feedback|HUMAN_RESPONSE_PRIVATE|FEEDBACK_PRIVATE|ANSWER_KEY_PRIVATE|RUBRIC_PRIVATE/i);
  assert.equal(await f.store.approved(f.snapshot, f.config), true);
  assert.equal((await f.run({ elicit: async () => assert.fail('A claimed request must not reopen') })).status, 'not-required');
});

test('native forms ignore answer-bearing concept metadata even from an older public-state adapter', async t => {
  const concept = 'PRIVATE_CONCEPT_ANSWER: yes, retries repeat the unconditional insertion.';
  const f = await fixture(t, { questions: [{ ...q, concept }] });
  const start = f.store.start;
  f.store.start = async (...args) => {
    const state = await start(...args);
    return { ...state, question: { ...state.question, concept } };
  };
  const result = await f.run({ elicit: async form => {
    assert.match(form.message, /Could retrying after a timeout/);
    assert.doesNotMatch(JSON.stringify(form), /PRIVATE_CONCEPT_ANSWER|undefined|ANSWER_KEY_PRIVATE|RUBRIC_PRIVATE/);
    return answer('Yes, another request repeats the insertion.');
  } });
  assert.equal(result.status, 'passed');
  assert.equal(f.graded[0].question.concept, concept);
  assert.equal((await f.store.read(f.snapshot.id)).questions[0].concept, concept);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONCEPT_ANSWER/);
});

test('wrong answers and learning/dispute requests stay in the native learning loop', async t => {
  const f = await fixture(t, { grade: async (request, count) => count < 4
    ? { verdict: request.dispute ? 'ambiguous' : 'incorrect', feedback: `PRIVATE_FEEDBACK_${count}`, followUp: { ...q, id: `transfer-${count}`, prompt: `Different scenario ${count}: can a retry duplicate this operation?` } }
    : { verdict: 'correct', feedback: 'Understood.', followUp: null } });
  const replies = [answer('No.'), { action: 'accept', content: { action: 'learn', response: 'IGNORE_THIS_FOR_LEARN' } },
    { action: 'accept', content: { action: 'dispute', response: 'The timing is unspecified.' } }, answer('Yes, the write can repeat.')];
  const forms = [];
  const result = await f.run({ elicit: async form => { forms.push(form); return replies.shift(); } });
  assert.equal(result.status, 'passed');
  assert.equal(f.graded.length, 4);
  assert.match(f.graded[1].answer, /I do not know/);
  assert.doesNotMatch(f.graded[1].answer, /IGNORE_THIS/);
  assert.equal(f.graded[2].dispute, true);
  assert.deepEqual(f.graded.map(x => x.question.id), ['retry', 'transfer-1', 'transfer-2', 'transfer-3']);
  assert.match(forms[2].message, /PRIVATE_FEEDBACK_2/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FEEDBACK/);
});

for (const response of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { action: 'pause' } }]) {
  test(`${response.content?.action || response.action} leaves the assessment pending without grading`, async t => {
    const f = await fixture(t);
    const result = await f.run({ elicit: async () => response });
    assert.equal(result.status, 'pending');
    assert.equal(result.calls, 1);
    assert.equal(f.graded.length, 0);
    assert.equal(await f.store.approved(f.snapshot, f.config), false);
    assert.equal((await listPresentations({ cwd: f.cwd, env: f.env })).length, 0);
    assert.equal((await checkpointTerminalStatus({ id: f.snapshot.id, env: f.env })).status, 'pending');
  });
}

test('unsupported clients preserve requests and make no evaluator calls', async t => {
  const f = await fixture(t);
  const result = await f.run({ supportsForm: false, elicit: async () => assert.fail('No form support'), reserveDialog: async () => assert.fail('No reservation without form support') });
  assert.equal(result.status, 'unsupported');
  assert.equal(f.generated(), 0);
  assert.equal((await listPresentations({ cwd: f.cwd, env: f.env })).length, 1);
});

test('an existing questionnaire reservation prevents native inference and duplicate forms', async t => {
  const f = await fixture(t);
  const [request] = await listPresentations({ cwd: f.cwd, env: f.env });
  const reservation = await claimCheckpointDialog({ request, env: f.env });
  assert.equal(reservation.status, 'claimed');
  const result = await f.run({ elicit: async () => assert.fail('Another questionnaire owns the checkpoint') });
  assert.equal(result.status, 'busy');
  assert.equal(f.generated(), 0); assert.equal(f.graded.length, 0);
  assert.equal((await listPresentations({ cwd: f.cwd, env: f.env })).length, 0);
  assert.equal((await checkpointTerminalStatus({ id: f.snapshot.id, env: f.env })).status, 'running');
  await finishCheckpointDialog({ id: f.snapshot.id, token: reservation.token, status: 'pending', env: f.env });
});

test('native dialogs hold the shared reservation through human input and release only verified completion as passed', async t => {
  const f = await fixture(t);
  const result = await f.run({ elicit: async () => {
    const status = await checkpointTerminalStatus({ id: f.snapshot.id, env: f.env });
    assert.equal(status.status, 'running');
    const contender = await claimCheckpointDialog({ request: { id: f.snapshot.id, repoRoot: f.cwd, token: '00000000-0000-0000-0000-000000000000' }, env: f.env });
    assert.equal(contender.status, 'busy');
    return answer('Yes. Every attempt inserts.');
  } });
  assert.equal(result.status, 'passed');
  assert.equal((await checkpointTerminalStatus({ id: f.snapshot.id, env: f.env })).status, 'passed');
});

test('pausing consumes the queued Git batch so later inspection commands do not reopen it', async t => {
  const f = await fixture(t);
  const other = { ...f.snapshot, id: 'b'.repeat(64), target: { ...f.snapshot.target, ref: 'refs/heads/release' } };
  await queuePresentation(await f.store.ensure(other, f.config), { env: f.env });
  let forms = 0;
  assert.equal((await f.run({ elicit: async () => { forms++; return { action: 'cancel' }; } })).status, 'pending');
  assert.equal(forms, 1);
  assert.equal(f.generated(), 1);
  assert.equal((await listPresentations({ cwd: f.cwd, env: f.env })).length, 0);
  // Requests queued in the same millisecond may be presented in either order.
  // Exactly one was prepared; the rest of the consumed batch stays untouched.
  const states = await Promise.all([f.snapshot.id, other.id].map(id => f.store.read(id)));
  assert.deepEqual(states.map(session => session.status).sort(), ['active', 'pending']);
});

test('empty queues do not start the evaluator or open a form', async () => {
  const result = await runNativeCheckpoint({ cwd: '/unused', supportsForm: true, listRequests: async () => [],
    elicit: async () => assert.fail('No form expected'), store: { start: async () => assert.fail('No model expected') } });
  assert.equal(result.status, 'not-required');
  assert.equal(result.calls, 0);
});

test('malformed forms are never submitted as answers', async t => {
  const f = await fixture(t);
  const replies = [answer('   '), { action: 'accept', content: { action: 'answer', response: 'Yes', expectedAnswer: 'Injected' } }, answer('Yes: both requests insert.')];
  let calls = 0;
  const result = await f.run({ elicit: async form => {
    if (calls++) assert.match(form.message, /No answer was submitted/);
    return replies.shift();
  } });
  assert.equal(result.status, 'passed');
  assert.equal(f.graded.length, 1);
});

test('changed Git source while the form is open fails before grading', async t => {
  const f = await fixture(t);
  const result = await f.run({ elicit: async () => {
    await writeFile(path.join(f.cwd, 'worker.js'), 'export const order = () => deduplicate();\n');
    await f.git('add', 'worker.js');
    await f.git('commit', '-m', 'Changed while answering');
    return answer('Yes, it inserts again.');
  } });
  assert.equal(result.status, 'error');
  assert.equal(f.graded.length, 0);
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
  assert.equal((await checkpointTerminalStatus({ id: f.snapshot.id, env: f.env })).status, 'pending');
});

test('changed policy while the form is open fails before grading', async t => {
  const f = await fixture(t);
  const result = await f.run({ elicit: async () => {
    await saveConfig({ ...f.config, level: 'thorough' }, f.env);
    return answer('Yes, it inserts again.');
  } });
  assert.equal(result.status, 'error');
  assert.equal(f.graded.length, 0);
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
});

test('a concurrently replaced question never receives the stale human answer', async t => {
  const f = await fixture(t, { grade: async () => ({ verdict: 'incorrect', feedback: 'Revisit retries.',
    followUp: { ...q, id: 'replacement', prompt: 'Can a retried background job repeat this write?' } }) });
  const result = await f.run({ elicit: async () => {
    await f.store.answer(f.snapshot.id, 'Another client answered this.', f.config);
    return answer('STALE_NATIVE_RESPONSE');
  } });
  assert.equal(result.status, 'error');
  assert.equal(f.graded.length, 1);
  assert.doesNotMatch(JSON.stringify(f.graded), /STALE_NATIVE_RESPONSE/);
});

test('abort while grading does not record a receipt or disclose evaluator output', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { grade: async () => {
    controller.abort();
    return { verdict: 'correct', feedback: 'PRIVATE_LAST_GRADE', followUp: null };
  } });
  const result = await f.run({ signal: controller.signal, elicit: async () => answer('Yes.') });
  assert.equal(result.status, 'pending');
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
  assert.equal((await f.store.read(f.snapshot.id)).index, 0);
  assert.equal(result.calls, 2);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_LAST_GRADE/);
  assert.equal((await checkpointTerminalStatus({ id: f.snapshot.id, env: f.env })).status, 'pending');
});

test('source changes during final grading prevent completion', async t => {
  let f;
  f = await fixture(t, { grade: async () => {
    await writeFile(path.join(f.cwd, 'worker.js'), 'export const order = () => changed();\n');
    await f.git('add', '--all');
    await f.git('commit', '-m', 'Changed during grading');
    return { verdict: 'correct', feedback: 'This was correct for the old source.', followUp: null };
  } });
  let forms = 0;
  const result = await f.run({ elicit: async () => { forms++; return answer('Yes.'); } });
  assert.equal(result.status, 'error');
  assert.equal(forms, 1, 'A code change ends the dialog instead of offering the question again');
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
});

test('provider errors never escape through the coding-agent result', async t => {
  const f = await fixture(t, { grade: async () => { throw new Error('PROVIDER_ERROR_WITH_PRIVATE_FEEDBACK'); } });
  let forms = 0;
  const result = await f.run({ elicit: async () => ++forms > 3 ? { action: 'cancel' } : answer('Yes.') });
  assert.equal(result.status, 'error');
  assert.equal(forms, 3);
  assert.equal(result.calls, 4, 'The question generation plus three ungraded attempts');
  assert.doesNotMatch(JSON.stringify(result), /PROVIDER_ERROR|feedback/i);
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
});

test('a rejected grade offers the same question and draft again, and the resubmission is graded', async t => {
  const f = await fixture(t, { grade: async (_request, count) => {
    if (count === 1) throw Object.assign(new Error('PRIVATE_GRADER_REJECTION'), { code: 'INVALID_MODEL_OUTPUT' });
    return { verdict: 'correct', feedback: 'Understood.', followUp: null };
  } });
  const forms = [];
  const result = await f.run({ elicit: async form => { forms.push(form); return forms.length > 2 ? { action: 'cancel' } : answer('Yes, both attempts insert.'); } });
  assert.equal(result.status, 'passed');
  assert.equal(forms.length, 2);
  assert.match(forms[1].message, /That response was not graded, and nothing was marked complete\. Your draft is kept: send it again, or choose pause\./);
  assert.match(forms[1].message, /Could retrying after a timeout/);
  assert.equal(forms[1].requestedSchema.properties.response.default, 'Yes, both attempts insert.');
  assert.equal(f.graded.length, 2);
  assert.equal(result.calls, 3);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_GRADER_REJECTION|not graded/i);
  assert.equal(await f.store.approved(f.snapshot, f.config), true);
});

test('a failed explanation request offers learn again and promises no draft, since it saves none', async t => {
  const f = await fixture(t, { grade: async (request, count) => {
    if (count === 1) throw Object.assign(new Error('PRIVATE_GRADER_REJECTION'), { code: 'INVALID_MODEL_OUTPUT' });
    return { verdict: 'correct', feedback: 'Understood.', followUp: null };
  } });
  const forms = [], replies = [{ action: 'accept', content: { action: 'learn' } }, answer('Yes, both attempts insert.')];
  const result = await f.run({ elicit: async form => { forms.push(form); return replies.shift() ?? { action: 'cancel' }; } });
  assert.equal(result.status, 'passed');
  assert.equal(f.graded[0].learn, true);
  assert.match(forms[1].message, /The explanation was not shown, and nothing was marked complete\. Choose learn to ask again, or choose pause\./);
  assert.doesNotMatch(forms[1].message, /draft/i);
  assert.equal(forms[1].requestedSchema.properties.action.default, 'learn');
  assert.equal(forms[1].requestedSchema.properties.response.default, undefined);
});

test('a response the store never saved is not called a kept draft', async t => {
  const f = await fixture(t);
  const submit = f.store.answer;
  let busy = true;
  f.store.answer = async (...args) => {
    if (busy) { busy = false; throw Object.assign(new Error('This assessment is already running. Wait for preparation to finish, then resume the check.'), { code: 'SPHINX_SESSION_BUSY' }); }
    return submit(...args);
  };
  const forms = [];
  const result = await f.run({ elicit: async form => { forms.push(form); return forms.length > 2 ? { action: 'cancel' } : answer('Yes, both attempts insert.'); } });
  assert.equal(result.status, 'passed');
  assert.match(forms[1].message, /That response was not graded or saved, and nothing was marked complete\. Enter it again, or choose pause\./);
  assert.equal(forms[1].requestedSchema.properties.response.default, undefined);
  assert.equal(f.graded.length, 1);
});

test('a failure that sending the same response again cannot change ends the native dialog at once', async t => {
  const f = await fixture(t);
  f.store.answer = async () => { throw Object.assign(new Error('The grading context cannot fit its evidence and rubric.'), { code: 'CONTEXT_LIMIT' }); };
  let forms = 0;
  const result = await f.run({ elicit: async () => ++forms > 1 ? { action: 'cancel' } : answer('Yes.') });
  assert.equal(result.status, 'error');
  assert.equal(forms, 1);
  assert.equal(result.calls, 1, 'Only the question generation was charged');
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
});

test('three ungraded responses in a row end the native dialog, and a graded response resets the count', async t => {
  const f = await fixture(t, { grade: async (_request, count) => {
    if (count !== 3) throw Object.assign(new Error('PRIVATE_GRADER_REJECTION'), { code: 'INVALID_MODEL_OUTPUT' });
    return { verdict: 'incorrect', feedback: 'Revisit retries.', followUp: { ...q, id: 'transfer', prompt: 'Can a retried background job repeat this write?' } };
  } });
  let forms = 0;
  const result = await f.run({ elicit: async () => ++forms > 6 ? { action: 'cancel' } : answer('No.') });
  assert.equal(result.status, 'error');
  assert.equal(forms, 6);
  assert.deepEqual(f.graded.map(request => request.question.id), ['retry', 'retry', 'retry', 'transfer', 'transfer', 'transfer']);
  assert.equal(result.calls, 7);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_GRADER_REJECTION/);
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
});

test('pausing after an ungraded attempt reports the calls it used', async t => {
  const f = await fixture(t, { grade: async () => { throw new Error('PROVIDER_ERROR'); } });
  const replies = [answer('Yes.'), { action: 'accept', content: { action: 'pause' } }];
  const result = await f.run({ elicit: async () => replies.shift() ?? { action: 'cancel' } });
  assert.equal(result.status, 'pending');
  assert.equal(result.calls, 2);
});

test('an ungraded attempt that spends the call allowance ends the dialog', async t => {
  const f = await fixture(t, { grade: async () => { throw new Error('PROVIDER_ERROR'); } });
  let forms = 0;
  const result = await f.run({ elicit: async () => {
    if (++forms > 1) return { action: 'cancel' };
    await saveConfig({ ...f.config, maxModelCalls: 2 }, f.env);
    return answer('Yes.');
  } });
  assert.equal(result.status, 'error');
  assert.equal(forms, 1);
  assert.deepEqual(result.checkpoints[0].usage, { calls: 2, limit: 2 });
});

test('a question replaced during submission ends the dialog without grading the stale answer', async t => {
  const f = await fixture(t, { grade: async () => ({ verdict: 'incorrect', feedback: 'Revisit retries.',
    followUp: { ...q, id: 'replacement', prompt: 'Can a retried background job repeat this write?' } }) });
  const submit = f.store.answer;
  f.store.answer = async (...args) => { await submit(f.snapshot.id, 'Another client answered this.', f.config); return submit(...args); };
  let forms = 0;
  const result = await f.run({ elicit: async () => ++forms > 1 ? { action: 'cancel' } : answer('STALE_NATIVE_RESPONSE') });
  assert.equal(result.status, 'error');
  assert.equal(forms, 1);
  assert.equal(f.graded.length, 1);
  assert.doesNotMatch(JSON.stringify(f.graded), /STALE_NATIVE_RESPONSE/);
});

test('mismatched queue metadata cannot open a different repository assessment', async t => {
  const f = await fixture(t);
  const result = await f.run({ listRequests: async () => [{ id: f.snapshot.id, repoRoot: '/different' }], claimRequest: async () => true,
    elicit: async () => assert.fail('No form expected') });
  assert.equal(result.status, 'error');
  assert.equal(f.generated(), 0);
});
