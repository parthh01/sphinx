import { parseRoute, questionLimit } from './routing.js';
import { reviewerTurnLimit } from './reviewer-limits.js';
import { REVIEWER_PRESETS, presetOptions } from './model-presets.js';
import { DISTANCES } from './config.js';

export const routeText = route => `${route.provider}${route.model ? `:${route.model}` : ''}`;
export const splitList = value => String(value).split(',').map(item => item.trim()).filter(Boolean);
export const questionCapsText = level => ['small', 'medium', 'large'].map(tier => `${tier} ${questionLimit(level, tier)}`).join(', ');
export const reviewCapsText = config => ['small', 'medium', 'large'].map(tier => `${tier} ${Math.min(config.agentMaxTurns ?? 8, reviewerTurnLimit(tier, config.agentMaxTurns ?? 8) + 2)}`).join(', ');

export function createPrompts({ ask, ui, select }) {
  async function choose({ title, description, choices, current, requireSelection = false }) {
    ui.section(title); if (description) ui.paragraph(description);
    const selected = requireSelection ? -1 : Math.max(0, choices.findIndex(choice => choice.value === current));
    ui.blank();
    ui.rows(choices.map((choice, index) => [`${index + 1}. ${choice.label}${index === selected ? ' (default)' : ''}`, choice.description]));
    for (;;) {
      const answer = (await ask(selected < 0 ? '\nChoose: ' : `\nChoose [${selected + 1}]: `)).trim();
      if (!answer && selected >= 0) return choices[selected].value;
      const exact = choices.find(choice => choice.value.toLowerCase() === answer.toLowerCase());
      const number = /^\d+$/.test(answer) ? Number(answer) : 0;
      if (exact) return exact.value;
      if (number >= 1 && number <= choices.length) return choices[number - 1].value;
      ui.warning(`Enter a number from 1 to ${choices.length}${selected < 0 ? '.' : `, or press Enter for ${choices[selected].label}.`}`);
    }
  }
  async function text({ title, description, current, validate = value => value }) {
    ui.section(title); if (description) ui.paragraph(description);
    for (;;) {
      const value = (await ask(`\nValue [${current || 'none'}]: `)).trim() || current;
      try { validate(value); return value; } catch (error) { ui.warning(error.message); }
    }
  }
  async function multiselect(options) {
    if (select) return select(options);
    // Accessible line-input fallback for dumb terminals and redirected output.
    const { title, description, choices, current = [] } = options;
    const selected = new Set(current.filter(value => choices.some(choice => choice.value === value)));
    ui.section(title); if (description) ui.paragraph(description);
    ui.note('Toggle numbers or names separated by commas. all selects every agent; none clears the list. Enter confirms.');
    for (;;) {
      ui.blank();
      const all = selected.size === choices.length, partial = selected.size > 0;
      ui.rows([
        [`1. [${all ? 'x' : partial ? '-' : ' '}] All supported agents`, 'Select or clear every agent.'],
        ...choices.map((choice, index) => [`${index + 2}. [${selected.has(choice.value) ? 'x' : ' '}] ${choice.label}`, choice.description]),
      ]);
      const answer = (await ask('\nToggle selection (Enter to confirm): ')).trim().toLowerCase();
      if (!answer) return choices.filter(choice => selected.has(choice.value)).map(choice => choice.value);
      if (answer === 'all') { choices.forEach(choice => selected.add(choice.value)); continue; }
      if (answer === 'none') { selected.clear(); continue; }
      const toggles = answer.split(/[\s,]+/u).filter(Boolean).map(value => {
        if (/^\d+$/.test(value)) return Number(value) - 1;
        const index = choices.findIndex(choice => choice.value.toLowerCase() === value);
        return index === -1 ? -1 : index + 1;
      });
      if (toggles.some(index => index < 0 || index > choices.length)) { ui.warning('Choose numbers from the list, agent names, all, or none.'); continue; }
      for (const index of new Set(toggles)) {
        if (index === 0) { if (selected.size === choices.length) selected.clear(); else choices.forEach(choice => selected.add(choice.value)); }
        else { const value = choices[index - 1].value; if (selected.has(value)) selected.delete(value); else selected.add(value); }
      }
    }
  }
  return { choose, text, multiselect };
}

const lists = value => { if (!splitList(value).length) throw new Error('Enter at least one comma-separated value.'); if (/\s/.test(splitList(value).join(''))) throw new Error('Use commas between patterns; patterns cannot contain spaces.'); };

