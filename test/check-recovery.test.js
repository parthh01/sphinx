import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareInteractiveCheck } from '../src/check-recovery.js';
import { createSessionStore } from '../src/sessions.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createPrompts } from '../src/prompts.js';

const snapshot = { id: 'b'.repeat(64), repoRoot: '/test/repo', event: 'pre-push', target: { ref: 'refs/heads/main' }, files: ['app.js'], stats: { additions: 5, deletions: 1, files: 1 } };
const question = { id: 'duplicate', concept: 'idempotency', prompt: 'Can a retry duplicate the insert? Why?', choices: [], expectedAnswer: 'Yes, every request inserts.', rationale: 'There is no deduplication.', evidence: [{ path: 'app.js', reason: 'Unconditional insertion.' }] };
const failure = (message = 'The reviewer did not retain changed-code evidence.', code = 'INSUFFICIENT_EVIDENCE') => Object.assign(new Error(message), { code });

async function fixture(t, { maxModelCalls = 10, generate, validate = async () => {}, change = snapshot } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'sphinx-check-recovery-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = { ...structuredClone(DEFAULT_CONFIG), maxModelCalls };
  let attempts = 0, authorizations = 0;
  const env = { SPHINX_HOME: home };
  const store = createSessionStore({ env, validate,
    generate: async (_snapshot, _config, options) => {
      attempts++;
      if (generate) return generate(attempts, options);
      await options.beforeCall();
      if (attempts === 1) throw failure();
      return { questions: [question] };
    },
  });
  await store.ensure(change, config);
  const messages = [], prompts = [];
  const ui = Object.fromEntries(['warning', 'note', 'command', 'section', 'paragraph', 'blank', 'rows'].map(name => [name, value => messages.push(value)]));
  const run = (choose, extra = {}) => prepareInteractiveCheck({
    start: () => store.start(change.id, config),
    inspect: async () => store.public(await store.read(change.id)),
    authorizeMore: async () => { authorizations++; return store.retryReview(change.id, config); },
    validate: () => validate(change, config), config, ui,
    choose: async prompt => { prompts.push(prompt); return choose(prompt); }, ...extra,
  });
  return { env, config, store, run, ui, messages, prompts, attempts: () => attempts, authorizations: () => authorizations };
}

test('failed review waits for an explicit retry and keeps the same allowance and route', async t => {
  const f = await fixture(t);
  let respond, shown;
  const displayed = new Promise(resolve => { shown = resolve; });
  const pending = f.run(prompt => { shown(prompt); return new Promise(resolve => { respond = resolve; }); }, { waitingGit: true });
  const prompt = await displayed;
  assert.equal(f.attempts(), 1);
  assert.equal(f.authorizations(), 0);
  assert.equal(prompt.current, 'pause');
  assert.match(prompt.description, /original Git operation is waiting/);
  assert.deepEqual(prompt.choices.map(choice => choice.value), ['retry', 'pause']);
  assert.match(prompt.choices[0].description, /9 calls remain/);
  assert.equal(await f.store.approved(snapshot, f.config), false);
  respond('retry');
  const state = await pending;
  assert.equal(state.status, 'active');
  assert.deepEqual(state.usage, { calls: 2, limit: 10 });
  assert.equal(f.authorizations(), 0);
  assert.equal(state.route.model, 'openrouter/free');
  assert.equal(await f.store.approved(snapshot, f.config), false, 'preparing questions never approves the waiting Git operation');
});

test('Enter defaults to pause, preserving failed usage without any new requests', async t => {
  const f = await fixture(t);
  const prompts = createPrompts({ ask: async () => '', ui: f.ui });
  assert.equal(await f.run(prompts.choose), null);
  const record = await f.store.read(snapshot.id);
  assert.equal(record.calls, 1);
  assert.equal(record.status, 'pending');
  assert.equal(record.preparation.status, 'failed');
  assert.equal(record.reviewRetries, undefined);
  assert.equal(f.attempts(), 1);
  assert.equal(f.authorizations(), 0);
});

