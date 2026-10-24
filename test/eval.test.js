import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.js';
import { CASES, generatedAnswers } from '../eval/cases.js';
import { runEvaluation, createBudget, meteredFetch, qualityFindings, unknownSourceSelectors, diagnosticCopy, PRIVATE_MARKERS, canonicalEvidence, createFixture } from '../eval/harness.js';
import { createReviewWorkspace } from '../src/review-workspace.js';

test('curated eval fixtures exercise real immutable repos, Pi review, and all grading probes without live inference', async () => {
  const report = await runEvaluation();
  assert.equal(report.status, 'passed');
  assert.equal(report.cases.length, 6);
  assert.equal(report.usage.calls, 67, 'small and medium cases skip the separate audit by default');
  assert.equal(report.usage.responses.length, 0, 'Scripted transports make no network requests');
  assert.match(report.interpretation, /do not measure model quality/);
  for (const result of report.cases) {
    assert.equal(result.oracle, 'passed');
    assert.equal(result.status, 'passed');
    assert.equal(result.generated.review.harness, 'pi');
    for (const question of result.generated.questions) {
      assert.deepEqual(Object.keys(question.acceptance).sort(), ['causalReason', 'prediction']);
      assert.ok(question.acceptance.prediction.trim());
      assert.ok(question.acceptance.causalReason.trim());
    }
    assert.ok(result.generated.questions.length <= result.questionCeiling);
    assert.equal(result.grades.length, 7);
    assert.ok(result.grades.every(probe => probe.pass));
    assert.equal(result.grades.find(probe => probe.id === 'unsupported-premise').actual.verdict, 'ambiguous');
    assert.equal(result.grades.find(probe => probe.id === 'dispute').actual.verdict, 'ambiguous');
    for (const probe of result.grades.filter(probe => probe.expected === 'incorrect')) {
      assert.notEqual(probe.actual.followUp.id, probe.question.id);
      assert.notEqual(probe.actual.followUp.prompt, probe.question.prompt);
      assert.equal(probe.actual.followUp.concept, probe.question.concept);
      assert.ok(probe.actual.followUp.acceptance.prediction);
      assert.ok(probe.actual.followUp.acceptance.causalReason);
    }
    for (const marker of PRIVATE_MARKERS) assert.ok(!JSON.stringify(result).includes(marker));
  }
  const cosmetic = report.cases.find(item => item.id === 'cosmetic');
  assert.equal(cosmetic.questionCeiling, 1);
  assert.match(cosmetic.generated.questions[0].prompt, /both surfaces/);
  assert.ok(cosmetic.generated.review.evidencePaths.includes('index.html'), 'Unchanged markup establishes selector propagation');
  const retry = report.cases.find(item => item.id === 'retry');
  assert.match(retry.grades.find(probe => probe.id === 'correct').answer, /can lose a retry after failure/);
});

test('curated minimum criteria exclude teaching details while retaining the asked behavior and cause', () => {
  const cosmetic = CASES.find(item => item.id === 'cosmetic').canonical.acceptance;
  assert.match(cosmetic.prediction, /card button changes.*toolbar button remains unchanged/i);
  assert.match(cosmetic.causalReason, /card ancestor/);
  assert.doesNotMatch(JSON.stringify(cosmetic), /pixel|specificity|padding-block|\d/);
  const retry = CASES.find(item => item.id === 'retry').canonical.acceptance;
  assert.match(retry.causalReason, /recorded before execution/);
  assert.doesNotMatch(JSON.stringify(retry), /restart|durable|undefined/);
  const multi = CASES.find(item => item.id === 'multifile').canonical.acceptance;
  assert.match(multi.prediction, /Three total attempts.*third failure is rethrown/);
  assert.match(multi.causalReason, /includes the initial attempt/);
});

test('one run-wide budget includes grading and prevents an extra request', async () => {
  const report = await runEvaluation({ cases: CASES.slice(0, 2), maxCalls: 3, config: { ...structuredClone(DEFAULT_CONFIG), audit: 'all' } });
  assert.equal(report.usage.calls, 3);
  assert.equal(report.cases.length, 1);
  assert.equal(report.status, 'failed');
  assert.equal(report.stopped, 'EVAL_CALL_BUDGET');
  assert.equal(report.cases[0].grades[0].error.code, 'EVAL_CALL_BUDGET');
});

