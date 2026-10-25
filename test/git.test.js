import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commitSnapshot, manualSnapshot, matches, pushSnapshots, repository, revalidateSnapshot } from '../src/git.js';

const exec = promisify(execFile);
const home = await mkdtemp(join(tmpdir(), 'sphinx-git-home-'));
const previousHome = process.env.SPHINX_HOME;
process.env.SPHINX_HOME = home;
after(async () => {
  if (previousHome === undefined) delete process.env.SPHINX_HOME;
  else process.env.SPHINX_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const defaults = {
  version: 1, enabled: true, provider: 'auto', model: null, level: 'standard', mode: 'block',
  events: ['pre-push', 'pre-commit'], branches: ['main', 'master'], remotes: ['*'], exclude: [],
  maxContextBytes: 120000, timeoutSeconds: 180, receiptHours: 24,
};
const zero = '0'.repeat(40);

async function command(cwd, ...args) {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  return stdout.trim();
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'sphinx-git-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await command(cwd, 'init', '-b', 'main');
  await command(cwd, 'config', 'user.name', 'Sphinx test');
  await command(cwd, 'config', 'user.email', 'sphinx@example.invalid');
  return cwd;
}

async function commit(cwd, files, message = 'test change') {
  for (const [name, body] of Object.entries(files)) {
    const filename = join(cwd, name);
    await mkdir(join(filename, '..'), { recursive: true });
    await writeFile(filename, body);
  }
  await command(cwd, 'add', '--all');
  await command(cwd, 'commit', '-m', message);
  return command(cwd, 'rev-parse', 'HEAD');
}

function push(cwd, head, base = zero, config = defaults, extra = {}) {
  return pushSnapshots({
    cwd, remote: 'origin', remoteUrl: 'https://example.invalid/sphinx.git',
    input: `refs/heads/main ${head} refs/heads/main ${base}\n`, config, ...extra,
  });
}

test('initial push captures committed metadata without eagerly loading source content', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'worker.js': 'export const operation = "committed";\n' });
  await writeFile(join(cwd, 'worker.js'), 'UNCOMMITTED_SECRET\n');
  const [snapshot] = await push(cwd, head);
  assert.equal(snapshot.base, null);
  assert.equal(snapshot.head, head);
  assert.equal(snapshot.sourceRef, 'refs/heads/main');
  assert.deepEqual(snapshot.files, ['worker.js']);
  assert.deepEqual(snapshot.stats, { additions: 1, deletions: 0, files: 1 });
  assert.equal(snapshot.version, 2);
  assert.deepEqual(JSON.parse(snapshot.evidence).changedPaths, ['worker.js']);
  assert.doesNotMatch(snapshot.evidence, /export const operation/);
  assert.doesNotMatch(snapshot.evidence, /UNCOMMITTED_SECRET/);
  assert.equal(snapshot.repoRoot, (await repository(cwd)).root);
});

test('destination ref, rather than local branch, decides push coverage', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'a.txt': 'content\n' });
  const snapshots = await push(cwd, head, zero, defaults, {
    input: `refs/heads/feature ${head} refs/heads/main ${zero}\nrefs/heads/main ${head} refs/heads/preview ${zero}\n`,
  });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].target.ref, 'refs/heads/main');
  assert.equal(snapshots[0].sourceRef, 'refs/heads/feature');
});

test('a push of HEAD records the branch HEAD names, or HEAD when detached, with the same identity', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'a.txt': 'content\n' });
  const input = `HEAD ${head} refs/heads/main ${zero}\n`;
  const [attached] = await push(cwd, head, zero, defaults, { input });
  assert.equal(attached.sourceRef, 'refs/heads/main');
  await command(cwd, 'checkout', '-q', '--detach');
  const [detached] = await push(cwd, head, zero, defaults, { input });
  assert.equal(detached.sourceRef, 'HEAD');
  assert.equal(detached.id, attached.id);
});

