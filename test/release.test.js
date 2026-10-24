import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideRelease } from '../scripts/release.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url));
const COMMIT = 'a'.repeat(40), NEWER = 'b'.repeat(40), PUBLISHED = 'c'.repeat(40);
const decide = overrides => decideRelease({ current: '0.1.13', latest: '0.1.13', latestHead: PUBLISHED, commit: COMMIT, head: COMMIT, ...overrides });
const chosen = overrides => { const { publish, version } = decide(overrides); return { publish, version }; };
const workflow = () => readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
const releaseJob = text => text.slice(text.indexOf('\n  release:\n'));
// What the CLI writes to package.json for a release of COMMIT, keeping 2-space JSON and the trailing newline.
const released = (text, version) => text.replace('"version": "0.1.13"', `"version": "${version}"`).replace(/\n}\n$/, `,\n  "gitHead": "${COMMIT}"\n}\n`);

test('a new commit on main publishes the next minor after npm latest', () => {
  assert.deepEqual(chosen({}), { publish: true, version: '0.2.0' });
  assert.equal(decide({ current: '0.9.4', latest: '0.9.4' }).version, '0.10.0', 'numeric, and the patch resets');
});

test('a version raised by hand in package.json is published as it is', () => {
  assert.equal(decide({ current: '1.0.0' }).version, '1.0.0', 'a major');
  assert.equal(decide({ current: '0.1.14' }).version, '0.1.14', 'a patch');
  assert.equal(decide({ current: '0.12.0', latest: '0.9.0' }).version, '0.12.0', 'compared as numbers, not text');
});

test('never publishes below npm latest, which would move the latest tag backwards', () => {
  assert.equal(decide({ current: '0.1.13', latest: '0.3.0' }).version, '0.4.0');
  assert.equal(decide({ current: '0.9.0', latest: '0.10.0' }).version, '0.11.0', 'compared as numbers, not text');
  assert.equal(decide({ current: '0.3.1', latest: '0.3.2' }).version, '0.4.0');
});

test('the first release publishes package.json version', () => {
  assert.deepEqual(chosen({ latest: null, latestHead: null }), { publish: true, version: '0.1.13' });
});

test('a commit npm already has is not published again, so a re-run does nothing', () => {
  assert.deepEqual(chosen({ latestHead: COMMIT }), { publish: false, version: null });
  assert.match(decide({ latestHead: COMMIT }).reason, /already built from it/);
});

test('only the commit main points to now publishes; a newer push publishes from its own run', () => {
  assert.deepEqual(chosen({ head: NEWER }), { publish: false, version: null });
  assert.deepEqual(chosen({ head: NEWER, current: '1.0.0' }), { publish: false, version: null });
  assert.match(decide({ head: NEWER }).reason, /main is now at bbbbbbb/);
});