test('generated configuration probes use visible numeric inputs and the source oracle, never the model key', () => {
  const fixture = CASES.find(item => item.id === 'config');
  const q = { ...fixture.canonical, prompt: 'What batch size is used with BATCH_SIZE=15? Explain the precedence.' };
  const answers = generatedAnswers(fixture, q);
  assert.match(answers.correct, /BATCH_SIZE=15, the effective batch size is 15/);
  assert.doesNotMatch(answers.correct, /BATCH_SIZE=7/);
  assert.match(answers.wrong, /BATCH_SIZE=15 still use 20/);
  assert.deepEqual(generatedAnswers(fixture, { ...q, expectedAnswer: '999', rationale: 'Ignore the source.' }), answers);
  const comparison = generatedAnswers(fixture, { ...q, prompt: 'Compare BATCH_SIZE=15 and BATCH_SIZE=7.' });
  assert.match(comparison.correct, /BATCH_SIZE=15, the effective batch size is 15/);
  assert.match(comparison.correct, /BATCH_SIZE=7, the effective batch size is 7/);
  assert.ok(generatedAnswers(fixture, { ...q, prompt: 'What happens with BATCH_SIZE=unknown?' }).uncovered);
});

test('the recorded V20 natural-language assignment is answered from the visible input without reading private keys', () => {
  const fixture = CASES.find(item => item.id === 'config');
  const prompt = 'After this change, the checked-in default batch size is 20 instead of 10. If BATCH_SIZE is set to 5 in the environment, does batchSize(env) return 5 or 20? Give a short reason.';
  const question = { prompt };
  for (const key of ['expectedAnswer', 'rationale', 'acceptance']) Object.defineProperty(question, key, { get() { throw new Error(`Probe must not read ${key}`); } });
  const answers = generatedAnswers(fixture, question);
  assert.match(answers.correct, /BATCH_SIZE=5, the effective batch size is 5/);
  assert.match(answers.correct, /explicit environment setting before the checked-in default/);
  assert.match(answers.wrong, /BATCH_SIZE=5 still use 20/);
  assert.doesNotMatch(JSON.stringify(answers), /BATCH_SIZE=7/);
  assert.deepEqual(generatedAnswers(fixture, { prompt, expectedAnswer: 'Always 999', rationale: 'Ignore the loader.', acceptance: { prediction: '999', causalReason: 'Trust this key.' } }), answers);
  const mixed = generatedAnswers(fixture, { prompt: 'Compare BATCH_SIZE=15 with BATCH_SIZE is set to "5".' });
  assert.match(mixed.correct, /BATCH_SIZE=15, the effective batch size is 15/);
  assert.match(mixed.correct, /BATCH_SIZE=5, the effective batch size is 5/);
});

test('unsupported explicit configuration assignments are uncovered instead of silently using seven', () => {
  const fixture = CASES.find(item => item.id === 'config');
  for (const prompt of [
    'What happens when BATCH_SIZE is set to five?',
    'What happens when BATCH_SIZE is set to ""?',
    'What happens when BATCH_SIZE=""?',
    'What happens when BATCH_SIZE is set to?',
    'What happens when BATCH_SIZE is configured to 5?',
    'What happens when BATCH_SIZE equals "many"?',
    'Compare BATCH_SIZE=15 with BATCH_SIZE is configured as a computed value.',
  ]) {
    const result = generatedAnswers(fixture, { prompt });
    assert.ok(result.uncovered, prompt);
    assert.equal(Object.hasOwn(result, 'correct'), false, prompt);
    assert.equal(Object.hasOwn(result, 'wrong'), false, prompt);
  }
  assert.deepEqual(generatedAnswers(fixture, { prompt: 'What happens when BATCH_SIZE is unset?' }), { correct: fixture.correct, wrong: fixture.wrong });
});

