import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { deckFile, readDeck } from '../src/deck.js';

const CLI = fileURLToPath(new URL('../bin/sphinx.js', import.meta.url));

// A subprocess fixture exercising the real provider transport and output validation.
// It never calls a model or connects to a service.
const PROVIDER = `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.SPHINX_TEST_LOG, JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2),input,evaluator:process.env.SPHINX_EVALUATOR})+'\\n');
  if (process.env.SPHINX_TEST_FAILURE === '1') process.exit(23);
  const data = JSON.parse(input.slice(input.lastIndexOf('\\n')+1));
  const evidence = [{path:'app.js',reason:'The set records IDs before enqueue returns, so duplicate IDs are rejected in one process.'}];
  const question = {id:'duplicate',concept:'deduplication lifetime',prompt:'In the same running process, enqueue receives the same ID twice. Does the second request enqueue again? Explain why.',choices:[],expectedAnswer:'No, the set already contains the ID.',rationale:'Membership is checked before insertion. The second call returns false.',acceptance:{prediction:'The repeated ID does not enqueue again in the same process.',causalReason:'The existing set membership is checked before insertion.'},evidence};
  const followUp = {...question,id:'restart',prompt:'After the process restarts, the same ID arrives again. Can this implementation enqueue it? Explain why.',expectedAnswer:'Yes. The in-memory set is recreated on restart.',rationale:'The deduplication state is only an in-memory set.',acceptance:{prediction:'The same ID can enqueue after a process restart.',causalReason:'The process-local set is recreated empty on restart.'}};
  let result;
  if (data.proposedQuestions) result = {questions:data.proposedQuestions,feedback:'The proposed questions match the supplied source observations.'};
  else if (!data.question) {
    const observations = (data.conversation || []).filter(item => item.content.startsWith('Workspace observation')).map(item => JSON.parse(item.content.slice(item.content.indexOf('\\n')+1)));
    result = observations.length
      ? {action:'finish',calls:[],assessment:{questions:[question]},summary:'The changed enqueue path uses process-local ID membership.',evidenceIds:observations.map(item=>item.id)}
      : {action:'tools',calls:[{name:'read_diff',arguments:JSON.stringify({path:'app.js'})}],assessment:null,summary:'',evidenceIds:[]};
  }
  else if (data.humanAnswer === 'WRONG' || data.humanAnswer.startsWith('I do not know')) result = {questionValid:true,verdict:'incorrect',feedback:'The set belongs to this process. It rejects duplicate IDs until the process restarts; the state is not persisted.',evidence,followUp};
  else if (data.dispute) result = {questionValid:true,verdict:'ambiguous',feedback:'The assumptions need clarification.',evidence,followUp};
  else result = {questionValid:true,verdict:'correct',feedback:'You connected the observable result to the lifetime of the stored IDs.',evidence,followUp:null};
  process.stdout.write(JSON.stringify({type:'result',subtype:'success',structured_output:result}));
});
`;

