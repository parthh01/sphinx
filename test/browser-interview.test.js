import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { get } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowserInterview, notifyDesktop, openQuestionnaireBrowser } from '../src/browser-interview.js';
import { createSessionStore } from '../src/sessions.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { claimCheckpointDialog, checkpointTerminalStatus, finishCheckpointDialog } from '../src/terminal-launch.js';
import { recentOverrides } from '../src/overrides.js';
import { textStream } from '../src/stream.js';

const q = { id: 'duplicate', concept: 'idempotency', prompt: 'Can a retry duplicate the insert? <script>PRIVATE_SCRIPT</script>', choices: ['Yes', 'No'], expectedAnswer: 'PRIVATE_KEY', rationale: 'PRIVATE_RUBRIC', evidence: [{ path: 'app.js', reason: 'The insert is unconditional.' }] };
async function fixture(t, { generate, grade, maxModelCalls = 20, validate = async () => {}, plans = [], interviewOptions = {}, snapshotOverrides = {} } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'sphinx-browser-'));
  const env = { SPHINX_HOME: path.join(home, 'state'), SPHINX_USER_HOME: home }, repoRoot = path.join(home, 'repo'); await mkdir(repoRoot);
  const config = { ...structuredClone(DEFAULT_CONFIG), maxModelCalls };
  const snapshot = { id: 'a'.repeat(64), repoRoot, event: 'pre-push', target: { ref: 'refs/heads/main' }, files: ['app.js'], stats: { additions: 5, deletions: 1, files: 1 }, ...snapshotOverrides };
  let generated = 0, graded = 0, opened = 0;
  const store = createSessionStore({ env, validate,
    generate: async (_s, _c, options) => { generated++; if (generate) return generate(generated, options); await options.beforeCall(); return { questions: [q] }; },
    grade: async request => { graded++; await request.beforeCall(); return grade ? grade(request, graded) : { verdict: 'correct', feedback: 'Correct.', followUp: null }; },
  });
  await store.ensure(snapshot, config);
  const controller = new AbortController(), output = [];
  const interview = createBrowserInterview({ notify: () => false, env, signal: controller.signal, store, readConfig: async () => config, revalidate: async () => { await validate(); return true; }, openBrowser: async () => { opened++; return true; }, output: text => output.push(text), findPlans: async () => plans, checkUpdate: async () => null, ...interviewOptions });
  const request = { id: snapshot.id, token: randomUUID(), repoRoot, delivery: 'hook', createdAt: Date.now() };
  const tasks = [];
  const present = (next = request) => { const task = interview.present({ request: next }); tasks.push(task); return task; };
  t.after(async () => { controller.abort(); await Promise.allSettled(tasks); await interview.close(); await rm(home, { recursive: true, force: true }); });
  const waitFor = async phase => {
    for (let i = 0; i < 300 && interview.state.phase !== phase; i++) await delay(10);
    assert.equal(interview.state.phase, phase, JSON.stringify(interview.state)); return interview.state;
  };
  const post = async (action, extra = {}, selected = interview.state, headers = {}) => fetch(`${interview.url}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(interview.url).origin, 'X-Sphinx-Token': new URL(interview.url).pathname.slice(1), ...headers }, body: JSON.stringify({ id: selected.id, revision: selected.revision, action, ...(['answer', 'learn', 'dispute'].includes(action) && selected.question ? { questionId: selected.question.id } : {}), ...extra }) });
  const confirm = async (action = 'proceed') => {
    await waitFor('consent');
    const response = await post(action);
    assert.equal(response.status, 200, await response.clone().text());
    return response;
  };
  // A pass made while Git waits is saved held: Git takes it as approval only once the gate has seen Continue.
  const receipt = async () => { const session = await store.read(snapshot.id); return { passed: session.status === 'passed', held: !!session.held, approved: await store.approved(snapshot, config) }; };
  return { env, config, snapshot, store, interview, request, present, waitFor, post, confirm, controller, receipt, generated: () => generated, graded: () => graded, opened: () => opened, output };
}

test('browser launch uses only macOS background open and never activates or minimizes another app', async () => {
  let invocation;
  const result = await openQuestionnaireBrowser('http://127.0.0.1:12345/token', { platform: 'darwin', env: {}, spawnImpl: (command, args, options) => {
    invocation = { command, args, options }; const child = new EventEmitter(); setImmediate(() => child.emit('exit', 0)); return child;
  } });
  assert.equal(result, true); assert.equal(invocation.command, '/usr/bin/open'); assert.deepEqual(invocation.args, ['-g', 'http://127.0.0.1:12345/token']);
  assert.doesNotMatch(JSON.stringify(invocation), /activate|minimiz|frontmost|osascript/);
  for (const options of [{ platform: 'linux', env: { DISPLAY: ':1' } }, { platform: 'darwin', env: { SSH_TTY: '/dev/tty' } }, { platform: 'darwin', env: { CI: '1' } }]) assert.equal(await openQuestionnaireBrowser('http://127.0.0.1:12345/token', { ...options, spawnImpl: () => assert.fail('must not invoke a foreground launcher') }), false);
});

test('local page requires its token and rejects cross-origin, rebinding, and stale submissions', async t => {
  const f = await fixture(t), done = f.present(); const current = await f.waitFor('question');
  const page = await fetch(f.interview.url); const html = await page.text();
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(page.headers.get('cache-control'), /no-store/); assert.match(page.headers.get('referrer-policy'), /no-referrer/);
  assert.doesNotMatch(html, /PRIVATE_KEY|PRIVATE_RUBRIC|PRIVATE_SCRIPT/); assert.doesNotMatch(html, /innerHTML|https?:\/\//);
  const state = await (await fetch(`${f.interview.url}/state`)).json();
  assert.match(state.question.prompt, /<script>/); assert.doesNotMatch(JSON.stringify(state), /PRIVATE_KEY|PRIVATE_RUBRIC/);
  assert.equal((await fetch(`${new URL(f.interview.url).origin}/wrong/state`)).status, 404);
  const rebound = await new Promise(resolve => get(`${f.interview.url}/state`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }));
  assert.equal(rebound, 403);
  assert.equal((await f.post('answer', { response: 'Yes.' }, current, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.post('answer', { response: 'Yes.' }, current, { 'X-Sphinx-Token': 'wrong' })).status, 403);
  assert.equal((await f.post('answer', { response: 'Yes.', questionId: 'old-question' })).status, 409);
  assert.equal(f.graded(), 0);
  assert.equal((await f.post('answer', { response: 'Yes, the operation repeats.' }, current)).status, 202);
  assert.equal((await f.post('answer', { response: 'DUPLICATE' }, current)).status, 409);
  await f.confirm();
  assert.equal((await done).status, 'passed'); assert.equal(f.graded(), 1);
  assert.deepEqual(await f.receipt(), { passed: true, held: true, approved: false }, 'only the Git gate releases a waiting pass, once it sees Continue');
});

test('wrong answers stay in the same page and require a human response to the transfer question', async t => {
  const f = await fixture(t, { grade: async (_request, count) => count === 1 ? { verdict: 'incorrect', feedback: 'There is no durable deduplication.', followUp: { ...q, id: 'transfer', prompt: 'What changes after restart?' } } : { verdict: 'correct', feedback: 'Correct.', followUp: null } });
  const done = f.present(); await f.waitFor('question'); await f.post('answer', { response: 'No.' }); await f.waitFor('question');
  assert.equal(f.interview.state.question.id, 'transfer'); assert.match(f.interview.state.feedback, /durable/);
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
  await f.post('answer', { response: 'The set is recreated.' }); await f.confirm(); assert.equal((await done).status, 'passed'); assert.equal(f.opened(), 1);
});

test('a miss or an explanation without a new question says the same question is still open; a follow-up needs no such note', async t => {
  const transfer = { ...q, id: 'transfer', prompt: 'What changes after restart?' };
  const replies = [{ verdict: 'incorrect', feedback: 'There is no durable deduplication.', followUp: null }, { verdict: 'incorrect', feedback: 'Here is how it works.', followUp: null },
    { verdict: 'incorrect', feedback: 'Still not durable.', followUp: transfer }, { verdict: 'correct', feedback: '', followUp: null }];
  const f = await fixture(t, { grade: async () => replies.shift() });
  const done = f.present(); await f.waitFor('question');
  await f.post('answer', { response: 'No.' }); await f.waitFor('question');
  assert.equal((await (await f.post('learn')).json()).message, 'Preparing an explanation…', 'Nothing promises a new scenario that may not come');
  await f.waitFor('question');
  await f.post('answer', { response: 'Still no.' }); await f.waitFor('question');
  const shape = f.interview.state.messages.map(item => [item.kind, item.kind === 'question' ? item.questionId : item.text]);
  assert.deepEqual(shape, [['question', q.id], ['answer', 'No.'], ['feedback', 'There is no durable deduplication.'], ['notice', 'The same question is still open.'],
    ['learn', 'Explain this concept.'], ['feedback', 'Here is how it works.'], ['notice', 'The same question is still open.'],
    ['answer', 'Still no.'], ['feedback', 'Still not durable.'], ['question', 'transfer']]);
  await f.post('answer', { response: 'The set is recreated.' }); await f.confirm(); assert.equal((await done).status, 'passed');
});

test('a replacement that repeats the id of the question it replaces still appears as a new question', async t => {
  const f = await fixture(t, { grade: async (_request, count) => count < 3 ? { verdict: 'incorrect', feedback: 'Not quite.', followUp: { ...q, id: 'transfer', prompt: `Scenario ${count}: what changes after a restart?` } } : { verdict: 'correct', feedback: '', followUp: null } });
  const done = f.present(); await f.waitFor('question');
  await f.post('answer', { response: 'No.' }); await f.waitFor('question');
  await f.post('answer', { response: 'Still no.' }); await f.waitFor('question');
  const questions = f.interview.state.messages.filter(item => item.kind === 'question').map(item => [item.questionId, item.text]);
  assert.deepEqual(questions, [[q.id, q.prompt], ['transfer', 'Scenario 1: what changes after a restart?'], ['transfer-2', 'Scenario 2: what changes after a restart?']]);
  await f.post('answer', { response: 'The set is recreated.' }); await f.confirm(); assert.equal((await done).status, 'passed');
});

test('browser responses omit private concept and acceptance metadata even from a permissive public-state adapter', async t => {
  const concept = 'PRIVATE_CONCEPT_ANSWER: yes, each retry repeats the unconditional insertion.';
  const acceptance = { prediction: 'PRIVATE_ACCEPTANCE_PREDICTION: A retry can insert again.', causalReason: 'PRIVATE_ACCEPTANCE_CAUSE: The next request repeats the unconditional insertion.' };
  const f = await fixture(t, {
    generate: async (_count, options) => { await options.beforeCall(); return { questions: [{ ...q, concept, acceptance }] }; },
    grade: async request => {
      assert.equal(request.question.concept, concept);
      assert.deepEqual(request.question.acceptance, acceptance);
      return { verdict: 'correct', feedback: 'Correct.', followUp: null };
    },
  });
  const start = f.store.start;
  f.store.start = async (...args) => {
    const state = await start(...args);
    return { ...state, question: { ...state.question, concept, acceptance } };
  };
  const done = f.present();
  await f.waitFor('question');
  const current = await (await fetch(`${f.interview.url}/state`)).json();
  assert.deepEqual(current.question, { id: q.id, prompt: q.prompt, choices: q.choices });
  assert.doesNotMatch(JSON.stringify(current), /PRIVATE_CONCEPT_ANSWER|PRIVATE_ACCEPTANCE|"concept"|"acceptance"/);
  const submitted = await f.post('answer', { response: 'Yes, another insertion is attempted.' });
  assert.doesNotMatch(await submitted.text(), /PRIVATE_CONCEPT_ANSWER|PRIVATE_ACCEPTANCE|"concept"|"acceptance"/);
  await f.confirm();
  assert.equal((await done).status, 'passed');
  assert.equal((await f.store.read(f.snapshot.id)).questions[0].concept, concept);
  assert.deepEqual((await f.store.read(f.snapshot.id)).questions[0].acceptance, acceptance);
  assert.doesNotMatch(JSON.stringify(f.interview.state), /PRIVATE_CONCEPT_ANSWER|PRIVATE_ACCEPTANCE|"concept"|"acceptance"/);
});

test('the character allowance accepts UTF-8 answers without truncation', async t => {
  const answer = '因'.repeat(8000);
  const f = await fixture(t, { grade: async request => {
    assert.equal(request.answer, answer);
    return { verdict: 'ambiguous', feedback: 'Use a complete causal explanation.', followUp: null };
  } });
  const done = f.present(); await f.waitFor('question');
  assert.equal((await f.post('answer', { response: answer })).status, 202);
  await f.waitFor('question'); assert.equal(f.graded(), 1);
  await f.post('pause'); assert.equal((await done).status, 'pending');
});

test('Pause aborts active grading and releases Git without storing late success', async t => {
  let entered;
  const grading = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { grade: async request => { entered(); await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true })); return { verdict: 'correct', feedback: 'Late success.', followUp: null }; } });
  const done = f.present(); await f.waitFor('question'); await f.post('answer', { response: 'Yes.' }); await grading;
  await f.post('pause'); assert.equal((await done).status, 'pending'); assert.equal(await f.store.approved(f.snapshot, f.config), false);
  assert.equal((await checkpointTerminalStatus({ id: f.snapshot.id, env: f.env })).status, 'pending');
  assert.equal((await f.store.read(f.snapshot.id)).calls, 2);
});

test('Pause after a receipt was committed stops the interview without revoking or denying saved completion', async t => {
  const f = await fixture(t);
  let saved;
  const committed = new Promise(resolve => { saved = resolve; });
  const answer = f.store.answer;
  f.store.answer = async (...args) => {
    const result = await answer(...args);
    saved();
    await new Promise(resolve => args[3].signal.addEventListener('abort', resolve, { once: true }));
    return result;
  };
  const done = f.present(); await f.waitFor('question');
  await f.post('answer', { response: 'Yes, the insert is repeated.' }); await committed;
  assert.deepEqual(await f.receipt(), { passed: true, held: true, approved: false });
  const paused = await (await f.post('pause')).json();
  assert.match(paused.message, /^Push stopped\. It did not go through, and your progress is saved\. To continue, run the same push again/);
  assert.equal(paused.resume, 'git push', 'says how to continue');
  assert.equal((await done).status, 'pending');
  assert.doesNotMatch(f.interview.state.message, /No approval/);
  assert.deepEqual(await f.receipt(), { passed: true, held: true, approved: false }, 'An already committed receipt must remain saved');
  assert.equal((await checkpointTerminalStatus({ id: f.snapshot.id, env: f.env })).status, 'pending');
});

test('review failure stays in the page and cannot retry or add an allowance without human action', async t => {
  const f = await fixture(t, { generate: async (attempt, options) => { await options.beforeCall(); if (attempt === 1) throw Object.assign(new Error('Review did not retain evidence.'), { code: 'INSUFFICIENT_EVIDENCE' }); return { questions: [q] }; } });
  const done = f.present(); await f.waitFor('recovery');
  assert.deepEqual(f.interview.state.choices.map(choice => choice.value), ['retry', 'pause']);
  assert.equal(f.generated(), 1); assert.equal((await f.store.read(f.snapshot.id)).calls, 1);
  await f.post('retry'); await f.waitFor('question'); assert.equal(f.generated(), 2);
  await f.post('pause'); assert.equal((await done).status, 'pending');
  assert.equal((await f.store.read(f.snapshot.id)).reviewRetries, undefined);
});

test('a batch reuses one local page and stale prior-checkpoint submissions cannot reach the next one', async t => {
  const f = await fixture(t), first = f.present(); await f.waitFor('question'); const stale = f.interview.state;
  await f.post('answer', { response: 'Yes.' }); await f.confirm(); await first;
  const next = { ...f.snapshot, id: 'b'.repeat(64), target: { ref: 'refs/heads/master' } }; await f.store.ensure(next, f.config);
  const second = f.present({ ...f.request, id: next.id, token: randomUUID() }); await f.waitFor('question');
  assert.equal(f.opened(), 1); assert.equal(f.output.filter(line => line.startsWith('Sphinx questionnaire:')).length, 1);
  assert.equal((await f.post('answer', { response: 'Old answer' }, stale)).status, 409);
  await f.post('pause'); assert.equal((await second).status, 'pending');
});

test('browser reservation prevents simultaneous native dialogs and errors never approve stale source', async t => {
  let stale = false;
  const f = await fixture(t, { validate: async () => { if (stale) throw new Error('Snapshot changed.'); } });
  const done = f.present(); await f.waitFor('question');
  assert.equal((await claimCheckpointDialog({ request: f.request, env: f.env })).status, 'busy');
  stale = true; await f.post('answer', { response: 'Yes.' });
  assert.equal((await done).status, 'pending'); assert.equal(f.graded(), 0);
  assert.doesNotMatch(f.interview.state.message, /No approval/);
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
});

test('disconnected event streams cannot interrupt grading and the operation closes its HTTP listener', async t => {
  const f = await fixture(t), done = f.present(); await f.waitFor('question');
  await new Promise((resolve, reject) => {
    const request = get(`${f.interview.url}/events`, response => {
      response.once('data', () => { response.destroy(); request.destroy(); resolve(); });
    });
    request.once('error', reject);
  });
  await f.post('answer', { response: 'Yes, the insert is repeated.' });
  await f.confirm();
  assert.equal((await done).status, 'passed');
  const final = await (await fetch(`${f.interview.url}/state`)).json();
  assert.equal(final.phase, 'passed');
  assert.equal(final.operationClosed, false);
  await f.interview.close();
  assert.equal(f.interview.state.operationClosed, true);
  await assert.rejects(fetch(`${f.interview.url}/state`));
});

test('Git cancellation during review aborts work, releases the reservation, and never approves a late result', async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { generate: async (_attempt, options) => {
    await options.beforeCall(); entered();
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    return { questions: [q] };
  } });
  const done = f.present(); await started; f.controller.abort(new Error('Git stopped.'));
  assert.equal((await done).status, 'pending');
  assert.equal(f.interview.state.phase, 'paused');
  assert.equal((await checkpointTerminalStatus({ id: f.snapshot.id, env: f.env })).status, 'pending');
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
  assert.equal((await f.store.read(f.snapshot.id)).questions.length, 0);
});

test('a check Git discarded as stale tells the page why instead of reporting a pause', async t => {
  const f = await fixture(t), done = f.present(); await f.waitFor('question');
  const reason = Object.assign(new Error('Sphinx settings changed while Git was waiting, so this check was discarded.'), { code: 'SPHINX_STALE' });
  f.controller.abort(reason);
  assert.equal((await done).status, 'pending');
  assert.equal(f.interview.state.phase, 'error');
  assert.equal(f.interview.state.error, reason.message);
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
});

test('CI and evaluator subprocesses never start a browser or model', async () => {
  for (const env of [{ CI: '1' }, { SPHINX_EVALUATOR: '1' }]) {
    const interview = createBrowserInterview({ notify: () => false, env, openBrowser: () => assert.fail('must not open'), reserve: () => assert.fail('must not reserve') });
    assert.equal((await interview.present({ request: { id: 'a'.repeat(64) } })).status, 'unavailable'); await interview.close();
  }
});

test('the page receives a chat transcript of questions, answers, feedback, follow-ups, and live review activity', async t => {
  const f = await fixture(t, {
    generate: async (_count, options) => { options.onProgress?.('Reading app.js'); await options.beforeCall(); return { questions: [q] }; },
    grade: async (_request, count) => count === 1 ? { verdict: 'incorrect', feedback: 'There is no durable deduplication.', followUp: { ...q, id: 'transfer', prompt: 'What changes after restart?' } } : { verdict: 'correct', feedback: 'Correct.', followUp: null },
  });
  const done = f.present(); await f.waitFor('question');
  await f.post('answer', { response: 'No.' });
  for (let i = 0; i < 300 && f.interview.state.question?.id !== 'transfer'; i++) await delay(10);
  await f.waitFor('question');
  const shape = f.interview.state.messages.map(item => [item.role, item.kind, item.status, item.followUp].filter(value => value !== undefined));
  assert.deepEqual(shape, [['sphinx', 'activity'], ['sphinx', 'question', false], ['human', 'answer', 'graded'], ['sphinx', 'feedback'], ['sphinx', 'question', true]]);
  assert.equal(f.interview.state.messages[2].text, 'No.');
  assert.doesNotMatch(JSON.stringify(f.interview.state), /PRIVATE_KEY|PRIVATE_RUBRIC|idempotency/);
  await f.post('answer', { response: 'The set is recreated.' });
  await f.confirm();
  assert.equal((await done).status, 'passed');
});

test('Skip this time lets Git continue during review, logs the reason, and never writes a receipt', async t => {
  let entered;
  const reviewing = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { generate: async (_count, options) => { entered(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); throw options.signal.reason; } });
  const done = f.present(); await reviewing; await f.waitFor('working');
  const response = await f.post('skip', { response: 'prod is down', revision: 'stale-revision' });
  assert.equal(response.status, 200, 'Skip does not need the latest revision while progress streams');
  assert.equal((await done).status, 'skipped');
  assert.equal(f.interview.state.phase, 'skipped');
  assert.match(f.interview.state.message, /you can close this tab/);
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
  const [entry] = await recentOverrides({ env: f.env });
  assert.equal(entry.kind, 'skip'); assert.equal(entry.reason, 'prod is down'); assert.equal(entry.id, f.snapshot.id);
  assert.equal((await f.store.read(f.snapshot.id)).status, 'skipped');
  assert.deepEqual(await f.store.pending(f.snapshot.repoRoot), [], 'A skipped check never resurfaces as pending');
});

test('grader feedback streams into the page while grading, then the saved feedback replaces the draft', async t => {
  let release, seenDraft;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { grade: async () => {
    textStream()?.('{"questionValid":true,"verdict":"incorrect","feedback":"There is no dur');
    await gate;
    return { verdict: 'correct', feedback: 'There is no durable deduplication.', followUp: null };
  } });
  const done = f.present(); await f.waitFor('question');
  await f.post('answer', { response: 'Yes.' });
  for (let i = 0; i < 300 && !seenDraft; i++) { seenDraft = f.interview.state.messages.find(item => item.streaming); if (!seenDraft) await delay(10); }
  assert.equal(seenDraft?.text, 'There is no dur', 'Partial feedback reached the page before grading finished');
  release();
  await f.confirm();
  assert.equal((await done).status, 'passed');
  const feedback = f.interview.state.messages.filter(item => item.kind === 'feedback');
  assert.deepEqual(feedback.map(item => [item.text, Boolean(item.streaming)]), [['There is no durable deduplication.', false]], 'Feedback the grader wrote is shown, even on a correct answer');
});

test('the page serves the frozen change and verified question evidence without disturbing an answer in flight', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { writeFile } = await import('node:fs/promises');
  const { pushSnapshots } = await import('../src/git.js');
  const { createReviewWorkspace } = await import('../src/review-workspace.js');
  const exec = promisify(execFile);
  const home = await mkdtemp(path.join(tmpdir(), 'sphinx-browser-change-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const repoRoot = path.join(home, 'repo'); await mkdir(repoRoot);
  // Only what Git needs: inheriting the runner's environment would carry CI=true, which disables the browser questionnaire.
  const env = { PATH: process.env.PATH, HOME: home, SPHINX_HOME: path.join(home, 'state'), SPHINX_USER_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = async (...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repoRoot, env })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repoRoot, 'app.js'), 'const seen = new Set();\nexport function add(id) {\n  seen.add(id);\n}\n');
  await git('add', '.'); await git('commit', '-qm', 'base'); const base = await git('rev-parse', 'HEAD');
  await writeFile(path.join(repoRoot, 'app.js'), 'const seen = new Set();\nexport function add(id) {\n  if (seen.has(id)) return false;\n  seen.add(id);\n  return true;\n}\n');
  await writeFile(path.join(repoRoot, 'notes.md'), 'hello\n'); await writeFile(path.join(repoRoot, '.env'), 'SECRET=1\n');
  await git('add', '.'); await git('commit', '-qm', 'change'); const head = await git('rev-parse', 'HEAD');
  const config = { ...structuredClone(DEFAULT_CONFIG), events: ['pre-push'] };
  const [snapshot] = await pushSnapshots({ cwd: repoRoot, config, env, remote: 'origin', remoteUrl: 'https://example.invalid/r', input: `refs/heads/main ${head} refs/heads/main ${base}\n` });
  const workspace = await createReviewWorkspace(snapshot, config, { env });
  const result = await workspace.execute('read_diff', { path: 'app.js' });
  const review = { version: 1, snapshotId: snapshot.id, summary: 'Fixture.', evidence: [{ id: 'read-1', tool: 'read_diff', args: { path: 'app.js' }, result, paths: ['app.js'] }], evidencePaths: ['app.js'] };
  const store = createSessionStore({ env, generate: async (_s, _c, options) => { await options.beforeCall(); return { questions: [{ ...q, evidence: [{ path: 'app.js', reason: 'PRIVATE_REASON' }] }], review }; },
    grade: async request => { await request.beforeCall(); return { verdict: 'correct', feedback: 'Correct.', followUp: null }; } });
  await store.ensure(snapshot, config);
  const controller = new AbortController();
  const interview = createBrowserInterview({ notify: () => false, env, signal: controller.signal, store, readConfig: async () => config, revalidate: async () => true, openBrowser: async () => false, output: () => {} });
  const done = interview.present({ request: { id: snapshot.id, token: randomUUID(), repoRoot: snapshot.repoRoot, delivery: 'hook', createdAt: Date.now() } });
  t.after(async () => { controller.abort(); await done.catch(() => {}); await interview.close(); });
  let first;
  for (let i = 0; i < 300 && interview.state.phase !== 'question'; i++) await delay(10);
  first = interview.state;
  for (let i = 0; i < 300 && !interview.state.evidence; i++) await delay(10);
  const current = interview.state;
  assert.equal(current.change?.status, 'ready', JSON.stringify(current));
  assert.deepEqual(current.change.totals, { files: 2, additions: 3, deletions: 0, binaryFiles: 0, uncountedFiles: 0 });
  assert.equal(current.change.header.excludedFiles, 1);
  assert.deepEqual(current.evidence, { questionId: q.id, refs: [{ path: 'app.js', inChange: true, viewPath: 'app.js', ranges: [{ side: 'new', start: 1, end: 6 }] }] });
  assert.doesNotMatch(JSON.stringify(current), /PRIVATE_REASON|PRIVATE_KEY/);
  const summary = await (await fetch(`${interview.url}/change?id=${snapshot.id}`)).json();
  assert.deepEqual(summary.files.map(file => [file.path, file.status, file.additions, file.deletions]), [['app.js', 'modified', 2, 0], ['notes.md', 'added', 1, 0]]);
  const diff = await (await fetch(`${interview.url}/diff?id=${snapshot.id}&path=app.js&context=all`)).json();
  assert.deepEqual(diff.hunks[0].rows.filter(row => row.type === 'addition').map(row => row.new), [3, 5]);
  assert.equal((await fetch(`${interview.url}/diff?id=${snapshot.id}&path=.env`)).status, 404);
  assert.equal((await fetch(`${interview.url}/diff?id=${'b'.repeat(64)}&path=app.js`)).status, 409);
  assert.equal((await fetch(`${new URL(interview.url).origin}/wrong/change?id=${snapshot.id}`)).status, 404);
  // Display-only updates keep the actionable revision used by a draft answer.
  assert.equal(current.revision, first.revision);
  const answered = await fetch(`${interview.url}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(interview.url).origin, 'X-Sphinx-Token': new URL(interview.url).pathname.slice(1) },
    body: JSON.stringify({ id: first.id, revision: first.revision, action: 'answer', questionId: q.id, response: 'It returns false for a repeated id.' }) });
  assert.equal(answered.status, 202);
  for (let i = 0; i < 300 && interview.state.phase !== 'consent'; i++) await delay(10);
  assert.equal(interview.state.phase, 'consent');
  const continued = await fetch(`${interview.url}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(interview.url).origin, 'X-Sphinx-Token': new URL(interview.url).pathname.slice(1) },
    body: JSON.stringify({ id: interview.state.id, revision: interview.state.revision, action: 'proceed' }) });
  assert.equal(continued.status, 200);
  assert.equal((await done).status, 'passed');
  assert.match(interview.state.message, /You passed\. You can close this tab/);
  assert.match(interview.state.message, /not a review of every changed line/);
});

test('a rate limit while grading offers the coding-agent plan, then the same question is answered on it', async t => {
  const providers = [];
  const f = await fixture(t, { plans: ['claude'], grade: async (request, count) => {
    providers.push(request.config.provider);
    if (count === 1) throw Object.assign(new Error('OpenRouter HTTP 429 (code: 429; error_type: rate_limit_exceeded).'), { code: 'OPENROUTER_PROVIDER_ERROR', status: 429, errorType: 'rate_limit_exceeded' });
    return { verdict: 'correct', feedback: 'Correct.', followUp: null };
  } });
  const done = f.present(); await f.waitFor('question');
  await f.post('answer', { response: 'Yes, it inserts again.' });
  const recovery = await f.waitFor('recovery');
  assert.deepEqual(recovery.choices.map(choice => choice.value), ['switch-claude', 'back']);
  await f.post('switch-claude');
  await f.waitFor('question');
  assert.match(f.interview.state.messages.at(-1).text, /Switched this check to Claude Code\. Send your answer again\./);
  await f.post('answer', { response: 'Yes, it inserts again.' });
  await f.confirm();
  assert.equal((await done).status, 'passed');
  assert.deepEqual(providers, ['openrouter', 'claude']);
});

test('a newer release is offered in the header and installs only after the check ends', async t => {
  const started = [];
  const f = await fixture(t, { interviewOptions: {
    checkUpdate: async () => ({ current: '0.1.7', latest: '0.1.9', available: true, command: 'npm install -g sphinx-understand@latest', note: null }),
    planUpdate: async () => ({ manager: 'npm', command: ['npm', 'install', '-g', 'sphinx-understand@latest'] }),
    startUpdate: async options => { started.push(options); return true; },
  } });
  f.present(); await f.waitFor('question');
  for (let i = 0; i < 100 && !f.interview.state.update; i++) await delay(10);
  assert.equal(f.interview.state.update.latest, '0.1.9');
  const html = await (await fetch(f.interview.url)).text();
  assert.match(html, /id="version">v\d+\.\d+\.\d+</);
  const forged = await fetch(`${f.interview.url}/action?update=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.invalid' }, body: '{}' });
  assert.equal(forged.status, 403); assert.equal(started.length, 0);
  const token = new URL(f.interview.url).pathname.slice(1);
  const res = await fetch(`${f.interview.url}/action?update=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(f.interview.url).origin, 'X-Sphinx-Token': token }, body: '{}' });
  assert.equal(res.status, 200); assert.equal((await res.json()).update.status, 'scheduled');
  assert.deepEqual(started[0].command, ['npm', 'install', '-g', 'sphinx-understand@latest']);
  assert.equal(f.interview.state.phase, 'question', 'updating never interrupts the check');
  const again = await fetch(`${f.interview.url}/action?update=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(f.interview.url).origin, 'X-Sphinx-Token': token }, body: '{}' });
  assert.equal(again.status, 409); assert.equal(started.length, 1);
});