export async function askPolicy(config, initial, prompts, { scope = 'repository' } = {}) {
  const values = { ...initial };
  if (values.events === undefined) {
    const original = config.events.join(',');
    const current = config.events.includes('pre-push') && config.events.includes('pre-commit') ? 'pre-push,pre-commit' : original;
    const selected = await prompts.choose({
    title: 'When should Sphinx run?', description: 'Git decides deterministically when a checkpoint is needed. The Git gate makes no model calls.', current,
    choices: [
      { value: 'pre-push', label: 'Before pushing', description: 'Check commits when they leave your machine for a matching destination branch.' },
      { value: 'pre-commit', label: 'Before committing', description: 'Check staged changes on a matching local branch. More frequent checkpoints.' },
      { value: 'pre-push,pre-commit', label: 'Before both', description: 'Check both boundaries. Commit and push snapshots may require separate assessments.' },
      ...(config.events.length ? [] : [{ value: '', label: 'Keep checkpoints disabled', description: 'Preserve the current empty event policy.' }]),
    ],
    });
    values.events = selected === current ? original : selected;
  }
  const branchScope = scope === 'global'
    ? 'By default, Sphinx runs on pushes to the destination branch names below. Each repository can override these machine-wide defaults by setting branches in .sphinxconfig to its own production branch name.'
    : 'Choose the destination branches that should trigger push checks in this repository. These override your machine-wide defaults and are saved as branches in .sphinxconfig. Use this project\'s production branch name.';
  const remoteScope = scope === 'global'
    ? 'By default, push checks apply to the remote names below. These are machine-wide defaults; each repository can override remotes in .sphinxconfig.'
    : 'Choose which remotes should trigger push checks in this repository. These override your machine-wide defaults and are saved as remotes in .sphinxconfig.';
  if (values.branches === undefined) values.branches = await prompts.text({ title: 'Which branches?', description: `${branchScope} Use comma-separated names or patterns, such as main,release/*. Commit checks match the current local branch. An empty list matches no branches.`, current: config.branches.join(','), validate: value => { if (value || config.branches.length) lists(value); } });
  if (values.remotes === undefined) values.remotes = await prompts.text({ title: 'Which remotes?', description: `${remoteScope} Use * for every remote, or names such as origin,upstream. This does not affect commit checks. An empty list matches no remotes.`, current: config.remotes.join(','), validate: value => { if (value || config.remotes.length) lists(value); } });
  if (values.level === undefined) values.level = await prompts.choose({ title: 'How much understanding should the check cover?', description: 'Question caps depend on change size and depth. The evaluator can ask fewer, without filler. Model selection is separate.', current: config.level, choices: [
    { value: 'relaxed', label: 'Relaxed', description: `Caps: ${questionCapsText('relaxed')}. Behavior and the most consequential edge case.` },
    { value: 'standard', label: 'Standard', description: `Caps: ${questionCapsText('standard')}. Behavior, failures, and system interactions.` },
    { value: 'thorough', label: 'Thorough', description: `Caps: ${questionCapsText('thorough')}. Also consider rollout, rollback, and compatibility.` },
  ] });
  if (values.distance === undefined) values.distance = await prompts.choose({ title: 'How close to the code should questions get?', current: config.distance ?? 'mixed', choices: ['high', 'mixed', 'low'].map(value => ({ value, label: DISTANCES[value].label, description: DISTANCES[value].description })) });
  return values;
}

