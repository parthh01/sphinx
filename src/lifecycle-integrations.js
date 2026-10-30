import path from 'node:path';
import { settingsTarget } from './user-file.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, readFile, mkdir, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { listPresentations, claimPresentation } from './presentations.js';
import { launchCheckpointTerminal, waitForCheckpointTerminal } from './terminal-launch.js';
import { createBrowserInterview } from './browser-interview.js';
import { setupNudge } from './repo-setup.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sessionId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : undefined;
const HERE = fileURLToPath(import.meta.url);

export const TERMINAL_GUIDANCE = [
  'Sphinx checks the human\'s understanding at Git checkpoints selected by .sphinxconfig.',
  'Git alone decides when a checkpoint is required. Do not alter policy or bypass its hooks.',
  'For a blocking checkpoint, the Git hook serves a local Sphinx browser questionnaire and keeps the original Git operation waiting. On macOS the page opens in the background without activating or minimizing your coding window. Other environments print the local URL. After the human passes, they confirm whether that same operation should continue. Git then verifies the exact change and policy before going through. Never start a duplicate Git operation while it waits.',
  'Allow enough shell execution time for the human questionnaire. Sphinx waits up to 25 minutes, but the host may cancel the shell sooner. Keep the original process running using the host\'s supported yielding or background execution; do not terminate or duplicate it while the human answers.',
  'After shell execution, this integration handles fallback requests only. It presents a local browser questionnaire for the exact queued checkpoint and waits for the human\'s result. A fallback interview cannot resume an exited Git process. Do not open another interview or poll for answers.',
  'If a local browser questionnaire is unavailable, the human can run `sphinx check` in their own terminal in the checked repository. No terminal window is opened automatically.',
  'Never run the interview or answer, explain, or dispute commands for the human. Do not relay questions or answers through chat, read private Sphinx session files or answer keys, or automate the questionnaire.',
  'Respect .sphinxignore and configured exclusions. The independent evaluator only sees permitted immutable Git evidence.',
  'The human can learn, dispute, or pause inside the questionnaire (pause reads Stop push or Stop commit while Git waits), and after a pass chooses whether the waiting push or commit goes through. Never open its local URL, submit browser responses, or automate it for the human. After a fallback check passes, verify that the original Git operation has exited with a Sphinx blocking failure before retrying it. If the human passes and then stops the push or commit, or Git stops waiting before they choose, do not retry it unless they ask. Stopping is their decision; a retry reopens the questionnaire and interrupts them with the same choice. Never duplicate a waiting operation or repeat a successful operation.',
].join('\n');

export function lifecycleHome(name, paths, env = process.env) {
  if (name === 'cursor') return path.join(paths.userHome, '.cursor');
  if (name === 'opencode') {
    if (!env.SPHINX_USER_HOME && env.OPENCODE_CONFIG_DIR) return path.resolve(env.OPENCODE_CONFIG_DIR);
    return path.join(!env.SPHINX_USER_HOME && env.XDG_CONFIG_HOME || path.join(paths.userHome, '.config'), 'opencode');
  }
  throw new Error(`Unsupported lifecycle integration: ${name}`);
}

