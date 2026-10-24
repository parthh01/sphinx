import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { runTerminalCheck } from '../src/terminal-check.js';
import { createTerminal } from '../src/terminal.js';
import { prefersTerminal, runGitTerminalCheck } from '../src/git-interview.js';
import { DEFAULT_CONFIG, policyHash, validateConfig, validateRepositoryConfig } from '../src/config.js';

const question = (id, prompt, extra = {}) => ({ id, prompt, choices: [], ...extra });
function harness({ answers, results, waitingGit = false }) {
  let output = '';
  const stream = new Writable({ write(chunk, _e, done) { output += chunk; done(); } });
  const q1 = question('q1', 'What happens on redelivery?\u001b[2J', { evidence: [{ path: 'src/jobs/charge.js', reason: 'PRIVATE_REASON' }] });
  const session = { id: 'x', questions: [q1], route: { provider: 'claude', model: 'sonnet' }, snapshot: { repoRoot: '/work/billing', target: { remote: 'origin', ref: 'refs/heads/main' }, stats: { files: 2, additions: 10, deletions: 1 } } };
  const sent = [], skips = [];
  const store = {
    start: async () => ({ status: 'active', question: q1, progress: { completed: 0, total: 1 } }),
    read: async () => session, public: s => s,
    answer: async (_id, text, _c, options) => { sent.push({ text, ...options }); return results.shift(); },
  };
  const ask = async () => answers.shift();
  const run = () => runTerminalCheck({ store, session, config: DEFAULT_CONFIG, ask, terminal: createTerminal({ stream, env: { NO_COLOR: '1' }, width: 80 }), stream, waitingGit, env: { SPHINX_HOME: '/nonexistent-sphinx-home' }, validate: async () => {}, choose: async () => 'pause', skip: async reason => skips.push(reason) });
  return { run, sent, skips, output: () => output, q1 };
}

test('the terminal check shows the change, asks, grades, and passes', async () => {
  const done = { status: 'passed', question: null, progress: { completed: 1, total: 1 }, verdict: 'correct', feedback: '' };
  const h = harness({ answers: ['/hint', '', 'It charges twice'], results: [done] });
  assert.equal(await h.run(), 0);
  const out = h.output();
  assert.match(out, /◆ sphinx v\d+\.\d+\.\d+/);
  assert.match(out, /billing → origin\/main  ·  2 files  \+10 −1  ·  Claude Code sonnet/);
  assert.match(out, /Question 1 of 1\n {2}┃ What happens on redelivery\?/);
  assert.doesNotMatch(out, /\u001b\[2J/, 'model text cannot drive the terminal');
  assert.match(out, /Look at\n {4}src\/jobs\/charge\.js/);
  assert.doesNotMatch(out, /PRIVATE_REASON/);
  assert.doesNotMatch(out, /\/skip/, 'skip is only offered while Git waits');
  assert.match(out, /✓ Understanding check complete\./);
  assert.deepEqual(h.sent.map(item => item.text), ['It charges twice']);
});

test('a wrong answer explains and asks a labelled follow-up; /quit saves progress', async () => {
  const followUp = { status: 'active', question: question('q2', 'Now the crash is after charge().'), progress: { completed: 0, total: 1 }, verdict: 'incorrect', feedback: 'The job saves nothing before charge().' };
  const h = harness({ answers: ['Charged once', '/quit'], results: [followUp] });
  assert.equal(await h.run(), 1);
  assert.match(h.output(), /✗ Not quite\n {2}│ The job saves nothing before charge\(\)\./);
  assert.match(h.output(), /Question 1 of 1 · follow-up/);
  assert.match(h.output(), /Progress saved/);
});

test('after a miss or an explanation without a new question, the same question is shown again below the explanation', async () => {
  const results = [];
  const h = harness({ answers: ['Charged once', '/learn', 'It charges twice'], results });
  const same = feedback => ({ status: 'active', question: h.q1, progress: { completed: 0, total: 1 }, verdict: 'incorrect', feedback });
  results.push(same('The job saves nothing before charge().'), same('Here is how it works.'), { status: 'passed', question: null, progress: { completed: 1, total: 1 }, verdict: 'correct', feedback: '' });
  assert.equal(await h.run(), 0);
  const out = h.output();
  assert.match(out, /✗ Not quite\n {2}│ The job saves nothing before charge\(\)\.\n\n {2}Question 1 of 1 · still open\n {2}┃ What happens on redelivery\?/);
  assert.match(out, /Preparing an explanation…\n\n {2}◇ Here's how it works\n {2}│ Here is how it works\.\n\n {2}Question 1 of 1 · still open\n/);
  assert.doesNotMatch(out, /new scenario|follow-up/, 'Nothing promises a new question that did not come');
});

test('/skip asks for a reason and lets a waiting Git operation through', async () => {
  const h = harness({ answers: ['/skip', 'prod hotfix'], results: [], waitingGit: true });
  assert.equal(await h.run(), 3);
  assert.deepEqual(h.skips, ['prod hotfix']);
  assert.match(h.output(), /Skipped\. Git is continuing\./);
  const back = harness({ answers: ['/skip', 'n', '/quit'], results: [], waitingGit: true });
  assert.equal(await back.run(), 1); assert.deepEqual(back.skips, []);
});

test('auto uses the terminal unless the browser can open in the background', () => {
  assert.equal(prefersTerminal({ interface: 'auto' }, { env: {}, platform: 'darwin' }), false);
  assert.equal(prefersTerminal({ interface: 'auto' }, { env: { SSH_CONNECTION: '1' }, platform: 'darwin' }), true);
  assert.equal(prefersTerminal({ interface: 'auto' }, { env: {}, platform: 'linux' }), true);
  assert.equal(prefersTerminal({ interface: 'terminal' }, { env: {}, platform: 'darwin' }), true);
  assert.equal(prefersTerminal({ interface: 'browser' }, { env: { SSH_TTY: '/dev/x' }, platform: 'linux' }), false);
});

test('Git asks inline on its own terminal, else opens a window', async () => {
  const fakeChild = code => { const child = new EventEmitter(); child.kill = () => {}; queueMicrotask(() => child.emit('exit', code)); return child; };
  for (const [code, status] of [[0, 'passed'], [3, 'skipped'], [1, 'pending']]) {
    let spawned;
    const result = await runGitTerminalCheck({ request: { id: 'abc' }, env: { A: '1' }, openTty: () => 99, spawnImpl: (...args) => { spawned = args; return fakeChild(code); }, openWindow: () => assert.fail('no window when a terminal is visible') });
    assert.equal(result.status, status);
    assert.deepEqual(spawned[1].slice(1), ['check', '--id', 'abc']);
    assert.deepEqual(spawned[2].stdio, [99, 99, 99]);
    assert.equal(spawned[2].env.SPHINX_WAITING_GIT, '1');
  }
  const windowed = await runGitTerminalCheck({ request: { id: 'abc' }, openTty: () => null, openWindow: async () => ({ status: 'unavailable' }) });
  assert.equal(windowed.status, 'unavailable');
});

test('interface is a personal setting outside the policy hash', () => {
  assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), interface: 'tui' }), /interface/);
  assert.throws(() => validateRepositoryConfig({ interface: 'terminal' }), /cannot set interface/);
  assert.equal(policyHash(DEFAULT_CONFIG), policyHash({ ...DEFAULT_CONFIG, interface: 'terminal' }));
});

