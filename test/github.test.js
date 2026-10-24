import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMENT_MARKER, STATUS_CONTEXT, checkRecord, commentBody, githubRepository, runStampJob, scheduleStamp, statusFor } from '../src/github.js';
import { DEFAULT_CONFIG, policyHash, validateConfig, validateRepositoryConfig } from '../src/config.js';

const snapshot = { event: 'pre-push', repoRoot: '/repo', head: 'b'.repeat(40), base: 'a'.repeat(40), stats: { files: 2, additions: 10, deletions: 1 }, target: { remote: 'origin', url: 'git@github.com:acme/widgets.git', ref: 'refs/heads/feature' } };
const question = (id, prompt) => ({ id, prompt, choices: [], expectedAnswer: 'PRIVATE_KEY_TEXT', rationale: 'PRIVATE_RATIONALE', acceptance: { prediction: 'PRIVATE_PREDICTION', causalReason: 'x' } });
const session = {
  route: { provider: 'claude', model: 'sonnet' }, config: { level: 'standard', distance: 'high' },
  questions: [question('q1', 'What happens on retry?'), question('t2', 'Follow-up: what if the id is new?')],
  attempts: [
    { index: 0, kind: 'answer', prompt: 'What happens on retry?', answer: 'returns the prior result', verdict: 'correct' },
    { index: 1, kind: 'learn', prompt: 'What does a timeout do?', answer: '', verdict: 'incorrect' },
    { index: 1, kind: 'answer', prompt: 'Follow-up: what if the id is new?', answer: 'creates one', verdict: 'correct' },
  ],
};

test('recognizes GitHub remotes only', () => {
  for (const url of ['https://github.com/acme/widgets.git', 'https://x@github.com/acme/widgets', 'git@github.com:acme/widgets.git', 'ssh://git@github.com/acme/widgets.git'])
    assert.deepEqual(githubRepository(url), { host: 'github.com', owner: 'acme', repo: 'widgets' }, url);
  for (const url of ['https://gitlab.com/acme/widgets.git', '/tmp/repo.git', '', 'https://example.invalid/sphinx.git']) assert.equal(githubRepository(url), null, url);
});

test('summaries count first tries like the score and never include answer keys', () => {
  const record = checkRecord({ session, snapshot, outcome: 'passed' });
  assert.deepEqual(record.questions.map(q => [q.prompt, q.tries, q.firstTry]), [['What happens on retry?', 1, true], ['What does a timeout do?', 2, false]]);
  assert.deepEqual(statusFor(record), { state: 'success', description: 'Sphinx stamped · 2 questions, 1 first try' });
  const body = commentBody([record]);
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.match(body, /claude sonnet/);
  assert.doesNotMatch(body, /PRIVATE_|returns the prior result/);
  assert.match(commentBody([checkRecord({ session, snapshot, outcome: 'passed', includeAnswers: true })]), /> returns the prior result/);
  assert.equal(statusFor(checkRecord({ session: null, snapshot, outcome: 'skipped' })).state, 'failure');
  assert.equal(statusFor(checkRecord({ session: { questions: [], noQuestionReason: 'docs' }, snapshot, outcome: 'passed' })).description, 'Sphinx stamped · no questions needed');
});

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sphinx-github-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { SPHINX_HOME: dir };
}
const fakeSpawn = calls => (...args) => { calls.push(args); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; };
const config = github => ({ ...DEFAULT_CONFIG, github: { ...DEFAULT_CONFIG.github, ...github } });

