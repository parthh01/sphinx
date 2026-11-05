import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getPaths, readJson, writeJson } from './config.js';

// A small per-repository understanding score that lasts as long as the repository. Checks are cleaned up after a
// day, so the score keeps its own counters: questions answered correctly on the first try, questions answered, the
// current first-try streak, and how many checks were completed or skipped. One fixed-size file per repository,
// shared by all its clones and worktrees (see repositoryKey). Updates are best-effort.
export const CALIBRATION_QUESTIONS = 5;
const RECENT = 10;
const digest = value => createHash('sha256').update(value).digest('hex');
const statsDir = env => path.join(getPaths(env).home, 'stats');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const run = promisify(execFile);

// A remote URL without its scheme, user, port separator or .git, so https and SSH spellings of one repository agree.
const normalizeUrl = url => url.trim().replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):(?!\d+\/)/, '$1/').replace(/\.git\/?$/, '').replace(/\/+$/, '').toLowerCase();

/**
 * Which repository a checkout belongs to, the same in every clone and worktree of it: its root commit, else (in a
 * shallow clone, which may lack it) its origin URL, else Git's shared directory, else the folder itself.
 * The answer for each Git directory is kept in stats/keys.json, so the history walk runs once per clone.
 */
export async function repositoryKey(repoRoot, env = process.env) {
  const git = args => run('git', ['-C', repoRoot, ...args], { timeout: 30000, maxBuffer: 1024 * 1024 }).then(result => result.stdout.trim(), () => '');
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return `path:${repoRoot}`;
  const keysFile = path.join(statsDir(env), 'keys.json'), keys = await readJson(keysFile, {}).catch(() => ({}));
  if (typeof keys[common] === 'string') return keys[common];
  let key = null;
  if (await git(['rev-parse', '--is-shallow-repository']) === 'false') {
    const roots = (await git(['rev-list', '--max-parents=0', 'HEAD'])).split('\n').filter(Boolean).sort();
    if (roots.length) key = `root:${roots[0]}`;
  }
  if (!key) { const url = await git(['config', '--get', 'remote.origin.url']); if (url) key = `remote:${normalizeUrl(url)}`; }
  key ??= `git:${common}`;
  // Only a root commit is final: a shallow clone may deepen, and an empty repository gets its first commit.
  if (key.startsWith('root:')) await writeJson(keysFile, { ...keys, [common]: key }).catch(() => {});
  return key;
}

export const statsFile = (key, env = process.env) => path.join(statsDir(env), `${digest(key)}.json`);

const fields = stored => ({
  answered: count(stored?.answered), firstTry: count(stored?.firstTry), streak: count(stored?.streak), bestStreak: count(stored?.bestStreak),
  completed: count(stored?.completed), skipped: count(stored?.skipped), updatedAt: stored?.updatedAt ?? null,
  recent: Array.isArray(stored?.recent) ? stored.recent.filter(item => typeof item === 'boolean').slice(-RECENT) : [],
});

// Older Sphinx kept one file per checkout folder (with repoRoot and no key). The first read under a repository's key adds
// up the files of its checkouts that still exist, then removes them. The current streak and recent answers come from
// the newest one.
async function adoptLegacy(key, env) {
  const dir = statsDir(env), merged = fields(null), adopted = [];
  for (const name of await readdir(dir).catch(() => [])) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const stored = await readJson(path.join(dir, name), null).catch(() => null);
    if (!stored || stored.key !== undefined || typeof stored.repoRoot !== 'string' || await repositoryKey(stored.repoRoot, env) !== key) continue;
    const old = fields(stored);
    for (const field of ['answered', 'firstTry', 'completed', 'skipped']) merged[field] += old[field];
    merged.bestStreak = Math.max(merged.bestStreak, old.bestStreak);
    if (!merged.updatedAt || (old.updatedAt && old.updatedAt > merged.updatedAt)) Object.assign(merged, { streak: old.streak, recent: old.recent, updatedAt: old.updatedAt });
    adopted.push(path.join(dir, name));
  }
  if (!adopted.length) return null;
  await writeJson(statsFile(key, env), { version: 1, key, ...merged });
  for (const file of adopted) if (file !== statsFile(key, env)) await unlink(file).catch(() => {});
  return merged;
}

export async function readStats(repoRoot, env = process.env) {
  const key = await repositoryKey(repoRoot, env);
  const stored = await readJson(statsFile(key, env), null).catch(() => null) ?? await adoptLegacy(key, env).catch(() => null);
  return { version: 1, key, ...fields(stored) };
}

async function update(repoRoot, env, change) {
  try {
    const stats = change(await readStats(repoRoot, env));
    await writeJson(statsFile(stats.key, env), { ...stats, updatedAt: new Date().toISOString() });
  } catch { /* The score never affects a check. */ }
}

/** One question's first graded answer: correct on the first try, or not. */
export const recordAnswer = ({ repoRoot, correct, env = process.env }) => update(repoRoot, env, stats => {
  const streak = correct ? stats.streak + 1 : 0;
  return { ...stats, answered: stats.answered + 1, firstTry: stats.firstTry + (correct ? 1 : 0), streak, bestStreak: Math.max(stats.bestStreak, streak), recent: [...stats.recent, Boolean(correct)].slice(-RECENT) };
});

/** A check that asked questions was completed, or the human skipped it. */
export const recordCheck = ({ repoRoot, outcome, env = process.env }) => update(repoRoot, env, stats => ({
  ...stats, completed: stats.completed + (outcome === 'completed' ? 1 : 0), skipped: stats.skipped + (outcome === 'skipped' ? 1 : 0),
}));

/** What the questionnaire and CLI show. Accuracy stays hidden while calibrating. */
export function scoreSummary(stats) {
  const calibrating = stats.answered < CALIBRATION_QUESTIONS;
  const checks = stats.completed + stats.skipped;
  return {
    calibrating, answered: stats.answered, needed: Math.max(0, CALIBRATION_QUESTIONS - stats.answered),
    accuracy: calibrating ? null : Math.round((stats.firstTry / stats.answered) * 100),
    streak: stats.streak, bestStreak: stats.bestStreak,
    skipRate: checks ? Math.round((stats.skipped / checks) * 100) : null, checks,
    recent: stats.recent,
  };
}
