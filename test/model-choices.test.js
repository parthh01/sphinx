import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { modelChoices, validChoice } from '../src/model-choices.js';
import { DEFAULT_CONFIG, saveOpenRouterKey } from '../src/config.js';

test('the picker lists only providers this machine is set up for, and keeps paid models off unless allowed', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'sphinx-models-')); t.after(() => rm(home, { recursive: true, force: true }));
  const env = { SPHINX_HOME: home };
  const config = structuredClone(DEFAULT_CONFIG);
  assert.deepEqual((await modelChoices({ config, env, plans: ['claude'] })).map(group => group.provider), ['claude']);
  await saveOpenRouterKey('sk-or-test', env);
  const groups = await modelChoices({ config, env, plans: ['claude', 'codex'], current: { provider: 'openrouter', model: 'qwen/qwen3-coder' } });
  assert.deepEqual(groups.map(group => group.provider), ['claude', 'codex', 'openrouter']);
  const openrouter = groups.find(group => group.provider === 'openrouter');
  assert.ok(openrouter.models.find(model => model.model === 'qwen/qwen3-coder').disabled, 'paid model shown but off');
  assert.equal(openrouter.models.find(model => model.model === 'openrouter/free').disabled, undefined);
  assert.equal(validChoice(groups, 'claude', 'sonnet', config), null);
  assert.match(validChoice(groups, 'claude', 'haiku', config), /from the list/, 'Claude Code offers Sonnet, not Haiku');
  assert.match(validChoice(groups, 'openrouter', 'some/paid-model', config), /Paid models are off/);
  assert.equal(validChoice(groups, 'openrouter', 'some/model:free', config), null, 'any free model ID is allowed');
  assert.match(validChoice(groups, 'claude', 'opus', config), /from the list/, 'plans take listed models only');
  assert.match(validChoice(groups, 'openai', 'x', config), /from the list/, 'an unconfigured provider is refused');
  assert.match(validChoice(groups, 'openrouter', 'bad id; rm', config), /from the list/);
  assert.equal(validChoice(await modelChoices({ config: { ...config, allowPaid: true }, env, plans: [] }), 'openrouter', 'some/paid-model', { ...config, allowPaid: true }), null);
});
