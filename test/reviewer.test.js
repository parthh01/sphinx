import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReviewer, reviewedData, REVIEWER_SYSTEM } from '../src/reviewer.js';
import { QUESTION_SCHEMA, validateQuestion, createEvaluator } from '../src/evaluator.js';
import { DEFAULT_CONFIG, saveConfig } from '../src/config.js';
import { pushSnapshots } from '../src/git.js';
import { createReviewWorkspace } from '../src/review-workspace.js';
import { reviewerTurnLimit } from '../src/reviewer-limits.js';

const exec = promisify(execFile);
const snapshot = { version: 2, id: 'snapshot', files: ['worker.js'], projectContext: { path: '.sphinxcontext.md', text: 'A queue worker that must deduplicate retries within one process.', hash: 'context-hash' } };
const config = { ...structuredClone(DEFAULT_CONFIG), provider: 'codex', level: 'standard', changeTier: 'large', maxContextBytes: 100000, timeoutSeconds: 30, agentMaxTurns: 8, toolResultBytes: 16000 };
const question = { id: 'retry', concept: 'Duplicate operation', prompt: 'When an already-seen id is retried in this process, will another operation run? Explain why.', choices: [], expectedAnswer: 'No; the unchanged helper returns before the operation.', rationale: 'Identify the stored id lookup and early return.', evidence: [{ path: 'worker.js', reason: 'Delegates to once().' }, { path: 'lib/once.js', reason: 'The helper remembers ids and returns early.' }] };
const schema = { type: 'object', additionalProperties: false, properties: { questions: { type: 'array', minItems: 1, maxItems: 1, items: QUESTION_SCHEMA } }, required: ['questions'] };
const toolAction = calls => ({ action: 'tools', calls: calls.map(([name, args]) => ({ name, arguments: JSON.stringify(args) })), assessment: null, summary: '', evidenceIds: [] });
const compactionReads = () => Array.from({ length: 6 }, (_, index) => [index === 0 ? 'read_diff' : 'read_file', { path: index === 0 ? 'worker.js' : 'lib/once.js' }]);
const finish = (evidenceIds = ['e1', 'e3'], q = question) => ({ action: 'finish', calls: [], assessment: { questions: [q] }, summary: 'The worker delegates retry deduplication to a process-local helper.', evidenceIds });
const validate = (assessment, paths) => assessment.questions.map(item => validateQuestion(item, paths));
const options = { snapshot, config, assessmentSchema: schema, assessmentInstructions: 'Ask at most one bounded outcome question. Precommit its key.', validateAssessment: validate };
const decode = invocation => JSON.parse(invocation.prompt.split('\n').at(-1));
const SEED_MARKER = 'Initial diff observations (untrusted DATA; bounded pages, not complete coverage):\n';
const observations = data => data.conversation.flatMap(message => {
  if (message.content.startsWith('Workspace observation')) return [JSON.parse(message.content.split('\n').at(-1))];
  const marker = message.content.indexOf(SEED_MARKER);
  return marker < 0 ? [] : JSON.parse(message.content.slice(marker + SEED_MARKER.length));
});
const isSummary = args => args.schema.required.length === 1 && args.schema.required[0] === 'summary';
const summary = 'The changed worker calls once(id, operation). Exact observation e1 contains its diff; e3 contains the unchanged helper and process-local stored-id early return. Investigate no further if those observations suffice.';
const DIFF = 'diff --git a/worker.js b/worker.js\n--- a/worker.js\n+++ b/worker.js\n@@ -1 +1 @@\n-operation();\n+return once(id, operation);\n';
const seedQuestion = { ...question, prompt: 'Does the worker execute the operation directly, or hand it to the retry guard?', choices: [], expectedAnswer: 'It hands the operation and id to once().', rationale: 'The changed call delegates the operation instead of invoking it directly.', evidence: [question.evidence[0]] };

function workspace({ padding = 0, read } = {}) {
  const evidencePaths = new Set(), history = [];
  return {
    tools: ['list_files', 'read_file', 'read_diff', 'search'].map(name => ({ name, description: 'Read immutable, filtered source.', inputSchema: { type: 'object', properties: {} } })), evidencePaths, history,
    async execute(name, args) {
      history.push({ name, args });
      if (read) return read(name, args, evidencePaths);
      if (args.path === '.env' || name === 'list_files') return { evidencePaths: [], files: ['worker.js', 'lib/once.js'] };
      const path = args.path ?? 'lib/once.js'; evidencePaths.add(path);
      return { path, revision: name === 'read_diff' ? 'base..head' : 'head', oid: 'a'.repeat(40), ...(name === 'read_diff' ? { baseOid: 'b'.repeat(40), headOid: 'a'.repeat(40), baseMode: '100644', headMode: '100644' } : {}), text: name === 'read_diff' ? DIFF : `if (seen.has(id)) return; seen.add(id); operation();\n${'x'.repeat(padding)}`, startLine: 1, endLine: 2, offset: 0, nextOffset: null, truncated: false, evidencePaths: [path] };
    },
  };
}