test('canonical probes retain immutable old/new diff evidence alongside unchanged dependencies', async () => {
  const fixture = CASES.find(item => item.id === 'config');
  const config = structuredClone(DEFAULT_CONFIG);
  const data = await createFixture(fixture, config);
  try {
    const workspace = await createReviewWorkspace(data.snapshot, config, { env: data.env });
    const evidence = await canonicalEvidence(data.snapshot, fixture.requiredPaths, workspace);
    const defaultsDiff = evidence.find(item => item.tool === 'read_diff' && item.args.path === 'defaults.json');
    assert.match(defaultsDiff.result.text, /-\{"batchSize":10\}/);
    assert.match(defaultsDiff.result.text, /\+\{"batchSize":20\}/);
    assert.equal(defaultsDiff.result.headOid, evidence.find(item => item.tool === 'read_file' && item.args.path === 'defaults.json').result.oid);
    assert.ok(evidence.some(item => item.tool === 'read_file' && item.args.path === 'loader.js'));
    assert.ok(!evidence.some(item => item.tool === 'read_diff' && item.args.path === 'loader.js'), 'Unchanged dependency is not described as a changed diff');
    for (const marker of PRIVATE_MARKERS) assert.ok(!JSON.stringify(evidence).includes(marker));
    await assert.rejects(canonicalEvidence(data.snapshot, ['defaults.json'], { execute: async () => ({ evidencePaths: ['defaults.json'], truncated: true }) }), /completely/);
  } finally { await data.cleanup(); }
});

