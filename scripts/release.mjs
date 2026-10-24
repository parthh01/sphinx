// Releases each push to main that passes the tests, in the release job of .github/workflows/test.yml.
// The version is the next patch after npm's latest, or a higher one set by hand in package.json. A new
// version is committed to main as "Release <version> [skip ci]", the commit to publish is tagged
// v<version>, and one atomic push sends both before the job publishes, so npm never records a commit
// GitHub lacks. If main moves on meanwhile, the push is rejected and nothing is published.
//
// A release commit never releases again, by three guards that test/release.test.js pins: the job's own
// token pushes it, and GitHub starts no run for that; its [skip ci] skips push runs whatever pushed it;
// and decideRelease skips any commit npm already published from, which a published release commit is,
// or that is already in the history npm's latest was published from, such as one main is reset back to.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PLAIN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const numbers = version => version.split('.').map(Number);
const higher = (a, b) => { const [x, y] = [numbers(a), numbers(b)]; const index = x.findIndex((part, i) => part !== y[i]); return index >= 0 && x[index] > y[index]; };
const nextPatch = version => { const [major, minor, patch] = numbers(version); return `${major}.${minor}.${patch + 1}`; };
const short = sha => sha.slice(0, 7);
/** The release commit's message: [skip ci] keeps GitHub from starting push runs for it, whatever token pushed it. */
export const releaseMessage = version => `Release ${version} [skip ci]`;
// The identity GitHub gives commits made with a job's own token. git takes a tag's tagger from the committer.
const NAME = 'github-actions[bot]', EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';
const BOT = { GIT_AUTHOR_NAME: NAME, GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: NAME, GIT_COMMITTER_EMAIL: EMAIL };

/**
 * Whether to release `commit`, and as which version. `current` is package.json's version; `latest` and
 * `latestHead` are npm's latest version and the commit it was published from, and `versions` every version
 * npm has (null, null and [] before the first publish); `contained` says latestHead's history already has
 * `commit`. `tags` maps the repository's tags to the commits they name, and `head` is main's commit now.
 * `bump` asks for a release commit that sets the version, and `tag` for tagging the commit to publish,
 * which is that release commit, or `commit` when there is none.
 */
export function decideRelease({ current, latest, latestHead, versions, tags, commit, head, contained = false }) {
  if (!PLAIN.test(current)) throw new Error(`package.json's version "${current}" is not a plain x.y.z version, and releases publish only those. Set package.json's version to one.`);
  // No package.json value gets past this one: the next version is counted from npm's latest.
  if (latest !== null && !PLAIN.test(latest)) throw new Error(`npm's latest dist-tag is ${latest}, which is not a plain x.y.z version, so there is no next version to count from. Point it at a plain release (npm dist-tag add <package>@<x.y.z> latest), then re-run.`);
  const skip = reason => ({ publish: false, version: null, bump: false, tag: false, reason });
  if (head !== commit) {
    // A release commit whose job failed or was cancelled after its push gets no run of its own, so say how it is published.
    const unpublished = Object.entries(tags).find(([name, sha]) => sha === head && name[0] === 'v' && PLAIN.test(name.slice(1)) && !versions.includes(name.slice(1)))?.[0];
    return skip(`main is now at ${short(head)}, and only main's newest commit releases.${unpublished ? ` npm lacks ${unpublished.slice(1)}, which ${unpublished} tags there: if its release job failed or was cancelled, Run workflow on main publishes it.` : ''}`);
  }
  // A commit is released once at most, so a release commit, which is what gets published, never releases again.
  if (latestHead === commit) return skip(`npm's latest, ${latest}, was already published from it.`);
  // Nor does a commit npm's latest already contains, such as one main is reset back to: npm has something newer.
  if (contained) return skip(`npm's latest, ${latest}, was published from a later commit that already contains it.`);
  const published = versions.find(version => tags[`v${version}`] === commit);
  if (published) return skip(`npm already has ${published}, and v${published} tags it.`);
  const start = latest === null || higher(current, latest) ? current : nextPatch(latest);
  // npm never takes a version twice. A version's tag may name only this commit, and only when it already
  // carries that version: a tag anywhere else is a release whose publish failed, so its version is skipped.
  const taken = version => versions.includes(version) || (tags[`v${version}`] !== undefined && (version !== current || tags[`v${version}`] !== commit));
  let version = start;
  while (taken(version)) version = nextPatch(version);
  const reason = latest === null ? "nothing is published yet, so this is package.json's version." : start === current ? `package.json's ${current} is higher than npm's latest ${latest}.` : `the next patch after npm's latest ${latest}.`;
  // A release commit is always tagged, which is what pushes it: npm must never record a commit GitHub lacks.
  const bump = version !== current;
  return { publish: true, version, bump, tag: bump || tags[`v${version}`] === undefined, reason: version === start ? reason : `${reason} ${start} is taken: npm has it, or its tag names another commit.` };
}

const run = (command, args, env) => {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }); }
  catch (error) { throw Object.assign(new Error(`${command} ${args.join(' ')} failed: ${String(error.stderr || error.message).trim()}`), { stdout: error.stdout }); }
};
const git = (...args) => run('git', args).trim();
const json = text => { try { return JSON.parse(text); } catch { return null; } };

/** npm's latest version of `name`, the commit it was published from, and every published version; nulls and [] when it was never published. */
function npmLatest(name) {
  let out;
  try { out = run('npm', ['view', `${name}@latest`, '--json']); }
  catch (error) {
    // npm reports a package it has never seen as {"error":{"code":"E404"}} on stdout. Any other failure stops the release.
    if (json(error.stdout)?.error?.code === 'E404') return { latest: null, latestHead: null, versions: [] };
    throw error;
  }
  const manifest = json(out);
  if (typeof manifest?.version !== 'string') throw new Error(`npm view ${name}@latest returned no version: ${out.trim() || 'no output'}`);
  return { latest: manifest.version, latestHead: manifest.gitHead ?? null, versions: [].concat(manifest.versions ?? []) };
}

