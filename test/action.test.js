import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_NAME, checkFor, findStamp, parseStamp, run } from '../action/index.mjs';
import { checkRecord, commentBody } from '../src/github.js';

const head = 'b'.repeat(40);
const snapshot = { head, base: 'a'.repeat(40), stats: { files: 3, additions: 40, deletions: 2 }, target: { ref: 'refs/heads/feature' } };
const session = { route: { provider: 'claude', model: 'haiku' }, config: { level: 'standard', distance: 'mixed' }, questions: [{ id: 'q', prompt: 'What happens on retry? <img src=x onerror=alert(1)> | **bold**' }],
  attempts: [{ index: 0, kind: 'answer', prompt: 'What happens on retry? <img src=x onerror=alert(1)> | **bold**', answer: 'SECRET_ANSWER', verdict: 'correct' }] };
const stampedBody = outcome => commentBody([checkRecord({ session, snapshot, outcome })], { stampHead: head });
const comment = (body, user = 'alice', association = 'CONTRIBUTOR', at = '2026-10-19T10:00:00Z') => ({ body, user: { login: user }, author_association: association, created_at: at, html_url: 'https://github.com/o/r/pull/1#c' });

test('a stamp round-trips from the local comment, without answers', () => {
  const stamp = parseStamp(stampedBody('passed'));
  assert.equal(stamp.head, head);
  assert.deepEqual(stamp.questions.map(q => q.firstTry), [true]);
  assert.doesNotMatch(JSON.stringify(stamp), /SECRET_ANSWER/);
  assert.equal(parseStamp('no stamp here'), null);
  assert.equal(parseStamp('<!-- sphinx-stamp:v1 bm90IGpzb24= -->'), null, 'garbage is ignored');
});

test('only the PR author or a maintainer can stamp, and only for the current commit', () => {
  const good = stampedBody('passed');
  assert.ok(findStamp({ comments: [comment(good)], head, author: 'alice' }));
  assert.equal(findStamp({ comments: [comment(good, 'mallory')], head, author: 'alice' }), null, 'a passer-by cannot stamp');
  assert.ok(findStamp({ comments: [comment(good, 'maintainer', 'MEMBER')], head, author: 'alice' }));
  assert.equal(findStamp({ comments: [comment(good)], head: 'c'.repeat(40), author: 'alice' }), null, 'a new push needs a new stamp');
  const newest = findStamp({ comments: [comment(good, 'alice', 'NONE', '2026-10-19T10:00:00Z'), comment(stampedBody('skipped'), 'alice', 'NONE', '2026-10-19T11:00:00Z')], head, author: 'alice' });
  assert.equal(newest.stamp.outcome, 'skipped', 'the newest stamp wins');
});

test('the check says stamped with a summary, failed when skipped, and neutral or failed when missing', () => {
  const passed = checkFor(findStamp({ comments: [comment(stampedBody('passed'))], head, author: 'alice' }));
  assert.equal(passed.conclusion, 'success');
  assert.equal(passed.title, 'Sphinx stamped · 1 question, 1 first try');
  assert.match(passed.summary, /\| Distance \| mixed \|/);
  assert.match(passed.summary, /✅ first try/);
  assert.doesNotMatch(passed.summary, /<img/, 'model text cannot inject markup');
  assert.equal(checkFor(findStamp({ comments: [comment(stampedBody('skipped'))], head, author: 'alice' })).conclusion, 'failure');
  assert.equal(checkFor(null).conclusion, 'neutral');
  assert.equal(checkFor(null, { require: true }).conclusion, 'failure');
});

const raw = stamp => `<!-- sphinx-stamp:v1 ${Buffer.from(JSON.stringify({ v: 1, head, outcome: 'passed', questions: [], ...stamp })).toString('base64')} -->`;

test('a stamp with fields Sphinx never writes is ignored, and its time cannot inject markup', () => {
  for (const questions of [[null], ['text'], [{ prompt: 7 }], [{ prompt: 'p', tries: '2 | x', firstTry: false }], [{ prompt: 'p', tries: -1, firstTry: false }], [{ prompt: 'p', tries: 1, firstTry: 'yes' }], [{ prompt: 'p', firstTry: false }], [{ prompt: 'p', tries: 2 }]]) {
    assert.equal(parseStamp(raw({ questions })), null, JSON.stringify(questions));
  }
  // An object whose toString is no function makes String() and Number() throw, which used to fail the whole run.
  const unprintable = { toString: 0, valueOf: 0 };
  for (const field of [{ head: unprintable }, { level: unprintable }, { model: ['x'] }, { noQuestionReason: 5 }, { at: unprintable }, { stats: { files: unprintable } }, { stats: [1] }]) {
    assert.equal(parseStamp(raw(field)), null, JSON.stringify(field));
  }
  assert.ok(parseStamp(raw({ questions: [{ prompt: 'p' }, { prompt: 'q', tries: 2, firstTry: false }] })), 'what Sphinx writes still parses');
  const summary = at => checkFor(findStamp({ comments: [comment(raw({ at }))], head, author: 'alice' })).summary;
  assert.match(summary('2026-10-24T19:40:57.000Z'), /\| Checked \| 2026-10-24 19:40 UTC \|/);
  for (const at of ['[x](https://e.co) |', ['2026-10-24T19:40'], 5]) assert.doesNotMatch(summary(at), /Checked/, JSON.stringify(at));
});

function fakeApi({ comments, existing = [] }) {
  const calls = [];
  const api = async (method, route, body) => {
    calls.push({ method, route, body });
    if (route.endsWith('/pulls/1')) return { head: { sha: head }, user: { login: 'alice' } };
    if (route.includes('/issues/1/comments')) return comments;
    if (route.includes('/check-runs?')) return { check_runs: existing };
    return {};
  };
  return { api, calls };
}

test('the Action creates the Sphinx check, then updates it in place; non-PR comments are ignored', async () => {
  const first = fakeApi({ comments: [comment(stampedBody('passed'))] });
  await run({ event: { pull_request: { number: 1 } }, eventName: 'pull_request_target', repository: 'o/r', api: first.api, log: () => {} });
  const created = first.calls.find(call => call.method === 'POST');
  assert.equal(created.route, '/repos/o/r/check-runs');
  assert.deepEqual([created.body.name, created.body.head_sha, created.body.conclusion], [CHECK_NAME, head, 'success']);
  const second = fakeApi({ comments: [comment(stampedBody('passed'))], existing: [{ id: 42 }] });
  await run({ event: { issue: { number: 1, pull_request: {} } }, eventName: 'issue_comment', repository: 'o/r', api: second.api, log: () => {} });
  const updated = second.calls.find(call => call.method === 'PATCH');
  assert.equal(updated.route, '/repos/o/r/check-runs/42');
  assert.deepEqual([updated.body.name, updated.body.conclusion, 'head_sha' in updated.body], [CHECK_NAME, 'success', false], 'GitHub documents head_sha only for creating a check run');
  const issue = fakeApi({ comments: [] });
  assert.equal(await run({ event: { issue: { number: 5 } }, eventName: 'issue_comment', repository: 'o/r', api: issue.api, log: () => {} }), null);
  assert.equal(issue.calls.length, 0);
});