test('after a wrong answer streams its feedback, the page shows what Sphinx is doing next', async t => {
  const transfer = { ...q, id: 'transfer', prompt: 'A different retry scenario: what happens now?' };
  let release;
  const f = await fixture(t, { grade: async request => {
    const raw = '{"questionValid":true,"verdict":"incorrect","feedback":"The insert runs again on retry."';
    textStream()?.(raw);
    await Promise.race([new Promise(resolve => { release = resolve; }), delay(3000)]);
    return { verdict: 'incorrect', feedback: 'The insert runs again on retry.', followUp: transfer };
  } });
  f.present(); const state = await f.waitFor('question');
  await f.post('answer', { questionId: state.question.id, response: 'It is skipped.' });
  for (let i = 0; i < 200 && !release; i++) await delay(10);
  for (let i = 0; i < 200 && f.interview.state.messages.at(-1)?.kind !== 'activity'; i++) await delay(10);
  const messages = f.interview.state.messages;
  assert.equal(messages.at(-1).text, 'Writing a new scenario to try…');
  assert.equal(messages.at(-2).kind, 'feedback'); assert.equal(messages.at(-2).streaming, false, 'no frozen cursor');
  release?.();
  const next = await f.waitFor('question');
  assert.ok(!next.messages.some(item => item.text === 'Writing a new scenario to try…'), 'the step goes away with the result');
});

