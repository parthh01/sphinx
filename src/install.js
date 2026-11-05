import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { settingsTarget } from './user-file.js';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { constants as osConstants } from 'node:os';
import { getPaths } from './config.js';
import { nativeHookSpecs, installedHookSpecs, hasHook, addHook, removeHook, prepareMcp, commitMcp, rollbackMcp, removeMcp, inspectMcp } from './agent-settings.js';
import { lifecycleHome, prepareCursorIntegration, prepareOpenCodeIntegration, removeLifecycleIntegration, lifecycleIntegrationStatus } from './lifecycle-integrations.js';
import { preparePiIntegration, removePiIntegration, piIntegrationStatus, piIntegrationHome } from './pi-integration.js';

// All documented Git hook names, including server, mail, p4, and fsmonitor hooks.
const HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout',
  'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive',
  'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite',
  'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist',
  'p4-post-changelist', 'p4-pre-submit', 'post-index-change',
];
const GATED = new Set(['pre-push', 'pre-commit']);
const PREPARED = new Set(['post-commit', 'post-merge', 'post-rewrite', 'post-checkout']);
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * The shell command hooks use to run Sphinx. Prefer the package manager's own
 * `sphinx` on PATH (an npm/yarn symlink or a pnpm/bun shim): it survives
 * upgrades, unlike a versioned store path. Node's directory is put first on
 * PATH so GUI-launched agents without a login PATH still find node. A checkout
 * without such a shim falls back to absolute node and CLI paths.
 * Returns shell `env` assignments (placed before any exec) and the `command`.
 */
export async function sphinxLauncher(cliPath, env = process.env, execPath = process.execPath) {
  const real = await realpath(cliPath).catch(() => cliPath);
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir))) {
    const candidate = path.join(directory, 'sphinx');
    try {
      const info = await stat(candidate);
      if (!info.isFile() || !(info.mode & 0o111)) continue;
      const matches = await realpath(candidate) === real
        || (info.size < 64 * 1024 && (await readFile(candidate, 'utf8')).includes('sphinx-understand/bin/sphinx.js'));
      if (matches) return { env: `PATH=${quote(path.dirname(execPath))}:"$PATH" `, command: quote(candidate) };
    } catch { /* Not a usable shim. */ }
  }
  return { env: '', command: `${quote(execPath)} ${quote(cliPath)}` };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const AGENTS = ['codex', 'claude', 'pi', 'cursor', 'opencode'];

function gitEnvironment(env) {
  // An explicit integration home must never write the caller's real global file.
  return env.SPHINX_USER_HOME ? {
    ...env, HOME: env.SPHINX_USER_HOME,
    GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL || path.join(env.SPHINX_USER_HOME, '.gitconfig'),
  } : env;
}

