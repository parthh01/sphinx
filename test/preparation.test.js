import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, getPaths } from '../src/config.js';
import { pushSnapshots, repository } from '../src/git.js';
import { toggleYolo } from '../src/overrides.js';
import { preparationStatus, runPreparation, schedulePreparation } from '../src/preparation.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sphinx-preparation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home'), cwd = path.join(directory, 'repo');
  await mkdir(home); await mkdir(cwd);
  const env = { ...process.env, HOME: home, SPHINX_USER_HOME: home, SPHINX_HOME: path.join(home, '.sphinx'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  // Background curation calls OpenRouter when a key exists; tests stay offline.
  delete env.OPENROUTER_API_KEY;
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'SPHINX_EVALUATOR', 'SPHINX_PREPARATION_JOB']) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Sphinx Test'); git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(cwd, 'app.js'), 'export const count = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const remoteUrl = 'https://must-not-contact.invalid/repo.git';
  git('remote', 'add', 'origin', remoteUrl); git('update-ref', 'refs/remotes/origin/main', base);
  git('branch', '--set-upstream-to=origin/main', 'main');
  await writeFile(path.join(cwd, 'app.js'), 'export const count = 2;\n'); git('commit', '-qam', 'change');
  const config = { ...structuredClone(DEFAULT_CONFIG), backgroundPreparation: true, preparationDebounceMs: 0 };
  const launches = [];
  const spawnImpl = (...args) => {
    launches.push(args);
    const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {};
    queueMicrotask(() => child.emit('spawn')); return child;
  };
  const generated = [], ensured = [];
  const store = { ensure: async snapshot => { ensured.push(snapshot); return { id: snapshot.id }; }, prepare: async id => { generated.push(id); } };
  const options = { cwd, env, config, cliPath: path.join(directory, 'sphinx.js'), spawnImpl };
  return { directory, cwd, env, config, git, base, remoteUrl, launches, generated, ensured, store, options };
}

test('schedules one detached worker and prepares the exact local-tracking push identity without networking', async t => {
  const f = await fixture(t);
  const scheduled = await schedulePreparation(f.options);
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(f.generated.length, 0, 'Scheduling does not call the evaluator');
  assert.equal(f.launches.length, 1);
  const [command, args, launch] = f.launches[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [f.options.cliPath, 'prepare', '--worker']);
  assert.equal(launch.detached, true); assert.equal(launch.stdio, 'ignore');
  assert.equal(launch.env.SPHINX_PREPARATION_JOB, scheduled.jobId);
  assert.equal((await schedulePreparation(f.options)).status, 'existing');
  const ready = await runPreparation({ ...f.options, store: f.store });
  assert.equal(ready.status, 'ready'); assert.equal(f.generated.length, 1);
  const [actualPush] = await pushSnapshots({ cwd: f.cwd, env: f.env, config: f.config, remote: 'origin', remoteUrl: f.remoteUrl,
    input: `refs/heads/main ${f.git('rev-parse', 'HEAD')} refs/heads/main ${f.base}\n` });
  assert.equal(f.generated[0], actualPush.id);
  assert.deepEqual(ready.prepared, [actualPush.id]);
  assert.deepEqual(f.ensured[0].target, actualPush.target);
  assert.equal((await preparationStatus(f.options)).status, 'ready');
  await schedulePreparation(f.options); await runPreparation({ ...f.options, store: f.store });
  assert.equal(f.launches.length, 1); assert.equal(f.generated.length, 1);
  const [stateDirectory] = await readdir(path.join(getPaths(f.env).home, 'preparations'));
  const records = path.join(getPaths(f.env).home, 'preparations', stateDirectory);
  for (const file of await readdir(records)) assert.equal((await stat(path.join(records, file))).mode & 0o777, 0o600);
});