async function fixture(t, { background = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'sphinx-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repo');
  const bare = path.join(base, 'remote.git');
  const bin = path.join(base, 'bin');
  for (const dir of [home, repo, bin]) await mkdir(dir);
  const env = { ...process.env, CI: '1', HOME: home, SPHINX_USER_HOME: home, SPHINX_HOME: path.join(home, 'sphinx'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, SPHINX_TEST_LOG: path.join(base, 'model-calls.jsonl'),
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG', 'SPHINX_EVALUATOR', 'SPHINX_INSTALL_ID', 'SPHINX_HOOK_DEPTH', 'OPENROUTER_API_KEY', 'SPHINX_TEST_FAILURE', 'CODEX_THREAD_ID', 'SPHINX_CLAUDE_SESSION']) delete env[key];
  await writeFile(path.join(bin, 'claude'), PROVIDER, { mode: 0o755 });
  await chmod(path.join(bin, 'claude'), 0o755);
  const run = (command, args, changes = {}) => spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', input: '', timeout: 20000, ...changes });
  const ok = (command, args, changes) => {
    const result = run(command, args, changes);
    assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}\n${result.error || ''}`);
    return result.stdout.trim();
  };
  const git = (...args) => ok('git', args);
  const cli = (...args) => {
    const output = ok(process.execPath, [CLI, ...args]);
    // These gate tests control evaluation explicitly. The background E2E below
    // opts in separately, so detached workers never race unrelated assertions.
    // Their scripted model also expects the independent audit on every change.
    if (args[0] === 'install' && !args.includes('--repo') && !args.includes('--help') && !args.includes('-h')) {
      const file = path.join(env.SPHINX_HOME, 'config.json');
      const config = JSON.parse(readFileSync(file, 'utf8'));
      if (!background) config.backgroundPreparation = false;
      config.audit = 'all';
      writeFileSync(file, JSON.stringify(config));
    }
    return output;
  };
  const cliJson = (...args) => JSON.parse(cli(...args, '--json'));
  git('init', '-q', '-b', 'main');
  git('config', '--local', 'user.name', 'Sphinx Test');
  git('config', '--local', 'user.email', 'sphinx@example.test');
  git('config', '--local', 'commit.gpgsign', 'false');
  git('init', '--bare', '-q', bare);
  git('remote', 'add', 'origin', bare);
  const app = 'const seen = new Set();\nexport function enqueue(id) {\n  if (seen.has(id)) return false;\n  seen.add(id);\n  return true;\n}\n';
  await writeFile(path.join(repo, 'app.js'), app);
  await writeFile(path.join(repo, '.sphinxignore'), '.env\n');
  await writeFile(path.join(repo, '.env'), 'PRIVATE_TEST_SECRET=do-not-transmit-92bfa\n');
  git('add', '.'); git('commit', '-qm', 'Add queue deduplication');
  const calls = async () => (await readFile(env.SPHINX_TEST_LOG, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { base, home, repo, bare, env, run, ok, git, cli, cliJson, calls, app };
}

test('CLI blocks a push, conducts the learning loop, reuses completion, and rejects changed code', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  const blocked = f.run('git', ['push', 'origin', 'main']);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Sphinx: understanding check needed/);
  assert.deepEqual(await f.calls(), [], 'Git hooks must not invoke the evaluator');
  const pending = f.cliJson('pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');
  assert.equal(pending[0].route.provider, 'claude');
  const first = f.cliJson('check');
  assert.equal(first.id, pending[0].id);
  assert.equal(first.status, 'active');
  assert.equal(first.question.id, 'duplicate');
  assert.equal(Object.hasOwn(first.question, 'expectedAnswer'), false);
  assert.equal(Object.hasOwn(first.question, 'acceptance'), false);
  assert.equal(Object.hasOwn(first.question, 'rationale'), false);
  assert.equal((await f.calls()).length, 3);
  // Resuming an existing interview does not spend another generation call.
  assert.equal(f.cliJson('check').question.id, 'duplicate');
  assert.equal((await f.calls()).length, 3);
  const wrong = f.cliJson('answer', first.id, '--text', 'WRONG');
  assert.equal(wrong.verdict, 'incorrect');
  assert.equal(wrong.status, 'active');
  assert.equal(wrong.progress.completed, 0);
  assert.equal(wrong.question.id, 'restart');
  assert.notEqual(wrong.question.prompt, first.question.prompt);
  assert.match(wrong.feedback, /not persisted/);
  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0);
  const afterWrong = await f.calls();
  assert.equal(afterWrong.length, 5, 'Incorrect grading and the independent transfer-question audit each consume one call');
  const transferAudit = JSON.parse(afterWrong.at(-1).input.split('\n').at(-1));
  assert.equal(transferAudit.auditPurpose, 'followUp');
  assert.equal(transferAudit.proposedQuestions[0].id, 'restart');
  assert.equal(transferAudit.humanAnswer, undefined, 'The replacement audit must be independent of the human answer');
  const passed = f.cliJson('answer', first.id, '--text', 'Yes. Restart recreates the set, so it cannot remember the previous process\'s IDs.');
  assert.equal(passed.status, 'passed');
  assert.equal(passed.progress.completed, 1);
  assert.equal(Object.hasOwn(passed, 'question'), false);
  const sessionPath = path.join(f.env.SPHINX_HOME, 'sessions', `${first.id}.json`);
  assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
  f.git('push', 'origin', 'main');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0], f.git('rev-parse', 'HEAD'));
  f.git('push', 'origin', 'main');
  assert.equal((await f.calls()).length, 6);
  assert.deepEqual(f.cliJson('pending'), []);
  await writeFile(path.join(f.repo, 'app.js'), `${f.app}\nexport const maxQueueSize = 100;\n`);
  f.git('add', 'app.js'); f.git('commit', '-qm', 'Expose queue limit');
  const changed = f.run('git', ['push', 'origin', 'main']);
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /understanding check needed/);
  assert.notEqual(f.cliJson('pending')[0].id, first.id);
  for (const invocation of await f.calls()) {
    assert.equal(invocation.evaluator, '1');
    assert.notEqual(invocation.cwd, f.repo);
    assert.ok(invocation.argv.includes('--no-session-persistence'));
    assert.equal(invocation.input.includes('do-not-transmit-92bfa'), false);
  }
  f.cli('uninstall');
  assert.notEqual(f.run('git', ['config', '--global', '--get', 'core.hooksPath']).status, 0);
});

test('a passed check fills the local deck and sphinx drill lists it without model calls or answer keys', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0);
  const pending = f.cliJson('pending')[0];
  f.cliJson('check');
  f.cliJson('answer', pending.id, '--text', 'Yes. Restart recreates the set, so it cannot remember the previous process\'s IDs.');
  const before = (await f.calls()).length;
  const empty = f.cliJson('drill');
  assert.equal(empty.due, 0);
  assert.equal(empty.upcoming, 1);
  assert.equal(empty.cards.length, 0);
  const listed = f.cliJson('drill', '--list');
  assert.equal(listed.cards.length, 1);
  assert.match(listed.cards[0].prompt, /same ID twice/);
  assert.equal(Object.hasOwn(listed.cards[0], 'back'), false);
  assert.equal(Object.hasOwn(listed.cards[0], 'expectedAnswer'), false);
  assert.equal(Object.hasOwn(listed.cards[0], 'rationale'), false);
  assert.doesNotMatch(JSON.stringify(listed), /recreated on restart|in-memory set/i);
  const status = f.cliJson('status');
  assert.equal(status.drill.total, 1);
  assert.equal(status.drill.due, 0);
  const human = f.cli('drill', '--list');
  assert.match(human, /same ID twice/);
  assert.doesNotMatch(human, /recreated on restart|in-memory set/i);
  const rejected = f.run(process.execPath, [CLI, 'drill', '--limit', '0']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /1 to 50/);
  const file = deckFile(f.repo, f.env);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const id = Object.keys((await readDeck(f.repo, f.env)).cards)[0];
  stored.cards[id].dueAt = '2020-01-01T00:00:00.000Z';
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
  const interactive = f.run(process.execPath, [CLI, 'drill']);
  assert.equal(interactive.status, 1);
  assert.match(interactive.stderr, /terminal|--json/);
  const dueNow = f.cliJson('drill');
  assert.equal(dueNow.due, 1);
  assert.equal(dueNow.cards.length, 1);
  assert.equal(Object.hasOwn(dueNow.cards[0], 'back'), false);
  assert.equal((await f.calls()).length, before, 'drill makes no model calls');
});

test('CLI keeps a failed evaluator pending and enforces the checkpoint on retry', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0);
  const failure = f.run(process.execPath, [CLI, 'check', '--json'], { env: { ...f.env, SPHINX_TEST_FAILURE: '1' } });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /No completion\s+was\s+recorded/);
  assert.equal(f.cliJson('pending')[0].status, 'pending');
  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0);
  const first = f.cliJson('check');
  const beforeLearn = (await f.calls()).length;
  const learned = f.cliJson('explain', first.id);
  assert.equal(learned.status, 'active');
  assert.equal(learned.question.id, 'restart');
  assert.equal(learned.progress.completed, 0);
  assert.equal((await f.calls()).length, beforeLearn + 2, 'Learning grades once and audits its replacement before display');
});

test('CLI explicitly retries a failed review without erasing prior usage or resetting active questions', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  // Extending an allowance only applies to an explicitly configured cap.
  f.cli('config', '--max-model-calls', '20');
  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0);
  const failed = f.run(process.execPath, [CLI, 'check', '--json'], { env: { ...f.env, SPHINX_TEST_FAILURE: '1' } });
  assert.equal(failed.status, 1);
  const before = f.cliJson('pending')[0];
  assert.equal(before.usage.calls, 1);
  const noId = f.run(process.execPath, [CLI, 'check', '--retry-review', '--json']);
  assert.equal(noId.status, 1); assert.match(noId.stderr, /requires --id/);
  const retried = f.cliJson('check', '--id', before.id, '--retry-review');
  assert.equal(retried.status, 'active');
  assert.equal(retried.usage.limit, before.usage.calls + before.usage.limit);
  assert.ok(retried.usage.calls > before.usage.calls);
  const calls = (await f.calls()).length;
  const active = f.run(process.execPath, [CLI, 'check', '--id', before.id, '--retry-review', '--json']);
  assert.equal(active.status, 1);
  assert.equal((await f.calls()).length, calls);
  assert.deepEqual(f.cliJson('pending')[0].usage, retried.usage);
});

test('interactive CLI stays open after review failure until the human pauses or retries', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0);
  const id = f.cliJson('pending')[0].id;
  const marker = path.join(f.base, 'fail-review');
  await writeFile(marker, 'fail');
  const provider = PROVIDER.replace("  const data = JSON.parse", `  if (process.env.SPHINX_TEST_BAD_REVIEW_FILE && fs.existsSync(process.env.SPHINX_TEST_BAD_REVIEW_FILE)) {
    process.stdout.write(JSON.stringify({type:'result',subtype:'success',structured_output:{}}));
    return;
  }
  const data = JSON.parse`);
  await writeFile(path.join(f.base, 'bin', 'claude'), provider, { mode: 0o755 });
  const launch = () => {
    // Exercise the actual CLI/readline wiring with controlled pipe input. No GUI
    // or real terminal is needed; TERM=dumb keeps this synthetic TTY unstyled.
    const script = `Object.defineProperty(process.stdin,'isTTY',{value:true});
      const {main}=await import(${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)});
      try { process.exitCode=await main(['check','--id',${JSON.stringify(id)}]); }
      catch(error) { console.error(error.message); process.exitCode=error.exitCode||1; }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: f.repo, env: { ...f.env, TERM: 'dumb', NO_COLOR: '1', SPHINX_WAITING_GIT: '1', SPHINX_TEST_BAD_REVIEW_FILE: marker }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const done = new Promise(resolve => child.once('close', code => resolve(code)));
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    const waitFor = async text => {
      const deadline = Date.now() + 8000;
      while (!output.includes(text) && child.exitCode === null && Date.now() < deadline) await delay(20);
      assert.ok(output.includes(text), `Missing ${text}:\n${output}`);
    };
    return { child, done, waitFor, output: () => output };
  };
  const paused = launch();
  await paused.waitFor('Choose [2]:');
  const before = f.cliJson('pending')[0].usage;
  assert.equal(paused.child.exitCode, null);
  await delay(80);
  assert.deepEqual(f.cliJson('pending')[0].usage, before, 'waiting at the prompt cannot spend calls');
  paused.child.stdin.write('\n');
  assert.equal(await paused.done, 1);
  assert.match(paused.output(), /Progress saved/);
  const resumed = launch();
  await resumed.waitFor('Choose [2]:');
  assert.match(resumed.output(), /original Git operation is waiting/);
  await rm(marker);
  resumed.child.stdin.write('1\n');
  await resumed.waitFor('› ');
  resumed.child.stdin.write('No. The existing ID is rejected before insertion.\n');
  assert.equal(await resumed.done, 0);
  assert.match(resumed.output(), /Understanding check complete/);
  const record = JSON.parse(await readFile(path.join(f.env.SPHINX_HOME, 'sessions', `${id}.json`), 'utf8'));
  assert.equal(record.status, 'passed');
  assert.equal(record.reviewRetries, undefined);
  assert.ok(record.calls > before.calls);
  assert.equal(record.callLimit, undefined, 'ordinary interactive retries never extend the allowance');
});