test('the first native or structured request can finish from exact seeded evidence without a planning call', async () => {
  for (const nativeTools of [false, true]) {
    const space = workspace(); let requests = 0, charges = 0;
    const provider = async args => {
      assert.equal(charges, 0, 'Local seeding must not spend the model allowance');
      assert.equal(space.history.length, 1);
      const seen = nativeTools ? observations({ conversation: args.messages.filter(message => typeof message.content === 'string') }) : observations(decode(args));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].id, 'e1'); assert.equal(seen[0].result.text, DIFF);
      // Only a CLI turn, whose model has no workspace tools, is told to request reads in its structured action.
      const system = nativeTools ? args.messages[0].content : args.systemPrompt;
      assert.ok(system.startsWith(REVIEWER_SYSTEM));
      if (nativeTools) assert.doesNotMatch(system, /no callable workspace tools/);
      else {
        assert.match(system, /no callable workspace tools/);
        assert.doesNotMatch(system.slice(REVIEWER_SYSTEM.length), /read_evidence/, 'read_evidence is offered only after a resume or compaction');
      }
      await args.beforeCall(); requests++;
      const action = finish(['e1'], seedQuestion);
      return nativeTools ? { calls: [{ id: 'finish', name: 'finish_review', arguments: { assessment: action.assessment, summary: action.summary, evidenceIds: action.evidenceIds } }] } : action;
    };
    const result = await runReviewer({ ...options, workspace: space, nativeTools, beforeCall: async () => { charges++; }, runModel: provider, runToolModel: provider });
    assert.equal(requests, 1); assert.equal(charges, 1); assert.equal(result.review.calls, 1);
    assert.equal(result.review.toolCalls, 1);
    assert.deepEqual(result.review.evidence.map(item => item.id), ['e1']);
    assert.deepEqual(result.questions, [seedQuestion]);
  }
});

test('seeding visits first pages before continuing a split diff header, without charging for pagination', async () => {
  const first = 'diff --git a/worker.js b/worker.js\n---';
  const remainder = ' a/worker.js\n+++ b/worker.js\n@@ -1 +1 @@\n--- old source;\n+++ new source;\n';
  const space = workspace({ read: (_name, args, evidencePaths) => {
    evidencePaths.add(args.path);
    const text = args.path === 'other.js' ? 'diff --git a/other.js b/other.js\n' : args.offset ? remainder : first;
    return { path: args.path, baseOid: 'b'.repeat(40), headOid: 'a'.repeat(40), text,
      offset: args.offset ?? 0, nextOffset: args.path === 'worker.js' && !args.offset ? Buffer.byteLength(first) : null,
      partialLine: args.path === 'worker.js' && !args.offset, truncated: args.path === 'worker.js' && !args.offset, evidencePaths: [args.path] };
  } }); let requests = 0, charges = 0;
  const result = await runReviewer({ ...options, snapshot: { ...snapshot, files: ['worker.js', 'other.js'] }, workspace: space,
    beforeCall: async () => { charges++; }, runModel: async args => {
      assert.equal(charges, 0);
      assert.deepEqual(space.history.map(item => [item.args.path, item.args.offset ?? 0]), [['worker.js', 0], ['other.js', 0], ['worker.js', Buffer.byteLength(first)]]);
      assert.deepEqual(observations(decode(args)).map(item => item.id), ['e1', 'e2', 'e3']);
      await args.beforeCall(); requests++;
      return finish(['e1', 'e3'], seedQuestion);
    },
  });
  assert.equal(requests, 1); assert.equal(charges, 1);
  assert.equal(result.review.evidence[1].result.text, remainder, 'Source starting -- or ++ remains real changed evidence after the hunk header');
});

test('partial file headers cannot masquerade as changed source or spend any model allowance', async () => {
  for (const ending of ['---', '+++']) {
    const first = `diff --git a/worker.js b/worker.js\n${ending}`;
    const space = workspace({ read: (_name, args, evidencePaths) => {
      evidencePaths.add(args.path);
      return { path: args.path, baseOid: 'b'.repeat(40), headOid: 'a'.repeat(40), text: args.offset ? ' b/worker.js\n' : first,
        offset: args.offset ?? 0, nextOffset: args.offset ? null : Buffer.byteLength(first), partialLine: !args.offset, truncated: !args.offset, evidencePaths: [args.path] };
    } }); let requests = 0, charges = 0;
    await assert.rejects(runReviewer({ ...options, workspace: space, beforeCall: async () => { charges++; }, runModel: async args => {
      await args.beforeCall(); requests++; return finish(['e1'], seedQuestion);
    } }), { code: 'INSUFFICIENT_EVIDENCE' });
    assert.equal(requests, 0); assert.equal(charges, 0); assert.equal(space.history.length, 2);
  }
});

test('pagination does not treat a plus sign inside an unchanged context line as changed source', async () => {
  const pages = ['diff --git a/worker.js b/worker.js\n--- a/worker.js\n+++ b/worker.js\n@@ -1,2 +1,2 @@\n context ', '+ still the same context\n', '-operation();\n+return once(id, operation);\n'];
  const offsets = pages.map((_page, index) => Buffer.byteLength(pages.slice(0, index).join('')));
  const space = workspace({ read: (_name, args, evidencePaths) => {
    evidencePaths.add(args.path);
    const index = offsets.indexOf(args.offset ?? 0);
    assert.ok(index >= 0);
    return { path: args.path, baseOid: 'b'.repeat(40), headOid: 'a'.repeat(40), text: pages[index], offset: offsets[index],
      nextOffset: offsets[index + 1] ?? null, partialLine: index === 0, truncated: index < pages.length - 1, evidencePaths: [args.path] };
  } });
  const result = await runReviewer({ ...options, workspace: space, runModel: async args => {
    assert.equal(space.history.length, 3, 'Both header/context pages must be followed before a changed source line is available');
    await args.beforeCall(); return finish(['e1', 'e3'], seedQuestion);
  } });
  assert.equal(result.review.calls, 1);
  assert.equal(result.review.evidence[1].result.text, pages[2]);
});