const pickModel = (f, body) => fetch(`${f.interview.url}/action?model=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(f.interview.url).origin, 'X-Sphinx-Token': new URL(f.interview.url).pathname.slice(1) }, body: JSON.stringify(body) });

test('picking a model during the questions grades with it from then on, and can become the default after the check', async t => {
  const f = await fixture(t, { plans: ['claude'] });
  const done = f.present(); await f.waitFor('question');
  assert.deepEqual(f.interview.state.models.groups.map(group => group.provider), ['claude']);
  assert.equal((await pickModel(f, { provider: 'claude', model: 'opus' })).status, 400, 'only listed models');
  const res = await pickModel(f, { provider: 'claude', model: 'sonnet', saveDefault: true });
  assert.equal(res.status, 200);
  assert.deepEqual([f.interview.state.route.provider, f.interview.state.route.model], ['claude', 'sonnet']);
  assert.match(f.interview.state.messages.at(-1).text, /Switched this check to Claude Code sonnet\. It becomes your default when this check ends\./);
  const { readFile } = await import('node:fs/promises');
  const before = await readFile(path.join(f.env.SPHINX_HOME, 'config.json'), 'utf8').catch(() => '');
  assert.doesNotMatch(before, /sonnet/, 'saved when the check ends, not mid-check');
  const state = f.interview.state;
  await f.post('answer', { questionId: state.question.id, response: 'Yes, because the insert is unconditional.' });
  await f.confirm();
  assert.equal((await done).status, 'passed');
  // Settings for future checks are written on close(), after Git has had its answer.
  assert.doesNotMatch(await readFile(path.join(f.env.SPHINX_HOME, 'config.json'), 'utf8').catch(() => ''), /sonnet/);
  await f.interview.close();
  const saved = JSON.parse(await readFile(path.join(f.env.SPHINX_HOME, 'config.json'), 'utf8'));
  assert.deepEqual(saved.models.large, { provider: 'claude', model: 'sonnet' });
});

test('picking a model mid-review stops that run and restarts the review on the new model', async t => {
  let inFlight;
  const firstCall = new Promise(resolve => { inFlight = resolve; });
  const f = await fixture(t, { plans: ['claude'], generate: async (n, options) => {
    await options.beforeCall();
    if (n === 1) await new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); inFlight(); });
    return { questions: [q] };
  } });
  f.present();
  // Pick only once the first review call is running; picking earlier makes the
  // restarted review the first call, which this fake would then hold forever.
  await firstCall;
  assert.equal(f.interview.state.models.reviewing, true);
  const res = await pickModel(f, { provider: 'claude', model: 'haiku' });
  assert.deepEqual(await res.json(), { ok: true, restarting: true });
  // The restarted review can take a while when the whole suite is running.
  for (let i = 0; i < 1500 && f.interview.state.phase !== 'question'; i++) await delay(10);
  const state = await f.waitFor('question');
  assert.equal(f.generated(), 2);
  assert.deepEqual([state.route.provider, state.route.model], ['claude', 'haiku']);
  assert.ok(state.messages.some(item => /Restarting the review on the new model/.test(item.text)));
});

test('a model picked while background preparation holds the check is applied once it finishes, and the push goes on', async t => {
  // The worker writes questions, or decides a small change needs none; either way no review restarts.
  for (const outcome of [{ questions: [q] }, { questions: [], noQuestionReason: 'Only renames a local variable.' }]) {
    let release; const held = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { plans: ['claude'] });
    // Background preparation runs in another process; a second store takes the same lock file.
    const worker = createSessionStore({ env: f.env, generate: async (_s, _c, options) => { await options.beforeCall(); await held; return outcome; } });
    const preparing = worker.prepare(f.snapshot.id, f.config, { wait: true });
    for (let i = 0; i < 300 && (await f.store.read(f.snapshot.id)).preparation?.status !== 'running'; i++) await delay(10);
    const done = f.present();
    for (let i = 0; i < 300 && !f.interview.state.models?.reviewing; i++) await delay(10);
    assert.deepEqual(await (await pickModel(f, { provider: 'claude', model: 'sonnet' })).json(), { ok: true, restarting: true });
    release(); await preparing;
    const state = await f.waitFor(outcome.questions.length ? 'question' : 'consent');
    assert.deepEqual([state.route.provider, state.route.model], ['claude', 'sonnet']);
    assert.equal(f.generated(), 0, 'the worker\'s review is kept');
    assert.ok(!state.messages.some(item => /Restarting the review/.test(item.text)), 'no review restarts');
    if (outcome.questions.length) await f.post('answer', { questionId: state.question.id, response: 'Yes, because the insert is unconditional.' });
    await f.confirm();
    assert.equal((await done).status, 'passed');
  }
});

test('the page shows the question distance and saves a repository change only when the check ends', async t => {
  const f = await fixture(t);
  const done = f.present(); const state = await f.waitFor('question');
  assert.deepEqual(state.distance, { current: 'mixed', next: null, scope: 'machine' });
  const pick = distance => fetch(`${f.interview.url}/action?distance=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(f.interview.url).origin, 'X-Sphinx-Token': new URL(f.interview.url).pathname.slice(1) }, body: JSON.stringify({ distance }) });
  assert.equal((await pick('sideways')).status, 400);
  assert.equal((await pick('low')).status, 200);
  assert.equal(f.interview.state.distance.next, 'low');
  const { readFile } = await import('node:fs/promises');
  await assert.rejects(readFile(path.join(f.snapshot.repoRoot, '.sphinxconfig'), 'utf8'), { code: 'ENOENT' }, 'not written mid-check: it would invalidate this check');
  await f.post('answer', { questionId: state.question.id, response: 'Yes, because the insert is unconditional.' });
  await f.confirm();
  assert.equal((await done).status, 'passed');
  // Git re-checks the policy after the questionnaire returns; writing must wait for close().
  await assert.rejects(readFile(path.join(f.snapshot.repoRoot, '.sphinxconfig'), 'utf8'), { code: 'ENOENT' });
  await f.interview.close();
  assert.equal(JSON.parse(await readFile(path.join(f.snapshot.repoRoot, '.sphinxconfig'), 'utf8')).distance, 'low');
});

