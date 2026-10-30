import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, getPaths, stableStringify, writeJson } from '../src/config.js';
import { createSessionStore, sessionFile } from '../src/sessions.js';

const question = {
  id: 'retry-safety', concept: 'idempotency',
  prompt: 'Can retrying this operation produce a duplicate? Explain the cause.',
  choices: ['Yes', 'No'], expectedAnswer: 'Yes, each request inserts again.',
  rationale: 'There is no deduplication before insertion.',
  evidence: [{ path: 'order.js', reason: 'Each request inserts an order.' }],
};
const snapshot = {
  id: 'b'.repeat(64), repoRoot: '/fixture/repo', repoId: 'fixture',
  event: 'pre-push', target: { ref: 'refs/heads/main' },
  files: ['order.js'], evidence: 'insertOrder()', stats: { additions: 10, deletions: 1, files: 1 },
};
const review = { summary: 'Fixture evidence retained for grading.', evidence: [{ id: 'e1', text: 'insertOrder()' }], toolCalls: 1, compactions: 0 };

async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'sphinx-session-budget-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { SPHINX_HOME: home };
  const config = { ...structuredClone(DEFAULT_CONFIG), maxModelCalls: 10 };
  const invoked = { generate: 0, grade: 0 };
  const store = createSessionStore({
    env,
    generate: async (change, settings, request) => {
      invoked.generate++;
      if (options.generate) return options.generate(change, settings, request);
      await request.beforeCall();
      return { questions: [structuredClone(question)], review: structuredClone(review) };
    },
    grade: async request => {
      invoked.grade++;
      await request.beforeCall();
      return { verdict: 'correct', feedback: 'Correct.', followUp: null };
    },
  });
  const setGlobal = value => writeJson(getPaths(env).config, value);
  await setGlobal({ maxModelCalls: 10 });
  async function seed(patch = {}, change = snapshot) {
    const session = await store.ensure(change, config);
    Object.assign(session, {
      calls: 7, preparation: { status: 'failed', completedAt: '2026-01-01T00:00:00.000Z' },
    }, structuredClone(patch));
    await writeJson(sessionFile(change.id, env), session);
    return structuredClone(session);
  }
  return { store, env, config, invoked, seed, setGlobal };
}

