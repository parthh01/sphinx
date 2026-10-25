import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI = fileURLToPath(new URL('../bin/sphinx.js', import.meta.url));

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'sphinx-config-cli-'));
  const home = path.join(base, 'home'), state = path.join(home, 'sphinx'), bin = path.join(base, 'bin');
  await mkdir(home); await mkdir(bin);
  const env = { ...process.env, HOME: home, SPHINX_HOME: state, SPHINX_USER_HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    OPENROUTER_API_KEY: '', CI: '1', FORCE_COLOR: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_') || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG', 'SPHINX_EVALUATOR', 'NO_COLOR'].includes(key)) delete env[key];
  const marker = path.join(base, 'provider-invoked');
  for (const name of ['claude', 'codex']) await writeFile(path.join(bin, name), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected model invocation');process.exit(88);\n`, { mode: 0o755 });
  const configPath = path.join(state, 'config.json');
  const run = (args, cwd = base) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 10000, input: '' });
  const ok = (args, cwd) => {
    const result = run(args, cwd);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
    return result.stdout;
  };
  const absent = file => assert.rejects(stat(file), { code: 'ENOENT' });
  t.after(async () => { try { await absent(marker); } finally { await rm(base, { recursive: true, force: true }); } });
  return { base, home, state, env, configPath, run, ok, absent };
}

test('config setter works outside a repository and reports saved global settings without inference or installation', async t => {
  const f = await fixture(t);
  const before = JSON.parse(f.ok(['config', '--json']));
  await f.absent(f.configPath);
  const output = f.ok(['config', '--max-model-calls', '30', '--json']);
  assert.doesNotMatch(output, /\x1b/u);
  const saved = JSON.parse(output);
  assert.equal(saved.scope, 'global');
  assert.equal(saved.path, f.configPath);
  assert.equal(saved.previousMaxModelCalls, before.maxModelCalls);
  assert.equal(saved.maxModelCalls, 30);
  assert.deepEqual(saved.config, { ...before, maxModelCalls: 30 });
  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), saved.config);
  assert.deepEqual(JSON.parse(f.ok(['config', '--json'])), saved.config, 'read-only JSON shape stays unchanged');
  await f.absent(path.join(f.state, 'install.json'));
  await f.absent(path.join(f.state, 'sessions'));
  await f.absent(f.env.GIT_CONFIG_GLOBAL);
  await f.absent(path.join(f.state, 'credentials.json'));
});

test('saving the call limit preserves global routes and does not copy repository policy into global settings', async t => {
  const f = await fixture(t);
  await mkdir(f.state);
  await writeFile(f.configPath, JSON.stringify({
    version: 1, maxModelCalls: 11, branches: ['production'], level: 'relaxed', agentMaxTurns: 4,
    models: { small: { provider: 'claude', model: 'small-custom' }, medium: { provider: 'codex', model: 'medium-custom' }, large: { provider: 'openrouter', model: 'large-custom:free' } },
  }));
  const global = JSON.parse(f.ok(['config', '--json']));
  const repo = path.join(f.base, 'repo'); await mkdir(repo);
  const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: f.env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const policy = JSON.stringify({ version: 1, branches: ['release/*'], level: 'thorough' });
  await writeFile(path.join(repo, '.sphinxconfig'), policy);
  assert.deepEqual(JSON.parse(f.ok(['config', '--json'], repo)).branches, ['release/*']);
  const saved = JSON.parse(f.ok(['config', '--max-model-calls', '25', '--json'], repo));
  assert.deepEqual(saved.config, { ...global, maxModelCalls: 25 });
  assert.equal(await readFile(path.join(repo, '.sphinxconfig'), 'utf8'), policy);
  assert.deepEqual(JSON.parse(f.ok(['config', '--json'], repo)).branches, ['release/*']);
  await writeFile(path.join(repo, '.sphinxconfig'), '{invalid local policy');
  assert.equal(JSON.parse(f.ok(['config', '--max-model-calls', '26', '--json'], repo)).maxModelCalls, 26, 'a global setter does not depend on repository parsing');
});

test('invalid limits fail before writing while both documented boundaries are accepted', async t => {
  const f = await fixture(t);
  f.ok(['config', '--max-model-calls', '1', '--json']);
  const saved = await readFile(f.configPath, 'utf8');
  for (const value of ['0', '101', '-1', '2.5', '1e2', '', 'twenty']) {
    const result = f.run(['config', `--max-model-calls=${value}`, '--json']);
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /whole number from 1 to 100/);
    assert.doesNotMatch(result.stderr, /\x1b/u);
    assert.equal(await readFile(f.configPath, 'utf8'), saved);
  }
  assert.equal(JSON.parse(f.ok(['config', '--max-model-calls', '100', '--json'])).maxModelCalls, 100);
});

