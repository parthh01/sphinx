import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { getPaths, loadConfig, policyHash, readJson, writeJson } from './config.js';
import { matches, pushSnapshots, repository, revalidateSnapshot } from './git.js';
import { yoloStatus } from './overrides.js';
import { createSessionStore } from './sessions.js';
import { curateQuietly } from './working-context.js';
import { collectGarbage } from './storage.js';

const exec = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const JOB_ID = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const errors = {
  authentication: 'Evaluator authentication is unavailable. Configure it, then run sphinx prepare --retry.',
  rate_limit: 'The evaluator rate limit was reached. Wait, then run sphinx prepare --retry.',
  call_limit: 'The assessment call limit was reached. Review maxModelCalls before retrying.',
  output_limit: 'The evaluator reached its output limit. Review maxOutputTokens or the selected model, then retry explicitly.',
  generation_failed: 'Question preparation failed. No approval was created. Run sphinx prepare --retry to try again.',
  launch_failed: 'The background worker could not start. Run sphinx prepare --retry to try again.',
  interrupted: 'The background worker stopped before finishing. Run sphinx prepare --retry to try again.',
};
const failureKind = error => /API key|sphinx auth|credentials/i.test(error.message) ? 'authentication'
  : /rate limit|429/i.test(error.message) ? 'rate_limit'
  : /call limit/i.test(error.message) ? 'call_limit'
  : /output limit|finish_reason: length/i.test(error.message) ? 'output_limit' : 'generation_failed';

async function git(cwd, args, env, optional = false) {
  try {
    const result = await exec('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
      cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
      encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024,
    });
    return result.stdout.trimEnd();
  } catch (error) {
    if (optional && typeof error.code === 'number') return '';
    throw new Error('Could not inspect local Git references for background preparation.');
  }
}