test('handles multiple refs while skipping deletions, unchanged refs, and tags', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'a.txt': 'content\n' });
  const input = [
    `refs/heads/main ${head} refs/heads/main ${zero}`,
    `refs/heads/main ${head} refs/heads/master ${zero}`,
    `(delete) ${zero} refs/heads/old ${head}`,
    `refs/heads/main ${head} refs/heads/main ${head}`,
    `refs/tags/v1 ${head} refs/tags/v1 ${zero}`,
  ].join('\n');
  assert.equal((await push(cwd, head, zero, defaults, { input })).length, 2);
  assert.deepEqual(await push(cwd, head, zero, { ...defaults, remotes: ['upstream'] }), []);
  assert.deepEqual(await push(cwd, head, zero, { ...defaults, enabled: false }), []);
});

test('force pushes compare destination tree directly, not a merge base', async t => {
  const cwd = await fixture(t);
  const base = await commit(cwd, { 'state.txt': 'original\n' });
  const destination = await commit(cwd, { 'state.txt': 'destination-only\n' });
  await command(cwd, 'checkout', '-b', 'replacement', base);
  const head = await commit(cwd, { 'state.txt': 'replacement\n' });
  const [snapshot] = await push(cwd, head, destination);
  assert.equal(snapshot.base, destination);
  assert.equal(snapshot.head, head);
  assert.deepEqual(snapshot.stats, { additions: 1, deletions: 1, files: 1 });
});

test('missing destination history fails with fetch instructions without fetching', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'a.txt': 'content\n' });
  await assert.rejects(push(cwd, head, 'f'.repeat(40)), /Fetch the destination history with git fetch/);
});

test('identity binds destination, policy, and excluded changes', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'code.js': 'export const a = 1;\n', 'generated.txt': 'first\n' });
  const config = { ...defaults, exclude: ['generated.txt'] };
  const [first] = await push(cwd, head, zero, config);
  const [again] = await push(cwd, head, zero, config);
  const [policy] = await push(cwd, head, zero, { ...config, level: 'thorough' });
  const [destination] = await push(cwd, head, zero, config, { remoteUrl: 'ssh://other/repo.git' });
  const next = await commit(cwd, { 'generated.txt': 'second\n' });
  const [excluded] = await push(cwd, next, zero, config);
  assert.equal(first.id, again.id);
  assert.notEqual(first.id, policy.id);
  assert.notEqual(first.id, destination.id);
  assert.notEqual(first.id, excluded.id);
  assert.deepEqual(first.files, ['code.js']);
  assert.deepEqual(first.omitted, ['generated.txt']);
  assert.doesNotMatch(first.evidence, /\+first/);
});