/** The commit main points to on GitHub now, which can be newer than this checkout, the commit each tag names, and each ref's object. */
function origin() {
  // ls-remote matches patterns against the ends of ref names, so a/refs/heads/main matches too: only exact names count.
  const refs = Object.fromEntries(git('ls-remote', 'origin', 'refs/heads/main', 'refs/tags/*').split('\n').map(line => line.split('\t').reverse()));
  const head = refs['refs/heads/main'] ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('git ls-remote origin refs/heads/main found no main branch.');
  // An annotated tag is listed twice: as the tag object, and with ^{} as the commit it names.
  const tags = Object.fromEntries(Object.keys(refs).filter(ref => ref.startsWith('refs/tags/') && !ref.endsWith('^{}')).map(ref => [ref.slice('refs/tags/'.length), refs[`${ref}^{}`] ?? refs[ref]]));
  return { head, tags, refs };
}

/** Whether `commit` is in the history of `latestHead`, the commit npm's latest was published from, which it fetches to see. */
function contains(latestHead, commit) {
  // npm's record goes to git as an argument, so it must be a commit name and not an option.
  if (!/^[0-9a-f]{40,64}$/.test(latestHead ?? '') || latestHead === commit) return false;
  // GitHub lacks it only if main's history was rewritten since, and then nothing on main now is released yet.
  try { git('fetch', '-q', '--no-tags', 'origin', latestHead); } catch { return false; }
  return spawnSync('git', ['merge-base', '--is-ancestor', commit, latestHead]).status === 0;
}

/** Sets `version` in package.json and package-lock.json, changing nothing else in them. */
function setVersion(version) {
  const update = (file, change) => { const data = JSON.parse(readFileSync(file, 'utf8')); change(data); writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); };
  update('package.json', pkg => { pkg.version = version; });
  update('package-lock.json', lock => { lock.version = version; lock.packages[''].version = version; });
}

/** Makes the release commit and tag `decision` asks for and pushes them to main: the commit to publish, or `moved` to main's new head. */
function push({ version, bump, tag }, commit) {
  if (bump) { setVersion(version); run('git', ['commit', '-q', '-m', releaseMessage(version), '--', 'package.json', 'package-lock.json'], BOT); }
  // Only a version package.json already carries, whose tag already names this commit: a publish that failed.
  if (!tag) return { published: commit };
  run('git', ['tag', '-a', `v${version}`, '-m', `Sphinx ${version}`], BOT);
  // One atomic push: the tag never lands without its commit, and neither lands once main has moved on, as
  // HEAD is then behind main. A tag that already exists on GitHub is refused, never moved.
  try { git('push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/v${version}`); }
  catch (error) {
    // A push can land though git reports a failure, as when the connection drops after GitHub applied it: main at the
    // commit pushed, carrying this run's own tag object, means it landed. Another run's tag on the same commit does not.
    const { head: now, refs } = origin(), pushed = git('rev-parse', 'HEAD');
    if (now === pushed && refs[`refs/tags/v${version}`] === git('rev-parse', `refs/tags/v${version}`)) {
      console.log(`::warning::GitHub has the push though git reported a failure: main is ${short(pushed)}, with this run's v${version}. ${error.message.split('\n')[0]}`);
      return { published: pushed };
    }
    if (now === commit) throw error; // main has not moved, so this is not a race: permissions, protection or the network
    return { moved: now };
  }
  return { published: git('rev-parse', 'HEAD') };
}

// Node gives the main module its real path, so a path through a symlink must be resolved too.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { GITHUB_SHA: commit, GITHUB_OUTPUT: output } = process.env;
    if (!commit || !output) throw new Error('GITHUB_SHA and GITHUB_OUTPUT are not set. This script runs in the release job of .github/workflows/test.yml.');
    const checkout = git('rev-parse', 'HEAD');
    if (checkout !== commit) throw new Error(`The checkout is at ${checkout}, not at ${commit}, the commit this run is for.`);
    const { name, version: current } = JSON.parse(readFileSync('package.json', 'utf8'));
    const npm = npmLatest(name), { head, tags } = origin();
    const decision = decideRelease({ current, ...npm, head, tags, commit, contained: contains(npm.latestHead, commit) });
    if (decision.publish) console.log(`Releasing ${name}@${decision.version} from ${short(commit)}: ${decision.reason}`);
    const { published, moved } = decision.publish ? push(decision, commit) : {};
    // actions/checkout keeps the job's token, which can push to main, in .git/config. Only the push needed it, so the
    // steps after this one, npm publish among them, cannot read it. None there means there is nothing to read.
    try { git('config', '--local', '--unset-all', 'http.https://github.com/.extraheader'); } catch {}
    appendFileSync(output, `publish=${!!published}\nversion=${published ? decision.version : ''}\ncommit=${published ?? ''}\n`);
    if (!decision.publish) console.log(`Not publishing ${short(commit)}: ${decision.reason}`);
    else if (moved) console.log(`Not publishing ${short(commit)}: main moved on to ${short(moved)} during the release, so the push was rejected and nothing changed. ${short(moved)}'s run releases.`);
    else console.log(decision.bump ? `Pushed the release commit ${short(published)} and v${decision.version} to main; the job publishes ${short(published)}.` : decision.tag ? `Pushed v${decision.version} on ${short(published)}; the job publishes it.` : `v${decision.version} already tags ${short(published)}; the job publishes it.`);
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
