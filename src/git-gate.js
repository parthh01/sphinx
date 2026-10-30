import path from 'node:path';
import { loadConfig, policyHash } from './config.js';
import { repository, pushSnapshots, commitSnapshot, revalidateSnapshot } from './git.js';
import { createSessionStore } from './sessions.js';
import { queuePresentation, claimPresentation, listPresentations } from './presentations.js';
import { createBrowserInterview } from './browser-interview.js';
import { yoloStatus, recordOverride } from './overrides.js';
import { dropContext } from './working-context.js';
import { collectGarbage } from './storage.js';
import { scheduleStamp } from './github.js';
import { prefersTerminal, runGitTerminalCheck } from './git-interview.js';

async function snapshotsFor({ event, args, input, cwd, config, env }) {
  if (event === 'pre-push') return pushSnapshots({ cwd, remote: args[0], remoteUrl: args[1], input, config, env });
  if (event === 'pre-commit') return [await commitSnapshot({ cwd, config, env })].filter(Boolean);
  return [];
}

/** Preserve Git's operation context while the human questionnaire runs. */
export function interviewEnvironment(cwd, env) {
  const scoped = { ...env };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) {
    if (typeof env[key] === 'string' && env[key]) scoped[key] = path.resolve(cwd, env[key]);
    else delete scoped[key];
  }
  return scoped;
}