test('staged evidence includes partial staging, excludes subsequent working edits', async t => {
  const cwd = await fixture(t);
  await commit(cwd, { 'code.js': 'export const a = 1;\n' });
  await writeFile(join(cwd, 'code.js'), 'export const a = 2;\n');
  await command(cwd, 'add', 'code.js');
  await writeFile(join(cwd, 'code.js'), 'WORKING_TREE_SECRET\n');
  const snapshot = await commitSnapshot({ cwd, config: defaults });
  assert.equal(snapshot.indexEntries[0].oid, await command(cwd, 'rev-parse', ':code.js'));
  assert.deepEqual(snapshot.indexEntries.map(entry => entry.path), ['code.js']);
  assert.doesNotMatch(snapshot.evidence, /WORKING_TREE_SECRET/);
  assert.match(snapshot.tree, /^index:[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.stats, { additions: 1, deletions: 1, files: 1 });
});

test('supports unborn staged commits and returns null for an empty index diff', async t => {
  const cwd = await fixture(t);
  assert.equal(await commitSnapshot({ cwd, config: defaults }), null);
  await writeFile(join(cwd, 'first.txt'), 'first\n');
  await command(cwd, 'add', 'first.txt');
  const snapshot = await commitSnapshot({ cwd, config: defaults });
  assert.equal(snapshot.head, null);
  assert.equal(snapshot.base, null);
  assert.deepEqual(snapshot.files, ['first.txt']);
  assert.equal(snapshot.indexEntries[0].oid, await command(cwd, 'rev-parse', ':first.txt'));
  await command(cwd, 'commit', '-m', 'first');
  assert.equal(await commitSnapshot({ cwd, config: defaults }), null);
});

test('manual check uses live remote and upstream destination, matching pre-push identity', async t => {
  const cwd = await fixture(t);
  const remote = await mkdtemp(join(tmpdir(), 'sphinx-remote-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await command(remote, 'init', '--bare');
  await command(cwd, 'remote', 'add', 'upstream', remote);
  const base = await commit(cwd, { 'a.txt': 'base\n' });
  await command(cwd, 'push', '--set-upstream', 'upstream', 'main');
  const head = await commit(cwd, { 'a.txt': 'new\n' });
  const manual = await manualSnapshot({ cwd, config: defaults });
  const [hook] = await push(cwd, head, base, defaults, { remote: 'upstream', remoteUrl: remote });
  assert.equal(manual.id, hook.id);
  assert.equal(manual.target.remote, 'upstream');
  assert.equal(manual.base, base);
});

test('never runs configured external diff or textconv', async t => {
  const cwd = await fixture(t);
  await commit(cwd, { '.gitattributes': '*.txt diff=dangerous\n', 'a.txt': 'before\n' });
  const head = await commit(cwd, { 'a.txt': 'after\n' });
  await command(cwd, 'config', 'diff.external', 'false');
  await command(cwd, 'config', 'diff.dangerous.textconv', 'false');
  const [snapshot] = await push(cwd, head);
  assert.deepEqual(snapshot.files, ['.gitattributes', 'a.txt']);
  assert.deepEqual(snapshot.stats, { additions: 2, deletions: 0, files: 2 });
});

test('a 417 KiB initial patch needs only bounded metadata during checkpoint capture', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'large.txt': 'large line\n'.repeat(42701) });
  const [snapshot] = await push(cwd, head, zero, { ...defaults, maxContextBytes: 1000 });
  assert.deepEqual(snapshot.stats, { additions: 42701, deletions: 0, files: 1 });
  assert.ok(Buffer.byteLength(snapshot.evidence) <= 1000);
  assert.doesNotMatch(snapshot.evidence, /large line/);
});

test('full-file context and patches are deferred regardless of file size', async t => {
  const cwd = await fixture(t);
  const body = 'unchanged line\n'.repeat(1000);
  const base = await commit(cwd, { 'large.txt': body });
  const head = await commit(cwd, { 'large.txt': `changed line\n${body}` });
  const [snapshot] = await push(cwd, head, base, { ...defaults, maxContextBytes: 4000 });
  assert.deepEqual(snapshot.files, ['large.txt']);
  assert.deepEqual(snapshot.omitted, []);
  assert.deepEqual(snapshot.contextOmitted, []);
  assert.doesNotMatch(snapshot.evidence, /changed line|unchanged line/);
  assert.ok(Buffer.byteLength(snapshot.evidence) <= 4000);
});

test('sensitive paths never enter evidence and cannot be unignored', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, {
    'code.js': 'export const a = 1;\n', '.env': 'TOP_SECRET_TOKEN\n',
    'nested/private.key': 'PRIVATE_KEY_MATERIAL\n', '.sphinxignore': '!.env\n!nested/private.key\n',
  });
  const [snapshot] = await push(cwd, head);
  assert.deepEqual(snapshot.omitted, ['.env', 'nested/private.key']);
  assert.doesNotMatch(snapshot.evidence, /TOP_SECRET_TOKEN|PRIVATE_KEY_MATERIAL/);
  assert.equal(snapshot.stats.files, 2);
});

test('repository ignores filter content before retrieval and policy changes invalidate identity', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'code.js': 'okay\n', 'secret.data': 'NO_PEEK\n' });
  await writeFile(join(cwd, '.sphinxignore'), 'secret.data\n');
  const [first] = await push(cwd, head);
  assert.doesNotMatch(first.evidence, /NO_PEEK/);
  assert.doesNotMatch(first.evidence, /secret\.data/);
  assert.doesNotMatch(first.evidence, /example\.invalid/);
  await writeFile(join(cwd, '.sphinxignore'), 'secret.data\n# updated policy\n');
  const [second] = await push(cwd, head);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.files, ['code.js']);
});

