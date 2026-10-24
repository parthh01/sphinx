import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decideRelease, releaseMessage } from '../scripts/release.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url));
const COMMIT = 'a'.repeat(40), NEWER = 'b'.repeat(40), PUBLISHED = 'c'.repeat(40), OTHER = 'd'.repeat(40);
const decide = overrides => decideRelease({ current: '0.1.13', latest: '0.1.13', latestHead: PUBLISHED, versions: ['0.1.11', '0.1.13'], tags: { 'v0.1.13': PUBLISHED }, commit: COMMIT, head: COMMIT, ...overrides });
const chosen = overrides => { const { publish, version, bump, tag } = decide(overrides); return { publish, version, bump, tag }; };
const SKIP = { publish: false, version: null, bump: false, tag: false };
const workflow = () => readFile(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
const releaseJob = text => text.slice(text.indexOf('\n  release:\n'));

test('a new commit on main is released as the next patch after npm latest, by a tagged release commit', () => {
  assert.deepEqual(chosen({}), { publish: true, version: '0.1.14', bump: true, tag: true });
  assert.match(decide({}).reason, /^the next patch after npm's latest 0\.1\.13\.$/);
  assert.equal(decide({ current: '0.9.9', latest: '0.9.9', versions: ['0.9.9'] }).version, '0.9.10', 'numeric, not text');
  assert.equal(decide({ current: '1.4.2', latest: '1.4.2', versions: ['1.4.2'] }).version, '1.4.3', 'the major and minor stay');
});

test('a version raised by hand in package.json is published as it is: tagged, with no release commit', () => {
  for (const current of ['1.0.0', '0.2.0', '0.1.20']) assert.deepEqual(chosen({ current }), { publish: true, version: current, bump: false, tag: true }, current);
  assert.equal(decide({ current: '0.12.0', latest: '0.9.0', versions: ['0.9.0'] }).version, '0.12.0', 'compared as numbers, not text');
});

test('never publishes below npm latest, which would move the latest tag backwards', () => {
  assert.deepEqual(chosen({ current: '0.1.13', latest: '0.3.0', versions: ['0.3.0'] }), { publish: true, version: '0.3.1', bump: true, tag: true });
  assert.equal(decide({ current: '0.9.0', latest: '0.10.0', versions: ['0.10.0'] }).version, '0.10.1', 'compared as numbers, not text');
  assert.equal(decide({ current: '0.3.1', latest: '0.3.2', versions: ['0.3.2'] }).version, '0.3.3');
  // A higher version npm has under another tag, or left when latest was moved back, does not change the count.
  assert.deepEqual(chosen({ versions: ['0.1.13', '0.2.0'] }), { publish: true, version: '0.1.14', bump: true, tag: true });
});

test('the first release publishes package.json version', () => {
  assert.deepEqual(chosen({ latest: null, latestHead: null, versions: [], tags: {} }), { publish: true, version: '0.1.13', bump: false, tag: true });
});

test('a commit npm already published from never releases again, so a release commit cannot start a loop', () => {
  // A release commit is the commit that gets published, so a run for it, if GitHub ever started one, stops here.
  const released = { current: '0.1.14', latest: '0.1.14', versions: ['0.1.13', '0.1.14'], tags: { 'v0.1.13': PUBLISHED, 'v0.1.14': COMMIT } };
  assert.deepEqual(chosen({ ...released, latestHead: COMMIT }), SKIP);
  assert.match(decide({ ...released, latestHead: COMMIT }).reason, /^npm's latest, 0\.1\.14, was already published from it\.$/);
  // Its tag says so too, should npm ever record no gitHead.
  assert.deepEqual(chosen({ ...released, latestHead: null }), SKIP);
  assert.match(decide({ ...released, latestHead: null }).reason, /^npm already has 0\.1\.14, and v0\.1\.14 tags it\.$/);
  assert.deepEqual(chosen({ latestHead: COMMIT, current: '9.0.0' }), SKIP, 'even with a higher version in package.json');
});

test('a commit already in the history npm latest was published from never releases again', () => {
  // Such as the commit a release commit was made on, should main be reset back to it: npm has something newer.
  assert.deepEqual(chosen({ contained: true }), SKIP);
  assert.match(decide({ contained: true }).reason, /^npm's latest, 0\.1\.13, was published from a later commit that already contains it\.$/);
  assert.deepEqual(chosen({ contained: true, current: '9.0.0' }), SKIP, 'even with a higher version in package.json');
});

test('only the commit main points to now releases; a newer push releases from its own run', () => {
  assert.deepEqual(chosen({ head: NEWER }), SKIP);
  assert.deepEqual(chosen({ head: NEWER, current: '1.0.0' }), SKIP);
  assert.match(decide({ head: NEWER }).reason, /^main is now at bbbbbbb, and only main's newest commit releases\.$/);
  // A release commit whose job failed or was cancelled after its push gets no run, so the skip says how it is published.
  assert.match(decide({ head: NEWER, tags: { 'v0.1.13': PUBLISHED, 'v0.1.14': NEWER } }).reason, /^main is now at bbbbbbb, and only main's newest commit releases\. npm lacks 0\.1\.14, which v0\.1\.14 tags there: if its release job failed or was cancelled, Run workflow on main publishes it\.$/);
  assert.match(decide({ head: NEWER, versions: ['0.1.13', '0.1.14'], tags: { 'v0.1.14': NEWER } }).reason, /commit releases\.$/, 'not once npm has it');
});

test('skips a version npm already has, or whose tag names another commit, and never moves a tag', () => {
  assert.deepEqual(chosen({ versions: ['0.1.13', '0.1.14'] }), { publish: true, version: '0.1.15', bump: true, tag: true }, "npm's latest was moved back by hand");
  // A release whose publish failed keeps its tag on its own commit.
  assert.deepEqual(chosen({ tags: { 'v0.1.14': OTHER } }), { publish: true, version: '0.1.15', bump: true, tag: true });
  assert.match(decide({ tags: { 'v0.1.14': OTHER } }).reason, /^the next patch after npm's latest 0\.1\.13\. 0\.1\.14 is taken: npm has it, or its tag names another commit\.$/);
  assert.deepEqual(chosen({ tags: { 'v0.1.14': OTHER, 'v0.1.15': NEWER } }), { publish: true, version: '0.1.16', bump: true, tag: true });
  assert.deepEqual(chosen({ current: '1.0.0', tags: { 'v1.0.0': OTHER } }), { publish: true, version: '1.0.1', bump: true, tag: true }, 'a version set by hand too');
  // A release commit is new, so no existing tag can name it, even one on the commit it builds on.
  assert.deepEqual(chosen({ tags: { 'v0.1.14': COMMIT } }), { publish: true, version: '0.1.15', bump: true, tag: true });
});

test('a release commit whose publish failed is published as it is, reusing its tag; a later commit bumps past it', () => {
  // What Run workflow on main sees: package.json has the version, and its tag names this commit.
  const failed = { current: '0.1.14', tags: { 'v0.1.13': PUBLISHED, 'v0.1.14': COMMIT } };
  assert.deepEqual(chosen(failed), { publish: true, version: '0.1.14', bump: false, tag: false });
  assert.match(decide(failed).reason, /^package\.json's 0\.1\.14 is higher than npm's latest 0\.1\.13\.$/);
  // A later commit inherits 0.1.14, but v0.1.14 names the failed release, so this one is 0.1.15.
  assert.deepEqual(chosen({ ...failed, tags: { ...failed.tags, 'v0.1.14': OTHER } }), { publish: true, version: '0.1.15', bump: true, tag: true });
});

test('rejects versions that are not plain x.y.z, saying where to fix each', () => {
  for (const current of ['1.0.0-beta.1', 'v1.0.0', '01.2.3', '1.2', '1.2.3.4', '', undefined]) assert.throws(() => decide({ current }), /package\.json's version ".*" is not a plain x\.y\.z version.*Set package\.json's version to one/, String(current));
  // package.json cannot fix this one, since the next version is counted from npm's latest.
  for (const current of ['0.1.13', '9.0.0']) assert.throws(() => decide({ current, latest: '1.0.0-rc.1' }), /npm's latest dist-tag is 1\.0\.0-rc\.1, which is not a plain x\.y\.z version.*npm dist-tag add/, current);
});

test('the release job pushes only with its own token and its release commit says [skip ci], so a release starts no run', async () => {
  const text = await workflow(), job = releaseJob(text), code = text.replace(/#.*$/gm, '');
  // GitHub starts no run for a push made with the job's own token. A personal token or a secret would start one per release.
  assert.match(text, /^permissions:\n {2}contents: read\n(?! )/m, 'every other job keeps read-only contents');
  assert.match(job, /\n {4}permissions:\n {6}contents: write[^\n]*\n {6}id-token: write[^\n]*\n(?! {6})/);
  assert.deepEqual(code.match(/\bwrite(-all)?\b/g), ['write', 'write'], 'those two are the only grants that write, however a grant is quoted or spaced');
  assert.doesNotMatch(code, /\bsecrets\b|\bvars\b|\bssh-key\b/, 'no stored credential reaches the workflow, in any expression syntax, and no deploy key');
  assert.doesNotMatch(text, /^\s*token:/m, "checkout keeps its default token, the job's own");
  // GitHub skips push runs for a commit whose message says [skip ci], whatever token pushed it.
  assert.equal(releaseMessage('0.1.14'), 'Release 0.1.14 [skip ci]');
  assert.match(text, /^on: \[push, pull_request, workflow_dispatch\]\n/m, 'a release pushes a commit and a tag; Run workflow on main publishes one whose publish failed');
});

test('only main of parthh01/sphinx releases, after the tests, from the npm environment, and no release cancels another', async () => {
  const job = releaseJob(await workflow());
  assert.match(job, /\n {4}if: github\.repository == 'parthh01\/sphinx' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && github\.ref == 'refs\/heads\/main'\n/, 'a fork, a pull request or a tag push never reaches it');
  assert.match(job, /\n {4}needs: test\n/);
  // npm's trusted publisher requires this environment, and the repository's settings let only main use it.
  assert.match(job, /\n {4}environment: npm\n/);
  assert.match(job, /\n {4}timeout-minutes: 10\n/, 'a stalled npm or git call would otherwise hold a runner for 6 hours');
  assert.doesNotMatch(job, /concurrency:/, "GitHub cancels a group's waiting job when another queues, which can drop main's newest release");
  // npm only views, publishes, and upgrades itself with --ignore-scripts: no install or lifecycle script runs here.
  assert.doesNotMatch(job.replace(/^ *#.*\n/gm, ''), /\bnpm (ci|i|install(?! --global --ignore-scripts npm@)|add|update|rebuild|run|run-script|test|start|exec|x|pack|link)\b|\b(npx|yarn|pnpm)\b/, 'no install scripts run in a job that can mint an npm token and push to main');
});

test('the workflow publishes only after the script pushed, and checks npm recorded the pushed commit', async () => {
  const text = await workflow(), steps = releaseJob(text).split(/\n {6}- /).slice(1);
  const at = pattern => steps.findIndex(step => pattern.test(step));
  const release = at(/^id: release\n {8}run: node scripts\/release\.mjs\n/);
  const publish = at(/^if: steps\.release\.outputs\.publish == 'true'\n[^]*\n {10}npm publish --provenance --tag latest \|\|/);
  const check = at(/^if: steps\.release\.outputs\.publish == 'true'\n[^]*\n {10}COMMIT: \$\{\{ steps\.release\.outputs\.commit \}\}\n[^]*\[ "\$recorded" = "\$COMMIT" \]/);
  assert.ok(release >= 0 && release < publish && publish < check, JSON.stringify({ release, publish, check }));
  assert.equal(text.match(/npm publish/g).length, 1, 'no other publish');
});

// Real git against a bare "origin", and a fake npm whose registry is a JSON file: { latest, versions: { version: gitHead } }.
// job() checks a commit out the way actions/checkout does for main and runs the script there as the release step. When it
// says publish, job() does what the workflow's next two steps do: the workflow's own npm publish command from the checkout,
// then read npm's gitHead.
const FAKE_NPM = `const fs = require('node:fs'), { execFileSync } = require('node:child_process');
const args = process.argv.slice(2), env = process.env;
fs.appendFileSync(env.FAKE_LOG, 'npm ' + args.join(' ') + '\\n');
if (env.FAKE_NPM_OUT !== undefined) { process.stdout.write(env.FAKE_NPM_OUT); process.stderr.write(env.FAKE_NPM_ERR || ''); process.exit(Number(env.FAKE_NPM_EXIT || 0)); }
const registry = fs.existsSync(env.FAKE_REGISTRY) ? JSON.parse(fs.readFileSync(env.FAKE_REGISTRY, 'utf8')) : null;
const fail = (code, out = '') => { process.stdout.write(out); process.stderr.write('npm error code ' + code + '\\n'); process.exit(1); };
if (args[0] === 'view') {
  // npm 11 prints a missing package or version as {"error":{"code":"E404"}} on stdout.
  const [name, wanted] = args[1].split('@'), version = wanted === 'latest' ? registry?.latest : wanted;
  if (!registry?.versions[version]) fail('E404', JSON.stringify({ error: { code: 'E404', summary: 'Not Found' } }));
  if (args[2] === 'gitHead') console.log(registry.versions[version]);
  else console.log(JSON.stringify({ name, version, gitHead: registry.versions[version], versions: Object.keys(registry.versions), 'dist-tags': { latest: registry.latest } }));
} else if (args[0] === 'publish') {
  if (env.FAKE_PUBLISH_FAILS) fail('E503');
  // Like npm: the version from package.json, and gitHead from the checkout's HEAD.
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8')), gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const next = registry ?? { latest: null, versions: {} }, tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : null;
  if (next.versions[version]) fail('E403');
  // Like npm 11: with no --tag, latest moves only to a version above every one npm has.
  const number = v => v.split('.').reduce((sum, part) => sum * 1e4 + Number(part), 0);
  if (!tag && Object.keys(next.versions).some(v => number(v) >= number(version))) { process.stderr.write('npm error Cannot implicitly apply the "latest" tag because previously published version is higher than the new version ' + version + '. You must specify a tag using --tag.\\n'); process.exit(1); }
  next.versions[version] = gitHead; if ((tag ?? 'latest') === 'latest') next.latest = version;
  fs.writeFileSync(env.FAKE_REGISTRY, JSON.stringify(next));
}
`;
const BOT = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>';
// Where actions/checkout keeps the job's token: an http header for github.com in the checkout's own .git/config.
const TOKEN = 'http.https://github.com/.extraheader';
const SKIPPED = { publish: 'false', version: '', commit: '' };
// Sets the first `count` "version" fields: the package's own, which in package-lock.json are the root's and packages[""]'s.
const versioned = (text, version, count) => { let seen = 0; return text.replace(/"version": "[^"]*"/g, field => seen++ < count ? `"version": "${version}"` : field); };

async function repository(t, { version = '0.1.13', published = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sphinx-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), origin = path.join(dir, 'origin.git'), seed = path.join(dir, 'seed');
  const files = { log: path.join(dir, 'calls.log'), registry: path.join(dir, 'registry.json') };
  const base = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const GIT = execFileSync('sh', ['-c', 'command -v git'], { env: base, encoding: 'utf8' }).trim();
  const raw = (cwd, ...args) => execFileSync(GIT, args, { cwd, env: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const git = (cwd, ...args) => raw(cwd, ...args).trimEnd();
  const commit = message => git(seed, '-c', 'user.name=Sphinx test', '-c', 'user.email=sphinx@example.invalid', 'commit', '-q', '-m', message);
  await mkdir(bin);
  await writeFile(path.join(bin, 'npm.cjs'), FAKE_NPM);
  await writeFile(path.join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'npm.cjs')}" "$@"\n`, { mode: 0o755 });
  // Real git, which logs its calls and, when the release pushes, can first move a ref on origin as a push landing meanwhile
  // would, or push and then fail, as when the connection drops after GitHub applied the push.
  await writeFile(path.join(bin, 'git'), `#!/bin/sh\necho "git $*" >> "$FAKE_LOG"\nif [ "$1" = push ] && [ -n "$RACE_REF" ]; then "${GIT}" --git-dir="${origin}" update-ref "$RACE_REF" "$RACE_TO"; fi\nif [ "$1" = push ] && [ -n "$PUSH_LANDS" ]; then "${GIT}" "$@" 2>/dev/null; echo 'fatal: the remote end hung up unexpectedly' >&2; exit 128; fi\nexec "${GIT}" "$@"\n`, { mode: 0o755 });

  // The real package files at the version under test: the last release, tagged as releases are, then a merged change.
  const [pkg, lock] = await Promise.all(['package.json', 'package-lock.json'].map(name => readFile(new URL(`../${name}`, import.meta.url), 'utf8')));
  const files13 = { 'package.json': versioned(pkg, '0.1.13', 1), 'package-lock.json': versioned(lock, '0.1.13', 2) };
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-q', '-b', 'main', seed);
  git(seed, 'remote', 'add', 'origin', origin);
  for (const [name, text] of Object.entries({ ...files13, 'README.md': 'one\n' })) await writeFile(path.join(seed, name), text);
  git(seed, 'add', '-A'); commit('Release 0.1.13');
  const first = git(seed, 'rev-parse', 'HEAD');
  if (published) {
    git(seed, '-c', 'user.name=Sphinx test', '-c', 'user.email=sphinx@example.invalid', 'tag', '-a', 'v0.1.13', '-m', 'Sphinx 0.1.13');
    await writeFile(files.registry, JSON.stringify({ latest: '0.1.13', versions: { '0.1.11': PUBLISHED, '0.1.13': first } }));
  }
  await writeFile(path.join(seed, 'README.md'), 'two\n');
  await writeFile(path.join(seed, 'package.json'), versioned(pkg, version, 1)); await writeFile(path.join(seed, 'package-lock.json'), versioned(lock, version, 2));
  git(seed, 'add', '-A'); commit('Merge a change');
  git(seed, 'push', '-q', '--follow-tags', 'origin', 'main');

  let changes = 0, runs = 0;
  // Another merged change: on main, or only on another branch of origin, ready to become main mid-release.
  const merge = async (message, ref = 'refs/heads/main') => {
    git(seed, 'fetch', '-q', 'origin', 'main'); git(seed, 'reset', '-q', '--hard', 'FETCH_HEAD');
    await writeFile(path.join(seed, 'README.md'), `change ${++changes}\n`);
    git(seed, 'add', '-A'); commit(message); git(seed, 'push', '-q', 'origin', `HEAD:${ref}`);
    return git(seed, 'rev-parse', 'HEAD');
  };
  const job = async (sha, env = {}, { url, script = SCRIPT } = {}) => {
    const work = path.join(dir, `run-${++runs}`), output = path.join(dir, `output-${runs}`);
    // What actions/checkout does for main: a shallow fetch of the commit, with no tags, checked out as the branch.
    git(dir, 'init', '-q', work); git(work, 'remote', 'add', 'origin', pathToFileURL(origin).href);
    git(work, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', `+${sha}:refs/remotes/origin/main`);
    git(work, 'checkout', '-q', '--force', '-B', 'main', 'refs/remotes/origin/main');
    git(work, 'config', '--local', TOKEN, 'AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46am9i'); // unused here, as origin is a path
    if (url) git(work, 'remote', 'set-url', 'origin', url);
    const vars = Object.fromEntries(Object.entries({ ...base, PATH: `${bin}:${base.PATH}`, FAKE_LOG: files.log, FAKE_REGISTRY: files.registry, GITHUB_SHA: sha, GITHUB_OUTPUT: output, ...env }).filter(([, value]) => value !== undefined));
    const result = spawnSync(process.execPath, [script], { cwd: work, encoding: 'utf8', env: vars });
    const credential = spawnSync(GIT, ['config', '--local', '--get', TOKEN], { cwd: work, env: base, encoding: 'utf8' }).stdout.trim() || null;
    const calls = (await readFile(files.log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    await rm(files.log, { force: true });
    const text = await readFile(output, 'utf8').catch(() => null);
    const outputs = text === null ? null : Object.fromEntries(text.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    let publish = null;
    if (outputs?.publish === 'true') {
      const args = (await workflow()).match(/\n {10}npm (publish [^|\n]*?) \|\|/)[1].split(' ');
      const published = spawnSync(path.join(bin, 'npm'), args, { cwd: work, encoding: 'utf8', env: vars });
      publish = { status: published.status, gitHead: published.status === 0 ? execFileSync(path.join(bin, 'npm'), ['view', `sphinx-understand@${outputs.version}`, 'gitHead'], { cwd: work, env: vars, encoding: 'utf8' }).trim() : null };
      await rm(files.log, { force: true });
    }
    return { status: result.status, stdout: result.stdout, outputs, publish, calls, credential, pkg: await readFile(path.join(work, 'package.json'), 'utf8') };
  };
  const refs = () => Object.fromEntries(git(dir, 'ls-remote', origin, 'refs/*').split('\n').map(line => line.split('\t').reverse()));
  const registry = () => readFile(files.registry, 'utf8').then(JSON.parse, () => null);
  const setRegistry = value => writeFile(files.registry, JSON.stringify(value));
  return { dir, origin, first, main: git(seed, 'rev-parse', 'HEAD'), pkg: files13['package.json'], lock: files13['package-lock.json'], git: (...args) => git(origin, ...args), raw: (...args) => raw(origin, ...args), refs, registry, setRegistry, merge, job };
}

test('a push to main is released as the next patch: a release commit and tag on main by the bot, then a publish from that commit', async t => {
  const repo = await repository(t);
  const run = await repo.job(repo.main);
  assert.equal(run.status, 0, run.stdout);
  const release = repo.refs()['refs/heads/main'];
  assert.deepEqual(run.outputs, { publish: 'true', version: '0.1.14', commit: release });
  assert.notEqual(release, repo.main);
  // The release commit sits on the pushed commit, says [skip ci], comes from the job's bot, and changes only the versions.
  assert.equal(repo.git('log', '-1', '--format=%P', release), repo.main);
  assert.equal(repo.raw('log', '-1', '--format=%B', release), 'Release 0.1.14 [skip ci]\n\n');
  assert.equal(repo.git('log', '-1', '--format=%an <%ae>%n%cn <%ce>', release), `${BOT}\n${BOT}`);
  assert.equal(repo.git('diff', '--numstat', repo.main, release), '2\t2\tpackage-lock.json\n1\t1\tpackage.json');
  assert.equal(repo.raw('show', `${release}:package.json`), versioned(repo.pkg, '0.1.14', 1), 'no gitHead, and the formatting stays');
  assert.equal(repo.raw('show', `${release}:package-lock.json`), versioned(repo.lock, '0.1.14', 2));
  // v0.1.14 is an annotated tag on the release commit, like the earlier releases, by the bot.
  assert.equal(repo.refs()['refs/tags/v0.1.14^{}'], release);
  assert.match(repo.raw('cat-file', '-p', 'v0.1.14'), new RegExp(`^object ${release}\\ntype commit\\ntag v0\\.1\\.14\\ntagger ${BOT.replace(/[[\]+.]/g, '\\$&')} \\d+ [+-]\\d{4}\\n\\nSphinx 0\\.1\\.14\\n$`));
  // It looked whether npm's latest already contains the commit, sent the commit and tag in one atomic push, then dropped the
  // job's token; the script itself never publishes.
  assert.deepEqual(run.calls, ['git rev-parse HEAD', 'npm view sphinx-understand@latest --json', 'git ls-remote origin refs/heads/main refs/tags/*', `git fetch -q --no-tags origin ${repo.first}`, `git merge-base --is-ancestor ${repo.main} ${repo.first}`, 'git commit -q -m Release 0.1.14 [skip ci] -- package.json package-lock.json', 'git tag -a v0.1.14 -m Sphinx 0.1.14', 'git push --atomic origin HEAD:refs/heads/main refs/tags/v0.1.14', 'git rev-parse HEAD', `git config --local --unset-all ${TOKEN}`]);
  assert.equal(run.credential, null, "the job's token, which can push to main, is gone before npm publish runs");
  assert.match(run.stdout, /^Releasing sphinx-understand@0\.1\.14 from \w{7}: the next patch after npm's latest 0\.1\.13\.\nPushed the release commit \w{7} and v0\.1\.14 to main; the job publishes \w{7}\.\n$/);
  // npm then has 0.1.14 from the release commit, so the workflow's check of npm's gitHead passes.
  assert.deepEqual(run.publish, { status: 0, gitHead: release });
  assert.deepEqual(await repo.registry(), { latest: '0.1.14', versions: { '0.1.11': PUBLISHED, '0.1.13': repo.first, '0.1.14': release } });
});

test('a release commit never releases again, even if GitHub started a run for it, and the next merge releases as usual', async t => {
  const repo = await repository(t);
  await repo.job(repo.main);
  const release = repo.refs()['refs/heads/main'], refs = repo.refs(), registry = await repo.registry();
  // As if its [skip ci] and the job's own token both failed to stop the run.
  const again = await repo.job(release);
  assert.equal(again.status, 0, again.stdout);
  assert.deepEqual(again.outputs, SKIPPED);
  assert.match(again.stdout, /^Not publishing \w{7}: npm's latest, 0\.1\.14, was already published from it\.\n$/);
  // A re-run of the run that released skips too: main has moved on to its release commit.
  const rerun = await repo.job(repo.main);
  assert.deepEqual(rerun.outputs, SKIPPED);
  assert.match(rerun.stdout, /main is now at \w{7}, and only main's newest commit releases/);
  assert.deepEqual([repo.refs(), await repo.registry()], [refs, registry], 'no commit, tag or publish');
  const next = await repo.merge('Merge another change');
  const run = await repo.job(next);
  assert.deepEqual(run.outputs, { publish: 'true', version: '0.1.15', commit: repo.refs()['refs/heads/main'] });
  assert.equal(repo.git('log', '-1', '--format=%P%n%B', run.outputs.commit), `${next}\nRelease 0.1.15 [skip ci]`);
  assert.equal(run.publish.gitHead, run.outputs.commit);
});

test('when main moves on during a release, the push is rejected whole and nothing is published', async t => {
  for (const version of ['0.1.13', '0.2.0']) {
    const repo = await repository(t, { version });
    const newer = await repo.merge('Merge a newer change', 'refs/heads/newer'), refs = repo.refs(), registry = await repo.registry();
    // main moves to the newer merge just before the release pushes: a release commit and tag for 0.1.14, or only the tag for 0.2.0.
    const run = await repo.job(repo.main, { RACE_REF: 'refs/heads/main', RACE_TO: newer });
    assert.equal(run.status, 0, run.stdout);
    assert.deepEqual(run.outputs, SKIPPED, version);
    assert.equal(run.publish, null);
    assert.match(run.stdout, new RegExp(`\\nNot publishing ${repo.main.slice(0, 7)}: main moved on to ${newer.slice(0, 7)} during the release, so the push was rejected and nothing changed\\. ${newer.slice(0, 7)}'s run releases\\.\\n$`));
    assert.deepEqual(repo.refs(), { ...refs, 'refs/heads/main': newer }, 'neither a commit nor a tag landed');
    assert.deepEqual(await repo.registry(), registry);
  }
});

test('a version raised by hand is tagged on its own commit and published from it, with no release commit', async t => {
  const repo = await repository(t, { version: '0.2.0' });
  const run = await repo.job(repo.main);
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(run.outputs, { publish: 'true', version: '0.2.0', commit: repo.main });
  assert.equal(repo.refs()['refs/heads/main'], repo.main, 'main stays where it was');
  assert.equal(repo.refs()['refs/tags/v0.2.0^{}'], repo.main);
  assert.ok(run.calls.includes('git push --atomic origin HEAD:refs/heads/main refs/tags/v0.2.0'), 'the tag goes only if main is still this commit');
  assert.ok(!run.calls.some(call => call.startsWith('git commit')));
  assert.match(run.stdout, /: package\.json's 0\.2\.0 is higher than npm's latest 0\.1\.13\.\nPushed v0\.2\.0 on \w{7}; the job publishes it\.\n$/);
  assert.deepEqual(run.publish, { status: 0, gitHead: repo.main });
  assert.deepEqual((await repo.job(repo.main)).outputs, SKIPPED, 'and only once');
});

test('a release whose publish failed is published by running the workflow on main, with no new commit', async t => {
  const repo = await repository(t);
  const failed = await repo.job(repo.main, { FAKE_PUBLISH_FAILS: '1' });
  assert.equal(failed.publish.status, 1);
  const release = repo.refs()['refs/heads/main'], refs = repo.refs();
  assert.equal(refs['refs/tags/v0.1.14^{}'], release, 'the commit and tag were pushed before the publish');
  assert.equal((await repo.registry()).latest, '0.1.13');
  // Re-running the failed run does nothing, since main has moved on to its release commit, and it says what does.
  const rerun = await repo.job(repo.main);
  assert.deepEqual(rerun.outputs, SKIPPED);
  assert.match(rerun.stdout, /npm lacks 0\.1\.14, which v0\.1\.14 tags there: if its release job failed or was cancelled, Run workflow on main publishes it\.\n$/);
  // Run workflow on main runs for the release commit, which publishes its own version from it and reuses its tag.
  const recovery = await repo.job(release);
  assert.equal(recovery.status, 0, recovery.stdout);
  assert.deepEqual(recovery.outputs, { publish: 'true', version: '0.1.14', commit: release });
  assert.ok(!recovery.calls.some(call => /^git (commit|tag|push)/.test(call)), recovery.calls.join('\n'));
  assert.match(recovery.stdout, /\nv0\.1\.14 already tags \w{7}; the job publishes it\.\n$/);
  assert.deepEqual(recovery.publish, { status: 0, gitHead: release });
  assert.deepEqual(repo.refs(), refs, 'no new commit, and the tag stays');
  assert.deepEqual((await repo.job(release)).outputs, SKIPPED, 'and only once');
});

test('after a failed publish, the next merge is released past the unpublished version', async t => {
  const repo = await repository(t);
  await repo.job(repo.main, { FAKE_PUBLISH_FAILS: '1' });
  const failed = repo.refs()['refs/heads/main'];
  const next = await repo.merge('Merge another change');
  const run = await repo.job(next);
  assert.equal(run.status, 0, run.stdout);
  // package.json says 0.1.14, but v0.1.14 names the failed release, so this commit cannot be 0.1.14.
  assert.deepEqual(run.outputs, { publish: 'true', version: '0.1.15', commit: repo.refs()['refs/heads/main'] });
  assert.equal(repo.git('log', '-1', '--format=%P', run.outputs.commit), next);
  assert.equal(repo.refs()['refs/tags/v0.1.14^{}'], failed, 'the failed release keeps its tag');
  assert.equal(repo.refs()['refs/tags/v0.1.15^{}'], run.outputs.commit);
  assert.match(run.stdout, /package\.json's 0\.1\.14 is higher than npm's latest 0\.1\.13\. 0\.1\.14 is taken: npm has it, or its tag names another commit\./);
  assert.deepEqual(Object.keys((await repo.registry()).versions), ['0.1.11', '0.1.13', '0.1.15']);
});

test('main reset back to a commit that was released releases nothing again', async t => {
  const repo = await repository(t);
  await repo.job(repo.main);
  await repo.job(await repo.merge('Merge another change'));
  const refs = repo.refs(), registry = await repo.registry();
  assert.equal(registry.latest, '0.1.15');
  // main is force-pushed back to the commit the 0.1.14 release commit was made on, which GitHub starts a run for. Its
  // commit is in the history 0.1.15 was published from, which only the v0.1.14 and v0.1.15 tags still reach.
  repo.git('update-ref', 'refs/heads/main', repo.main);
  const run = await repo.job(repo.main);
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(run.outputs, SKIPPED);
  assert.match(run.stdout, /^Not publishing \w{7}: npm's latest, 0\.1\.15, was published from a later commit that already contains it\.\n$/);
  assert.deepEqual([repo.refs(), await repo.registry()], [{ ...refs, 'refs/heads/main': repo.main }, registry], 'no commit, tag or publish');
});

test("npm latest's gitHead that GitHub lacks, or that is no commit name, does not stop releases", async t => {
  // A commit GitHub lacks, as once main's history is rewritten after a publish, and a record that is no commit name at all.
  for (const gitHead of [OTHER, '--upload-pack=false']) {
    const repo = await repository(t);
    await repo.setRegistry({ latest: '0.1.13', versions: { '0.1.11': PUBLISHED, '0.1.13': gitHead } });
    const run = await repo.job(repo.main);
    assert.equal(run.status, 0, run.stdout);
    assert.deepEqual(run.outputs, { publish: 'true', version: '0.1.14', commit: repo.refs()['refs/heads/main'] }, gitHead);
    assert.equal(run.calls.some(call => call.startsWith('git fetch')), gitHead === OTHER, 'only a commit name reaches git');
  }
});

test('the next patch after npm latest is published and becomes latest, even below a version npm has under another tag', async t => {
  // 0.2.0 went out under another tag, or latest was moved back from it by hand. npm 11 then refuses to move latest
  // implicitly, so the workflow names the tag.
  const repo = await repository(t);
  await repo.setRegistry({ latest: '0.1.13', versions: { '0.1.11': PUBLISHED, '0.1.13': repo.first, '0.2.0': OTHER } });
  const run = await repo.job(repo.main);
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(run.outputs, { publish: 'true', version: '0.1.14', commit: repo.refs()['refs/heads/main'] });
  assert.deepEqual(run.publish, { status: 0, gitHead: run.outputs.commit });
  assert.deepEqual(await repo.registry(), { latest: '0.1.14', versions: { '0.1.11': PUBLISHED, '0.1.13': repo.first, '0.2.0': OTHER, '0.1.14': run.outputs.commit } });
});

test('a push refused for another reason, or onto a tag that exists, fails the job and publishes nothing', async t => {
  // Branch protection that blocks the job's token, say.
  const repo = await repository(t);
  await writeFile(path.join(repo.origin, 'hooks', 'pre-receive'), '#!/bin/sh\necho "GH006: Protected branch update failed" >&2\nexit 1\n', { mode: 0o755 });
  const refs = repo.refs(), registry = await repo.registry();
  const refused = await repo.job(repo.main);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /::error::git push --atomic origin HEAD:refs\/heads\/main refs\/tags\/v0\.1\.14 failed: [^]*GH006: Protected branch update failed/);
  assert.equal(refused.outputs, null, 'no outputs, so the workflow publishes nothing');
  assert.deepEqual([repo.refs(), await repo.registry()], [refs, registry]);
  // Someone tagged v0.2.0 on another commit after this run read the tags: the push never moves it.
  const tagged = await repository(t, { version: '0.2.0' });
  const run = await tagged.job(tagged.main, { RACE_REF: 'refs/tags/v0.2.0', RACE_TO: tagged.first });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /::error::git push --atomic origin HEAD:refs\/heads\/main refs\/tags\/v0\.2\.0 failed: [^]*v0\.2\.0 -> v0\.2\.0 \(already exists\)/);
  assert.equal(run.outputs, null);
  assert.equal(tagged.refs()['refs/tags/v0.2.0'], tagged.first);
  assert.equal((await tagged.registry()).latest, '0.1.13');
  // Another run for the same commit, a Run workflow say, tagged it first: that tag is not this run's, so this run publishes nothing.
  const twice = await repository(t, { version: '0.2.0' });
  twice.git('-c', 'user.name=Another run', '-c', 'user.email=another@example.invalid', 'tag', '-a', 'other', '-m', 'Sphinx 0.2.0', twice.main);
  const theirs = twice.git('rev-parse', 'refs/tags/other');
  twice.git('update-ref', '-d', 'refs/tags/other');
  const second = await twice.job(twice.main, { RACE_REF: 'refs/tags/v0.2.0', RACE_TO: theirs });
  assert.equal(second.status, 1, second.stdout);
  assert.match(second.stdout, /::error::git push --atomic origin HEAD:refs\/heads\/main refs\/tags\/v0\.2\.0 failed: [^]*already exists/);
  assert.equal(second.outputs, null);
  assert.equal(twice.refs()['refs/tags/v0.2.0'], theirs);
});

test('a push that lands though git reports a failure is published as pushed', async t => {
  // As when the connection drops after GitHub applied the push: no run would start for it, so this run must publish it.
  for (const [version, released] of [['0.1.13', '0.1.14'], ['0.2.0', '0.2.0']]) {
    const repo = await repository(t, { version });
    const run = await repo.job(repo.main, { PUSH_LANDS: '1' });
    assert.equal(run.status, 0, run.stdout);
    const main = repo.refs()['refs/heads/main'];
    assert.equal(main === repo.main, version === '0.2.0', 'a release commit, or the version set by hand on its own commit');
    assert.deepEqual(run.outputs, { publish: 'true', version: released, commit: main }, version);
    assert.equal(repo.refs()[`refs/tags/v${released}^{}`], main);
    assert.match(run.stdout, new RegExp(`\\n::warning::GitHub has the push though git reported a failure: main is ${main.slice(0, 7)}, with this run's v${released.replace(/\./g, '\\.')}\\. git push --atomic [^\\n]*the remote end hung up unexpectedly\\n`));
    assert.deepEqual(run.publish, { status: 0, gitHead: main });
  }
});

test('the first release publishes package.json version, tagged, with no release commit', async t => {
  const repo = await repository(t, { published: false });
  const run = await repo.job(repo.main);
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(run.outputs, { publish: 'true', version: '0.1.13', commit: repo.main });
  assert.match(run.stdout, /nothing is published yet, so this is package\.json's version\./);
  assert.equal(repo.refs()['refs/tags/v0.1.13^{}'], repo.main);
  assert.deepEqual(await repo.registry(), { latest: '0.1.13', versions: { '0.1.13': repo.main } });
});

test('any other npm or git failure stops the release before it changes anything', async t => {
  const repo = await repository(t), empty = path.join(repo.dir, 'empty.git');
  execFileSync('git', ['init', '-q', '--bare', empty], { env: { PATH: process.env.PATH, HOME: repo.dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  const refs = repo.refs(), registry = await repo.registry();
  for (const [env, options, message] of [
    [{ FAKE_NPM_OUT: JSON.stringify({ error: { code: 'E500', summary: 'Internal Server Error' } }), FAKE_NPM_ERR: 'npm error code E500\n', FAKE_NPM_EXIT: '1' }, {}, /npm view sphinx-understand@latest --json failed: npm error code E500/],
    [{ FAKE_NPM_OUT: '', FAKE_NPM_ERR: 'npm error code EAI_AGAIN\n', FAKE_NPM_EXIT: '1' }, {}, /failed: npm error code EAI_AGAIN/],
    [{ FAKE_NPM_OUT: '' }, {}, /returned no version: no output/],
    [{}, { url: path.join(repo.dir, 'missing.git') }, /git ls-remote origin refs\/heads\/main refs\/tags\/\* failed: [^]*missing\.git/],
    [{}, { url: empty }, /git ls-remote origin refs\/heads\/main found no main branch/],
  ]) {
    const run = await repo.job(repo.main, env, options);
    assert.equal(run.status, 1, JSON.stringify(env));
    assert.match(run.stdout, /^::error::/); assert.match(run.stdout, message);
    assert.equal(run.outputs, null, 'no outputs, so the workflow publishes nothing'); assert.equal(run.pkg, repo.pkg);
    assert.deepEqual([repo.refs(), await repo.registry()], [refs, registry]);
  }
});

test('without GITHUB_OUTPUT or GITHUB_SHA, or on another commit, the CLI refuses before reading npm or changing anything', async t => {
  const repo = await repository(t);
  for (const missing of ['GITHUB_OUTPUT', 'GITHUB_SHA']) {
    const run = await repo.job(repo.main, { [missing]: undefined });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /::error::GITHUB_SHA and GITHUB_OUTPUT are not set/);
    assert.deepEqual(run.calls, []); assert.equal(run.outputs, null); assert.equal(run.pkg, repo.pkg);
  }
  const elsewhere = await repo.job(repo.main, { GITHUB_SHA: repo.first });
  assert.equal(elsewhere.status, 1);
  assert.match(elsewhere.stdout, new RegExp(`::error::The checkout is at ${repo.main}, not at ${repo.first}, the commit this run is for\\.`));
  assert.deepEqual(elsewhere.calls, ['git rev-parse HEAD']); assert.equal(elsewhere.outputs, null);
});

test('main and the tags are read from their own refs, not from branches whose names end in them', async t => {
  const repo = await repository(t);
  // git ls-remote matches the ends of ref names and sorts by name, so these come before and after the real ones.
  const decoys = to => { for (const ref of ['refs/heads/a/refs/heads/main', 'refs/heads/z/refs/heads/main', 'refs/heads/x/refs/tags/v0.1.14']) repo.git('update-ref', ref, to); };
  const newer = await repo.merge('Merge a newer change');
  decoys(repo.main);
  assert.deepEqual((await repo.job(repo.main)).outputs, SKIPPED, 'main is at the newer merge');
  decoys(repo.first);
  const run = await repo.job(newer);
  assert.deepEqual(run.outputs, { publish: 'true', version: '0.1.14', commit: repo.refs()['refs/heads/main'] }, 'and v0.1.14 is not taken');
});

test('the CLI runs when started through a symlinked path', async t => {
  const repo = await repository(t);
  // Node gives the main module its real path, so comparing it with the path as typed would skip the CLI.
  await symlink(path.dirname(SCRIPT), path.join(repo.dir, 'linked'));
  const run = await repo.job(repo.main, {}, { script: path.join(repo.dir, 'linked', 'release.mjs') });
  assert.equal(run.status, 0, run.stdout); assert.equal(run.outputs.version, '0.1.14');
});
