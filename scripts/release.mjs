// Decides whether a push to main publishes to npm, and as which version. It runs in
// the release job of .github/workflows/test.yml. The version it picks is written to
// that job's checkout only: nothing is committed or tagged, so a release can never
// trigger another run. The commit goes into package.json's gitHead too: npm records it,
// which is how a later run knows a commit is already published, and an installed copy
// pins its GitHub Action to it, as releases have no tags (workflowTemplate in src/github.js).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLAIN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const numbers = version => version.split('.').map(Number);
const higher = (a, b) => { const [x, y] = [numbers(a), numbers(b)]; const index = x.findIndex((part, i) => part !== y[i]); return index >= 0 && x[index] > y[index]; };
const short = sha => sha.slice(0, 7);

/**
 * Whether to publish `commit`, and as which version. `current` is package.json's
 * version, `latest` and `latestHead` are npm's latest version and the commit it was
 * built from (both null when nothing is published), and `head` is main's commit now.
 */
export function decideRelease({ current, latest, latestHead, commit, head }) {
  if (!PLAIN.test(current)) throw new Error(`package.json's version "${current}" is not a plain x.y.z version, and releases publish only those. Set package.json's version to one.`);
  // No package.json value gets past this one: the next version is counted from npm's latest.
  if (latest !== null && !PLAIN.test(latest)) throw new Error(`npm's latest dist-tag is ${latest}, which is not a plain x.y.z version, so there is no next version to count from. Point it at a plain release (npm dist-tag add <package>@<x.y.z> latest), then re-run.`);
  if (head !== commit) return { publish: false, version: null, reason: `main is now at ${short(head)}, and that commit's run publishes.` };
  if (latestHead === commit) return { publish: false, version: null, reason: `npm's latest, ${latest}, was already built from it.` };
  if (latest === null) return { publish: true, version: current, reason: "nothing is published yet, so this is package.json's version." };
  // A version raised by hand (a major, or a patch) wins; anything else moves past npm's latest, never below it.
  if (higher(current, latest)) return { publish: true, version: current, reason: `package.json's ${current} is higher than npm's latest ${latest}.` };
  const [major, minor] = numbers(latest);
  return { publish: true, version: `${major}.${minor + 1}.0`, reason: `the next minor after npm's latest ${latest}.` };
}

const run = (command, args) => {
  try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw Object.assign(new Error(`${command} ${args.join(' ')} failed: ${String(error.stderr || error.message).trim()}`), { stdout: error.stdout }); }
};
const json = text => { try { return JSON.parse(text); } catch { return null; } };

/** npm's latest version of `name` and the commit it was built from, or nulls when it was never published. */
function npmLatest(name) {
  let out;
  try { out = run('npm', ['view', `${name}@latest`, '--json']); }
  catch (error) {
    // npm reports a package it has never seen as {"error":{"code":"E404"}} on stdout. Any other failure stops the release.
    if (json(error.stdout)?.error?.code === 'E404') return { latest: null, latestHead: null };
    throw error;
  }
  const manifest = json(out);
  if (typeof manifest?.version !== 'string') throw new Error(`npm view ${name}@latest returned no version: ${out.trim() || 'no output'}`);
  return { latest: manifest.version, latestHead: manifest.gitHead ?? null };
}

/** The commit main points to on GitHub now, which can be newer than this checkout. */
function mainHead() {
  // The pattern also matches branches whose names end in refs/heads/main, such as a/refs/heads/main.
  const head = run('git', ['ls-remote', 'origin', 'refs/heads/main']).split('\n').map(line => line.split('\t')).find(([, ref]) => ref === 'refs/heads/main')?.[0] ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new Error('git ls-remote origin refs/heads/main found no main branch.');
  return head;
}

// Node gives the main module its real path, so a path through a symlink must be resolved too.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const { GITHUB_SHA: commit, GITHUB_OUTPUT: output } = process.env;
    if (!commit || !output) throw new Error('GITHUB_SHA and GITHUB_OUTPUT are not set. This script runs in the release job of .github/workflows/test.yml.');
    const file = path.resolve('package.json'), pkg = JSON.parse(readFileSync(file, 'utf8'));
    const decision = decideRelease({ current: pkg.version, ...npmLatest(pkg.name), commit, head: mainHead() });
    // Not npm version, which commits and tags. npm publish reads this file; the repository never sees it.
    if (decision.publish) writeFileSync(file, `${JSON.stringify({ ...pkg, version: decision.version, gitHead: commit }, null, 2)}\n`);
    appendFileSync(output, `publish=${decision.publish}\nversion=${decision.version ?? ''}\n`);
    console.log(decision.publish ? `Publishing ${pkg.name}@${decision.version} from ${short(commit)}: ${decision.reason}` : `Not publishing ${short(commit)}: ${decision.reason}`);
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