test('a failed grade keeps the question open instead of ending the check; cancelling still ends it', async () => {
  // The first grade fails the way issue #14 reported.
  const failing = harness({ answers: [], results: [] });
  let calls = 0;
  const done = { status: 'passed', question: null, progress: { completed: 1, total: 1 }, verdict: 'correct', feedback: '' };
  const store = { start: async () => ({ status: 'active', question: failing.q1, progress: { completed: 0, total: 1 } }), read: async () => ({}), public: s => s,
    answer: async () => { calls++; if (calls === 1) throw new Error("The grader's reply couldn't be used, so no explanation is shown. Asking again makes another model call."); return done; } };
  let output = '';
  const { Writable } = await import('node:stream');
  const stream = new Writable({ write(chunk, _e, next) { output += chunk; next(); } });
  const answers = ['/learn', 'It charges twice'];
  const code = await runTerminalCheck({ store, session: { id: 'x', questions: [failing.q1], route: {}, snapshot: { repoRoot: '/r', target: { ref: 'refs/heads/main' } } }, config: DEFAULT_CONFIG, ask: async () => answers.shift(), terminal: createTerminal({ stream, env: { NO_COLOR: '1' }, width: 80 }), stream, env: { SPHINX_HOME: '/nonexistent' }, validate: async () => {}, choose: async () => 'pause' });
  assert.equal(code, 0, 'the check carried on and passed');
  assert.match(output, /That didn't go through: The grader's reply couldn't be used, so no explanation is shown\./);
  assert.match(output, /Your progress is kept/);
  const cancelled = Object.assign(new Error('cancelled'), { code: 'SPHINX_CANCELLED' });
  const stopping = { ...store, answer: async () => { throw cancelled; } };
  await assert.rejects(runTerminalCheck({ store: stopping, session: { id: 'x', questions: [failing.q1], route: {}, snapshot: { repoRoot: '/r', target: { ref: 'refs/heads/main' } } }, config: DEFAULT_CONFIG, ask: async () => 'An answer', terminal: createTerminal({ stream, env: { NO_COLOR: '1' }, width: 80 }), stream, env: { SPHINX_HOME: '/nonexistent' }, validate: async () => {}, choose: async () => 'pause' }), /cancelled/);
});

test('a saved ungraded answer is shown once and Enter sends it again without retyping', async () => {
  const q1 = question('q1', 'What happens on redelivery?');
  const session = { id: 'x', index: 0, status: 'active', questions: [q1], draft: { questionId: 'q1', kind: 'dispute', text: 'It assumes one worker.' }, route: {}, snapshot: { repoRoot: '/r', target: { ref: 'refs/heads/main' } } };
  const sent = [];
  const done = { status: 'passed', question: null, progress: { completed: 1, total: 1 }, verdict: 'ambiguous', feedback: '' };
  const store = { start: async () => ({ status: 'active', question: q1, progress: { completed: 0, total: 1 } }), read: async () => session, public: s => s,
    answer: async (_id, text, _c, options) => { sent.push({ text, dispute: options.dispute }); return done; } };
  let output = '';
  const stream = new Writable({ write(chunk, _e, next) { output += chunk; next(); } });
  const answers = [''];
  const code = await runTerminalCheck({ store, session, config: DEFAULT_CONFIG, ask: async () => answers.shift(), terminal: createTerminal({ stream, env: { NO_COLOR: '1' }, width: 80 }), stream, env: { SPHINX_HOME: '/nonexistent' }, validate: async () => {}, choose: async () => 'pause' });
  assert.equal(code, 0);
  assert.match(output, /Your last dispute was not graded and is saved: It assumes one worker\./);
  assert.deepEqual(sent, [{ text: 'It assumes one worker.', dispute: true }]);
});
