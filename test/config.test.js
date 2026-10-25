import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, getPaths, loadConfig, openRouterKey, policyHash, repositoryConfigInfo, saveConfig, saveOpenRouterKey, stableStringify, validateConfig, writeJson } from '../src/config.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sphinx-config-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  await mkdir(repo);
  const env = { SPHINX_HOME: join(directory, 'state'), SPHINX_USER_HOME: join(directory, 'user'), CODEX_HOME: '/do-not-use-real-codex', CLAUDE_CONFIG_DIR: '/do-not-use-real-claude' };
  return { directory, repo, env, paths: getPaths(env) };
}

test('default configuration is free, uncapped by call count, and valid', () => {
  assert.equal(validateConfig(structuredClone(DEFAULT_CONFIG)).provider, 'openrouter');
  assert.equal(DEFAULT_CONFIG.allowPaid, false);
  assert.equal(DEFAULT_CONFIG.maxModelCalls, null);
  assert.equal(DEFAULT_CONFIG.agentMaxTurns, null);
  assert.equal(validateConfig({ ...structuredClone(DEFAULT_CONFIG), maxModelCalls: 30, agentMaxTurns: 8 }).maxModelCalls, 30);
  assert.ok(DEFAULT_CONFIG.maxOutputTokens > 0);
  for (const route of Object.values(DEFAULT_CONFIG.models)) assert.deepEqual(route, { provider: 'openrouter', model: 'openrouter/free' });
});

test('test home isolates both integrations and state without changing the real home', async t => {
  const { env, paths } = await fixture(t);
  assert.equal(paths.home, env.SPHINX_HOME);
  assert.equal(paths.codexHome, join(env.SPHINX_USER_HOME, '.codex'));
  assert.equal(paths.claudeHome, join(env.SPHINX_USER_HOME, '.claude'));
  const normal = getPaths({ CODEX_HOME: '/custom/codex', CLAUDE_CONFIG_DIR: '/custom/claude' });
  assert.equal(normal.codexHome, '/custom/codex');
  assert.equal(normal.claudeHome, '/custom/claude');
  assert.deepEqual(await loadConfig(undefined, env), DEFAULT_CONFIG);
});

test('configuration persists privately and legacy single-provider settings apply to all tiers', async t => {
  const { env, paths } = await fixture(t);
  const config = structuredClone(DEFAULT_CONFIG);
  config.level = 'thorough';
  await saveConfig(config, env);
  assert.deepEqual(await loadConfig(undefined, env), config);
  if (process.platform !== 'win32') assert.equal((await stat(paths.config)).mode & 0o777, 0o600);
  await writeJson(paths.config, { provider: 'claude', model: 'chosen-model' });
  const legacy = await loadConfig(undefined, env);
  for (const route of Object.values(legacy.models)) assert.deepEqual(route, { provider: 'claude', model: 'chosen-model' });
});

test('repository configuration cannot redirect source, raise spend, or change model budgets', async t => {
  const { repo, env } = await fixture(t);
  const forbidden = {
    provider: 'claude', model: 'expensive', allowPaid: true,
    maxOutputTokens: 16384, maxModelCalls: 100, timeoutSeconds: 600,
    maxContextBytes: 1000000, receiptHours: 720,
    models: { large: { provider: 'openrouter', model: 'vendor/paid' } },
    routing: { riskPatterns: [''] }, apiKey: 'secret', endpoint: 'https://example.invalid',
  };
  for (const [key, value] of Object.entries(forbidden)) {
    await writeJson(join(repo, '.sphinx.json'), { [key]: value });
    await assert.rejects(loadConfig(repo, env), new RegExp(`cannot set ${key}`));
  }
  await writeJson(join(repo, '.sphinx.json'), { level: 'relaxed', branches: ['release/*'], events: ['pre-commit'] });
  const config = await loadConfig(repo, env);
  assert.equal(config.level, 'relaxed');
  assert.deepEqual(config.branches, ['release/*']);
  assert.deepEqual(config.events, ['pre-commit']);
  assert.equal(config.maxModelCalls, DEFAULT_CONFIG.maxModelCalls);
});

test('repository exclusions add to global privacy exclusions instead of removing them', async t => {
  const { repo, env, paths } = await fixture(t);
  await writeJson(paths.config, { exclude: ['private/**', 'customer-data.json'] });
  await writeJson(join(repo, '.sphinx.json'), { exclude: ['fixtures/**'] });
  const config = await loadConfig(repo, env);
  assert.deepEqual(new Set(config.exclude), new Set(['private/**', 'customer-data.json', 'fixtures/**']));
  await writeJson(join(repo, '.sphinx.json'), { exclude: [] });
  assert.deepEqual((await loadConfig(repo, env)).exclude, ['private/**', 'customer-data.json']);
});

