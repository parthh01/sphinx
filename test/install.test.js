import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { install, uninstall, doctor, dispatchHook, detectAgents } from '../src/install.js';
import { getPaths } from '../src/config.js';
import { lifecycleHome } from '../src/lifecycle-integrations.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "sphinx install ' "));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const repo = path.join(base, 'repository');
  await mkdir(home); await mkdir(repo);
  const env = { ...process.env, HOME: home, SPHINX_USER_HOME: home, SPHINX_HOME: path.join(home, '.sphinx'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'SPHINX_INSTALL_ID', 'SPHINX_EVALUATOR', 'SPHINX_HOOK_DEPTH']) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  git('init', '-q');
  const cliPath = path.join(base, "sphinx cli ' entry.mjs");
  const modulePath = fileURLToPath(new URL('../src/install.js', import.meta.url));
  await writeFile(cliPath, `import { dispatchHook } from ${JSON.stringify(modulePath)};\nlet input = ''; for await (const chunk of process.stdin) input += chunk;\nprocess.exitCode = await dispatchHook({ event: process.argv[4], args: process.argv.slice(5), input, gate: async () => Number(process.env.SPHINX_TEST_GATE || 0) });\n`);
  const options = { cwd: repo, env, cliPath, agents: 'none' };
  const paths = getPaths(env);
  return { base, home, repo, env, git, cliPath, options, paths };
}

async function executable(file, content) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content, { mode: 0o755 }); await chmod(file, 0o755); }
const json = async file => JSON.parse(await readFile(file, 'utf8'));

test('Cursor, OpenCode and Pi install together, preserve user settings, and uninstall idempotently', async t => {
  const f = await fixture(t);
  const cursorHome = lifecycleHome('cursor', f.paths, f.env), openCodeHome = lifecycleHome('opencode', f.paths, f.env);
  await mkdir(cursorHome, { recursive: true }); await mkdir(openCodeHome, { recursive: true });
  const cursorFile = path.join(cursorHome, 'hooks.json'), openCodeConfig = path.join(openCodeHome, 'opencode.jsonc');
  const existing = { version: 1, hooks: { sessionStart: [{ command: 'my-existing-hook' }], postToolUse: [] }, custom: true };
  await writeFile(cursorFile, JSON.stringify(existing));
  const jsonc = '// Keep comments\n{"model":"my/model", "plugin":["my-plugin"]}\n';
  await writeFile(openCodeConfig, jsonc);
  const result = await install({ ...f.options, agents: 'cursor,opencode,pi' });
  assert.deepEqual(result.agents, ['cursor', 'opencode', 'pi']);
  assert.deepEqual(result.warnings, []);
  assert.match(result.messages.join('\n'), /Pi extension installed with native/);
  await install({ ...f.options, agents: 'cursor,opencode,pi' });
  const cursor = await json(cursorFile);
  assert.equal(cursor.hooks.sessionStart.length, 2);
  assert.equal(cursor.hooks.postToolUse.length, 1);
  assert.equal(cursor.hooks.postToolUseFailure[0].matcher, '^Shell$');
  assert.equal(await readFile(openCodeConfig, 'utf8'), jsonc);
  assert.equal((await doctor(f.options)).checks.every(check => check.ok), true);
  const manifest = await json(f.paths.install);
  assert.match(await readFile(manifest.agents.opencode.file, 'utf8'), /registerOpenCodeIntegration/);
  assert.match(await readFile(manifest.agents.pi.file, 'utf8'), /registerPiIntegration/);
  await uninstall(f.options); await uninstall(f.options);
  assert.deepEqual(await json(cursorFile), existing);
  assert.equal(await readFile(openCodeConfig, 'utf8'), jsonc);
  await assert.rejects(readFile(manifest.agents.opencode.file), { code: 'ENOENT' });
  await assert.rejects(readFile(manifest.agents.pi.file), { code: 'ENOENT' });
});

test('new Cursor settings disappear on uninstall and auto detection finds all supported agent homes', async t => {
  const f = await fixture(t);
  for (const directory of [f.paths.codexHome, f.paths.claudeHome, lifecycleHome('cursor', f.paths, f.env), lifecycleHome('opencode', f.paths, f.env), path.join(f.home, '.pi', 'agent')]) await mkdir(directory, { recursive: true });
  assert.deepEqual(await detectAgents(f.options), ['codex', 'claude', 'pi', 'cursor', 'opencode']);
  await assert.rejects(readFile(f.paths.install), { code: 'ENOENT' });
  assert.throws(() => f.git('config', '--global', '--get', 'core.hooksPath'));
  await install({ ...f.options, agents: 'auto' });
  const manifest = await json(f.paths.install);
  assert.deepEqual(Object.keys(manifest.agents).sort(), ['claude', 'codex', 'cursor', 'opencode', 'pi']);
  await uninstall(f.options);
  await assert.rejects(readFile(path.join(f.home, '.cursor', 'hooks.json')), { code: 'ENOENT' });
});