test('insufficient remaining calls require a separate explicit allowance and retain usage', async t => {
  const f = await fixture(t, { maxModelCalls: 3 });
  const state = await f.run(prompt => {
    assert.deepEqual(prompt.choices.map(choice => choice.value), ['extend', 'pause']);
    assert.match(prompt.choices[0].description, /Keep all 1 used calls counted/);
    assert.equal(f.authorizations(), 0);
    return 'extend';
  });
  assert.deepEqual(state.usage, { calls: 2, limit: 4 });
  assert.equal(f.authorizations(), 1);
  const record = await f.store.read(snapshot.id);
  assert.deepEqual(record.reviewRetries.map(({ calls, previousLimit, limit }) => ({ calls, previousLimit, limit })), [{ calls: 1, previousLimit: 3, limit: 4 }]);
  assert.equal(record.status, 'active');
  assert.equal(await f.store.approved(snapshot, f.config), false);
  assert.ok(f.messages.some(message => /Authorized up to 3 additional/.test(message)));
  assert.ok(!f.messages.some(message => /--retry-review/.test(message)), 'the menu replaces Sphinx’s appended manual command hint');
});

test('an already exhausted review can explicitly recover without charging another failed preflight', async t => {
  const f = await fixture(t, { maxModelCalls: 3 });
  await assert.rejects(f.store.start(snapshot.id, f.config), /changed-code evidence/);
  const state = await f.run(() => 'extend');
  assert.deepEqual(state.usage, { calls: 2, limit: 4 });
  assert.equal(f.attempts(), 2);
  assert.equal(f.authorizations(), 1);
});

test('only a saved pending audit offers a retry with one investigation call remaining', async t => {
  for (const pendingAudit of [false, true]) {
    const f = await fixture(t, { maxModelCalls: 4, generate: async (attempt, options) => {
      if (attempt > 1) { await options.beforeCall(); return { questions: [question] }; }
      await options.beforeCall(); await options.beforeCall();
      await options.reviewerCheckpoint.save({ version: 1, snapshotId: snapshot.id, archive: [], entries: [], calls: 2, compactions: 0,
        ...(pendingAudit ? { pendingAssessment: { assessment: { questions: [question] }, summary: 'The insert is unconditional.' } } : {}),
      });
      throw failure('Provider interrupted the investigation.');
    } });
    const result = await f.run(prompt => {
      assert.deepEqual(prompt.choices.map(choice => choice.value), [pendingAudit ? 'retry' : 'extend', 'pause']);
      return pendingAudit ? 'retry' : 'pause';
    });
    assert.equal(f.attempts(), pendingAudit ? 2 : 1);
    assert.equal(f.authorizations(), 0);
    assert.equal((await f.store.read(snapshot.id)).calls, pendingAudit ? 3 : 2);
    assert.equal(result?.status ?? null, pendingAudit ? 'active' : null);
    assert.equal(await f.store.approved(snapshot, f.config), false);
  }
});

test('a medium review with 7 of 10 calls used reserves both grading calls before offering recovery', async t => {
  const f = await fixture(t, {
    change: { ...snapshot, stats: { additions: 200, deletions: 19, files: 7 } },
    generate: async (attempt, options) => {
      for (let i = 0; i < (attempt === 1 ? 7 : 1); i++) await options.beforeCall();
      if (attempt === 1) throw failure();
      return { questions: [question] };
    },
  });
  const state = await f.run(prompt => {
    assert.deepEqual(prompt.choices.map(choice => choice.value), ['extend', 'pause']);
    assert.match(prompt.choices[0].description, /3 calls remain; review needs at least 2 plus 2 reserved for grading/);
    return 'extend';
  });
  assert.equal(state.route.tier, 'medium');
  assert.deepEqual(state.usage, { calls: 8, limit: 17 });
  assert.equal(f.authorizations(), 1);
});

test('another failure asks the human again rather than automatically retrying or extending', async t => {
  const f = await fixture(t, { generate: async (_attempt, options) => { await options.beforeCall(); throw failure(); } });
  let choices = 0;
  assert.equal(await f.run(() => ++choices === 1 ? 'retry' : 'pause'), null);
  assert.equal(choices, 2);
  assert.equal(f.attempts(), 2);
  assert.equal(f.authorizations(), 0);
  assert.deepEqual(f.store.public(await f.store.read(snapshot.id)).usage, { calls: 2, limit: 10 });
});

test('a failed initial diff read without a model request does not offer a spending retry', async t => {
  const f = await fixture(t, { generate: async () => { throw failure('No usable initial diff. No model request was made.'); } });
  assert.equal(await f.run(prompt => {
    assert.deepEqual(prompt.choices.map(choice => choice.value), ['pause']);
    return 'pause';
  }), null);
  assert.equal((await f.store.read(snapshot.id)).calls, 0);
  assert.equal(f.attempts(), 1);
});

