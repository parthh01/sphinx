import path from 'node:path';
import { readStats, scoreSummary } from './stats.js';
import { deckSummary, dueCards, publicCard, readDeck, reviewCard } from './deck.js';
import { planProviders } from './evaluator.js';
import { VERSION } from './version.js';
import { fileURLToPath } from 'node:url';
import { lstat, readFile } from 'node:fs/promises';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { DISTANCES, getPaths, loadConfig, saveConfig, saveOpenRouterKey, openRouterKey, saveOpenAIEndpoint, openAIEndpoint, validateConfig, repositoryConfigInfo, policyHash } from './config.js';
import { initializeRepository } from './repo-config.js';
import { applyRepositorySetup, suggestRepositorySetup } from './repo-setup.js';
import * as git from './git.js';
import { install, uninstall, doctor, dispatchHook, installedAgents, detectAgents } from './install.js';
import { activateIntegrations } from './activation.js';
import { checkbox } from './checkbox.js';
import { agentHook } from './agent.js';
import { createSessionStore } from './sessions.js';
import { parseRoute } from './routing.js';
import { createTerminal, withProgress } from './terminal.js';
import { HELP, printHelp } from './help.js';
import { askInstall, askPolicy, createPrompts, questionCapsText, reviewCapsText, routeText, splitList } from './prompts.js';
import { runGitGate } from './git-gate.js';
import { loadProjectContext, contextWithDescription, contextWithPreferences, ensurePersonalContext, PROJECT_CONTEXT_TEMPLATE } from './repo-context.js';
import { REVIEWER_PRESETS, presetOptions } from './model-presets.js';
import { modelUsageText, modelLimitText, readUsage, summarizeUsage, printUsage, usageDir } from './usage.js';
import { toggleYolo, yoloStatus, recentOverrides, recordOverride } from './overrides.js';
import { runTerminalCheck } from './terminal-check.js';

const CLI_PATH = fileURLToPath(new URL('../bin/sphinx.js', import.meta.url));
const POLICY_FLAGS = ['branches', 'events', 'level', 'distance', 'remotes'];
const MODEL_FLAGS = ['preset', 'provider', 'model', 'small', 'medium', 'large', 'allow-paid', 'max-model-calls', 'max-output-tokens', 'cli-billing'];
const OPTIONS = {
  install: ['yes', 'repo', 'agents', ...MODEL_FLAGS, 'launch', 'no-launch', ...POLICY_FLAGS],
  activate: ['agents', 'json'],
  init: ['yes', 'json', 'context', 'suggest', 'apply', 'github-check', ...POLICY_FLAGS], check: ['json', 'id', 'remote', 'branch', 'staged', 'retry-review'],
  prepare: ['json', 'worker', 'retry'],
  answer: ['json', 'text'], explain: ['json'], dispute: ['json', 'text'], pending: ['json'],
  status: ['json'], config: ['json', 'distance', 'interface', ...MODEL_FLAGS], doctor: ['json'], auth: ['provider', 'base-url'], uninstall: ['repo'],
  mcp: [], yolo: ['json', 'reason'], usage: ['json'], drill: ['json', 'list', 'limit'],
};
const json = value => console.log(JSON.stringify(value, null, 2));
const ui = () => createTerminal();
const cancelled = () => Object.assign(new Error('Cancelled. No further changes were made.'), { code: 'SPHINX_CANCELLED', exitCode: 130 });

async function readStdin() {
  let value = '';
  for await (const chunk of process.stdin) { value += chunk; if (value.length > 2e6) throw new Error('Hook input too large.'); }
  return value;
}

async function withReadline(operation, { output = process.stdout, terminal = !!(process.stdin.isTTY && output.isTTY && process.env.TERM !== 'dumb'), controller } = {}) {
  let rl, closed = false;
  const release = () => { const previous = rl; rl = undefined; previous?.close(); };
  const interrupt = () => { controller?.abort(cancelled()); rl?.close(); };
  const acquire = () => {
    if (closed || process.stdin.readableEnded || process.stdin.destroyed) throw cancelled();
    if (!rl) {
      const current = createInterface({ input: process.stdin, output, terminal });
      rl = current;
      current.on('close', () => { if (rl === current) { closed = true; rl = undefined; controller?.abort(cancelled()); } });
      current.on('SIGINT', () => current.close());
    }
    return rl;
  };
  const ask = prompt => {
    const current = acquire();
    return new Promise((resolve, reject) => {
      const onClose = () => reject(cancelled());
      current.once('close', onClose);
      current.question(prompt).then(answer => { current.off('close', onClose); resolve(answer); }, error => { current.off('close', onClose); reject(closed ? cancelled() : error); });
    });
  };
  ask.checkbox = options => {
    if (closed || process.stdin.readableEnded || process.stdin.destroyed) throw cancelled();
    release(); return checkbox({ ...options, ui: ui(), output });
  };
  const signals = controller ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : [];
  for (const event of signals) process.on(event, interrupt);
  try {
    // During an interview, Ctrl+C/EOF must cancel investigation and grading as
    // well as a pending question. Other prompt flows retain lazy acquisition.
    if (controller) acquire();
    return await operation(ask);
  } finally {
    for (const event of signals) process.off(event, interrupt);
    release();
  }
}

async function repoConfig(cwd = process.cwd()) {
  const repo = await git.repository(cwd);
  return { repo, config: await loadConfig(repo.root) };
}
async function validateCheckpoint(snapshot, config) {
  if (policyHash(await loadConfig(snapshot.repoRoot)) !== policyHash(config) || !(await git.revalidateSnapshot(snapshot, config))) throw new Error('The code, project context, or policy changed since this checkpoint. Retry the Git operation or run sphinx check with an explicit target.');
}
const store = createSessionStore({ validate: validateCheckpoint });

async function gate({ event, args, input, cwd }) {
  const controller = new AbortController();
  const cancel = () => controller.abort(Object.assign(new Error('Git operation cancelled. Progress is saved.'), { exitCode: 130 }));
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const event of signals) process.on(event, cancel);
  try {
    return await runGitGate({ event, args, input, cwd, signal: controller.signal });
  } finally {
    for (const event of signals) process.off(event, cancel);
  }
}