test('CLI pre-commit gate assesses staged content without waiting for terminal input', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none', '--events', 'pre-commit');
  await writeFile(path.join(f.repo, 'app.js'), `${f.app}\nexport const retries = 3;\n`);
  f.git('add', 'app.js');
  const commit = f.run('git', ['commit', '-qm', 'Add retries']);
  assert.notEqual(commit.status, 0);
  assert.match(commit.stderr, /understanding check needed/);
  const first = f.cliJson('check', '--staged');
  assert.equal(first.event, 'pre-commit');
  assert.equal(f.cliJson('answer', first.id, '--text', 'No. The set already contains the ID and the function returns false.').status, 'passed');
  f.git('commit', '-qm', 'Add retries');
});

test('CLI init creates canonical main-branch policy without reinstalling hooks or overwriting files', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const ignoreBefore = await readFile(path.join(f.repo, '.sphinxignore'), 'utf8');
  f.cli('init', '--yes', '--branches', 'main', '--events', 'pre-push', '--level', 'standard');
  const configPath = path.join(f.repo, '.sphinxconfig');
  const saved = await readFile(configPath, 'utf8');
  const policy = JSON.parse(saved);
  assert.deepEqual(policy.branches, ['main']);
  assert.deepEqual(policy.events, ['pre-push']);
  assert.equal(policy.level, 'standard');
  assert.equal(policy.mode, 'block');
  for (const key of ['provider', 'model', 'models', 'allowPaid', 'maxModelCalls', 'maxOutputTokens']) assert.equal(Object.hasOwn(policy, key), false);
  assert.equal(await readFile(path.join(f.repo, '.sphinxignore'), 'utf8'), ignoreBefore);
  assert.notEqual(f.run('git', ['config', '--global', '--get', 'core.hooksPath']).status, 0);
  assert.notEqual(f.run('git', ['config', '--local', '--get', 'core.hooksPath']).status, 0);
  await assert.rejects(stat(path.join(f.env.SPHINX_HOME, 'config.json')), { code: 'ENOENT' });
  f.cli('init', '--yes', '--branches', 'release/*', '--level', 'thorough');
  assert.equal(await readFile(configPath, 'utf8'), saved, 'A second init must not replace existing repository policy');
  assert.equal(await readFile(path.join(f.repo, '.sphinxignore'), 'utf8'), ignoreBefore);
  assert.deepEqual(await f.calls(), []);
});

