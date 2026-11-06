import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readStats, recordAnswer, recordCheck, repositoryKey, scoreSummary, statsFile, CALIBRATION_QUESTIONS } from '../src/stats.js';
import { collectGarbage } from '../src/storage.js';

async function home(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sphinx-stats-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { SPHINX_HOME: dir };
}

test('the score calibrates first, then reports first-try accuracy, streak, and skip rate per repository', async t => {
  const env = await home(t), repoRoot = '/work/billing';
  assert.equal(scoreSummary(await readStats(repoRoot, env)).calibrating, true);
  for (const correct of [true, true, false, true]) await recordAnswer({ repoRoot, correct, env });
  let score = scoreSummary(await readStats(repoRoot, env));
  assert.deepEqual([score.calibrating, score.accuracy, score.needed], [true, null, CALIBRATION_QUESTIONS - 4], 'No percentage before five answers');
  await recordAnswer({ repoRoot, correct: true, env });
  await recordCheck({ repoRoot, outcome: 'completed', env }); await recordCheck({ repoRoot, outcome: 'completed', env }); await recordCheck({ repoRoot, outcome: 'skipped', env });
  score = scoreSummary(await readStats(repoRoot, env));
  assert.deepEqual([score.calibrating, score.accuracy, score.streak, score.bestStreak, score.skipRate], [false, 80, 2, 2, 33]);
  assert.equal(scoreSummary(await readStats('/work/other', env)).answered, 0, 'Each repository keeps its own score');
  await collectGarbage({ env, now: Date.now() + 365 * 86400000 });
  assert.equal((await readStats(repoRoot, env)).answered, 5, 'Cleanup never removes the score');
});

const exec = promisify(execFile);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', ...args], { cwd, env: gitEnv });

test('one repository keeps one score across its worktrees and clones, and a shallow clone matches by its remote', async t => {
  const env = await home(t), base = await realpath(await mkdtemp(path.join(tmpdir(), 'sphinx-stats-repo-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const main = path.join(base, 'main');
  await exec('git', ['init', '-q', '-b', 'main', main]);
  await writeFile(path.join(main, 'a.txt'), 'a\n'); await git(main, 'add', '-A'); await git(main, 'commit', '-qm', 'first');
  await writeFile(path.join(main, 'a.txt'), 'b\n'); await git(main, 'commit', '-qam', 'second');
  await git(main, 'worktree', 'add', '-q', path.join(base, 'linked'));
  await git(base, 'clone', '-q', main, path.join(base, 'clone'));
  await recordAnswer({ repoRoot: main, correct: true, env });
  await recordAnswer({ repoRoot: path.join(base, 'linked'), correct: false, env });
  await recordAnswer({ repoRoot: path.join(base, 'clone'), correct: true, env });
  for (const checkout of ['main', 'linked', 'clone']) assert.deepEqual((await readStats(path.join(base, checkout), env)).recent, [true, false, true], checkout);
  assert.match(await repositoryKey(main, env), /^root:[0-9a-f]{40}$/);
  // A shallow clone may lack the root commit, so it is matched by its origin URL, however it is spelled.
  await git(base, 'clone', '-q', '--depth', '1', `file://${main}`, path.join(base, 'shallow'));
  await git(path.join(base, 'shallow'), 'remote', 'set-url', 'origin', 'git@github.com:Acme/Billing.git');
  assert.equal(await repositoryKey(path.join(base, 'shallow'), env), 'remote:github.com/acme/billing');
  // The score file never grows: it holds counters and the last ten answers.
  for (let i = 0; i < 30; i++) await recordAnswer({ repoRoot: main, correct: true, env });
  const stored = await readStats(main, env);
  assert.deepEqual([stored.answered, stored.recent.length], [33, 10]);
  assert.deepEqual((await readdir(env.SPHINX_HOME + '/stats')).sort(), [path.basename(statsFile(stored.key, env)), 'keys.json'].sort());
});

test('scores that older Sphinx kept per checkout folder are added up into the repository’s score once', async t => {
  const env = await home(t), base = await realpath(await mkdtemp(path.join(tmpdir(), 'sphinx-stats-repo-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const main = path.join(base, 'main'), linked = path.join(base, 'linked');
  await exec('git', ['init', '-q', '-b', 'main', main]);
  await writeFile(path.join(main, 'a.txt'), 'a\n'); await git(main, 'add', '-A'); await git(main, 'commit', '-qm', 'first');
  await git(main, 'worktree', 'add', '-q', linked);
  const { createHash } = await import('node:crypto');
  const legacy = async (repoRoot, stats) => {
    const { writeJson } = await import('../src/config.js');
    await writeJson(path.join(env.SPHINX_HOME, 'stats', `${createHash('sha256').update(repoRoot).digest('hex')}.json`), { version: 1, repoRoot, ...stats });
  };
  await legacy(main, { answered: 4, firstTry: 3, streak: 1, bestStreak: 3, completed: 2, skipped: 1, recent: [true, true, false, true], updatedAt: '2026-10-01T00:00:00.000Z' });
  await legacy(linked, { answered: 2, firstTry: 2, streak: 2, bestStreak: 2, completed: 1, skipped: 0, recent: [true, true], updatedAt: '2026-10-05T00:00:00.000Z' });
  await legacy('/gone/elsewhere', { answered: 9, firstTry: 9, streak: 9, bestStreak: 9, completed: 9, skipped: 0, recent: [], updatedAt: '2026-10-09T00:00:00.000Z' });
  const stats = await readStats(linked, env);
  assert.deepEqual([stats.answered, stats.firstTry, stats.completed, stats.skipped, stats.bestStreak, stats.streak, stats.recent], [6, 5, 3, 1, 3, 2, [true, true]]);
  assert.equal((await readdir(path.join(env.SPHINX_HOME, 'stats'))).length, 3, 'the two adopted files are gone; another repository’s stays; keys.json');
  assert.equal((await readStats(main, env)).answered, 6, 'read again, nothing is counted twice');
});