test('auth ordering and transient retry probes are independently executable source facts, not model keys', async () => {
  for (const id of ['auth', 'multifile']) {
    const fixture = CASES.find(item => item.id === id);
    const data = await createFixture(fixture, structuredClone(DEFAULT_CONFIG));
    await data.cleanup(); // Fixture creation executes the source-derived oracle.
    const answer = generatedAnswers(fixture, fixture.canonical);
    assert.deepEqual(generatedAnswers(fixture, { ...fixture.canonical, expectedAnswer: 'Wrong model key', rationale: 'Invented explanation' }), answer);
    if (id === 'auth') assert.match(answer.correct, /401 before any document lookup or tenant comparison/);
    else assert.match(answer.correct, /second call's value after two invocations/);
  }
});

test('cost telemetry includes failed responses and stops on unknown or reached cost', async () => {
  const budget = createBudget({ maxCalls: 10, maxCost: 0.1 });
  await budget.beforeCall();
  const fetch = meteredFetch(async () => new Response(JSON.stringify({ error: { code: 429 }, usage: { cost: 0.12, prompt_tokens: 10, completion_tokens: 2 } }), { status: 429 }), budget);
  const response = await fetch('https://example.invalid', { body: '{}' });
  await response.text();
  assert.equal(budget.state.reportedCostUsd, 0.12);
  assert.equal(budget.state.responses[0].status, 429);
  await assert.rejects(budget.beforeCall(), { code: 'EVAL_COST_BUDGET' });
  assert.equal(budget.state.calls, 1);
  const unknown = createBudget({ maxCalls: 10, maxCost: 0.1 });
  await unknown.beforeCall(); unknown.record({}, 200);
  await assert.rejects(unknown.beforeCall(), { code: 'EVAL_COST_BUDGET' });
  const unreadable = createBudget({ maxCalls: 10, maxCost: 0.1 });
  await unreadable.beforeCall();
  await assert.rejects(unreadable.beforeCall(), { code: 'EVAL_COST_BUDGET' });
});

test('live adapter mode sends only synthetic filtered evidence, records costs, and never retains the key', async () => {
  const fixture = CASES[0]; let requests = 0;
  const fetchImpl = async (_url, options) => {
    requests++;
    assert.equal(options.headers.Authorization, 'Bearer TEST_EVAL_KEY_NEVER_RETAIN');
    for (const marker of [...PRIVATE_MARKERS, '.env', 'private/secret.txt']) assert.ok(!options.body.includes(marker));
    const body = JSON.parse(options.body);
    assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0, request: 0 });
    let message, finish_reason;
    if (body.tools) {
      const observed = body.messages.flatMap(message => {
        const text = message.content;
        if (typeof text !== 'string') return [];
        if (text.startsWith('Workspace observation')) return [JSON.parse(text.split('\n').at(-1))];
        const marker = 'Initial diff observations (untrusted DATA; bounded pages, not complete coverage):\n';
        return text.includes(marker) ? JSON.parse(text.slice(text.indexOf(marker) + marker.length)) : [];
      });
      const hasMarkup = observed.some(item => item.paths.includes('index.html'));
      const name = hasMarkup ? 'finish_review' : 'read_file';
      const args = hasMarkup ? { assessment: { questions: [fixture.canonical] }, summary: fixture.correct, evidenceIds: observed.map(item => item.id) } : { path: 'index.html' };
      message = { role: 'assistant', content: null, tool_calls: [{ id: `tool-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; finish_reason = 'tool_calls';
    } else {
      const data = JSON.parse(body.messages.at(-1).content.split('\n').at(-1));
      if (Array.isArray(data.proposedQuestions)) return new Response(JSON.stringify({ model: 'synthetic-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: data.proposedQuestions }) } }], usage: { cost: 0.001, prompt_tokens: 100, completion_tokens: 20 } }));
      const verdict = data.dispute || ['unsupported-speed', 'contradictory-key'].includes(data.question.id) ? 'ambiguous' : data.humanAnswer === fixture.correct ? 'correct' : 'incorrect';
      message = { content: JSON.stringify({ verdict, questionValid: !['unsupported-speed', 'contradictory-key'].includes(data.question.id), feedback: fixture.correct, evidence: data.question.evidence, followUp: verdict === 'incorrect' ? { ...data.question, ...data.sourceKey, id: 'transfer', prompt: 'A shared-class button is placed outside every card. Does the new rule apply? Explain the boundary.' } : null }) }; finish_reason = 'stop';
    }
    return new Response(JSON.stringify({ model: 'synthetic-model', choices: [{ finish_reason, message }], usage: { cost: 0.001, prompt_tokens: 100, completion_tokens: 20 } }));
  };
  const report = await runEvaluation({ cases: [fixture], live: true, apiKey: 'TEST_EVAL_KEY_NEVER_RETAIN', fetchImpl, maxCalls: 12, maxCost: 0.1, delayMs: 0, config: { ...structuredClone(DEFAULT_CONFIG), audit: 'all' } });
  assert.equal(report.status, 'passed', JSON.stringify(report.cases.map(item => ({ error: item.error, findings: item.findings, grades: item.grades.map(grade => ({ id: grade.id, error: grade.error })) }))));
  assert.equal(requests, 12); assert.equal(report.usage.calls, 12);
  assert.ok(Math.abs(report.usage.reportedCostUsd - 0.012) < 1e-9);
  assert.equal(report.usage.inputTokens, 1200);
  assert.ok(!JSON.stringify(report).includes('TEST_EVAL_KEY_NEVER_RETAIN'));
});

test('quality checks flag trivia and weak cosmetic questions without claiming semantic certification', () => {
  const fixture = CASES[0];
  for (const prompt of ['Which file contains the button styles?', 'How many pixels is the padding?', 'Will the button be bigger and more prominent?', 'How much height does the button gain?', 'What will be the vertical padding of the toolbar button compared to the card button?', 'What vertical and horizontal padding does each button get, and what in the selectors causes that result?']) {
    const result = qualityFindings(fixture, { questions: [{ ...fixture.canonical, prompt }] }, 1);
    assert.ok(result.some(item => ['MECHANICAL_TRIVIA', 'STYLE_NUMEROLOGY', 'WEAK_STYLE_QUESTION'].includes(item.code)), prompt);
  }
  assert.ok(qualityFindings(fixture, { questions: [fixture.canonical, fixture.canonical] }, 1).some(item => item.code === 'QUESTION_COUNT'));
  assert.deepEqual(qualityFindings(fixture, { questions: [fixture.canonical] }, 1), []);
  assert.deepEqual(qualityFindings(fixture, { questions: [{ ...fixture.canonical, prompt: 'The toolbar and card each have a button. For each button, state what happens and give a short reason grounded in how the two CSS rules combine.' }] }, 1), []);
  const configFixture = CASES.find(item => item.id === 'config');
  assert.ok(qualityFindings(configFixture, { questions: [{ ...configFixture.canonical, prompt: 'Without BATCH_SIZE set, what batch size will it use after this change?' }] }, 1).some(item => item.code === 'CHANGED_LITERAL_RECALL'));
  assert.ok(qualityFindings(fixture, { questions: [{ ...fixture.canonical, prompt: 'What is the value?' }] }, 1).some(item => item.code === 'CONCEPT_COVERAGE'), 'A causal rubric does not substitute for a meaningful visible question');
});

test('transfer reference checks recognize literal HTML classes but do not invent classes from hypothetical prompts', () => {
  const question = { prompt: 'Hypothetically add <div class="alert">.', evidence: [{ path: 'index.html', reason: 'The .toolbar wrapper and .button are present, unlike .alert.' }] };
  const evidence = [{ result: { text: '<nav class="toolbar"><button class="button primary">Refresh</button></nav>' } }];
  assert.deepEqual(unknownSourceSelectors(question, evidence), ['.alert']);
});

test('a provider error that persists through retries stops the live run without probing the remaining cases', async () => {
  let requests = 0;
  const report = await runEvaluation({ cases: CASES.slice(0, 2), live: true, apiKey: 'fake', maxCalls: 20, delayMs: 0, sleep: async () => {},
    fetchImpl: async () => { requests++; return new Response(JSON.stringify({ error: { code: 429, message: 'UNTRUSTED_ERROR_CONTENT' }, usage: { cost: 0.0001 } }), { status: 429 }); },
  });
  // A 429 is transient: the transport retries it three times, each a metered request.
  assert.equal(requests, 4); assert.equal(report.usage.calls, 4);
  assert.equal(report.cases.length, 1);
  assert.equal(report.stopped, 'OPENROUTER_PROVIDER_ERROR');
  assert.equal(report.cases[0].error.code, 'OPENROUTER_PROVIDER_ERROR');
  assert.ok(Math.abs(report.usage.reportedCostUsd - 0.0004) < 1e-12, "Each metered attempt reports its cost");
  assert.equal(report.usage.responses[0].errorMessage, 'UNTRUSTED_ERROR_CONTENT', 'Synthetic eval diagnostics are bounded; product errors remain sanitized separately');
});

test('live pacing waits after the previous response without charging an additional request', async () => {
  const budget = createBudget({ maxCalls: 2, delayMs: 20 });
  await budget.beforeCall(); budget.record({ usage: { cost: 0 } }, 200);
  const at = Date.now(); await budget.beforeCall();
  assert.ok(Date.now() - at >= 15);
  assert.equal(budget.state.calls, 2);
  await assert.rejects(budget.beforeCall(), { code: 'EVAL_CALL_BUDGET' });
});

test('live evaluation requires an explicit key and a supported route before fixtures or requests', async () => {
  await assert.rejects(runEvaluation({ live: true }), /require an OpenRouter key/);
  const config = structuredClone(DEFAULT_CONFIG); config.models.small.provider = 'claude';
  await assert.rejects(runEvaluation({ live: true, apiKey: 'fake', config }), /OpenRouter routes only/);
});

test('a rejected audit retains its synthetic candidate, exact archive and audit transcript', async () => {
  const fixture = CASES[0]; let turns = 0;
  const report = await runEvaluation({ cases: [fixture], live: true, apiKey: 'fake-audit-key', maxCalls: 3, delayMs: 0, config: { ...structuredClone(DEFAULT_CONFIG), audit: 'all' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); let message, finish_reason;
      if (body.tools) {
        turns++;
        const args = turns === 1 ? { path: 'index.html' } : { assessment: { questions: [fixture.canonical] }, summary: fixture.correct, evidenceIds: ['e1', 'e2'] };
        message = { content: null, tool_calls: [{ id: `tool-${turns}`, type: 'function', function: { name: turns === 1 ? 'read_file' : 'finish_review', arguments: JSON.stringify(args) } }] }; finish_reason = 'tool_calls';
      } else { message = { content: JSON.stringify({ questions: [] }) }; finish_reason = 'stop'; }
      return new Response(JSON.stringify({ choices: [{ finish_reason, message }], usage: { cost: 0 } }));
    },
  });
  const result = report.cases[0];
  assert.equal(result.generated, null);
  assert.equal(result.trace.audits.length, 1);
  assert.deepEqual(result.trace.audits[0].result, { questions: [] });
  assert.match(result.trace.audits[0].prompt, /Assessment audit data/);
  assert.deepEqual(result.trace.lastProposedAssessment.assessment.questions, [fixture.canonical]);
  assert.ok(result.trace.checkpoint.entries.length > 0);
  assert.ok(result.trace.checkpoint.archive.some(item => item.paths.includes('index.html')));
  assert.ok(result.trace.saves.some(item => item.pendingAssessment));
});

test('diagnostic copies redact key echoes and omit opaque provider thinking', () => {
  const result = diagnosticCopy({ prompt: 'synthetic KEY text', result: { echo: 'KEY' }, entries: [{ message: { content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'KEY ordinary response' }], reasoning_details: [{ data: 'opaque' }] } }] }, 'KEY');
  const text = JSON.stringify(result);
  assert.ok(!text.includes('"KEY"')); assert.ok(!text.includes('synthetic KEY'));
  assert.ok(!text.includes('private reasoning')); assert.ok(!text.includes('opaque'));
  assert.match(text, /REDACTED_OPENROUTER_KEY/);
});

test('synthetic grade traces preserve a rejected structured grade without retaining credentials', async () => {
  const fixture = CASES.find(item => item.id === 'auth');
  const report = await runEvaluation({ cases: [fixture], live: true, apiKey: 'TEST_GRADE_TRACE_KEY', maxCalls: 4, delayMs: 0, probes: 'generated',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); let message, finish_reason = 'stop';
      if (body.tools) {
        message = { content: null, tool_calls: [{ id: 'finish', type: 'function', function: { name: 'finish_review', arguments: JSON.stringify({ assessment: { questions: [fixture.canonical] }, summary: fixture.correct }) } }] };
        finish_reason = 'tool_calls';
      } else {
        const data = JSON.parse(body.messages.at(-1).content.split('\n').at(-1));
        const result = data.proposedQuestions ? { questions: data.proposedQuestions } : { questionValid: true, verdict: 'excellent', feedback: null, evidence: fixture.canonical.evidence, followUp: null };
        message = { content: JSON.stringify(result) };
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason, message }], usage: { cost: 0 } }));
    },
  });
  assert.equal(report.cases[0].trace.grades.length, 2);
  assert.ok(report.cases[0].trace.grades.every(entry => entry.result.feedback === null));
  assert.ok(report.cases[0].grades.every(entry => entry.error.code === 'INVALID_MODEL_OUTPUT'));
  assert.ok(!JSON.stringify(report).includes('TEST_GRADE_TRACE_KEY'));
});

test('eval error telemetry keeps bounded provider diagnostics and Retry-After while redacting credentials', () => {
  const budget = createBudget({ apiKey: 'REAL_KEY_VALUE' });
  budget.record({ error: { message: `Rate limited for REAL_KEY_VALUE; Bearer another-token; api_key=other-secret; sk-or-v1-abcdefghijk. ${'x'.repeat(400)}`, metadata: { error_type: 'rate_limit_exceeded', provider_name: 'Example provider', raw: { secret: 'NEVER_RETAIN_RAW_METADATA' } } } }, 429, new Headers({ 'retry-after': '60' }));
  const entry = budget.state.responses[0];
  assert.equal(entry.errorType, 'rate_limit_exceeded'); assert.equal(entry.providerName, 'Example provider'); assert.equal(entry.retryAfter, '60');
  assert.ok(entry.errorMessage.length <= 300);
  for (const secret of ['REAL_KEY_VALUE', 'another-token', 'other-secret', 'sk-or-v1-abcdefghijk', 'NEVER_RETAIN_RAW_METADATA']) assert.ok(!JSON.stringify(entry).includes(secret));
  budget.record({}, 429, new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }));
  assert.equal(budget.state.responses[1].retryAfter, 'Wed, 21 Oct 2026 07:28:00 GMT');
  budget.record({}, 429, new Headers({ 'retry-after': 'Bearer bad-secret' }));
  assert.equal(budget.state.responses[2].retryAfter, undefined);
});