test('call caps default to unlimited and explicit unlimited aliases clear a saved cap without inference', async t => {
  const f = await fixture(t);
  const initial = JSON.parse(f.ok(['config', '--json']));
  assert.equal(initial.maxModelCalls, null);
  assert.equal(initial.agentMaxTurns, null);
  for (const value of ['unlimited', 'none']) {
    f.ok(['config', '--max-model-calls', '20', '--json']);
    const saved = JSON.parse(f.ok(['config', '--max-model-calls', value, '--json']));
    assert.equal(saved.previousMaxModelCalls, 20);
    assert.equal(saved.maxModelCalls, null);
    assert.equal(saved.config.maxModelCalls, null);
    assert.deepEqual(saved.config.models, initial.models);
    assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).maxModelCalls, null);
  }
  const output = f.ok(['config', '--max-model-calls', 'unlimited']).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+/g, ' ');
  assert.match(output, /Saved machine-wide limit: no limit \(previously no limit\)/);
  assert.doesNotMatch(output, /\bnull\b|Infinity|\/null/);
  const displayed = f.ok(['config']).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+/g, ' ');
  assert.match(displayed, /Model calls: no limit/);
  assert.match(displayed, /Reviewer turns No request limit/);
  assert.doesNotMatch(displayed, /\bnull\b|Infinity|\/null/);
  await f.absent(path.join(f.state, 'sessions'));
  await f.absent(f.env.GIT_CONFIG_GLOBAL);
});

test('output-token allowance is explicit, bounded, and preserves model routes and total calls', async t => {
  const f = await fixture(t);
  const before = JSON.parse(f.ok(['config', '--json']));
  const saved = JSON.parse(f.ok(['config', '--max-output-tokens', '8192', '--json']));
  assert.deepEqual(saved.config, { ...before, maxOutputTokens: 8192 });
  assert.equal(saved.maxModelCalls, before.maxModelCalls);
  const original = await readFile(f.configPath, 'utf8');
  for (const value of ['0', '511', '16385', '-1', '8192.5', '8e3', '', 'many']) {
    const result = f.run(['config', `--max-output-tokens=${value}`, '--json']);
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /whole number from 512 to 16384/);
    assert.equal(await readFile(f.configPath, 'utf8'), original);
  }
  for (const value of ['512', '16384']) assert.equal(JSON.parse(f.ok(['config', '--max-output-tokens', value, '--json'])).config.maxOutputTokens, Number(value));
  // Changing assessment policy tells the human what happens to a waiting Git operation.
  assert.match(f.ok(['config', '--distance', 'low']).replace(/\s+/g, ' '), /Checks started under the previous settings no longer apply\. A Git operation waiting on one stops within a few seconds/);
  // The output allowance and the call ceiling are run settings, not assessment policy, so no warning is shown.
  assert.doesNotMatch(f.ok(['config', '--max-output-tokens', '4096']), /no longer apply/);
  assert.doesNotMatch(f.ok(['config', '--max-model-calls', '50']), /no longer apply/);
  await f.absent(path.join(f.state, 'sessions'));
  await f.absent(f.env.GIT_CONFIG_GLOBAL);
});

test('install accepts the total call limit, preserves it on rerun, and rejects invalid values before setup', async t => {
  const f = await fixture(t);
  const invalid = f.run(['install', '--yes', '--provider', 'claude', '--agents', 'none', '--max-model-calls', '101']);
  assert.equal(invalid.status, 1);
  await f.absent(f.configPath); await f.absent(f.env.GIT_CONFIG_GLOBAL);
  f.ok(['install', '--yes', '--provider', 'claude', '--agents', 'none', '--max-model-calls', '35']);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).maxModelCalls, 35);
  f.ok(['install', '--yes', '--agents', 'none']);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).maxModelCalls, 35);
  const config = JSON.parse(f.ok(['config', '--json']));
  assert.equal(config.agentMaxTurns, null);
  assert.equal(config.models.small.provider, 'claude');
  f.ok(['install', '--yes', '--agents', 'none', '--max-model-calls', 'unlimited']);
  assert.equal(JSON.parse(await readFile(f.configPath, 'utf8')).maxModelCalls, null);
});