test('CLI init defaults inherit configured destinations rather than the current feature branch', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.git('checkout', '-qb', 'feature/setup');
  const initialized = f.cliJson('init');
  assert.equal(typeof initialized, 'object');
  const policy = JSON.parse(await readFile(path.join(f.repo, '.sphinxconfig'), 'utf8'));
  assert.deepEqual(policy.branches, ['main', 'master']);
  assert.equal(policy.branches.includes('feature/setup'), false);
  assert.deepEqual(await f.calls(), []);
});

test('canonical repository policy controls actual destination pushes through existing global hooks', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  const hooksBefore = f.git('config', '--global', '--get', 'core.hooksPath');
  f.cli('init', '--yes', '--branches', 'release/*', '--events', 'pre-push');
  assert.equal(f.git('config', '--global', '--get', 'core.hooksPath'), hooksBefore);
  f.git('push', 'origin', 'main');
  assert.deepEqual(f.cliJson('pending'), []);
  const release = f.run('git', ['push', 'origin', 'HEAD:refs/heads/release/v1']);
  assert.notEqual(release.status, 0);
  assert.match(release.stderr, /understanding check needed/);
  assert.equal(f.cliJson('pending').length, 1);
  assert.deepEqual(f.cliJson('status').config.branches, ['release/*']);
  assert.deepEqual(await f.calls(), [], 'Policy setup and Git gates must not invoke an evaluator');
});

