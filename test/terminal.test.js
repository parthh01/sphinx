import test from 'node:test';
import assert from 'node:assert/strict';
import { colorEnabled, createTerminal, stripAnsi, wrapText, withProgress, formatError, SPHINX } from '../src/terminal.js';
import { printHelp, HELP } from '../src/help.js';
import { askInstall, askPolicy, createPrompts } from '../src/prompts.js';
import { applyInstallOptions } from '../src/cli.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { presetOptions } from '../src/model-presets.js';
import { modelUsageText, modelLimitText } from '../src/usage.js';

function capture({ width = 80, env = {}, tty = false } = {}) {
  let text = '';
  const stream = { isTTY: tty, columns: width, write(value) { text += value; } };
  return { stream, ui: createTerminal({ stream, env }), text: () => text };
}

test('human usage shows tokens and cost, and calls only when a cap is set', () => {
  assert.equal(modelUsageText({ calls: 20, limit: null }, { input: 11800, output: 600, cost: 0.0031 }), '12.4k tokens · $0.0031');
  assert.equal(modelUsageText({ calls: 7, limit: 30 }, { input: 900, output: 50, cost: null }), '950 tokens · 7/30 calls');
  assert.equal(modelUsageText({ calls: 3, limit: null }, { input: 2_000_000, output: 0, cost: 1.5 }), '2.0M tokens · $1.50');
  assert.equal(modelUsageText({ calls: 1, limit: null }, { input: 53, output: 6, cost: 0.00001116 }), '59 tokens · <$0.0001');
  assert.equal(modelUsageText({ calls: 1, limit: null }, { input: 53, output: 6, cost: 0 }), '59 tokens · $0');
  assert.equal(modelLimitText(null), 'no limit');
  assert.equal(modelLimitText(30), '30 model calls per assessment');
});

test('color follows terminal, NO_COLOR, TERM=dumb, and explicit FORCE_COLOR policy', () => {
  assert.equal(colorEnabled({ stream: { isTTY: true }, env: {} }), true);
  assert.equal(colorEnabled({ stream: { isTTY: false }, env: {} }), false);
  assert.equal(colorEnabled({ stream: { isTTY: true }, env: { TERM: 'dumb' } }), false);
  assert.equal(colorEnabled({ stream: { isTTY: false }, env: { FORCE_COLOR: '1' } }), true);
  assert.equal(colorEnabled({ stream: { isTTY: true }, env: { FORCE_COLOR: '0' } }), false);
  assert.equal(colorEnabled({ stream: { isTTY: true }, env: { FORCE_COLOR: '1', NO_COLOR: '1' } }), false);
  assert.equal(colorEnabled({ stream: { isTTY: true }, env: { NO_COLOR: '' } }), false);
});

test('wrapping respects visible width, long tokens, indentation, and blank paragraphs', () => {
  const text = wrapText('\x1b[1mA rather long sentence\x1b[0m\n\n' + 'x'.repeat(100), 24, '  ');
  assert.ok(text.split('\n').every(line => stripAnsi(line).length <= 24));
  assert.ok(text.includes('\n\n'));
  assert.equal(stripAnsi(text).replace(/\s/g, ''), 'Aratherlongsentence' + 'x'.repeat(100));
});

test('main help has the sphinx mark and command help stays scoped at narrow widths', () => {
  const main = capture(); printHelp(main.ui);
  assert.ok(main.text().includes(SPHINX[0]));
  assert.match(main.text(), /Get started/);
  for (const width of [24, 40, 60, 80]) {
    for (const command of Object.keys(HELP)) {
      const output = capture({ width, env: { FORCE_COLOR: '1' } });
      printHelp(output.ui, command);
      assert.ok(stripAnsi(output.text()).includes(`sphinx ${command}`));
      assert.equal(output.text().includes(SPHINX[0]), false);
      assert.ok(output.text().split('\n').every(line => stripAnsi(line).length <= width), `${command} overflowed ${width} columns`);
    }
  }
});

test('check help names /stop for a waiting Git operation and says what stop means after a pass', () => {
  const output = capture(); printHelp(output.ui, 'check');
  const text = stripAnsi(output.text()).replace(/\s+/g, ' ');
  assert.match(text, /\/stop While a Git operation waits: stop it now\. It does not go through, and progress is saved\. \/quit does the same\./);
  assert.match(text, /a pass \(including one that needs no questions\) asks you to continue or stop it, within its time limit; stop means it does not go through, and the pass is kept, so the next push or commit of that change asks only whether to continue\./);
});

