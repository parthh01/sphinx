import { createServer } from 'node:http';
import path from 'node:path';
import { readStats, scoreSummary } from './stats.js';
import { planProviders } from './evaluator.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DISTANCES, loadConfig, policyHash, readJson, repositoryConfigInfo, saveConfig } from './config.js';
import { revalidateSnapshot, repositoryName } from './git.js';
import { createSessionStore, savedDraft } from './sessions.js';
import { prepareInteractiveCheck, isRateLimit, isCliFailure, switchChoices, PLAN_NAMES } from './check-recovery.js';
import { claimCheckpointDialog, finishCheckpointDialog, waitForCheckpointTerminal } from './terminal-launch.js';
import { browserPage } from './browser-page.js';
import { recordOverride } from './overrides.js';
import { withTextStream, partialField } from './stream.js';
import { loadChangeView } from './change-view.js';
import { updateStatus, updatePlan, scheduleUpdate } from './update.js';
import { modelChoices, validChoice } from './model-choices.js';
import { setRepositoryDistance } from './repo-config.js';
import { pullRequestPush, usesSphinxAction } from './github.js';

const ID = /^[a-f0-9]{64}$/u;
const cancelled = () => Object.assign(new Error('Check paused. Progress is saved.'), { code: 'SPHINX_CANCELLED' });
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const offLimits = env => env.SPHINX_EVALUATOR === '1' || (env.CI && !['false', '0'].includes(env.CI));

/**
 * A quiet macOS notification that questions are waiting, since the page opens
 * in a background tab. Never steals focus; text travels as arguments, never as
 * script. Skipped over SSH, in CI, and off macOS. Never throws.
 */
export function notifyDesktop({ title, message, env = process.env, platform = process.platform, spawnImpl = spawn } = {}) {
  if (platform !== 'darwin' || offLimits(env) || env.SSH_CONNECTION || env.SSH_TTY) return false;
  try {
    const child = spawnImpl('/usr/bin/osascript', ['-e', 'on run argv\n  display notification (item 2 of argv) with title (item 1 of argv)\nend run', String(title), String(message)], { env, stdio: 'ignore', detached: false });
    child.once?.('error', () => {});
    return true;
  } catch { return false; }
}

/** macOS has an explicit background-open flag. Elsewhere print the local URL;
 * do not guess at window-manager focus rules or invoke a foreground opener. */
export async function openQuestionnaireBrowser(url, { env = process.env, platform = process.platform, spawnImpl = spawn } = {}) {
  if (offLimits(env) || env.SSH_CONNECTION || env.SSH_TTY || platform !== 'darwin') return false;
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) throw new Error('Invalid local questionnaire URL.');
  return new Promise(resolve => {
    let child, timer, settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    try { child = spawnImpl('/usr/bin/open', ['-g', url], { env, stdio: 'ignore' }); }
    catch { finish(false); return; }
    child.once('error', () => finish(false));
    child.once('exit', code => finish(code === 0));
    timer = setTimeout(() => { child.kill(); finish(false); }, 5000);
  });
}

