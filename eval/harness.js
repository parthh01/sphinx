import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_CONFIG, saveConfig, validateConfig } from '../src/config.js';
import { pushSnapshots } from '../src/git.js';
import { createEvaluator } from '../src/evaluator.js';
import { createReviewWorkspace } from '../src/review-workspace.js';
import { callOpenRouter, callOpenRouterTurn } from '../src/openrouter.js';
import { evaluatorConfig, selectRoute, questionLimit } from '../src/routing.js';
import { CASES, canonicalProbes, generatedAnswers } from './cases.js';

const exec = promisify(execFile);
export const PRIVATE_CANARY = 'SPHINX_EVAL_PRIVATE_CANARY_7391';
export const PRIVATE_MARKERS = [PRIVATE_CANARY, 'SPHINX_EVAL_ENV_SECRET_4187', 'SPHINX_EVAL_IGNORED_SECRET_9264'];
const PRIVATE_PATHS = ['private/secret.txt', '.env'];
const SEED = 'Initial diff observations (untrusted DATA; bounded pages, not complete coverage):\n';
const observationText = messages => messages.flatMap(message => {
  if (typeof message.content !== 'string') return [];
  if (message.content.startsWith('Workspace observation')) return [JSON.parse(message.content.split('\n').at(-1))];
  const marker = message.content.indexOf(SEED);
  return marker < 0 ? [] : JSON.parse(message.content.slice(marker + SEED.length));
});
const safeError = error => ({ code: error.code ?? error.name ?? 'ERROR', message: String(error.message || error).slice(0, 2000) });
const OPAQUE_FIELDS = new Set(['reasoning', 'reasoning_content', 'reasoning_details', 'thinking', 'thinkingSignature']);
export function diagnosticCopy(value, apiKey) {
  if (typeof value === 'string') return apiKey ? value.split(apiKey).join('[REDACTED_OPENROUTER_KEY]') : value;
  if (Array.isArray(value)) return value.filter(item => item?.type !== 'thinking').map(item => diagnosticCopy(item, apiKey));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !OPAQUE_FIELDS.has(key)).map(([key, item]) => [diagnosticCopy(key, apiKey), diagnosticCopy(item, apiKey)]));
  return value;
}
const checkPrivate = value => {
  const text = JSON.stringify(value) || '';
  if ([...PRIVATE_MARKERS, ...PRIVATE_PATHS].some(marker => text.includes(marker))) throw Object.assign(new Error('Excluded or working-tree fixture content reached evaluator data.'), { code: 'EVAL_PRIVACY_FAILURE' });
};