test('seeding is bounded to eight local reads and never opens omitted or binary paths', async () => {
  const files = ['private.js', 'image.bin', ...Array.from({ length: 12 }, (_, index) => `source-${index}.js`)];
  const space = workspace({ read: (_name, args, evidencePaths) => {
    evidencePaths.add(args.path);
    return { path: args.path, baseOid: 'b'.repeat(40), headOid: 'a'.repeat(40), text: `diff --git a/${args.path} b/${args.path}\n`, offset: 0, truncated: false, nextOffset: null, evidencePaths: [args.path] };
  } }); let requests = 0;
  await assert.rejects(runReviewer({ ...options, snapshot: { ...snapshot, files, omitted: ['private.js'], binaryFiles: ['image.bin'] }, workspace: space,
    runModel: async () => { requests++; assert.fail('Header-only evidence must not reach a model'); },
  }), { code: 'INSUFFICIENT_EVIDENCE' });
  assert.equal(requests, 0);
  assert.deepEqual(space.history.map(item => item.args.path), files.slice(2, 10));
});

test('initial task and seeded evidence must fit before the first provider request is charged', async () => {
  const space = workspace(); let requests = 0, charges = 0;
  await assert.rejects(runReviewer({ ...options, config: { ...config, maxContextBytes: 30000 },
    snapshot: { ...snapshot, projectContext: { ...snapshot.projectContext, text: 'Project purpose. '.repeat(1500) } }, workspace: space,
    beforeCall: async () => { charges++; }, runModel: async () => { requests++; assert.fail('An oversized initial request must not reach a provider'); },
  }), { code: 'CONTEXT_LIMIT' });
  assert.equal(requests, 0); assert.equal(charges, 0); assert.equal(space.history.length, 1);
});

test('investigative reviewer follows unchanged dependencies and saves exact evidence for grading', async () => {
  const space = workspace(), requests = [];
  let charges = 0;
  const result = await runReviewer({ ...options, workspace: space, beforeCall: async () => { charges++; }, runModel: async args => {
    await args.beforeCall(); requests.push(args); const data = decode(args), seen = observations(data);
    assert.deepEqual(data.projectContext, snapshot.projectContext);
    assert.ok(seen.length, 'The first model request already contains an immutable changed diff');
    if (seen.length === 1) { assert.match(seen[0].result.text, /once/); return toolAction([['search', { query: 'once', prefix: 'lib/' }]]); }
    if (seen.length === 2) return toolAction([['read_file', { path: seen[1].result.path, revision: 'head', startLine: 1, limit: 20 }]]);
    return finish(['e1', 'e3']);
  } });
  assert.equal(charges, 3); assert.equal(result.review.calls, 3);
  assert.deepEqual(space.history.map(item => item.name), ['read_diff', 'search', 'read_file']);
  assert.ok(!snapshot.files.includes('lib/once.js'));
  assert.deepEqual(result.review.evidencePaths, ['worker.js', 'lib/once.js']);
  assert.match(result.review.evidence[1].result.text, /seen\.has/);
  assert.equal(result.review.evidence[1].result.oid, 'a'.repeat(40));
  assert.deepEqual(result.review.projectContext, snapshot.projectContext);
  const data = reviewedData(snapshot, result.review, question, config);
  assert.deepEqual(data.allowedEvidencePaths, ['worker.js', 'lib/once.js']);
  assert.equal(data.evidence.length, 2);
  assert.ok(requests.every(request => !request.prompt.includes('/private/checkout')));
});

test('a structured tool action runs its reads whatever summary or evidenceIds it carries, but cannot also finish', async () => {
  // Haiku has written the summary as the two characters "" instead of an empty string.
  for (const [extra, reads] of [[{ summary: '""' }, true], [{ summary: 'Reading the helper.', evidenceIds: ['e1'] }, true], [{ assessment: { questions: [question] } }, false]]) {
    const space = workspace(); let requests = 0;
    const result = await runReviewer({ ...options, workspace: space, runModel: async args => {
      await args.beforeCall(); requests++;
      if (requests === 1) return { ...toolAction([['read_file', { path: 'lib/once.js' }]]), ...extra };
      assert.equal(args.prompt.includes('A tool action cannot also finish'), !reads, JSON.stringify(extra));
      return reads ? finish(['e1', 'e2']) : finish(['e1'], seedQuestion);
    } });
    assert.deepEqual(space.history.map(item => item.name), reads ? ['read_diff', 'read_file'] : ['read_diff'], JSON.stringify(extra));
    assert.equal(requests, 2); assert.deepEqual(result.questions, [reads ? question : seedQuestion]);
  }
});