test('canonical repository policy overrides globals and completely shadows legacy policy', async t => {
  const { repo, env, paths } = await fixture(t);
  await writeJson(paths.config, { level: 'thorough', exclude: ['private/**'] });
  await writeJson(join(repo, '.sphinx.json'), { branches: ['legacy'], mode: 'advisory', exclude: ['legacy/**'] });
  await writeJson(join(repo, '.sphinxconfig'), { branches: ['main'], events: ['pre-commit'], exclude: ['generated/**'] });
  const config = await loadConfig(repo, env);
  assert.deepEqual(config.branches, ['main']);
  assert.deepEqual(config.events, ['pre-commit']);
  assert.equal(config.level, 'thorough');
  assert.equal(config.mode, 'block', 'A missing canonical field inherits globals, never legacy fields');
  assert.deepEqual(config.exclude, ['private/**', 'generated/**']);
  assert.deepEqual(await repositoryConfigInfo(repo), {
    path: join(repo, '.sphinxconfig'), exists: true, legacy: false, shadowed: join(repo, '.sphinx.json'),
  });
  await writeFile(join(repo, '.sphinx.json'), 'invalid shadowed legacy JSON');
  assert.deepEqual((await loadConfig(repo, env)).branches, ['main']);
});

test('repository configuration metadata identifies absent and legacy files', async t => {
  const { repo } = await fixture(t);
  assert.deepEqual(await repositoryConfigInfo(repo), { path: join(repo, '.sphinxconfig'), exists: false, legacy: false });
  await writeJson(join(repo, '.sphinx.json'), { branches: ['release/*'] });
  assert.deepEqual(await repositoryConfigInfo(repo), { path: join(repo, '.sphinx.json'), exists: true, legacy: true });
});

test('canonical repository policy refuses unsafe keys and malformed values without legacy fallback', async t => {
  const { repo, env } = await fixture(t);
  await writeJson(join(repo, '.sphinx.json'), { branches: ['fallback'] });
  for (const local of [
    { provider: 'claude' }, { model: 'paid' }, { models: {} }, { routing: {} }, { maxModelCalls: 100 },
    { allowPaid: true }, { apiKey: 'secret' }, { enabled: 'yes' }, { branches: 'main' },
    { events: ['post-commit'] }, { exclude: [4] }, { level: 'impossible' }, [], null,
  ]) {
    await writeJson(join(repo, '.sphinxconfig'), local);
    await assert.rejects(loadConfig(repo, env), /cannot set|configuration|JSON object/i);
  }
  await writeFile(join(repo, '.sphinxconfig'), 'invalid JSON');
  await assert.rejects(loadConfig(repo, env), /invalid JSON/);
});

test('canonical and legacy policy symlinks are refused without reading their targets', async t => {
  const { repo, env } = await fixture(t);
  const target = join(repo, '.env');
  await writeFile(target, 'SECRET_POLICY_TARGET');
  for (const filename of ['.sphinxconfig', '.sphinx.json']) {
    const file = join(repo, filename);
    await symlink(target, file);
    await assert.rejects(loadConfig(repo, env), error => {
      assert.match(error.message, /symlink/);
      assert.ok(!error.message.includes('SECRET_POLICY_TARGET'));
      return true;
    });
    await rm(file);
  }
});

test('unknown keys at every configuration nesting level are rejected', () => {
  for (const mutate of [
    c => { c.hiddenOption = true; },
    c => { c.models.unlisted = { provider: 'claude', model: null }; },
    c => { c.models.small.hiddenOption = true; },
    c => { c.routing.hiddenOption = true; },
  ]) {
    const config = structuredClone(DEFAULT_CONFIG);
    mutate(config);
    assert.throws(() => validateConfig(config), /unknown|unexpected/i);
  }
});

test('invalid token, timeout, spend, and routing settings fail validation', () => {
  const invalid = [
    ['allowPaid', 'false'], ['maxOutputTokens', 0], ['maxOutputTokens', 16385],
    ['maxModelCalls', 0], ['maxModelCalls', 101], ['timeoutSeconds', 0], ['timeoutSeconds', 601],
    ['maxContextBytes', 999], ['maxContextBytes', 1000001], ['maxOutputTokens', 512.5],
    ['provider', 'unknown'], ['model', '   '], ['events', ['post-commit']],
    ['backgroundPreparation','yes'], ['agentMaxTurns',1], ['agentMaxTurns',51], ['maxModelCalls','20'],
    ['toolResultBytes',999], ['toolResultBytes',64001], ['preparationDebounceMs',-1], ['preparationDebounceMs',60001],
  ];
  for (const [key, value] of invalid) assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), [key]: value }), /Invalid Sphinx configuration/);
  const badThreshold = structuredClone(DEFAULT_CONFIG);
  badThreshold.routing.largeMinLines = badThreshold.routing.smallMaxLines;
  assert.throws(() => validateConfig(badThreshold), /thresholds/);
});

test('repositories may opt out of preparation but cannot override a machine-wide opt-out', async t => {
  const { repo, env, paths } = await fixture(t);
  await writeJson(join(repo, '.sphinxconfig'), { backgroundPreparation: false });
  assert.equal((await loadConfig(repo, env)).backgroundPreparation, false);
  await writeJson(paths.config, { backgroundPreparation: false });
  await writeJson(join(repo, '.sphinxconfig'), { backgroundPreparation: true });
  assert.equal((await loadConfig(repo, env)).backgroundPreparation, false);
});