export async function askInstall(config, initial, prompts, { detectedAgents = [], hasExistingConfig = true, installedPlans = [] } = {}) {
  let values = { ...initial };
  if (values.agents === undefined) {
    const selected = await prompts.multiselect({ title: 'Which coding agents do you use?', description: 'Connect any combination. Detected agents are preselected; clear all for Git-only use. Previously connected agents remain installed.', current: detectedAgents, choices: [
      { value: 'codex', label: 'Codex', description: 'Local browser page; native fallback forms. Trust Sphinx hooks in /hooks.' },
      { value: 'claude', label: 'Claude Code', description: 'Local browser page; native fallback forms.' },
      { value: 'pi', label: 'Pi', description: 'Local browser page; native fallback dialogs.' },
      { value: 'cursor', label: 'Cursor', description: 'A local browser page for answers from local Agent sessions.' },
      { value: 'opencode', label: 'OpenCode', description: 'A local browser page for answers. Requires OpenCode 1.x.' },
    ] });
    values.agents = selected.length ? selected.join(',') : 'none';
  }
  const tiers = ['small', 'medium', 'large'];
  const explicitTiers = tiers.filter(tier => initial[tier] !== undefined);
  const explicitRoute = ['preset', 'provider', 'model'].some(key => initial[key] !== undefined)
    || explicitTiers.length === tiers.length || (hasExistingConfig && explicitTiers.length > 0);
  if (!explicitRoute) {
    const agents = values.agents === 'auto' ? detectedAgents : splitList(values.agents);
    // A coding plan reviews far faster than OpenRouter's free router. Prefer the
    // agent the user works in, then any Codex or Claude Code CLI installed here.
    const plan = ['codex', 'claude'].find(name => agents.includes(name)) ?? ['claude', 'codex'].find(name => installedPlans.includes(name));
    const recommended = plan ? `${plan}-economy` : undefined;
    const current = hasExistingConfig ? 'keep' : recommended;
    for (;;) {
      const choice = await prompts.choose({
        title: 'Choose your evaluator models',
        description: 'A separate evaluator reads filtered code without your coding conversation. Codex and Claude use their signed-in CLI and usage allowance. Pi, Cursor, and OpenCode need a separate evaluator route. Paid OpenRouter presets use API credits; choosing one enables paid requests. There is no model-call cap by default; set one later with sphinx config --max-model-calls. Setup makes no model calls.',
        current, requireSelection: !current,
        choices: [
          ...(hasExistingConfig ? [{ value: 'keep', label: 'Keep current model routes', description: `Small: ${routeText(config.models.small)}. Medium: ${routeText(config.models.medium)}. Large: ${routeText(config.models.large)}.` }] : []),
          ...[...REVIEWER_PRESETS].sort((a, b) => (b.id === recommended) - (a.id === recommended)).map(preset => ({ value: preset.id, label: preset.id === recommended ? `${preset.label} (recommended)` : preset.label, description: preset.description })),
          { value: 'custom', label: 'Choose by change size', description: 'Set separate provider:model routes for small, medium, and large changes.' },
        ],
      });
      if (choice === 'keep') break;
      if (choice !== 'custom') {
        const selected = presetOptions(choice);
        values = { ...selected, ...values, preset: choice, ...(selected['allow-paid'] ? { 'allow-paid': true } : {}) }; break;
      }
      const custom = Object.fromEntries(explicitTiers.map(tier => [tier, initial[tier]]));
      for (const [tier, description] of [['small', 'At most 80 changed lines and 3 files, with no consequential paths, by default.'], ['medium', 'Changes between the small and large thresholds.'], ['large', 'At least 400 lines, 12 files, or a consequential path by default.']]) {
        if (initial[tier] !== undefined) continue;
        custom[tier] = await prompts.text({ title: `Evaluator for ${tier} changes`, description: `${description} Enter provider:model, such as claude:sonnet or an OpenRouter model ID prefixed with openrouter:.`, current: routeText(config.models[tier]), validate: parseRoute });
      }
      const paid = Object.values(custom).some(value => {
        const route = parseRoute(value);
        return route.provider === 'openrouter' && route.model && route.model !== 'openrouter/free' && !route.model.endsWith(':free');
      });
      if (paid && !config.allowPaid && !values['allow-paid']) {
        const permission = await prompts.choose({ title: 'Enable paid OpenRouter requests?', description: 'These custom routes can charge your OpenRouter credits. Model prices vary. This permission applies to your machine-wide evaluator configuration.', current: 'back', choices: [
          { value: 'back', label: 'Choose routes again', description: 'Return to model selection without enabling paid requests.' },
          { value: 'allow', label: 'Enable paid requests', description: 'Use these routes with your OpenRouter API key and credits.' },
        ] });
        if (permission !== 'allow') continue;
        custom['allow-paid'] = true;
      }
      values = { ...values, ...custom }; break;
    }
  }
  // Offer the saved (or default) policy as one choice; branch, remote, and depth details stay optional.
  if (['events', 'branches', 'remotes', 'level', 'distance'].every(key => values[key] === undefined)) {
    const policy = await prompts.choose({
      title: 'When should Sphinx check your understanding?',
      description: 'Each repository can override this later with sphinx init.',
      current: 'keep',
      choices: [
        { value: 'keep', label: hasExistingConfig ? 'Keep current checkpoints' : 'Recommended checkpoints', description: policyText(config) },
        { value: 'custom', label: 'Customize', description: 'Choose Git events, branches, remotes, and question depth now.' },
      ],
    });
    if (policy === 'keep') return values;
  }
  return askPolicy(config, values, prompts, { scope: 'global' });
}

export function policyText(config) {
  if (!config.events.length) return 'Checkpoints stay disabled.';
  const branches = config.branches.length ? config.branches.join(', ') : 'no branches';
  const remotes = config.remotes.includes('*') ? 'any remote' : config.remotes.length ? config.remotes.join(', ') : 'no remotes';
  const parts = [];
  if (config.events.includes('pre-push')) parts.push(`before pushes to ${branches} on ${remotes}`);
  if (config.events.includes('pre-commit')) parts.push(`before commits on ${branches}`);
  const text = parts.join(' and ');
  return `${text[0].toUpperCase()}${text.slice(1)}, at ${config.level} depth, ${DISTANCES[config.distance]?.label.toLowerCase() ?? 'mixed'} questions.`;
}