function parseModelCalls(value) {
  if (['unlimited', 'none'].includes(String(value).toLowerCase())) return null;
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/u.test(String(value))) throw new Error('--max-model-calls must be a whole number from 1 to 100, or unlimited (none is an alias).');
  return Number(value);
}

function parseOutputTokens(value) {
  if (!/^\d+$/u.test(String(value)) || Number(value) < 512 || Number(value) > 16384) throw new Error('--max-output-tokens must be a whole number from 512 to 16384.');
  return Number(value);
}

function parseLimit(value) {
  if (!/^(?:[1-9]|[1-4][0-9]|50)$/u.test(String(value))) throw new Error('--limit must be a whole number from 1 to 50.');
  return Number(value);
}

export function applyInstallOptions(current, values) {
  const config = structuredClone(current);
  if (values.preset !== undefined) {
    if (values.provider !== undefined || values.model !== undefined) throw new Error('--preset cannot be combined with --provider or --model. Use --small, --medium, or --large to override a preset tier.');
    // A preset describes paid routes, but never grants spending permission.
    // Guided setup must return an explicit --allow-paid after confirmation.
    const selected = presetOptions(values.preset);
    for (const tier of ['small', 'medium', 'large']) config.models[tier] = parseRoute(selected[tier]);
    config.provider = config.models.small.provider;
    config.model = config.models.small.model;
    if (selected['max-output-tokens'] !== undefined) config.maxOutputTokens = parseOutputTokens(selected['max-output-tokens']);
  }
  if (values['max-model-calls'] !== undefined) config.maxModelCalls = parseModelCalls(values['max-model-calls']);
  if (values['max-output-tokens'] !== undefined) config.maxOutputTokens = parseOutputTokens(values['max-output-tokens']);
  for (const key of ['provider', 'model', 'level', 'distance', 'interface', 'mode']) if (values[key] !== undefined) config[key] = values[key];
  for (const key of ['branches', 'events', 'remotes']) if (values[key] !== undefined) config[key] = splitList(values[key]);
  if (values.provider !== undefined || values.model !== undefined) {
    if (values.provider !== undefined && values.model === undefined) {
      const economical = REVIEWER_PRESETS.find(preset => preset.id === `${values.provider}-economy`);
      config.model = economical ? economical.models.small.model : values.provider === 'openrouter' ? 'openrouter/free' : null;
    }
    for (const tier of ['small', 'medium', 'large']) config.models[tier] = { provider: config.provider, model: config.model };
  }
  for (const tier of ['small', 'medium', 'large']) if (values[tier] !== undefined) config.models[tier] = parseRoute(values[tier]);
  if (values['allow-paid']) config.allowPaid = true;
  if (values['cli-billing'] !== undefined) config.cliBilling = values['cli-billing'];
  validateConfig(config);
  if (values.agents !== undefined && !['auto', 'none'].includes(values.agents)) {
    const selected = values.agents.split(',');
    if (!selected.length || new Set(selected).size !== selected.length || selected.some(name => !['codex', 'claude', 'pi', 'cursor', 'opencode'].includes(name))) throw new Error('--agents must be auto, none, or a comma-separated selection of codex, claude, pi, cursor, opencode.');
  }
  for (const route of Object.values(config.models)) {
    if (route.provider === 'openrouter' && route.model && route.model !== 'openrouter/free' && !route.model.endsWith(':free') && !config.allowPaid) throw new Error(`Model ${route.model} may be paid. Explicitly pass --allow-paid or choose a free route.`);
  }
  return config;
}

function policyRows(config) {
  const enabled = config.enabled;
  return [
    ['Push checkpoints', enabled && config.events.includes('pre-push') ? `Destination branches: ${config.branches.join(', ') || 'none'}. Remotes: ${config.remotes.join(', ') || 'none'}.` : 'Off. Local pushes are not checked by this policy.'],
    ['Commit checkpoints', enabled && config.events.includes('pre-commit') ? `Staged changes on local branches: ${config.branches.join(', ') || 'none'}.` : 'Off. Local commits are not checked by this policy.'],
    ['Depth', `${config.level} · question caps: ${questionCapsText(config.level)}`],
    ['Distance', `${config.distance} · ${(DISTANCES[config.distance] ?? DISTANCES.mixed).description}`],
    ['Preparation', config.backgroundPreparation ? 'Background review after commits and branch updates' : 'On demand when the understanding check starts'],
    ['Behavior', !enabled ? 'Disabled for this repository' : 'The Git operation only goes through after you answer the understanding questions correctly'],
  ];
}

function printConfiguration(terminal, config, { routes = true } = {}) {
  terminal.rows(policyRows(config));
  if (routes) {
    terminal.section('Evaluator routes');
    terminal.rows(['small', 'medium', 'large'].map(tier => [tier[0].toUpperCase() + tier.slice(1), routeText(config.models[tier])]));
    if (Object.values(config.models).some(route => ['codex', 'claude'].includes(route.provider))) terminal.rows([['Codex/Claude billing', config.cliBilling === 'api' ? 'API keys from your environment, when set' : 'Your signed-in plan; API keys in your environment are ignored']]);
    terminal.blank(); terminal.note(`Model calls: ${modelLimitText(config.maxModelCalls)}. Review, compaction, grading, learning, and failed requests stay counted. Completion lasts ${config.receiptHours} hours unless code, destination, or policy changes.`);
    terminal.note(`Review planning targets: ${reviewCapsText(config)} calls. These are soft targets; only explicitly configured request limits stop further calls. Context limits and deadlines still apply.`);
    terminal.note('A call cap is optional. Set one with sphinx config --max-model-calls 30, or clear it with --max-model-calls unlimited.');
  }
}

function printInstallationResult(terminal, result) {
  terminal.blank();
  for (const line of result.messages) terminal.success(line);
  for (const line of result.warnings) terminal.warning(line);
}