test('pending snapshot validation rejects source, ignore-policy, and configuration changes', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'code.js': 'first\n' });
  const [snapshot] = await push(cwd, head);
  assert.equal(await revalidateSnapshot(snapshot, defaults), true);
  await writeFile(join(cwd, 'code.js'), 'working edit\n');
  assert.equal(await revalidateSnapshot(snapshot, defaults), true);
  assert.equal(await revalidateSnapshot(snapshot, { ...defaults, level: 'thorough' }), false);
  await writeFile(join(cwd, '.sphinxignore'), '*.tmp\n');
  assert.equal(await revalidateSnapshot(snapshot, defaults), false);
  await rm(join(cwd, '.sphinxignore'));
  await commit(cwd, { 'code.js': 'second\n' });
  assert.equal(await revalidateSnapshot(snapshot, defaults), false);
});

test('staged validation rejects index edits while allowing working-tree edits', async t => {
  const cwd = await fixture(t);
  await commit(cwd, { 'code.js': 'first\n' });
  await writeFile(join(cwd, 'code.js'), 'second\n');
  await command(cwd, 'add', 'code.js');
  const snapshot = await commitSnapshot({ cwd, config: defaults });
  assert.equal(await revalidateSnapshot(snapshot, defaults), true);
  await writeFile(join(cwd, 'code.js'), 'third\n');
  assert.equal(await revalidateSnapshot(snapshot, defaults), true);
  await command(cwd, 'add', 'code.js');
  assert.equal(await revalidateSnapshot(snapshot, defaults), false);
});

test('ignored-only changes need no checkpoint, including binary private keys', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { '.env': 'secret\n', 'private.key': Buffer.from([0, 1, 2, 3]) });
  assert.deepEqual(await push(cwd, head), []);
});

test('binary metadata remains available without loading binary content', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'image.bin': Buffer.from([0, 1, 2]), 'code.js': 'okay\n' });
  const [binary] = await push(cwd, head);
  assert.deepEqual(binary.binaryFiles, ['image.bin']);
  assert.deepEqual(binary.stats, { additions: 1, deletions: 0, files: 2 });
  const [snapshot] = await push(cwd, head, zero, { ...defaults, exclude: ['*.bin'] });
  assert.deepEqual(snapshot.files, ['code.js']);
});

test('literal paths are safe even when their names resemble Git pathspec magic', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { ':(glob)*.txt': 'literal\n', 'other.txt': 'ordinary\n' });
  const [snapshot] = await push(cwd, head, zero, { ...defaults, exclude: ['other.txt'] });
  assert.deepEqual(snapshot.files, [':(glob)*.txt']);
  assert.deepEqual(JSON.parse(snapshot.evidence).changedPaths, [':(glob)*.txt']);
  assert.doesNotMatch(snapshot.evidence, /\+ordinary/);
});

test('NUL-separated path parsing preserves filenames containing tabs and newlines', async t => {
  const cwd = await fixture(t);
  const filename = 'strange\tname\nfile.js';
  const head = await commit(cwd, { [filename]: 'export const okay = true;\n' });
  const [snapshot] = await push(cwd, head);
  assert.deepEqual(snapshot.files, [filename]);
  assert.deepEqual(snapshot.stats, { additions: 1, deletions: 0, files: 1 });
  assert.deepEqual(JSON.parse(snapshot.evidence).changedPaths, [filename]);
});

test('mode-only changes remain visible and assessable', async t => {
  const cwd = await fixture(t);
  const base = await commit(cwd, { 'run.sh': '#!/bin/sh\nexit 0\n' });
  await chmod(join(cwd, 'run.sh'), 0o755);
  await command(cwd, 'add', 'run.sh');
  await command(cwd, 'commit', '-m', 'make executable');
  const head = await command(cwd, 'rev-parse', 'HEAD');
  const [snapshot] = await push(cwd, head, base);
  assert.deepEqual(snapshot.stats, { additions: 0, deletions: 0, files: 1 });
  assert.deepEqual(snapshot.files, ['run.sh']);
});

