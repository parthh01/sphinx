const question = (id, concept, prompt, expectedAnswer, evidence, acceptance) => ({
  id, concept, prompt, choices: [], expectedAnswer, acceptance,
  rationale: `${expectedAnswer} Accept equivalent causal explanations; do not require names or exact wording.`,
  evidence: evidence.map(path => ({ path, reason: `Establishes ${concept.toLowerCase()}.` })),
});

const handlers = limit => Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`handlers/job-${index}.js`, `import { retry } from '../retry.js';\nexport const retryLimit = ${limit};\nexport const run = operation => retry(retryLimit, operation);\n`]));
const batchBase = handlers(1), batchHead = handlers(3);

/** Golden facts and answers are hand-authored from these small executable fixtures.
 * They are never supplied to the reviewer as instructions or scoring criteria. */
export const CASES = [
  {
    id: 'cosmetic', title: 'Card styling leaves shared toolbar controls unchanged', expectedTier: 'small',
    context: 'A task application shares the button class between task-card actions and toolbar actions. This patch should change only card buttons, without changing toolbar controls or click behavior.',
    before: { 'styles.css': '.button { padding-block: 4px; padding-inline: 12px; }\n', 'index.html': '<main><nav class="toolbar"><button class="button">Refresh</button></nav><article class="card"><button class="button">Complete task</button></article></main>\n' },
    after: { 'styles.css': '.button { padding-block: 4px; padding-inline: 12px; }\n.card .button { padding-block: 8px; }\n' },
    requiredPaths: ['styles.css', 'index.html'],
    concepts: [{ label: 'card scope', any: ['card'] }, { label: 'toolbar invariant', any: ['toolbar', 'outside the card', 'outside a card'] }, { label: 'scoped propagation', any: ['selector', 'ancestor', 'scop', 'descendant', 'only', 'boundar', 'rules combine'] }],
    canonical: question('button-scope', 'Style propagation boundary', 'The card action and toolbar action both use the shared button class. Does this change affect both surfaces? Explain the boundary that determines where it applies.', 'Only the card button changes. The new rule requires a card ancestor; the toolbar button has none and retains the shared styling. Sharing the button class alone does not spread the scoped change.', ['styles.css', 'index.html'], { prediction: 'The card button changes; the toolbar button remains unchanged.', causalReason: 'The new rule requires a card ancestor, so sharing the button class alone is insufficient.' }),
    correct: 'Only buttons inside a card receive the new padding because the new selector requires a card ancestor. The toolbar button shares the button class but is outside a card, so its styling stays unchanged. The base button rule, horizontal padding, and click behavior remain unchanged.',
    wrong: 'Both the card and toolbar buttons change, because sharing the button class makes the new rule apply globally regardless of their ancestors.',
    oracle: "const css = await readFile('styles.css', 'utf8'); const html = await readFile('index.html', 'utf8'); assert.match(css, /\\.card \\.button \\{ padding-block: 8px; \\}/); assert.match(css, /\\.button \\{ padding-block: 4px;/); assert.match(html, /<nav class=\"toolbar\"><button class=\"button\">/); assert.match(html, /<article class=\"card\"><button class=\"button\">/);",
  },
  {
    id: 'retry', title: 'Retry deduplication and a failure boundary', expectedTier: 'small',
    context: 'A single-process queue worker. The in-memory seen set is intentionally not shared across workers or persisted across restarts. Understand implemented behavior, including bugs.',
    before: { 'worker.js': 'export const run = (id, operation) => operation();\n', 'lib/once.js': 'const seen = new Set();\nexport function once(id, operation) { if (seen.has(id)) return; seen.add(id); return operation(); }\n' },
    after: { 'worker.js': 'import { once } from "./lib/once.js";\nexport const run = (id, operation) => once(id, operation);\n' },
    requiredPaths: ['worker.js', 'lib/once.js'],
    concepts: [{ label: 'duplicate suppression', any: ['duplicate', 'dedup', 'already-seen', 'same id', 'same identifier', 'retry'] }, { label: 'process/failure boundary', any: ['process', 'memory', 'restart', 'throw', 'fail', 'before'] }],
    canonical: question('retry-failure', 'Retry after failure', 'Within this process, the operation throws on its first attempt. Will a second call with the same id execute the operation again? Explain the relevant ordering.', 'No. The helper records the id before invoking the operation, so the failed first attempt leaves that id marked seen and the retry returns early. This is a failure-handling bug, not durable exactly-once delivery.', ['worker.js', 'lib/once.js'], { prediction: 'The second call with the same id does not execute the operation again.', causalReason: 'The id is recorded before execution, so the thrown error leaves it marked as seen.' }),
    correct: 'The worker delegates to the in-memory guard. A repeated id in this process returns undefined without executing again or caching the first result, even if the first operation threw: the id is recorded before the operation. The first invocation returns its operation result. Recording the id before execution can lose a retry after failure. This set is process-local and not durable or shared, so another process or restart can execute the same id again.',
    wrong: 'A failed operation removes its id, so the same-process retry executes again. Successful ids are deduplicated across all workers and survive restarts, and duplicates return the cached first operation result.',
    oracle: "const { run } = await import('./worker.js'); let n = 0; assert.throws(() => run('a', () => { n++; throw Error('failed'); })); assert.equal(run('a', () => n++), undefined); assert.equal(n, 1); assert.equal(run('b', () => { n++; return 42; }), 42); assert.equal(run('b', () => 99), undefined); assert.equal(n, 2);",
  },
  {
    id: 'auth', title: 'Tenant ownership boundary', expectedTier: 'large',
    context: 'A multi-tenant document service. A signed-in user may read only documents belonging to their tenant. Missing documents and denied documents share a 404 response.',
    before: { 'auth/document.js': 'export function getDocument(user, id, documents) { if (!user) return { status: 401 }; const doc = documents.get(id); return doc ? { status: 200, body: doc.text } : { status: 404 }; }\n' },
    after: { 'auth/document.js': 'export function getDocument(user, id, documents) { if (!user) return { status: 401 }; const doc = documents.get(id); if (!doc || doc.tenantId !== user.tenantId) return { status: 404 }; return { status: 200, body: doc.text }; }\n' },
    requiredPaths: ['auth/document.js'],
    concepts: [{ label: 'tenant access boundary', any: ['tenant', 'ownership', 'another organization'] }, { label: 'denial behavior', any: ['404', 'denied', 'not found', 'not-found', 'refus', 'cannot read', 'missing'] }],
    canonical: question('tenant-read', 'Tenant isolation', 'A signed-in user knows the id of a document owned by a different tenant. Does the service return its contents, and how does that response compare with a missing id? Explain the access boundary.', 'No contents are returned. A different tenant and a missing document both return 404; authentication alone no longer grants cross-tenant access.', ['auth/document.js'], { prediction: 'A different tenant and a missing document both return 404 without document contents.', causalReason: 'Access requires matching tenant ownership; authentication or knowing the id does not bypass that boundary.' }),
    correct: 'A signed-in user can read only a document with the same tenantId. A different tenant gets 404 without document contents, just like a missing id. A caller without a user gets 401 before any document lookup or tenant comparison, because the missing-user guard returns first. Knowing an id or being authenticated is not enough to cross the tenant boundary.',
    wrong: 'Any signed-in user can read the document if they know its id; the tenant check only affects the missing-document response.',
    oracle: "const { getDocument } = await import('./auth/document.js'); const docs = new Map([['x', { tenantId: 'a', text: 'secret' }]]); assert.deepEqual(getDocument({tenantId:'b'}, 'x', docs), {status:404}); assert.deepEqual(getDocument({tenantId:'a'}, 'missing', docs), {status:404}); assert.equal(getDocument({tenantId:'a'}, 'x', docs).status, 200); assert.equal(getDocument(null, 'x', docs).status, 401); let lookups = 0; assert.deepEqual(getDocument(null, 'x', { get() { lookups++; throw Error('lookup must not run'); } }), {status:401}); assert.equal(lookups, 0);",
  },
  {
    id: 'config', title: 'Configured defaults and documentation', expectedTier: 'small',
    context: 'A command-line batch processor. Environment variables override checked-in defaults. Documentation describes behavior; the loader defines precedence.',
    before: { 'defaults.json': '{"batchSize":10}\n', 'loader.js': 'import defaults from "./defaults.json" with { type: "json" };\nexport function batchSize(env) { return Number(env.BATCH_SIZE ?? defaults.batchSize); }\n', 'README.md': 'The default batch size is 10. BATCH_SIZE overrides the default.\n' },
    after: { 'defaults.json': '{"batchSize":20}\n', 'README.md': 'The default batch size is 20. BATCH_SIZE overrides the default.\n' },
    requiredPaths: ['defaults.json', 'loader.js', 'README.md'],
    concepts: [{ label: 'default versus override', any: ['override', 'environment', 'batch_size', 'explicit'] }],
    canonical: question('batch-override', 'Configuration precedence', 'After this change, one process has no BATCH_SIZE setting and another has BATCH_SIZE=7. What batch size does each use, and why?', 'They use 20 and 7 respectively. The checked-in default increased, but the loader still gives an explicit environment setting precedence.', ['defaults.json', 'loader.js'], { prediction: 'The unset process uses 20; the process with BATCH_SIZE=7 uses 7.', causalReason: 'An explicit environment setting takes precedence; the checked-in default is only the fallback.' }),
    correct: 'Without BATCH_SIZE the process uses the new checked-in default of 20. With BATCH_SIZE=7 it still uses 7, because the environment override takes precedence. The README now describes the changed default; it does not change the loader or remove overrides.',
    wrong: 'Every process now uses 20, including one configured with BATCH_SIZE=7, because the new defaults file overrides the environment.',
    oracle: "const { batchSize } = await import('./loader.js'); assert.equal(batchSize({}), 20); for (const value of ['5', '7', '15', '0', '-2', '1.5']) assert.equal(batchSize({ BATCH_SIZE: value }), Number(value));",
  },
  {
    id: 'multifile', title: 'Shared retry behavior across twelve handlers', expectedTier: 'large',
    context: 'Twelve worker handlers delegate retry execution to one helper. retryLimit counts total attempts, including the initial attempt; the final failure is rethrown.',
    before: { ...batchBase, 'retry.js': 'export async function retry(limit, operation) { for (let attempt = 1; ; attempt++) { try { return await operation(); } catch (error) { if (attempt >= limit) throw error; } } }\n' },
    after: batchHead,
    requiredPaths: ['handlers/job-0.js', 'retry.js'],
    concepts: [{ label: 'bounded retry attempts', any: ['attempt', 'retry', 'retries'] }, { label: 'final failure', any: ['throw', 'propagat', 'final', 'failure', 'fail'] }],
    canonical: question('retry-cap', 'Retry cap', 'Using a changed handler’s retryLimit, an operation fails on every attempt. How many total attempts does the shared helper make, and what does the caller receive? Explain the limiting condition.', 'Three total attempts, including the initial attempt; the third failure is rethrown to the caller. It is not three retries plus an initial attempt.', ['handlers/job-0.js', 'retry.js'], { prediction: 'Three total attempts are made, and the third failure is rethrown to the caller.', causalReason: 'The counter includes the initial attempt and stops retrying when it reaches the limit.' }),
    correct: 'The changed handler limit is three total attempts. The shared helper counts the initial attempt, resolves immediately with a successful operation result, and rethrows the last error after the third failed attempt. If the first call throws and the second succeeds, run resolves with the second call\'s value after two invocations; the earlier error is caught and there is no third invocation. There are at most three attempts, not four; the change does not guarantee eventual success.',
    wrong: 'Each handler now makes four total attempts: one initial attempt and three retries. If all fail, the helper returns success and swallows the final error.',
    oracle: "const { run } = await import('./handlers/job-0.js'); let n = 0; await assert.rejects(run(async () => { n++; throw Error('failed'); })); assert.equal(n, 3); n = 0; assert.equal(await run(async () => { if (++n === 1) throw Error('transient'); return 'recovered'; }), 'recovered'); assert.equal(n, 2);",
  },
  {
    id: 'override', title: 'A site override against a framework link rule', expectedTier: 'small',
    context: 'A classless CSS framework wraps its element selectors in :where() so that a site stylesheet can override them with plain element selectors. This patch keeps links marked role="button" out of the navigation link rule.',
    before: { 'framework.css': ':where(nav) :where(a) { color: var(--link); }\n', 'site.css': 'nav a { color: crimson; }\n', 'index.html': '<link rel="stylesheet" href="framework.css"><link rel="stylesheet" href="site.css"><nav><a href="/">Home</a> <a href="/start" role="button">Start</a></nav>\n' },
    after: { 'framework.css': ':where(nav) :where(a):not([role="button"]) { color: var(--link); }\n' },
    requiredPaths: ['framework.css', 'site.css', 'index.html'],
    concepts: [{ label: 'site override', any: ['site', 'override', 'nav a'] }, { label: 'cascade precedence', any: ['specificity', 'precedence', 'wins', 'outrank', 'cascade', 'decides'] }],
    canonical: question('link-override', 'Override precedence', 'site.css loads after framework.css and sets nav a { color: crimson; }. Before and after this change, which color does the plain Home link in the navigation get, and which rule wins? Explain what decides it.', 'Crimson before the change, the framework link color after it. The :not() sits outside :where(), so its attribute selector gives the framework rule more specificity than nav a, and loading site.css later no longer helps.', ['framework.css', 'site.css', 'index.html'], { prediction: 'The Home link is crimson before the change and takes the framework link color after it.', causalReason: 'The :not() outside :where() adds the specificity of its attribute selector, which outranks nav a regardless of stylesheet order.' }),
    correct: 'Before the change the framework rule has zero specificity, because :where() contributes none, so nav a makes the Home link crimson. After the change the :not() sits outside :where() and contributes the specificity of its attribute selector, one attribute against the two element names in nav a. The framework rule now outranks nav a, so the Home link takes the framework link color, and loading site.css later does not change that. The Start link has role="button", so the changed rule no longer matches it and it stays crimson. Moving the :not() inside :where() would restore zero specificity.',
    wrong: 'The Home link stays crimson after the change. The framework selector is wrapped in :where(), so the whole rule has zero specificity, and site.css loads later, so nav a still wins.',
    oracle: "const fw = await readFile('framework.css', 'utf8'); const site = await readFile('site.css', 'utf8'); const html = await readFile('index.html', 'utf8'); const selector = css => css.slice(0, css.indexOf('{')).trim(); const weight = s => { const t = s.replace(/:where\\([^)]*\\)/g, '').replace(/:not\\(([^)]*)\\)/g, ' $1'); return [(t.match(/\\[[^\\]]*\\]|\\.[\\w-]+/g) ?? []).length, (t.match(/(?:^|[\\s>+~])[a-z][\\w-]*/g) ?? []).length]; }; assert.equal(selector(fw), ':where(nav) :where(a):not([role=\"button\"])'); assert.deepEqual(weight(selector(fw)), [1, 0]); assert.deepEqual(weight(selector(site)), [0, 2]); assert.ok(html.indexOf('framework.css') < html.indexOf('site.css')); assert.match(html, /<nav><a href=\"\\/\">Home<\\/a>/); assert.match(html, /role=\"button\">Start<\\/a>/);",
  },
];