test('edited Cursor hooks and OpenCode plugins are preserved and diagnosed', async t => {
  const f = await fixture(t);
  await install({ ...f.options, agents: 'cursor,opencode' });
  const manifest = await json(f.paths.install), cursorFile = manifest.agents.cursor.file, pluginFile = manifest.agents.opencode.file;
  const document = await json(cursorFile);
  document.hooks.postToolUse[0].timeout = 99;
  document.unrelated = 'keep';
  await writeFile(cursorFile, JSON.stringify(document));
  await writeFile(pluginFile, '// User replacement\n');
  await assert.rejects(install({ ...f.options, agents: 'cursor' }), /edited cursor/);
  await assert.rejects(install({ ...f.options, agents: 'opencode' }), /edited OpenCode/);
  const checks = (await doctor(f.options)).checks;
  assert.equal(checks.find(check => check.name === 'cursor integration').ok, false);
  assert.equal(checks.find(check => check.name === 'opencode integration').ok, false);
  const result = await uninstall(f.options);
  assert.ok(result.warnings.some(warning => warning.includes('Cursor')));
  assert.ok(result.warnings.some(warning => warning.includes('OpenCode')));
  assert.equal((await json(cursorFile)).hooks.postToolUse[0].timeout, 99);
  assert.equal((await json(cursorFile)).unrelated, 'keep');
  assert.equal(await readFile(pluginFile, 'utf8'), '// User replacement\n');
});

test('invalid Cursor settings or conflicting OpenCode plugin fail before any Git or agent changes', async t => {
  const f = await fixture(t);
  const cursorHome = lifecycleHome('cursor', f.paths, f.env), pluginDirectory = path.join(lifecycleHome('opencode', f.paths, f.env), 'plugins');
  await mkdir(cursorHome, { recursive: true }); await mkdir(pluginDirectory, { recursive: true });
  const cursorFile = path.join(cursorHome, 'hooks.json');
  await writeFile(cursorFile, 'secret-sentinel-invalid-json');
  await assert.rejects(install({ ...f.options, agents: 'pi,cursor' }), error => /invalid JSON/.test(error.message) && !error.message.includes('secret-sentinel'));
  assert.throws(() => f.git('config', '--global', '--get', 'core.hooksPath'));
  await assert.rejects(readFile(path.join(f.home, '.pi', 'agent', 'extensions', 'sphinx.js')), { code: 'ENOENT' });
  await rm(cursorFile); await writeFile(path.join(pluginDirectory, 'sphinx.js'), '// unrelated plugin');
  await assert.rejects(install({ ...f.options, agents: 'cursor,opencode' }), /existing or edited OpenCode/);
  await assert.rejects(readFile(cursorFile), { code: 'ENOENT' });
  assert.throws(() => f.git('config', '--global', '--get', 'core.hooksPath'));
});

test('Cursor and OpenCode refuse symlinked integration paths and isolated homes ignore ambient paths', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside'); await mkdir(outside);
  const cursorHome = lifecycleHome('cursor', f.paths, f.env);
  await symlink(outside, cursorHome);
  await assert.rejects(install({ ...f.options, agents: 'cursor' }), /symlinked/);
  await rm(cursorHome);
  const openCodeHome = lifecycleHome('opencode', f.paths, f.env);
  await mkdir(openCodeHome, { recursive: true }); await symlink(outside, path.join(openCodeHome, 'plugins'));
  await assert.rejects(install({ ...f.options, agents: 'opencode' }), /symlinked/);
  assert.equal(lifecycleHome('opencode', f.paths, { ...f.env, XDG_CONFIG_HOME: outside, OPENCODE_CONFIG_DIR: outside }), openCodeHome);
});

test('global installation chains custom hooks, preserves agent settings, and reverses idempotently', async t => {
  const f = await fixture(t);
  const oldHooks = path.join(f.base, 'old hooks');
  const output = path.join(f.base, 'chained');
  await executable(path.join(oldHooks, 'post-checkout'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$SPHINX_TEST_OUTPUT"\nexit 7\n');
  await executable(path.join(oldHooks, 'future-custom-hook'), '#!/bin/sh\nexit 0\n');
  f.git('config', '--global', 'core.hooksPath', oldHooks);
  const codexFile = path.join(f.paths.codexHome, 'hooks.json');
  const claudeFile = path.join(f.paths.claudeHome, 'settings.json');
  await mkdir(f.paths.codexHome, { recursive: true }); await mkdir(f.paths.claudeHome, { recursive: true });
  const existing = { description: 'Keep me', hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'other-hook' }] }], Stop: [] }, unrelated: { enabled: true } };
  await writeFile(codexFile, JSON.stringify(existing));
  await writeFile(claudeFile, JSON.stringify({ model: 'user-model', permissions: { deny: ['Bash(rm *)'] } }));
  const result = await install({ ...f.options, agents: 'codex,claude' });
  assert.deepEqual(result.agents, ['codex', 'claude']);
  assert.deepEqual(result.warnings, []);
  await install({ ...f.options, agents: 'codex,claude' });
  assert.equal((await json(codexFile)).hooks.SessionStart.length, 2);
  assert.equal((await json(claudeFile)).model, 'user-model');
  const hookDir = f.git('config', '--global', '--get', 'core.hooksPath');
  await readFile(path.join(hookDir, 'future-custom-hook'));
  await assert.rejects(async () => execFileSync(path.join(hookDir, 'post-checkout'), ['a b', "c'd"], { cwd: f.repo, env: { ...f.env, SPHINX_TEST_OUTPUT: output } }), error => error.status === 7);
  assert.equal(await readFile(output, 'utf8'), "a b\nc'd\n");
  await uninstall(f.options);
  assert.equal(f.git('config', '--global', '--get', 'core.hooksPath'), oldHooks);
  assert.deepEqual(await json(codexFile), existing);
  assert.equal((await json(claudeFile)).model, 'user-model');
  await uninstall(f.options);
  assert.equal(f.git('config', '--global', '--get', 'core.hooksPath'), oldHooks);
});