test('known auth, setup, and context failures do not suggest spending or adding calls', async t => {
  for (const error of [
    Object.assign(failure('API key was rejected.', 'OPENROUTER_PROVIDER_ERROR'), { status: 401, errorType: 'authentication' }),
    failure('Configured context cannot hold the evidence.', 'CONTEXT_LIMIT'),
    failure('CLI sign-in or access needs repair.', 'PROVIDER_FAILED'),
  ]) {
    await t.test(error.code, async t => {
      const f = await fixture(t, { maxModelCalls: 3, generate: async (_attempt, options) => { await options.beforeCall(); throw error; } });
      assert.equal(await f.run(prompt => {
        assert.deepEqual(prompt.choices.map(choice => choice.value), ['pause']);
        return 'pause';
      }), null);
      assert.equal(f.attempts(), 1);
      assert.equal(f.authorizations(), 0);
    });
  }
});

test('stale content or policy stops before recovery choices or more model calls', async t => {
  let stale = false;
  const f = await fixture(t, { validate: async () => { if (stale) throw failure('Snapshot changed.', 'STALE_SNAPSHOT'); },
    generate: async (_attempt, options) => { await options.beforeCall(); stale = true; throw failure(); },
  });
  await assert.rejects(f.run(() => assert.fail('stale checkpoint offered a choice')), /Snapshot changed/);
  assert.equal(f.attempts(), 1);
  assert.equal(f.authorizations(), 0);
});

test('cancelling the recovery prompt exits with saved usage and no authorization', async t => {
  const f = await fixture(t);
  const cancelled = Object.assign(new Error('Cancelled'), { code: 'SPHINX_CANCELLED', exitCode: 130 });
  await assert.rejects(f.run(() => { throw cancelled; }), error => error === cancelled);
  assert.equal((await f.store.read(snapshot.id)).calls, 1);
  assert.equal(f.attempts(), 1);
  assert.equal(f.authorizations(), 0);
});

test('an aborted signal cannot authorize a choice or accept a late successful preparation', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(f.run(() => { controller.abort(new Error('Cancelled during choice')); return 'retry'; }, { signal: controller.signal }), /Cancelled during choice/);
  assert.equal(f.attempts(), 1);
  assert.equal(f.authorizations(), 0);
  const late = new AbortController();
  await assert.rejects(f.run(() => assert.fail('cancelled preparation showed a menu'), {
    signal: late.signal,
    start: async () => { late.abort(new Error('Cancelled during review')); return { status: 'active' }; },
  }), /Cancelled during review/);
});

test('a changed snapshot after human authorization still fails store validation before a retry', async t => {
  let stale = false;
  const f = await fixture(t, { maxModelCalls: 3, validate: async () => { if (stale) throw failure('Snapshot changed.', 'STALE_SNAPSHOT'); } });
  await assert.rejects(f.run(() => { stale = true; return 'extend'; }), /Snapshot changed/);
  assert.equal(f.attempts(), 1);
  assert.equal((await f.store.read(snapshot.id)).reviewRetries, undefined);
});

test('errors while loading an active questionnaire are not treated as failed reviews', async t => {
  const f = await fixture(t, { generate: async (_attempt, options) => { await options.beforeCall(); return { questions: [question] }; } });
  await f.store.start(snapshot.id, f.config);
  await assert.rejects(f.run(() => assert.fail('active questionnaire offered recovery'), { start: async () => { throw new Error('Unable to load'); } }), /Unable to load/);
  assert.equal(f.authorizations(), 0);
});

const rateLimit = () => Object.assign(new Error('OpenRouter HTTP 429 (code: 429; error_type: rate_limit_exceeded).'), { code: 'OPENROUTER_PROVIDER_ERROR', status: 429, errorType: 'rate_limit_exceeded' });

test('an OpenRouter rate limit offers the installed coding-agent plans, and switching moves only this check', async t => {
  const providers = [];
  const f = await fixture(t, { generate: async (attempt, options) => {
    await options.beforeCall();
    if (attempt === 1) throw rateLimit();
    return { questions: [question] };
  } });
  const seen = [];
  const store = f.store;
  const original = store.start;
  store.start = async (...args) => { seen.push((await store.read(snapshot.id)).route.provider); return original(...args); };
  const result = await f.run(prompt => prompt.choices[0].value, {
    planProviders: ['claude', 'codex'],
    switchRoute: async provider => { providers.push(provider); return store.switchRoute(snapshot.id, f.config, provider); },
    start: () => store.start(snapshot.id, f.config),
  });
  assert.deepEqual(f.prompts[0].choices.map(choice => choice.value).slice(0, 2), ['switch-claude', 'switch-codex']);
  assert.match(f.prompts[0].choices[0].description, /signed-in Claude plan instead of OpenRouter/);
  assert.deepEqual(providers, ['claude']);
  assert.deepEqual(seen, ['openrouter', 'claude']);
  assert.equal(result.status, 'active');
  const saved = await store.read(snapshot.id);
  assert.deepEqual([saved.route.provider, saved.route.model], ['claude', 'haiku']);
  assert.equal(saved.routeChanges.length, 1);
  assert.equal(saved.routeChanges[0].from.provider, 'openrouter');
  assert.equal(f.config.models.small.provider, 'openrouter', 'Saved routes are untouched');
});