test('each public CLI command provides contextual help without setup or model calls', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const commands = ['install', 'activate', 'init', 'auth', 'check', 'pending', 'answer', 'explain', 'dispute', 'status', 'config', 'doctor', 'uninstall', 'drill'];
  const generalHelp = f.cli('--help');
  for (const command of commands) {
    const optionHelp = f.cli(command, '--help');
    const topicHelp = f.cli('help', command);
    assert.match(optionHelp, new RegExp(`sphinx ${command}`));
    assert.match(topicHelp, new RegExp(`sphinx ${command}`));
    assert.notEqual(optionHelp, generalHelp, 'Command help must describe that command instead of repeating the entire command index');
    assert.equal(optionHelp, topicHelp, 'Both contextual help forms should present the same guidance');
    assert.equal(/\u001b\[/u.test(optionHelp), false, 'Piped help must not contain ANSI styling');
  }
  assert.match(f.cli('init', '--help'), /\.sphinxconfig/);
  assert.match(f.cli('check', '--help'), /--staged/);
  assert.match(f.cli('install', '--help'), /--allow-paid/);
  await assert.rejects(stat(path.join(f.repo, '.sphinxconfig')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.env.SPHINX_HOME, 'config.json')), { code: 'ENOENT' });
  assert.deepEqual(await f.calls(), []);
});

test('scripted installation defers client launch and activate checks configured selections', async t => {
  const f = await fixture(t);
  const output = f.cli('install', '--yes', '--provider', 'claude', '--agents', 'claude');
  assert.match(output, /sphinx activate --agents claude/);
  assert.doesNotMatch(output, /Restart Claude Code|Codex hook trust/);
  await assert.rejects(stat(path.join(f.env.SPHINX_HOME, 'activations')), { code: 'ENOENT' });
  const manifest = await readFile(path.join(f.env.SPHINX_HOME, 'install.json'), 'utf8');
  for (const selection of ['codex', 'claude,codex', 'claude,claude', 'none']) {
    const rejected = f.run(process.execPath, [CLI, 'activate', '--agents', selection]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /not installed|--agents must/);
  }
  assert.equal(await readFile(path.join(f.env.SPHINX_HOME, 'install.json'), 'utf8'), manifest);
  assert.deepEqual(await f.calls(), []);
});

test('explicit activation in headless environments reports fallback without changing installation or calling a model', async t => {
  const f = await fixture(t);
  const env = { ...f.env, CI: '1', FORCE_COLOR: '1' };
  const installed = f.run(process.execPath, [CLI, 'install', '--yes', '--launch', '--provider', 'claude', '--agents', 'claude'], { env });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /No local desktop/);
  const manifest = await readFile(path.join(f.env.SPHINX_HOME, 'install.json'), 'utf8');
  const activated = f.run(process.execPath, [CLI, 'activate', '--json'], { env });
  assert.equal(activated.status, 1);
  assert.equal(/\u001b\[/u.test(activated.stdout), false);
  const { results } = JSON.parse(activated.stdout);
  assert.deepEqual(results.map(item => item.agent), ['claude']);
  assert.equal(results[0].status, 'unavailable');
  assert.match(results[0].detail, /No local desktop/);
  assert.equal(await readFile(path.join(f.env.SPHINX_HOME, 'install.json'), 'utf8'), manifest);
  await assert.rejects(stat(path.join(f.env.SPHINX_HOME, 'activations')), { code: 'ENOENT' });
  assert.deepEqual(await f.calls(), []);
});

