import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  INTERVALS, MAX_CARDS, cardId, capturePassedCheck, deckFile, deckSummary, dueCards, nextInterval, publicCard, readDeck, reviewCard,
} from '../src/deck.js';
import { collectGarbage } from '../src/storage.js';
import { createSessionStore } from '../src/sessions.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { withFileLock } from '../src/lock.js';

const q = {
  id: 'retry', concept: 'idempotency',
  prompt: 'Can a repeated request duplicate the operation? Give the cause.',
  choices: [], expectedAnswer: 'Yes: no deduplication.', rationale: 'The insert happens on every call.',
};
const snapshot = { id: 'a'.repeat(64), repoRoot: '/work/billing', event: 'pre-push', target: { ref: 'refs/heads/main' }, files: ['src/order.js'], stats: { additions: 10, deletions: 1, files: 1 } };

async function home(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sphinx-deck-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { SPHINX_HOME: dir };
}

function passedSession(overrides = {}) {
  return {
    status: 'passed', questions: [q], index: 1, attempts: [
      { questionId: q.id, index: 0, kind: 'answer', prompt: q.prompt, answer: 'It inserts every time.', verdict: 'correct', feedback: 'Correct.', at: '2026-10-23T00:00:00.000Z' },
    ], snapshot, ...overrides,
  };
}

test('intervals grow on good and reset on again', () => {
  assert.deepEqual(INTERVALS, [1, 3, 7, 14, 30]);
  assert.equal(nextInterval(1, 'again'), 1);
  assert.equal(nextInterval(1, 'good'), 3);
  assert.equal(nextInterval(14, 'good'), 30);
  assert.equal(nextInterval(30, 'good'), 30);
});

test('a passed check stores prompts and explanations without exposing them on the public card', async t => {
  const env = await home(t);
  assert.equal(await capturePassedCheck({ session: passedSession(), env, now: new Date('2026-10-23T12:00:00.000Z') }), 1);
  const deck = await readDeck('/work/billing', env);
  const id = cardId('/work/billing', q.prompt);
  const card = deck.cards[id];
  assert.equal(card.prompt, q.prompt);
  assert.equal(card.back, q.rationale);
  assert.equal(card.firstTry, true);
  assert.equal(card.target, 'refs/heads/main');
  assert.equal(card.dueAt, '2026-10-24T12:00:00.000Z');
  assert.equal(publicCard(card).back, undefined);
  assert.equal(Object.hasOwn(publicCard(card), 'back'), false);
  assert.equal((await stat(deckFile('/work/billing', env))).mode & 0o777, 0o600);
  assert.equal((await readDeck('/work/other', env)).cards[id], undefined, 'Each repository keeps its own deck');
});

test('documentation-only and empty checks add nothing', async t => {
  const env = await home(t);
  assert.equal(await capturePassedCheck({ session: { status: 'passed', noQuestionReason: 'Documentation-only change.', questions: [], snapshot }, env }), 0);
  assert.equal(await capturePassedCheck({ session: { status: 'pending', questions: [q], snapshot }, env }), 0);
  assert.equal((await readDeck('/work/billing', env)).cards[cardId('/work/billing', q.prompt)], undefined);
});

test('a missed first try is recorded, and repeating the same prompt schedules the next interval', async t => {
  const env = await home(t);
  const missed = passedSession({
    questions: [{ ...q, id: 'timeout', prompt: 'The connection drops after insertion. Can retry insert again? Why?', rationale: 'Both attempts insert.' }],
    attempts: [
      { questionId: 'retry', index: 0, kind: 'answer', verdict: 'incorrect', feedback: 'There is no key.' },
      { questionId: 'timeout', index: 0, kind: 'answer', verdict: 'correct', feedback: 'Both attempts insert.' },
    ],
  });
  const noon = new Date('2026-10-23T12:00:00.000Z');
  await capturePassedCheck({ session: missed, env, now: noon });
  const id = cardId('/work/billing', missed.questions[0].prompt);
  assert.equal((await readDeck('/work/billing', env)).cards[id].firstTry, false);
  await capturePassedCheck({ session: missed, env, now: new Date('2026-10-24T12:00:00.000Z') });
  const again = (await readDeck('/work/billing', env)).cards[id];
  assert.equal(again.intervalDays, 3);
  assert.equal(again.reviews, 1);
  assert.equal(again.dueAt, '2026-10-27T12:00:00.000Z');
});

