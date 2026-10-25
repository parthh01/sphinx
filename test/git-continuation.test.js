import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { install } from '../src/install.js';
import { DEFAULT_CONFIG, saveConfig, writeJson } from '../src/config.js';
import { toggleYolo, yoloStatus, recentOverrides } from '../src/overrides.js';
import { contextFile } from '../src/working-context.js';

const exec = promisify(execFile);
const modulePath = name => fileURLToPath(new URL(`../src/${name}.js`, import.meta.url));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
// Both sides poll these files, so a reader must never see a partly written one.
const publish = async (file, data) => { await writeFile(`${file}.tmp`, data); await rename(`${file}.tmp`, file); };
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

async function fixture(t, { events = ['pre-push'], oldHook = '' } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "sphinx waiting git ' "));
  const repo = path.join(base, 'repo'), remote = path.join(base, 'remote.git'), home = path.join(base, 'home');
  const state = path.join(base, 'fixture-state');
  await Promise.all([repo, home, state].map(directory => mkdir(directory)));
  // Newer Git detaches post-commit/receive maintenance, which can write packs while cleanup removes the fixture.
  await writeFile(path.join(home, '.gitconfig'), '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n');
  const env = { ...process.env, HOME: home, SPHINX_USER_HOME: home, SPHINX_HOME: path.join(home, '.sphinx'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', SPHINX_TEST_STATE: state, CI: '1' };
  for (const key of Object.keys(env)) if (/^(?:GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG(?:_|$))|SPHINX_(?:INSTALL_ID|EVALUATOR|HOOK_DEPTH)$|CODEX_THREAD_ID$|PI_SESSION_ID$|OPENROUTER_API_KEY$|OPENAI_API_KEY$|ANTHROPIC_API_KEY$)/.test(key) && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].includes(key)) delete env[key];
  const children = new Set();
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    await Promise.all([...children].map(child => child.finished));
    await rm(base, { recursive: true, force: true, maxRetries: 5 });
  });
  const git = async (...args) => (await exec('git', args, { cwd: repo, env, maxBuffer: 1024 * 1024 })).stdout.trimEnd();
  const bare = async (...args) => git('--git-dir', remote, ...args);
  const setup = (...args) => git('-c', 'core.hooksPath=/dev/null', ...args);
  await setup('init', '-q', '-b', 'main');
  await setup('config', 'user.name', 'Sphinx fixture'); await setup('config', 'user.email', 'fixture@example.invalid');
  // Git's detached auto-maintenance can still be writing objects/pack when cleanup removes the fixture.
  await setup('config', 'maintenance.auto', 'false'); await setup('config', 'gc.auto', '0');
  await setup('init', '--bare', '-q', remote);
  await setup('remote', 'add', 'origin', remote);
  await writeFile(path.join(repo, 'a.txt'), 'base a\n'); await writeFile(path.join(repo, 'b.txt'), 'base b\n');
  await setup('add', '.'); await setup('commit', '-qm', 'base');
  const baseHead = await git('rev-parse', 'HEAD');
  const config = { ...structuredClone(DEFAULT_CONFIG), events, branches: ['main', 'master'], backgroundPreparation: false };
  await saveConfig(config, env);
  for (const event of events) {
    const script = `#!/bin/sh\nprintf '%s\\n' ${quote(event)} >> "$SPHINX_TEST_STATE/old-hooks"\n${event === 'pre-push' ? 'cat > "$SPHINX_TEST_STATE/original-input"\n' : ''}${oldHook}\n`;
    await writeFile(path.join(repo, '.git', 'hooks', event), script, { mode: 0o755 });
  }
  const validator = path.join(base, 'validate-index.mjs');
  await writeFile(validator, `import { revalidateSnapshot } from ${JSON.stringify(modulePath('git'))};
import { readFile } from 'node:fs/promises';
const {snapshot,config}=JSON.parse(await readFile(process.argv[2],'utf8'));
process.stdout.write(JSON.stringify({valid:await revalidateSnapshot(snapshot,config),index:process.env.GIT_INDEX_FILE??null}));
`);
  const launcher = path.join(base, 'hook-launcher.mjs');
  await writeFile(launcher, `import { dispatchHook } from ${JSON.stringify(modulePath('install'))};
import { runGitGate } from ${JSON.stringify(modulePath('git-gate'))};
import { readFile,writeFile,rename,rm,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
if(process.argv[2]!=='hook')process.exit(0);
const state=process.env.SPHINX_TEST_STATE,controller=new AbortController();
process.on('SIGINT',()=>controller.abort(new Error('fixture interrupted')));
process.on('SIGTERM',()=>controller.abort(new Error('fixture terminated')));
const publish=async(file,data)=>{await writeFile(file+'.tmp',data);await rename(file+'.tmp',file);};
const read=async(file,fallback)=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const event=process.argv[4];let input='';
if(event==='pre-push')for await(const chunk of process.stdin)input+=chunk;
// Numbered across Git runs, so a retry's questionnaire is ready-N for the next N.
const sessions=new Map();let count=(await readdir(state)).filter(name=>name.startsWith('ready-')&&name.endsWith('.json')).length;
const has=async file=>!!(await read(join(state,file),null));
const store={
  approved:async(snapshot)=>await has(snapshot.id+'.approval')&&!(await has(snapshot.id+'.held')),
  ensure:async(snapshot,config)=>{const session={id:snapshot.id,snapshot,config,route:{tier:'small'},held:await read(join(state,snapshot.id+'.held'),undefined),noQuestionReason:await read(join(state,snapshot.id+'.reason'),undefined)};sessions.set(snapshot.id,session);return session;},
  hold:async(id)=>{if(!(await has(id+'.approval')))return false;await publish(join(state,id+'.held'),JSON.stringify({at:Date.now()}));return true;},
  confirm:async(id)=>{await rm(join(state,id+'.held'),{force:true});return true;},
};
const present=async({request,env,signal})=>{
  const session=sessions.get(request.id),number=count++,file=join(state,'ready-'+number+'.json');
  const payload={request,snapshot:session.snapshot,config:session.config,held:!!session.held,pid:process.pid,index:env.GIT_INDEX_FILE??null};
  const candidate=join(state,'candidate-'+number+'.json');await writeFile(candidate,JSON.stringify(payload));
  if(event==='pre-commit'){
    const result=await promisify(execFile)(process.execPath,[${JSON.stringify(validator)},candidate],{cwd:request.repoRoot,env});
    payload.externalValidation=JSON.parse(result.stdout);
  }
  await publish(file,JSON.stringify(payload));
  // Each decision answers one questionnaire; a retry waits for a new one.
  while(true){signal?.throwIfAborted();const decision=await read(join(state,request.id+'.decision'),null);if(decision){await rm(join(state,request.id+'.decision'));return decision;}await delay(10,undefined,{signal});}
};
try{process.exitCode=await dispatchHook({event,args:process.argv.slice(5),input,gate:args=>runGitGate({...args,store,present,signal:controller.signal})});}
catch(error){process.stderr.write(error.message+'\\n');process.exitCode=1;}
`);
  await install({ cwd: repo, env, cliPath: launcher, agents: 'none', repo: true });
  const start = (...args) => {
    const child = spawn('git', args, { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
    return child;
  };
  const ready = async (child, number = 0) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { return await json(path.join(state, `ready-${number}.json`)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Git exited before questionnaire: ${JSON.stringify(await child.finished)}`);
      await delay(10);
    }
    assert.fail('Git did not reach the fixture questionnaire');
  };
  const release = async (checkpoint, { status = 'passed', approve = status === 'passed' } = {}) => {
    if (approve) await publish(path.join(state, `${checkpoint.request.id}.approval`), JSON.stringify({ id: checkpoint.request.id }));
    await publish(path.join(state, `${checkpoint.request.id}.decision`), JSON.stringify({ status }));
  };
  const pending = async () => readdir(path.join(env.SPHINX_HOME, 'presentations')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const oldCalls = async () => (await readFile(path.join(state, 'old-hooks'), 'utf8')).trim().split('\n');
  const held = async checkpoint => readFile(path.join(state, `${checkpoint.request.id}.held`)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  return { base, repo, remote, env, state, config, baseHead, git, bare, setup, start, ready, release, pending, oldCalls, held };
}

test('the original push waits, preserves hook input, and continues exactly once after approval', { timeout: 15000 }, async t => {
  const f = await fixture(t), child = f.start('push', 'origin', 'main');
  const checkpoint = await f.ready(child);
  assert.equal(child.exitCode, null); assert.equal(checkpoint.request.delivery, 'hook');
  assert.equal(checkpoint.snapshot.head, f.baseHead);
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  assert.deepEqual(await f.oldCalls(), ['pre-push']);
  assert.match(await readFile(path.join(f.state, 'original-input'), 'utf8'), new RegExp(`refs/heads/main ${f.baseHead} refs/heads/main 0+`));
  // Working-tree edits are outside the exact commit this original push selected.
  await writeFile(path.join(f.repo, 'a.txt'), 'unstaged while answering\n');
  await f.release(checkpoint);
  const result = await child.finished;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), f.baseHead);
  assert.deepEqual(await f.oldCalls(), ['pre-push']);
  assert.deepEqual(await f.pending(), []);
});

test('stopping after a pass holds it: the same push then asks only whether to continue, and goes through on Continue', { timeout: 20000 }, async t => {
  const f = await fixture(t), child = f.start('push', 'origin', 'main');
  const checkpoint = await f.ready(child);
  assert.equal(checkpoint.held, false);
  await f.release(checkpoint, { status: 'stopped', approve: true });
  const result = await child.finished;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Sphinx: you stopped this push after passing, so it did not go through\. Your pass is saved; the next push of this change asks only whether to continue\. A coding agent must not retry it unless you ask\./);
  assert.doesNotMatch(result.stderr, /without questions/, 'a coding agent reading Git output is not told a retry would go through');
  assert.doesNotMatch(result.stderr, /before you chose/, 'the human did choose');
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  assert.equal(await f.held(checkpoint), true);
  // The retry a coding agent might make waits for the human instead of going through.
  const again = f.start('push', 'origin', 'main'), asked = await f.ready(again, 1);
  assert.equal(asked.request.id, checkpoint.request.id); assert.equal(asked.held, true);
  assert.equal(again.exitCode, null); await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  await f.release(asked);
  const retried = await again.finished;
  assert.equal(retried.code, 0, retried.stderr);
  assert.match(retried.stderr, /Sphinx: you passed the understanding check for refs\/heads\/main earlier, but that push did not go through\.\n/);
  assert.match(retried.stderr, /Sphinx: Git is waiting for you to choose in the local Sphinx questionnaire whether this push should continue\. Do not start another copy of this push\./);
  assert.doesNotMatch(retried.stderr, /understanding check needed|waiting for your answers|understanding check complete/);
  assert.match(retried.stderr, /Sphinx: continuing this Git operation\.\n/, 'nothing was checked again');
  assert.equal(await f.held(checkpoint), false, 'Continue clears the hold');
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), f.baseHead);
  assert.deepEqual(await f.oldCalls(), ['pre-push', 'pre-push']);
  assert.deepEqual(await f.pending(), []);
});

test('a check that ends after its pass was saved, without Continue, says so and holds the pass like Stop', { timeout: 20000 }, async t => {
  const f = await fixture(t), child = f.start('push', 'origin', 'main');
  const checkpoint = await f.ready(child);
  await f.release(checkpoint, { status: 'pending', approve: true });
  const result = await child.finished;
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Sphinx: you passed, but this push stopped before you chose to continue, so it did not go through\. Your pass is saved; the next push of this change asks only whether to continue\. A coding agent must not retry it unless you ask\./);
  assert.doesNotMatch(result.stderr, /incomplete/);
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  assert.equal(await f.held(checkpoint), true);
  // Stop at the retry keeps the hold; a cut-short retry says the pass is saved, not that the check is incomplete.
  const again = f.start('push', 'origin', 'main');
  await f.release(await f.ready(again, 1), { status: 'stopped' });
  assert.notEqual((await again.finished).code, 0);
  assert.equal(await f.held(checkpoint), true);
  const third = f.start('push', 'origin', 'main');
  await f.release(await f.ready(third, 2), { status: 'pending' });
  assert.match((await third.finished).stderr, /you passed, but this push stopped before you chose to continue/);
  assert.equal(await f.held(checkpoint), true);
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
});

test('Git cancelled after the pass was saved also holds it, so a retry still asks', { timeout: 20000 }, async t => {
  const f = await fixture(t), child = f.start('push', 'origin', 'main');
  const checkpoint = await f.ready(child);
  await publish(path.join(f.state, `${checkpoint.request.id}.approval`), JSON.stringify({ id: checkpoint.request.id }));
  process.kill(checkpoint.pid, 'SIGINT');
  const result = await child.finished;
  assert.notEqual(result.code, 0); await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  assert.equal(await f.held(checkpoint), true, 'the gate holds the pass on its way out, not only on Stop');
  assert.match(result.stderr, /Sphinx: you passed, but this push stopped before you chose to continue, so it did not go through\. Your pass is saved; the next push of this change asks only whether to continue\. A coding agent must not retry it unless you ask\.\n/, 'a coding agent whose shell timed out reads the same as after the deadline');
  const again = f.start('push', 'origin', 'main'), asked = await f.ready(again, 1);
  assert.equal(asked.request.id, checkpoint.request.id); assert.equal(asked.held, true);
  await f.release(asked);
  assert.equal((await again.finished).code, 0);
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), f.baseHead);
});

test('pause, cancellation, and a false terminal success cannot authorize a push or leave forms queued', { timeout: 30000 }, async t => {
  for (const mode of ['pause', 'cancel', 'false-success']) await t.test(mode, async t => {
    const f = await fixture(t), child = f.start('push', 'origin', 'main');
    const checkpoint = await f.ready(child);
    if (mode === 'cancel') process.kill(checkpoint.pid, 'SIGINT');
    else await f.release(checkpoint, { status: mode === 'pause' ? 'pending' : 'passed', approve: false });
    const result = await child.finished;
    assert.notEqual(result.code, 0); await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
    assert.deepEqual(await f.pending(), []);
    assert.deepEqual(await f.oldCalls(), ['pre-push']);
    assert.equal(await f.held(checkpoint), false, 'with no saved pass there is nothing to hold');
    assert.doesNotMatch(result.stderr, /you passed/);
  });
});

test('source and effective policy changes while answering invalidate the original push', { timeout: 30000 }, async t => {
  for (const mode of ['source', 'policy', 'context']) await t.test(mode, async t => {
    const f = await fixture(t), child = f.start('push', 'origin', 'main');
    const checkpoint = await f.ready(child);
    if (mode === 'source') { await writeFile(path.join(f.repo, 'a.txt'), 'new commit\n'); await f.setup('add', 'a.txt'); await f.setup('commit', '-qm', 'new while waiting'); }
    else if (mode === 'policy') await writeFile(path.join(f.repo, '.sphinxconfig'), JSON.stringify({ level: 'thorough' }));
    else await writeFile(path.join(f.repo, '.sphinxcontext.md'), 'Updated project expectations.\n');
    await f.release(checkpoint);
    const result = await child.finished;
    assert.notEqual(result.code, 0); assert.match(result.stderr, /changed while Git was waiting/);
    assert.doesNotMatch(result.stderr, /you passed/, 'that pass is for the old change');
    await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
    assert.deepEqual(await f.pending(), []);
  });
});

test('a settings change while Git waits releases the push promptly with the next step', { timeout: 30000 }, async t => {
  for (const mode of ['global', 'repository']) await t.test(mode, async t => {
    const f = await fixture(t), child = f.start('push', 'origin', 'main');
    await f.ready(child);
    if (mode === 'global') await saveConfig({ ...f.config, level: 'thorough' }, f.env);
    else await writeFile(path.join(f.repo, '.sphinxconfig'), JSON.stringify({ level: 'thorough' }));
    const changed = Date.now(), result = await child.finished;
    assert.ok(Date.now() - changed < 10000, 'the waiting push must not outlive a discarded check');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Sphinx settings changed while Git was waiting, so this check was discarded\. This Git operation was stopped; run git push again/);
    await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
    assert.deepEqual(await f.pending(), []);
  });
});

test('a reviewer model or limit change while Git waits keeps the check, and the push goes through', { timeout: 30000 }, async t => {
  const f = await fixture(t), child = f.start('push', 'origin', 'main');
  const checkpoint = await f.ready(child);
  const sonnet = { provider: 'claude', model: 'sonnet' };
  await saveConfig({ ...f.config, maxOutputTokens: 16384, models: { small: sonnet, medium: sonnet, large: sonnet } }, f.env);
  await delay(1500); // longer than the gate's settings watcher interval
  assert.equal(child.exitCode, null, 'still waiting for the questionnaire');
  await f.release(checkpoint);
  const result = await child.finished;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), f.baseHead);
});

test('a push of HEAD drops the working context of the branch it names once Git continues', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  // What background curation keeps for the branch; git push origin HEAD names its source HEAD.
  const brief = contextFile(await realpath(f.repo), 'refs/heads/main', f.env);
  await writeJson(brief, { version: 1, sourceRef: 'refs/heads/main', overview: 'Unpushed work on main.', items: [] });
  const child = f.start('push', 'origin', 'HEAD'), checkpoint = await f.ready(child);
  assert.equal(checkpoint.snapshot.sourceRef, 'refs/heads/main');
  await f.release(checkpoint);
  const result = await child.finished;
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(readFile(brief), { code: 'ENOENT' });
});

test('one push waits for every protected destination before any ref is sent', { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.setup('branch', 'master');
  const child = f.start('push', 'origin', 'main', 'master');
  const first = await f.ready(child); await f.release(first);
  const second = await f.ready(child, 1);
  assert.notEqual(first.request.id, second.request.id);
  assert.deepEqual([first.request.more, second.request.more], [true, undefined], 'only the last destination asks whether to continue');
  assert.deepEqual(new Set([first.snapshot.target.ref, second.snapshot.target.ref]), new Set(['refs/heads/main', 'refs/heads/master']));
  assert.equal(child.exitCode, null);
  assert.equal(await f.bare('for-each-ref', '--format=%(refname)', 'refs/heads'), '');
  await f.release(second);
  const result = await child.finished; assert.equal(result.code, 0, result.stderr);
  assert.equal(await f.bare('rev-parse', 'main'), f.baseHead); assert.equal(await f.bare('rev-parse', 'master'), f.baseHead);
  assert.deepEqual(await f.oldCalls(), ['pre-push']); assert.deepEqual(await f.pending(), []);
  assert.deepEqual([await f.held(first), await f.held(second)], [false, false]);
});

test('Stop at the last destination holds every pass in the push, so pushing only the first destination still asks', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.setup('branch', 'master');
  const child = f.start('push', 'origin', 'main', 'master');
  const first = await f.ready(child); await f.release(first);
  const second = await f.ready(child, 1); await f.release(second, { status: 'stopped', approve: true });
  assert.notEqual((await child.finished).code, 0);
  assert.equal(await f.bare('for-each-ref', '--format=%(refname)', 'refs/heads'), '');
  assert.deepEqual([await f.held(first), await f.held(second)], [true, true], 'the destination that passed first is held too');
  const [main, master] = first.snapshot.target.ref === 'refs/heads/main' ? [first, second] : [second, first];
  const retry = f.start('push', 'origin', 'main'), asked = await f.ready(retry, 2);
  assert.equal(asked.request.id, main.request.id); assert.equal(asked.held, true);
  assert.equal(asked.request.more, undefined, 'as the only destination, it asks whether to continue');
  await f.release(asked);
  const result = await retry.finished; assert.equal(result.code, 0, result.stderr);
  assert.equal(await f.bare('rev-parse', 'main'), f.baseHead); await assert.rejects(f.bare('rev-parse', '--verify', 'master'));
  assert.deepEqual([await f.held(main), await f.held(master)], [false, true], 'master stays held until a push of it continues');
});

test('a retried push confirms its earlier destination only once the last one continues, so pushing that one alone meanwhile still asks', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.setup('branch', 'master');
  const child = f.start('push', 'origin', 'main', 'master');
  const first = await f.ready(child); await f.release(first);
  const second = await f.ready(child, 1); await f.release(second, { status: 'stopped', approve: true });
  assert.notEqual((await child.finished).code, 0);
  const again = f.start('push', 'origin', 'main', 'master');
  const earlier = await f.ready(again, 2); assert.equal(earlier.request.id, first.request.id); assert.equal(earlier.request.more, true);
  await f.release(earlier);
  const last = await f.ready(again, 3); assert.equal(last.request.id, second.request.id);
  assert.deepEqual([await f.held(first), await f.held(second)], [true, true], 'moving on past an earlier destination is no Continue');
  const alone = f.start('push', 'origin', 'main'), asked = await f.ready(alone, 4);
  assert.equal(asked.request.id, first.request.id); assert.equal(asked.held, true);
  await f.release(asked, { status: 'stopped' }); assert.notEqual((await alone.finished).code, 0);
  await assert.rejects(f.bare('rev-parse', '--verify', 'main'));
  await f.release(last);
  const result = await again.finished; assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([await f.held(first), await f.held(second)], [false, false], 'Continue at the last destination releases the whole push');
  assert.equal(await f.bare('rev-parse', 'main'), f.baseHead); assert.equal(await f.bare('rev-parse', 'master'), f.baseHead);
});

test('Git cancelled partway through a push holds what passed, and does not say only the choice is left', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.setup('branch', 'master');
  const child = f.start('push', 'origin', 'main', 'master');
  const first = await f.ready(child); await f.release(first);
  const second = await f.ready(child, 1);
  process.kill(second.pid, 'SIGINT');
  const result = await child.finished;
  assert.notEqual(result.code, 0); await assert.rejects(f.bare('rev-parse', '--verify', 'main'));
  assert.deepEqual([await f.held(first), await f.held(second)], [true, false]);
  assert.doesNotMatch(result.stderr, /you passed/, 'the second destination still needs its questions');
});

test('a held pass that needed no questions is named that way in Git output', { timeout: 20000 }, async t => {
  const f = await fixture(t), child = f.start('push', 'origin', 'main');
  const checkpoint = await f.ready(child);
  await publish(path.join(f.state, `${checkpoint.request.id}.reason`), JSON.stringify('Only renames a local variable.'));
  await f.release(checkpoint, { status: 'stopped', approve: true });
  assert.notEqual((await child.finished).code, 0);
  const again = f.start('push', 'origin', 'main');
  await f.release(await f.ready(again, 1));
  const result = await again.finished; assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Sphinx: refs\/heads\/main needed no questions earlier, but that push did not go through\.\n/);
  assert.doesNotMatch(result.stderr, /you passed the understanding check/);
});

test('a push with a held destination and a new one still waits for answers, and says the check is complete', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.setup('branch', 'master');
  const child = f.start('push', 'origin', 'main'), main = await f.ready(child);
  await f.release(main, { status: 'stopped', approve: true }); assert.notEqual((await child.finished).code, 0);
  const both = f.start('push', 'origin', 'main', 'master');
  await f.release(await f.ready(both, 1)); await f.release(await f.ready(both, 2));
  const result = await both.finished; assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Sphinx: you passed the understanding check for refs\/heads\/main earlier, but that push did not go through\.\nSphinx: understanding check needed for refs\/heads\/master \(small change\)\./);
  assert.match(result.stderr, /Sphinx: Git is waiting for your answers in the local Sphinx questionnaire\. After you pass, confirm whether this push should continue\./, 'master still has questions');
  assert.match(result.stderr, /\nSphinx: understanding check complete\. Continuing this Git operation\.\n/);
  assert.equal(await f.held(main), false);
});

test('a destination that passed is held again when a later destination ends the push before Continue', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.setup('branch', 'master');
  const child = f.start('push', 'origin', 'main', 'master');
  const first = await f.ready(child); await f.release(first);
  // The second destination is cut short before any pass: nothing of it is held, but the first one is.
  const second = await f.ready(child, 1); await f.release(second, { status: 'pending', approve: false });
  const result = await child.finished;
  assert.notEqual(result.code, 0); assert.match(result.stderr, /understanding check is incomplete/);
  assert.deepEqual([await f.held(first), await f.held(second)], [true, false]);
});

test('an existing hook rejection prevents the questionnaire and original push', { timeout: 15000 }, async t => {
  const f = await fixture(t, { oldHook: 'exit 19' });
  const result = await f.start('push', 'origin', 'main').finished;
  assert.notEqual(result.code, 0); assert.deepEqual(await f.oldCalls(), ['pre-push']);
  await assert.rejects(readFile(path.join(f.state, 'ready-0.json')), { code: 'ENOENT' });
  await assert.rejects(f.bare('rev-parse', '--verify', 'main'));
});

test('a remote advance while the original force push waits is rejected by Git instead of replayed', { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.setup('push', '-q', 'origin', 'main');
  await writeFile(path.join(f.repo, 'a.txt'), 'local replacement\n'); await f.setup('add', '.'); await f.setup('commit', '-qm', 'local replacement');
  const child = f.start('push', '--force', 'origin', 'main');
  const checkpoint = await f.ready(child);
  // An independent destination update happens after its old oid was advertised.
  const newer = (await exec('git', ['--git-dir', f.remote, 'commit-tree', `${f.baseHead}^{tree}`, '-p', f.baseHead, '-m', 'remote advance'], { env: { ...f.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })).stdout.trim();
  await f.bare('update-ref', 'refs/heads/main', newer, f.baseHead);
  await f.release(checkpoint);
  const result = await child.finished;
  assert.notEqual(result.code, 0); assert.equal(await f.bare('rev-parse', 'main'), newer);
  assert.deepEqual(await f.oldCalls(), ['pre-push']);
});

test('commit -a and --only continue with the exact temporary index passed into the human process', { timeout: 30000 }, async t => {
  for (const mode of ['all', 'only']) await t.test(mode, async t => {
    const f = await fixture(t, { events: ['pre-commit'] });
    await writeFile(path.join(f.repo, 'a.txt'), 'changed a\n'); await writeFile(path.join(f.repo, 'b.txt'), 'changed b\n');
    if (mode === 'only') await f.setup('add', 'b.txt');
    const child = f.start('commit', ...(mode === 'all' ? ['-a'] : ['--only', 'a.txt']), '-m', 'original commit');
    const checkpoint = await f.ready(child);
    assert.equal(child.exitCode, null); assert.equal(await f.git('rev-parse', 'HEAD'), f.baseHead);
    assert.equal(path.isAbsolute(checkpoint.index), true);
    assert.equal(checkpoint.externalValidation.index, checkpoint.index);
    assert.equal(checkpoint.externalValidation.valid, true, 'The separate human process validates Git\'s temporary index');
    assert.deepEqual(checkpoint.snapshot.files, mode === 'all' ? ['a.txt', 'b.txt'] : ['a.txt']);
    await f.release(checkpoint);
    const result = await child.finished; assert.equal(result.code, 0, result.stderr);
    assert.equal(await f.git('show', 'HEAD:a.txt'), 'changed a');
    assert.equal(await f.git('show', 'HEAD:b.txt'), mode === 'all' ? 'changed b' : 'base b');
    if (mode === 'only') assert.equal(await f.git('show', ':b.txt'), 'changed b');
    assert.deepEqual(await f.oldCalls(), ['pre-commit']); assert.deepEqual(await f.pending(), []);
  });
});

test('staging another change while a commit waits invalidates its approval; an unstaged edit does not', { timeout: 30000 }, async t => {
  for (const staged of [false, true]) await t.test(staged ? 'staged' : 'unstaged', async t => {
    const f = await fixture(t, { events: ['pre-commit'] });
    await writeFile(path.join(f.repo, 'a.txt'), 'approved staged content\n'); await f.setup('add', 'a.txt');
    const child = f.start('commit', '-m', 'original commit');
    const checkpoint = await f.ready(child);
    await writeFile(path.join(f.repo, 'a.txt'), 'changed while answering\n');
    if (staged) await f.setup('add', 'a.txt');
    await f.release(checkpoint);
    const result = await child.finished;
    if (staged) { assert.notEqual(result.code, 0); assert.equal(await f.git('rev-parse', 'HEAD'), f.baseHead); }
    else { assert.equal(result.code, 0, result.stderr); assert.equal(await f.git('show', 'HEAD:a.txt'), 'approved staged content'); }
    assert.deepEqual(await f.pending(), []);
  });
});

test('Skip this time lets the same push continue without a receipt', { timeout: 15000 }, async t => {
  const f = await fixture(t), child = f.start('push', 'origin', 'main');
  const checkpoint = await f.ready(child);
  await f.release(checkpoint, { status: 'skipped', approve: false });
  const result = await child.finished;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /skipped for this push/);
  assert.doesNotMatch(result.stderr, /understanding check complete/, 'A skip is not reported as a completed check');
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), f.baseHead);
});

test('yolo mode for a repository skips the questionnaire and logs the override; toggling again restores the gate', { timeout: 20000 }, async t => {
  const f = await fixture(t), repoRoot = await realpath(f.repo);
  assert.equal((await toggleYolo({ repoRoot, reason: 'hotfix', env: f.env })).enabled, true);
  const result = await f.start('push', 'origin', 'main').finished;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /yolo mode is on for this repository/);
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), f.baseHead);
  const [entry] = await recentOverrides({ repoRoot, env: f.env });
  assert.equal(entry.kind, 'yolo'); assert.equal(entry.reason, 'hotfix'); assert.equal(entry.target, 'refs/heads/main');
  assert.equal(await readFile(path.join(f.state, 'ready-0.json')).catch(() => null), null, 'Yolo never prepares or queues a check');
  assert.equal((await toggleYolo({ repoRoot, env: f.env })).enabled, false);
  await writeFile(path.join(f.repo, 'a.txt'), 'changed\n'); await f.setup('commit', '-qam', 'next');
  const child = f.start('push', 'origin', 'main');
  await f.ready(child);
  assert.equal(child.exitCode, null, 'The gate is back on');
});

test('global yolo applies to repositories without their own setting', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await toggleYolo({ repoRoot: null, env: f.env });
  const result = await f.start('push', 'origin', 'main').finished;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /yolo mode is on globally/);
});

test('turning repository yolo off under global yolo restores that repository gate', { timeout: 20000 }, async t => {
  const f = await fixture(t), repoRoot = await realpath(f.repo);
  await toggleYolo({ repoRoot: null, env: f.env });
  assert.equal((await toggleYolo({ repoRoot, env: f.env })).enabled, false, 'The toggle flips the effective state from global ON');
  assert.equal(await yoloStatus(repoRoot, f.env), null, 'An explicit repository OFF shadows global yolo');
  assert.equal((await yoloStatus(null, f.env)).scope, 'global');
  await writeFile(path.join(f.repo, 'a.txt'), 'changed\n'); await f.setup('commit', '-qam', 'next');
  const child = f.start('push', 'origin', 'main');
  await f.ready(child);
  assert.equal(child.exitCode, null, 'The gate is back on despite global yolo');
});