test('Pi sequentially executes bounded 3–8 read batches for native and structured transports', async () => {
  for (const nativeTools of [false, true]) for (const count of [3, 8]) {
    const space = workspace();
    const execute = space.execute.bind(space);
    let active = 0, maximum = 0, requests = 0, charges = 0;
    space.execute = async (...args) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setImmediate(resolve));
      try { return await execute(...args); } finally { active--; }
    };
    const readCalls = Array.from({ length: count }, (_, index) => ({ id: `read-${index}`, name: index === 0 ? 'read_diff' : 'read_file', arguments: index === 0 ? { path: 'worker.js' } : { path: 'lib/once.js', startLine: index } }));
    const provider = async args => {
      await args.beforeCall(); requests++;
      assert.ok(requests <= 2);
      const done = requests === 2;
      if (nativeTools) return { calls: done ? [{ id: 'finish', name: 'finish_review', arguments: { assessment: { questions: [question] }, summary, evidenceIds: ['e1', `e${count + 1}`] } }] : readCalls };
      assert.equal(args.schema.properties.calls.maxItems, 8);
      return done ? finish(['e1', `e${count + 1}`]) : toolAction(readCalls.map(call => [call.name, call.arguments]));
    };
    const result = await runReviewer({ ...options, workspace: space, nativeTools, beforeCall: async () => { charges++; }, runModel: provider, runToolModel: provider });
    assert.equal(maximum, 1);
    assert.equal(space.history.length, count + 1);
    assert.equal(result.review.toolCalls, count + 1);
    assert.equal(result.review.calls, 2);
    assert.equal(charges, 2);
    assert.deepEqual(result.review.evidence.map(item => item.id), ['e1', `e${count + 1}`]);
  }
});

test('invalid native batches execute no workspace tools and Pi corrects them within the existing allowance', async () => {
  const read = { id: 'read', name: 'read_diff', arguments: { path: 'worker.js' } };
  const done = { id: 'finish', name: 'finish_review', arguments: { assessment: { questions: [seedQuestion] }, summary } };
  for (const calls of [[], Array.from({ length: 9 }, (_, index) => ({ ...read, id: `read-${index}` })), [read, done]]) {
    const space = workspace(); let requests = 0;
    const result = await runReviewer({ ...options, workspace: space, nativeTools: true, runToolModel: async args => {
      await args.beforeCall(); requests++;
      if (requests === 1) return { calls };
      assert.match(JSON.stringify(args.messages), /review_feedback/);
      return { calls: [done] };
    }, runModel: async () => assert.fail('This short correction needs no compaction') });
    assert.equal(space.history.length, 1, 'Only the automatic seed ran; no tool from the invalid response executed');
    assert.equal(requests, 2); assert.equal(result.review.calls, 2);
  }
});

test('read pages honor both the configured ceiling and context room reserved for bounded batches', async () => {
  for (const limits of [{ maxContextBytes: 32000, toolResultBytes: 16000 }, { maxContextBytes: 100000, toolResultBytes: 1000 }]) {
    const result = { evidencePaths: [], text: 'x'.repeat(1000) };
    const space = workspace({ read: () => result });
    let requests = 0;
    await assert.rejects(runReviewer({ ...options, config: { ...config, ...limits }, workspace: space, runModel: async args => {
      await args.beforeCall(); requests++;
      return toolAction(compactionReads());
    } }), { code: 'TOOL_RESULT_LIMIT' });
    assert.equal(requests, 0, 'An oversized seed observation fails before any provider request');
    assert.equal(space.history.length, 1, 'Seeding stops when its page budget is exceeded');
  }
});

test('Pi native compaction preserves the exact evidence archive, project context and charged remaining budget', async () => {
  const space = workspace({ padding: 600 });
  const limit = 8;
  let turns = 0, charges = 0, summaryCalls = 0;
  const result = await runReviewer({ ...options, config: { ...config, maxContextBytes: 30000, timeoutSeconds: 5 }, maxReviewerCalls: limit, workspace: space, beforeCall: async () => { charges++; }, runModel: async args => {
    await args.beforeCall();
    assert.deepEqual(decode(args).projectContext, snapshot.projectContext);
    if (isSummary(args)) {
      summaryCalls++;
      assert.deepEqual(args.schema.required, ['summary']);
      assert.match(args.systemPrompt, /context summarization assistant/);
      assert.doesNotMatch(args.systemPrompt, /no callable workspace tools/);
      assert.match(args.prompt, /\[Assistant tool calls\]|\[Tool result\]/);
      assert.match(args.prompt, /Workspace observation/);
      assert.ok(charges < limit, 'Compaction must leave a request to finish');
      return { summary };
    }
    turns++;
    const data = decode(args);
    assert.equal(data.remainingCalls, limit - charges + 1);
    assert.equal(/read_evidence/.test(args.systemPrompt.slice(REVIEWER_SYSTEM.length)), summaryCalls > 0, 'The CLI note names read_evidence once compaction offers it');
    if (summaryCalls) {
      assert.match(JSON.stringify(data.conversation), /Exact observation e1/);
      return finish(['e1', 'e3']);
    }
    return toolAction(compactionReads());
  } });
  assert.ok(summaryCalls >= 1, 'The real Pi session must issue native summarization calls');
  assert.ok(turns >= 3, 'Accumulate several bounded investigation turns before compacting');
  assert.equal(result.review.compactions, 1);
  assert.equal(result.review.harness, 'pi');
  assert.equal(result.review.calls, charges);
  assert.equal(charges, turns + summaryCalls);
  assert.deepEqual(result.review.evidence.map(item => item.id), ['e1', 'e3']);
  assert.equal(result.review.evidence[0].result.text, DIFF);
  assert.equal(result.review.evidence[1].result.text, `if (seen.has(id)) return; seen.add(id); operation();\n${'x'.repeat(600)}`);
  assert.equal(result.review.evidence[1].result.oid, 'a'.repeat(40));
  assert.deepEqual(result.review.projectContext, snapshot.projectContext);
  assert.ok(Buffer.byteLength(JSON.stringify(result.review)) < 30000);
});