test('contradictory launch flags and repository-only launches fail before installation', async t => {
  const f = await fixture(t);
  for (const args of [['--launch', '--no-launch'], ['--repo', '--launch']]) {
    const result = f.run(process.execPath, [CLI, 'install', '--yes', ...args]);
    assert.equal(result.status, 1);
  }
  await assert.rejects(stat(path.join(f.env.SPHINX_HOME, 'install.json')), { code: 'ENOENT' });
  assert.notEqual(f.run('git', ['config', '--global', '--get', 'core.hooksPath']).status, 0);
  assert.deepEqual(await f.calls(), []);
});

test('JSON inspection and out-of-policy checks stay unstyled and require no remote or evaluator', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.git('remote', 'remove', 'origin');
  const env = { ...f.env, FORCE_COLOR: '1' };
  delete env.NO_COLOR;
  const json = (...args) => {
    const raw = f.ok(process.execPath, [CLI, ...args, '--json'], { env });
    assert.equal(/\u001b\[/u.test(raw), false, 'JSON must not contain ANSI even when color is forced');
    return JSON.parse(raw);
  };
  assert.equal(typeof json('init', '--branches', 'main'), 'object');
  assert.deepEqual(json('pending'), []);
  assert.deepEqual(json('status').config.branches, ['main']);
  const configuration = json('config');
  assert.deepEqual((configuration.config ?? configuration).branches, ['main']);
  assert.equal(typeof json('init', '--help'), 'object');
  assert.deepEqual(json('check', '--remote', 'not-configured', '--branch', 'feature/skip'), { status: 'not-required' });
  assert.deepEqual(await f.calls(), []);
});

async function nativeClient(f, t) {
  const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: f.repo, env: { ...f.env, FORCE_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let buffer = '', stderr = ''; const messages = [], waiters = [];
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n'); if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const message = JSON.parse(line);
      const waiter = waiters.find(item => item.matches(message));
      if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
      else messages.push(message);
    }
  });
  const next = matches => new Promise((resolve, reject) => {
    const index = messages.findIndex(matches);
    if (index >= 0) { resolve(messages.splice(index, 1)[0]); return; }
    const item = { matches, resolve };
    item.timer = setTimeout(() => { waiters.splice(waiters.indexOf(item), 1); reject(new Error(`MCP response timed out: ${stderr}`)); }, 10000);
    waiters.push(item);
  });
  const send = value => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sphinx-test-host', version: '1' } } });
  const initialized = await next(message => message.id === 1);
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  send({ method: 'notifications/initialized' });
  const hook = id => send({ id, method: 'tools/call', params: { name: 'sphinx_checkpoint', arguments: { cwd: f.repo, host: 'claude', hookEvent: 'PostToolUseFailure', hostSession: 'test-host-session' } } });
  return { child, send, next, hook };
}

test('Git triggers a native questionnaire, direct human replies complete it, and only summary reaches the model', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0);
  assert.deepEqual(await f.calls(), [], 'The Git hook only queues; it does not call the coding model or evaluator');
  const client = await nativeClient(f, t);
  client.hook(2); // The host lifecycle invokes this deterministically, without a model tools/call decision.
  const first = await client.next(message => message.method === 'elicitation/create');
  assert.match(first.params.message, /same ID twice/);
  assert.equal(first.params.message.includes('do-not-transmit-92bfa'), false);
  client.send({ id: first.id, result: { action: 'accept', content: { action: 'answer', response: 'WRONG' } } });
  const transfer = await client.next(message => message.method === 'elicitation/create');
  assert.match(transfer.params.message, /process restarts/);
  assert.match(transfer.params.message, /not persisted/);
  client.send({ id: transfer.id, result: { action: 'accept', content: { action: 'answer', response: 'Yes, restarting recreates the in-memory set.' } } });
  const completed = await client.next(message => message.id === 2);
  assert.equal(completed.result.structuredContent.status, 'passed');
  const modelOutput = JSON.stringify(completed.result);
  for (const hidden of ['same ID twice', 'process restarts', 'not persisted', 'WRONG', 'restarting recreates', 'expectedAnswer', 'do-not-transmit-92bfa']) assert.equal(modelOutput.includes(hidden), false);
  const hookOutput = JSON.parse(completed.result.content[0].text);
  assert.equal(hookOutput.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(hookOutput.hookSpecificOutput.additionalContext, /retry/i);
  assert.equal((await f.calls()).length, 6);
  assert.deepEqual(f.cliJson('pending'), []);
  f.git('push', 'origin', 'main');
  client.hook(3);
  assert.equal((await client.next(message => message.id === 3)).result.structuredContent.status, 'not-required');
  assert.equal((await f.calls()).length, 6);
  client.child.stdin.end();
});

