import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { runTerminalCheck } from '../src/terminal-check.js';
import { createTerminal } from '../src/terminal.js';
import { prefersTerminal, runGitTerminalCheck } from '../src/git-interview.js';
import { DEFAULT_CONFIG, policyHash, validateConfig, validateRepositoryConfig } from '../src/config.js';

const question = (id, prompt, extra = {}) => ({ id, prompt, choices: [], ...extra });
function harness({ answers, results, waitingGit = false, more = false, started, event = 'pre-push', width = 80, held = false }) {
  let output = '';
  const stream = new Writable({ write(chunk, _e, done) { output += chunk; done(); } });
  const q1 = question('q1', 'What happens on redelivery?\u001b[2J', { evidence: [{ path: 'src/jobs/charge.js', reason: 'PRIVATE_REASON' }] });
  const session = { id: 'x', questions: [q1], ...(held ? { status: 'passed', held: { at: '2026-10-23T00:00:00.000Z' } } : {}), route: { provider: 'claude', model: 'sonnet' }, snapshot: { repoRoot: '/work/billing', event, target: { remote: 'origin', ref: 'refs/heads/main' }, stats: { files: 2, additions: 10, deletions: 1 } } };
  const sent = [], skips = [], prompts = [], starts = [];
  const store = {
    start: async (_id, _c, options) => { starts.push(options); return started ?? ({ status: 'active', question: q1, progress: { completed: 0, total: 1 } }); },
    read: async () => session, public: s => s,
    answer: async (_id, text, _c, options) => { sent.push({ text, ...options }); const result = results.shift(); if (result instanceof Error) throw result; return result; },
  };
  const ask = async prompt => { prompts.push(prompt); if (!answers.length) throw new Error(`Unexpected prompt: ${prompt}`); return answers.shift(); };
  const run = () => runTerminalCheck({ store, session, config: DEFAULT_CONFIG, ask, terminal: createTerminal({ stream, env: { NO_COLOR: '1' }, width }), stream, waitingGit, more, env: { SPHINX_HOME: '/nonexistent-sphinx-home' }, validate: async () => {}, choose: async () => 'pause', skip: async reason => skips.push(reason) });
  return { run, sent, skips, prompts, starts, output: () => output, q1 };
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
  assert.match(out, /Approval saved for this exact change and destination\. A waiting push or commit\s+goes through once you choose Continue in its questionnaire\./);
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

test('after a waiting pass, continue lets Git through and stop keeps the receipt without continuing', async () => {
  const done = { status: 'passed', question: null, progress: { completed: 1, total: 1 }, verdict: 'correct', feedback: '' };
  const continued = harness({ answers: ['It charges twice', 'continue'], results: [done], waitingGit: true });
  assert.equal(await continued.run(), 0);
  assert.match(continued.output(), /Continue the push\?\n {2}continue: the push goes through\. stop: it does not go through\. Your pass is\n {2}saved, so the next push of this change asks only whether to continue\.\n/);
  assert.match(continued.output(), /Approval saved\. Git is continuing\./);
  const halted = harness({ answers: ['It charges twice', 'stop'], results: [{ ...done }], waitingGit: true });
  assert.equal(await halted.run(), 4);
  assert.match(halted.output(), /‖ Push stopped\. It did not go through; your pass is saved\./);
  const retried = harness({ answers: ['It charges twice', 'maybe', '', 'c'], results: [{ ...done }], waitingGit: true });
  assert.equal(await retried.run(), 0);
  assert.equal(retried.output().match(/Type continue or stop\./g).length, 2, 'there is no default choice');
});

test('a pass that needed no questions asks before a waiting Git operation continues, and nothing is asked when none waits', async () => {
  const none = { status: 'passed', noQuestionReason: 'Only renames a local variable.', progress: { completed: 0, total: 0 } };
  const continued = harness({ answers: ['yes'], results: [], waitingGit: true, started: none });
  assert.equal(await continued.run(), 0);
  assert.match(continued.output(), /✓ No questions needed: Only renames a local variable\.\n\n {2}Continue the push\?/);
  assert.deepEqual(continued.prompts, ['  › continue / stop: ']);
  const halted = harness({ answers: ['/stop'], results: [], waitingGit: true, started: none, event: 'pre-commit' });
  assert.equal(await halted.run(), 4, 'the /stop command also answers stop here');
  assert.match(halted.output(), /Continue the commit\?\n {2}continue: the commit goes through\./);
  assert.match(halted.output(), /Your pass is\s+saved, so the next commit of this change asks only whether to continue\./);
  assert.match(halted.output(), /‖ Commit stopped\. It did not go through; your pass is saved\./);
  const manual = harness({ answers: [], results: [], started: none });
  assert.equal(await manual.run(), 0);
  assert.deepEqual(manual.prompts, []);
});

test('while Git waits, /stop or /quit stops it and says it did not go through; a manual check keeps /quit as it was', async () => {
  const waiting = harness({ answers: ['/stop'], results: [], waitingGit: true });
  assert.equal(await waiting.run(), 1);
  assert.match(waiting.output(), /Enter to send · \/hint {2}\/learn {2}\/dispute <reason> {2}\/skip {2}\/stop\n/);
  assert.match(waiting.output(), /\n {2}‖ Push stopped\. It did not go through; your progress is saved\.\n {4}Run git push again to continue; Sphinx reopens at this question\.\n$/);
  const alias = harness({ answers: ['/quit'], results: [], waitingGit: true, event: 'pre-commit' });
  assert.equal(await alias.run(), 1);
  assert.match(alias.output(), /‖ Commit stopped\. It did not go through; your progress is saved\.\n {4}Run git commit again to continue; Sphinx reopens at this question\./);
  const manual = harness({ answers: ['/stop', '/quit'], results: [] });
  assert.equal(await manual.run(), 1);
  assert.match(manual.output(), /Enter to send · \/hint {2}\/learn {2}\/dispute <reason> {2}\/quit\n/);
  assert.match(manual.output(), /Use \/hint, \/learn, \/dispute <reason>, \/quit, or type your answer\./);
  assert.match(manual.output(), /Progress saved\. Run sphinx check when you are ready to continue\./);
});

test('with more destinations to check in the same push, a pass does not ask yet', async () => {
  const done = { status: 'passed', question: null, progress: { completed: 1, total: 1 }, verdict: 'correct', feedback: '' };
  const h = harness({ answers: ['It charges twice'], results: [done], waitingGit: true, more: true });
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.prompts, ['  › '], 'no continue / stop prompt before the last destination');
  assert.match(h.output(), /Approval saved\. This push has another destination to check next\./);
});