test('gated hooks preserve stdin and arguments and do not bypass an original rejection', async t => {
  const f = await fixture(t);
  const output = path.join(f.base, 'stdin');
  await executable(path.join(f.repo, '.git/hooks/pre-push'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$SPHINX_TEST_OUTPUT"\ncat >> "$SPHINX_TEST_OUTPUT"\nexit 19\n');
  await install(f.options);
  let calls = 0;
  assert.equal(await dispatchHook({ event: 'pre-push', args: ['origin', 'url with spaces'], input: 'refs/heads/main 123 refs/heads/main 456\n', cwd: f.repo, env: { ...f.env, SPHINX_TEST_OUTPUT: output }, gate: async () => { calls++; return 0; } }), 19);
  assert.equal(calls, 0);
  assert.equal(await readFile(output, 'utf8'), 'origin\nurl with spaces\nrefs/heads/main 123 refs/heads/main 456\n');
  await rm(path.join(f.repo, '.git/hooks/pre-push'));
  assert.equal(await dispatchHook({ event: 'pre-push', args: [], input: '', cwd: f.repo, env: f.env, gate: async () => 23 }), 23);
  assert.equal(await dispatchHook({ event: 'pre-commit', args: [], input: '', cwd: f.repo, env: { ...f.env, SPHINX_EVALUATOR: '1' }, gate: async () => 23 }), 0);
});

test('fresh repositories initialize and clone after global installation while existing reference hooks still reject', async t => {
  const f = await fixture(t);
  await install(f.options);
  const run = (args, cwd = f.base) => execFileSync('git', args, { cwd, env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  run(['init', '-q', 'fresh']);
  run(['init', '-q', '--bare', 'fresh.git']);
  for (const directory of ['fresh/.git', 'fresh.git']) assert.match(run(['--git-dir', directory, 'symbolic-ref', 'HEAD']), /^refs\/heads\//);
  run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'base'], path.join(f.base, 'fresh'));
  run(['clone', '-q', 'fresh', 'cloned']);
  run(['clone', '-q', '--bare', 'fresh', 'cloned.git']);
  assert.equal(run(['rev-parse', 'HEAD'], path.join(f.base, 'cloned')), run(['rev-parse', 'HEAD'], path.join(f.base, 'fresh')));

  const rejecting = '#!/bin/sh\ncat >/dev/null\n[ "$1" = prepared ] && { echo rejected by original hook >&2; exit 9; }\nexit 0\n';
  const template = path.join(f.base, 'template');
  await executable(path.join(template, 'hooks/reference-transaction'), rejecting);
  // Older Git creates the initial HEAD without running reference-transaction.
  let initRunsHook = true;
  try { run(['-c', `core.hooksPath=${path.join(template, 'hooks')}`, 'init', '-q', 'probe']); initRunsHook = false; } catch {}
  if (initRunsHook) assert.throws(() => run(['init', '-q', `--template=${template}`, 'templated']), error => /rejected by original hook/.test(error.stderr));
  f.git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'base');
  await executable(path.join(f.repo, '.git/hooks/reference-transaction'), rejecting);
  assert.throws(() => f.git('update-ref', 'refs/heads/blocked', 'HEAD'), error => /rejected by original hook/.test(error.stderr));
});

test('generated gate dispatcher safely quotes the Node, CLI and state paths', async t => {
  const f = await fixture(t);
  await install(f.options);
  const hookDir = f.git('config', '--global', '--get', 'core.hooksPath');
  await assert.rejects(async () => execFileSync(path.join(hookDir, 'pre-commit'), [], { cwd: f.repo, env: { ...f.env, SPHINX_TEST_GATE: '17' }, input: '' }), error => error.status === 17);
});

test('non-gated protocol hooks retain streaming stdin and stdout', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await executable(path.join(f.repo, '.git/hooks/proc-receive'), '#!/bin/sh\nread first\nprintf "ack:%s\\n" "$first"\nread second\nprintf "done:%s\\n" "$second"\n');
  await install(f.options);
  const hookDir = f.git('config', '--global', '--get', 'core.hooksPath');
  const child = spawn(path.join(hookDir, 'proc-receive'), [], { cwd: f.repo, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '';
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output === 'ack:one\n') child.stdin.end('two\n');
    });
  });
  child.stdin.write('one\n');
  await finished;
  assert.equal(output, 'ack:one\ndone:two\n');
});