test('Pi retains opaque reasoning for native continuation but excludes it from native summaries', async () => {
  let turns = 0, compactCalls = 0, charges = 0, continuedWithReasoning = false;
  const encrypted = 'opaque-private-reasoning-' + 'A'.repeat(800);
  const result = await runReviewer({ ...options, config: { ...config, maxContextBytes: 40000, timeoutSeconds: 5 }, workspace: workspace({ padding: 900 }), nativeTools: true,
    beforeCall: async () => { charges++; },
    runToolModel: async args => {
      await args.beforeCall();
      turns++;
      assert.match(args.messages.at(-1).content, /A queue worker that must deduplicate retries within one process/);
      if (compactCalls) return { calls: [{ id: 'finish', name: 'finish_review', arguments: { assessment: { questions: [question] }, summary: 'The helper makes duplicate operations return early.', evidenceIds: ['e1', 'e3'] } }] };
      if (turns > 1) {
        const original = args.messages.find(message => message.reasoning_details);
        assert.equal(original.reasoning_details[0].data, encrypted);
        continuedWithReasoning = true;
      }
      const calls = compactionReads().map(([name, args], index) => ({ id: `read-${turns}-${index}`, name, arguments: args }));
      return { calls, message: { role: 'assistant', content: null, tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })), reasoning_details: [{ type: 'reasoning.encrypted', data: encrypted }] } };
    },
    runModel: async args => {
      await args.beforeCall(); compactCalls++;
      assert.ok(isSummary(args));
      assert.match(args.systemPrompt, /context summarization assistant/);
      assert.ok(!args.prompt.includes(encrypted));
      assert.doesNotMatch(args.prompt, /opaque-private-reasoning|reasoning_details/);
      assert.deepEqual(decode(args).projectContext, snapshot.projectContext);
      assert.match(args.prompt, /Workspace observation/);
      return { summary };
    },
  });
  assert.ok(compactCalls >= 1);
  assert.equal(continuedWithReasoning, true);
  assert.equal(result.review.compactions, 1);
  assert.equal(result.review.calls, turns + compactCalls);
  assert.equal(result.review.calls, charges);
  assert.equal(result.review.evidence[0].result.text, DIFF);
  assert.equal(result.review.evidence[1].result.oid, 'a'.repeat(40));
  assert.doesNotMatch(JSON.stringify(result.review), /opaque-private-reasoning|reasoning_details/);
});

test('an oversized opaque continuation fails closed when Pi has no earlier turn it can compact', async () => {
  let calls = 0, charges = 0;
  await assert.rejects(runReviewer({ ...options, config: { ...config, maxContextBytes: 30000 }, workspace: workspace(), nativeTools: true,
    beforeCall: async () => { charges++; },
    runToolModel: async args => {
      await args.beforeCall(); calls++;
      assert.equal(calls, 1, 'An oversized second request must not reach the provider');
      const toolCalls = [{ id: 'diff', name: 'read_diff', arguments: { path: 'worker.js' } }];
      return { calls: toolCalls, message: { role: 'assistant', content: null,
        tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
        reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-' + 'A'.repeat(28000) }],
      } };
    },
    runModel: async () => assert.fail('There is no earlier completed turn for Pi to summarize'),
  }), { code: 'CONTEXT_LIMIT' });
  assert.equal(calls, 1); assert.equal(charges, 1);
});

test('unread or unchanged-only citations remain unapproved after bounded correction attempts', async () => {
  for (const [first, candidate] of [
    [toolAction([['list_files', {}]]), question],
    [toolAction([['read_diff', { path: 'worker.js' }]]), { ...question, evidence: [...question.evidence, { path: 'invented.js', reason: 'Never observed.' }] }],
    [toolAction([['read_file', { path: 'lib/once.js' }]]), { ...question, evidence: [question.evidence[1]] }],
    [toolAction([['read_diff', { path: '.env' }]]), { ...question, evidence: [{ path: '.env', reason: 'Excluded.' }] }],
  ]) {
    let turn = 0;
    await assert.rejects(runReviewer({ ...options, maxReviewerCalls: 3, workspace: workspace(), runModel: async args => { await args.beforeCall(); return turn++ ? finish([], candidate) : first; } }), { code: 'REVIEWER_BUDGET' });
    assert.equal(turn, 3, 'Corrections never raise the configured request allowance');
  }
});