test('parallel scheduling and workers coalesce before evaluator work', async t => {
  const f = await fixture(t);
  const jobs = await Promise.all([schedulePreparation(f.options), schedulePreparation(f.options), schedulePreparation(f.options)]);
  assert.equal(jobs.filter(job => job.status === 'scheduled').length, 1);
  let release;
  const running = new Promise(resolve => { release = resolve; });
  f.store.prepare = async id => { f.generated.push(id); await running; };
  const first = runPreparation({ ...f.options, store: f.store });
  for (let attempt = 0; attempt < 50 && !f.generated.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  const second = await runPreparation({ ...f.options, store: f.store });
  assert.equal(second.status, 'existing');
  release(); assert.equal((await first).status, 'ready'); assert.equal(f.generated.length, 1);
});

test('debounced worker checks HEAD again and spends no evaluator call on stale work', async t => {
  const f = await fixture(t); f.config.preparationDebounceMs = 60000;
  await schedulePreparation(f.options);
  let waits = 0;
  const stale = await runPreparation({ ...f.options, store: f.store, wait: async ms => {
    assert.ok(ms > 0); waits++;
    await writeFile(path.join(f.cwd, 'app.js'), 'export const count = 3;\n'); f.git('commit', '-qam', 'newer');
  } });
  assert.equal(waits, 1); assert.equal(stale.status, 'stale'); assert.equal(f.generated.length, 0);
  assert.equal((await schedulePreparation(f.options)).status, 'scheduled');
});

test('a newer job supersedes its predecessor and stale jobs can be rescheduled without retrying failures', async t => {
  const f = await fixture(t);
  const oldHead = f.git('rev-parse', 'HEAD'), first = await schedulePreparation(f.options);
  await writeFile(path.join(f.cwd, 'app.js'), 'export const count = 3;\n'); f.git('commit', '-qam', 'newer');
  const second = await schedulePreparation(f.options);
  assert.notEqual(first.jobId, second.jobId);
  const old = await runPreparation({ ...f.options, store: f.store, env: { ...f.env, SPHINX_PREPARATION_JOB: first.jobId } });
  assert.equal(old.status, 'skipped'); assert.equal(f.generated.length, 0);
  f.git('reset', '--hard', oldHead);
  assert.equal((await schedulePreparation(f.options)).status, 'scheduled');
});

test('changed policy, exclusions, project context, and remote-tracking history invalidate scheduled work', async t => {
  for (const change of ['policy', 'ignore', 'context', 'tracking']) {
    const f = await fixture(t); await schedulePreparation(f.options);
    if (change === 'policy') f.config.level = 'thorough';
    if (change === 'ignore') await writeFile(path.join(f.cwd, '.sphinxignore'), '# changed policy\n');
    if (change === 'context') await writeFile(path.join(f.cwd, '.sphinxcontext.md'), 'An exported count supports a reporting workflow.\n');
    if (change === 'tracking') f.git('update-ref', 'refs/remotes/origin/main', f.git('rev-parse', 'HEAD'));
    assert.equal((await runPreparation({ ...f.options, store: f.store })).status, 'stale');
    assert.equal(f.generated.length, 0);
  }
});

test('failed preparation is recorded safely and only an explicit retry spends another attempt', async t => {
  const f = await fixture(t); let attempts = 0;
  f.store.prepare = async () => { attempts++; throw new Error('provider-body-private-source SECRET_SENTINEL'); };
  await schedulePreparation(f.options);
  assert.equal((await runPreparation({ ...f.options, store: f.store })).status, 'failed');
  const status = await preparationStatus(f.options);
  assert.match(status.error, /sphinx prepare --retry/);
  assert.ok(!JSON.stringify(status).includes('SECRET_SENTINEL'));
  assert.equal((await schedulePreparation(f.options)).state, 'failed');
  await runPreparation({ ...f.options, store: f.store }); assert.equal(attempts, 1);
  assert.equal((await schedulePreparation({ ...f.options, retry: true })).status, 'scheduled');
  await runPreparation({ ...f.options, store: f.store }); assert.equal(attempts, 2);
});

test('evaluator subprocesses, disabled policy, and detached HEAD never schedule', async t => {
  const f = await fixture(t);
  assert.equal((await schedulePreparation({ ...f.options, env: { ...f.env, SPHINX_EVALUATOR: '1' } })).status, 'skipped');
  for (const override of [{ backgroundPreparation: false }, { enabled: false }, { events: ['pre-commit'] }, { branches: ['release/*'] }, { remotes: ['upstream'] }]) {
    assert.equal((await schedulePreparation({ ...f.options, config: { ...f.config, ...override } })).status, 'skipped');
  }
  f.git('checkout', '--detach', '-q');
  assert.equal((await schedulePreparation(f.options)).status, 'skipped'); assert.equal(f.launches.length, 0);
});

// What the pre-push hook receives for a destination the remote lacks, as from git push -u origin HEAD.
const firstPush = (f, ref) => {
  const head = f.git('rev-parse', 'HEAD');
  return pushSnapshots({ cwd: f.cwd, env: f.env, config: f.config, remote: 'origin', remoteUrl: f.remoteUrl, input: `HEAD ${head} ${ref} ${'0'.repeat(head.length)}\n` });
};

test('a first push is prepared from the branch point the push checkpoint uses', async t => {
  const f = await fixture(t); f.config.branches = ['*'];
  f.git('checkout', '-q', '-b', 'feature');
  await schedulePreparation(f.options);
  const ready = await runPreparation({ ...f.options, store: f.store });
  const [actualPush] = await firstPush(f, 'refs/heads/feature');
  assert.deepEqual(ready.prepared, [actualPush.id]);
  assert.equal(f.ensured[0].base, f.base); assert.deepEqual(f.ensured[0].files, ['app.js']);
  // With no checked branch on the remote yet, the push checkpoint assesses the whole tree, and so does preparation.
  f.git('checkout', '-q', 'main'); f.git('update-ref', '-d', 'refs/remotes/origin/main');
  await schedulePreparation(f.options);
  const whole = await runPreparation({ ...f.options, store: f.store });
  const [wholePush] = await firstPush(f, 'refs/heads/main');
  assert.deepEqual(whole.prepared, [wholePush.id]); assert.equal(wholePush.base, null);
});

test('a branch made from origin/main prepares its push to the same-named branch, not to main', async t => {
  const f = await fixture(t);
  f.git('checkout', '-q', '-b', 'feature', '--track', 'origin/main');
  await writeFile(path.join(f.cwd, 'app.js'), 'export const count = 3;\n'); f.git('commit', '-qam', 'feature');
  // Only main is checked by default, and this branch's push never goes there.
  assert.equal((await schedulePreparation(f.options)).status, 'skipped');
  f.config.branches = ['*'];
  await schedulePreparation(f.options);
  const ready = await runPreparation({ ...f.options, store: f.store });
  const [actualPush] = await firstPush(f, 'refs/heads/feature');
  assert.deepEqual(ready.prepared, [actualPush.id]);
  assert.equal(actualPush.base, f.base);
  // push.default upstream is the one setting under which git push does go to main.
  f.git('config', 'push.default', 'upstream');
  await schedulePreparation(f.options); await runPreparation({ ...f.options, store: f.store });
  assert.equal(f.ensured.at(-1).target.ref, 'refs/heads/main'); assert.equal(f.ensured.at(-1).base, f.base);
});

test('the prediction follows push mappings and URLs, and skips a destination it cannot know', async t => {
  const f = await fixture(t); f.config.branches = ['*'];
  const prepare = async () => { await schedulePreparation(f.options); return runPreparation({ ...f.options, store: f.store }); };
  // push.default nothing: plain git push names no destination.
  f.git('config', 'push.default', 'nothing');
  assert.equal((await schedulePreparation(f.options)).status, 'skipped');
  f.git('config', '--unset', 'push.default'); f.git('checkout', '-q', '-b', 'feature');
  // remote.<name>.push sends the branch to another name, here for the first time.
  f.git('config', 'remote.origin.push', 'refs/heads/feature:refs/heads/team/feature');
  await prepare();
  assert.equal(f.ensured.at(-1).target.ref, 'refs/heads/team/feature'); assert.equal(f.ensured.at(-1).base, f.base);
  f.git('config', '--unset', 'remote.origin.push');
  // A first push to two URLs: once the first takes it, Git writes the tracking ref and the second has nothing to check.
  f.git('config', '--add', 'remote.origin.pushurl', f.remoteUrl);
  f.git('config', '--add', 'remote.origin.pushurl', 'https://mirror-never-contact.invalid/repo.git');
  assert.equal((await prepare()).prepared.length, 1); assert.equal(f.ensured.at(-1).target.url, f.remoteUrl);
  // Once the branch is there, each URL is checked from where it stands.
  f.git('update-ref', 'refs/remotes/origin/feature', f.base);
  assert.equal((await prepare()).prepared.length, 2);
  // No fetch refspec covers the destination, so whether the remote has it is unknown.
  f.git('config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  assert.equal((await schedulePreparation(f.options)).status, 'skipped');
});

test('repository and global yolo pause background review without launching workers or creating checks', async t => {
  const f = await fixture(t), { root } = await repository(f.cwd);
  for (const repoRoot of [root, null]) {
    await toggleYolo({ repoRoot, env: f.env });
    const skipped = await schedulePreparation(f.options);
    assert.equal(skipped.status, 'skipped'); assert.match(skipped.reason, /Yolo mode is on/);
    assert.equal(await preparationStatus(f.options), null);
    await toggleYolo({ repoRoot, env: f.env });
  }
  assert.equal(f.launches.length, 0);
  assert.equal((await schedulePreparation(f.options)).status, 'scheduled');
});

test('an explicit repository yolo OFF keeps background review on while global yolo is on', async t => {
  const f = await fixture(t), { root } = await repository(f.cwd);
  await toggleYolo({ repoRoot: null, env: f.env });
  assert.equal((await schedulePreparation(f.options)).status, 'skipped');
  await toggleYolo({ repoRoot: root, env: f.env });
  assert.equal((await schedulePreparation(f.options)).status, 'scheduled');
  assert.equal((await runPreparation({ ...f.options, store: f.store })).status, 'ready');
  assert.equal(f.launches.length, 1); assert.equal(f.generated.length, 1);
});

test('turning yolo on supersedes an already scheduled worker before any reviewer call', async t => {
  const f = await fixture(t), scheduled = await schedulePreparation(f.options);
  await toggleYolo({ env: f.env });
  const result = await runPreparation({ ...f.options, store: f.store, env: { ...f.env, SPHINX_PREPARATION_JOB: scheduled.jobId } });
  assert.equal(result.status, 'stale');
  assert.equal(f.ensured.length, 0); assert.equal(f.generated.length, 0);
});

// The production validator compares against loaded settings, so persist them instead of injecting a config.
async function loadedOptions(f) {
  const file = getPaths(f.env).config;
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ preparationDebounceMs: 0 }));
  return { ...f.options, config: undefined };
}