test('configuration help documents the setter without saving and text output separates total and review limits', async t => {
  const f = await fixture(t);
  const help = JSON.parse(f.ok(['config', '--max-model-calls', '30', '--help', '--json']));
  assert.match(JSON.stringify(help), /--max-model-calls/);
  assert.match(JSON.stringify(help), /without reinstalling/);
  await f.absent(f.configPath);
  const output = f.ok(['config', '--max-model-calls', '30']).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+/g, ' ');
  assert.match(output, /Saved machine-wide limit: 30 model calls per assessment/);
  assert.match(output, /Review planning targets: small 5, medium 7, large 8/);
  assert.match(JSON.stringify(help), /unlimited/);
  assert.match(JSON.stringify(help), /Default: no limit/);
});

test('a fresh unattended installation requires a reviewer choice before writing hooks or credentials', async t => {
  const f = await fixture(t);
  for (const routes of [[], ['--small', 'claude:haiku'], ['--small', 'claude:haiku', '--medium', 'codex:custom']]) {
    const result = f.run(['install', '--yes', '--agents', 'none', ...routes]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /First installation needs an explicit reviewer choice/);
  }
  for (const file of [f.configPath, f.env.GIT_CONFIG_GLOBAL, path.join(f.state, 'install.json'), path.join(f.state, 'credentials.json')]) await f.absent(file);
});

test('a fresh unattended installation accepts an explicit route for every size', async t => {
  const f = await fixture(t);
  f.ok(['install', '--yes', '--agents', 'none', '--small', 'claude:haiku', '--medium', 'claude:haiku', '--large', 'codex:custom']);
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.deepEqual(config.models, {
    small: { provider: 'claude', model: 'haiku' },
    medium: { provider: 'claude', model: 'haiku' },
    large: { provider: 'codex', model: 'custom' },
  });
});

test('economical CLI provider defaults are explicit and custom models remain selectable', async t => {
  const f = await fixture(t);
  for (const [provider, model] of [['codex', 'gpt-6-luna'], ['claude', 'haiku']]) {
    const result = JSON.parse(f.ok(['config', '--provider', provider, '--json']));
    for (const tier of ['small', 'medium', 'large']) assert.deepEqual(result.config.models[tier], { provider, model });
    assert.equal(result.config.provider, provider);
    assert.equal(result.config.model, model);
  }
  const custom = JSON.parse(f.ok(['config', '--provider', 'claude', '--model', 'my-explicit-model', '--json']));
  for (const route of Object.values(custom.config.models)) assert.deepEqual(route, { provider: 'claude', model: 'my-explicit-model' });
  await f.absent(f.env.GIT_CONFIG_GLOBAL);
  await f.absent(path.join(f.state, 'install.json'));
});

test('presets allow tier overrides and preserve unrelated global settings', async t => {
  const f = await fixture(t);
  await mkdir(f.state);
  await writeFile(f.configPath, JSON.stringify({ version: 1, branches: ['production'], maxModelCalls: 27, level: 'relaxed', backgroundPreparation: false }));
  const result = JSON.parse(f.ok(['config', '--preset', 'codex-economy', '--large', 'claude:sonnet', '--json']));
  assert.deepEqual(result.config.models, {
    small: { provider: 'codex', model: 'gpt-6-luna' },
    medium: { provider: 'codex', model: 'gpt-6-luna' },
    large: { provider: 'claude', model: 'sonnet' },
  });
  assert.deepEqual(result.config.branches, ['production']);
  assert.equal(result.config.level, 'relaxed');
  assert.equal(result.config.backgroundPreparation, false);
  assert.equal(result.previousMaxModelCalls, 27);
  assert.equal(result.maxModelCalls, 27);
  await f.absent(path.join(f.state, 'sessions'));
});

test('paid presets need an explicit flag or previously saved paid permission', async t => {
  const f = await fixture(t);
  for (const preset of ['openrouter-value', 'openrouter-deepseek']) {
    const denied = f.run(['config', '--preset', preset, '--json']);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /--allow-paid/);
    await f.absent(f.configPath);
  }
  const value = JSON.parse(f.ok(['config', '--preset', 'openrouter-value', '--allow-paid', '--json']));
  assert.equal(value.config.allowPaid, true);
  assert.deepEqual(value.config.models, {
    small: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' },
    medium: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' },
    large: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' },
  });
  assert.equal(value.config.maxOutputTokens, 8192);
  assert.equal(value.config.maxModelCalls, null);
  const override = JSON.parse(f.ok(['config', '--preset', 'openrouter-value', '--max-output-tokens', '6144', '--json']));
  assert.equal(override.config.maxOutputTokens, 6144);
  const alternative = JSON.parse(f.ok(['config', '--preset', 'openrouter-deepseek', '--json']));
  for (const route of Object.values(alternative.config.models)) assert.deepEqual(route, { provider: 'openrouter', model: 'deepseek/deepseek-v3.2' });
  await f.absent(path.join(f.state, 'credentials.json'));
  await f.absent(path.join(f.state, 'install.json'));
});