test('status rows and narrow banners fit without decorative boxes or blue colors', () => {
  for (const width of [20, 24, 30, 40, 65, 80]) {
    const output = capture({ width, env: { FORCE_COLOR: '1' } });
    output.ui.banner();
    output.ui.rows([['Repository policy', '/long/path/'.repeat(15)], ['Current local branch', 'release/next-version']]);
    assert.ok(output.text().split('\n').every(line => stripAnsi(line).length <= width), `overflowed ${width} columns`);
    assert.equal(output.text().includes('\x1b[34m'), false);
  }
});

test('model progress uses only a live terminal and is suppressed for machine output', async () => {
  const pipe = capture(); await withProgress('Preparing questions', async () => 42, { stream: pipe.stream, env: {} });
  assert.equal(pipe.text(), '');
  const terminal = capture({ tty: true });
  assert.equal(await withProgress('Preparing questions', async () => 42, { stream: terminal.stream, env: {} }), 42);
  assert.match(stripAnsi(terminal.text()), /Preparing questions/);
  const machine = capture({ tty: true });
  await withProgress('Must not print', async () => 42, { stream: machine.stream, env: { FORCE_COLOR: '1' }, enabled: false });
  assert.equal(machine.text(), '');
});

test('plain protocol errors never contain ANSI despite forced color', () => {
  const output = capture({ tty: true });
  formatError(new Error('Unknown option --wat'), { stream: output.stream, env: { FORCE_COLOR: '1' }, plain: true });
  assert.equal(output.text().includes('\x1b'), false);
  assert.match(output.text(), /Sphinx: Unknown option --wat/);
});

test('numbered prompts validate choices and retry without accepting invalid input', async () => {
  const output = capture(), answers = ['99', 'nonsense', '2'];
  const prompts = createPrompts({ ui: output.ui, ask: async () => answers.shift() });
  const result = await prompts.choose({ title: 'Depth', current: 'standard', choices: [
    { value: 'relaxed', label: 'Relaxed', description: 'Up to 2 questions.' },
    { value: 'standard', label: 'Standard', description: 'Up to 3 questions.' },
  ] });
  assert.equal(result, 'standard');
  assert.equal((output.text().match(/Enter a number/g) || []).length, 2);
  assert.match(output.text(), /Standard \(default\)/);
});

test('required choices never accept Enter or display a default', async () => {
  const output = capture(), answers = ['', 'invalid', 'paid'];
  const prompts = createPrompts({ ui: output.ui, ask: async prompt => {
    assert.equal(prompt, '\nChoose: ');
    return answers.shift();
  } });
  assert.equal(await prompts.choose({ title: 'Models', requireSelection: true, current: 'paid', choices: [
    { value: 'paid', label: 'Paid route', description: 'Uses API credits.' },
    { value: 'free', label: 'Free route', description: 'Best effort.' },
  ] }), 'paid');
  assert.equal((output.text().match(/Enter a number/g) || []).length, 2);
  assert.doesNotMatch(output.text(), /default|press Enter/);
});

test('text prompts reject bad routes before returning a valid option', async () => {
  const output = capture(), answers = ['invalid', 'claude:sonnet'];
  const prompts = createPrompts({ ui: output.ui, ask: async () => answers.shift() });
  const value = await prompts.text({ title: 'Route', current: 'codex', validate: input => { if (!input.includes(':')) throw new Error('Use provider:model.'); } });
  assert.equal(value, 'claude:sonnet'); assert.match(output.text(), /Use provider:model/);
});

test('accepting onboarding defaults preserves existing per-tier models and reversed event order', async () => {
  const current = structuredClone(DEFAULT_CONFIG);
  current.maxModelCalls = 12;
  current.agentMaxTurns = 6;
  current.events = ['pre-commit', 'pre-push'];
  current.models = { small: { provider: 'openrouter', model: 'openrouter/free' }, medium: { provider: 'claude', model: 'sonnet' }, large: { provider: 'codex', model: 'custom-model' } };
  const output = capture();
  const values = await askInstall(current, {}, createPrompts({ ui: output.ui, ask: async () => '' }), { hasExistingConfig: true });
  const updated = applyInstallOptions(current, values);
  assert.deepEqual(updated.models, current.models);
  assert.deepEqual(updated.events, current.events);
  assert.equal(updated.maxModelCalls, 12);
  assert.equal(updated.agentMaxTurns, 6);
  assert.match(output.text().replace(/\s+/g, ' '), /no model-call cap by default/);
  assert.deepEqual(current.models.large, { provider: 'codex', model: 'custom-model' });
});