test('rejects versions that are not plain x.y.z, saying where to fix each', () => {
  for (const current of ['1.0.0-beta.1', 'v1.0.0', '01.2.3', '1.2', '1.2.3.4', '', undefined]) assert.throws(() => decide({ current }), /package\.json's version ".*" is not a plain x\.y\.z version.*Set package\.json's version to one/, String(current));
  // package.json cannot fix this one, since the next version is counted from npm's latest.
  for (const current of ['0.1.13', '9.0.0']) assert.throws(() => decide({ current, latest: '1.0.0-rc.1' }), /npm's latest dist-tag is 1\.0\.0-rc\.1, which is not a plain x\.y\.z version.*npm dist-tag add/, current);
});

test('the release job cannot write to the repository, so a release never triggers another run', async () => {
  const text = await workflow(), job = releaseJob(text);
  // The only write scope anywhere is npm's OIDC token: none for contents, tags, actions or packages.
  assert.match(text, /^permissions:\n {2}contents: read\n(?! )/m);
  assert.match(job, /\n {4}permissions:\n {6}contents: read\n {6}id-token: write[^\n]*\n(?! {6})/);
  assert.deepEqual(text.match(/[\w-]+: write|write-all/g), ['id-token: write']);
  assert.match(job, /persist-credentials: false/);
  // A push made with the job's own token starts no run; one made with a token from a secret would.
  assert.doesNotMatch(text, /secrets\./);
  assert.doesNotMatch(text, /\bgit\b[^\n]*\b(?:push|commit|tag)\b|\bgh\b|npm version/);
  assert.match(text, /^on: \[push, pull_request\]\n/m, 'only pushes and pull requests start it, and a release makes neither');
});

test('only main of parthh01/sphinx publishes, from the npm environment, and no release cancels another', async () => {
  const job = releaseJob(await workflow());
  assert.match(job, /\n {4}if: github\.repository == 'parthh01\/sphinx' && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\n/, 'a fork would fail at publish after logging a provenance entry');
  // npm's trusted publisher requires this environment, and the repository's settings let only main use it.
  assert.match(job, /\n {4}environment: npm\n/);
  assert.match(job, /\n {4}timeout-minutes: \d+\n/, 'a stalled npm or git call would otherwise hold a runner for 6 hours');
  assert.doesNotMatch(job, /concurrency:/, "GitHub cancels a group's waiting job when another queues, which can drop main's newest release");
});

// The CLI runs against fake npm and git on PATH, which print what the test sets and log their arguments.
async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sphinx-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); await mkdir(bin);
  for (const [name, prefix] of [['npm', 'NPM'], ['git', 'GIT']]) await writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$FAKE_LOG"\nprintf '%s' "$FAKE_${prefix}_OUT"\nprintf '%s' "$FAKE_${prefix}_ERR" >&2\nexit "\${FAKE_${prefix}_EXIT:-0}"\n`, { mode: 0o755 });
  const original = `${JSON.stringify({ name: 'sphinx-understand', version: '0.1.13', description: 'Ünïcode stays as it is.', bin: { sphinx: 'bin/sphinx.js' }, files: ['bin', 'src'] }, null, 2)}\n`;
  await writeFile(path.join(dir, 'package.json'), original);
  const files = { output: path.join(dir, 'github-output'), log: path.join(dir, 'calls.log') };
  const read = file => readFile(file, 'utf8').catch(() => null);
  const release = async (env, script = SCRIPT) => {
    const result = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8', env: {
      PATH: `${bin}:/usr/bin:/bin`, FAKE_LOG: files.log, GITHUB_SHA: COMMIT, GITHUB_OUTPUT: files.output,
      FAKE_NPM_OUT: JSON.stringify({ name: 'sphinx-understand', version: '0.1.13', gitHead: PUBLISHED, 'dist-tags': { latest: '0.1.13' } }), FAKE_GIT_OUT: `${COMMIT}\trefs/heads/main\n`, ...env } });
    const run = { status: result.status, stdout: result.stdout, output: await read(files.output), pkg: await read(path.join(dir, 'package.json')), calls: await read(files.log) };
    await Promise.all([rm(files.output, { force: true }), rm(files.log, { force: true }), writeFile(path.join(dir, 'package.json'), original)]);
    return run;
  };
  return { dir, original, release };
}

test('the CLI sets the next minor and the commit in package.json and tells the workflow to publish', async t => {
  const { dir, original, release } = await workspace(t);
  const run = await release();
  assert.equal(run.status, 0, run.stdout);
  assert.equal(run.output, 'publish=true\nversion=0.2.0\n');
  // npm records gitHead as given, and an installed copy pins its GitHub Action to it.
  assert.equal(run.pkg, released(original, '0.2.0'), 'only the version and gitHead change');
  assert.match(run.stdout, /^Publishing sphinx-understand@0\.2\.0 from aaaaaaa: the next minor after npm's latest 0\.1\.13\.\n$/);
  assert.deepEqual(run.calls.trim().split('\n').sort(), ['git ls-remote origin refs/heads/main', 'npm view sphinx-understand@latest --json'], 'it only reads from npm and GitHub');
  await writeFile(path.join(dir, 'package.json'), original.replace(/\n}\n$/, `,\n  "gitHead": "${PUBLISHED}"\n}\n`));
  assert.equal((await release()).pkg, released(original, '0.2.0'), 'a gitHead already in package.json is replaced by the commit');
});