test('a push that may be a pull request offers posting the stamp there, and the Git hook gets the choice', async t => {
  const pr = await fixture(t, { snapshotOverrides: { target: { remote: 'origin', url: 'https://github.com/acme/widgets.git', ref: 'refs/heads/feature' } } });
  pr.present(); await pr.waitFor('question');
  assert.deepEqual(pr.interview.state.stamp, { post: false, action: false });
  const toggle = post => fetch(`${pr.interview.url}/action?stamp=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(pr.interview.url).origin, 'X-Sphinx-Token': new URL(pr.interview.url).pathname.slice(1) }, body: JSON.stringify({ post }) });
  assert.equal((await toggle('yes')).status, 409);
  assert.equal((await toggle(true)).status, 200);
  assert.equal(pr.interview.stampChoice(pr.snapshot.id), true);
  const main = await fixture(t);
  main.present(); await main.waitFor('question');
  assert.equal(main.interview.state.stamp, undefined, 'a push to main is not a pull request');
});

test('a paused push shows the exact command that resumes it', async t => {
  const f = await fixture(t, { snapshotOverrides: { sourceRef: 'refs/heads/master', target: { remote: 'origin', url: '/tmp/r.git', ref: 'refs/heads/master' } } });
  f.present(); await f.waitFor('question');
  await f.post('pause');
  const paused = await f.waitFor('paused');
  assert.equal(paused.resume, 'git push origin master');
});

test('questions ready raise one quiet macOS notification, with text passed as arguments', async t => {
  const sent = [];
  const f = await fixture(t, { interviewOptions: { notify: message => { sent.push(message); return true; } } });
  f.present(); const state = await f.waitFor('question');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Sphinx needs your answers');
  assert.match(sent[0].message, /→ main$/);
  await f.post('answer', { questionId: state.question.id, response: 'Yes, because the insert is unconditional.' });
  assert.equal(sent.length, 1, 'once per check');
  let call;
  const spawnImpl = (...args) => { call = args; return new EventEmitter(); };
  assert.equal(notifyDesktop({ title: 'T', message: 'repo"; do shell script "x', env: {}, platform: 'darwin', spawnImpl }), true);
  assert.equal(call[0], '/usr/bin/osascript');
  assert.deepEqual(call[1].slice(-2), ['T', 'repo"; do shell script "x'], 'text is data, never script');
  for (const options of [{ platform: 'linux', env: {} }, { platform: 'darwin', env: { SSH_TTY: '/dev/x' } }, { platform: 'darwin', env: { CI: '1' } }]) assert.equal(notifyDesktop({ title: 'T', message: 'M', ...options, spawnImpl: () => assert.fail('must not notify') }), false);
});

test('a follow-up whose ID matches a later question still lets that question appear', async t => {
  const second = { ...q, id: 'q2', prompt: 'Second question: what about a restart?' };
  const f = await fixture(t, { snapshotOverrides: { stats: { additions: 200, deletions: 40, files: 6 } },
    generate: async (_n, options) => { await options.beforeCall(); return { questions: [q, second] }; },
    grade: async (request, n) => n === 1
      ? { verdict: 'incorrect', feedback: 'Not quite.', followUp: { ...q, id: 'q2', prompt: 'Follow-up for question one: a different retry?' } }
      : { verdict: 'correct', feedback: '', followUp: null },
  });
  f.present();
  let state = await f.waitFor('question');
  await f.post('answer', { questionId: state.question.id, response: 'Wrong.' });
  for (let i = 0; i < 300 && !/Follow-up for question one/.test(f.interview.state.question?.prompt || ''); i++) await delay(10);
  state = f.interview.state;
  await f.post('answer', { questionId: state.question.id, response: 'Right.' });
  for (let i = 0; i < 300 && !/Second question/.test(f.interview.state.question?.prompt || ''); i++) await delay(10);
  const shown = f.interview.state.messages.filter(item => item.kind === 'question').map(item => item.text);
  assert.ok(shown.some(text => /Second question/.test(text)), `question 2 must be shown: ${JSON.stringify(shown)}`);
  assert.notEqual(f.interview.state.messages.filter(item => item.kind === 'question').at(-2).questionId, f.interview.state.question.id, 'the follow-up was renamed apart from question 2');
});

test('answers saved outside the page, as sphinx answer or a terminal check does, release the waiting Git operation', async t => {
  const f = await fixture(t, { interviewOptions: { watchMs: 20 } }), done = f.present(); await f.waitFor('question');
  // A separate store on the same state directory is what another sphinx process sees.
  const cli = createSessionStore({ env: f.env, grade: async request => { await request.beforeCall(); return { verdict: 'correct', feedback: 'Correct from the CLI.', followUp: null }; } });
  await cli.answer(f.snapshot.id, 'Yes, the retry repeats the insert.', f.config);
  await f.confirm();
  const result = await Promise.race([done, delay(3000).then(() => 'still waiting')]);
  assert.deepEqual(result, { status: 'passed', id: f.snapshot.id });
  assert.equal(f.interview.state.phase, 'passed'); assert.equal(f.graded(), 0);
  assert.ok(f.interview.state.messages.some(item => item.kind === 'feedback' && item.text === 'Correct from the CLI.'));
  assert.equal(await f.store.approved(f.snapshot, f.config), true);
});

test('a wrong answer saved outside the page moves the page to the transfer question', async t => {
  const f = await fixture(t, { interviewOptions: { watchMs: 20 } }), done = f.present(); await f.waitFor('question');
  const cli = createSessionStore({ env: f.env, grade: async request => { await request.beforeCall(); return { verdict: 'incorrect', feedback: 'Nothing deduplicates.', followUp: { ...q, id: 'transfer', prompt: 'What changes after restart?' } }; } });
  await cli.answer(f.snapshot.id, 'No.', f.config);
  for (let i = 0; i < 300 && f.interview.state.question?.id !== 'transfer'; i++) await delay(10);
  assert.equal(f.interview.state.question.id, 'transfer'); assert.equal(f.interview.state.phase, 'question');
  assert.equal((await f.post('answer', { response: 'The set is recreated.' })).status, 202);
  await f.confirm();
  assert.equal((await done).status, 'passed'); assert.equal(f.graded(), 1);
});

test('after a waiting pass, skip and pause are refused until continue or stop', async t => {
  const f = await fixture(t), done = f.present(); await f.waitFor('question');
  await f.post('answer', { response: 'Yes, the insert is repeated.' });
  const consent = await f.waitFor('consent');
  assert.deepEqual(consent.choices.map(choice => choice.value), ['proceed', 'stop']);
  assert.equal((await f.post('skip', { response: 'prod is down' })).status, 409);
  assert.equal((await f.post('pause')).status, 409);
  assert.equal((await f.post('answer', { response: 'late' })).status, 409);
  await f.confirm();
  assert.equal((await done).status, 'passed');
  assert.deepEqual(await f.receipt(), { passed: true, held: true, approved: false });
});

test('stopping after a waiting pass keeps the receipt and does not mark this Git operation complete', async t => {
  const f = await fixture(t), done = f.present(); await f.waitFor('question');
  await f.post('answer', { response: 'Yes, the insert is repeated.' });
  await f.confirm('stop');
  assert.equal((await done).status, 'stopped');
  assert.equal(f.interview.state.phase, 'stopped');
  assert.equal(f.interview.state.message, 'Push stopped. It did not go through. Your pass is saved, so the next push of this change asks only whether to continue. You can close this tab.');
  assert.equal(f.interview.state.resume, 'git push', 'the same command to push it later, as a pause shows');
  assert.deepEqual(await f.receipt(), { passed: true, held: true, approved: false });
  assert.equal((await checkpointTerminalStatus({ id: f.snapshot.id, env: f.env })).status, 'pending');
});

const noQuestions = async (_n, options) => { await options.beforeCall(); return { questions: [], noQuestionReason: 'Only renames a local variable; behavior is unchanged.' }; };

test('a pass that needed no questions still asks before the waiting push continues, with one quiet notification', async t => {
  const sent = [];
  const f = await fixture(t, { generate: noQuestions, interviewOptions: { notify: message => { sent.push(message); return true; } } });
  const done = f.present(), consent = await f.waitFor('consent');
  assert.equal(consent.message, 'No questions needed: Only renames a local variable; behavior is unchanged. Continue the push?');
  assert.deepEqual(consent.choices.map(choice => [choice.value, choice.label]), [['proceed', 'Continue push'], ['stop', 'Stop push']]);
  assert.deepEqual(sent.map(message => message.title), ['Sphinx: continue the push?'], 'nobody may be looking at the page yet');
  assert.deepEqual(await f.receipt(), { passed: true, held: true, approved: false }, 'the pass is already saved, held until the choice');
  assert.equal((await f.post('skip', { response: 'late' })).status, 409);
  assert.equal((await f.post('pause')).status, 409);
  await f.confirm();
  assert.deepEqual(await done, { status: 'passed', id: f.snapshot.id });
  assert.equal(f.interview.state.message, 'No questions needed: Only renames a local variable; behavior is unchanged. You can close this tab; Git is finishing the push on its own.');
  assert.equal(f.graded(), 0); assert.equal(sent.length, 1);
});

test('a no-questions decision from background preparation is no pass until the page opens, and the push still asks', async t => {
  const f = await fixture(t, { generate: noQuestions });
  assert.equal((await f.store.prepare(f.snapshot.id, f.config)).status, 'pending', 'preparation records the decision but approves nothing');
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
  const done = f.present(), consent = await f.waitFor('consent');
  assert.equal(consent.message, 'No questions needed: Only renames a local variable; behavior is unchanged. Continue the push?');
  assert.equal(f.generated(), 1, 'the prepared decision is reused without another review');
  await f.confirm('stop');
  assert.equal((await done).status, 'stopped');
  assert.deepEqual(await f.receipt(), { passed: true, held: true, approved: false });
});

test('a push to several destinations asks to continue once, after the last destination passes', async t => {
  const f = await fixture(t), second = { ...f.snapshot, id: 'b'.repeat(64), target: { ref: 'refs/heads/master' } };
  await f.store.ensure(second, f.config);
  const first = f.present({ ...f.request, more: true }); await f.waitFor('question');
  await f.post('answer', { response: 'Yes, the insert is repeated.' });
  assert.deepEqual(await first, { status: 'passed', id: f.snapshot.id }, 'no consent before the next destination');
  assert.equal(f.interview.state.message, 'You passed. This push has another destination to check next.\nThis records your answers, not a review of every changed line.');
  const last = f.present({ ...f.request, id: second.id, token: randomUUID() }); await f.waitFor('question');
  await f.post('answer', { response: 'Yes, the insert is repeated.' });
  await f.confirm();
  assert.deepEqual(await last, { status: 'passed', id: second.id });
  assert.equal(f.interview.state.message, 'You passed. You can close this tab; Git is finishing the push on its own.\nThis records your answers, not a review of every changed line.');
});

test('a pass made in another window while this page holds a waiting push still asks here before it goes through', async t => {
  const f = await fixture(t);
  const other = await claimCheckpointDialog({ request: { ...f.request, token: randomUUID() }, env: f.env, kind: 'browser' });
  assert.equal(other.status, 'claimed');
  const done = f.present(); await delay(100);
  await f.store.start(f.snapshot.id, f.config);
  await f.store.answer(f.snapshot.id, 'Yes, the insert is repeated.', f.config);
  await finishCheckpointDialog({ id: f.snapshot.id, token: other.token, status: 'passed', env: f.env });
  assert.equal((await f.waitFor('consent')).message, 'You passed. Continue the push?');
  await f.confirm('stop');
  assert.equal((await done).status, 'stopped');
});

test('with no Git operation waiting, a pass that needed no questions ends without asking', async t => {
  const f = await fixture(t, { generate: noQuestions }), { delivery, ...fallback } = f.request;
  assert.equal(delivery, 'hook');
  assert.deepEqual(await f.present(fallback), { status: 'passed', id: f.snapshot.id });
  assert.equal(f.interview.state.phase, 'passed');
  assert.equal(f.interview.state.message, 'No questions needed: Only renames a local variable; behavior is unchanged. You can close this tab.');
  assert.deepEqual(await f.receipt(), { passed: true, held: false, approved: true }, 'with no Git operation waiting, nothing holds the pass');
});

test('a pass answered with no Git operation waiting is a plain receipt, while one made for a waiting push is held at once', async t => {
  const fallback = await fixture(t), { delivery, ...request } = fallback.request, done = fallback.present(request); await fallback.waitFor('question');
  await fallback.post('answer', { response: 'Yes, the insert is repeated.' });
  assert.deepEqual(await done, { status: 'passed', id: fallback.snapshot.id });
  assert.deepEqual(await fallback.receipt(), { passed: true, held: false, approved: true });
  // Held as the grade saves it, before any choice: a second copy of the push started now cannot go through.
  const f = await fixture(t), waiting = f.present(); await f.waitFor('question');
  await f.post('answer', { response: 'Yes, the insert is repeated.' });
  assert.equal((await f.waitFor('consent')).message, 'You passed. Continue the push?', 'a pass made here is not called an earlier one');
  assert.deepEqual(await f.receipt(), { passed: true, held: true, approved: false });
  await f.confirm('stop'); assert.equal((await waiting).status, 'stopped');
});

test('a waiting commit is called a commit in its pause message, consent step, and stopped end state', async t => {
  const commit = { snapshotOverrides: { event: 'pre-commit' } };
  const paused = await fixture(t, commit);
  paused.present(); await paused.waitFor('question');
  const stopped = await (await paused.post('pause')).json();
  assert.match(stopped.message, /^Commit stopped\. It did not go through, and your progress is saved\. To continue, run the same commit again/);
  assert.equal(stopped.resume, 'git commit');
  const f = await fixture(t, commit), done = f.present(); await f.waitFor('question');
  await f.post('answer', { response: 'Yes, the insert is repeated.' });
  const consent = await f.waitFor('consent');
  assert.equal(consent.message, 'You passed. Continue the commit?');
  assert.deepEqual(consent.choices.map(choice => choice.label), ['Continue commit', 'Stop commit']);
  assert.deepEqual(consent.choices.map(choice => choice.description), ['Continue: the commit goes through.', 'Stop: it does not go through. Your pass is saved, so the next commit of this change asks only whether to continue.']);
  assert.match(await (await f.post('skip')).text(), /Choose continue or stop for this commit/);
  await f.confirm('stop');
  assert.equal((await done).status, 'stopped');
  assert.match(f.interview.state.message, /^Commit stopped\. It did not go through\. Your pass is saved, so the next commit of this change asks only whether to continue\. You can close this tab\./);
  assert.equal(f.interview.state.resume, 'git commit');
  const continued = await fixture(t, commit), finished = continued.present(); await continued.waitFor('question');
  await continued.post('answer', { response: 'Yes, the insert is repeated.' });
  await continued.confirm();
  assert.equal((await finished).status, 'passed');
  assert.match(continued.interview.state.message, /^You passed\. You can close this tab; Git is finishing the commit on its own\./);
});

test('a consent step cut short by Git never lets the operation through and says the pass is saved', async t => {
  const f = await fixture(t), done = f.present(); await f.waitFor('question');
  await f.post('answer', { response: 'Yes, the insert is repeated.' });
  await f.waitFor('consent');
  f.controller.abort(new Error('Git stopped waiting.'));
  assert.deepEqual(await done, { status: 'pending', id: f.snapshot.id });
  assert.equal(f.interview.state.phase, 'paused');
  assert.equal(f.interview.state.message, 'Git stopped waiting before you chose, so the push did not go through. Your pass is saved, so the next push of this change asks only whether to continue.', 'nobody chose Stop');
  assert.equal(f.interview.state.resume, 'git push');
  assert.deepEqual(await f.receipt(), { passed: true, held: true, approved: false });
  assert.equal((await checkpointTerminalStatus({ id: f.snapshot.id, env: f.env })).status, 'pending');
});

// What the Git gate leaves behind after Stop, or after Git stopped waiting at the consent step.
const heldPass = async f => {
  await f.store.start(f.snapshot.id, f.config); await f.store.answer(f.snapshot.id, 'Yes, the insert is repeated.', f.config);
  assert.equal(await f.store.hold(f.snapshot.id, f.config), true);
  return [f.generated(), f.graded()];
};

test('a held pass asks only Continue or Stop, with no question or model call, and says it passed earlier', async t => {
  const sent = [];
  const f = await fixture(t, { interviewOptions: { notify: message => { sent.push(message); return true; } } }), calls = await heldPass(f);
  const done = f.present(), consent = await f.waitFor('consent');
  assert.equal(consent.message, 'You passed this change earlier, but that push did not go through. Continue the push?');
  assert.deepEqual(consent.choices.map(choice => [choice.label, choice.description]), [['Continue push', 'Continue: the push goes through.'], ['Stop push', 'Stop: it does not go through. Your pass is saved, so the next push of this change asks only whether to continue.']]);
  assert.equal(consent.question, undefined);
  assert.deepEqual(consent.messages.filter(item => item.kind === 'question'), [], 'there is nothing to answer');
  assert.equal(consent.feedback, undefined, 'the earlier grade\'s feedback would read out of context');
  assert.deepEqual(sent.map(message => message.title), ['Sphinx: continue the push?'], 'nobody may be looking at the page yet');
  assert.equal((await f.post('skip', { response: 'late' })).status, 409);
  await f.confirm();
  assert.deepEqual(await done, { status: 'passed', id: f.snapshot.id });
  assert.deepEqual([f.generated(), f.graded()], calls, 'no review or grading call');
  assert.match(f.interview.state.message, /^You passed\. You can close this tab; Git is finishing the push on its own\./);
  assert.equal(await f.store.approved(f.snapshot, f.config), false, 'only the Git gate clears the hold, once it sees Continue');
});

test('a held commit says commit, and Stop ends it again with the pass still held', async t => {
  const f = await fixture(t, { snapshotOverrides: { event: 'pre-commit' } }), calls = await heldPass(f);
  const done = f.present(), consent = await f.waitFor('consent');
  assert.equal(consent.message, 'You passed this change earlier, but that commit did not go through. Continue the commit?');
  assert.deepEqual(consent.choices.map(choice => choice.label), ['Continue commit', 'Stop commit']);
  await f.confirm('stop');
  assert.deepEqual(await done, { status: 'stopped', id: f.snapshot.id });
  assert.equal(f.interview.state.message, 'Commit stopped. It did not go through. Your pass is saved, so the next commit of this change asks only whether to continue. You can close this tab.');
  assert.equal(f.interview.state.resume, 'git commit');
  assert.deepEqual([f.generated(), f.graded()], calls);
  assert.equal(await f.store.approved(f.snapshot, f.config), false);
});

test('a held pass that needed no questions says so instead of saying it passed', async t => {
  const f = await fixture(t, { generate: noQuestions });
  await f.store.start(f.snapshot.id, f.config); assert.equal(await f.store.hold(f.snapshot.id, f.config), true);
  const done = f.present(), consent = await f.waitFor('consent');
  assert.equal(consent.message, 'This change needed no questions earlier, but that push did not go through. Continue the push?');
  await f.confirm();
  assert.deepEqual(await done, { status: 'passed', id: f.snapshot.id });
  assert.match(f.interview.state.message, /^No questions needed: Only renames a local variable; behavior is unchanged\. You can close this tab; Git is finishing the push on its own\./);
  assert.equal(f.generated(), 1);
});

test('a held pass at an earlier destination of the push moves on without asking yet', async t => {
  const f = await fixture(t), calls = await heldPass(f);
  assert.deepEqual(await f.present({ ...f.request, more: true }), { status: 'passed', id: f.snapshot.id });
  assert.equal(f.interview.state.phase, 'passed');
  assert.match(f.interview.state.message, /^You passed\. This push has another destination to check next\./);
  assert.deepEqual([f.generated(), f.graded()], calls);
});