function printActivationResult(terminal, result) {
  terminal.section('Open your coding agents');
  if (!result.results.length) { terminal.note('No coding-agent integrations are configured. Choose agents with sphinx install.'); return; }
  const labels = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi', cursor: 'Cursor', opencode: 'OpenCode' };
  terminal.rows(result.results.map(item => [labels[item.agent] || item.agent, `${item.status === 'opened' ? 'Opened' : 'Not opened'}. ${item.detail}`]));
  terminal.blank();
  terminal.note('Opened means a client was launched; hook trust and MCP connections are confirmed inside the client.');
  const remaining = result.results.filter(item => item.status !== 'opened').map(item => item.agent);
  if (remaining.length) terminal.command(`sphinx activate --agents ${remaining.join(',')}`);
}

async function activateCommand(values) {
  const configured = await installedAgents();
  const agents = values.agents === undefined || values.agents === 'auto' ? configured : splitList(values.agents);
  if (values.agents !== undefined && values.agents !== 'auto' && (!agents.length || new Set(agents).size !== agents.length || agents.some(name => !['codex', 'claude', 'pi', 'cursor', 'opencode'].includes(name)))) {
    throw new Error('--agents must be auto or a comma-separated selection of codex, claude, pi, cursor, opencode.');
  }
  const missing = agents.filter(name => !configured.includes(name));
  if (missing.length) throw new Error(`Sphinx is not installed for ${missing.join(', ')}. Run sphinx install --agents ${missing.join(',')} first.`);
  const result = await withProgress('Opening configured coding agents', () => activateIntegrations({ agents }), { enabled: !values.json });
  if (values.json) json(result); else printActivationResult(ui(), result);
  return result.results.some(item => item.status !== 'opened') ? 1 : 0;
}

async function readHidden(prompt) {
  const hidden = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  process.stdout.write(prompt);
  try { return await withReadline(ask => ask(''), { output: hidden, terminal: true }); } finally { process.stdout.write('\n'); }
}

async function authOpenAI(baseUrlFlag) {
  if (!process.stdin.isTTY) throw new Error('Set SPHINX_OPENAI_BASE_URL and SPHINX_OPENAI_API_KEY in noninteractive environments; sphinx auth requires a terminal.');
  const terminal = ui();
  terminal.section('OpenAI-compatible endpoint');
  terminal.paragraph('Any server with an OpenAI chat-completions API: OpenAI, Groq, Together, vLLM, Ollama, LM Studio, and others. It must support tool calls and JSON-schema structured output. The key is only ever sent to this URL.');
  const baseUrl = baseUrlFlag ?? await withReadline(ask => ask('\nBase URL [https://api.openai.com/v1]: '));
  terminal.note('Input is hidden. Leave it empty only for a localhost server without a key.');
  const key = await readHidden('\nAPI key: ');
  const saved = await saveOpenAIEndpoint({ baseUrl: baseUrl.trim() || 'https://api.openai.com/v1', apiKey: key }); 
  terminal.success(`Endpoint saved: ${saved}`); terminal.note(getPaths().credentials);
  terminal.paragraph('Route reviews to it with a model ID your endpoint serves, for example:');
  terminal.command('sphinx config --provider openai --model gpt-5-mini');
}

async function auth() {
  if (!process.stdin.isTTY) throw new Error('Use OPENROUTER_API_KEY in noninteractive environments; sphinx auth requires a terminal.');
  const terminal = ui();
  terminal.section('OpenRouter API key'); terminal.paragraph('Free models also require a key. Create one at:');
  terminal.command('https://openrouter.ai/settings/keys');
  terminal.blank(); terminal.note('Input is hidden. The key stays in a user-only credentials file outside your repositories.');
  for (;;) {
    const hidden = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    process.stdout.write('\nAPI key: ');
    let key;
    try { key = await withReadline(ask => ask(''), { output: hidden, terminal: true }); } finally { process.stdout.write('\n'); }
    if (!key.trim() || /\s/.test(key.trim())) { terminal.warning('Enter a nonempty key without spaces, or press Ctrl+C to cancel.'); continue; }
    await saveOpenRouterKey(key);
    terminal.success('OpenRouter key saved.'); terminal.note(getPaths().credentials); return;
  }
}

async function installCommand(initial) {
  const terminal = ui(), current = await loadConfig();
  const hasExistingConfig = await lstat(getPaths().config).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  if (initial.launch && initial['no-launch']) throw new Error('Choose either --launch or --no-launch, not both.');
  if (initial.repo) {
    const incompatible = Object.keys(initial).filter(key => !['repo', 'yes'].includes(key));
    if (incompatible.length) throw new Error(`install --repo only repairs repository hook coverage. Remove ${incompatible.map(key => `--${key}`).join(', ')} or run global sphinx install separately.`);
    terminal.banner(); terminal.section('Connect this repository');
    printInstallationResult(terminal, await install({ config: current, agents: 'none', repo: true, cliPath: CLI_PATH })); return 0;
  }
  applyInstallOptions(current, initial);
  const completeRouteChoice = ['preset', 'provider', 'model'].some(key => initial[key] !== undefined)
    || ['small', 'medium', 'large'].every(key => initial[key] !== undefined);
  if (initial.yes && !hasExistingConfig && !completeRouteChoice) {
    throw new Error('First installation needs an explicit reviewer choice for every change size. Run sphinx install for guided setup, or use --yes --preset codex-economy, --preset claude-economy, or --preset openrouter-value --allow-paid. Custom routes need all three flags: --small, --medium, and --large.');
  }
  if (!initial.yes && !process.stdin.isTTY) throw new Error('Run sphinx install in a terminal for guided setup, or use --yes with your chosen options. See sphinx install --help.');
  terminal.banner(); terminal.paragraph('Connect Git and your coding agents once for this machine. Existing hooks and unrelated agent settings are preserved.');
  const launch = !initial['no-launch'] && (initial.launch || !initial.yes);
  if (launch) terminal.paragraph('After setup, Sphinx opens selected installed clients in fresh sessions. Existing sessions stay open. Use --no-launch to defer this step.');
  const detected = !initial.yes && (initial.agents === undefined || initial.agents === 'auto') ? await detectAgents() : [];
  const installedPlans = initial.yes ? [] : await planProviders().catch(() => []);
  const values = initial.yes ? initial : await withReadline(ask => askInstall(current, initial, createPrompts({ ask, ui: terminal,
    select: process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb' ? ask.checkbox : undefined,
  }), { detectedAgents: detected, hasExistingConfig, installedPlans }));
  const config = applyInstallOptions(current, values);
  terminal.section('Machine-wide defaults');
  terminal.paragraph('Each repository can override these branches and remotes in .sphinxconfig to match its own production setup.');
  printConfiguration(terminal, config);
  terminal.rows([['Agent integrations', values.agents || 'auto (detect installed agents)']]);
  if (Object.values(config.models).some(route => route.provider === 'openrouter') && !(await openRouterKey())) {
    if (process.stdin.isTTY && !values.yes) await auth();
    else throw new Error('OpenRouter requires a key before installation. Set OPENROUTER_API_KEY or run sphinx auth. Alternatively choose --provider codex or --provider claude.');
  }
  const result = await install({ config, agents: values.agents || 'auto', cliPath: CLI_PATH });
  await saveConfig(config); printInstallationResult(terminal, result);
  const personal = await ensurePersonalContext().catch(() => null);
  if (personal) terminal.note(`Created ${personal}: tell Sphinx what you do and don't want questions about, in every repository.`);
  if (result.agents.length) {
    if (launch) printActivationResult(terminal, await withProgress('Opening your coding agents', () => activateIntegrations({ agents: result.agents })));
    else {
      terminal.section('Open your coding agents');
      terminal.command(`sphinx activate --agents ${result.agents.join(',')}`);
      terminal.note('Opens fresh clients to load Sphinx.');
      if (result.agents.includes('codex')) terminal.note('Codex hook trust still requires your approval in /hooks.');
    }
  }
  terminal.section('Repository setup'); terminal.command('sphinx init');
  terminal.note('Choose repository policy, project context, and excluded paths. Use sphinx status to check Git coverage.');
  terminal.blank(); terminal.note(`Global settings: ${getPaths().config}`); return 0;
}