test('a new assessment contract rejects old questions and receipts without erasing usage', async t => {
  for (const status of ['active', 'passed']) {
    const f = await fixture(t);
    const oldPolicy = createHash('sha256').update(stableStringify(f.config)).digest('hex');
    const before = await f.seed({ policy: oldPolicy, status, questions: [question], review,
      index: status === 'passed' ? 1 : 0, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    await f.setGlobal({ maxModelCalls: 20 });
    const current = { ...f.config, maxModelCalls: 20 };
    assert.equal(await f.store.approved(snapshot, current), false);
    await assert.rejects(f.store.refreshBudget(snapshot.id, current), /settings changed/);
    await assert.rejects(f.store.start(snapshot.id, current), /settings changed/);
    assert.deepEqual(await f.store.read(snapshot.id), before);
    assert.deepEqual(f.invoked, { generate: 0, grade: 0 });
  }
});

test('a global ceiling edit adopts 7/20 without a top-up, new checkpoint, or inference', async t => {
  const f = await fixture(t);
  const before = await f.seed();
  await f.setGlobal({ maxModelCalls: 20 });
  // The still-open CLI deliberately passes its old ten-call configuration.
  const state = await f.store.refreshBudget(snapshot.id, f.config);
  assert.deepEqual(state.usage, { calls: 7, limit: 20 });
  assert.equal(state.id, before.id);
  assert.equal(state.status, 'pending');
  assert.deepEqual(f.invoked, { generate: 0, grade: 0 });
  const after = await f.store.read(snapshot.id);
  assert.equal(after.createdAt, before.createdAt);
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.equal(after.policy, before.policy);
  assert.deepEqual(after.preparation, before.preparation);
  assert.equal(after.reviewRetries, undefined);
  assert.deepEqual(after.budgetChanges.map(({ calls, previousConfiguredLimit, configuredLimit, previousLimit, limit }) => ({ calls, previousConfiguredLimit, configuredLimit, previousLimit, limit })), [
    { calls: 7, previousConfiguredLimit: 10, configuredLimit: 20, previousLimit: 10, limit: 20 },
  ]);
  await f.store.refreshBudget(snapshot.id, f.config);
  assert.equal((await f.store.read(snapshot.id)).budgetChanges.length, 1, 'Refreshing must not repeatedly add allowance');
});

test('resuming a failed review uses the new ceiling while retaining every previous call', async t => {
  const f = await fixture(t);
  await f.seed();
  await f.setGlobal({ maxModelCalls: 20 });
  const state = await f.store.start(snapshot.id, f.config);
  assert.deepEqual(state.usage, { calls: 8, limit: 20 });
  assert.equal(state.status, 'active');
  assert.equal(f.invoked.generate, 1);
  const after = await f.store.read(snapshot.id);
  assert.deepEqual(after.review, review);
  assert.equal(after.reviewRetries, undefined);
  const completed = await f.store.answer(snapshot.id, 'Yes, every request inserts again.', f.config);
  assert.deepEqual(completed.usage, { calls: 9, limit: 20 });
  assert.equal(completed.status, 'passed');
});

test('active questions, completed progress, attempts, and exact review survive a ceiling edit', async t => {
  const f = await fixture(t);
  const change = { ...snapshot, stats: { additions: 100, deletions: 0, files: 1 } };
  const before = await f.seed({
    status: 'active', index: 1, questions: [{ ...question, id: 'completed' }, question],
    attempts: [{ questionId: 'completed', verdict: 'correct', answer: 'Fixture answer.' }],
    review, preparation: { status: 'ready', completedAt: '2026-01-01T00:00:00.000Z' },
  }, change);
  await f.setGlobal({ maxModelCalls: 20 });
  const state = await f.store.start(change.id, f.config);
  assert.deepEqual(state.progress, { completed: 1, total: 2 });
  assert.deepEqual(state.usage, { calls: 7, limit: 20 });
  const after = await f.store.read(change.id);
  for (const key of ['questions', 'attempts', 'review', 'preparation', 'index', 'route']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(f.invoked, { generate: 0, grade: 0 });
  const completed = await f.store.answer(change.id, 'Yes, the insert repeats.', f.config, { expectedQuestionId: question.id });
  assert.equal(completed.status, 'passed');
  assert.deepEqual(completed.usage, { calls: 8, limit: 20 });
});

test('a passed receipt remains valid with its original expiration and retained evidence', async t => {
  const f = await fixture(t);
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const before = await f.seed({ status: 'passed', index: 1, questions: [question], review, expiresAt });
  const current = { ...f.config, maxModelCalls: 20 };
  await f.setGlobal({ maxModelCalls: 20 });
  assert.equal(await f.store.approved(snapshot, current), true);
  const state = await f.store.start(snapshot.id, current);
  assert.equal(state.status, 'passed');
  assert.equal(state.expiresAt, expiresAt);
  assert.deepEqual(state.usage, { calls: 7, limit: 20 });
  const after = await f.store.read(snapshot.id);
  for (const key of ['questions', 'review', 'index', 'expiresAt', 'createdAt', 'policy']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(f.invoked, { generate: 0, grade: 0 });
});

test('a prior explicit limit of 19 becomes an absolute 20, preserving retry history', async t => {
  const f = await fixture(t);
  const reviewRetries = [{ at: '2026-01-01T00:00:00.000Z', calls: 9, previousLimit: 10, limit: 19 }];
  await f.seed({ calls: 12, callLimit: 19, reviewRetries });
  assert.deepEqual((await f.store.refreshBudget(snapshot.id, f.config)).usage, { calls: 12, limit: 19 }, 'An unchanged configured ceiling preserves an already authorized allowance');
  await f.setGlobal({ maxModelCalls: 20 });
  const state = await f.store.refreshBudget(snapshot.id, f.config);
  assert.deepEqual(state.usage, { calls: 12, limit: 20 });
  assert.deepEqual((await f.store.read(snapshot.id)).reviewRetries, reviewRetries);
  assert.equal((await f.store.read(snapshot.id)).budgetChanges[0].previousLimit, 19);
  assert.deepEqual(f.invoked, { generate: 0, grade: 0 });
});

test('an explicit retry from an old ten-call menu cannot lower a newly adopted twenty-call ceiling', async t => {
  const f = await fixture(t);
  await f.seed();
  await f.setGlobal({ maxModelCalls: 20 });
  const state = await f.store.retryReview(snapshot.id, f.config);
  assert.deepEqual(state.usage, { calls: 7, limit: 20 });
  assert.deepEqual(f.invoked, { generate: 0, grade: 0 });
  const after = await f.store.read(snapshot.id);
  assert.equal(after.config.maxModelCalls, 20);
  assert.deepEqual(after.reviewRetries.map(({ calls, previousLimit, limit }) => ({ calls, previousLimit, limit })), [
    { calls: 7, previousLimit: 20, limit: 20 },
  ]);
  assert.deepEqual((await f.store.refreshBudget(snapshot.id, f.config)).usage, { calls: 7, limit: 20 });
  assert.deepEqual((await f.store.start(snapshot.id, f.config)).usage, { calls: 8, limit: 20 });
});

test('lowering a ceiling below used calls blocks generation and grading without erasing usage', async t => {
  for (const active of [false, true]) {
    const f = await fixture(t);
    await f.seed(active ? { status: 'active', questions: [question], review } : {});
    await f.setGlobal({ maxModelCalls: 5 });
    await assert.rejects(active
      ? f.store.answer(snapshot.id, 'Yes, insertion repeats.', f.config)
      : f.store.start(snapshot.id, f.config), /call limit \(5\)/);
    assert.deepEqual(f.store.public(await f.store.read(snapshot.id)).usage, { calls: 7, limit: 5 });
    assert.deepEqual(f.invoked, { generate: 0, grade: 0 });
    assert.equal(await f.store.approved(snapshot, f.config), false);
  }
});

test('a global ceiling lowered during review prevents the next charged request', async t => {
  let f, requests = 0;
  f = await fixture(t, { generate: async (_snapshot, _config, { beforeCall }) => {
    await beforeCall(); requests++;
    await f.setGlobal({ maxModelCalls: 8 });
    await beforeCall(); requests++;
    assert.fail('The second provider request must never begin');
  } });
  await f.seed();
  await f.setGlobal({ maxModelCalls: 20 });
  await assert.rejects(f.store.start(snapshot.id, f.config), /call limit \(8\)/);
  assert.equal(requests, 1);
  const after = await f.store.read(snapshot.id);
  assert.deepEqual(f.store.public(after).usage, { calls: 8, limit: 8 });
  assert.equal(after.preparation.status, 'failed');
  assert.equal(after.questions.length, 0);
  assert.equal(after.reviewRetries, undefined);
  assert.equal(await f.store.approved(snapshot, f.config), false);
});

test('lowering the ceiling during review preserves the final call reserved for grading', async t => {
  let f, requests = 0;
  f = await fixture(t, { generate: async (_snapshot, _config, { beforeCall }) => {
    await beforeCall(); requests++;
    await f.setGlobal({ maxModelCalls: 2 });
    await beforeCall(); requests++;
    assert.fail('Investigation must not consume the reserved grading call');
  } });
  await f.seed({ calls: 0 });
  await f.setGlobal({ maxModelCalls: 20 });
  await assert.rejects(f.store.start(snapshot.id, f.config), /call limit \(2\).*reserving 1 for grading/);
  assert.equal(requests, 1);
  const after = await f.store.read(snapshot.id);
  assert.deepEqual(f.store.public(after).usage, { calls: 1, limit: 2 });
  assert.equal(after.preparation.status, 'failed');
  assert.equal(after.questions.length, 0);
  assert.equal(after.reviewRetries, undefined);
  assert.equal(await f.store.approved(snapshot, f.config), false);
});

test('other assessment or privacy changes still invalidate the legacy checkpoint; reviewer and spending changes keep it', async t => {
  const f = await fixture(t);
  const before = await f.seed();
  await f.setGlobal({ maxModelCalls: 20 });
  for (const patch of [{ level: 'thorough' }, { exclude: ['private/**'] }]) {
    const changed = { ...f.config, maxModelCalls: 20, ...patch };
    await assert.rejects(f.store.refreshBudget(snapshot.id, changed), /settings changed/);
    await assert.rejects(f.store.start(snapshot.id, changed), /settings changed/);
    assert.deepEqual(await f.store.read(snapshot.id), before);
    assert.equal(await f.store.approved(snapshot, changed), false);
  }
  // A reviewer route or spending change is not an assessment change.
  for (const patch of [{ model: 'another-model' }, { allowPaid: true }]) {
    assert.equal((await f.store.refreshBudget(snapshot.id, { ...f.config, maxModelCalls: 20, ...patch })).id, before.id);
  }
  assert.deepEqual(f.invoked, { generate: 0, grade: 0 });
});

test('a global file without an explicit ceiling adopts the uncapped default for an already open CLI', async t => {
  const f = await fixture(t);
  await f.seed();
  await f.setGlobal({});
  assert.deepEqual((await f.store.refreshBudget(snapshot.id, f.config)).usage, { calls: 7, limit: null });
  assert.equal((await f.store.read(snapshot.id)).config.maxModelCalls, null);
});

test('a null config file or invalid ceiling is rejected, while a missing file uses the passed configuration', async t => {
  const f = await fixture(t);
  const before = await f.seed();
  for (const [value, expected] of [[null, /configuration must be a JSON object/], [{ maxModelCalls: 0 }, /maxModelCalls must be null \(unlimited\) or an integer/]]) {
    await f.setGlobal(value);
    await assert.rejects(f.store.refreshBudget(snapshot.id, f.config), expected);
    await assert.rejects(f.store.start(snapshot.id, f.config), expected);
    assert.deepEqual(await f.store.read(snapshot.id), before);
  }
  await rm(getPaths(f.env).config);
  assert.deepEqual((await f.store.refreshBudget(snapshot.id, f.config)).usage, { calls: 7, limit: 10 });
  assert.deepEqual(await f.store.read(snapshot.id), before);
  assert.deepEqual(f.invoked, { generate: 0, grade: 0 });
});

test('budget adoption shares the assessment lock with in-flight preparation', async t => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { generate: async (_snapshot, _config, { beforeCall }) => {
    await beforeCall(); entered(); await waiting;
    return { questions: [structuredClone(question)], review: structuredClone(review) };
  } });
  await f.seed();
  await f.setGlobal({ maxModelCalls: 20 });
  const preparing = f.store.start(snapshot.id, f.config);
  await ready;
  try {
    await assert.rejects(f.store.refreshBudget(snapshot.id, f.config), /already running/);
  } finally { release(); }
  assert.deepEqual((await preparing).usage, { calls: 8, limit: 20 });
  assert.deepEqual((await f.store.refreshBudget(snapshot.id, f.config)).usage, { calls: 8, limit: 20 });
  assert.equal((await f.store.read(snapshot.id)).budgetChanges.length, 1);
});