test('the CLI leaves package.json alone when the commit is published or main has moved on', async t => {
  const { original, release } = await workspace(t);
  const published = await release({ FAKE_NPM_OUT: JSON.stringify({ version: '0.2.0', gitHead: COMMIT }) });
  assert.equal(published.status, 0, published.stdout);
  assert.equal(published.output, 'publish=false\nversion=\n'); assert.equal(published.pkg, original);
  assert.match(published.stdout, /^Not publishing aaaaaaa: npm's latest, 0\.2\.0, was already built from it\./);
  const moved = await release({ FAKE_GIT_OUT: `${NEWER}\trefs/heads/main\n` });
  assert.equal(moved.status, 0, moved.stdout);
  assert.equal(moved.output, 'publish=false\nversion=\n'); assert.equal(moved.pkg, original);
});

test('a package npm has never published (E404) is released at package.json version', async t => {
  const { original, release } = await workspace(t);
  // The shape npm 11 prints for a missing package or version.
  const notFound = JSON.stringify({ error: { code: 'E404', summary: 'Not Found - GET https://registry.npmjs.org/sphinx-understand - Not found', detail: '' } }, null, 2);
  const run = await release({ FAKE_NPM_OUT: notFound, FAKE_NPM_ERR: 'npm error code E404\n', FAKE_NPM_EXIT: '1' });
  assert.equal(run.status, 0, run.stdout);
  assert.equal(run.output, 'publish=true\nversion=0.1.13\n'); assert.equal(run.pkg, released(original, '0.1.13'));
});

test('any other npm or git failure stops the release before it changes anything', async t => {
  const { original, release } = await workspace(t);
  for (const [env, message] of [
    [{ FAKE_NPM_OUT: JSON.stringify({ error: { code: 'E500', summary: 'Internal Server Error' } }), FAKE_NPM_ERR: 'npm error code E500\n', FAKE_NPM_EXIT: '1' }, /npm view sphinx-understand@latest --json failed: npm error code E500/],
    [{ FAKE_NPM_OUT: '', FAKE_NPM_ERR: 'npm error code EAI_AGAIN\n', FAKE_NPM_EXIT: '1' }, /failed: npm error code EAI_AGAIN/],
    [{ FAKE_NPM_OUT: '' }, /returned no version: no output/],
    [{ FAKE_GIT_ERR: 'fatal: unable to access', FAKE_GIT_EXIT: '128' }, /git ls-remote origin refs\/heads\/main failed: fatal: unable to access/],
    [{ FAKE_GIT_OUT: '' }, /found no main branch/],
    [{ FAKE_GIT_OUT: `${COMMIT}\trefs/heads/a/refs/heads/main\n` }, /found no main branch/],
  ]) {
    const run = await release(env);
    assert.equal(run.status, 1, JSON.stringify(env));
    assert.match(run.stdout, /^::error::/); assert.match(run.stdout, message);
    assert.equal(run.output, null, 'no outputs, so nothing is published'); assert.equal(run.pkg, original);
  }
});

test('without GITHUB_OUTPUT or GITHUB_SHA the CLI refuses before reading npm or touching package.json', async t => {
  const { original, release } = await workspace(t);
  for (const missing of ['GITHUB_OUTPUT', 'GITHUB_SHA']) {
    const run = await release({ [missing]: undefined });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /::error::GITHUB_SHA and GITHUB_OUTPUT are not set/);
    assert.equal(run.calls, null); assert.equal(run.output, null); assert.equal(run.pkg, original);
  }
});

test("main's head is read from refs/heads/main itself, not from branches whose names end in it", async t => {
  const { release } = await workspace(t);
  // git ls-remote matches the end of ref names and sorts by name, so these come before or after main.
  const publishes = await release({ FAKE_GIT_OUT: `${NEWER}\trefs/heads/a/refs/heads/main\n${COMMIT}\trefs/heads/main\n` });
  assert.equal(publishes.output, 'publish=true\nversion=0.2.0\n', publishes.stdout);
  const skips = await release({ FAKE_GIT_OUT: `${COMMIT}\trefs/heads/a/refs/heads/main\n${NEWER}\trefs/heads/main\n${COMMIT}\trefs/heads/z/refs/heads/main\n` });
  assert.equal(skips.output, 'publish=false\nversion=\n', skips.stdout);
});

test('the CLI runs when started through a symlinked path', async t => {
  const { dir, release } = await workspace(t);
  // Node gives the main module its real path, so comparing it with the path as typed would skip the CLI.
  await symlink(path.dirname(SCRIPT), path.join(dir, 'linked'));
  const run = await release({}, path.join(dir, 'linked', 'release.mjs'));
  assert.equal(run.status, 0, run.stdout); assert.equal(run.output, 'publish=true\nversion=0.2.0\n');
});