test('repository override is diagnosed and explicitly chained without replacing existing files', async t => {
  const f = await fixture(t);
  await executable(path.join(f.repo, 'custom-hooks/pre-push'), '#!/bin/sh\nexit 12\n');
  f.git('config', '--local', 'core.hooksPath', 'custom-hooks');
  const global = await install(f.options);
  assert.ok(global.warnings.some(w => w.includes('overrides')));
  assert.equal((await doctor(f.options)).checks.find(c => c.name === 'Current repository').ok, false);
  await install({ ...f.options, repo: true });
  assert.equal((await doctor(f.options)).checks.find(c => c.name === 'Current repository').ok, true);
  const reinstalled = await install(f.options);
  assert.equal(reinstalled.warnings.some(w => w.includes('overrides')), false, 'An existing Sphinx repository dispatcher already covers this override');
  assert.equal(await dispatchHook({ event: 'pre-push', input: '', cwd: f.repo, env: f.env, gate: async () => 0 }), 12);
  await uninstall({ ...f.options, repo: true });
  assert.equal(f.git('config', '--local', '--get', 'core.hooksPath'), 'custom-hooks');
  assert.match(await readFile(path.join(f.repo, 'custom-hooks/pre-push'), 'utf8'), /exit 12/);
});

test('repository installation works with linked worktrees whether or not extensions.worktreeConfig is on (#35)', async t => {
  const f = await fixture(t);
  await executable(path.join(f.repo, 'custom-hooks/pre-push'), '#!/bin/sh\nexit 12\n');
  f.git('config', '--local', 'core.hooksPath', 'custom-hooks');
  f.git('commit', '-q', '--allow-empty', '-m', 'base');
  f.git('worktree', 'add', '-q', path.join(f.repo, '..', 'linked'));
  // Off: Git refuses --worktree here, so the repository's own setting is chained.
  await install({ ...f.options, repo: true });
  assert.equal(await dispatchHook({ event: 'pre-push', input: '', cwd: f.repo, env: f.env, gate: async () => 0 }), 12);
  await uninstall({ ...f.options, repo: true });
  assert.equal(f.git('config', '--local', '--get', 'core.hooksPath'), 'custom-hooks');
  // On, with this worktree's own override: that one is chained instead.
  f.git('config', 'extensions.worktreeConfig', 'true');
  await executable(path.join(f.repo, 'own-hooks/pre-push'), '#!/bin/sh\nexit 13\n');
  f.git('config', '--worktree', 'core.hooksPath', 'own-hooks');
  await install({ ...f.options, repo: true });
  assert.equal(await dispatchHook({ event: 'pre-push', input: '', cwd: f.repo, env: f.env, gate: async () => 0 }), 13);
  await uninstall({ ...f.options, repo: true });
  assert.equal(f.git('config', '--worktree', '--get', 'core.hooksPath'), 'own-hooks');
});

test('uninstall preserves subsequent Git, generated-hook, and agent settings edits', async t => {
  const f = await fixture(t);
  await install({ ...f.options, agents: 'codex' });
  const hookDir = f.git('config', '--global', '--get', 'core.hooksPath');
  await writeFile(path.join(hookDir, 'pre-push'), '# user-edited\n');
  f.git('config', '--global', 'core.hooksPath', 'new-user-path');
  const file = path.join(f.paths.codexHome, 'hooks.json');
  const settings = await json(file);
  settings.hooks.SessionStart[0].hooks[0].timeout = 99;
  settings.unrelated = 'keep';
  await writeFile(file, JSON.stringify(settings));
  const result = await uninstall(f.options);
  assert.equal(f.git('config', '--global', '--get', 'core.hooksPath'), 'new-user-path');
  assert.equal(await readFile(path.join(hookDir, 'pre-push'), 'utf8'), '# user-edited\n');
  delete settings.hooks.PostToolUse; // Unedited Sphinx native hook is removed; the edited SessionStart stays.
  assert.deepEqual(await json(file), settings);
  assert.ok(result.warnings.length >= 3);
});