test('while Git waits, command hints name /stop, and on a narrow terminal the marked lines wrap clear of their mark', async () => {
  const failing = harness({ answers: ['/pause', 'It charges twice', '/stop'], results: [new Error('Provider timed out.')], waitingGit: true });
  assert.equal(await failing.run(), 1);
  assert.match(failing.output(), /Use \/hint, \/learn, \/dispute <reason>, \/stop, or type your answer\./);
  assert.match(failing.output(), /That didn't go through: Provider timed out\.\n {2}Your progress is kept\. Try again, or \/stop to stop here\./);
  const none = { status: 'passed', noQuestionReason: 'Only renames a local variable.', progress: { completed: 0, total: 0 } };
  const narrow = harness({ answers: ['stop'], results: [], waitingGit: true, started: none, width: 40 });
  assert.equal(await narrow.run(), 4);
  assert.match(narrow.output(), /\n {2}✓ No questions needed: Only renames a\n {4}local variable\.\n/);
  assert.match(narrow.output(), /\n {2}‖ Push stopped\. It did not go through;\n {4}your pass is saved\.\n/);
  const stopped = harness({ answers: ['/stop'], results: [], waitingGit: true, width: 40 });
  assert.equal(await stopped.run(), 1);
  assert.match(stopped.output(), /\n {2}‖ Push stopped\. It did not go through;\n {4}your progress is saved\.\n {4}Run git push again to continue;\n {4}Sphinx reopens at this question\.\n$/);
});

test('a held pass asks only whether to continue, saying it passed earlier, with nothing to answer', async () => {
  const held = { status: 'passed', held: true, progress: { completed: 1, total: 1 } };
  const stopped = harness({ answers: ['stop'], results: [], waitingGit: true, started: held, held: true });
  assert.equal(await stopped.run(), 4, 'stop reaches Git as a stopped check, which holds the pass again');
  const out = stopped.output();
  assert.match(out, /Loading your earlier pass…\n\n {2}✓ You passed this change earlier, but that push did not go through\.\n\n {2}Continue the push\?\n {2}continue: the push goes through\. stop: it does not go through\. Your pass is\n {2}saved, so the next push of this change asks only whether to continue\.\n/);
  assert.match(out, /‖ Push stopped\. It did not go through; your pass is saved\./);
  assert.doesNotMatch(out, /Understanding check complete|Question 1|Open-book|Loading prepared questions/);
  assert.deepEqual(stopped.prompts, ['  › continue / stop: ']);
  assert.deepEqual(stopped.sent, [], 'nothing is graded');
  const continued = harness({ answers: ['continue'], results: [], waitingGit: true, started: held, held: true, event: 'pre-commit', width: 40 });
  assert.equal(await continued.run(), 0);
  assert.match(continued.output(), /\n {2}✓ You passed this change earlier, but\n {4}that commit did not go through\.\n\n {2}Continue the commit\?\n/);
  assert.match(continued.output(), /Approval saved\. Git is continuing\./);
  const earlier = harness({ answers: [], results: [], waitingGit: true, more: true, started: held, held: true });
  assert.equal(await earlier.run(), 0);
  assert.deepEqual(earlier.prompts, [], 'an earlier destination of the push does not ask yet');
  assert.match(earlier.output(), /✓ You passed this change earlier, but that push did not go through\.\n {2}Approval saved\. This push has another destination to check next\./);
  const none = harness({ answers: ['stop'], results: [], waitingGit: true, started: { ...held, noQuestionReason: 'Only renames a local variable.' }, held: true });
  assert.equal(await none.run(), 4);
  assert.match(none.output(), /✓ This change needed no questions earlier, but that push did not go through\.\n/, 'nobody was asked anything to pass');
});

test('while Git waits a pass is saved held as it is made, and only a pass held when the check opened is called earlier', async () => {
  const done = { status: 'passed', held: true, question: null, progress: { completed: 1, total: 1 }, verdict: 'correct', feedback: '' };
  const waiting = harness({ answers: ['It charges twice', 'continue'], results: [done], waitingGit: true });
  assert.equal(await waiting.run(), 0);
  assert.equal(waiting.starts[0].hold, true); assert.equal(waiting.sent[0].hold, true);
  assert.match(waiting.output(), /✓ Understanding check complete\./); assert.doesNotMatch(waiting.output(), /earlier/);
  const none = harness({ answers: ['stop'], results: [], waitingGit: true, started: { status: 'passed', held: true, noQuestionReason: 'Only renames a local variable.', progress: { completed: 0, total: 0 } } });
  assert.equal(await none.run(), 4);
  assert.match(none.output(), /✓ No questions needed: Only renames a local variable\./); assert.doesNotMatch(none.output(), /earlier/);
  // A check with no Git operation waiting saves a plain receipt, as before.
  const manual = harness({ answers: ['It charges twice'], results: [{ ...done, held: undefined }] });
  assert.equal(await manual.run(), 0);
  assert.equal(manual.starts[0].hold, false); assert.equal(manual.sent[0].hold, false);
});

test('Git asks inline on its own terminal, else opens a window', async () => {
  const fakeChild = code => { const child = new EventEmitter(); child.kill = () => {}; queueMicrotask(() => child.emit('exit', code)); return child; };
  for (const [code, status] of [[0, 'passed'], [3, 'skipped'], [4, 'stopped'], [1, 'pending']]) {
    let spawned;
    const result = await runGitTerminalCheck({ request: { id: 'abc' }, env: { A: '1' }, openTty: () => 99, spawnImpl: (...args) => { spawned = args; return fakeChild(code); }, openWindow: () => assert.fail('no window when a terminal is visible') });
    assert.equal(result.status, status);
    assert.deepEqual(spawned[1].slice(1), ['check', '--id', 'abc']);
    assert.deepEqual(spawned[2].stdio, [99, 99, 99]);
    assert.equal(spawned[2].env.SPHINX_WAITING_GIT, '1');
    assert.equal(spawned[2].env.SPHINX_MORE_CHECKS, undefined);
  }
  let more;
  await runGitTerminalCheck({ request: { id: 'abc', more: true }, env: {}, openTty: () => 99, spawnImpl: (...args) => { more = args[2].env; return fakeChild(0); } });
  assert.equal(more.SPHINX_MORE_CHECKS, '1', 'an earlier destination of the push does not ask to continue yet');
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