test('Git content commands receive only allowed paths, never ignored paths', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'code.js': 'okay\n', '.env': 'SECRET_TOKEN\n', 'private.data': 'SENSITIVE_DATA\n' });
  await writeFile(join(cwd, '.sphinxignore'), 'private.data\n');
  const realGit = (await exec('which', ['git'])).stdout.trim();
  const shim = join(cwd, 'shim');
  const log = join(cwd, 'git-calls.jsonl');
  await mkdir(shim);
  await writeFile(join(shim, 'git'), `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst child = require('node:child_process');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nconst result = child.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim}:${previousPath}`;
  try { await push(cwd, head); }
  finally { process.env.PATH = previousPath; }
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.some(args => args.includes('--name-only')));
  assert.ok(!calls.some(args => args.includes('blob')));
  for (const args of calls) {
    if (args.includes('diff') && !args.includes('--name-only')) {
      assert.ok(args.includes('--numstat'), 'snapshot capture may request counts but never patches');
      assert.deepEqual(args.slice(args.indexOf('--') + 1), ['code.js']);
    }
    assert.ok(!args.some(arg => arg.includes('.env') || arg.includes('private.data')));
  }
});

test('project context is attached explicitly and invalidates the exact checkpoint when edited', async t => {
  const cwd = await fixture(t);
  const head = await commit(cwd, { 'code.js': 'okay\n' });
  await writeFile(join(cwd, '.sphinxcontext.md'), 'Project intention and system boundaries.\n');
  const [first] = await push(cwd, head);
  assert.equal(first.projectContext.text, 'Project intention and system boundaries.');
  assert.equal(first.contextHash, first.projectContext.hash);
  assert.equal(await revalidateSnapshot(first, defaults), true);
  await writeFile(join(cwd, '.sphinxcontext.md'), 'A changed intended invariant.\n');
  assert.equal(await revalidateSnapshot(first, defaults), false);
  const [second] = await push(cwd, head);
  assert.notEqual(first.id, second.id);
  await writeFile(join(cwd, '.sphinxignore'), '.sphinxcontext.md\n');
  const [ignored] = await push(cwd, head);
  assert.equal(ignored.projectContext.text, '');
  await writeFile(join(cwd, '.sphinxcontext.md'), 'Ignored edits do not invalidate context.\n');
  assert.equal(await revalidateSnapshot(ignored, defaults), true);
});

test('a new branch stacked on a pushed feature branch is checked from that branch', async t => {
  const cwd = await fixture(t);
  const main = await commit(cwd, { 'base.js': 'export const base = 1;\n' });
  await command(cwd, 'update-ref', 'refs/remotes/origin/main', main);
  await command(cwd, 'checkout', '-b', 'parent');
  const parent = await commit(cwd, { 'parent.js': 'export const parent = 1;\n' });
  await command(cwd, 'update-ref', 'refs/remotes/origin/parent', parent);
  await command(cwd, 'checkout', '-b', 'child');
  const head = await commit(cwd, { 'child.js': 'export const child = 1;\n' });
  const input = `refs/heads/child ${head} refs/heads/child ${zero}\n`;
  const remoteUrl = 'https://example.invalid/sphinx.git';
  const [snapshot] = await pushSnapshots({ cwd, remote: 'origin', remoteUrl, input, config: { ...defaults, branches: ['*'] } });
  assert.equal(snapshot.base, parent);
  assert.deepEqual(snapshot.files, ['child.js']);
  // A parent branch the policy does not check was never assessed, so it is not a base.
  const [unchecked] = await pushSnapshots({ cwd, remote: 'origin', remoteUrl, input, config: { ...defaults, branches: ['main', 'child'] } });
  assert.equal(unchecked.base, main);
  assert.deepEqual(unchecked.files, ['child.js', 'parent.js']);
});