test('invalid existing agent settings stop installation before mutating Git', async t => {
  const f = await fixture(t);
  await mkdir(f.paths.claudeHome, { recursive: true });
  const file = path.join(f.paths.claudeHome, 'settings.json');
  await writeFile(file, '{broken');
  await assert.rejects(install({ ...f.options, agents: 'claude' }), /Cannot read/);
  assert.throws(() => f.git('config', '--global', '--get', 'core.hooksPath'));
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('malformed agent settings errors identify the file without exposing its contents', async t => {
  const f = await fixture(t);
  await mkdir(f.paths.claudeHome, { recursive: true });
  const file = path.join(f.paths.claudeHome, 'settings.json');
  const sentinel = 'private-settings-sentinel-651a';
  await writeFile(file, sentinel);
  await assert.rejects(install({ ...f.options, agents: 'claude' }), error => {
    assert.match(error.message, /invalid JSON/);
    assert.ok(error.message.includes(file));
    assert.equal(error.message.includes(sentinel), false);
    return true;
  });
});

test('reinstallation refuses to clobber user edits and hook recursion fails closed', async t => {
  const f = await fixture(t);
  await install(f.options);
  await assert.rejects(dispatchHook({ event: 'pre-push', cwd: f.repo, env: { ...f.env, SPHINX_HOOK_DEPTH: '1' }, gate: async () => 0 }), /Recursive/);
  const hookDir = f.git('config', '--global', '--get', 'core.hooksPath');
  await writeFile(path.join(hookDir, 'pre-push'), '# edited');
  await assert.rejects(install(f.options), /Refusing to overwrite edited hook/);
});

test('repository installation can inherit a global chain and outlive global uninstall', async t => {
  const f = await fixture(t);
  await install(f.options);
  await install({ ...f.options, repo: true });
  const manifest = await json(f.paths.install);
  const repoEntry = Object.values(manifest.installs).find(entry => entry.id !== 'global');
  assert.deepEqual(repoEntry.source, { kind: 'default' });
  await uninstall(f.options);
  assert.equal((await doctor(f.options)).checks.find(check => check.name === 'Current repository').ok, true);
  let calls = 0;
  assert.equal(await dispatchHook({ event: 'pre-push', cwd: f.repo, env: f.env, gate: async () => { calls++; return 0; } }), 0);
  assert.equal(calls, 1);
  await uninstall({ ...f.options, repo: true });
  assert.throws(() => f.git('config', '--local', '--get', 'core.hooksPath'));
});

test('integration-home override isolates Git even without GIT_CONFIG_GLOBAL', async t => {
  const f = await fixture(t);
  const env = { ...f.env, HOME: path.join(f.base, 'unrelated-home') };
  delete env.GIT_CONFIG_GLOBAL;
  await mkdir(env.HOME);
  await install({ ...f.options, env });
  assert.match(await readFile(path.join(f.home, '.gitconfig'), 'utf8'), /hooksPath/);
  await assert.rejects(readFile(path.join(env.HOME, '.gitconfig')), { code: 'ENOENT' });
});

test('reinstalling an edited agent hook refuses to create a second Sphinx handler', async t => {
  const f = await fixture(t);
  await install({ ...f.options, agents: 'claude' });
  const file = path.join(f.paths.claudeHome, 'settings.json');
  const settings = await json(file);
  settings.hooks.SessionStart[0].hooks[0].timeout = 42;
  await writeFile(file, JSON.stringify(settings));
  await assert.rejects(install({ ...f.options, agents: 'claude' }), /edited claude integration/);
  assert.deepEqual(await json(file), settings);
});

test('installer preserves user replacement symlinks and reports intentionally unselected agents as optional', async t => {
  const f = await fixture(t);
  await install(f.options);
  const report = await doctor(f.options);
  assert.equal(report.checks.every(check => check.ok), true);
  assert.match(report.checks.find(check => check.name === 'codex integration').detail, /Not selected/);
  const hookDir = f.git('config', '--global', '--get', 'core.hooksPath');
  const file = path.join(hookDir, 'pre-push');
  const original = await readFile(file, 'utf8');
  const target = path.join(f.base, 'user-hook');
  await writeFile(target, original);
  await rm(file);
  await symlink(target, file);
  await assert.rejects(install(f.options), /edited hook symlink/);
  const result = await uninstall(f.options);
  assert.ok(result.warnings.some(warning => warning.includes('hook symlink')));
  assert.equal((await lstat(file)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), original);
});

test('native questionnaire hooks register host MCP servers without changing unrelated settings', async t => {
  const f = await fixture(t);
  const tomlFile = path.join(f.paths.codexHome, 'config.toml');
  const claudeFile = path.join(f.home, '.claude.json');
  const beforeToml = '# Keep this exact formatting\nmodel = "existing-model"\n\n[mcp_servers.other]\ncommand = "/bin/echo"\nargs = ["hello"]\n';
  const beforeClaude = { numStartups: 17, oauthAccount: { accountUuid: 'existing-test-id' }, projects: { '/other': { hasTrustDialogAccepted: false } }, mcpServers: { other: { type: 'stdio', command: '/bin/echo' } } };
  await mkdir(f.paths.codexHome, { recursive: true });
  await writeFile(tomlFile, beforeToml);
  await writeFile(claudeFile, JSON.stringify(beforeClaude));
  await install({ ...f.options, agents: 'codex,claude' });
  for (const name of ['codex', 'claude']) {
    const file = path.join(f.paths[`${name}Home`], name === 'codex' ? 'hooks.json' : 'settings.json');
    const document = await json(file);
    const events = name === 'codex' ? ['PostToolUse'] : ['PostToolUse', 'PostToolUseFailure'];
    assert.equal(document.hooks.SessionStart.length, 1);
    assert.equal(document.hooks.SessionStart[0].hooks[0].statusMessage, 'Sphinx session setup');
    for (const event of events) {
      const group = document.hooks[event][0];
      assert.equal(group.matcher, 'Bash');
      // A command hook needs no MCP connection, so sessions opened before install never error.
      assert.deepEqual(group.hooks[0], { type: 'command', command: document.hooks.SessionStart[0].hooks[0].command, timeout: 1800, statusMessage: 'Sphinx understanding check' });
    }
  }
  const toml = await readFile(tomlFile, 'utf8');
  assert.ok(toml.startsWith(beforeToml));
  assert.match(toml, /\[mcp_servers\.sphinx\]/);
  assert.match(toml, /tool_timeout_sec = 1800/);
  const claude = await json(claudeFile);
  assert.deepEqual(claude.oauthAccount, beforeClaude.oauthAccount);
  assert.deepEqual(claude.mcpServers.sphinx, { type: 'stdio', command: process.execPath, args: [f.cliPath, 'mcp'], env: { SPHINX_HOME: f.paths.home }, timeout: 1800000 });
  assert.equal((await doctor(f.options)).checks.every(check => check.ok), true);
  await install({ ...f.options, agents: 'codex,claude' });
  assert.equal((await readFile(tomlFile, 'utf8')).split('[mcp_servers.sphinx]').length, 2);
  assert.equal((await json(path.join(f.paths.claudeHome, 'settings.json'))).hooks.PostToolUseFailure.length, 1);
  await uninstall(f.options);
  assert.equal(await readFile(tomlFile, 'utf8'), beforeToml);
  assert.deepEqual(await json(claudeFile), beforeClaude);
});

test('legacy SessionStart-only manifest upgrades in place and removes cleanly', async t => {
  const f = await fixture(t);
  await install({ ...f.options, agents: 'codex' });
  const manifest = await json(f.paths.install), record = manifest.agents.codex;
  const hooks = await json(record.file);
  delete hooks.hooks.SessionStart[0].hooks[0].statusMessage;
  delete hooks.hooks.PostToolUse;
  await writeFile(record.file, JSON.stringify(hooks));
  await rm(record.mcp.file);
  delete record.hooks; delete record.mcp; delete record.emptyEvents;
  await writeFile(f.paths.install, JSON.stringify(manifest));
  assert.equal((await doctor(f.options)).checks.find(check => check.name === 'codex integration').ok, false);
  await install({ ...f.options, agents: 'codex' });
  const migrated = await json(record.file);
  assert.equal(migrated.hooks.SessionStart.length, 1);
  assert.equal(migrated.hooks.SessionStart[0].hooks[0].statusMessage, 'Sphinx session setup');
  assert.equal(migrated.hooks.PostToolUse.length, 1);
  assert.equal((await doctor(f.options)).checks.every(check => check.ok), true);
  await uninstall(f.options);
  await assert.rejects(readFile(record.file), { code: 'ENOENT' });
});

test('unlabelled native installations gain labels once and preserve unrelated hooks on removal', async t => {
  const f = await fixture(t);
  await install({ ...f.options, agents: 'codex,claude' });
  const manifest = await json(f.paths.install);
  const other = { type: 'command', command: 'my-session-hook', statusMessage: 'My session hook' };
  for (const name of ['codex', 'claude']) {
    const record = manifest.agents[name], document = await json(record.file);
    delete record.hooks.find(spec => spec.event === 'SessionStart').group.hooks[0].statusMessage;
    delete document.hooks.SessionStart[0].hooks[0].statusMessage;
    document.hooks.SessionStart[0].hooks.push(other);
    await writeFile(record.file, JSON.stringify(document));
  }
  await writeFile(f.paths.install, JSON.stringify(manifest));
  await install({ ...f.options, agents: 'codex,claude' });
  const upgraded = new Map();
  for (const name of ['codex', 'claude']) {
    const file = manifest.agents[name].file, document = await json(file);
    const handlers = document.hooks.SessionStart.flatMap(group => group.hooks);
    assert.equal(handlers.length, 2);
    assert.deepEqual(handlers.find(handler => handler.command === other.command), other);
    assert.equal(handlers.filter(handler => handler.statusMessage === 'Sphinx session setup').length, 1);
    upgraded.set(file, await readFile(file, 'utf8'));
  }
  await install({ ...f.options, agents: 'codex,claude' });
  for (const [file, text] of upgraded) assert.equal(await readFile(file, 'utf8'), text);
  assert.equal((await doctor(f.options)).checks.every(check => check.ok), true);
  await uninstall(f.options);
  for (const file of upgraded.keys()) assert.deepEqual(await json(file), { hooks: { SessionStart: [{ hooks: [other] }] } });
});

test('a user-edited hook label is preserved instead of overwritten or removed', async t => {
  const f = await fixture(t);
  await install({ ...f.options, agents: 'codex' });
  const record = (await json(f.paths.install)).agents.codex, document = await json(record.file);
  document.hooks.SessionStart[0].hooks[0].statusMessage = 'My custom checkpoint setup';
  await writeFile(record.file, JSON.stringify(document));
  await assert.rejects(install({ ...f.options, agents: 'codex' }), /Refusing to replace an edited codex integration/);
  await uninstall(f.options);
  assert.deepEqual(await json(record.file), { hooks: { SessionStart: document.hooks.SessionStart } });
});

test('existing MCP server names and edited native hook matchers are never overwritten', async t => {
  const f = await fixture(t);
  const file = path.join(f.home, '.claude.json');
  const original = { mcpServers: { sphinx: { type: 'stdio', command: '/my/sphinx' } } };
  await writeFile(file, JSON.stringify(original));
  await assert.rejects(install({ ...f.options, agents: 'claude' }), /existing or edited sphinx/);
  assert.deepEqual(await json(file), original);
  assert.throws(() => f.git('config', '--global', '--get', 'core.hooksPath'));
  await rm(file);
  await install({ ...f.options, agents: 'claude' });
  const settingsFile = path.join(f.paths.claudeHome, 'settings.json');
  const settings = await json(settingsFile);
  settings.hooks.PostToolUse[0].matcher = 'Write';
  await writeFile(settingsFile, JSON.stringify(settings));
  await assert.rejects(install({ ...f.options, agents: 'claude' }), /edited claude integration/);
  assert.deepEqual(await json(settingsFile), settings);
});

test('uninstall retains modified MCP registrations and later unrelated TOML additions', async t => {
  const f = await fixture(t);
  await install({ ...f.options, agents: 'codex,claude' });
  const codexFile = path.join(f.paths.codexHome, 'config.toml');
  const original = await readFile(codexFile, 'utf8');
  const addition = '\n[profiles.added-later]\nmodel = "keep-this"\n';
  await writeFile(codexFile, original + addition);
  const claudeFile = path.join(f.home, '.claude.json');
  const document = await json(claudeFile);
  document.mcpServers.sphinx.timeout = 123000;
  document.userPreference = true;
  await writeFile(claudeFile, JSON.stringify(document));
  assert.equal((await doctor(f.options)).checks.find(check => check.name === 'claude questionnaire server').ok, false);
  const result = await uninstall(f.options);
  assert.equal(await readFile(codexFile, 'utf8'), addition);
  assert.deepEqual(await json(claudeFile), document);
  assert.ok(result.warnings.some(warning => warning.includes('MCP server was edited')));
});

test('Codex registration rejects quoted and inline name conflicts but preserves multiline values', async t => {
  const f = await fixture(t);
  await mkdir(f.paths.codexHome, { recursive: true });
  const file = path.join(f.paths.codexHome, 'config.toml');
  for (const conflict of ['[mcp_servers."sphinx"]\ncommand="existing"\n', 'mcp_servers = { other = { command = "existing" } }\n', '[mcp_servers]\nsphinx = { command = "existing" }\n']) {
    await writeFile(file, conflict);
    await assert.rejects(install({ ...f.options, agents: 'codex' }), /existing|conflicts/);
    assert.equal(await readFile(file, 'utf8'), conflict);
  }
  const multiline = 'description = """\n[mcp_servers.sphinx]\nThis is text, not a table.\n"""\n[profiles."a.b"]\nmodel="existing"\n';
  await writeFile(file, multiline);
  await install({ ...f.options, agents: 'codex' });
  await uninstall(f.options);
  assert.equal(await readFile(file, 'utf8'), multiline);
});

test('malformed Claude MCP JSON errors never disclose settings contents', async t => {
  const f = await fixture(t);
  const secret = 'test-auth-sentinel-6c97';
  await writeFile(path.join(f.home, '.claude.json'), secret);
  await assert.rejects(install({ ...f.options, agents: 'claude' }), error => {
    assert.match(error.message, /invalid JSON/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.throws(() => f.git('config', '--global', '--get', 'core.hooksPath'));
});

test('preparation hooks preserve streaming input and original status while scheduling without a terminal', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const scheduled = path.join(f.base, 'scheduled');
  await writeFile(f.cliPath, `import {writeFile} from 'node:fs/promises';\nlet input='';for await(const chunk of process.stdin)input+=chunk;\nawait writeFile(process.env.SPHINX_TEST_SCHEDULED,JSON.stringify({args:process.argv.slice(2),input}));\nsetTimeout(()=>{},1500);\n`);
  await executable(path.join(f.repo, '.git/hooks/post-rewrite'), '#!/bin/sh\nread first\nprintf "ack:%s\\n" "$first"\nread second\nprintf "done:%s:%s\\n" "$1" "$second"\nexit 13\n');
  await install(f.options);
  const hookDir = f.git('config', '--global', '--get', 'core.hooksPath');
  const child = spawn(path.join(hookDir, 'post-rewrite'), ['amend'], { cwd: f.repo, env: { ...f.env, SPHINX_TEST_SCHEDULED: scheduled }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '';
  const acknowledged = new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (output.includes('ack:first\n')) resolve(); }));
  const closed = new Promise(resolve => child.on('close', resolve));
  child.stdin.write('first\n'); await acknowledged;
  child.stdin.end('second\n');
  assert.equal(await closed, 13);
  assert.equal(output, 'ack:first\ndone:amend:second\n');
  for (let i = 0; i < 100; i++) {
    if (await readFile(scheduled, 'utf8').catch(() => '')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await json(scheduled), { args: ['prepare'], input: '' });
  // A scheduler that stays alive must not hold the post-hook's streams open.
  assert.equal(child.exitCode, 13);
  await rm(scheduled);
  execFileSync(path.join(hookDir, 'post-commit'), [], { cwd: f.repo, env: { ...f.env, SPHINX_EVALUATOR: '1', SPHINX_TEST_SCHEDULED: scheduled }, timeout: 1000 });
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(readFile(scheduled), error => error.code === 'ENOENT');
  for (const hook of ['post-commit', 'post-merge', 'post-rewrite', 'post-checkout']) assert.match(await readFile(path.join(hookDir, hook), 'utf8'), / prepare <\/dev\/null >\/dev\/null 2>&1 &/);
  await uninstall(f.options);
  assert.equal(await readFile(path.join(f.repo, '.git/hooks/post-rewrite'), 'utf8'), '#!/bin/sh\nread first\nprintf "ack:%s\\n" "$first"\nread second\nprintf "done:%s:%s\\n" "$1" "$second"\nexit 13\n');
});

test('a dotfiles-symlinked Claude settings file is updated through its link, and uninstall keeps the target', async t => {
  const f = await fixture(t);
  const dotfiles = path.join(f.base, 'dotfiles'), target = path.join(dotfiles, 'claude-settings.json'), link = path.join(f.paths.claudeHome, 'settings.json');
  await mkdir(dotfiles, { recursive: true }); await mkdir(f.paths.claudeHome, { recursive: true });
  await writeFile(target, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }));
  await symlink(target, link);
  await install({ ...f.options, agents: 'claude' });
  assert.ok((await lstat(link)).isSymbolicLink(), 'The dotfiles link is kept');
  const updated = await json(target);
  assert.equal(updated.theme, 'dark');
  assert.ok(updated.hooks.SessionStart?.length && updated.hooks.PostToolUse?.length, 'Hooks were written to the link target');
  assert.deepEqual(updated.hooks.Stop, [{ hooks: [{ type: 'command', command: 'mine' }] }]);
  await uninstall({ env: f.env });
  assert.ok((await lstat(link)).isSymbolicLink());
  const restored = await json(target);
  assert.equal(restored.theme, 'dark');
  assert.equal(restored.hooks.SessionStart, undefined);
});

test('a dangling settings symlink fails with a clear message and changes nothing', async t => {
  const f = await fixture(t);
  await mkdir(f.paths.claudeHome, { recursive: true });
  await symlink(path.join(f.base, 'missing.json'), path.join(f.paths.claudeHome, 'settings.json'));
  await assert.rejects(install({ ...f.options, agents: 'claude' }), /symlink to a missing file/);
});

test('hooks call the package manager shim on PATH so upgrades keep working; a checkout falls back to absolute paths', async t => {
  const { sphinxLauncher } = await import('../src/install.js');
  const f = await fixture(t);
  const cli = path.join(f.base, 'store', 'sphinx-understand@0.1.0_abc', 'node_modules', 'sphinx-understand', 'bin', 'sphinx.js');
  await executable(cli, '#!/usr/bin/env node\n');
  const npmBin = path.join(f.base, 'npm-bin'), pnpmBin = path.join(f.base, 'pnpm-home'), other = path.join(f.base, 'other');
  await mkdir(npmBin, { recursive: true }); await symlink(cli, path.join(npmBin, 'sphinx'));
  await executable(path.join(pnpmBin, 'sphinx'), '#!/bin/sh\nexec node "$basedir/global/5/node_modules/sphinx-understand/bin/sphinx.js" "$@"\n');
  await executable(path.join(other, 'sphinx'), '#!/bin/sh\necho unrelated tool\n');
  const node = '/opt/node/bin/node', q = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const npm = await sphinxLauncher(cli, { PATH: [other, npmBin].join(path.delimiter) }, node);
  assert.equal(npm.command, q(path.join(npmBin, 'sphinx')), 'An unrelated sphinx earlier on PATH is skipped');
  assert.equal(npm.env, `PATH='/opt/node/bin':"$PATH" `);
  const pnpm = await sphinxLauncher(cli, { PATH: pnpmBin }, node);
  assert.equal(pnpm.command, q(path.join(pnpmBin, 'sphinx')));
  const checkout = await sphinxLauncher(cli, { PATH: other }, node);
  assert.deepEqual(checkout, { env: '', command: `${q(node)} ${q(cli)}` });
});