test('stamping is skipped for other hosts, commits, and when turned off, and never throws', async t => {
  const env = await home(t), calls = [];
  assert.equal(await scheduleStamp({ snapshot: { ...snapshot, target: { ...snapshot.target, url: '/tmp/x.git' } }, session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), false);
  assert.equal(await scheduleStamp({ snapshot: { ...snapshot, event: 'pre-commit' }, session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), false);
  assert.equal(await scheduleStamp({ snapshot, session, outcome: 'passed', config: config({ status: false }), env, spawnImpl: fakeSpawn(calls) }), false);
  assert.equal(calls.length, 0);
  assert.equal(await scheduleStamp({ snapshot, session, outcome: 'passed', config: config({}), env, spawnImpl: () => { throw new Error('ENOENT'); } }), false);
  assert.equal(await scheduleStamp({ snapshot, session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].detached, true);
  const job = JSON.parse(await readFile(calls[0][1][1], 'utf8'));
  assert.deepEqual({ ...job, branchFile: undefined }, { version: 1, repo: { host: 'github.com', owner: 'acme', repo: 'widgets' }, sha: snapshot.head, branch: 'feature', branchFile: undefined, status: true, comment: false });
});

function fakeGh(responses) {
  const calls = [];
  const gh = async (args, options) => {
    calls.push({ args, input: options.input });
    for (const [pattern, result] of responses) if (pattern.test(args.join(' '))) return typeof result === 'function' ? result() : result;
    return { ok: false, stdout: '' };
  };
  return { gh, calls };
}

async function job(t, overrides = {}) {
  const env = await home(t);
  const branchFile = join(env.SPHINX_HOME, 'branch.json');
  await writeFile(branchFile, JSON.stringify({ records: [checkRecord({ session, snapshot, outcome: 'passed' })] }));
  return { version: 1, repo: { host: 'github.com', owner: 'acme', repo: 'widgets' }, sha: snapshot.head, branch: 'feature', branchFile, status: true, comment: false, ...overrides };
}
const ok = (stdout = '') => ({ ok: true, stdout });

test('without a gh login nothing is posted', async t => {
  const { gh, calls } = fakeGh([]);
  assert.equal(await runStampJob(await job(t), { gh, wait: async () => {} }), 'not-signed-in');
  assert.equal(calls.length, 1);
});

test('waits for the push to land, then posts the commit status', async t => {
  let polls = 0;
  const { gh, calls } = fakeGh([[/^auth/, ok()], [/commits\//, () => (++polls < 3 ? { ok: false } : ok('sha'))], [/statuses\//, ok()]]);
  assert.equal(await runStampJob(await job(t), { gh, wait: async () => {} }), 'done');
  const status = calls.find(call => /statuses\//.test(call.args.join(' ')));
  assert.deepEqual(status.input, { state: 'success', context: STATUS_CONTEXT, description: 'Sphinx stamped · 2 questions, 1 first try' });
  assert.ok(!calls.some(call => call.args[0] === 'pr'));
});

test('creates the pull request comment once, then edits it in place', async t => {
  const responses = [[/^auth/, ok()], [/commits\//, ok('sha')], [/statuses\//, ok()], [/^api user/, ok('me\n')], [/repos\/acme\/widgets --jq/, ok('')], [/pulls\?state=open/, ok('[{"number":7}]')], [/issues\/comments\/55/, ok('https://github.com/c/55\n')], [/issues\/7\/comments --method POST/, ok('https://github.com/c/new\n')]];
  const first = fakeGh([[/issues\/7\/comments --paginate/, ok('')], ...responses]);
  assert.equal(await runStampJob(await job(t, { comment: true }), { gh: first.gh, wait: async () => {} }), 'done');
  const posted = first.calls.find(call => /--method POST/.test(call.args.join(' ')) && /issues/.test(call.args.join(' ')));
  assert.ok(posted.input.body.startsWith(COMMENT_MARKER));
  assert.equal(first.calls.filter(call => /statuses\//.test(call.args.join(' '))).at(-1).input.target_url, 'https://github.com/c/new');
  const second = fakeGh([[/issues\/7\/comments --paginate/, ok('55\n')], ...responses]);
  await runStampJob(await job(t, { comment: true }), { gh: second.gh, wait: async () => {} });
  assert.ok(second.calls.some(call => /issues\/comments\/55 --method PATCH/.test(call.args.join(' '))));
});

test('a branch without a pull request gives up quietly', async t => {
  const { gh } = fakeGh([[/^auth/, ok()], [/commits\//, ok('sha')], [/statuses\//, ok()], [/repos\/acme\/widgets --jq/, ok('')], [/pulls\?state=open/, ok('[]')]]);
  assert.equal(await runStampJob(await job(t, { comment: true, status: false }), { gh, wait: async () => {}, prTries: 3 }), 'no-pull-request');
});

test('github settings validate, merge from .sphinxconfig, and stay out of the policy hash', () => {
  assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), github: { status: 'yes' } }), /github/);
  assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), github: { extra: true } }), /github/);
  assert.doesNotThrow(() => validateRepositoryConfig({ github: { comment: true } }));
  assert.equal(policyHash(DEFAULT_CONFIG), policyHash({ ...DEFAULT_CONFIG, github: { status: false, comment: true, answers: true } }));
});

test('the PR comment carries an encoded stamp for the pushed commit, and only this person\u2019s comment is edited', async t => {
  const responses = [[/^auth/, ok()], [/commits\//, ok('sha')], [/^api user/, ok('me\n')], [/repos\/acme\/widgets --jq/, ok('')], [/pulls\?state=open/, ok('[{"number":7}]')], [/issues\/7\/comments --paginate/, ok('')], [/issues\/7\/comments --method POST/, ok('https://github.com/c/new\n')]];
  const { gh, calls } = fakeGh(responses);
  await runStampJob(await job(t, { comment: true, status: false }), { gh, wait: async () => {} });
  const lookup = calls.find(call => /comments --paginate/.test(call.args.join(' ')));
  assert.match(lookup.args.join(' '), /\.user\.login == "me"/);
  const body = calls.find(call => /--method POST/.test(call.args.join(' '))).input.body;
  const { parseStamp } = await import('../action/index.mjs');
  const stamp = parseStamp(body);
  assert.equal(stamp.head, snapshot.head); assert.equal(stamp.outcome, 'passed');
  assert.deepEqual(stamp.questions.map(q => q.firstTry), [true, false]);
  assert.doesNotMatch(JSON.stringify(stamp), /PRIVATE_|returns the prior result/, 'no answers or answer keys');
});

test('from a fork, the stamp goes to the upstream pull request', async t => {
  const { gh, calls } = fakeGh([[/^auth/, ok()], [/commits\//, ok('sha')], [/^api user/, ok('me\n')], [/repos\/acme\/widgets --jq/, ok('upstream/widgets\n')],
    [/repos\/acme\/widgets\/pulls\?/, ok('[]')], [/repos\/upstream\/widgets\/pulls\?state=open&head=acme%3Afeature/, ok('[{"number":9}]')],
    [/upstream\/widgets\/issues\/9\/comments --paginate/, ok('')], [/upstream\/widgets\/issues\/9\/comments --method POST/, ok('https://github.com/c/9\n')]]);
  assert.equal(await runStampJob(await job(t, { comment: true, status: false }), { gh, wait: async () => {} }), 'done');
  assert.ok(calls.some(call => /upstream\/widgets\/issues\/9\/comments --method POST/.test(call.args.join(' '))));
});

test('a repository running the Sphinx Action gets the comment instead of a commit status', async t => {
  const env = await home(t), calls = [];
  const repoRoot = join(env.SPHINX_HOME, 'repo');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(repoRoot, '.github', 'workflows'), { recursive: true });
  await writeFile(join(repoRoot, '.github', 'workflows', 'sphinx.yml'), 'jobs:\n  stamp:\n    steps:\n      - uses: someone/sphinx/action@v1\n');
  assert.equal(await scheduleStamp({ snapshot: { ...snapshot, repoRoot }, session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), true);
  const job = JSON.parse(await readFile(calls[0][1].at(-1), 'utf8'));
  assert.deepEqual([job.status, job.comment], [false, true]);
  calls.length = 0;
  await scheduleStamp({ snapshot: { ...snapshot, repoRoot }, session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls), post: false });
  assert.equal(calls.length, 0, 'turning the toggle off posts nothing');
});