test('agent checkboxes accept arbitrary combinations, preselect detection, and skip when flags are explicit', async () => {
  const initial = { provider: 'claude', events: 'pre-push', branches: 'main', remotes: '*', level: 'standard', distance: 'high', mode: 'block' };
  let selections = 0;
  const output = capture();
  const prompts = createPrompts({ ui: output.ui, ask: () => assert.fail('other choices were supplied'), select: async options => {
    selections++;
    assert.equal(options.title, 'Which coding agents do you use?');
    assert.deepEqual(options.current, ['claude', 'pi']);
    assert.deepEqual(options.choices.map(choice => choice.value), ['codex', 'claude', 'pi', 'cursor', 'opencode']);
    return ['pi', 'cursor', 'opencode'];
  } });
  const result = await askInstall(DEFAULT_CONFIG, initial, prompts, { detectedAgents: ['claude', 'pi'] });
  assert.equal(result.agents, 'pi,cursor,opencode');
  assert.doesNotThrow(() => applyInstallOptions(DEFAULT_CONFIG, result));
  for (const agents of ['auto', 'none', 'codex,pi']) assert.equal((await askInstall(DEFAULT_CONFIG, { ...initial, agents }, prompts)).agents, agents);
  assert.equal(selections, 1);
  const cleared = await askInstall(DEFAULT_CONFIG, initial, { multiselect: async () => [] });
  assert.equal(cleared.agents, 'none');
});

test('checkbox line fallback toggles any agents and all without accepting partially invalid input', async () => {
  const choices = ['codex', 'claude', 'pi', 'cursor', 'opencode'].map(value => ({ value, label: value, description: '' }));
  const output = capture({ width: 40 });
  const answers = ['codex,invalid', '1', '6', ''];
  const selected = await createPrompts({ ui: output.ui, ask: async () => answers.shift() }).multiselect({ title: 'Agents', choices, current: ['codex'] });
  assert.deepEqual(selected, ['codex', 'claude', 'pi', 'cursor']);
  assert.match(output.text(), /1\. \[-\] All supported agents/);
  assert.match(output.text(), /1\. \[x\] All supported agents/);
  assert.match(output.text(), /Choose numbers/);
  assert.ok(output.text().split('\n').every(line => stripAnsi(line).length <= 40));
  const none = ['all', 'none', ''];
  assert.deepEqual(await createPrompts({ ui: output.ui, ask: async () => none.shift() }).multiselect({ title: 'Agents', choices }), []);
});

test('onboarding keeps intentionally empty branches and remotes on Enter', async () => {
  const current = { ...structuredClone(DEFAULT_CONFIG), branches: [], remotes: [], events: [] };
  const output = capture();
  const values = await askPolicy(current, {}, createPrompts({ ui: output.ui, ask: async () => '' }));
  const updated = applyInstallOptions(current, values);
  assert.deepEqual(updated.events, []); assert.deepEqual(updated.branches, []); assert.deepEqual(updated.remotes, []);
});

test('explicit model flags alter only their requested routes and reject invalid settings before setup', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const updated = applyInstallOptions(config, { large: 'claude:opus' });
  assert.deepEqual(updated.models.small, config.models.small);
  assert.deepEqual(updated.models.large, { provider: 'claude', model: 'opus' });
  const all = applyInstallOptions(config, { provider: 'codex' });
  for (const route of Object.values(all.models)) assert.deepEqual(route, { provider: 'codex', model: 'gpt-6-luna' });
  assert.throws(() => applyInstallOptions(config, { agents: 'unknown' }), /--agents/);
  assert.throws(() => applyInstallOptions(config, { large: 'openrouter:paid-model' }), /allow-paid/);
  assert.throws(() => applyInstallOptions(config, { level: 'anything' }), /level/);
});

test('guided setup defers branch, remote, and depth questions unless the human customizes', async () => {
  const output = capture(), answers = ['2', '', 'release/*', 'origin', 'thorough', 'low'];
  const values = await askInstall(DEFAULT_CONFIG, { agents: 'none', preset: 'claude-economy' }, createPrompts({ ui: output.ui, ask: async () => answers.shift() }), { hasExistingConfig: false });
  assert.match(output.text().replace(/\s+/g, ' '), /Before pushes to main, master on any remote, at standard depth, mixed questions\./);
  assert.match(output.text(), /When should Sphinx run\?/);
  assert.deepEqual(applyInstallOptions(DEFAULT_CONFIG, values).branches, ['release/*']);
  assert.equal(values.level, 'thorough');
  assert.equal(values.distance, 'low', 'Customizing also asks how close to the code questions get');
  const kept = await askInstall(DEFAULT_CONFIG, { agents: 'none', preset: 'claude-economy' }, createPrompts({ ui: capture().ui, ask: async () => '' }), { hasExistingConfig: false });
  assert.deepEqual(applyInstallOptions(DEFAULT_CONFIG, kept).branches, DEFAULT_CONFIG.branches);
  assert.equal(kept.events, undefined);
});