async function readProposal(source) {
  let text = '';
  if (source === '-') { for await (const chunk of process.stdin) { text += chunk; if (text.length > 1e6) throw new Error('Proposal exceeds 1 MB.'); } }
  else text = await readFile(path.resolve(source), 'utf8');
  try { return JSON.parse(text); } catch (error) { throw new Error(`Proposal is not valid JSON: ${error.message}`); }
}

// Agent setup: a read-only proposal, then a validated, idempotent apply.
async function agentSetupCommand(values) {
  const extra = Object.keys(values).filter(key => !['suggest', 'apply', 'json'].includes(key));
  if (extra.length || (values.suggest && values.apply !== undefined)) throw new Error('Use either --suggest or --apply <file|->, optionally with --json, and no other init options.');
  const { repo, config } = await repoConfig();
  if (values.suggest) { json(await suggestRepositorySetup({ repoRoot: repo.root })); return 0; }
  let result;
  try { result = await applyRepositorySetup({ repoRoot: repo.root, proposal: await readProposal(values.apply), config }); }
  catch (error) {
    if (!values.json || error.code !== 'SPHINX_INVALID_PROPOSAL') throw error;
    json({ ok: false, errors: error.errors }); return 1;
  }
  if (values.json) { json(result); return 0; }
  const terminal = ui();
  for (const file of result.created) terminal.success(`Created ${file}`);
  for (const file of result.updated) terminal.success(`Updated ${file}`);
  for (const file of result.preserved) terminal.note(`Preserved ${file}`);
  for (const line of result.warnings) terminal.warning(line);
  return 0;
}

async function initCommand(initial) {
  if (initial.suggest || initial.apply !== undefined) return agentSetupCommand(initial);
  if (initial['github-check']) return githubCheckCommand(initial);
  const { repo, config } = await repoConfig(), info = await repositoryConfigInfo(repo.root), terminal = ui();
  let values = initial;
  if (!initial.json) { terminal.banner(); terminal.section('Repository setup'); terminal.note(repo.root); }
  if (!info.exists || info.legacy) {
    applyInstallOptions(config, initial);
    if (!initial.yes && !initial.json) {
      if (!process.stdin.isTTY) throw new Error('Run sphinx init in a terminal, or use --yes to accept inherited defaults. See sphinx init --help.');
      if (info.legacy) terminal.note('Existing .sphinx.json policy will be carried into .sphinxconfig; the legacy file remains.');
      values = await withReadline(ask => askPolicy(config, initial, createPrompts({ ask, ui: terminal })));
    }
  }
  const overrides = {};
  for (const key of ['level', 'distance']) if (values[key] !== undefined) overrides[key] = values[key];
  for (const key of ['branches', 'events', 'remotes']) if (values[key] !== undefined) overrides[key] = splitList(values[key]);
  let context = values.context;
  if (context === undefined && !initial.yes && !initial.json && process.stdin.isTTY && !(await loadProjectContext(repo.root)).text) {
    terminal.section('Project context');
    terminal.paragraph('Describe what this project does and its key workflows. This background is included in every review; you can expand .sphinxcontext.md later.');
    const [answer, preferences] = await withReadline(async ask => [
      await ask('\nProject description (Enter to fill in later): '),
      await ask('Anything Sphinx should skip or focus on here? For example "don\'t ask about styling" (Enter to skip): '),
    ]);
    if (answer.trim() || preferences.trim()) context = contextWithPreferences(answer.trim() ? contextWithDescription(answer) : PROJECT_CONTEXT_TEMPLATE, preferences.trim() ? `- ${preferences.trim()}` : '');
  }
  const result = await initializeRepository({ repoRoot: repo.root, config, overrides, context });
  if (initial.json) { json(result); return 0; }
  terminal.blank();
  for (const file of result.created) terminal.success(`Created ${path.basename(file)}`);
  for (const file of result.preserved) terminal.note(`Preserved ${path.basename(file)}`);
  if (info.exists && !info.legacy && Object.keys(overrides).length) terminal.warning('The existing .sphinxconfig was preserved; command-line overrides were not applied. Edit that file to change its policy.');
  terminal.section('Effective repository policy'); printConfiguration(terminal, await loadConfig(repo.root), { routes: false });
  terminal.blank(); terminal.paragraph('Add project-specific sensitive or generated paths to .sphinxignore before an assessment.');
  terminal.paragraph('.sphinxcontext.md tells the reviewer what this project is and what you want to be asked about, for example "don\'t ask about styling". Your preferences for every repository go in ~/.config/sphinx/context.md.');
  if (result.contextExcluded) terminal.note('.sphinxcontext.md is kept out of Git on this machine. To share it with your team, run git add -f .sphinxcontext.md.');
  terminal.note('This command does not install Git hooks. Check coverage with sphinx status.'); return 0;
}