test('explicit tier routes retain paid checks and untouched routes', async t => {
  const f = await fixture(t);
  f.ok(['config', '--preset', 'claude-economy', '--json']);
  const previous = await readFile(f.configPath, 'utf8');
  const denied = f.run(['config', '--large', 'openrouter:custom/paid', '--json']);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /--allow-paid/);
  assert.equal(await readFile(f.configPath, 'utf8'), previous);
  const saved = JSON.parse(f.ok(['config', '--large', 'openrouter:custom/paid', '--allow-paid', '--max-model-calls', '24', '--json']));
  assert.deepEqual(saved.config.models.small, { provider: 'claude', model: 'haiku' });
  assert.deepEqual(saved.config.models.medium, { provider: 'claude', model: 'haiku' });
  assert.deepEqual(saved.config.models.large, { provider: 'openrouter', model: 'custom/paid' });
  assert.equal(saved.maxModelCalls, 24);
});

test('unknown or conflicting presets fail without changing saved settings', async t => {
  const f = await fixture(t);
  f.ok(['config', '--preset', 'claude-economy', '--json']);
  const previous = await readFile(f.configPath, 'utf8');
  for (const args of [
    ['--preset', 'missing'],
    ['--preset', 'codex-economy', '--provider', 'claude'],
    ['--preset', 'codex-economy', '--model', 'custom'],
  ]) {
    for (const command of ['config', 'install']) {
      const result = f.run([command, ...args, ...(command === 'install' ? ['--yes', '--agents', 'none'] : ['--json'])]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /preset/);
      assert.equal(await readFile(f.configPath, 'utf8'), previous);
      await f.absent(f.env.GIT_CONFIG_GLOBAL);
    }
  }
});

test('preset installation preserves explicit routes on an unattended rerun', async t => {
  const f = await fixture(t);
  f.ok(['install', '--yes', '--preset', 'claude-economy', '--large', 'codex:custom-reviewer', '--agents', 'none']);
  const previous = await readFile(f.configPath, 'utf8');
  const config = JSON.parse(previous);
  assert.deepEqual(config.models.small, { provider: 'claude', model: 'haiku' });
  assert.deepEqual(config.models.large, { provider: 'codex', model: 'custom-reviewer' });
  f.ok(['install', '--yes', '--agents', 'none']);
  assert.equal(await readFile(f.configPath, 'utf8'), previous);
});

test('paid preset installation checks permission and credentials before installing', async t => {
  const f = await fixture(t);
  const denied = f.run(['install', '--yes', '--preset', 'openrouter-value', '--agents', 'none']);
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /--allow-paid/);
  const missingKey = f.run(['install', '--yes', '--preset', 'openrouter-value', '--allow-paid', '--agents', 'none']);
  assert.equal(missingKey.status, 1);
  assert.match(missingKey.stderr, /OpenRouter requires a key/);
  for (const file of [f.configPath, f.env.GIT_CONFIG_GLOBAL, path.join(f.state, 'install.json')]) await f.absent(file);
});

test('free routing remains an explicit best-effort choice and help never saves presets', async t => {
  const f = await fixture(t);
  const help = JSON.parse(f.ok(['config', '--preset', 'openrouter-value', '--help', '--json']));
  assert.match(JSON.stringify(help), /openrouter-free/);
  assert.match(JSON.stringify(help), /best-effort/);
  assert.match(JSON.stringify(help), /--allow-paid/);
  await f.absent(f.configPath);
  const free = JSON.parse(f.ok(['config', '--preset', 'openrouter-free', '--json']));
  assert.equal(free.config.allowPaid, false);
  for (const route of Object.values(free.config.models)) assert.deepEqual(route, { provider: 'openrouter', model: 'openrouter/free' });  // Free router models spend most of the output budget on reasoning (CRI-58).
  assert.equal(free.config.maxOutputTokens, 16384);
});
