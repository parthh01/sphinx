#!/usr/bin/env node
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, openRouterKey } from '../src/config.js';
import { CASES } from './cases.js';
import { runEvaluation } from './harness.js';

const { values } = parseArgs({ options: {
  live: { type: 'boolean' }, case: { type: 'string' }, model: { type: 'string' },
  'max-calls': { type: 'string' }, 'max-cost': { type: 'string' }, out: { type: 'string' },
  'delay-ms': { type: 'string' },
  'max-output-tokens': { type: 'string' },
  probes: { type: 'string', default: 'both' }, 'allow-paid': { type: 'boolean' },
  'skip-regressions': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });

if (values.help) {
  console.log(`Usage: npm run eval -- [options]

Default: deterministic scripted transports, real Pi and isolated committed Git fixtures.
  --live                 Use selected global OpenRouter routes; sends synthetic fixture code only
  --case <ids>           Comma-separated: ${CASES.map(item => item.id).join(', ')}
  --model <id>           Override all tiers with this OpenRouter model
  --allow-paid           Explicitly permit a paid live route for this evaluation
  --max-calls <1-1000>    Hard run-wide request cap (live: 20; scripted: 80)
  --max-cost <USD>       Stop after reported cost reaches this amount; can exceed by one request
  --delay-ms <0-60000>    Delay after each response (live default: 1000; scripted: 0)
  --max-output-tokens <512-16384>  Override the per-request output cap for this run only
  --probes <selection>   both (default), generated, or canonical grading probes
  --out <path>           Save JSON including synthetic questions, rubrics, evidence and grades
  --json                Print only the report JSON
  --skip-regressions     Skip existing deterministic evidence/compaction/recovery regressions

Live cost limits depend on provider reporting; missing usage stops subsequent requests.
No Sphinx session receipts are created, and real pending assessments are never read.`);
} else {
  try {
    const ids = values.case?.split(',');
    if (ids?.some(id => !CASES.some(item => item.id === id))) throw new Error('Unknown case; run npm run eval -- --help.');
    const cases = ids ? CASES.filter(item => ids.includes(item.id)) : CASES;
    const config = values.live ? await loadConfig() : structuredClone(DEFAULT_CONFIG);
    if (values['max-output-tokens'] !== undefined) config.maxOutputTokens = Number(values['max-output-tokens']);
    if (values.model) for (const tier of ['small', 'medium', 'large']) config.models[tier] = { provider: 'openrouter', model: values.model };
    // A saved product preference is not blanket permission to spend in an eval.
    config.allowPaid = Boolean(values['allow-paid']);
    if (values.live && Object.values(config.models).some(route => route.provider !== 'openrouter')) throw new Error('Selected routes must be OpenRouter; use --model to select an OpenRouter route for this run.');
    if (values.live && !config.allowPaid && Object.values(config.models).some(route => route.model && route.model !== 'openrouter/free' && !route.model.endsWith(':free'))) throw new Error('The selected route may be paid. Pass --allow-paid explicitly or choose --model openrouter/free.');
    const apiKey = values.live ? await openRouterKey(process.env) : undefined;
    const report = await runEvaluation({ cases, config, live: !!values.live, apiKey,
      maxCalls: Number(values['max-calls'] ?? (values.live ? 20 : 80)), maxCost: values['max-cost'] === undefined ? undefined : Number(values['max-cost']), probes: values.probes,
      delayMs: values['delay-ms'] === undefined ? undefined : Number(values['delay-ms']),
      onCase: async (result, partial) => {
        if (values.out) await writeFile(resolve(values.out), `${JSON.stringify(partial, null, 2)}\n`, { mode: 0o600 });
        if (!values.json) console.error(`${result.id}: ${result.status} · ${result.calls} requests · ${result.toolCalls} workspace reads · ${result.grades.filter(item => item.pass).length}/${result.grades.length} grading probes`);
      },
    });
    if (!values['skip-regressions']) {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const names = 'unread or unchanged-only citations|seeded context citations retain|a retained file-read hint also retains|Pi native compaction preserves|invalid Pi compaction summaries|failed review waits for an explicit retry|Enter defaults to pause';
      try {
        const result = await promisify(execFile)(process.execPath, ['scripts/run-suite.mjs', '--test-reporter=spec', `--test-name-pattern=${names}`, 'test/reviewer.test.js', 'test/reviewer-recovery.test.js', 'test/check-recovery.test.js'], { cwd: root, maxBuffer: 1024 * 1024, timeout: 60000 });
        report.regressions = { status: 'passed', liveRequests: 0, output: result.stdout };
      } catch (error) { report.regressions = { status: 'failed', liveRequests: 0, output: String(error.stdout || error.message).slice(0, 20000) }; report.status = 'failed'; }
    }
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) await writeFile(resolve(values.out), output, { mode: 0o600 });
    if (values.json) process.stdout.write(output);
    else {
      const cost = !values.live ? 'no live requests' : report.usage.costReports
        ? `$${report.usage.reportedCostUsd.toFixed(6)} reported (${report.usage.costReports}/${report.usage.calls} cost reports)` : 'cost unavailable';
      console.log(`${report.status}: ${report.usage.calls}/${report.limits.maxCalls} requests; ${cost}.${values.out ? ` Report: ${resolve(values.out)}` : ' Use --out to retain questions and rubrics.'}`);
    }
    if (report.status === 'failed') process.exitCode = 1;
  } catch (error) { console.error(`Evaluation stopped: ${error.message}`); process.exitCode = 1; }
}