// Adds the workflow that turns contributors' Sphinx stamps into a "Sphinx" check on PRs.
async function githubCheckCommand(values) {
  const { repo } = await repoConfig();
  const { workflowTemplate } = await import('./github.js');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const file = path.join(repo.root, '.github', 'workflows', 'sphinx.yml');
  await mkdir(path.dirname(file), { recursive: true });
  let created = true;
  try { await writeFile(file, workflowTemplate(VERSION), { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; created = false; }
  if (values.json) { json({ file, created }); return 0; }
  const terminal = ui();
  if (created) terminal.success(`Created ${path.relative(repo.root, file)}`); else terminal.note(`${path.relative(repo.root, file)} already exists and was kept.`);
  terminal.paragraph('Commit and push it. Pull requests then show a "Sphinx" check: stamped with a summary once the author passes Sphinx for the latest commit, neutral until then.');
  terminal.paragraph('To require it, set require: true in the workflow and add the "Sphinx" check to branch protection. Stamps are self-reported by contributors\u2019 machines, so treat it as a strong nudge, not proof.');
  terminal.note('Contributors need Sphinx with pull request branches checked ("branches": ["*"]) and the GitHub CLI signed in.');
  return 0;
}

function printSession(session, terminal = ui()) {
  if (session.feedback) {
    terminal.section(session.verdict === 'incorrect' ? 'Review this concept' : session.verdict === 'ambiguous' ? 'Clarification needed' : 'Feedback'); terminal.paragraph(session.feedback);
  }
  if (session.status === 'passed') {
    terminal.blank(); terminal.success('Understanding check complete.');
    terminal.paragraph(process.env.SPHINX_WAITING_GIT === '1'
      ? "Approval saved. Return to the original Git output for the operation's result."
      : 'Approval saved for this exact change and destination. A waiting Git operation can now continue.');
    return;
  }
  terminal.blank(); terminal.note(`${session.route.tier} change · ${routeText(session.route)} · ${modelUsageText(session.usage, session.tokens)}`);
  if (!session.question) { terminal.paragraph('Assessment queued. Run sphinx check to begin.'); return; }
  terminal.section(`Question ${session.progress.completed + 1} of ${session.progress.total}`); terminal.paragraph(session.question.prompt);
  if (session.question.choices.length) { terminal.blank(); terminal.rows(session.question.choices.map((choice, index) => [`${index + 1}.`, choice])); }
  terminal.blank(); terminal.note('Give a prediction and a short reason. /learn for help · /dispute <reason> · /quit to save progress');
}

async function checkCommand(values) {
  if (values['retry-review'] && !values.id) throw new Error('--retry-review requires --id to select the failed checkpoint. Find it with sphinx pending.');
  const { repo, config } = await repoConfig(); let session;
  if (values.id) session = await store.read(values.id);
  else if (!values.staged && !values.remote && !values.branch) {
    for (const candidate of await store.pending(repo.root)) if (await git.revalidateSnapshot(candidate.snapshot, config)) { session = candidate; break; }
  }
  if (session && session.snapshot.repoRoot !== repo.root) throw new Error('This checkpoint belongs to a different repository.');
  if (!session) {
    const snapshot = values.staged ? await git.commitSnapshot({ cwd: repo.root, config }) : await git.manualSnapshot({ cwd: repo.root, config, remote: values.remote, branch: values.branch });
    if (!snapshot) { if (values.json) json({ status: 'not-required' }); else ui().success('No assessment required by the current policy.'); return 0; }
    session = await store.ensure(snapshot, config);
  }
  if (!values.json && !process.stdin.isTTY) throw new Error('Use sphinx check --json from a coding agent, or run in an interactive terminal.');
  const start = signal => withProgress(session.questions.length ? 'Loading prepared questions' : `Reviewing the change with ${routeText(session.route)}`, () => store.start(session.id, config, { signal }), { enabled: !values.json });
  if (values.json) {
    if (values['retry-review']) await store.retryReview(session.id, config);
    json(await start()); return 0;
  }
  const controller = new AbortController(), { signal } = controller;
  const waitingGit = process.env.SPHINX_WAITING_GIT === '1';
  return withReadline(async ask => {
    const terminal = ui();
    if (values['retry-review']) {
      await store.retryReview(session.id, config, { signal });
      signal.throwIfAborted();
      terminal.note(config.maxModelCalls === null
        ? 'Resuming the review with no model-call limit. Previous usage remains counted.'
        : `Starting a new review attempt with up to ${config.maxModelCalls} additional model calls, including grading. Previous usage remains counted.`);
    }
    return runTerminalCheck({
      store, session: await store.read(session.id), config, ask, terminal, signal, waitingGit,
      choose: createPrompts({ ask, ui: terminal }).choose,
      validate: () => validateCheckpoint(session.snapshot, config),
      planProviders: await planProviders().catch(() => []),
      // A skip lets the waiting Git operation through; it is logged like the browser's.
      skip: async reason => {
        await store.skip(session.id);
        await recordOverride({ kind: 'skip', repoRoot: repo.root, target: session.snapshot.target.ref, id: session.id, reason });
      },
    });
  }, { controller });
}

function printPending(terminal, pending) {
  if (!pending.length) { terminal.success('No pending assessments.'); return; }
  for (const session of pending) {
    terminal.section(`${session.target} · ${session.status}`);
    terminal.paragraph(`${session.route.tier} change · ${routeText(session.route)} · ${session.progress.completed}/${session.progress.total} concepts complete · ${modelUsageText(session.usage, session.tokens)}`);
    terminal.command(`sphinx check --id ${session.id}`);
  }
}

async function statusCommand(command, values) {
  const { repo, config } = await repoConfig(), pending = [];
  const { preparationStatus } = await import('./preparation.js');
  const preparation = command === 'status' ? await preparationStatus({ cwd: repo.root }) : null;
  for (const session of await store.pending(repo.root)) if (await git.revalidateSnapshot(session.snapshot, config)) pending.push(store.public(session));
  const yolo = command === 'status' ? await yoloStatus(repo.root) : null, overrides = command === 'status' ? await recentOverrides({ repoRoot: repo.root }) : [];
  const drill = command === 'status' ? deckSummary(await readDeck(repo.root)) : null;
  if (values.json) { json(command === 'status' ? { repo: repo.root, config, pending, preparation, yolo, overrides, drill } : pending); return 0; }
  const terminal = ui();
  if (command === 'pending') { terminal.section('Pending assessments'); printPending(terminal, pending); return 0; }
  const info = await repositoryConfigInfo(repo.root), report = await doctor();
  const coverage = report.checks.filter(check => check.name === 'Current repository' || check.name.endsWith('dispatcher'));
  const active = coverage.length > 0 && coverage.every(check => check.ok);
  const branch = await promisify(execFile)('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo.root }).then(result => result.stdout.trim()).catch(() => 'detached HEAD');
  terminal.section('Repository status');
  terminal.rows([['Repository', repo.root], ['Current local branch', branch], ['Git integration', active ? 'Active · Sphinx dispatchers are configured' : 'Not active or needs repair · run sphinx doctor'], ['Repository policy', info.exists ? `${info.path}${info.legacy ? ' (legacy)' : ''}` : 'Global defaults; use sphinx init to create .sphinxconfig']]);
  if (info.shadowed) terminal.warning(`${info.shadowed} is ignored because .sphinxconfig takes precedence.`);
  terminal.section('Configured checkpoints'); printConfiguration(terminal, config, { routes: false });
  if (preparation) terminal.rows([['Background review', preparation.status], ...(preparation.error ? [['Details', preparation.error]] : [])]);
  if (!active) { terminal.blank(); terminal.warning('Policy alone does not install hooks. Use sphinx install, or sphinx install --repo when this repository overrides core.hooksPath.'); }
  const score = scoreSummary(await readStats(repo.root));
  terminal.rows([['Understanding', score.calibrating ? `Calibrating · ${score.answered} of ${score.answered + score.needed} answers` : `${score.accuracy}% first try · ${score.answered} questions${score.streak > 1 ? ` · ${score.streak} in a row` : ''}${score.skipRate !== null ? ` · skipped ${score.skipRate}% of checks` : ''}`]]);
  if (drill) terminal.rows([['Retention', drill.total ? `${drill.due} due · ${drill.total} saved · sphinx drill` : 'No saved questions yet']]);
  if (yolo) { terminal.blank(); terminal.warning(`Yolo mode is on ${yolo.scope === 'repo' ? 'for this repository' : 'globally'} since ${yolo.since}: checks are skipped. Run sphinx yolo${yolo.scope === 'global' ? ' outside a repository' : ''} to turn it off.`); }
  terminal.section('Pending assessments'); printPending(terminal, pending);
  if (overrides.length) { terminal.section('Recent overrides'); terminal.rows(overrides.map(row => [row.at, `${row.kind}${row.target ? ` · ${row.target}` : ''}${row.reason ? ` · ${row.reason}` : ''}`])); }
  terminal.blank(); terminal.note('Status uses local Git state only. Agent hook trust is not verified here.'); return 0;
}

function printDeckList(terminal, cards, { due }) {
  if (!cards.length) { terminal.success(due ? 'No cards due.' : 'No saved questions yet.'); return; }
  for (const card of cards) {
    terminal.section(card.dueAt ? `${card.target || 'question'} · due ${card.dueAt.slice(0, 10)}` : 'question');
    terminal.paragraph(card.prompt);
  }
}

async function drillCommand(values) {
  const { repo } = await repoConfig();
  const now = new Date();
  const deck = await readDeck(repo.root);
  const summary = deckSummary(deck, now);
  const due = dueCards(deck, now);
  const listed = Object.values(deck.cards).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
  const limit = values.limit !== undefined ? parseLimit(values.limit) : 10;
  const cards = values.list ? listed : due.slice(0, limit);
  if (values.json) {
    json({ repo: repo.root, ...summary, cards: cards.map(publicCard) });
    return 0;
  }
  const terminal = ui();
  if (values.list || !due.length) {
    terminal.section(values.list ? 'Saved questions' : 'Retention');
    printDeckList(terminal, values.list ? listed.map(publicCard) : [], { due: !values.list });
    if (!values.list && summary.nextDue) terminal.note(`Next card is due ${summary.nextDue.slice(0, 10)}.`);
    if (!values.list && listed.length) terminal.command('sphinx drill --list');
    terminal.note('Makes no model calls.');
    return 0;
  }
  if (!process.stdin.isTTY) throw new Error('Run sphinx drill in a terminal, or use --json. See sphinx drill --help.');
  return withReadline(async ask => {
    terminal.banner();
    terminal.section('Retention');
    terminal.paragraph(`Due now: ${due.length}. You will see the stored explanation after you answer, then mark again or good.`);
    let asked = 0;
    for (const card of due.slice(0, limit)) {
      asked += 1;
      terminal.blank();
      terminal.section(`Card ${asked} of ${Math.min(limit, due.length)}`);
      terminal.paragraph(card.prompt);
      terminal.note('Write a prediction and a short reason. Enter to reveal. /quit to stop.');
      const answer = (await ask('\nYour answer: ')).trim();
      if (answer === '/quit') { terminal.note('Stopped. Remaining cards stay due.'); return 0; }
      terminal.blank();
      terminal.section('Stored explanation');
      terminal.paragraph(card.back || 'No stored explanation for this card.');
      let rating;
      for (;;) {
        const raw = (await ask('\nagain (tomorrow) or good (next interval): ')).trim().toLowerCase();
        if (raw === '/quit') { terminal.note('Stopped. This card stays due.'); return 0; }
        if (['again', 'a'].includes(raw)) { rating = 'again'; break; }
        if (['good', 'g'].includes(raw)) { rating = 'good'; break; }
        terminal.warning('Type again or good.');
      }
      const reviewed = await reviewCard({ repoRoot: repo.root, id: card.id, rating });
      terminal.note(rating === 'again' ? 'Due tomorrow.' : `Next due ${reviewed.dueAt.slice(0, 10)}.`);
    }
    terminal.blank();
    terminal.success(`Reviewed ${asked} card${asked === 1 ? '' : 's'}.`);
    terminal.note('Makes no model calls.');
    return 0;
  });
}

// Parses and validates a command line before any command runs; exported so documented commands can be checked.
export function parseCommandLine(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, json: { type: 'boolean' }, yes: { type: 'boolean' }, repo: { type: 'boolean' }, staged: { type: 'boolean' },
    preset: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, small: { type: 'string' }, medium: { type: 'string' }, large: { type: 'string' }, level: { type: 'string' }, distance: { type: 'string' }, interface: { type: 'string' }, branches: { type: 'string' }, events: { type: 'string' }, agents: { type: 'string' }, remotes: { type: 'string' },
    remote: { type: 'string' }, branch: { type: 'string' }, id: { type: 'string' }, text: { type: 'string' }, 'allow-paid': { type: 'boolean' },
    context: { type: 'string' }, 'github-check': { type: 'boolean' }, suggest: { type: 'boolean' }, apply: { type: 'string' }, worker: { type: 'boolean' }, retry: { type: 'boolean' }, reason: { type: 'string' }, 'base-url': { type: 'string' }, 'cli-billing': { type: 'string' },
    launch: { type: 'boolean' }, 'no-launch': { type: 'boolean' }, 'retry-review': { type: 'boolean' }, 'max-model-calls': { type: 'string' }, 'max-output-tokens': { type: 'string' },
    list: { type: 'boolean' }, limit: { type: 'string' },
  } });
  const [command, id] = positionals;
  if (values.version || values.help || !command || command === 'help') return { values, command, id };
  if (!HELP[command]) throw new Error(`Unknown command ${command}. Run sphinx --help.`);
  for (const key of Object.keys(values)) if (!OPTIONS[command].includes(key)) throw new Error(`--${key} is not an option for ${command}. Run sphinx ${command} --help.`);
  const needsId = ['answer', 'explain', 'dispute'].includes(command);
  if (positionals.length > (needsId ? 2 : 1)) throw new Error(`Unexpected argument. Usage: ${HELP[command].usage}`);
  if (needsId && !id) throw new Error(`An assessment ID is required. Run sphinx pending to find it. Usage: ${HELP[command].usage}`);
  if (['answer', 'dispute'].includes(command) && !values.text?.trim()) throw new Error(`--text is required. Usage: ${HELP[command].usage}`);
  return { values, command, id };
}