const QUESTION = { id: 'count', concept: 'observable behavior', prompt: 'Does the exported count change from one to two?', expectedAnswer: 'Yes', rationale: 'The export changed.', evidence: [{ path: 'app.js', reason: 'The count is exported as two.' }] };

test('turning yolo on during a background review stops further reviewer requests', async t => {
  for (const scope of ['repo', 'global']) {
    const f = await fixture(t), { root } = await repository(f.cwd), repoRoot = scope === 'repo' ? root : null;
    let requests = 0;
    const generate = async (_snapshot, _config, { beforeCall }) => {
      await beforeCall(); requests++;
      await toggleYolo({ repoRoot, env: f.env });
      await beforeCall(); requests++;
      await beforeCall(); requests++;
      return { questions: [QUESTION] };
    };
    const options = await loadedOptions(f);
    await schedulePreparation(options);
    const result = await runPreparation({ ...options, generate });
    assert.equal(result.status, 'stale', scope); assert.equal(requests, 1, scope);
    const { createSessionStore } = await import('../src/sessions.js');
    const [session, ...others] = await createSessionStore({ env: f.env }).pending(root);
    assert.equal(others.length, 0, scope);
    // The started request is kept as resumable progress, never as a ready check.
    assert.equal(session.calls, 1, scope); assert.equal(session.questions.length, 0, scope); assert.notEqual(session.status, 'active', scope);
  }
});