test('malformed config document shapes fail before merging defaults', async t => {
  const { repo, env, paths } = await fixture(t);
  for (const value of [[], null, 'not an object', { routing: null }, { models: null }, { routing: [] }, { models: [] }]) {
    await writeJson(paths.config, value);
    await assert.rejects(loadConfig(undefined, env), /configuration|object|required|routing|models/i);
  }
  await writeJson(paths.config, {});
  for (const value of [[], null, 'not an object']) {
    await writeJson(join(repo, '.sphinx.json'), value);
    await assert.rejects(loadConfig(repo, env), /configuration|object/i);
  }
});

test('policy hashes ignore object-key ordering and cover only what a check asks', () => {
  const original = structuredClone(DEFAULT_CONFIG);
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(policyHash(original), policyHash(reordered));
  // Which operations and files are checked, and how deep: these change the hash.
  const assessment = { version: 2, enabled: false, mode: 'other', events: ['pre-commit'], branches: ['release/*'], remotes: ['upstream'], exclude: ['private/**'], level: 'relaxed', distance: 'low', routing: { ...original.routing, largeMinLines: 200 } };
  // Reviewer routes and run settings do not, so changing them keeps prepared checks and passes.
  const run = { provider: 'claude', model: 'another-model', models: { ...original.models, large: { provider: 'claude', model: 'sonnet' } }, audit: 'all', maxContextBytes: 50000, timeoutSeconds: 60, receiptHours: 1, maxModelCalls: 5, maxOutputTokens: 8192, allowPaid: true, cliBilling: 'api', agentMaxTurns: 4, toolResultBytes: 8000, backgroundPreparation: false, preparationDebounceMs: 0, workingContext: false, interface: 'terminal', github: { status: false, comment: true, answers: true } };
  // A new setting must be placed in one group or the other.
  assert.deepEqual([...Object.keys(assessment), ...Object.keys(run)].sort(), Object.keys(original).sort());
  for (const [key, value] of Object.entries(assessment)) assert.notEqual(policyHash({ ...original, [key]: value }), policyHash(original), key);
  for (const [key, value] of Object.entries(run)) assert.equal(policyHash({ ...original, [key]: value }), policyHash(original), key);
});

test('assessment contract invalidates old caches while call-ceiling edits preserve current identity', () => {
  const legacy = { ...structuredClone(DEFAULT_CONFIG), maxModelCalls: 10 };
  // Compute the pre-upgrade representation independently of policyHash.
  const historicalHash = createHash('sha256').update(stableStringify(legacy)).digest('hex');
  const currentHash = policyHash(legacy);
  assert.notEqual(currentHash, historicalHash);
  for (const maxModelCalls of [1, 9, 10, 20, 100]) {
    assert.equal(policyHash({ ...legacy, maxModelCalls }), currentHash);
  }
});

test('saved credentials are private, env wins, and keys stay out of config', async t => {
  const { env, paths } = await fixture(t);
  const key = 'test-private-key';
  await saveOpenRouterKey(` ${key} `, env);
  assert.equal(await openRouterKey(env), key);
  assert.equal(await openRouterKey({ ...env, OPENROUTER_API_KEY: 'override-key' }), 'override-key');
  if (process.platform !== 'win32') assert.equal((await stat(paths.credentials)).mode & 0o777, 0o600);
  await saveConfig(structuredClone(DEFAULT_CONFIG), env);
  assert.ok(!(await readFile(paths.config, 'utf8')).includes(key));
  for (const invalid of ['', 'contains spaces', 'contains\nnewline']) await assert.rejects(saveOpenRouterKey(invalid, env), /valid OpenRouter API key/);
});

test('malformed credential files never echo their content in errors', async t => {
  const { env, paths } = await fixture(t);
  await mkdir(paths.home, { recursive: true });
  const secret = 'malformed-secret-key';
  await writeFile(paths.credentials, secret);
  await assert.rejects(openRouterKey(env), error => {
    assert.ok(!error.message.includes(secret), 'Credential parsing must not echo secret content');
    assert.match(error.message, /credential|auth/i);
    return true;
  });
});

test('advisory mode was removed and fails with a pointer to yolo', () => {
  assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), mode: 'advisory' }), /advisory" was removed.*sphinx yolo/);
});

test('understanding distance defaults to mixed, accepts high and low, and a repository can override it', async t => {
  assert.equal(DEFAULT_CONFIG.distance, 'mixed');
  for (const value of ['high', 'low']) assert.equal(validateConfig({ ...structuredClone(DEFAULT_CONFIG), distance: value }).distance, value);
  assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), distance: 'medium' }), /distance must be high, mixed, low/);
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadConfig } = await import('../src/config.js');
  const dir = await mkdtemp(join(tmpdir(), 'sphinx-distance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, '.sphinxconfig'), JSON.stringify({ version: 1, distance: 'low' }));
  assert.equal((await loadConfig(dir, { SPHINX_HOME: join(dir, 'home') })).distance, 'low');
});