export function createBudget({ maxCalls = 20, maxCost, delayMs = 0, apiKey } = {}) {
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000) throw new Error('max-calls must be an integer from 1 to 1000.');
  if (maxCost !== undefined && (!Number.isFinite(maxCost) || maxCost <= 0)) throw new Error('max-cost must be positive USD.');
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000) throw new Error('delay-ms must be an integer from 0 to 60000.');
  let lastActivity = 0;
  const state = { limit: maxCalls, calls: 0, reportedCostUsd: 0, costReports: 0, missingCostReports: 0, inputTokens: 0, outputTokens: 0, responses: [] };
  return {
    state,
    async beforeCall() {
      if (state.calls >= maxCalls) throw Object.assign(new Error('Evaluation run-wide model-call limit reached; no next request was made.'), { code: 'EVAL_CALL_BUDGET' });
      if (maxCost !== undefined && (state.reportedCostUsd >= maxCost || state.missingCostReports > 0 || state.calls > state.responses.length)) throw Object.assign(new Error('Evaluation cost guard stopped further requests; the reported threshold was reached or a prior request omitted its cost.'), { code: 'EVAL_COST_BUDGET' });
      const remainingDelay = lastActivity + delayMs - Date.now();
      if (remainingDelay > 0) await delay(remainingDelay);
      state.calls++; lastActivity = Date.now();
    },
    record(data, status, headers) {
      lastActivity = Date.now();
      const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
      const usage = data?.usage;
      const cost = numeric(usage?.cost);
      const entry = { status, costUsd: cost, inputTokens: numeric(usage?.prompt_tokens), outputTokens: numeric(usage?.completion_tokens), model: typeof data?.model === 'string' ? data.model.slice(0, 200) : null };
      const error = data?.error ?? data?.choices?.[0]?.error;
      const scrub = (value, limit) => typeof value !== 'string' ? null : diagnosticCopy(value, apiKey)
        .replace(/\bBearer\s+[^\s,;"']+/giu, 'Bearer [REDACTED]')
        .replace(/\b(?:sk-or-v1-|sk-|or-v1-)[a-zA-Z0-9_-]{8,}/gu, '[REDACTED_CREDENTIAL]')
        .replace(/\b(api[_ -]?key|authorization|access[_ -]?token|password|secret)\s*[:=]\s*["']?[^\s,;"']+/giu, '$1=[REDACTED]')
        .replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, limit);
      const type = error?.metadata?.error_type;
      if (typeof type === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(type)) entry.errorType = scrub(type, 80);
      const provider = scrub(error?.metadata?.provider_name ?? data?.provider, 80);
      if (provider) entry.providerName = provider;
      const message = scrub(error?.message, 300);
      if (message) entry.errorMessage = message;
      const retry = headers?.get?.('retry-after');
      if (typeof retry === 'string' && (/^\d{1,12}(?:\.\d{1,3})?$/u.test(retry) || (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(retry) && Number.isFinite(Date.parse(retry))))) entry.retryAfter = retry;
      state.responses.push(entry);
      if (cost === null) state.missingCostReports++; else { state.reportedCostUsd += cost; state.costReports++; }
      state.inputTokens += entry.inputTokens || 0; state.outputTokens += entry.outputTokens || 0;
    },
  };
}

/** Observe bounded usage and sanitized failure telemetry while the production
 * adapter consumes its normal bounded stream. Never retain raw bodies/headers. */
export function meteredFetch(fetchImpl, budget) {
  return async (...args) => {
    checkPrivate(args[1]?.body);
    let response;
    try { response = await fetchImpl(...args); }
    catch (error) { budget.record(null, null); throw error; }
    if (!response.body) { budget.record(null, response.status, response.headers); return response; }
    const chunks = []; let size = 0, recorded = false;
    const record = () => {
      if (recorded) return; recorded = true;
      let data; try { if (size <= 1024 * 1024) data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Missing telemetry is explicit. */ }
      budget.record(data, response.status, response.headers);
    };
    const stream = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) { size += chunk.length; if (size <= 1024 * 1024) chunks.push(Buffer.from(chunk)); else { chunks.length = 0; record(); } controller.enqueue(chunk); },
      flush() { record(); },
      cancel() { record(); },
    }));
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export async function createFixture(fixture, config) {
  const directory = await mkdtemp(join(tmpdir(), `sphinx-eval-${fixture.id}-`));
  const repo = join(directory, 'repo'), home = join(directory, 'home');
  await mkdir(repo); await mkdir(home);
  // Do not inherit Git command scope, agent sessions, user configuration, or auth.
  const env = { PATH: process.env.PATH, HOME: home, SPHINX_HOME: home, SPHINX_USER_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
  const git = async (...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env })).stdout.trim();
  const writeFiles = async files => {
    for (const [file, text] of Object.entries(files)) { await mkdir(dirname(join(repo, file)), { recursive: true }); await writeFile(join(repo, file), text); }
  };
  try {
    await git('init', '-b', 'main'); await git('config', 'user.name', 'Sphinx evaluation'); await git('config', 'user.email', 'eval@example.invalid');
    await writeFiles({ 'package.json': '{"type":"module"}\n', 'README.md': `${fixture.title}\n${fixture.context}\n`, '.sphinxcontext.md': `${fixture.context}\n`, '.sphinxignore': 'private/**\n', '.env': 'KEY=base-placeholder\n', 'private/secret.txt': 'base-placeholder\n', ...fixture.before });
    await git('add', '.'); await git('commit', '-m', 'fixture base'); const base = await git('rev-parse', 'HEAD');
    await writeFiles({ ...fixture.after, '.env': `KEY=${PRIVATE_MARKERS[1]}\n`, 'private/secret.txt': `${PRIVATE_MARKERS[2]}\n` }); await git('add', '.'); await git('commit', '-m', 'fixture change'); const head = await git('rev-parse', 'HEAD');
    await exec(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; ${fixture.oracle}`], { cwd: repo, env });
    await saveConfig(config, env);
    const [snapshot] = await pushSnapshots({ cwd: repo, remote: 'origin', remoteUrl: 'https://example.invalid/synthetic-eval', input: `refs/heads/main ${head} refs/heads/main ${base}\n`, config, env });
    if (!snapshot) throw new Error('Synthetic fixture unexpectedly created no checkpoint.');
    const dirtyPath = Object.keys(fixture.after)[0];
    await writeFiles({ [dirtyPath]: `${fixture.after[dirtyPath]}\n${PRIVATE_CANARY}\n`, 'untracked-secret.txt': PRIVATE_CANARY });
    return { directory, repo, env, snapshot, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export function qualityFindings(fixture, assessment, ceiling) {
  const findings = [];
  if (!assessment.questions.length || assessment.questions.length > ceiling) findings.push({ code: 'QUESTION_COUNT', severity: 'failure', detail: `Expected 1–${ceiling} questions.` });
  const visible = assessment.questions.map(q => q.prompt).join('\n').toLowerCase();
  for (const concept of fixture.concepts) if (!concept.any.some(term => visible.includes(term))) findings.push({ code: 'CONCEPT_COVERAGE', severity: 'review', detail: `The visible question does not clearly test ${concept.label}; rubric-only coverage does not count.` });
  for (const q of assessment.questions) {
    const causalOrBoundary = /\b(?:why|explain|reason|mechanism|boundary|boundaries|ordering|both|compare|compared|versus|instead|rather than|still|remain|unchanged|even if|despite|for each)\b|\bhow (?:does|do|would|can|is|are|will)\b/iu.test(q.prompt);
    if (!causalOrBoundary) findings.push({ code: 'MISSING_CAUSAL_OR_BOUNDARY_PROMPT', severity: 'review', questionId: q.id, detail: 'The visible question requests an outcome without an explicit causal explanation or comparison; inspect whether this tests understanding or recall.' });
    if (!causalOrBoundary && /\bwhat (?:will be (?:the )?|is (?:the )?|are (?:the )?|(?:the )?)(?:vertical padding|padding(?:-block)?|batch size|default value|value|status(?: code)?)\b/iu.test(q.prompt)) findings.push({ code: 'CHANGED_LITERAL_RECALL', severity: 'failure', questionId: q.id, detail: 'The question asks for a literal value without testing its cause or a contrasting condition.' });
    if (/\b(?:which|what) (?:file|function name|class name|constant name)|\b(?:name the|spell|syntax of|hex code|pixel value)\b/iu.test(q.prompt)) findings.push({ code: 'MECHANICAL_TRIVIA', severity: 'failure', questionId: q.id, detail: 'Question appears to ask naming, location, syntax, or style-number recall.' });
    if (fixture.id === 'cosmetic' && /\b(?:how many pixels|exact (?:padding|pixel|value)|what (?:is|are) the (?:padding|gap) value)|\bwhat (?:(?:will be|is) the (?:vertical padding|padding-block)|(?:vertical and horizontal |vertical |horizontal )?padding (?:does|do))\b/iu.test(q.prompt)) findings.push({ code: 'STYLE_NUMEROLOGY', severity: 'failure', questionId: q.id, detail: 'Cosmetic assessment should test the propagation boundary, not memorized CSS values.' });
    if (fixture.id === 'cosmetic' && /\b(?:how much (?:height|taller)|(?:bigger|larger|more prominent|taller))\b/iu.test(q.prompt) && !/\b(?:toolbar|ancestor|scope|propagat|both|outside)\w*/iu.test(q.prompt)) findings.push({ code: 'WEAK_STYLE_QUESTION', severity: 'review', questionId: q.id, detail: 'Question appears to restate the visual edit without testing its propagation or an unchanged surface.' });
  }
  return findings;
}

export function unknownSourceSelectors(question, evidence) {
  const source = JSON.stringify(evidence);
  const observedText = evidence.flatMap(item => [item.result?.text, ...(item.result?.matches ?? []).map(match => match.text)]).filter(text => typeof text === 'string');
  const classes = new Set(observedText.flatMap(text => [...text.matchAll(/\bclass(?:Name)?\s*=\s*["']([^"']*)["']/gu)].flatMap(match => match[1].split(/\s+/u))));
  return [...new Set(question.evidence.flatMap(item => [...item.reason.matchAll(/(?<![\w/])\.[a-zA-Z][\w-]*/gu)].map(match => match[0]))
    .filter(selector => !source.includes(selector) && !classes.has(selector.slice(1))))];
}

function scriptedEvaluator(fixture, env, { missingRetention = false } = {}) {
  let sequence = 0;
  return createEvaluator({ env,
    openRouterTurn: async args => {
      checkPrivate(args.messages); await args.beforeCall();
      const seen = observationText(args.messages);
      const missing = fixture.requiredPaths.filter(path => !seen.some(item => item.paths.includes(path)));
      if (missing.length) return { calls: missing.slice(0, 8).map(path => ({ id: `read-${++sequence}`, name: 'read_file', arguments: { path, revision: 'head' } })) };
      const evidenceIds = [...new Set(fixture.requiredPaths.map(path => seen.find(item => item.paths.includes(path)).id))];
      return { calls: [{ id: `finish-${++sequence}`, name: 'finish_review', arguments: { assessment: { questions: [fixture.canonical] }, summary: fixture.correct, evidenceIds: missingRetention ? ['e-does-not-exist'] : evidenceIds } }] };
    },
    openRouter: async args => {
      checkPrivate(args.prompt); await args.beforeCall();
      const data = JSON.parse(args.prompt.split('\n').at(-1));
      if (Array.isArray(data.proposedQuestions)) return { questions: data.proposedQuestions };
      const question = { ...data.question, ...data.sourceKey };
      const verdict = data.dispute || ['unsupported-speed', 'contradictory-key'].includes(data.question.id) ? 'ambiguous' : [fixture.correct, generatedAnswers(fixture, data.question).correct].includes(data.humanAnswer) ? 'correct' : 'incorrect';
      return { verdict, questionValid: !['unsupported-speed', 'contradictory-key'].includes(data.question.id), feedback: verdict === 'incorrect' ? fixture.correct : 'The fixture evidence establishes the bounded outcome or the stated uncertainty.', evidence: data.question.evidence,
        followUp: verdict === 'incorrect' ? { ...question, id: `${question.id}-transfer`, prompt: `Consider a fresh instance with the same code and conditions. Predict the outcome and explain the mechanism: ${question.prompt}` } : null };
    },
  });
}

/** Fixed probes need the old/new change as well as current dependencies. A HEAD
 * body alone cannot support historical assertions such as a default increasing.
 * These small curated fixtures must fit a complete bounded observation. */
export async function canonicalEvidence(snapshot, paths, workspace) {
  const evidence = [];
  for (const path of paths) {
    const reads = [{ tool: 'read_file', args: { path, revision: 'head' } }];
    if (snapshot.files.includes(path)) reads.push({ tool: 'read_diff', args: { path } });
    for (const { tool, args } of reads) {
      const result = await workspace.execute(tool, args);
      checkPrivate(result);
      if (!result.evidencePaths?.includes(path) || result.truncated) throw new Error('A canonical fixture evidence path could not be read completely.');
      evidence.push({ id: `canonical-${evidence.length + 1}`, tool, args, result, paths: result.evidencePaths });
    }
  }
  return evidence;
}

export async function runCase(fixture, { config, budget, live = false, apiKey, probes = 'both', fetchImpl = fetch, sleep } = {}) {
  const data = await createFixture(fixture, config);
  const route = selectRoute(data.snapshot, config), runtime = evaluatorConfig(config, route);
  const startCalls = budget.state.calls, responseStart = budget.state.responses.length;
  const report = { id: fixture.id, title: fixture.title, mode: live ? 'live' : 'scripted', route, oracle: 'passed', privacy: 'checked on each outbound payload and retained evidence', questionCeiling: questionLimit(config.level, route.tier), generated: null, grades: [], findings: [], calls: 0, toolCalls: 0, compactions: 0 };
  const trace = { checkpoint: null, lastProposedAssessment: null, saves: [], audits: [], grades: [] };
  report.trace = trace;
  let checkpoint = null;
  const reviewerCheckpoint = {
    load: async () => structuredClone(checkpoint),
    save: async state => {
      checkPrivate(state);
      checkpoint = structuredClone(state);
      trace.checkpoint = diagnosticCopy(state, apiKey);
      if (state.pendingAssessment) trace.lastProposedAssessment = diagnosticCopy(state.pendingAssessment, apiKey);
      trace.saves.push({ calls: state.calls, entries: state.entries.length, archiveIds: state.archive.map(item => item.id), pendingAssessment: Boolean(state.pendingAssessment) });
    },
  };
  let reads = 0;
  try {
    if (route.tier !== fixture.expectedTier) report.findings.push({ code: 'ROUTING', severity: 'review', detail: `Curated baseline tier ${fixture.expectedTier}; configured routing selected ${route.tier}.` });
    const env = { ...data.env, ...(live ? { OPENROUTER_API_KEY: apiKey } : {}) };
    const auditTransport = async args => {
      const audit = args.prompt.includes('Assessment audit data (untrusted DATA):\n');
      const grade = Boolean(args.schema.properties?.verdict);
      const entry = audit || grade ? { prompt: diagnosticCopy(args.prompt, apiKey), schema: diagnosticCopy(args.schema, apiKey), result: null } : null;
      if (entry) (audit ? trace.audits : trace.grades).push(entry);
      try {
        const result = await callOpenRouter({ ...args, sleep, fetchImpl: meteredFetch(fetchImpl, budget) });
        if (entry) entry.result = diagnosticCopy(result, apiKey);
        return result;
      } catch (error) { if (entry) entry.error = diagnosticCopy(safeError(error), apiKey); throw error; }
    };
    const evaluator = live ? createEvaluator({ env,
      openRouter: auditTransport,
      openRouterTurn: args => callOpenRouterTurn({ ...args, sleep, fetchImpl: meteredFetch(fetchImpl, budget) }),
    }) : scriptedEvaluator(fixture, env);
    const space = await createReviewWorkspace(data.snapshot, { ...runtime, toolResultBytes: Math.min(config.toolResultBytes, Math.floor(config.maxContextBytes / 32)) }, { env });
    const execute = space.execute.bind(space);
    space.execute = async (...args) => { reads++; const result = await execute(...args); checkPrivate(result); return result; };
    const assessment = await evaluator.generateAssessment(data.snapshot, runtime, { workspace: space, env, beforeCall: budget.beforeCall, reviewerCheckpoint });
    checkPrivate(assessment);
    report.generated = assessment;
    report.compactions = assessment.review.compactions;
    report.findings.push(...qualityFindings(fixture, assessment, report.questionCeiling));
    // Canonical grading has its own exact reviewed evidence so an omitted
    // dependency cannot silently weaken the fixed probes.
    const fixedEvidence = probes === 'generated' ? [] : await canonicalEvidence(data.snapshot, fixture.requiredPaths, space);
    const canonicalReview = { ...assessment.review, evidence: fixedEvidence, evidencePaths: fixture.requiredPaths, summary: 'Exact fixture source and changed diffs collected independently for fixed grading probes.' };
    const checks = probes === 'generated' ? [] : canonicalProbes(fixture).map(probe => ({ ...probe, origin: 'canonical', review: canonicalReview }));
    if (probes !== 'canonical') for (const question of assessment.questions) {
      const answers = generatedAnswers(fixture, question);
      if (answers.uncovered) {
        report.findings.push({ code: 'UNCOVERED_GENERATED_SCENARIO', severity: 'review', questionId: question.id, detail: answers.uncovered });
        continue;
      }
      checks.push(
        { id: `${question.id}-grounded-answer`, question, answer: answers.correct, expected: 'correct', origin: 'generated', review: assessment.review },
        { id: `${question.id}-misconception`, question, answer: answers.wrong, expected: 'incorrect', origin: 'generated', review: assessment.review },
      );
    }
    for (const [index, probe] of checks.entries()) {
      try {
        const grade = await evaluator.gradeAnswer({ snapshot: data.snapshot, question: probe.question, answer: probe.answer, dispute: probe.dispute, config: runtime, review: probe.review, env, beforeCall: budget.beforeCall });
        const pass = grade.verdict === probe.expected;
        report.grades.push({ id: probe.id, origin: probe.origin, question: probe.question, answer: probe.answer, expected: probe.expected, actual: grade, pass });
        if (!pass) report.findings.push({ code: 'GRADE_MISMATCH', severity: 'failure', detail: `${probe.id}: expected ${probe.expected}, received ${grade.verdict}. Generated-question probes may reveal a question outside the curated behavior; inspect the saved question before classifying.` });
        if (fixture.id === 'cosmetic' && grade.followUp) {
          const unknown = unknownSourceSelectors(grade.followUp, probe.review.evidence);
          if (unknown.length) report.findings.push({ code: 'TRANSFER_SOURCE_REFERENCE', severity: 'review', detail: `${probe.id}: transfer citation mentions selectors absent from retained source (${[...new Set(unknown)].join(', ')}). Distinguish a stated hypothetical from a false source claim.` });
        }
      } catch (error) {
        report.grades.push({ id: probe.id, origin: probe.origin, expected: probe.expected, error: safeError(error), pass: false });
        report.findings.push({ code: 'GRADE_ERROR', severity: 'failure', detail: probe.id });
        if (['EVAL_CALL_BUDGET', 'EVAL_COST_BUDGET', 'OPENROUTER_PROVIDER_ERROR', 'EVALUATOR_TIMEOUT', 'OUTPUT_LIMIT'].includes(error.code) || /^PROVIDER_/u.test(error.code || '') || ['TimeoutError', 'AbortError'].includes(error.name) || !error.code) {
          report.stopped = error.code || error.name || 'TRANSPORT_ERROR';
          report.unrunProbes = checks.slice(index + 1).map(item => ({ id: item.id, origin: item.origin }));
          break;
        }
      }
    }
  } catch (error) {
    report.error = safeError(error); report.findings.push({ code: error.code || 'REVIEW_FAILED', severity: 'failure', detail: 'No valid generated assessment was accepted.' });
    if (['EVAL_CALL_BUDGET', 'EVAL_COST_BUDGET', 'OPENROUTER_PROVIDER_ERROR'].includes(error.code) || /^PROVIDER_/u.test(error.code || '') || !error.code) report.stopped = error.code || error.name || 'TRANSPORT_ERROR';
  }
  finally {
    report.calls = budget.state.calls - startCalls; report.toolCalls = reads;
    report.telemetry = budget.state.responses.slice(responseStart);
    await data.cleanup();
  }
  report.status = report.findings.some(item => item.severity === 'failure') ? 'failed' : report.findings.length ? 'needs-review' : 'passed';
  return diagnosticCopy(report, apiKey);
}

export async function runEvaluation({ cases = CASES, config = structuredClone(DEFAULT_CONFIG), maxCalls = 80, maxCost, live = false, apiKey, probes = 'both', fetchImpl, onCase, delayMs = live ? 1000 : 0, sleep } = {}) {
  validateConfig(config);
  if (!['both', 'generated', 'canonical'].includes(probes)) throw new Error('probes must be both, generated, or canonical.');
  if (live && !apiKey) throw new Error('Live evaluations require an OpenRouter key; no requests were made.');
  if (live && Object.values(config.models).some(route => route.provider !== 'openrouter')) throw new Error('Live eval currently supports OpenRouter routes only. Select --model explicitly to override all tiers.');
  const budget = createBudget({ maxCalls, maxCost, delayMs, apiKey });
  const report = { version: 1, mode: live ? 'live' : 'scripted', startedAt: new Date().toISOString(), limits: { maxCalls, maxOutputTokens: config.maxOutputTokens, delayMs, ...(maxCost !== undefined ? { maxCostUsd: maxCost } : {}) }, cases: [], usage: budget.state,
    interpretation: live ? 'Curated concept checks are heuristics; inspect generated questions, rubrics, and grading mismatches. No model judges its own quality.' : 'Scripted transports validate the real Pi/workspace/schema/grading pipeline and fixtures; they do not measure model quality.',
    costCaveat: 'Costs are provider-reported, may be absent, and already-incurred requests can exceed max-cost by one request. Missing cost stops subsequent requests when max-cost is set.' };
  for (const fixture of cases) {
    if (budget.state.calls >= maxCalls || (maxCost !== undefined && (budget.state.reportedCostUsd >= maxCost || budget.state.missingCostReports))) { report.stopped = 'run-budget'; break; }
    const result = await runCase(fixture, { config, budget, live, apiKey, probes, fetchImpl, sleep });
    report.cases.push(result); await onCase?.(result, diagnosticCopy({ ...report, status: 'running' }, apiKey));
    if (result.stopped) { report.stopped = result.stopped; break; }
  }
  report.completedAt = new Date().toISOString();
  report.status = report.cases.length !== cases.length || report.cases.some(item => item.status === 'failed') ? 'failed' : report.cases.some(item => item.status === 'needs-review') ? 'needs-review' : 'passed';
  checkPrivate(report);
  return diagnosticCopy(report, apiKey);
}