test('turning yolo on after a check is created removes it before any reviewer request', async t => {
  const { createSessionStore } = await import('../src/sessions.js');
  const f = await fixture(t), { root } = await repository(f.cwd);
  const real = createSessionStore({ env: f.env, generate: async () => assert.fail('No reviewer request is expected.') });
  const store = { ...real, ensure: async (...args) => { const session = await real.ensure(...args); await toggleYolo({ repoRoot: root, env: f.env }); return session; } };
  const options = await loadedOptions(f);
  await schedulePreparation(options);
  assert.equal((await runPreparation({ ...options, store })).status, 'stale');
  assert.deepEqual(await real.pending(root), []);
});

test('push remote configuration predicts a destination independently of the upstream remote', async t => {
  const f = await fixture(t);
  f.git('remote', 'add', 'publish', 'https://also-never-contact.invalid/repo.git');
  f.git('config', 'branch.main.pushRemote', 'publish');
  f.git('update-ref', 'refs/remotes/publish/main', f.base);
  await schedulePreparation(f.options); await runPreparation({ ...f.options, store: f.store });
  assert.equal(f.ensured[0].target.remote, 'publish');
});

test('a branch without an upstream can prepare its locally tracked same-name destination', async t => {
  const f = await fixture(t); f.git('branch', '--unset-upstream', 'main');
  assert.equal((await schedulePreparation(f.options)).status, 'scheduled');
  assert.equal((await runPreparation({ ...f.options, store: f.store })).status, 'ready');
});