/** Wait inside Git's original hook. Never reconstruct or replay a Git command. */
export async function runGitGate({ event, args = [], input = '', cwd = process.cwd(), env = process.env, signal,
  store: providedStore, readConfig = loadConfig, snapshotsFor: collectSnapshots = snapshotsFor,
  revalidate = revalidateSnapshot, present, readYolo = yoloStatus, logOverride = recordOverride,
  queue = queuePresentation, claim = claimPresentation, listRequests = listPresentations,
  output = line => process.stderr.write(`${line}\n`), stamp = scheduleStamp, askInTerminal = runGitTerminalCheck, watchMs = 1000,
} = {}) {
  if (env.SPHINX_EVALUATOR === '1') return 0;
  signal?.throwIfAborted();
  const repo = await repository(cwd);
  const config = await readConfig(repo.root, env);
  const snapshots = await collectSnapshots({ event, args, input, cwd, config, env });
  if (!snapshots.length) return 0;
  // Once Git continues, the branch's working context has served its purpose.
  const finished = async () => {
    for (const snapshot of snapshots) if (snapshot.event === 'pre-push') await dropContext({ repoRoot: snapshot.repoRoot, sourceRef: snapshot.sourceRef, env }).catch(() => {});
    await collectGarbage({ env });
  };
  // Names what invalidated a snapshot: 'settings', 'source', or null if it still applies.
  const staleness = async (snapshot, expected) => {
    const current = await readConfig(snapshot.repoRoot, env);
    if (policyHash(current) !== policyHash(expected)) return 'settings';
    return await revalidate(snapshot, current, { env }) ? null : 'source';
  };
  const validate = async (snapshot, expected) => {
    signal?.throwIfAborted();
    if (await staleness(snapshot, expected)) {
      throw new Error('The code, project context, or policy changed while Git was waiting. This operation was stopped; start a new Git operation for the updated change.');
    }
    signal?.throwIfAborted();
  };
  // Yolo is a straight bypass: no check is created, so nothing resurfaces later.
  const yolo = await readYolo(repo.root, env);
  if (yolo) {
    for (const snapshot of snapshots) await logOverride({ kind: 'yolo', repoRoot: repo.root, target: snapshot.target.ref, id: snapshot.id, head: snapshot.head, reason: yolo.reason }, env);
    output(`Sphinx: yolo mode is on ${yolo.scope === 'repo' ? 'for this repository' : 'globally'}; skipping the understanding check. Run sphinx yolo${yolo.scope === 'global' ? ' outside a repository' : ''} to turn it off.`);
    await finished();
    return 0;
  }
  const store = providedStore ?? createSessionStore({ env, validate });
  const retry = event === 'pre-commit' ? 'git commit' : 'git push', op = event === 'pre-commit' ? 'commit' : 'push';
  // A coding agent reads this output; it must not take a saved pass as leave to retry.
  const cutShort = `Sphinx: you passed, but this ${op} stopped before you chose to continue, so it did not go through. Your pass is saved; the next ${op} of this change asks only whether to continue. A coding agent must not retry it unless you ask.`;
  const pending = [];
  for (const snapshot of snapshots) {
    signal?.throwIfAborted();
    if (await store.approved(snapshot, config)) continue;
    const session = await store.ensure(snapshot, config);
    if (await store.passTrivial?.(session.id, config, snapshot)) { output(`Sphinx: documentation-only change to ${snapshot.target.ref}; no questions needed.`); continue; }
    pending.push({ snapshot, session });
    // A held pass is queued like any check; its questionnaire asks only whether to continue.
    output(session.held ? `Sphinx: ${session.noQuestionReason ? `${snapshot.target.ref} needed no questions` : `you passed the understanding check for ${snapshot.target.ref}`} earlier, but that ${op} did not go through.`
      : `Sphinx: understanding check needed for ${snapshot.target.ref} (${session.route.tier} change).`);
  }
  const held = pending.length && pending.every(({ session }) => session.held);

  const requests = [], skipped = new Set();
  const browser = present ? null : createBrowserInterview({ env, signal, output });
  // A settings or source change makes the waiting checks inapplicable (sphinx
  // pending stops listing them). Release Git promptly instead of leaving it
  // blocked on a questionnaire that can no longer approve this operation.
  const watcher = new AbortController();
  const waitSignal = signal ? AbortSignal.any([signal, watcher.signal]) : watcher.signal;
  let checking = false, watch, continued = false, cancelled = false;
  const discarded = () => watcher.signal.aborted && !signal?.aborted;
  try {
    // These requests belong to the waiting hook, not a post-tool callback.
    // Mark the whole batch before launching so sibling tools cannot open forms.
    for (const { session, snapshot } of pending) {
      signal?.throwIfAborted();
      const request = await queue(session, { env, delivery: 'hook' });
      requests.push({ ...request, event: snapshot.event });
      const old = await listRequests({ cwd: request.repoRoot, host: request.host, hostSession: request.hostSession, env });
      for (const previous of old.filter(item => item.id === request.id)) await claim(previous, { env });
    }
    if (requests.length) output(held
      ? `Sphinx: Git is waiting for you to choose in the local Sphinx questionnaire whether this ${op} should continue. Do not start another copy of this ${op}.`
      : `Sphinx: Git is waiting for your answers in the local Sphinx questionnaire. After you pass, confirm whether this ${op} should continue. Do not start another copy of this ${op}.`);
    const interviewEnv = interviewEnvironment(cwd, env);
    if (requests.length) watch = setInterval(async () => {
      if (checking || watcher.signal.aborted) return;
      checking = true;
      try {
        for (const snapshot of snapshots) {
          if (skipped.has(snapshot.id)) continue;
          const reason = await staleness(snapshot, config);
          if (!reason) continue;
          watcher.abort(Object.assign(new Error(reason === 'settings'
            ? `Sphinx settings changed while Git was waiting, so this check was discarded. This Git operation was stopped; run ${retry} again to start a fresh check.`
            : `The code or project context changed while Git was waiting, so this check was discarded. This Git operation was stopped; run ${retry} again for the updated change.`), { code: 'SPHINX_STALE' }));
          break;
        }
      } catch {} // A transient read failure is retried on the next tick; the final validation still applies.
      finally { checking = false; }
    }, watchMs);
    const passed = [];
    for (let index = 0; index < requests.length; index++) {
      signal?.throwIfAborted();
      // A push to several destinations asks whether to continue once, after the last one passes.
      const request = index < requests.length - 1 ? { ...requests[index], more: true } : requests[index];
      // Headless sessions (or interface: terminal) ask in the terminal first; the browser is the fallback.
      let result;
      try {
        result = !present && prefersTerminal(config, { env }) ? await askInTerminal({ request, env: interviewEnv, signal: waitSignal, cwd }) : null;
        if (!result || result.status === 'unavailable') result = await (present || browser.present)({ request, env: interviewEnv, signal: waitSignal });
      } catch (error) { if (!discarded()) throw error; }
      if (discarded()) { output(`Sphinx: ${watcher.signal.reason.message}`); return 1; }
      signal?.throwIfAborted();
      if (result?.status === 'unavailable') {
        // Native callbacks only run after Git exits. Keep that explicit fallback
        // for noninteractive environments without a local browser handoff.
        for (const { session } of pending.slice(index)) {
          await queue(session, { env });
          output(`Outside a supported agent, run sphinx check --id ${session.id} in your terminal.`);
        }
        output('Sphinx: no local questionnaire is available in this environment. This Git operation was stopped. Complete the queued check, then start the Git operation again.');
        return 1;
      }
      if (result?.status === 'skipped') { skipped.add(requests[index].id); output('Sphinx: understanding check skipped for this push and logged.'); continue; }
      // A coding agent reads this output. Every pass in the push stays held (see finally).
      if (result?.status === 'stopped') {
        output(`Sphinx: you stopped this ${op} after passing, so it did not go through. Your pass is saved; the next ${op} of this change asks only whether to continue. A coding agent must not retry it unless you ask.`);
        return 1;
      }
      if (result?.status !== 'passed') {
        // approved() refuses a held pass; hold() reports any saved pass, held or not.
        output(await store.hold?.(requests[index].id, config).catch(() => false) ? cutShort
          : 'Sphinx: the understanding check is incomplete, cancelled, or timed out. This Git operation was stopped; progress is saved.');
        return 1;
      }
      passed.push(requests[index].id);
    }
    // Only the last destination asks, so the loop ends only through its Continue. Until
    // then every pass stays held, so pushing an earlier destination alone still asks.
    for (const id of passed) await store.confirm?.(id, config);

    // The interview result is only a wake-up signal. Every original destination
    // needs a current receipt, including snapshots approved before the wait.
    for (const snapshot of snapshots) {
      if (skipped.has(snapshot.id)) continue;
      await validate(snapshot, config);
      if (!(await store.approved(snapshot, config))) {
        output('Sphinx: no valid completion exists for this exact change and destination. This Git operation was stopped.');
        return 1;
      }
    }
    signal?.throwIfAborted();
    continued = true;
    // Skipped checks already reported themselves; only a pass is a completed check, and a held one was completed before.
    if (requests.length > skipped.size) output(held ? 'Sphinx: continuing this Git operation.' : 'Sphinx: understanding check complete. Continuing this Git operation.');
    // GitHub stamps run detached after Git continues; they can never fail this push.
    for (const snapshot of snapshots) {
      try {
        const session = await Promise.resolve(store.read?.(snapshot.id)).catch(() => null);
        await stamp({ snapshot, session, outcome: skipped.has(snapshot.id) ? 'skipped' : 'passed', config, env, post: browser?.stampChoice?.(snapshot.id) });
      } catch { /* Best-effort only. */ }
    }
    await finished();
    return 0;
  } catch (error) { cancelled = !!signal?.aborted; throw error; } finally {
    clearInterval(watch);
    // A pass made while Git waited is not a choice to continue. Presenters save it
    // held; this also covers one made elsewhere. Stopped, timed out, cancelled, or
    // discarded before Git continued, every pass among these requests (all
    // destinations) is held, so the next push or commit of it asks again.
    const kept = [];
    if (!continued) for (const request of requests) kept.push(await store.hold?.(request.id, config).catch(() => false));
    // Cancelled (Ctrl+C, or the host ending a shell that timed out) with every pass saved: say what Stop and the deadline say.
    if (cancelled && kept.length && kept.every(Boolean)) output(cutShort);
    // A paused or cancelled batch must not reopen from an after-tool callback.
    for (const request of requests) await claim(request, { env });
    await browser?.close();
  }
}