async function readBody(req, limit) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new Error('Request too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

function publicFields(state) {
  if (!state) return {};
  return {
    id: state.id, target: state.target, event: state.event,
    route: state.route && { provider: state.route.provider, model: state.route.model, tier: state.route.tier },
    progress: state.progress, usage: state.usage, tokens: state.tokens,
    ...(state.question ? { question: { id: state.question.id, prompt: state.question.prompt, choices: state.question.choices || [] } } : {}),
    ...(state.feedback ? { feedback: state.feedback } : {}),
  };
}

/** One loopback page for a whole Git batch. The caller closes it after Git has
 * independently verified the receipt. All form inputs come from the browser,
 * never from tool arguments; no private evaluator data enters HTTP responses. */
export function createBrowserInterview({ env = process.env, signal, timeoutMs = 25 * 60 * 1000,
  store: providedStore, readConfig = loadConfig, revalidate = revalidateSnapshot,
  reserve = claimCheckpointDialog, release = finishCheckpointDialog, waitForExisting = waitForCheckpointTerminal,
  openBrowser = openQuestionnaireBrowser, notify = notifyDesktop, output = line => process.stderr.write(`${line}\n`), logOverride = recordOverride, findPlans = planProviders,
  loadView = loadChangeView, checkUpdate = updateStatus, planUpdate = updatePlan, startUpdate = scheduleUpdate, watchMs = 1000,
} = {}) {
  const token = randomBytes(32).toString('base64url'), nonce = randomBytes(24).toString('base64');
  let server, origin, url, opened = false, closed = false, active, skip, resolver, sequence = 0, waitingGit = false;
  // A pause stops the waiting Git operation, and this page's server with it, so
  // the only way back is to run it again. Say so, with the command when known.
  let resumeCommand = null;
  const pauseMessage = () => waitingGit
    ? 'Paused. Your progress is saved, and the waiting push was stopped. To continue, run the same push again; Sphinx reopens at this question.'
    : 'Paused. Your progress is saved. To continue, run the command below; Sphinx reopens at this question.';
  let state = { phase: 'waiting', operationClosed: false, revision: randomUUID(), sequence, message: 'Waiting for the checkpoint.', messages: [] };
  // The chat transcript for the current checkpoint lives only in this process.
  // It contains public questions, feedback, and the human's own text.
  let transcript = [], turns = 0, score = null;
  // The installed version and whether npm has a newer one. Display only.
  let update = null;
  // The repository's name, which in a worktree differs from its folder.
  let repoName = null;
  // The reviewer picker: offered choices, plus what the running check is doing,
  // because a switch means something different in each phase.
  let models = null, reviewAttempt = null, grading = false, switchModel = null, pendingDefault = null;
  // This check's understanding distance, and a change for the repository's next checks.
  // Distance is part of the check's policy, so it is written only when this check ends.
  let distance = null;
  const afterClose = [];
  // Whether to post the Sphinx stamp to the pull request, per checkpoint; read by the Git hook after a pass.
  let stamp = null; const stampChoices = new Map();
  // The repository's understanding score, refreshed after every graded answer.
  const refreshScore = async (repoRoot, operationEnv) => { score = scoreSummary(await readStats(repoRoot, operationEnv)); };
  // Read-only display of the checkpoint's frozen comparison. It is loaded
  // beside the questionnaire and can never block, grade, or approve it.
  let view, evidence, evidenceKey;
  const viewState = () => !view ? undefined : view.status === 'ready'
    ? { status: 'ready', header: view.model.header, totals: view.model.totals }
    : { status: view.status, ...(view.reason ? { reason: view.reason } : {}) };
  const say = item => { transcript = [...transcript, { id: `m${++turns}`, ...item }]; };
  const settle = status => { transcript = transcript.map(item => item.role === 'human' && item.status === 'checking' ? { ...item, status } : item); };
  const showQuestion = visible => {
    const question = visible?.question;
    const number = visible?.progress ? visible.progress.completed + 1 : null;
    // A question is new by its place as well as its ID: a follow-up's invented ID
    // can match a later question's, which must still be shown.
    if (!question || transcript.some(item => item.kind === 'question' && item.questionId === question.id && item.number === number)) return;
    say({ role: 'sphinx', kind: 'question', questionId: question.id, number, followUp: transcript.some(item => item.kind === 'question' && item.number === number), text: question.prompt, choices: question.choices || [] });
  };
  const streams = new Set();
  const writeEvent = (stream, event) => {
    if (stream.destroyed || stream.writableEnded) { streams.delete(stream); return; }
    try {
      // A disconnected or stalled page must not retain an ever-growing buffer
      // or interrupt the assessment. EventSource reconnects with current state.
      if (stream.writableLength > 256 * 1024) stream.destroy();
      else stream.write(event);
    } catch { stream.destroy(); streams.delete(stream); }
  };
  // Display-only updates (change view, evidence) keep the revision, so they
  // never turn an answer already in flight into a stale submission.
  const publish = (next, { display = false } = {}) => {
    state = { ...next, messages: transcript, ...(score ? { score } : {}), ...(update ? { update } : {}), ...(repoName ? { repoName } : {}), ...(models ? { models: { groups: models.groups, reviewing: !!reviewAttempt, busy: grading } } : {}), ...(distance ? { distance: { current: distance.current, next: distance.next, scope: distance.scope } } : {}), ...(stamp ? { stamp } : {}), change: viewState(), evidence: evidence && evidence.checkpoint === next.id ? { questionId: evidence.questionId, refs: evidence.refs } : undefined, waitingGit, operationClosed: closed, revision: display ? next.revision : randomUUID(), sequence: ++sequence };
    const event = `data: ${JSON.stringify(state)}\n\n`;
    for (const stream of streams) writeEvent(stream, event);
  };
  // `watch` polls for work done outside this page; a truthy result ends the wait as { action: 'saved' }.
  const waitForAction = (next, allowed, watch) => new Promise((resolve, reject) => {
    active.signal.throwIfAborted();
    const polling = new AbortController();
    const onAbort = () => { polling.abort(); resolver = undefined; reject(active.signal.reason || cancelled()); };
    const cleanup = () => { polling.abort(); active?.signal.removeEventListener('abort', onAbort); };
    resolver = { allowed, resolve: value => { cleanup(); resolver = undefined; resolve(value); }, reject: error => { cleanup(); resolver = undefined; reject(error); } };
    active.signal.addEventListener('abort', onAbort, { once: true });
    publish(next);
    if (watch) (async () => {
      const current = resolver;
      while (!polling.signal.aborted) {
        await delay(watchMs, undefined, { signal: polling.signal });
        const saved = await watch().catch(() => null);
        if (saved && resolver === current) { current.resolve({ action: 'saved', visible: saved }); return; }
      }
    })().catch(() => {});
  });
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
  const send = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
  };
  async function handle(req, res) {
    if (req.headers.host !== new URL(origin).host || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return send(res, 403, { error: 'Forbidden request.' });
    const route = req.url?.split('?')[0];
    const segments = route?.split('/') || [];
    if (!equal(segments[1], token) || segments.length > 3 || (segments[2] && !['state', 'events', 'action', 'change', 'diff'].includes(segments[2]))) return send(res, 404, { error: 'Not found.' });
    if (req.method === 'GET' && !segments[2]) {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); res.end(browserPage({ token, nonce })); return;
    }
    if (req.method === 'GET' && segments[2] === 'state') return send(res, 200, state);
    if (req.method === 'GET' && ['change', 'diff'].includes(segments[2])) {
      const query = new URL(req.url, origin).searchParams, current = view;
      if (!current || query.get('id') !== current.id || state.id !== current.id) return send(res, 409, { error: 'This checkpoint changed. Reload the current change.' });
      if (current.status !== 'ready') return send(res, current.status === 'loading' ? 202 : 200, viewState());
      try { await current.check(); } catch { return send(res, 409, { error: 'The code or settings changed. This view no longer describes the checkpoint.' }); }
      if (segments[2] === 'change') return send(res, 200, { status: 'ready', id: current.id, ...current.model.summary() });
      try { return send(res, 200, await current.model.diff(query.get('path') ?? '', { context: query.get('context') ?? '3' })); }
      catch (error) { return send(res, 404, { error: error.code === 'CHANGE_VIEW_UNAVAILABLE' ? error.message : 'This file diff is unavailable.' }); }
    }
    if (req.method === 'GET' && segments[2] === 'events') {
      if (streams.size >= 8) return send(res, 429, { error: 'Too many open questionnaire pages.' });
      res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      streams.add(res); writeEvent(res, `data: ${JSON.stringify(state)}\n\n`);
      const heartbeat = setInterval(() => writeEvent(res, ': keep-alive\n\n'), 10000); heartbeat.unref();
      res.once('close', () => { clearInterval(heartbeat); streams.delete(res); }); return;
    }
    if (req.method !== 'POST' || segments[2] !== 'action') return send(res, 405, { error: 'Unsupported method.' });
    if (req.headers.origin !== origin || !equal(req.headers['x-sphinx-token'], token) || req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 403, { error: 'Forbidden request.' });
    if (new URL(req.url, origin).searchParams.get('stamp') === '1') {
      let post; try { post = JSON.parse(await readBody(req, 256))?.post; } catch { return send(res, 400, { error: 'Invalid choice.' }); }
      if (!stamp || typeof post !== 'boolean') return send(res, 409, { error: 'There is no pull request stamp to set for this check.' });
      stamp = { ...stamp, post }; stampChoices.set(state.id, post);
      publish(state, { display: true });
      return send(res, 200, { stamp });
    }
    if (new URL(req.url, origin).searchParams.get('distance') === '1') {
      let picked; try { picked = JSON.parse(await readBody(req, 1024))?.distance; } catch { return send(res, 400, { error: 'Invalid distance.' }); }
      if (!distance) return send(res, 409, { error: 'Wait for the check to start.' });
      if (!Object.hasOwn(DISTANCES, picked)) return send(res, 400, { error: 'Choose high, mixed, or low.' });
      distance.next = picked === distance.current ? null : picked;
      publish(state, { display: true });
      return send(res, 200, { distance: { current: distance.current, next: distance.next } });
    }
    if (new URL(req.url, origin).searchParams.get('model') === '1') {
      let picked; try { picked = JSON.parse(await readBody(req, 4096)); } catch { return send(res, 400, { error: 'Invalid model choice.' }); }
      if (!switchModel || !models) return send(res, 409, { error: 'Wait for the check to start.' });
      try { return send(res, 200, await switchModel({ provider: picked?.provider, model: typeof picked?.model === 'string' ? picked.model.trim() : '', saveDefault: picked?.saveDefault === true })); }
      catch (error) { return send(res, error.status || 409, { error: error.message }); }
    }
    if (new URL(req.url, origin).searchParams.get('update') === '1') {
      // Independent of the check: the install runs only after this process exits.
      if (!update?.available || update.status === 'scheduled') return send(res, 409, { error: 'No update to install.' });
      const plan = await planUpdate().catch(() => null);
      const started = !!plan?.command && await startUpdate({ command: plan.command, env });
      update = { ...update, status: started ? 'scheduled' : 'failed' };
      publish(state, { display: true });
      return send(res, 200, { update });
    }
    let bytes = 0; const chunks = [];
    // 8,000 characters can occupy 24KB in UTF-8 or 48KB when JSON-escaped.
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 64 * 1024) { send(res, 413, { error: 'Keep your response below 8,000 characters.' }); req.destroy(); return; } chunks.push(chunk); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'Invalid response.' }); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['id', 'revision', 'action', 'response', 'questionId'].includes(key))
      || typeof data.action !== 'string' || (data.response !== undefined && (typeof data.response !== 'string' || data.response.length > 8000))) return send(res, 400, { error: 'Invalid response.' });
    // Live progress changes the revision often; Pause and Skip only need the checkpoint.
    if (!active || active.signal.aborted || data.id !== state.id || (!['pause', 'skip'].includes(data.action) && data.revision !== state.revision)) return send(res, 409, { error: 'This checkpoint changed. Use the current question.' });
    if (data.action === 'skip') {
      // Available at any step, including while the review is still running.
      skip = { reason: data.response };
      active.abort(cancelled());
      publish({ ...publicFields(state), phase: 'skipped', message: waitingGit ? 'Skipped. Git is continuing; you can close this tab.' : 'Skipped. You can close this tab.' });
      return send(res, 200, state);
    }
    if (data.action === 'pause') {
      active.abort(cancelled());
      publish({ ...publicFields(state), phase: 'paused', message: pauseMessage(), ...(resumeCommand ? { resume: resumeCommand } : {}) });
      return send(res, 200, state);
    }
    if (!resolver || !resolver.allowed.includes(data.action)) return send(res, 409, { error: 'Wait for the current step to finish.' });
    if (['answer', 'learn', 'dispute'].includes(data.action) && data.questionId !== state.question?.id) return send(res, 409, { error: 'The question changed. Use the current question.' });
    if (['answer', 'dispute'].includes(data.action) && !data.response?.trim()) return send(res, 400, { error: 'Enter an answer or a dispute reason first.' });
    const current = resolver;
    if (data.action === 'answer') say({ role: 'human', kind: 'answer', text: data.response.trim(), status: 'checking' });
    else if (data.action === 'dispute') say({ role: 'human', kind: 'dispute', text: `Dispute: ${data.response.trim()}`, status: 'checking' });
    else if (data.action === 'learn') say({ role: 'human', kind: 'learn', text: 'Explain this concept.', status: 'checking' });
    publish({ ...publicFields(state), phase: 'working', message: data.action === 'answer' ? 'Checking your reasoning…' : data.action === 'learn' ? 'Preparing an explanation…' : data.action === 'dispute' ? 'Reviewing the question…' : 'Continuing the review…' });
    send(res, 202, state); current.resolve(data);
  }
  async function ensureServer(operationEnv) {
    if (server) return;
    server = createServer((req, res) => {
      res.on('error', () => res.destroy());
      handle(req, res).catch(() => { if (!res.headersSent) send(res, 400, { error: 'Could not process this response.' }); else res.destroy(); });
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
    // Port 0 asks the OS for a free ephemeral loopback port, so an occupied
    // port cannot collide. If binding still fails, forget the half-made server
    // so a later checkpoint retries instead of serving with no origin.
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
    catch (error) { server = undefined; throw error; }
    origin = `http://127.0.0.1:${server.address().port}`; url = `${origin}/${token}`;
    Promise.resolve().then(() => checkUpdate({ env: operationEnv })).then(result => { update = result; publish(state, { display: true }); }).catch(() => {});
    output(`Sphinx questionnaire: ${url}`);
    if (!opened) {
      opened = true;
      const automatic = await Promise.resolve().then(() => openBrowser(url, { env: operationEnv })).catch(() => false);
      output(automatic ? 'Sphinx: questionnaire opened in a background browser tab. Your coding window stays in place.' : 'Sphinx: open the local URL above to answer. No application was brought to the foreground.');
    }
  }
  function startView(request, snapshot, config, operationEnv, store) {
    evidence = undefined; evidenceKey = undefined;
    const current = view = { id: request.id, status: 'loading', store, check: async () => {
      const latest = await readConfig(snapshot.repoRoot, operationEnv);
      if (policyHash(latest) !== policyHash(config) || !(await revalidate(snapshot, latest, { env: operationEnv }))) throw new Error('stale');
    } };
    Promise.resolve().then(() => loadView(snapshot, config, { env: operationEnv })).then(model => {
      if (view !== current) return;
      current.status = 'ready'; current.model = model; publish(state, { display: true }); refreshEvidence(request.id);
    }, error => {
      if (view !== current) return;
      current.status = 'unavailable';
      current.reason = error?.code === 'CHANGE_VIEW_UNAVAILABLE' ? error.message : 'The changed files could not be loaded for display.';
      publish(state, { display: true });
    });
  }
  function refreshEvidence(id) {
    const current = view;
    if (current?.status !== 'ready' || current.id !== id || !current.store) return;
    current.store.read(id).then(async session => {
      const question = session.questions?.[session.index];
      if (!question || session.status === 'passed') return;
      const key = `${id}:${question.id}`;
      if (evidenceKey === key) return;
      evidenceKey = key;
      const refs = await current.model.evidenceFor(question, session.review).catch(() => []);
      if (view !== current || evidenceKey !== key) return;
      evidence = { checkpoint: id, questionId: question.id, refs };
      publish(state, { display: true });
    }).catch(() => {});
  }
  async function present({ request, env: operationEnv = env, signal: requestSignal = signal } = {}) {
    if (offLimits(operationEnv)) return { status: 'unavailable', reason: 'noninteractive', id: request?.id };
    if (closed || active) return { status: 'unavailable', id: request?.id };
    if (!request || !ID.test(request.id) || typeof request.repoRoot !== 'string') throw new Error('Invalid browser checkpoint request.');
    const controller = new AbortController(); active = controller; skip = undefined; waitingGit = request.delivery === 'hook';
    repoName = await repositoryName(request.repoRoot).catch(() => null);
    transcript = [];
    const cancel = () => controller.abort(requestSignal?.reason || cancelled());
    requestSignal?.addEventListener('abort', cancel, { once: true });
    if (requestSignal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(cancelled()), timeoutMs);
    let reservation, finalStatus = 'pending';
    const skipped = async () => {
      // A human chose to let Git continue. Close the check and log it; never write a receipt.
      await store.skip?.(request.id).catch(() => {});
      await logOverride({ kind: 'skip', repoRoot: request.repoRoot, target: state.target, id: request.id, reason: skip.reason }, operationEnv).catch(() => {});
      return { status: 'skipped', id: request.id };
    };
    const localSignal = controller.signal;
    const validate = async (snapshot, expected) => {
      localSignal.throwIfAborted();
      const current = await readConfig(snapshot.repoRoot, operationEnv);
      if (policyHash(current) !== policyHash(expected) || !(await revalidate(snapshot, current, { env: operationEnv }))) throw new Error('The code or settings changed. Start a new Git operation for the updated change.');
      localSignal.throwIfAborted();
    };
    const store = providedStore || createSessionStore({ env: operationEnv, validate });
    try {
      localSignal.throwIfAborted();
      reservation = await reserve({ request, env: operationEnv, kind: 'browser' });
      if (reservation?.status !== 'claimed') {
        const status = await waitForExisting({ id: request.id, env: operationEnv, timeoutMs, signal: localSignal });
        return { status: status === 'passed' ? 'passed' : 'pending', id: request.id };
      }
      const session = await store.read(request.id), config = await readConfig(request.repoRoot, operationEnv);
      if (session.snapshot.repoRoot !== request.repoRoot) throw new Error('This checkpoint belongs to another repository.');
      await validate(session.snapshot, config);
      startView(request, session.snapshot, config, operationEnv, store);
      await refreshScore(request.repoRoot, operationEnv).catch(() => {});
      let visible = store.public(session);
      publish({ ...publicFields(visible), repoRoot: request.repoRoot, phase: 'working', message: 'Preparing your understanding check…' });
      await ensureServer(operationEnv);
      const notes = [];
      const recoveryUI = { warning: text => notes.push(text), note: text => notes.push(text), command: () => {} };
      const plans = await findPlans(operationEnv).catch(() => []);
      // Whether this repository chose its distance, or it comes from your machine-wide setting.
      const repoSets = await repositoryConfigInfo(request.repoRoot).then(info => info.exists && readJson(info.path)).then(local => Object.hasOwn(local || {}, 'distance')).catch(() => false);
      distance = { current: session.config?.distance ?? config.distance, next: null, scope: repoSets ? 'repository' : 'machine' };
      const target = session.snapshot.target || {}, branch = name => String(name || '').replace(/^refs\/heads\//, '');
      const source = branch(session.snapshot.sourceRef), destination = branch(target.ref);
      resumeCommand = !waitingGit ? `sphinx check --id ${request.id}`
        : session.snapshot.event === 'pre-commit' ? 'git commit'
        : target.remote && destination ? `git push ${target.remote} ${source && source !== destination ? `${source}:${destination}` : destination}` : 'git push';
      stamp = null;
      if (await pullRequestPush(session.snapshot).catch(() => false)) {
        const action = await usesSphinxAction(request.repoRoot).catch(() => false);
        stamp = { post: stampChoices.get(request.id) ?? (action || !!config.github?.comment), action };
        stampChoices.set(request.id, stamp.post);
      }
      const refreshModels = async route => { models = { groups: await modelChoices({ config, env: operationEnv, plans, current: route }).catch(() => []) }; };
      await refreshModels(visible.route);
      const applySwitch = async ({ provider, model, saveDefault }) => {
        visible = await store.switchRoute(request.id, config, provider, { model, signal: localSignal });
        if (saveDefault) pendingDefault = { provider, model };
        await refreshModels(visible.route);
        say({ role: 'sphinx', kind: 'notice', text: `Switched this check to ${[visible.route.provider === 'openai' ? 'your endpoint' : PLAN_NAMES[provider]?.[0] ?? 'OpenRouter', model].join(' ')}.${saveDefault ? ' It becomes your default when this check ends.' : ''}` });
        return visible;
      };
      let pendingSwitch = null;
      // What a picked model does depends on the phase: grade with it from now on,
      // restart a running review on it, or retry a failed review with it.
      switchModel = async picked => {
        const error = message => Object.assign(new Error(message), { status: 409 });
        const problem = validChoice(models.groups, picked.provider, picked.model, config);
        if (problem) throw Object.assign(new Error(problem), { status: 400 });
        const route = store.public(await store.read(request.id)).route;
        if (route.provider === picked.provider && route.model === picked.model) { if (picked.saveDefault) pendingDefault = picked; return { ok: true }; }
        if (grading) throw error('Switch after this answer is checked.');
        if (reviewAttempt) { pendingSwitch = picked; reviewAttempt.abort(cancelled()); return { ok: true, restarting: true }; }
        if (resolver?.allowed.includes('answer')) { await applySwitch(picked); publish({ ...state, ...publicFields(visible), route: visible.route }); return { ok: true }; }
        if (state.phase === 'recovery' && resolver) { await applySwitch(picked); resolver.resolve({ action: 'switched' }); return { ok: true }; }
        throw error('Switch once the current step finishes.');
      };
      visible = await prepareInteractiveCheck({ config, signal: localSignal, waitingGit: request.delivery === 'hook', ui: recoveryUI,
        planProviders: plans, switchRoute: provider => store.switchRoute(request.id, config, provider, { signal: localSignal }),
        inspect: async () => store.public(await store.read(request.id)),
        validate: () => validate(session.snapshot, config),
        authorizeMore: () => store.retryReview(request.id, config, { signal: localSignal }),
        start: async () => {
          for (;;) {
            notes.length = 0;
            const attempt = new AbortController(), stop = () => attempt.abort(localSignal.reason);
            localSignal.addEventListener('abort', stop, { once: true });
            reviewAttempt = attempt;
            try {
              publish({ ...publicFields(store.public(await store.read(request.id))), repoRoot: request.repoRoot, phase: 'working', message: 'Reviewing the change…' });
              return await store.start(request.id, config, { signal: attempt.signal, onProgress: text => {
                say({ role: 'sphinx', kind: 'activity', text }); publish(state);
                // Refresh tokens and cost from the per-call save without blocking review.
                store.read(request.id).then(saved => { if (active === controller && state.id === request.id) { const fresh = store.public(saved); publish({ ...state, usage: fresh.usage, tokens: fresh.tokens }); } }, () => {});
              } });
            } catch (error) {
              // A model picked mid-review stops this run; anything else is a real failure.
              if (!pendingSwitch || localSignal.aborted) throw error;
            } finally { reviewAttempt = null; localSignal.removeEventListener('abort', stop); }
            const picked = pendingSwitch; pendingSwitch = null;
            await applySwitch(picked);
            say({ role: 'sphinx', kind: 'activity', text: 'Restarting the review on the new model' });
          }
        },
        choose: async prompt => {
          const current = store.public(await store.read(request.id));
          const action = await waitForAction({ ...publicFields(current), repoRoot: request.repoRoot, phase: 'recovery', message: prompt.title, error: [prompt.description, ...notes].filter(Boolean).join('\n'), choices: prompt.choices }, prompt.choices.map(choice => choice.value));
          return action.action;
        },
      });
      if (!visible) return skip ? skipped() : { status: 'pending', id: request.id };
      let notified = false;
      while (visible.status !== 'passed') {
        localSignal.throwIfAborted();
        showQuestion(visible); refreshEvidence(request.id);
        // The page opened in a background tab; say once that questions are ready.
        if (!notified) { notified = true; notify({ title: 'Sphinx needs your answers', message: [repoName || path.basename(request.repoRoot), String(session.snapshot.target?.ref || '').replace(/^refs\/heads\//, '')].filter(Boolean).join(' → '), env: operationEnv }); }
        // Answers can also arrive from sphinx answer or a terminal check. Follow
        // the saved session so this page, and the Git operation waiting on it, keep up.
        const shown = visible;
        const draft = savedDraft(await store.read(request.id));
        const action = await waitForAction({ ...publicFields(visible), repoRoot: request.repoRoot, phase: 'question', ...(draft ? { draft } : {}), ...(visible.browserError ? { error: visible.browserError } : {}) }, ['answer', 'learn', 'dispute'], async () => {
          const saved = store.public(await store.read(request.id));
          return saved.status === 'passed' || saved.progress.completed !== shown.progress.completed || saved.question?.id !== shown.question?.id ? saved : null;
        });
        if (action.action === 'saved') {
          visible = action.visible;
          if (visible.feedback && visible.feedback !== shown.feedback) say({ role: 'sphinx', kind: 'feedback', text: visible.feedback });
          await refreshScore(request.repoRoot, operationEnv).catch(() => {});
          continue;
        }
        try {
          await validate(session.snapshot, config);
          // Type the grader's feedback into the conversation as it streams.
          // Only the first streamed feedback is shown; the saved result replaces it.
          let draft, step, frozen = false, lastPublish = 0;
          const onText = raw => {
            if (frozen) return;
            const field = partialField(raw, 'feedback');
            if (!field?.text) return;
            if (!draft) { say({ role: 'sphinx', kind: 'feedback', streaming: !field.complete, text: field.text }); draft = transcript.at(-1).id; }
            else transcript = transcript.map(item => item.id === draft ? { ...item, text: field.text, ...(field.complete ? { streaming: false } : {}) } : item);
            if (field.complete) {
              frozen = true;
              // The model is still writing the rest of its reply; say what, so the page never looks stalled.
              const next = action.action === 'learn' || ['incorrect', 'ambiguous'].includes(partialField(raw, 'verdict')?.text) ? 'Writing a new scenario to try…' : 'Finishing up…';
              say({ role: 'sphinx', kind: 'activity', text: next }); step = transcript.at(-1).id;
            }
            const now = Date.now();
            if (field.complete || now - lastPublish > 60) { lastPublish = now; publish(state); }
          };
          const dropDraft = () => { transcript = transcript.filter(item => item.id !== draft && item.id !== step); };
          grading = true; publish(state, { display: true });
          visible = await withTextStream(onText, () => store.answer(request.id, action.action === 'learn' ? 'I do not know. Explain this concept and give me a different scenario to apply it to.' : action.response.trim(), config, {
            learn: action.action === 'learn', dispute: action.action === 'dispute', expectedQuestionId: action.questionId, signal: localSignal,
          })).finally(() => { dropDraft(); grading = false; });
          settle('graded');
          await refreshScore(request.repoRoot, operationEnv).catch(() => {});
          if (visible.feedback) say({ role: 'sphinx', kind: 'feedback', text: visible.feedback });
          // Without a usable new question no new bubble appears, so say that the same one stays open.
          if (visible.status !== 'passed' && visible.question?.id === action.questionId) say({ role: 'sphinx', kind: 'notice', text: 'The same question is still open.' });
        } catch (error) {
          settle('not-graded');
          localSignal.throwIfAborted(); await validate(session.snapshot, config);
          visible = store.public(await store.read(request.id));
          // A rate-limited API route can hand grading to the user's coding-agent plan.
          if ((isRateLimit(error, visible.route) || isCliFailure(error, visible.route)) && switchChoices(plans, visible.route.provider).length) {
            const choices = [...switchChoices(plans, visible.route.provider), { value: 'back', label: 'Back to the question', description: 'Keep the current model and try again later. Your draft answer is kept.' }];
            const picked = await waitForAction({ ...publicFields(visible), repoRoot: request.repoRoot, phase: 'recovery', message: isRateLimit(error, visible.route) ? 'Grading was rate limited' : `${PLAN_NAMES[visible.route.provider][0]} could not grade this answer`, error: error.message, choices }, choices.map(choice => choice.value));
            if (picked.action.startsWith('switch-')) {
              const provider = picked.action.slice('switch-'.length);
              visible = await store.switchRoute(request.id, config, provider, { signal: localSignal });
              say({ role: 'sphinx', kind: 'notice', text: `Switched this check to ${PLAN_NAMES[provider][0]}. Send your answer again.` });
              continue;
            }
          }
          publish({ ...publicFields(visible), repoRoot: request.repoRoot, phase: 'question', error: error.message, message: 'Your response was not accepted. Review the error before submitting again.' });
          // Re-display through waitForAction on the next iteration; never resend.
          visible = { ...visible, browserError: error.message };
        }
      }
      localSignal.throwIfAborted(); await validate(session.snapshot, config);
      finalStatus = 'passed';
      publish({ ...publicFields(visible), repoRoot: request.repoRoot, phase: 'passed', message: visible.noQuestionReason ? `No questions needed: ${visible.noQuestionReason} You can close this tab${waitingGit ? '; Git is finishing the push on its own' : ''}.` : waitingGit ? 'You passed. You can close this tab; Git is finishing the push on its own.\nThis records your answers, not a review of every changed line.' : 'You passed. You can close this tab.\nThis records your answers, not a review of every changed line.' });
      return { status: 'passed', id: request.id };
    } catch (error) {
      settle('not-graded');
      if (skip) return skipped();
      // The waiting Git operation discarded this check because it no longer applies.
      if (localSignal.reason?.code === 'SPHINX_STALE') publish({ ...publicFields(state), repoRoot: request.repoRoot, phase: 'error', message: 'This check no longer applies.', error: localSignal.reason.message });
      else publish({ ...publicFields(state), repoRoot: request.repoRoot, phase: localSignal.aborted ? 'paused' : 'error', message: localSignal.aborted ? pauseMessage() : 'The check could not finish. Saved progress and completed checkpoints are retained.', ...(localSignal.aborted ? (resumeCommand ? { resume: resumeCommand } : {}) : { error: error.message }) });
      return { status: 'pending', id: request.id };
    } finally {
      clearTimeout(timer); requestSignal?.removeEventListener('abort', cancel); resolver?.reject(cancelled()); resolver = undefined;
      if (reservation?.status === 'claimed') await release({ id: request.id, token: reservation.token, status: finalStatus, env: operationEnv });
      // Settings chosen for future checks are part of a check's policy, and the
      // Git hook re-checks that policy after this returns. Write them on close().
      if (pendingDefault) {
        const { provider, model } = pendingDefault; pendingDefault = null;
        afterClose.push(() => loadConfig(undefined, operationEnv).then(saved => saveConfig({ ...saved, models: { small: { provider, model }, medium: { provider, model }, large: { provider, model } } }, operationEnv)));
      }
      if (distance?.next) { const { next } = distance, root = request.repoRoot; afterClose.push(() => setRepositoryDistance(root, next, { env: operationEnv })); }
      switchModel = null; models = null; distance = null; stamp = null;
      active = undefined;
    }
  }
  async function close() {
    closed = true; active?.abort(cancelled()); resolver?.reject(cancelled()); resolver = undefined;
    for (const write of afterClose.splice(0)) await write().catch(() => {});
    if (server) {
      // A passed checkpoint may be followed by another destination. Only this
      // explicit end-of-operation update tells the page to stop reconnecting.
      publish(state);
      // Flush the final SSE update before closing the per-operation listener.
      await delay(40);
      for (const stream of streams) stream.end(); streams.clear();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
  }
  // stampChoice(id): the human's choice to post a checkpoint's stamp to its PR, or undefined when not offered.
  return { present, close, stampChoice: id => stampChoices.get(id), get url() { return url; }, get state() { return structuredClone(state); } };
}