test('cancelled native forms do not reopen on unrelated tools; retrying Git resumes without regeneration', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0);
  const client = await nativeClient(f, t);
  client.hook(2);
  const first = await client.next(message => message.method === 'elicitation/create');
  client.send({ id: first.id, result: { action: 'cancel' } });
  assert.equal((await client.next(message => message.id === 2)).result.structuredContent.status, 'pending');
  client.hook(3);
  assert.equal((await client.next(message => message.id === 3)).result.structuredContent.status, 'not-required');
  assert.equal((await f.calls()).length, 3);
  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0);
  client.hook(4);
  const resumed = await client.next(message => message.method === 'elicitation/create');
  assert.equal(resumed.params.message, first.params.message);
  assert.equal((await f.calls()).length, 3);
  client.send({ id: resumed.id, result: { action: 'accept', content: { action: 'answer', response: 'No, the set already contains the ID.' } } });
  assert.equal((await client.next(message => message.id === 4)).result.structuredContent.status, 'passed');
  f.git('push', 'origin', 'main');
  client.child.stdin.end();
});

test('native resume trims a legacy small-change questionnaire without regeneration and still requires a human answer', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0);
  const [pending] = f.cliJson('pending');
  assert.equal(pending.route.tier, 'small');
  const sessionPath = path.join(f.env.SPHINX_HOME, 'sessions', `${pending.id}.json`);
  const legacy = JSON.parse(await readFile(sessionPath, 'utf8'));
  const current = {
    id: 'legacy-duplicate', concept: 'deduplication lifetime',
    prompt: 'In the same running process, enqueue receives the same ID twice. Does the second request enqueue again? Explain why.',
    choices: ['Yes', 'No'], expectedAnswer: 'No, the set already contains the ID.',
    rationale: 'Membership is checked before insertion. The second call returns false.',
    evidence: [{ path: 'app.js', reason: 'The existing ID returns before insertion.' }],
  };
  legacy.status = 'active';
  legacy.snapshot.version = 1;
  legacy.snapshot.evidence = `Committed legacy evidence for app.js:\n${f.app}`;
  legacy.calls = 1; // The previous version already paid for these stored questions.
  legacy.questions = [current,
    { ...current, id: 'legacy-restart', prompt: 'Can an ID enqueue again after the process restarts?' },
    { ...current, id: 'legacy-workers', prompt: 'Can two independent processes each enqueue the same ID?' },
  ];
  await writeFile(sessionPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

  const client = await nativeClient(f, t);
  client.hook(2);
  const form = await client.next(message => message.method === 'elicitation/create');
  assert.match(form.params.message, /1 of 1 concepts/);
  assert.ok(form.params.message.includes(current.prompt));
  assert.doesNotMatch(form.params.message, /process restarts|two independent processes/);
  assert.deepEqual(await f.calls(), [], 'Resuming stored questions must not invoke generation');
  const resumed = JSON.parse(await readFile(sessionPath, 'utf8'));
  assert.deepEqual(resumed.questions, [current]);
  assert.equal(resumed.index, 0);
  assert.equal(resumed.status, 'active', 'Trimming must never approve the change');
  assert.equal(resumed.expiresAt, null);
  assert.equal(resumed.calls, 1);

  client.send({ id: form.id, result: { action: 'accept', content: {
    action: 'answer', response: 'No, the set retains the ID in this process, so the second call returns before insertion.',
  } } });
  const completed = await client.next(message => message.id === 2);
  assert.equal(completed.result.structuredContent.status, 'passed');
  assert.deepEqual(completed.result.structuredContent.checkpoints[0].progress, { completed: 1, total: 1 });
  const calls = await f.calls();
  assert.equal(calls.length, 1, 'Only grading the fresh human response should invoke the evaluator');
  const gradingInput = JSON.parse(calls[0].input.slice(calls[0].input.lastIndexOf('\n') + 1));
  assert.equal(gradingInput.question.id, current.id);
  assert.match(gradingInput.humanAnswer, /set retains the ID/);
  assert.equal(JSON.parse(await readFile(sessionPath, 'utf8')).calls, 2);
  assert.deepEqual(f.cliJson('pending'), []);
  f.git('push', 'origin', 'main');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0], f.git('rev-parse', 'HEAD'));
  client.child.stdin.end();
});