test('branch and path glob semantics handle nested names', () => {
  assert.equal(matches('release/*', 'release/team/stable'), true);
  assert.equal(matches('*.js', 'src/main.js', { path: true }), false);
  assert.equal(matches('**/*.js', 'main.js', { path: true }), true);
  assert.equal(matches('**/*.js', 'src/main.js', { path: true }), true);
});

test('a new branch is checked from where it left the remote default branch', async t => {
  const cwd = await fixture(t);
  const main = await commit(cwd, { 'base.js': 'export const base = 1;\n' });
  await command(cwd, 'update-ref', 'refs/remotes/origin/main', main);
  await command(cwd, 'checkout', '-b', 'feature');
  const head = await commit(cwd, { 'feature.js': 'export const feature = 1;\n' });
  const input = `refs/heads/feature ${head} refs/heads/feature ${zero}\n`;
  const [snapshot] = await pushSnapshots({ cwd, remote: 'origin', remoteUrl: 'https://example.invalid/sphinx.git', input, config: { ...defaults, branches: ['*'] } });
  assert.equal(snapshot.base, main);
  assert.deepEqual(snapshot.files, ['feature.js']);
  // A branch with nothing beyond the default branch needs no check.
  const same = `refs/heads/copy ${main} refs/heads/copy ${zero}\n`;
  assert.deepEqual(await pushSnapshots({ cwd, remote: 'origin', remoteUrl: 'https://example.invalid/sphinx.git', input: same, config: { ...defaults, branches: ['*'] } }), []);
  // If the default branch is not checked, its code was never assessed: check the whole tree.
  const [release] = await pushSnapshots({ cwd, remote: 'origin', remoteUrl: 'https://example.invalid/sphinx.git', input: `refs/heads/feature ${head} refs/heads/release/v1 ${zero}\n`, config: { ...defaults, branches: ['release/*'] } });
  assert.equal(release.base, null);
  assert.deepEqual(release.files, ['base.js', 'feature.js']);
});

test('a branch that merged other pushed work starts from one of them, and many remote branches stay fast', async t => {
  const cwd = await fixture(t);
  const main = await commit(cwd, { 'base.js': 'export const base = 1;\n' });
  await command(cwd, 'update-ref', 'refs/remotes/origin/main', main);
  await command(cwd, 'checkout', '-b', 'other');
  const other = await commit(cwd, { 'other.js': 'export const other = 1;\n' });
  await command(cwd, 'update-ref', 'refs/remotes/origin/other', other);
  await command(cwd, 'checkout', '-b', 'parent', main);
  const parent = await commit(cwd, { 'parent.js': 'export const parent = 1;\n' });
  await command(cwd, 'update-ref', 'refs/remotes/origin/parent', parent);
  await command(cwd, 'checkout', '-b', 'child');
  await command(cwd, 'merge', '-q', '--no-edit', 'other');
  const head = await commit(cwd, { 'child.js': 'export const child = 1;\n' });
  // Hundreds of unrelated remote branches cost one walk, not two git calls each.
  const history = (await command(cwd, 'rev-list', main)).split('\n');
  const refs = Array.from({ length: 400 }, (_, i) => `create refs/remotes/origin/team/feature-${i} ${history[i % history.length]}\n`).join('');
  await new Promise((resolve, reject) => { const child = execFile('git', ['update-ref', '--stdin'], { cwd }, error => error ? reject(error) : resolve()); child.stdin.end(refs); });
  const started = Date.now();
  const [snapshot] = await pushSnapshots({ cwd, remote: 'origin', remoteUrl: 'https://example.invalid/sphinx.git', input: `refs/heads/child ${head} refs/heads/child ${zero}\n`, config: { ...defaults, branches: ['*'] } });
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  assert.ok([parent, other].includes(snapshot.base));
  assert.ok(snapshot.files.includes('child.js'));
  assert.ok(!snapshot.files.includes('base.js'), 'already-checked history is not re-assessed');
});