test('provider calls including compaction obey the shared budget with no retry or escalation', async () => {
  let charges = 0, requests = 0;
  await assert.rejects(runReviewer({ ...options, maxReviewerCalls: 1, workspace: workspace(), runModel: async () => { requests++; } }), { code: 'REVIEWER_BUDGET' });
  assert.equal(requests, 0);
  await assert.rejects(runReviewer({ ...options, maxReviewerCalls: 2, workspace: workspace(), beforeCall: async () => { charges++; }, runModel: async args => { await args.beforeCall(); requests++; return toolAction([['read_diff', { path: 'worker.js' }]]); } }), { code: 'REVIEWER_BUDGET' });
  assert.equal(charges, 2); assert.equal(requests, 2);
  requests = 0;
  await assert.rejects(runReviewer({ ...options, workspace: workspace(), beforeCall: async () => { throw new Error('shared budget exhausted'); }, runModel: async args => { await args.beforeCall(); requests++; } }), /shared budget exhausted/);
  assert.equal(requests, 0);
});

test('small and medium reviews reserve synthesis within their size caps for both transports', async () => {
  assert.equal(reviewerTurnLimit('small', 8), 3);
  assert.equal(reviewerTurnLimit('medium', 8), 5);
  assert.equal(reviewerTurnLimit('large', 8), 8);
  assert.equal(reviewerTurnLimit('small', 2), 2, 'Size caps cannot raise configured limits');
  for (const nativeTools of [false, true]) for (const [tier, limit] of [['small', 3], ['medium', 5], ['large', 8]]) {
    const space = workspace();
    let requests = 0, charges = 0;
    const provider = async args => {
      await args.beforeCall(); requests++;
      const final = requests === limit;
      if (nativeTools) {
        const definitions = args.tools.map(tool => tool.function.name);
        assert.deepEqual(definitions, ['list_files', 'read_file', 'read_diff', 'search', 'review_feedback', 'finish_review']);
        assert.deepEqual(args.toolChoice, final ? { type: 'function', function: { name: 'finish_review' } } : undefined);
        const historicalCalls = args.messages.flatMap(message => message.tool_calls ?? []);
        for (const call of historicalCalls) assert.ok(definitions.includes(call.function.name), 'Historical calls retain their tool definitions');
        if (final) {
          assert.ok(historicalCalls.some(call => call.function.name === 'read_diff'));
          assert.match(args.messages.at(-1).content, /Final synthesis: investigation is closed/);
          assert.match(args.messages.at(-1).content, /Submit finish_review now/, 'A native model finishes by calling the finish_review tool');
          return { calls: [{ id: 'finish', name: 'finish_review', arguments: { assessment: { questions: [question] }, summary, evidenceIds: ['e1', 'e3'] } }] };
        }
        return { calls: [
          { id: `diff-${requests}`, name: 'read_diff', arguments: { path: 'worker.js', offset: requests } },
          { id: `helper-${requests}`, name: 'read_file', arguments: { path: 'lib/once.js', startLine: requests } },
        ] };
      }
      const data = decode(args);
      assert.equal(data.remainingCalls, limit - requests + 1);
      assert.deepEqual(args.schema.properties.action.enum, final ? ['finish'] : ['tools', 'finish']);
      assert.equal(args.schema.properties.calls.maxItems, final ? 0 : 8);
      if (final) {
        assert.deepEqual(data.tools, []);
        assert.deepEqual(args.schema.properties.assessment, schema);
        assert.match(args.prompt, /Final synthesis: investigation is closed/);
        assert.doesNotMatch(args.prompt, /finish_review/, 'A CLI model has no finish_review tool to call');
        return finish();
      }
      assert.match(args.prompt, /Sphinx returns their observations in your next request/, 'A CLI model is told its reads come back in the next request');
      return toolAction([['read_diff', { path: 'worker.js', offset: requests }], ['read_file', { path: 'lib/once.js', startLine: requests }]]);
    };
    const result = await runReviewer({ ...options, config: { ...config, changeTier: tier }, workspace: space, nativeTools,
      beforeCall: async () => { charges++; }, runModel: provider, runToolModel: provider });
    assert.equal(requests, limit); assert.equal(charges, limit); assert.equal(result.review.calls, limit);
    assert.equal(space.history.length, 1 + (limit - 1) * 2, 'One seed precedes investigation; final synthesis executes no more repository reads');
    assert.deepEqual(result.questions, [question]);
  }
});

test('a noncompliant native final turn cannot execute another read or spend a repair call', async () => {
  const space = workspace(); let requests = 0, charges = 0;
  await assert.rejects(runReviewer({ ...options, maxReviewerCalls: 2, workspace: space, nativeTools: true,
    beforeCall: async () => { charges++; },
    runToolModel: async args => {
      await args.beforeCall(); requests++;
      if (requests === 2) {
        assert.deepEqual(args.toolChoice, { type: 'function', function: { name: 'finish_review' } });
        assert.ok(args.tools.some(tool => tool.function.name === 'read_diff'), 'A schema retained for history does not authorize another read');
      }
      return { calls: [{ id: `read-${requests}`, name: 'read_diff', arguments: { path: 'worker.js' } }] };
    }, runModel: async () => assert.fail('No compaction or repair request is allowed'),
  }), { code: 'REVIEWER_BUDGET' });
  assert.equal(requests, 2); assert.equal(charges, 2); assert.equal(space.history.length, 2);
});