test('a plan switch, wired as the terminal check wires it, stops background preparation reviewing the check and reviews on the plan', async t => {
  const f = await fixture(t, { generate: async (attempt, options) => { await options.beforeCall(); if (attempt === 1) throw rateLimit(); return { questions: [question] }; } });
  // Background preparation, in another process, takes the check once the first review fails.
  let reviewing; const started = new Promise(resolve => { reviewing = resolve; });
  const worker = createSessionStore({ env: f.env, generate: async (_s, _c, options) => {
    await options.beforeCall(); reviewing();
    return new Promise((_, reject) => { options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }); setTimeout(reject, 10000, new Error('Never stopped.')).unref(); });
  } });
  let stopped, waited;
  const result = await f.run(async () => { stopped = worker.prepare(snapshot.id, f.config, { wait: true, stoppable: true }).then(() => null, error => error.code); await started; return 'switch-claude'; }, {
    planProviders: ['claude'],
    switchRoute: async provider => { const at = Date.now(); await f.store.switchRoute(snapshot.id, f.config, provider); waited = Date.now() - at; },
  });
  assert.ok(waited < 1500, `the switch waited ${waited} ms`);
  assert.equal(await stopped, 'SPHINX_SWITCHED');
  assert.deepEqual([result.status, result.route.provider, f.attempts()], ['active', 'claude', 2]);
});

test('no switch is offered for other failures, without installed plans, or when already on a plan', async t => {
  for (const [error, plans] of [[failure(), ['claude']], [rateLimit(), []]]) {
    const f = await fixture(t, { generate: async (attempt, options) => { await options.beforeCall(); if (attempt === 1) throw error; return { questions: [question] }; } });
    await f.run(() => 'pause', { planProviders: plans, switchRoute: async () => assert.fail('No switch expected') });
    assert.ok(f.prompts[0].choices.every(choice => !choice.value.startsWith('switch-')));
  }
});

test('switching a check drops unanswered investigation but keeps questions, usage, and progress', async t => {
  const f = await fixture(t, { generate: async (_attempt, options) => { await options.beforeCall(); return { questions: [question] }; } });
  await f.store.start(snapshot.id, f.config);
  const before = await f.store.read(snapshot.id);
  const switched = await f.store.switchRoute(snapshot.id, f.config, 'codex');
  assert.equal(switched.route.provider, 'codex');
  const after = await f.store.read(snapshot.id);
  assert.equal(after.calls, before.calls);
  assert.deepEqual(after.questions, before.questions, 'Questions survive a mid-grading switch');
  await assert.rejects(f.store.switchRoute(snapshot.id, f.config, 'openrouter'), /Only Claude Code or Codex/);
});

test('a coding-agent CLI failure names the CLI and offers the other installed plan', async t => {
  const cliFailure = Object.assign(new Error('Codex reported: something broke.'), { code: 'PROVIDER_FAILED' });
  const f = await fixture(t, { generate: async (attempt, options) => { await options.beforeCall(); if (attempt === 1) throw cliFailure; return { questions: [question] }; } });
  await f.store.switchRoute(snapshot.id, f.config, 'codex');
  await f.run(prompt => prompt.choices[0].value, { planProviders: ['claude', 'codex'], switchRoute: provider => f.store.switchRoute(snapshot.id, f.config, provider), start: () => f.store.start(snapshot.id, f.config) });
  assert.equal(f.prompts[0].title, 'Codex could not run this review');
  assert.deepEqual(f.prompts[0].choices.filter(choice => choice.value.startsWith('switch-')).map(choice => choice.value), ['switch-claude'], 'Never offers the CLI that just failed');
  assert.equal((await f.store.read(snapshot.id)).route.provider, 'claude');
});