function filesFor(root, env) {
  const directory = path.join(getPaths(env).home, 'preparations', digest(root));
  return { directory, latest: path.join(directory, 'latest.json'), lock: path.join(directory, 'state.lock'), job: id => {
    if (!JOB_ID.test(id)) throw new Error('Invalid preparation job ID.');
    return path.join(directory, `${id}.json`);
  } };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

async function locked(files, operation) {
  await mkdir(files.directory, { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { handle = await open(files.lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(files.lock, null).catch(() => null);
      const age = await stat(files.lock).then(info => Date.now() - info.mtimeMs).catch(() => 0);
      if ((owner && !alive(owner.pid)) || (!owner && age > 30000)) await unlink(files.lock).catch(() => {});
      else await delay(10);
    }
  }
  if (!handle) throw new Error('Preparation state is busy. Try again shortly.');
  try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await operation(); }
  finally { await handle.close(); await unlink(files.lock).catch(() => {}); }
}

async function trackingRef(root, remote, ref, env) {
  const specs = (await git(root, ['config', '--get-all', `remote.${remote}.fetch`], env, true)).split('\n');
  for (const raw of specs) {
    const [source, target] = raw.replace(/^\+/, '').split(':');
    if (!source || !target || source.startsWith('^')) continue;
    if (source === ref) return target;
    const index = source.indexOf('*');
    if (index >= 0 && source.indexOf('*', index + 1) < 0 && ref.startsWith(source.slice(0, index)) && ref.endsWith(source.slice(index + 1))) {
      return target.replace('*', ref.slice(index, ref.length - (source.length - index - 1)));
    }
  }
  return '';
}

// The push to prepare is the one git push makes or, where plain git push
// refuses (no upstream yet, or one with another name under push.default
// simple), the git push -u <remote> HEAD an agent runs instead. Both reach the
// same-named branch on the push remote, unless remote.<name>.push maps it or
// push.default upstream sends it to the upstream branch. A destination with no
// remote-tracking ref is a first push: Git reports the zero OID as its old
// value, so pushSnapshots starts from the branch point exactly as the hook will.
// All commands below read local config/refs; none contact a remote.
async function expectedSnapshots(root, sourceRef, head, config, env) {
  const setting = key => git(root, ['config', '--get', key], env, true);
  const mode = await setting('push.default');
  if (mode === 'nothing') return [];
  const branch = sourceRef.slice('refs/heads/'.length);
  const upstreamRemote = await setting(`branch.${branch}.remote`);
  let remote = await setting(`branch.${branch}.pushRemote`) || await setting('remote.pushDefault') || upstreamRemote;
  if (!remote) {
    const remotes = (await git(root, ['remote'], env)).split('\n').filter(Boolean);
    remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '';
  }
  // %(push:remoteref) is set only when remote.<name>.push maps this branch.
  const [mapped, upstream] = (await git(root, ['for-each-ref', '--format=%(push:remoteref)%00%(upstream:remoteref)', sourceRef], env, true)).split('\0');
  const ref = mapped || (remote === upstreamRemote && ['upstream', 'tracking'].includes(mode) && upstream) || sourceRef;
  if (!remote || remote === '.' || !ref.startsWith('refs/heads/')) return [];
  if (!config.branches.some(pattern => matches(pattern, ref.slice(11))) || !config.remotes.some(pattern => matches(pattern, remote))) return [];
  const tracking = await trackingRef(root, remote, ref, env);
  if (!tracking) return [];
  const known = await git(root, ['rev-parse', '--verify', '--end-of-options', `${tracking}^{commit}`], env, true);
  const old = OID.test(known) ? known : '0'.repeat(head.length);
  if (old === head) return [];
  const urls = [...new Set((await git(root, ['remote', 'get-url', '--push', '--all', remote], env, true)).split('\n').filter(Boolean))];
  // Unusual fan-out configurations are left to the actual push checkpoint.
  if (!urls.length || urls.length > 4) return [];
  const snapshots = [];
  // Once the first URL takes a first push, Git writes the tracking ref, so the
  // other URLs start from head and their checkpoints have nothing to check.
  for (const remoteUrl of OID.test(known) ? urls : urls.slice(0, 1)) snapshots.push(...await pushSnapshots({ cwd: root, remote, remoteUrl, input: `${sourceRef} ${head} ${ref} ${old}\n`, config, env }));
  return snapshots;
}

async function planFor({ cwd, env, config }) {
  if (env.SPHINX_EVALUATOR === '1') return { reason: 'Evaluator subprocesses do not prepare assessments.' };
  const repo = await repository(cwd);
  config ??= await loadConfig(repo.root, env);
  if (config.backgroundPreparation === false || !config.enabled || !config.events.includes('pre-push')) return { reason: 'Background push preparation is disabled.', repo };
  // Yolo skips the push check, so preparing its questions would only spend model calls.
  const yolo = await yoloStatus(repo.root, env);
  if (yolo) return { reason: `Yolo mode is on ${yolo.scope === 'repo' ? 'for this repository' : 'globally'}; background review is paused.`, repo };
  const sourceRef = await git(repo.root, ['symbolic-ref', '--quiet', 'HEAD'], env, true);
  const head = await git(repo.root, ['rev-parse', '--verify', 'HEAD'], env, true);
  if (!sourceRef || !OID.test(head)) return { reason: 'No committed branch is checked out.', repo };
  const snapshots = await expectedSnapshots(repo.root, sourceRef, head, config, env);
  if (!snapshots.length) return { reason: 'No changed protected destination is expected for this branch.', repo };
  const id = digest(JSON.stringify({ version: 1, root: repo.root, sourceRef, head, policy: policyHash(config), snapshots: snapshots.map(snapshot => snapshot.id).sort() }));
  return { id, config, repo, snapshots };
}

function summary(record) {
  if (!record) return null;
  return {
    jobId: record.id, status: record.status, prepared: record.prepared.length, total: record.total,
    scheduledAt: record.scheduledAt, updatedAt: record.updatedAt,
    ...(Object.hasOwn(errors, record.errorCode) ? { error: errors[record.errorCode] } : {}),
  };
}

export async function preparationStatus({ cwd = process.cwd(), env = process.env } = {}) {
  const repo = await repository(cwd);
  const files = filesFor(repo.root, env);
  const latest = await readJson(files.latest, null);
  const record = latest && JOB_ID.test(latest.id) ? await readJson(files.job(latest.id), null) : null;
  if (record && ['scheduled', 'running'].includes(record.status)
      && (Number.isInteger(record.pid) || Date.now() - Date.parse(record.scheduledAt) > 30000) && !alive(record.pid)) {
    return summary({ ...record, status: 'failed', errorCode: 'interrupted' });
  }
  return summary(record);
}

export async function schedulePreparation({ cwd = process.cwd(), env = process.env, cliPath, config, retry = false, spawnImpl = spawn } = {}) {
  const plan = await planFor({ cwd, env, config });
  if (!plan.id) {
    if (plan.repo) {
      const oldFiles = filesFor(plan.repo.root, env);
      if (await readJson(oldFiles.latest, null)) await locked(oldFiles, () => writeJson(oldFiles.latest, { id: null }));
    }
    return { status: 'skipped', reason: plan.reason };
  }
  if (!path.isAbsolute(cliPath || '')) throw new Error('Preparation requires an absolute Sphinx CLI path.');
  const files = filesFor(plan.repo.root, env);
  return locked(files, async () => {
    let previous = await readJson(files.job(plan.id), null);
    if (previous && ['scheduled', 'running'].includes(previous.status) && !alive(previous.pid)) {
      previous.status = 'failed'; previous.errorCode = 'interrupted'; previous.updatedAt = new Date().toISOString();
      await writeJson(files.job(plan.id), previous);
    }
    await writeJson(files.latest, { id: plan.id });
    if (previous && previous.status !== 'stale' && !(retry && previous.status === 'failed')) return { status: 'existing', state: previous.status, jobId: plan.id };
    const now = new Date().toISOString();
    const record = { version: 1, id: plan.id, status: 'scheduled', total: plan.snapshots.length, prepared: [], scheduledAt: now, updatedAt: now, pid: null };
    await writeJson(files.job(plan.id), record);
    try {
      const child = spawnImpl(process.execPath, [cliPath, 'prepare', '--worker'], {
        cwd: plan.repo.root, env: { ...env, SPHINX_PREPARATION_JOB: plan.id }, detached: true, stdio: 'ignore',
      });
      await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
      record.pid = child.pid;
      child.unref();
      await writeJson(files.job(plan.id), record);
    } catch {
      record.status = 'failed'; record.errorCode = 'launch_failed'; await writeJson(files.job(plan.id), record);
      return { status: 'failed', jobId: plan.id, error: errors.launch_failed };
    }
    return { status: 'scheduled', jobId: plan.id, total: record.total };
  });
}

export async function runPreparation({ cwd = process.cwd(), env = process.env, config, store, generate, wait = delay, curate } = {}) {
  if (env.SPHINX_EVALUATOR === '1') return { status: 'skipped', prepared: [], reason: 'Evaluator subprocesses do not prepare assessments.' };
  const repo = await repository(cwd), files = filesFor(repo.root, env);
  const latest = await readJson(files.latest, null);
  const id = env.SPHINX_PREPARATION_JOB || latest?.id;
  if (!JOB_ID.test(id || '')) return { status: 'skipped', prepared: [], reason: 'No preparation was scheduled.' };
  const initial = await readJson(files.job(id), null);
  if (!initial || initial.status !== 'scheduled') return { status: 'existing', prepared: initial?.prepared || [] };
  const initialConfig = config || await loadConfig(repo.root, env);
  const remaining = Date.parse(initial.scheduledAt) + (initialConfig.preparationDebounceMs ?? 1500) - Date.now();
  if (remaining > 0) await wait(remaining);
  const claimed = await locked(files, async () => {
    const record = await readJson(files.job(id), null), current = await readJson(files.latest, null);
    if (!record || record.status !== 'scheduled') return null;
    if (current?.id !== id) { record.status = 'stale'; await writeJson(files.job(id), record); return null; }
    record.status = 'running'; record.pid = process.pid; record.updatedAt = new Date().toISOString();
    await writeJson(files.job(id), record); return record;
  });
  if (!claimed) return { status: 'skipped', prepared: [], reason: 'Preparation was superseded or already claimed.' };
  const finish = async (status, errorCode) => {
    claimed.status = status; claimed.updatedAt = new Date().toISOString();
    if (errorCode) claimed.errorCode = errorCode;
    await locked(files, () => writeJson(files.job(id), claimed));
    await collectGarbage({ env });
    return { status, prepared: claimed.prepared, ...(errorCode ? { error: errors[errorCode] } : {}) };
  };
  // Yolo can be turned on while this worker runs. Every reviewer request
  // re-checks it, and unstarted checks left behind are removed.
  const ensured = [];
  const yoloOn = () => yoloStatus(repo.root, env).catch(() => null);
  const paused = async () => {
    for (const sessionId of ensured) await store.discard(sessionId).catch(() => {});
    return finish('stale');
  };
  try {
    const plan = await planFor({ cwd: repo.root, env, config });
    if (plan.id !== id) return finish('stale');
    store ??= createSessionStore({ env, generate, validate: async (snapshot, currentConfig) => {
      if (await yoloOn()) throw new Error('Yolo mode was turned on; background review is paused.');
      const effective = await loadConfig(snapshot.repoRoot, env);
      if (policyHash(effective) !== policyHash(currentConfig) || !await revalidateSnapshot(snapshot, effective, { env })) throw new Error('The snapshot or policy changed before preparation.');
    } });
    // One cheap free-model call keeps the branch's working context current, so
    // the review below and the one at push time start already oriented.
    const lead = plan.snapshots[0];
    await curateQuietly({ repoRoot: repo.root, sourceRef: lead.sourceRef, base: lead.base, head: lead.head, config: plan.config, env, wait, call: curate });
    for (const snapshot of plan.snapshots) {
      const current = await readJson(files.latest, null);
      if (current?.id !== id) return finish('stale');
      const session = await store.ensure(snapshot, plan.config);
      ensured.push(session.id);
      const fresh = await planFor({ cwd: repo.root, env, config });
      if (await yoloOn()) return paused();
      if (fresh.id !== id || !await revalidateSnapshot(snapshot, plan.config, { env })) return finish('stale');
      await store.prepare(session.id, plan.config, { wait: true });
      ensured.pop();
      claimed.prepared.push(snapshot.id);
    }
    return finish('ready');
  } catch (error) { return await yoloOn() ? paused() : finish('failed', failureKind(error)); }
}