const onboardingPolicy = { events: 'pre-push', branches: 'main', remotes: '*', level: 'standard', distance: 'high', mode: 'block' };

test('fresh onboarding asks agents first, recommends economical CLI models, then offers recommended checkpoints', async () => {
  for (const agent of ['codex', 'claude']) {
    const order = [];
    const values = await askInstall(DEFAULT_CONFIG, {}, {
      multiselect: async options => { order.push(options.title); return [agent]; },
      choose: async options => { order.push(options.title); assert.equal(options.requireSelection ?? false, false); return options.current; },
      text: async options => { order.push(options.title); return options.current; },
    }, { hasExistingConfig: false });
    assert.deepEqual(order, ['Which coding agents do you use?', 'Choose your evaluator models', 'When should Sphinx check your understanding?']);
    for (const key of ['events', 'branches', 'remotes', 'level']) assert.equal(values[key], undefined);
    assert.equal(values.agents, agent);
    assert.equal(values.preset, `${agent}-economy`);
    for (const tier of ['small', 'medium', 'large']) assert.equal(values[tier], presetOptions(`${agent}-economy`)[tier]);
    assert.equal(values['allow-paid'], undefined);
    const configured = applyInstallOptions(DEFAULT_CONFIG, values);
    assert.equal(configured.provider, agent);
    assert.equal(configured.model, configured.models.small.model);
    const next = applyInstallOptions(configured, { model: 'custom-followup-model' });
    for (const route of Object.values(next.models)) assert.deepEqual(route, { provider: agent, model: 'custom-followup-model' });
  }
});

test('fresh auto agent selection uses detection for the economical evaluator default', async () => {
  const values = await askInstall(DEFAULT_CONFIG, { ...onboardingPolicy, agents: 'auto' }, {
    choose: async options => { assert.equal(options.current, 'claude-economy'); return options.current; },
  }, { hasExistingConfig: false, detectedAgents: ['claude', 'pi'] });
  assert.equal(values.small, presetOptions('claude-economy').small);
});

test('other integrations require a deliberate evaluator choice and paid presets enable only their chosen routes', async () => {
  for (const agents of ['pi', 'cursor', 'opencode', 'pi,cursor,opencode', 'none']) {
    const output = capture(), answers = ['', 'openrouter-value'];
    const values = await askInstall(DEFAULT_CONFIG, { ...onboardingPolicy, agents }, createPrompts({ ui: output.ui, ask: async () => answers.shift() }), { hasExistingConfig: false });
    assert.match(output.text(), /Enter a number/);
    assert.doesNotMatch(output.text(), /\(default\)/);
    assert.match(output.text(), /choosing one enables paid requests/);
    assert.equal(values['allow-paid'], true);
    for (const tier of ['small', 'medium', 'large']) assert.equal(values[tier], presetOptions('openrouter-value')[tier]);
    assert.equal(values.agents, agents);
  }
});

test('explicit preset and route flags skip the evaluator picker and remain authoritative', async () => {
  for (const flags of [{ preset: 'claude-economy' }, { provider: 'codex' }, { model: 'custom-model' }, { small: 'claude:haiku', medium: 'codex:custom-model', large: 'openrouter:vendor/model:free' }]) {
    const initial = { ...onboardingPolicy, agents: 'none', ...flags };
    const values = await askInstall(DEFAULT_CONFIG, initial, {
      choose: () => assert.fail('explicit routes must skip the evaluator picker'),
      multiselect: () => assert.fail('explicit agents must skip checkboxes'),
      text: () => assert.fail('explicit policy must skip text prompts'),
    }, { hasExistingConfig: false });
    assert.deepEqual(values, initial);
  }
});