test('due cards and reviews stay local; listing omits the explanation', async t => {
  const env = await home(t);
  const now = new Date('2026-10-23T12:00:00.000Z');
  await capturePassedCheck({ session: passedSession(), env, now });
  const id = cardId('/work/billing', q.prompt);
  let deck = await readDeck('/work/billing', env);
  assert.equal(dueCards(deck, now).length, 0);
  assert.equal(deckSummary(deck, now).due, 0);
  assert.equal(deckSummary(deck, now).nextDue, '2026-10-24T12:00:00.000Z');
  const later = new Date('2026-10-25T12:00:00.000Z');
  assert.equal(dueCards(deck, later)[0].id, id);
  const reviewed = await reviewCard({ repoRoot: '/work/billing', id, rating: 'again', env, now: later });
  assert.equal(reviewed.intervalDays, 1);
  assert.equal(reviewed.dueAt, '2026-10-26T12:00:00.000Z');
  await reviewCard({ repoRoot: '/work/billing', id, rating: 'good', env, now: later });
  deck = await readDeck('/work/billing', env);
  assert.equal(deck.cards[id].intervalDays, 3);
  await assert.rejects(reviewCard({ repoRoot: '/work/billing', id, rating: 'easy', env }), /again or good/);
  assert.equal(JSON.stringify(publicCard(deck.cards[id])).includes('insert happens'), false);
});

test('passing a real checkpoint writes the deck, and cleanup never removes it', async t => {
  const env = await home(t);
  const store = createSessionStore({
    env,
    generate: async (_s, _c, options) => { await options.beforeCall(); return { questions: [structuredClone(q)] }; },
    grade: async request => { await request.beforeCall(); return { verdict: 'correct', feedback: 'Correct: the repeated insert can duplicate it.', followUp: null }; },
  });
  await store.ensure(snapshot, DEFAULT_CONFIG);
  await store.start(snapshot.id, DEFAULT_CONFIG);
  assert.equal((await store.answer(snapshot.id, 'Yes: it inserts every time.', DEFAULT_CONFIG)).status, 'passed');
  const id = cardId(snapshot.repoRoot, q.prompt);
  assert.equal((await readDeck(snapshot.repoRoot, env)).cards[id].prompt, q.prompt);
  await collectGarbage({ env, now: Date.now() + 365 * 86400000 });
  assert.equal((await readDeck(snapshot.repoRoot, env)).cards[id].back, q.rationale, 'Cleanup never removes the deck');
});

test('the deck drops the oldest cards once it reaches the cap', async t => {
  const env = await home(t);
  const questions = Array.from({ length: MAX_CARDS + 5 }, (_, index) => ({ ...q, id: `q${index}`, prompt: `Prompt ${index}: what happens?`, rationale: `Because ${index}.` }));
  await capturePassedCheck({ session: passedSession({ questions, attempts: questions.map((item, index) => ({ questionId: item.id, index, kind: 'answer', verdict: 'correct' })) }), env, now: new Date('2026-10-23T00:00:00.000Z') });
  const deck = await readDeck('/work/billing', env);
  assert.equal(Object.keys(deck.cards).length, MAX_CARDS);
  assert.equal(deck.cards[cardId('/work/billing', 'Prompt 0: what happens?')], undefined);
  assert.ok(deck.cards[cardId('/work/billing', `Prompt ${MAX_CARDS + 4}: what happens?`)]);
});