async function text(file) {
  try {
    const target = (await settingsTarget(file)).path, info = await lstat(target);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error(`Refusing to replace a non-file or oversized integration: ${file}`);
    return await readFile(target, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function checkDirectories(home, file) {
  for (const directory of new Set([home, path.dirname(file)])) {
    const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Refusing to change a symlinked or non-directory integration path: ${directory}`);
  }
}

function json(content, file) {
  if (content === null) return {};
  try { const value = JSON.parse(content); if (!object(value)) throw new Error(); return value; }
  catch { throw new Error(`Cannot read ${file}: invalid JSON object. Fix the file and try again.`); }
}

async function write(link, content) {
  const { path: file, linked } = await settingsTarget(link);
  if (content === null && !linked) { await rm(file, { force: true }); return; }
  content ??= '';
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const mode = await stat(file).then(info => info.mode & 0o777).catch(() => 0o600);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { mode, flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

function plan({ name, file, before, after, record }) {
  return {
    name, record,
    async commit() {
      await checkDirectories(record.home, file);
      if (await text(file) !== before) throw new Error(`Settings changed during installation: ${file}. Retry installation.`);
      if (before !== after) await write(file, after);
    },
    async rollback() { if (await text(file) === after) await write(file, before); },
  };
}

/** Cursor exposes command hooks, but no documented hook that invokes MCP forms. */
export async function prepareCursorIntegration(paths, { env = process.env, previous, launcher } = {}) {
  const home = lifecycleHome('cursor', paths, env), file = path.join(home, 'hooks.json');
  await checkDirectories(home, file);
  if (previous && previous.file !== file) throw new Error('Cursor integration home changed. Uninstall from the original home before reinstalling.');
  const before = await text(file), document = json(before, file);
  if (document.version !== undefined && document.version !== 1) throw new Error(`Unsupported Cursor hooks version in ${file}`);
  if (document.hooks !== undefined && !object(document.hooks)) throw new Error(`Invalid hooks object in ${file}`);
  // Through the stable sphinx launcher when available, so package upgrades keep working.
  const command = launcher
    ? `SPHINX_HOME=${quote(paths.home)} ${launcher.env}${launcher.command} hook cursor`
    : `SPHINX_HOME=${quote(paths.home)} ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./cursor-hook.js', import.meta.url)))}`;
  const hooks = [
    { event: 'sessionStart', handler: { command, timeout: 10 } },
    { event: 'postToolUse', handler: { command, timeout: 1800, matcher: '^Shell$' } },
    { event: 'postToolUseFailure', handler: { command, timeout: 1800, matcher: '^Shell$' } },
  ];
  for (const { event } of hooks) {
    const entries = document.hooks?.[event];
    if (entries !== undefined && (!Array.isArray(entries) || entries.some(item => !object(item)))) throw new Error(`Invalid ${event} hooks in ${file}`);
  }
  for (const { event, handler } of previous?.hooks || []) {
    const entries = document.hooks?.[event] || [];
    if (entries.some(item => item.command === handler.command && !same(item, handler))) throw new Error(`Refusing to replace an edited cursor integration in ${file}. Uninstall first to preserve your edits.`);
    if (entries.some(item => same(item, handler))) document.hooks[event] = entries.filter(item => !same(item, handler));
  }
  const emptyEvents = previous?.emptyEvents ?? hooks.filter(({ event }) => document.hooks?.[event]?.length === 0).map(({ event }) => event);
  const record = { kind: 'cursor-terminal-v1', home, file, hooks, emptyEvents, existed: previous?.existed ?? before !== null, hooksExisted: previous?.hooksExisted ?? document.hooks !== undefined, versionExisted: previous?.versionExisted ?? document.version !== undefined };
  document.version = 1; document.hooks ??= {};
  for (const { event, handler } of hooks) {
    document.hooks[event] ??= [];
    if (!document.hooks[event].some(item => same(item, handler))) document.hooks[event].push(handler);
  }
  return plan({ name: 'cursor', file, before, after: `${JSON.stringify(document, null, 2)}\n`, record });
}

/** OpenCode 1.x local JS plugins load without changing opencode.json/JSONC. */
export async function prepareOpenCodeIntegration(paths, { env = process.env, previous } = {}) {
  const home = lifecycleHome('opencode', paths, env), file = path.join(home, 'plugins', 'sphinx.js');
  await checkDirectories(home, file);
  if (previous && previous.file !== file) throw new Error('OpenCode integration home changed. Uninstall from the original home before reinstalling.');
  const before = await text(file);
  const after = `// Managed by Sphinx. OpenCode 1.x lifecycle integration.\nimport { registerOpenCodeIntegration } from ${JSON.stringify(pathToFileURL(HERE).href)};\nexport const SphinxPlugin = async context => registerOpenCodeIntegration(context, { home: ${JSON.stringify(paths.home)} });\n`;
  if (before !== null && before !== after && (!previous || hash(before) !== previous.digest)) throw new Error(`Refusing to replace an existing or edited OpenCode plugin: ${file}`);
  return plan({ name: 'opencode', file, before, after, record: { kind: 'opencode-terminal-v1', home, file, digest: hash(after) } });
}

export async function removeLifecycleIntegration(_paths, record) {
  const warnings = [];
  await checkDirectories(record.home, record.file);
  const before = await text(record.file);
  if (before === null) return warnings;
  if (record.kind === 'opencode-terminal-v1') {
    if (hash(before) === record.digest) await rm(record.file);
    else warnings.push(`Preserved edited OpenCode plugin: ${record.file}`);
    return warnings;
  }
  const document = json(before, record.file);
  for (const { event, handler } of record.hooks || []) {
    const entries = document.hooks?.[event];
    if (!Array.isArray(entries) || !entries.some(item => same(item, handler))) { warnings.push(`Preserved removed or edited Cursor ${event} hook in ${record.file}.`); continue; }
    document.hooks[event] = entries.filter(item => !same(item, handler));
    if (!document.hooks[event].length && !record.emptyEvents?.includes(event)) delete document.hooks[event];
  }
  if (document.hooks && !Object.keys(document.hooks).length && !record.hooksExisted) delete document.hooks;
  if (!record.versionExisted && document.version === 1) delete document.version;
  if (await text(record.file) !== before) throw new Error(`Settings changed during uninstall: ${record.file}. Retry uninstall.`);
  await write(record.file, !record.existed && !Object.keys(document).length ? null : `${JSON.stringify(document, null, 2)}\n`);
  return warnings;
}

export async function lifecycleIntegrationStatus(_paths, { record } = {}) {
  if (!record) return { installed: false, healthy: false };
  try {
    await checkDirectories(record.home, record.file);
    const content = await text(record.file);
    const healthy = record.kind === 'opencode-terminal-v1' ? content !== null && hash(content) === record.digest
      : content !== null && record.hooks.every(({ event, handler }) => json(content, record.file).hooks?.[event]?.some(item => same(item, handler)));
    return { installed: true, healthy, file: record.file };
  } catch { return { installed: true, healthy: false, file: record.file }; }
}

/** Read only routing metadata. Never load questions, answers, source, or tool output. */
export async function terminalHandoff({ cwd, host, hostSession, checkpointIds, env = process.env, listRequests = listPresentations, claimRequest = claimPresentation, launch = launchCheckpointTerminal, waitForResult = waitForCheckpointTerminal } = {}) {
  if (env.SPHINX_EVALUATOR === '1' || !cwd) return null;
  const requests = await listRequests({ cwd, host, hostSession, ...(checkpointIds?.length ? { checkpointIds } : {}), env });
  const opened = [];
  let unavailable = 0;
  for (const request of requests) {
    const result = await launch({ request, env });
    if (result.status === 'unavailable') { unavailable++; continue; }
    if (!['opened', 'already-open', 'passed'].includes(result.status)) continue;
    if (await claimRequest(request, { env })) opened.push({ request, status: result.status });
  }
  const outcomes = await Promise.all(opened.map(async ({ request, status }) => status === 'passed' ? 'passed' : waitForResult({ id: request.id, env })));
  if (!outcomes.length && !unavailable) return null;
  const completed = outcomes.filter(status => status === 'passed').length;
  unavailable += outcomes.filter(status => ['unavailable', 'interrupted'].includes(status)).length;
  if (unavailable) return `Sphinx could not open a desktop terminal or keep its fallback questionnaire running for ${unavailable === 1 ? 'a checkpoint' : `${unavailable} checkpoints`}. The checkpoint remains pending. The human can run \`sphinx check\` in their own terminal in the checked repository. Check desktop availability or Terminal automation permission. Do not open another interview, relay questions, answer for the human, or repeatedly retry Git. Never duplicate a waiting operation; retry only after completion and confirmation that the original Git operation exited with a Sphinx blocking failure.`;
  if (completed === outcomes.length) return 'Sphinx fallback understanding check completed directly in its terminal window. This does not resume an exited Git process. Before retrying, verify that the original Git operation has exited with a Sphinx blocking failure. Never duplicate a waiting operation or repeat a successful operation.';
  return 'The Sphinx fallback terminal questionnaire remains incomplete or is still open. The human answers directly there. Do not open another interview, relay questions, answer for the human, poll for answers, or repeatedly retry Git. Never duplicate a waiting Git operation. Wait for the human before resuming a failed blocking operation.';
}

/** Read only Sphinx's exact emitted marker, never interpret or execute shell text. */
export function cursorCheckpointIds({ tool_output, error_message } = {}) {
  const strings = [];
  if (typeof tool_output === 'string' && Buffer.byteLength(tool_output) <= 1024 * 1024) {
    try {
      const output = JSON.parse(tool_output);
      if (object(output)) for (const key of ['stdout', 'stderr', 'output']) if (typeof output[key] === 'string') strings.push(output[key]);
    } catch { /* Cursor documents a JSON result payload; unknown shapes add no routing hints. */ }
  }
  if (typeof error_message === 'string' && Buffer.byteLength(error_message) <= 1024 * 1024) strings.push(error_message);
  const ids = new Set();
  for (const value of strings) {
    for (const match of value.matchAll(/(?:^|\r?\n)Outside a supported agent, run sphinx check --id ([a-f0-9]{64}) in your terminal\.(?=\r?\n|$)/gu)) {
      ids.add(match[1]);
      if (ids.size === 64) return [...ids];
    }
  }
  return [...ids];
}

/** Browser handoff is the automatic fallback; terminal check remains explicit. */
export async function browserHandoff({ cwd, host, hostSession, checkpointIds, env = process.env,
  listRequests = listPresentations, claimRequest = claimPresentation, createInterview = createBrowserInterview,
  output = line => process.stderr.write(`${line}\n`),
} = {}) {
  if (env.SPHINX_EVALUATOR === '1') return null;
  const requests = await listRequests({ cwd, host, hostSession, checkpointIds, env });
  if (!requests.length) return null;
  const interview = createInterview({ env, output });
  let passed = 0;
  try {
    for (const [index, request] of requests.entries()) {
      const result = await interview.present({ request, env });
      if (result.status === 'unavailable') return 'Sphinx could not start a local browser questionnaire. The human can run `sphinx check` in their own terminal. Do not answer for them or repeat a waiting Git operation.';
      await claimRequest(request, { env });
      if (result.status !== 'passed') {
        // Pause applies to this whole listed attempt, including destinations
        // not shown yet. New Git attempts have different tokens and stay queued.
        for (const remaining of requests.slice(index + 1)) await claimRequest(remaining, { env });
        return 'The Sphinx browser questionnaire is paused or incomplete. Progress is saved. Do not repeat Git or reopen the interview until the human asks; never duplicate a waiting operation.';
      }
      passed++;
    }
    return `${passed} Sphinx checkpoint(s) completed directly in the human’s browser. Verify the original Git operation has exited with a Sphinx blocking failure before retrying it. Never duplicate a waiting operation or repeat a successful operation.`;
  } finally { await interview.close(); }
}

export async function cursorAgentHook({ input = {}, env = process.env, handoff = browserHandoff } = {}) {
  if (env.SPHINX_EVALUATOR === '1') return {};
  const event = input.hook_event_name;
  if (event === 'sessionStart') {
    const nudge = await setupNudge(typeof input.cwd === 'string' ? input.cwd : input.workspace_roots?.[0]);
    return { additional_context: nudge ? `${TERMINAL_GUIDANCE}\n${nudge}` : TERMINAL_GUIDANCE, ...(sessionId(input.session_id || input.conversation_id) ? { env: { SPHINX_CURSOR_SESSION: sessionId(input.session_id || input.conversation_id) } } : {}) };
  }
  if (!['postToolUse', 'postToolUseFailure'].includes(event) || input.tool_name !== 'Shell') return {};
  try {
    const checkpointIds = cursorCheckpointIds(input);
    const notice = await handoff({ cwd: typeof input.cwd === 'string' ? input.cwd : undefined, host: 'cursor', hostSession: sessionId(input.session_id || input.conversation_id), ...(checkpointIds.length ? { checkpointIds } : {}), env });
    return notice ? { additional_context: notice } : {};
  } catch { return { additional_context: 'Sphinx could not inspect its checkpoint queue. The human can run sphinx doctor and sphinx check in their own terminal. Do not answer for them.' }; }
}

export function registerOpenCodeIntegration({ client, directory }, { home, env = process.env, handoff = browserHandoff } = {}) {
  const scopedEnv = { ...env, ...(home ? { SPHINX_HOME: home } : {}) };
  if (env.SPHINX_EVALUATOR === '1') return {};
  return {
    'shell.env': async (input, output) => {
      if (home) output.env.SPHINX_HOME = home;
      if (sessionId(input.sessionID)) output.env.SPHINX_OPENCODE_SESSION = input.sessionID;
    },
    'experimental.chat.system.transform': async (_input, output) => { if (!output.system.includes(TERMINAL_GUIDANCE)) output.system.push(TERMINAL_GUIDANCE); },
    'tool.execute.after': async (input, output) => {
      if (input.tool !== 'bash') return;
      let notice;
      try { notice = await handoff({ cwd: directory, host: 'opencode', hostSession: sessionId(input.sessionID), env: scopedEnv }); }
      catch { notice = 'Sphinx could not inspect its checkpoint queue. Run sphinx doctor and sphinx check in your own terminal.'; }
      if (!notice) return;
      // Only a handoff notice reaches the coding agent; the questionnaire stays
      // in the human's browser. A Git checkpoint remains incomplete meanwhile.
      if (typeof output.output === 'string') output.output += `\n\n${notice}`;
      try { await client?.tui?.showToast({ body: { title: 'Sphinx checkpoint', message: notice, variant: 'info', duration: 10000 } }); } catch { /* The tool output still carries the status when no TUI is attached. */ }
    },
  };
}