test('worker launch errors are retained without automatic retries', async t => {
  const f = await fixture(t); let launches = 0;
  const spawnImpl = () => { launches++; const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('SECRET_SENTINEL'))); return child; };
  assert.equal((await schedulePreparation({ ...f.options, spawnImpl })).status, 'failed');
  assert.equal((await schedulePreparation({ ...f.options, spawnImpl })).state, 'failed');
  assert.equal(launches, 1); assert.ok(!JSON.stringify(await preparationStatus(f.options)).includes('SECRET_SENTINEL'));
});

test('turning preparation off supersedes scheduled work and clears current preparation status', async t => {
  const f = await fixture(t), scheduled = await schedulePreparation(f.options);
  assert.equal((await preparationStatus(f.options)).status, 'scheduled');
  f.config.backgroundPreparation = false;
  assert.equal((await schedulePreparation(f.options)).status, 'skipped');
  assert.equal(await preparationStatus(f.options), null);
  assert.equal((await runPreparation({ ...f.options, store: f.store, env: { ...f.env, SPHINX_PREPARATION_JOB: scheduled.jobId } })).status, 'skipped');
  assert.equal(f.generated.length, 0);
});

test('status reports a dead worker as interrupted without launching a replacement', async t => {
  const f = await fixture(t), scheduled = await schedulePreparation(f.options);
  const directories = await readdir(path.join(getPaths(f.env).home, 'preparations'));
  const file = path.join(getPaths(f.env).home, 'preparations', directories[0], `${scheduled.jobId}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.status = 'running'; record.pid = 2147483647;
  await writeFile(file, JSON.stringify(record));
  const status = await preparationStatus(f.options);
  assert.equal(status.status, 'failed'); assert.match(status.error, /stopped before finishing/);
  assert.equal(f.launches.length, 1); assert.equal(f.generated.length, 0);
  assert.equal((await schedulePreparation(f.options)).state, 'failed');
  assert.equal(f.launches.length, 1);
});

test('workers populate the session cache without approval and foreground start reuses it', async t => {
  const { createSessionStore } = await import('../src/sessions.js');
  const f = await fixture(t); let generations = 0;
  const store = createSessionStore({ env: f.env, generate: async (_snapshot, _config, options) => {
    await options.beforeCall();
    generations++;
    return { questions: [{ id: 'count', concept: 'observable behavior', prompt: 'Does the exported count change from one to two?', expectedAnswer: 'Yes', rationale: 'The export changed.', evidence: [{ path: 'app.js', reason: 'The count is exported as two.' }] }] };
  } });
  await schedulePreparation(f.options);
  const ready = await runPreparation({ ...f.options, store });
  assert.equal(ready.status, 'ready');
  const [id] = ready.prepared, session = await store.read(id);
  assert.equal(session.status, 'active'); assert.equal(session.index, 0); assert.equal(session.expiresAt, null);
  assert.equal(await store.approved(session.snapshot, f.config), false);
  const foreground = await store.start(id, f.config);
  assert.equal(foreground.question.id, 'count'); assert.equal(generations, 1);
});

test('saving a new default model keeps a prepared check, and the push reuses its questions', async t => {
  const { createSessionStore } = await import('../src/sessions.js');
  const { loadConfig, saveConfig } = await import('../src/config.js');
  const f = await fixture(t), { root } = await repository(f.cwd); let generations = 0;
  const store = createSessionStore({ env: f.env, generate: async (_snapshot, _config, { beforeCall }) => { await beforeCall(); generations++; return { questions: [QUESTION] }; } });
  const options = await loadedOptions(f);
  await schedulePreparation(options);
  const [id] = (await runPreparation({ ...options, store })).prepared;
  // What the questionnaire saves when it closes after a model was picked as the default.
  const sonnet = { provider: 'claude', model: 'sonnet' };
  await saveConfig({ ...await loadConfig(undefined, f.env), models: { small: sonnet, medium: sonnet, large: sonnet } }, f.env);
  assert.equal((await schedulePreparation(options)).status, 'existing', 'no second background review');
  const config = await loadConfig(root, f.env);
  const [push] = await pushSnapshots({ cwd: f.cwd, env: f.env, config, remote: 'origin', remoteUrl: f.remoteUrl, input: `refs/heads/main ${f.git('rev-parse', 'HEAD')} refs/heads/main ${f.base}\n` });
  assert.equal(push.id, id, 'the push checkpoint has the prepared identity');
  assert.equal((await store.ensure(push, config)).status, 'active');
  assert.equal((await store.start(id, config)).question.id, QUESTION.id);
  assert.equal(generations, 1, 'the prepared questions are reused');
});

test('a worker that finds nothing to ask records that without approval; only a started check passes, with no new review', async t => {
  const { createSessionStore } = await import('../src/sessions.js');
  const f = await fixture(t); let generations = 0;
  const store = createSessionStore({ env: f.env, generate: async (_snapshot, _config, options) => {
    await options.beforeCall(); generations++;
    return { questions: [], noQuestionReason: 'Only changes an exported constant from one to two.' };
  } });
  await schedulePreparation(f.options);
  const [id] = (await runPreparation({ ...f.options, store })).prepared, session = await store.read(id);
  assert.equal(session.status, 'pending'); assert.equal(session.expiresAt, null);
  assert.equal(await store.approved(session.snapshot, f.config), false, 'a waiting push still opens the check, which asks before it continues');
  assert.equal(store.public(session).noQuestionReason, undefined);
  const started = await store.start(id, f.config);
  assert.equal(started.status, 'passed'); assert.equal(started.noQuestionReason, 'Only changes an exported constant from one to two.');
  assert.equal(generations, 1);
});

test('the background worker curates the working context once before preparing, with the push range', async t => {
  const f = await fixture(t);
  const curated = [];
  await schedulePreparation(f.options);
  const env = { ...f.env, OPENROUTER_API_KEY: 'test-key' };
  const ready = await runPreparation({ ...f.options, env, store: f.store, curate: async ({ prompt, config }) => { curated.push({ prompt, model: config.model }); return { overview: 'Bumps the count.', items: [] }; } });
  assert.equal(ready.status, 'ready');
  assert.equal(curated.length, 1);
  assert.equal(curated[0].model, f.config.models.small.model);
  assert.match(curated[0].prompt, /count = 2/, 'The curator sees the unpushed change');
});