export async function main(argv) {
  if (argv[0] === 'mcp' && argv.length === 1) {
    const { runMcpServer } = await import('./mcp.js');
    await runMcpServer(); return 0;
  }
  if (argv[0] === 'hook') {
    if (process.env.SPHINX_EVALUATOR === '1') return 0;
    if (argv[1] === 'git') {
      const event = argv[2], input = event === 'pre-push' ? await readStdin() : '';
      return dispatchHook({ event, args: argv.slice(3), input, cwd: process.cwd(), env: process.env, gate });
    }
    if (argv[1] === 'agent') {
      const result = await agentHook({ agent: argv[2], input: await readStdin(), cwd: process.cwd(), env: process.env });
      if (result.output) console.log(JSON.stringify(result.output)); return result.exitCode;
    }
    // Cursor's command hook protocol lives in its own module and runs on import.
    if (argv[1] === 'cursor') { await import('./cursor-hook.js'); return 0; }
    throw new Error('Unknown hook entry point.');
  }
  const { values, command, id } = parseCommandLine(argv);
  if (values.version) { if (values.json) json({ version: VERSION }); else console.log(VERSION); return 0; }
  if (values.help || !command || command === 'help') { printHelp(ui(), command === 'help' ? id : command, { json: values.json }); return 0; }
  if (command === 'install') return installCommand(values);
  if (command === 'activate') return activateCommand(values);
  if (command === 'init') return initCommand(values);
  if (command === 'prepare') {
    if (values.worker && values.retry) throw new Error('--retry is for an explicit preparation request, not a worker.');
    const { schedulePreparation, runPreparation } = await import('./preparation.js');
    const result = values.worker
      ? await runPreparation({ cwd: process.cwd() })
      : await schedulePreparation({ cwd: process.cwd(), cliPath: CLI_PATH, retry: !!values.retry });
    if (values.json) json(result);
    else if (!values.worker) {
      const terminal = ui(); terminal.section('Background preparation');
      terminal.paragraph(`Review ${result.status}.${result.reason ? ` ${result.reason}` : ''}`);
      terminal.note('Use sphinx status to inspect progress. Preparation never approves a push.');
    }
    return 0;
  }
  if (command === 'auth') {
    if (values.provider === 'openai') { await authOpenAI(values['base-url']); return 0; }
    if (values.provider !== undefined && values.provider !== 'openrouter') throw new Error('sphinx auth saves credentials for --provider openrouter (default) or --provider openai. Codex and Claude use their own sign-in.');
    if (values['base-url'] !== undefined) throw new Error('--base-url applies to --provider openai.');
    await auth(); return 0;
  }
  if (command === 'uninstall') { printInstallationResult(ui(), await uninstall({ repo: !!values.repo })); return 0; }
  if (command === 'doctor') {
    const result = await doctor();
    if (values.json) json(result);
    else {
      const terminal = ui(); terminal.section('Integration health');
      for (const check of result.checks) { terminal.blank(); (check.ok ? terminal.success : terminal.warning)(check.name); terminal.paragraph(check.detail, '  '); }
      terminal.blank(); (result.checks.every(check => check.ok) ? terminal.success : terminal.warning)(result.checks.every(check => check.ok) ? 'Configured integrations are in place.' : 'Some integrations need attention. See the steps above.');
    }
    return result.checks.every(check => check.ok) ? 0 : 1;
  }
  if (command === 'config') {
    if ([...MODEL_FLAGS, 'distance', 'interface'].some(key => values[key] !== undefined)) {
      const current = await loadConfig(), previousMaxModelCalls = current.maxModelCalls;
      const config = applyInstallOptions(current, values), maxModelCalls = config.maxModelCalls;
      await saveConfig(config);
      const result = { scope: 'global', path: getPaths().config, previousMaxModelCalls, maxModelCalls, config };
      if (values.json) { json(result); return 0; }
      const terminal = ui();
      if (values.interface !== undefined) terminal.success(`Questions appear ${config.interface === 'terminal' ? 'in the terminal (the browser is the fallback)' : config.interface === 'browser' ? 'in the browser' : 'in the browser on a local Mac, otherwise in the terminal'}.`);
      if (values['max-model-calls'] !== undefined) terminal.success(`Saved machine-wide limit: ${modelLimitText(maxModelCalls)} (previously ${modelLimitText(previousMaxModelCalls)}).`);
      if (values['max-output-tokens'] !== undefined) terminal.success(`Saved output allowance: ${config.maxOutputTokens} tokens per request, including model reasoning. Model calls: ${modelLimitText(maxModelCalls)}.`);
      if (MODEL_FLAGS.some(key => !['max-model-calls', 'max-output-tokens'].includes(key) && values[key] !== undefined)) {
        terminal.success('Saved machine-wide evaluator settings.');
        terminal.rows(['small', 'medium', 'large'].map(tier => [tier[0].toUpperCase() + tier.slice(1), routeText(config.models[tier])]));
        terminal.note('Changing evaluator routes applies to fresh checkpoints. Existing checkpoints remain bound to their original assessment policy.');
      }
      terminal.note(result.path);
      if (policyHash(current) !== policyHash(config)) terminal.note('Checks started under the previous settings no longer apply. A Git operation waiting on one stops within a few seconds; run it again to start a fresh check.');
      if (Object.values(config.models).some(route => route.provider === 'openai') && !(await openAIEndpoint().catch(() => null))) terminal.warning('No OpenAI-compatible endpoint is saved yet. Run sphinx auth --provider openai before the next check.');
      terminal.paragraph(`Model calls: ${modelLimitText(maxModelCalls)}. Review, compaction, grading, learning follow-ups, and failed requests stay counted. Saving configuration makes no model request.`);
      terminal.note(`Review planning targets: ${reviewCapsText(config)} calls. Explicit request caps, context limits, and deadlines still apply.`);
      return 0;
    }
    const repo = await git.repository(process.cwd()).catch(() => null), config = await loadConfig(repo?.root);
    if (values.json) { json(config); return 0; }
    const terminal = ui(); terminal.section('Effective configuration'); terminal.rows([['Global settings', getPaths().config]]);
    if (repo) {
      const info = await repositoryConfigInfo(repo.root);
      terminal.rows([['Repository policy', info.exists ? `${info.path}${info.legacy ? ' (legacy)' : ''}` : 'None; global policy applies']]);
      if (info.shadowed) terminal.warning(`Legacy ${info.shadowed} is shadowed by .sphinxconfig.`);
    }
    terminal.section('Checkpoint policy'); printConfiguration(terminal, config);
    terminal.section('Limits and exclusions'); terminal.rows([['Reviewer context', `${config.maxContextBytes.toLocaleString()} bytes in active context; older investigation is compacted`], ['Tool result', `${config.toolResultBytes.toLocaleString()} bytes per page`], ['Reviewer turns', config.agentMaxTurns === null ? 'No request limit; shared limits apply when explicitly configured' : `Up to ${config.agentMaxTurns}, also subject to an explicitly configured total call limit`], ['Reviewer timeout', `${config.timeoutSeconds} seconds per investigation`], ['Configured exclusions', config.exclude.join(', ') || 'None beyond built-in rules and ignore files']]);
    terminal.blank(); terminal.note('Use sphinx config --preset <name> to choose evaluator models, or --max-model-calls <1-100|unlimited> to set or clear an optional call cap. See sphinx config --help for tier overrides and paid routes.'); return 0;
  }
  if (command === 'check') return checkCommand(values);
  if (command === 'usage') {
    const summary = { ledger: usageDir(process.env), ...summarizeUsage(readUsage()) };
    if (values.json) json(summary); else printUsage(ui(), summary, { ledgerPath: summary.ledger });
    return 0;
  }
  if (command === 'drill') return drillCommand(values);
  if (command === 'yolo') {
    const repo = await git.repository(process.cwd()).catch(() => null);
    const result = await toggleYolo({ repoRoot: repo?.root ?? null, reason: values.reason });
    if (values.json) { json(result); return 0; }
    const where = result.scope === 'repo' ? `for ${result.repoRoot}` : 'globally (every repository without its own setting)';
    const terminal = ui();
    if (result.enabled) { terminal.warning(`Yolo mode is ON ${where}. Git operations skip the understanding check; each skip is logged.`); terminal.command('sphinx yolo   # run again to turn it off'); }
    else if (result.reposStillOn) { terminal.success(`Yolo mode is OFF ${where}.`); terminal.warning(`Checks are still skipped in ${result.reposStillOn.length === 1 ? 'a repository' : `${result.reposStillOn.length} repositories`} with ${result.reposStillOn.length === 1 ? 'its' : 'their'} own yolo setting: ${result.reposStillOn.join(', ')}. Run sphinx yolo inside each to turn it off.`); }
    else terminal.success(`Yolo mode is OFF ${where}. Understanding checks are back on.`);
    return 0;
  }
  if (['pending', 'status'].includes(command)) return statusCommand(command, values);
  if (['answer', 'explain', 'dispute'].includes(command)) {
    const { repo, config } = await repoConfig(), existing = await store.read(id);
    if (existing.snapshot.repoRoot !== repo.root) throw new Error('This checkpoint belongs to a different repository.');
    const learn = command === 'explain', dispute = command === 'dispute';
    const result = await withProgress(learn ? 'Preparing an explanation and new scenario' : dispute ? 'Reviewing the question' : 'Checking your reasoning', () => store.answer(id, learn ? 'I do not know. Explain this concept and give me a different scenario to apply it to.' : values.text, config, { learn, dispute }), { enabled: !values.json });
    if (values.json) json(result); else printSession(result); return 0;
  }
}