test('header-only seed observations fail before spending any model allowance', async () => {
  const space = workspace({ read: (_name, args, evidencePaths) => {
    evidencePaths.add(args.path);
    return { path: args.path, revision: 'base..head', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40), baseMode: '100644', headMode: '100644', text: 'diff --git a/worker.js b/worker.js\n--- a/worker.js\n+++ b/worker.js\n', offset: 0, nextOffset: null, truncated: false, evidencePaths: [args.path] };
  } }); let requests = 0;
  await assert.rejects(runReviewer({ ...options, maxReviewerCalls: 2, workspace: space,
    runModel: async args => { await args.beforeCall(); requests++; return toolAction([['list_files', {}]]); },
  }), { code: 'INSUFFICIENT_EVIDENCE' });
  assert.equal(requests, 0); assert.equal(space.history.length, 1);
});

test('Pi cannot spend the reserved synthesis request on automatic compaction', async () => {
  let charges = 0, summaries = 0, turns = 0;
  const result = await runReviewer({ ...options, config: { ...config, maxContextBytes: 30000, timeoutSeconds: 5 },
    maxReviewerCalls: 3, workspace: workspace({ padding: 600 }),
    beforeCall: async () => { charges++; }, runModel: async args => {
      await args.beforeCall();
      if (isSummary(args)) { summaries++; return { summary }; }
      turns++;
      if (decode(args).remainingCalls === 1) {
        assert.deepEqual(args.schema.properties.action.enum, ['finish']);
        return finish();
      }
      return toolAction(compactionReads());
    },
  });
  assert.equal(charges, 3); assert.equal(turns, 3); assert.equal(summaries, 0);
  assert.equal(result.review.calls, 3); assert.equal(result.review.compactions, 0);
});

test('Pi compaction must pass the shared beforeCall budget before any summary is requested', async () => {
  let summaryAttempt = false, summaries = 0, normalCalls = 0, charges = 0;
  await assert.rejects(runReviewer({ ...options, config: { ...config, maxContextBytes: 30000, timeoutSeconds: 5 }, workspace: workspace({ padding: 600 }),
    beforeCall: async () => {
      if (summaryAttempt) throw Object.assign(new Error('Shared budget exhausted before compaction'), { code: 'TEST_SHARED_BUDGET' });
      charges++;
    },
    runModel: async args => {
      summaryAttempt = isSummary(args);
      await args.beforeCall();
      if (summaryAttempt) { summaries++; return { summary }; }
      normalCalls++;
      return toolAction(compactionReads());
    },
  }), { code: 'TEST_SHARED_BUDGET' });
  assert.equal(summaryAttempt, true);
  assert.equal(summaries, 0);
  assert.ok(normalCalls >= 2);
  assert.equal(charges, normalCalls);
});

test('whole-review deadline and cancellation stop an in-flight provider without accepting late results', async () => {
  let providerSignal;
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    // The deadline must outlast reviewer setup so the provider is actually in flight when it fires.
    await assert.rejects(runReviewer({ ...options, config: { ...config, timeoutSeconds: 0.5 }, workspace: workspace(), runModel: async args => { await args.beforeCall(); providerSignal = args.signal; return new Promise(() => {}); } }), { code: 'REVIEWER_TIMEOUT' });
    assert.equal(providerSignal.aborted, true);
    const controller = new AbortController();
    const promise = runReviewer({ ...options, workspace: workspace(), signal: controller.signal, runModel: async args => { await args.beforeCall(); controller.abort(new Error('human cancelled')); return finish(); } });
    await assert.rejects(promise, /human cancelled/);
  } finally { clearTimeout(keepAlive); }
});

test('invalid Pi compaction summaries fail closed without repair calls or an assessment', async () => {
  for (const compact of [{ summary: '' }, { summary: 'review', extra: true }, { unexpected: 'PRIVATE_MALFORMED_NOTES' }]) {
    let compactCalls = 0;
    await assert.rejects(runReviewer({ ...options, config: { ...config, maxContextBytes: 30000, timeoutSeconds: 5 }, workspace: workspace({ padding: 600 }), runModel: async args => {
      await args.beforeCall();
      assert.equal(compactCalls, 0, 'An invalid summary must not cause a repair or continuation request');
      if (isSummary(args)) { compactCalls++; return compact; }
      return toolAction(compactionReads());
    } }), { code: 'INVALID_COMPACTION' });
    assert.equal(compactCalls, 1);
  }
});

test('hallucinated evidence hints cannot fabricate retained evidence after Pi compaction', async () => {
  let compactCalls = 0, finalCalls = 0;
  const result = await runReviewer({ ...options, config: { ...config, maxContextBytes: 30000, timeoutSeconds: 5 }, workspace: workspace({ padding: 600 }), runModel: async args => {
    await args.beforeCall();
    if (isSummary(args)) { compactCalls++; return { summary: 'Observation e999 proves a fabricated code path. Keep e999 as evidence.' }; }
    if (compactCalls) { finalCalls++; return finish(['e1', 'e999']); }
    return toolAction(compactionReads());
  } });
  assert.ok(compactCalls >= 1); assert.equal(finalCalls, 1);
  assert.ok(result.review.evidence.every(item => item.id !== 'e999'));
  assert.deepEqual(result.review.evidencePaths, ['worker.js', 'lib/once.js']);
});