test('post-commit preparation investigates before push and the native gate reuses the exact prepared questions', { timeout: 30000 }, async t => {
  const f = await fixture(t, { background: true });
  // Background curation of the working context runs on the same small-change
  // route, and a failed call is followed by a plan sign-in check. Count only
  // review and grading calls below.
  const curator = call => call.input.includes('You keep a brief orientation for a code reviewer');
  const allCalls = f.calls;
  f.calls = async () => (await allCalls()).filter(call => !curator(call) && call.argv[0] !== 'auth');
  // Establish local tracking metadata before installing hooks; no inference.
  f.git('push', '-u', 'origin', 'main');
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  const configFile = path.join(f.env.SPHINX_HOME, 'config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.preparationDebounceMs = 40;
  await writeFile(configFile, JSON.stringify(config));
  const projectContext = 'This repository implements a work queue. Duplicate IDs are suppressed within one process.';
  await writeFile(path.join(f.repo, '.sphinxcontext.md'), projectContext);
  await writeFile(path.join(f.repo, 'app.js'), `${f.app}\nexport const retryDelay = 50;\n`);
  f.git('add', 'app.js', '.sphinxcontext.md');
  f.git('commit', '-qm', 'Expose retry delay');

  let status;
  const deadline = Date.now() + 15000;
  do {
    status = f.cliJson('status');
    if (status.preparation?.status === 'failed') assert.fail(status.preparation.error);
    if (status.preparation?.status === 'ready') break;
    await delay(100);
  } while (Date.now() < deadline);
  assert.equal(status.preparation?.status, 'ready');
  assert.equal(status.pending.length, 1);
  assert.equal(status.pending[0].status, 'active');
  const all = await allCalls();
  assert.ok(all.some(curator), 'The working context was curated in the background');
  assert.equal(all.filter(curator).some(call => call.input.includes('do-not-transmit-92bfa')), false);
  const generated = await f.calls();
  assert.equal(generated.length, 3, 'Reviewer requested a diff, read its observation, then audited the questions before any push');
  assert.ok(generated.every(call => call.input.includes(projectContext)));
  assert.ok(generated[1].input.includes('Workspace observation'));
  assert.equal(generated.some(call => call.input.includes('do-not-transmit-92bfa')), false);

  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0, 'Prepared questions never approve a push');
  const client = await nativeClient(f, t); client.hook(2);
  const form = await client.next(message => message.method === 'elicitation/create');
  assert.match(form.params.message, /same ID twice/);
  assert.equal((await f.calls()).length, 3, 'The native questionnaire reuses preparation without more review calls');
  client.send({ id: form.id, result: { action: 'accept', content: { action: 'answer', response: 'No, the set retains that ID in this process.' } } });
  assert.equal((await client.next(message => message.id === 2)).result.structuredContent.status, 'passed');
  const calls = await f.calls();
  assert.equal(calls.length, 4); assert.ok(calls[3].input.includes(projectContext));
  f.git('push', 'origin', 'main');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0], f.git('rev-parse', 'HEAD'));
  client.child.stdin.end();
});

test('without a call cap, --retry-review simply continues a failed review', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  assert.notEqual(f.run('git', ['push', 'origin', 'main']).status, 0);
  assert.equal(f.run(process.execPath, [CLI, 'check', '--json'], { env: { ...f.env, SPHINX_TEST_FAILURE: '1' } }).status, 1);
  const before = f.cliJson('pending')[0];
  assert.equal(before.usage.limit, null);
  const retried = f.cliJson('check', '--id', before.id, '--retry-review');
  assert.equal(retried.status, 'active');
  assert.equal(retried.usage.limit, null);
  assert.ok(retried.usage.calls > before.usage.calls, 'Prior usage is kept and counted');
});

test('a documentation-only push goes through with no questionnaire and no model call', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.git('push', '-u', 'origin', 'main');
  f.cli('install', '--yes', '--provider', 'claude', '--agents', 'none');
  await writeFile(path.join(f.repo, 'README.md'), '# Queue\n\nUsage notes.\n');
  f.git('add', 'README.md'); f.git('commit', '-qm', 'Docs');
  const before = (await f.calls()).length;
  const pushed = f.run('git', ['push', 'origin', 'main']);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.match(pushed.stderr, /documentation-only change to refs\/heads\/main; no questions needed/);
  assert.equal((await f.calls()).length, before, 'No model was called');
});