async function git(args, cwd, env, accepted = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: gitEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => accepted.includes(code)
      ? resolve(stdout.trimEnd())
      : reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`)));
  });
}

async function exists(file) {
  try { await access(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(file, fallback) {
  try {
    const value = JSON.parse(await readFile((await settingsTarget(file)).path, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('expected an object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) throw new Error(`Cannot read ${file}: invalid JSON. Fix the file and try again.`);
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

async function writeJson(link, value) {
  // Write through a dotfiles symlink to its target, atomically, keeping the link.
  const file = (await settingsTarget(link)).path;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const mode = await stat(file).then(s => s.mode & 0o777).catch(() => 0o600);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function manifestFor(env) {
  const paths = getPaths(env);
  const manifest = await readJson(paths.install, { version: 1, installs: {}, agents: {} });
  if (manifest.version !== 1 || !manifest.installs || !manifest.agents) throw new Error('Unsupported Sphinx install manifest.');
  return { paths, manifest };
}

async function repoInfo(cwd, env) {
  const root = await git(['rev-parse', '--show-toplevel'], cwd, env);
  const commonDir = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, env);
  // Git refuses --worktree in a repository with linked worktrees unless the extension is on, so ask only then.
  const worktreeEnabled = await git(['config', '--bool', '--get', 'extensions.worktreeConfig'], cwd, env, [0, 1]);
  const worktreeValue = worktreeEnabled === 'true' ? await git(['config', '--worktree', '--get', 'core.hooksPath'], cwd, env, [0, 1]) : '';
  const scope = worktreeValue ? '--worktree' : '--local';
  const identity = scope === '--worktree' ? root : commonDir;
  return { root, commonDir, scope, id: `repo-${hash(identity).slice(0, 20)}` };
}

async function currentConfig(scope, cwd, env) {
  const output = await git(['config', scope, '--null', '--get-all', 'core.hooksPath'], cwd, env, [0, 1]);
  return output ? output.replace(/\0$/, '').split('\0') : [];
}

async function sourceBeforeInstall({ repo, cwd, env, manifest }) {
  const args = repo
    ? ['config', '--path', '--get', 'core.hooksPath']
    : ['config', '--global', '--includes', '--path', '--get', 'core.hooksPath'];
  let value = await git(args, cwd, env, [0, 1]);
  if (!value && !repo) value = await git(['config', '--system', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1, 128]);
  const inherited = Object.values(manifest.installs).find(entry => entry.hookDir === value);
  if (inherited) return inherited.source;
  return value ? { kind: 'path', value } : { kind: 'default' };
}

function sourceShell(source) {
  // git init runs reference-transaction while creating HEAD, before rev-parse
  // accepts the new repository; Git still exports that repository as GIT_DIR.
  return source.kind === 'path'
    ? `hook_dir=${quote(source.value)}\n`
    : 'if ! hook_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then\n  if [ -z "${GIT_DIR:-}" ] || [ ! -d "$GIT_DIR" ]; then\n    git rev-parse --git-common-dir >/dev/null\n    exit 128\n  fi\n  hook_dir=$GIT_DIR\nfi\nhook_dir="$hook_dir/hooks"\n';
}

function hookScript({ event, source, launcher, home, id }) {
  const header = '#!/bin/sh\n# Managed by Sphinx. Existing hooks remain in their original directory.\n';
  if (GATED.has(event)) {
    return `${header}SPHINX_HOME=${quote(home)} SPHINX_INSTALL_ID=${quote(id)} ${launcher.env}exec ${launcher.command} hook git ${quote(event)} "$@"\n`;
  }
  if (PREPARED.has(event)) {
    // The existing hook retains streaming stdin and its exit status. Scheduling
    // has no terminal, runs asynchronously, and never gates the Git operation.
    return `${header}${sourceShell(source)}hook="$hook_dir/${event}"\nstatus=0\nif [ -x "$hook" ]; then\n  "$hook" "$@"\n  status=$?\nfi\nif [ "\${SPHINX_EVALUATOR:-}" != "1" ]; then\n  SPHINX_HOME=${quote(home)} ${launcher.env}${launcher.command} prepare </dev/null >/dev/null 2>&1 &\nfi\nexit "$status"\n`;
  }
  // Protocol hooks such as proc-receive must retain streaming stdin/stdout.
  // They exec the prior hook directly rather than buffering input in Node.
  return `${header}${sourceShell(source)}hook="$hook_dir/${event}"\nif [ -x "$hook" ]; then\n  exec "$hook" "$@"\nfi\nexit 0\n`;
}

async function hookNames(source, cwd, env) {
  let directory;
  if (source.kind === 'path') directory = path.resolve(cwd, source.value);
  else {
    try { directory = path.join(await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, env), 'hooks'); }
    catch { return HOOKS; }
  }
  const existing = await readdir(directory).catch(error => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return [];
    throw error;
  });
  return [...new Set([...HOOKS, ...existing.filter(name => /^[a-z][a-z0-9-]*$/.test(name))])];
}

async function executable(name, env) {
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    try { await access(path.join(directory, name), constants.X_OK); return true; } catch {}
  }
  return false;
}

async function detectedAgents({ paths, env, manifest }) {
  const integrationHome = name => name === 'pi'
    ? piIntegrationHome(paths, env)
    : ['cursor', 'opencode'].includes(name) ? lifecycleHome(name, paths, env) : paths[`${name}Home`];
  return (await Promise.all(AGENTS.map(async name =>
    (await executable(name, env) || await exists(integrationHome(name)) || manifest.agents[name]) ? name : null))).filter(Boolean);
}

export async function detectAgents({ env = process.env } = {}) {
  const { paths, manifest } = await manifestFor(env);
  return detectedAgents({ paths, env, manifest });
}

async function prepareAgents({ agents, paths, env, cliPath, launcher, manifest }) {
  const selected = agents === 'auto'
    ? await detectedAgents({ paths, env, manifest })
    : agents === 'none' ? [] : Array.isArray(agents) ? agents : agents.split(',').map(x => x.trim());
  if ((!selected.length && agents !== 'auto' && agents !== 'none') || selected.some(name => !AGENTS.includes(name))) throw new Error('--agents must be auto, none, or a comma-separated list of codex, claude, pi, cursor, opencode.');
  const result = [];
  for (const name of new Set(selected)) {
    if (['pi', 'cursor', 'opencode'].includes(name)) {
      const prepare = name === 'pi' ? preparePiIntegration : name === 'cursor' ? prepareCursorIntegration : prepareOpenCodeIntegration;
      result.push(await prepare(paths, { env, cliPath, launcher, previous: manifest.agents[name] }));
      continue;
    }
    const file = path.join(paths[`${name}Home`], name === 'codex' ? 'hooks.json' : 'settings.json');
    const document = await readJson(file, {});
    if (document.hooks !== undefined && (!document.hooks || typeof document.hooks !== 'object' || Array.isArray(document.hooks))) throw new Error(`Invalid hooks object in ${file}`);
    const command = `SPHINX_HOME=${quote(paths.home)} ${launcher.env}${launcher.command} hook agent ${name}`;
    const handler = { type: 'command', command, timeout: 10 };
    const hooks = nativeHookSpecs(name, handler);
    for (const { event } of hooks) {
      if (document.hooks?.[event] !== undefined && (!Array.isArray(document.hooks[event]) || document.hooks[event].some(group => !group || typeof group !== 'object' || !Array.isArray(group.hooks)))) throw new Error(`Invalid ${event} hooks in ${file}`);
    }
    const previous = manifest.agents[name];
    if (previous && previous.file !== file) throw new Error(`${name} integration home changed. Uninstall the existing integration using its original home before reinstalling.`);
    for (const spec of previous ? installedHookSpecs(previous) : []) {
      const old = spec.group.hooks[0];
      const lookalike = (document.hooks?.[spec.event] || []).some(group => group.hooks.some(item => old.type === 'command' ? item?.command === old.command : item?.server === old.server && item?.tool === old.tool));
      if (!hasHook(document, spec) && lookalike) throw new Error(`Refusing to replace an edited ${name} integration in ${file}. Uninstall first to preserve your edits.`);
    }
    const mcp = await prepareMcp({ name, paths, env, cliPath, previous: previous?.mcp });
    const emptyEvents = previous?.emptyEvents ?? hooks.filter(({ event }) => Array.isArray(document.hooks?.[event]) && document.hooks[event].length === 0).map(({ event }) => event);
    result.push({ name, file, document, originalDocument: structuredClone(document), handler, hooks, mcp, previous, emptyEvents, existed: previous?.existed ?? await exists(file) });
  }
  return result;
}

export async function installedAgents({ env = process.env } = {}) {
  const { manifest } = await manifestFor(env);
  return AGENTS.filter(name => manifest.agents[name]);
}

export async function install({ config, agents = 'auto', repo = false, cwd = process.cwd(), env = process.env, cliPath }) {
  if (!cliPath || !path.isAbsolute(cliPath)) throw new Error('Installation requires an absolute CLI path.');
  if (process.platform === 'win32') throw new Error('Use Sphinx from WSL; native Windows installation is not supported yet.');
  const { paths, manifest } = await manifestFor(env);
  const messages = [], warnings = [];
  const info = repo ? await repoInfo(cwd, env) : { id: 'global', scope: '--global', root: null };
  const id = info.id;
  const previous = manifest.installs[id];
  // Validate every selected settings file before mutating any integration.
  const launcher = await sphinxLauncher(cliPath, env);
  const agentPlans = await prepareAgents({ agents, paths, env, cliPath, launcher, manifest });
  const scopeValues = await currentConfig(info.scope, cwd, env);
  if (previous && scopeValues.at(-1) !== previous.hookDir) {
    throw new Error('Git hooks changed since Sphinx was installed. Run sphinx uninstall first; your current configuration will be preserved.');
  }
  const entry = previous || {
    id, scope: info.scope, root: info.root,
    hookDir: path.join(paths.home, 'hooks', id),
    previousValues: scopeValues,
    source: await sourceBeforeInstall({ repo, cwd, env, manifest }), files: {},
  };
  const directoryState = await lstat(entry.hookDir).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (directoryState?.isSymbolicLink()) throw new Error(`Refusing to replace a symlinked hook directory: ${entry.hookDir}`);
  const names = await hookNames(entry.source, cwd, env);
  const scripts = names.map(event => ({ event, content: hookScript({ event, source: entry.source, launcher, home: paths.home, id }) }));
  for (const { event, content } of scripts) {
    const file = path.join(entry.hookDir, event);
    const fileState = await lstat(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (fileState?.isSymbolicLink()) throw new Error(`Refusing to overwrite edited hook symlink: ${file}`);
    if (fileState) {
      const current = await readFile(file, 'utf8');
      if (hash(current) !== entry.files[event] && current !== content) throw new Error(`Refusing to overwrite edited hook: ${file}`);
    }
  }
  await mkdir(entry.hookDir, { recursive: true, mode: 0o700 });
  for (const { event, content } of scripts) {
    const file = path.join(entry.hookDir, event);
    await writeFile(file, content, { mode: 0o755 });
    await chmod(file, 0o755);
    entry.files[event] = hash(content);
  }
  entry.preparationVersion = 1;
  manifest.installs[id] = entry;
  await writeJson(paths.install, manifest);
  await git(['config', info.scope, '--replace-all', 'core.hooksPath', entry.hookDir], cwd, env);
  messages.push(`Git hooks installed ${repo ? `for ${info.root}` : 'for this user'}. Existing hooks are chained.`);
  for (const plan of agentPlans) {
    if (plan.commit) {
      await plan.commit();
      try {
        manifest.agents[plan.name] = plan.record;
        await writeJson(paths.install, manifest);
      } catch (error) { await plan.rollback(); throw error; }
      messages.push(plan.name === 'pi' ? 'Pi extension installed with native human questionnaire dialogs.' : `${plan.name === 'cursor' ? 'Cursor lifecycle hooks' : 'OpenCode lifecycle plugin'} installed with local browser questionnaires; no automatic terminal popup.`);
      continue;
    }
    const { name, file, document, handler, hooks, mcp, previous: prior, existed, emptyEvents } = plan;
    for (const spec of prior ? installedHookSpecs(prior) : []) removeHook(document, spec);
    for (const spec of hooks) addHook(document, spec);
    await commitMcp(mcp);
    try {
      if (!same(await readJson(file, {}), plan.originalDocument)) throw new Error(`Settings changed during installation: ${file}. Retry installation.`);
      await writeJson(file, document);
    } catch (error) { await rollbackMcp(mcp); throw error; }
    manifest.agents[name] = { file, handler, hooks, existed, emptyEvents, mcp: mcp.record };
    await writeJson(paths.install, manifest);
    messages.push(`${name === 'codex' ? 'Codex' : 'Claude Code'} native questionnaire hooks and Sphinx MCP server installed.`);
  }
  if (!agentPlans.length && agents === 'auto') warnings.push('No supported coding agent was detected. Install one, then rerun sphinx install; Git hooks are ready.');
  if (!repo) {
    try {
      await git(['rev-parse', '--git-dir'], cwd, env);
      const effective = await git(['config', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1]);
      if (!Object.values(manifest.installs).some(installed => installed.hookDir === effective)) warnings.push('This repository overrides core.hooksPath. Run sphinx install --repo here to chain that hook setup.');
    } catch {}
  }
  return { messages, warnings, agents: agentPlans.map(plan => plan.name) };
}

export async function uninstall({ env = process.env, cwd = process.cwd(), repo = false } = {}) {
  const { paths, manifest } = await manifestFor(env);
  const messages = [], warnings = [];
  const id = repo ? (await repoInfo(cwd, env)).id : 'global';
  const entry = manifest.installs[id];
  if (entry) {
    const values = await currentConfig(entry.scope, cwd, env);
    if (values.length === 1 && values[0] === entry.hookDir) {
      await git(['config', entry.scope, '--unset-all', 'core.hooksPath'], cwd, env, [0, 5]);
      for (const value of entry.previousValues) await git(['config', entry.scope, '--add', 'core.hooksPath', value], cwd, env);
    } else warnings.push('Git core.hooksPath changed after installation; the current setting was preserved.');
    const hookDirectoryState = await lstat(entry.hookDir).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (hookDirectoryState?.isSymbolicLink()) warnings.push(`Preserved edited hook directory symlink: ${entry.hookDir}`);
    for (const [name, digest] of Object.entries(hookDirectoryState?.isSymbolicLink() ? {} : entry.files)) {
      const file = path.join(entry.hookDir, name);
      const state = await lstat(file).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (state?.isSymbolicLink()) { warnings.push(`Preserved edited hook symlink: ${file}`); continue; }
      if (!await exists(file)) continue;
      if (hash(await readFile(file)) === digest) await rm(file);
      else warnings.push(`Preserved edited hook: ${file}`);
    }
    await rmdir(entry.hookDir).catch(() => {});
    delete manifest.installs[id];
    messages.push(`Removed ${repo ? 'repository' : 'global'} Git integration.`);
  } else messages.push(`No ${repo ? 'repository' : 'global'} Git integration was installed.`);
  // Repository uninstall only removes its Git override; agent integration is user-wide.
  if (!repo) {
    for (const [name, installed] of Object.entries(manifest.agents)) {
      try {
        if (['pi', 'cursor', 'opencode'].includes(name)) {
          warnings.push(...await (name === 'pi' ? removePiIntegration : removeLifecycleIntegration)(paths, installed));
          delete manifest.agents[name];
          messages.push(`Removed managed ${name} integration; any user edits were preserved.`);
          continue;
        }
        const document = await readJson(installed.file, {});
        let removed = false;
        for (const spec of installedHookSpecs(installed)) {
          if (removeHook(document, spec)) removed = true;
          else warnings.push(`The ${name} ${spec.event} hook was removed or edited after installation; its settings were preserved.`);
        }
        for (const event of installed.emptyEvents || []) {
          document.hooks ??= {};
          document.hooks[event] ??= [];
        }
        if (removed) {
          if (!installed.existed && !Object.keys(document).length) await rm(installed.file, { force: true });
          else await writeJson(installed.file, document);
          messages.push(`Removed ${name} integration.`);
        }
        const mcpResult = await removeMcp(installed.mcp);
        if (mcpResult.edited) warnings.push(`The ${name} sphinx MCP server was edited after installation; preserved ${installed.mcp.file}.`);
        if (mcpResult.removed) messages.push(`Removed ${name} Sphinx MCP registration.`);
        delete manifest.agents[name];
      } catch (error) { warnings.push(error.message); }
    }
    if (Object.keys(manifest.installs).length) warnings.push('Repository integrations remain installed. Run sphinx uninstall --repo in those repositories to remove them.');
  }
  if (await exists(paths.install)) await writeJson(paths.install, manifest);
  return { messages, warnings };
}

export async function dispatchHook({ event, args = [], input = '', cwd = process.cwd(), env = process.env, gate }) {
  if (!/^[a-z][a-z0-9-]*$/.test(event)) throw new Error('Invalid Git hook event.');
  const { manifest } = await manifestFor(env);
  let entry = manifest.installs[env.SPHINX_INSTALL_ID];
  if (!entry) {
    const effective = await git(['config', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1]);
    entry = Object.values(manifest.installs).find(item => item.hookDir === effective);
  }
  if (!entry) throw new Error('Sphinx hook installation is missing. Run sphinx install to repair it.');
  if (Number(env.SPHINX_HOOK_DEPTH || 0) > 0) throw new Error('Recursive Sphinx Git hook detected. Run sphinx doctor and repair the hook chain.');
  const directory = entry.source.kind === 'path' ? path.resolve(cwd, entry.source.value)
    : path.join(await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, env), 'hooks');
  const original = path.join(directory, event);
  let isExecutable = false;
  try { await access(original, constants.X_OK); isExecutable = true; } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
  }
  if (isExecutable) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(original, args, { cwd, env: { ...env, SPHINX_HOOK_DEPTH: '1' }, stdio: [event === 'pre-commit' ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
      child.stdin?.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
      child.on('error', reject);
      child.on('close', (status, signal) => resolve(status ?? (osConstants.signals[signal] ? 128 + osConstants.signals[signal] : 1)));
      child.stdin?.end(input);
    });
    if (code !== 0) return code;
  }
  if (env.SPHINX_EVALUATOR === '1' || !GATED.has(event)) return 0;
  return gate({ event, args, input, cwd });
}

export async function doctor({ env = process.env, cwd = process.cwd() } = {}) {
  const { paths, manifest } = await manifestFor(env);
  const checks = [];
  const global = manifest.installs.global;
  const globalValue = await git(['config', '--global', '--includes', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1]);
  checks.push({ name: 'Global Git hooks', ok: !!global && globalValue === global.hookDir, detail: globalValue || 'Not installed' });
  try {
    await git(['rev-parse', '--git-dir'], cwd, env);
    const effective = await git(['config', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1]);
    const entry = Object.values(manifest.installs).find(item => item.hookDir === effective);
    checks.push({ name: 'Current repository', ok: !!entry, detail: entry ? `Sphinx active: ${effective}` : 'Not covered. A local, worktree, or conditional override may require sphinx install --repo.' });
    if (entry) {
      for (const name of [...GATED, ...PREPARED]) {
        const file = path.join(entry.hookDir, name);
        const content = await readFile(file).catch(() => null);
        let runnable = false;
        try { await access(file, constants.X_OK); runnable = true; } catch {}
        const preparationCurrent = !PREPARED.has(name) || entry.preparationVersion === 1;
        checks.push({ name: `${name} dispatcher`, ok: preparationCurrent && runnable && content !== null && hash(content) === entry.files[name], detail: preparationCurrent ? file : 'Background preparation hooks need updating. Run sphinx install.' });
      }
    }
  } catch { checks.push({ name: 'Current repository', ok: true, detail: 'Not inside a Git repository; global installation still applies to other repositories.' }); }
  for (const name of AGENTS) {
    const installed = manifest.agents[name];
    if (['pi', 'cursor', 'opencode'].includes(name)) {
      const result = await (name === 'pi' ? piIntegrationStatus : lifecycleIntegrationStatus)(paths, { record: installed, env });
      checks.push({ name: `${name} integration`, ok: installed ? result.healthy : true, detail: !installed
        ? `Not selected. Optional: sphinx install --agents ${name}.`
        : !result.healthy ? `Integration is missing or changed. Run sphinx install --agents ${name}.`
          : name === 'pi' ? `${result.file}; native human dialogs configured. Run /reload in Pi; dialog support is required.`
            : `${result.file}; local browser questionnaires configured. macOS opens the page in the background; other environments show its local URL. Human answers stay in the questionnaire; terminal checks are explicit${name === 'cursor' ? '; local sessions only, not cloud agents' : '; OpenCode 1.x plugin'}.` });
      continue;
    }
    let present = false;
    if (installed) {
      try {
        const document = await readJson(installed.file, {});
        present = !!installed.hooks && installedHookSpecs(installed).every(spec => hasHook(document, spec));
      } catch {}
    }
    checks.push({ name: `${name} integration`, ok: installed ? present : true, detail: present
      ? `${installed.file}; native questionnaire hooks configured${name === 'codex' ? '; review/trust in /hooks is required and cannot be verified by Sphinx' : '; start a new session to load changes'}`
      : installed ? `Native questionnaire hooks are missing, legacy, or changed. Run sphinx install --agents ${name}.`
        : `Not selected. Optional: sphinx install --agents ${name}.` });
    if (installed) {
      const mcpPresent = await inspectMcp(installed.mcp);
      checks.push({ name: `${name} questionnaire server`, ok: mcpPresent, detail: mcpPresent
        ? `${installed.mcp.file}; sphinx registration present. Connection and native-form support must be checked in the host /mcp panel.`
        : `Sphinx MCP registration is missing or changed. Run sphinx install --agents ${name}.` });
    }
  }
  checks.push({ name: 'Sphinx state', ok: true, detail: paths.home });
  return { checks };
}