test('a capture keeps cards it cannot read instead of saving over them', async t => {
  const env = await home(t);
  await capturePassedCheck({ session: passedSession(), env, now: new Date('2026-10-23T12:00:00.000Z') });
  const file = deckFile('/work/billing', env);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.cards.future = { kind: 'a card shape from a newer version' };
  await writeFile(file, JSON.stringify(stored));
  const other = { ...q, id: 'q2', prompt: 'What does the second retry do?' };
  assert.equal(await capturePassedCheck({ session: passedSession({ questions: [other], attempts: [] }), env }), 0);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), stored);
  assert.equal(Object.keys((await readDeck('/work/billing', env)).cards).length, 1, 'Lenient readers still skip the card');
  await assert.rejects(readDeck('/work/billing', env, { strict: true }), /Invalid card in deck: future/);
  await assert.rejects(reviewCard({ repoRoot: '/work/billing', id: cardId('/work/billing', q.prompt), rating: 'good', env }), /Invalid card in deck/);
  await writeFile(file, '{');
  assert.equal(await capturePassedCheck({ session: passedSession(), env }), 0);
  assert.equal(await readFile(file, 'utf8'), '{');
});

test('a passed answer does not wait out a busy deck', async t => {
  const env = await home(t);
  const store = createSessionStore({
    env,
    generate: async (_s, _c, options) => { await options.beforeCall(); return { questions: [structuredClone(q)] }; },
    grade: async request => { await request.beforeCall(); return { verdict: 'correct', feedback: 'Correct: the repeated insert can duplicate it.', followUp: null }; },
  });
  await store.ensure(snapshot, DEFAULT_CONFIG);
  await store.start(snapshot.id, DEFAULT_CONFIG);
  const lock = `${deckFile(snapshot.repoRoot, env)}.lock`;
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  const started = Date.now();
  assert.equal((await store.answer(snapshot.id, 'Yes: it inserts every time.', DEFAULT_CONFIG)).status, 'passed');
  assert.ok(Date.now() - started < 8000, 'The capture gives up well before the deck lock timeout');
  await rm(lock);
  assert.deepEqual((await readDeck(snapshot.repoRoot, env)).cards, {}, 'The skipped capture wrote nothing');
});

test('aborting stops a capture waiting on a busy deck', async t => {
  const env = await home(t);
  const lock = `${deckFile(snapshot.repoRoot, env)}.lock`;
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  const controller = new AbortController();
  const capture = capturePassedCheck({ session: passedSession(), env, signal: controller.signal });
  await delay(50);
  controller.abort();
  const outcome = await Promise.race([capture, delay(1000, 'still waiting')]);
  assert.equal(outcome, 0);
  await rm(lock);
});

test('concurrent captures and reviews all reach the deck', async t => {
  const env = await home(t);
  const repoRoot = '/work/billing';
  const at = new Date('2026-10-23T12:00:00.000Z');
  await capturePassedCheck({ session: passedSession(), env, now: at });
  const prompts = Array.from({ length: 4 }, (_, index) => `Concurrent prompt ${index}: what happens?`);
  await Promise.all([
    reviewCard({ repoRoot, id: cardId(repoRoot, q.prompt), rating: 'good', env, now: at }),
    ...prompts.map((prompt, index) => capturePassedCheck({ session: passedSession({ questions: [{ ...q, id: `c${index}`, prompt }], attempts: [] }), env, now: at })),
  ]);
  const { cards } = await readDeck(repoRoot, env);
  assert.equal(Object.keys(cards).length, 5);
  assert.equal(cards[cardId(repoRoot, q.prompt)].reviews, 1);
});

test('waiters that find the same orphaned lock never run together', async t => {
  const env = await home(t);
  const lock = path.join(env.SPHINX_HOME, 'orphan.lock');
  // A finished child's PID stands in for a process that died holding the lock.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  for (let round = 0; round < 30; round += 1) {
    await writeFile(lock, JSON.stringify({ pid: dead, createdAt: '2026-01-01T00:00:00.000Z' }));
    const old = new Date(Date.now() - 60000);
    await utimes(lock, old, old);
    let inside = 0, most = 0;
    // Staggered starts put one waiter's recovery after another has already retaken the lock.
    // Waiters that find a live holder give up at once, so only overlap matters here.
    await Promise.allSettled(Array.from({ length: 8 }, async (_, index) => {
      await delay(index % 3);
      return withFileLock(lock, async () => {
        inside += 1; most = Math.max(most, inside);
        await delay(30);
        inside -= 1;
      }, { busy: () => new Error('busy') });
    }));
    assert.equal(most, 1, `round ${round}: only one waiter holds the lock at a time`);
  }
  await assert.rejects(stat(`${lock}.recover`), { code: 'ENOENT' });
});
