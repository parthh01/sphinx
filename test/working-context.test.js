import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, getPaths, writeJson, readJson } from '../src/config.js';
import { curateContext, curateQuietly, briefFor, dropContext, contextFile } from '../src/working-context.js';
import { collectGarbage, storageUsage } from '../src/storage.js';

async function repo(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sphinx-context-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo');
  await mkdir(root);
  const env = { PATH: process.env.PATH, HOME: dir, SPHINX_USER_HOME: dir, SPHINX_HOME: path.join(dir, '.sphinx'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, '.gitconfig'), OPENROUTER_API_KEY: 'test-key' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.invalid');
  await writeFile(path.join(root, 'app.js'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
  const commit = async (files, message) => { for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); } git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  const realRoot = git('rev-parse', '--show-toplevel');
  return { dir, root: realRoot, env, git, commit, base: git('rev-parse', 'HEAD'), config: structuredClone(DEFAULT_CONFIG) };
}
const SOURCE = 'refs/heads/main';

test('curation sends only unseen filtered diffs, updates one context, and starts over after a rewrite', async t => {
  const r = await repo(t);
  const prompts = [];
  let reply = { overview: 'Adds retries to the worker.', items: [{ kind: 'map', text: 'worker.js wraps jobs in retry()', files: ['worker.js'] }, { kind: 'watch', text: 'retry count', files: ['retry.js'] }] };
  const call = async ({ prompt, config }) => { prompts.push({ prompt, config }); return reply; };
  const first = await r.commit({ 'worker.js': 'retry(job);\n', 'retry.js': 'export const retry = f => f();\n', '.env': 'SECRET=hunter2\n' }, 'add retry');
  assert.equal((await curateContext({ repoRoot: r.root, sourceRef: SOURCE, base: r.base, head: first, config: r.config, env: r.env, call })).status, 'updated');
  assert.match(prompts[0].prompt, /worker\.js/);
  assert.doesNotMatch(prompts[0].prompt, /hunter2|\.env/, 'Ignored credential files are never sent');
  assert.deepEqual([prompts[0].config.provider, prompts[0].config.model], [r.config.models.small.provider, r.config.models.small.model], 'The curator uses the small-change model the user chose');
  assert.equal((await curateContext({ repoRoot: r.root, sourceRef: SOURCE, base: r.base, head: first, config: r.config, env: r.env, call })).status, 'current');
  assert.equal(prompts.length, 1, 'No call when the context is already current');

  const second = await r.commit({ 'retry.js': 'export const retry = (f, n = 3) => f();\n' }, 'limit retries');
  await curateContext({ repoRoot: r.root, sourceRef: SOURCE, base: r.base, head: second, config: r.config, env: r.env, call });
  assert.match(prompts[1].prompt, /CURRENT CONTEXT \(DATA\): \{"overview":"Adds retries/, 'The curator edits the existing context');
  assert.doesNotMatch(prompts[1].prompt, /worker\.js b\/worker\.js/, 'Only the new diff is sent');

  r.git('reset', '-q', '--hard', r.base);
  const rewritten = await r.commit({ 'other.js': 'x\n' }, 'different work');
  reply = { overview: 'Different work.', items: [] };
  await curateContext({ repoRoot: r.root, sourceRef: SOURCE, base: r.base, head: rewritten, config: r.config, env: r.env, call });
  assert.match(prompts[2].prompt, /CURRENT CONTEXT \(DATA\): \{"overview":"","items":\[\]\}/, 'A rewrite starts from scratch');
});

test('a file named like a pathspec pattern or magic never pulls an excluded file into the curated diff', async t => {
  const r = await repo(t);
  const prompts = [];
  const call = async ({ prompt }) => { prompts.push(prompt); return { overview: 'Odd names.', items: [] }; };
  // As patterns, '*' and ':(glob)**' would match every changed path, .env included.
  const head = await r.commit({ '*': 'star\n', ':(glob)**': 'magic\n', '.env': 'SECRET=hunter2\n' }, 'odd names');
  assert.equal((await curateContext({ repoRoot: r.root, sourceRef: SOURCE, base: r.base, head, config: r.config, env: r.env, call })).status, 'updated');
  assert.match(prompts[0], /\+star/);
  assert.match(prompts[0], /\+magic/);
  assert.doesNotMatch(prompts[0], /hunter2|\.env/, 'Ignored credential files are never sent');
});

test('the brief withholds items whose files changed after curation, and curation can be turned off', async t => {
  const r = await repo(t);
  const head = await r.commit({ 'worker.js': 'retry(job);\n', 'retry.js': 'export const retry = f => f();\n' }, 'add retry');
  const call = async () => ({ overview: 'Adds retries.', items: [{ kind: 'map', text: 'worker calls retry', files: ['worker.js'] }, { kind: 'watch', text: 'retry has no limit', files: ['retry.js'] }] });
  await curateContext({ repoRoot: r.root, sourceRef: SOURCE, base: r.base, head, config: r.config, env: r.env, call });
  const later = await r.commit({ 'retry.js': 'export const retry = (f, n) => f();\n' }, 'uncurated change');
  const brief = await briefFor({ repoRoot: r.root, sourceRef: SOURCE, head: later, env: r.env });
  assert.deepEqual(brief.items.map(item => item.text), ['worker calls retry'], 'Later work replaced retry.js, so its note is withheld');
  assert.equal(brief.withheld, 1);
  assert.equal((await curateContext({ repoRoot: r.root, sourceRef: SOURCE, base: r.base, head: later, config: { ...r.config, workingContext: false }, env: r.env, call })).status, 'unavailable');
  await dropContext({ repoRoot: r.root, sourceRef: SOURCE, env: r.env });
  assert.equal(await briefFor({ repoRoot: r.root, sourceRef: SOURCE, head: later, env: r.env }), null);
});

test('a rate limit waits once for the provider hint, then gives up quietly', async t => {
  const r = await repo(t);
  const head = await r.commit({ 'a.js': '1\n' }, 'a');
  const waits = [];
  let calls = 0;
  const limited = async () => { calls++; throw Object.assign(new Error('429'), { status: 429, retryAfterSeconds: 7 }); };
  const result = await curateQuietly({ repoRoot: r.root, sourceRef: SOURCE, base: r.base, head, config: r.config, env: r.env, call: limited, wait: async ms => { waits.push(ms); } });
  assert.deepEqual([result.status, calls, waits], ['rate_limited', 2, [7000]]);
  const broken = await curateQuietly({ repoRoot: r.root, sourceRef: SOURCE, base: r.base, head, config: r.config, env: r.env, call: async () => { throw new Error('boom'); }, wait: async () => {} });
  assert.equal(broken.status, 'failed');
});

test('cleanup removes expired, skipped, abandoned, and stale data, keeps recent work, and enforces the size cap', async t => {
  const r = await repo(t);
  const home = getPaths(r.env).home, sessions = path.join(home, 'sessions');
  const now = Date.now(), old = (days) => new Date(now - days * 86400000);
  const write = async (name, value, days) => { const file = path.join(sessions, name); await writeJson(file, value); await utimes(file, old(days), old(days)); return file; };
  await write('a'.repeat(64) + '.json', { status: 'passed', expiresAt: old(1).toISOString() }, 2);
  await write('b'.repeat(64) + '.json', { status: 'skipped' }, 2);
  await write('c'.repeat(64) + '.json', { status: 'pending' }, 8);
  await write('d'.repeat(64) + '.json', { status: 'pending' }, 2);
  await write('e'.repeat(64) + '.json', { status: 'passed', expiresAt: new Date(now + 86400000).toISOString() }, 0.5);
  const stale = contextFile('/no/such/repo', SOURCE, r.env); await writeJson(stale, { repoRoot: '/no/such/repo' });
  await collectGarbage({ env: r.env, now });
  assert.deepEqual((await readdir(sessions)).sort(), ['d'.repeat(64) + '.json', 'e'.repeat(64) + '.json']);
  assert.equal(await readJson(stale, null), null, 'Contexts for repositories that no longer exist are removed');
  await writeJson(path.join(home, 'config.json'), { keep: true });
  const big = await write('f'.repeat(64) + '.json', { status: 'pending', pad: 'x'.repeat(4000) }, 0.1 + 2);
  await collectGarbage({ env: r.env, now, cap: 1000 });
  assert.equal(await readJson(big, null), null, 'The size cap removes the oldest removable data');
  assert.deepEqual(await readJson(path.join(home, 'config.json'), null), { keep: true }, 'Settings are never removed');
  assert.ok(await storageUsage(r.env) > 0);
});