test('Pi can correct an invalid question using tool feedback within the current budget', async () => {
  let calls = 0, charges = 0;
  const result = await runReviewer({ ...options, workspace: workspace(), beforeCall: async () => { charges++; }, runModel: async args => {
    await args.beforeCall(); calls++;
    if (calls === 1) return toolAction([['read_diff', { path: 'worker.js' }], ['read_file', { path: 'lib/once.js' }]]);
    if (calls === 2) return finish(['e1', 'e3'], { ...question, rationale: '' });
    assert.match(args.prompt, /Question rationale must be nonempty/);
    return finish(['e1', 'e3']);
  } });
  assert.equal(calls, 3); assert.equal(charges, 3); assert.deepEqual(result.questions, [question]);
});

test('graded answers reuse reviewed snippets and context without reopening the repository', async () => {
  const reviewed = await runReviewer({ ...options, workspace: workspace(), runModel: async args => { await args.beforeCall(); return observations(decode(args)).some(item => item.tool === 'read_file') ? finish(['e1', 'e2']) : toolAction([['read_file', { path: 'lib/once.js' }]]); } });
  let calls = 0;
  const evaluator = createEvaluator({ env: {}, workspaceFactory: () => { throw new Error('Must not reopen repository'); },
    openRouterTurn: async () => { throw new Error('Grading must not invoke reviewer transport'); }, openRouter: async args => {
    await args.beforeCall();
    const data = JSON.parse(args.prompt.split('\n').at(-1));
    assert.equal(data.sourceKey.expectedAnswer, question.expectedAnswer);
    assert.equal(data.question.expectedAnswer, undefined);
    assert.deepEqual(data.snapshot.projectContext, snapshot.projectContext);
    assert.equal(data.snapshot.evidence[1].result.oid, 'a'.repeat(40));
    assert.equal(data.humanAnswer, 'No, the helper returns early for the stored id.');
    return { questionValid: true, verdict: 'correct', feedback: 'The stored id prevents the second operation.', evidence: question.evidence, followUp: null };
  } });
  const result = await evaluator.gradeAnswer({ snapshot, review: reviewed.review, question, answer: 'No, the helper returns early for the stored id.', config: { ...config, provider: 'openrouter' }, beforeCall: async () => { calls++; } });
  assert.equal(result.verdict, 'correct'); assert.equal(calls, 1);
  await assert.rejects(evaluator.gradeAnswer({ snapshot: { ...snapshot, id: 'different' }, review: reviewed.review, question, answer: 'No.', config }), { code: 'INVALID_REVIEW' });
});

test('real immutable workspace follows unchanged callers while ignored and working-tree content stay unread', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sphinx-review-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo'), home = join(directory, 'home');
  await mkdir(repo); await mkdir(home);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SPHINX_HOME: home, SPHINX_USER_HOME: home };
  const git = async (...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Sphinx test'); await git('config', 'user.email', 'sphinx@example.invalid');
  await mkdir(join(repo, 'lib'));
  await writeFile(join(repo, 'worker.js'), 'export const run = operation => operation();\n');
  await writeFile(join(repo, 'lib/once.js'), 'const seen = new Set();\nexport function once(id, operation) { if (seen.has(id)) return; seen.add(id); operation(); }\n');
  await writeFile(join(repo, '.env'), 'DO_NOT_SEND_PRIVATE_KEY=secret-marker\n');
  await git('add', '.'); await git('commit', '-m', 'initial'); const base = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'worker.js'), 'import { once } from "./lib/once.js";\nexport const run = (id, operation) => once(id, operation);\n');
  await git('add', 'worker.js'); await git('commit', '-m', 'deduplicate'); const head = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'lib/once.js'), 'UNCOMMITTED_SECRET_CONTENT\n');
  const settings = { ...structuredClone(DEFAULT_CONFIG), provider: 'codex', models: { small: { provider: 'codex', model: null }, medium: { provider: 'codex', model: null }, large: { provider: 'codex', model: null } } };
  await saveConfig(settings, env);
  const [change] = await pushSnapshots({ cwd: repo, remote: 'origin', remoteUrl: 'https://example.invalid/repo', input: `refs/heads/main ${head} refs/heads/main ${base}\n`, config: settings, env });
  const space = await createReviewWorkspace(change, settings, { env });
  const rejected = await space.execute('read_file', { path: '.env' });
  assert.deepEqual(rejected.evidencePaths, []);
  assert.equal(rejected.error.code, 'PATH_UNAVAILABLE');
  const result = await runReviewer({ ...options, snapshot: change, config: { ...settings, changeTier: 'small' }, workspace: space, runModel: async args => {
    await args.beforeCall(); const seen = observations(decode(args));
    assert.ok(seen.length, 'The first request already contains the changed immutable diff');
    if (seen.length === 1) { assert.match(seen[0].result.text, /once/); return toolAction([['read_file', { path: 'lib/once.js' }]]); }
    assert.match(seen[1].result.text, /seen\.has/);
    return finish(['e1', 'e2']);
  } });
  assert.deepEqual(result.review.evidencePaths, ['worker.js', 'lib/once.js']);
  assert.doesNotMatch(JSON.stringify(result), /secret-marker|UNCOMMITTED_SECRET_CONTENT|DO_NOT_SEND_PRIVATE_KEY/);
});