test('partial tier flags preserve saved defaults but require a choice for fresh unset tiers', async () => {
  const initial = { ...onboardingPolicy, agents: 'claude', small: 'codex:custom-small' };
  assert.deepEqual(await askInstall(DEFAULT_CONFIG, initial, {
    choose: () => assert.fail('saved remaining tiers must stay unchanged'),
  }, { hasExistingConfig: true }), initial);
  let choices = 0;
  const values = await askInstall(DEFAULT_CONFIG, initial, {
    choose: async options => { choices++; assert.equal(options.current, 'claude-economy'); return options.current; },
  }, { hasExistingConfig: false });
  assert.equal(choices, 1);
  const configured = applyInstallOptions(DEFAULT_CONFIG, values);
  assert.deepEqual(configured.models.small, { provider: 'codex', model: 'custom-small' });
  for (const tier of ['medium', 'large']) assert.deepEqual(configured.models[tier], { provider: 'claude', model: 'haiku' });
});

test('fresh partial tiers retain overrides when deliberately selecting a paid preset', async () => {
  const values = await askInstall(DEFAULT_CONFIG, { ...onboardingPolicy, agents: 'none', large: 'claude:haiku' }, {
    choose: async () => 'openrouter-value',
  }, { hasExistingConfig: false });
  assert.equal(values.large, 'claude:haiku');
  assert.equal(values['allow-paid'], true);
  const configured = applyInstallOptions(DEFAULT_CONFIG, values);
  assert.equal(configured.allowPaid, true);
  for (const tier of ['small', 'medium']) assert.equal(configured.models[tier].provider, 'openrouter');
  assert.deepEqual(configured.models.large, { provider: 'claude', model: 'haiku' });
});

test('custom selection asks only for missing tiers and includes explicit paid tiers in consent', async () => {
  const asked = [];
  let permissions = 0;
  const values = await askInstall(DEFAULT_CONFIG, { ...onboardingPolicy, agents: 'none', small: 'openrouter:vendor/paid-model' }, {
    choose: async options => {
      if (options.title === 'Enable paid OpenRouter requests?') { permissions++; return 'allow'; }
      return 'custom';
    },
    text: async options => { asked.push(options.title); return 'claude:haiku'; },
  }, { hasExistingConfig: false });
  assert.deepEqual(asked, ['Evaluator for medium changes', 'Evaluator for large changes']);
  assert.equal(values.small, 'openrouter:vendor/paid-model');
  assert.equal(values.medium, 'claude:haiku');
  assert.equal(values.large, 'claude:haiku');
  assert.equal(permissions, 1);
  assert.equal(values['allow-paid'], true);
});

test('custom paid routes default back to model choice without enabling spending', async () => {
  let picks = 0;
  const values = await askInstall(DEFAULT_CONFIG, { ...onboardingPolicy, agents: 'none' }, {
    choose: async options => {
      if (options.title === 'Enable paid OpenRouter requests?') { assert.equal(options.current, 'back'); return options.current; }
      return picks++ === 0 ? 'custom' : 'openrouter-free';
    },
    text: async () => 'openrouter:vendor/paid-model',
  }, { hasExistingConfig: false });
  assert.equal(picks, 2);
  assert.equal(values['allow-paid'], undefined);
  for (const tier of ['small', 'medium', 'large']) assert.equal(values[tier], 'openrouter:openrouter/free');
});

test('custom paid routes require explicit permission unless machine-wide permission already exists', async () => {
  for (const allowed of [false, true]) {
    let permissions = 0;
    const values = await askInstall({ ...DEFAULT_CONFIG, allowPaid: allowed }, { ...onboardingPolicy, agents: 'none' }, {
      choose: async options => {
        if (options.title === 'Enable paid OpenRouter requests?') { permissions++; return 'allow'; }
        return 'custom';
      },
      text: async () => 'openrouter:vendor/paid-model',
    });
    assert.equal(permissions, allowed ? 0 : 1);
    assert.equal(values['allow-paid'], allowed ? undefined : true);
    for (const tier of ['small', 'medium', 'large']) assert.equal(values[tier], 'openrouter:vendor/paid-model');
  }
});

test('setup recommends an installed coding plan even when the user works in another agent', async () => {
  let seen;
  const values = await askInstall(DEFAULT_CONFIG, { agents: 'cursor', ...onboardingPolicy }, {
    choose: async options => { if (options.title === 'Choose your evaluator models') seen = options; return options.current; },
    multiselect: async () => [], text: async options => options.current,
  }, { hasExistingConfig: false, installedPlans: ['claude'] });
  assert.equal(seen.current, 'claude-economy');
  assert.equal(seen.choices[0].value, 'claude-economy');
  assert.match(seen.choices[0].label, /\(recommended\)/);
  assert.equal(values.preset, 'claude-economy');
  assert.ok(seen.choices.some(choice => /free router \(slow, best effort\)/.test(choice.label)));
});