/** Adapt only independently understood fixture inputs, never a model's rubric.
 * Unrecognized literal assignments are uncovered rather than scored as failures. */
export function generatedAnswers(fixture, question) {
  if (fixture.id !== 'config') return { correct: fixture.correct, wrong: fixture.wrong };
  const uncovered = { uncovered: 'The generated scenario contains an environment assignment outside the independently checked numeric fixture inputs.' };
  const markers = [...question.prompt.matchAll(/\bBATCH_SIZE\b[`"']?\s*(?:=|(?:is\s+)?set\s+to)\s*/gu)];
  const assignments = [];
  for (const marker of markers) {
    const tail = question.prompt.slice(marker.index + marker[0].length);
    const literal = /^(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s,;?]+))/u.exec(tail);
    if (!literal) return uncovered;
    const value = literal[1] ?? literal[2] ?? literal[3] ?? literal[4].replace(/[`.)]+$/u, '');
    assignments.push(value);
  }
  // Other explicit assignment wording must not silently use the fixture's
  // unrelated BATCH_SIZE=7 example. Leave it uncovered until parsed explicitly.
  const unparsed = question.prompt.replace(/\bBATCH_SIZE\b[`"']?\s*(?:=|(?:is\s+)?set\s+to)\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;?]+)/gu, '');
  if (/\bBATCH_SIZE\b[`"']?\s+(?:(?:is\s+)?configured\s+(?:to|as)\b|equals?\b|has\s+(?:a|the)\s+value\b|is\s+[`"'\d+-])/u.test(unparsed)) return uncovered;
  if (!assignments.length) return { correct: fixture.correct, wrong: fixture.wrong };
  if (assignments.length > 8 || assignments.some(value => !/^[-+]?\d+(?:\.\d+)?$/u.test(value) || !Number.isFinite(Number(value)))) return uncovered;
  const values = [...new Set(assignments)];
  return {
    correct: `${values.map(value => `With BATCH_SIZE=${value}, the effective batch size is ${Number(value)}.`).join(' ')} The loader reads the explicit environment setting before the checked-in default and converts that value with Number. Without an environment setting it uses the new default of 20; the documentation does not alter this precedence.`,
    wrong: `The new default overrides every explicit environment setting, so ${values.map(value => `BATCH_SIZE=${value}`).join(' and ')} still use 20. The defaults file takes precedence over the environment.`,
  };
}

export function canonicalProbes(fixture) {
  return [
    { id: 'correct', question: fixture.canonical, answer: fixture.correct, expected: 'correct' },
    { id: 'misconception', question: fixture.canonical, answer: fixture.wrong, expected: 'incorrect' },
    { id: 'unsupported-premise', question: { ...fixture.canonical, id: 'unsupported-speed', prompt: 'Will this change always make production requests faster under any workload? Explain why.', expectedAnswer: 'Yes, all production requests will always be faster.', rationale: 'All workloads necessarily run faster.' }, answer: 'The supplied change contains no workload measurements or universal latency guarantee, so that premise is not established.', expected: 'ambiguous' },
    { id: 'contradictory-key', question: { ...fixture.canonical, id: 'contradictory-key', expectedAnswer: fixture.wrong, rationale: fixture.correct }, answer: fixture.correct, expected: 'ambiguous' },
    { id: 'dispute', question: fixture.canonical, answer: 'Please check whether this question and its answer key are supported by the supplied code.', dispute: true, expected: 'ambiguous' },
  ];
}
