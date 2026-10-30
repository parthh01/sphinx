import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, writeFile, rename, chmod, lstat, unlink } from 'node:fs/promises';

// openai means any OpenAI chat-completions-compatible endpoint the user saves.
export const PROVIDERS = Object.freeze(['openrouter', 'codex', 'claude', 'openai', 'auto']);

export const DEFAULT_CONFIG = {
  version: 1, enabled: true, provider: 'openrouter', model: 'openrouter/free',
  level: 'standard', distance: 'mixed', audit: 'large', mode: 'block', interface: 'auto', events: ['pre-push'],
  branches: ['main', 'master'], remotes: ['*'], exclude: [],
  maxContextBytes: 100000, timeoutSeconds: 180, receiptHours: 24,
  maxModelCalls: null, maxOutputTokens: 4096, allowPaid: false, cliBilling: 'plan',
  agentMaxTurns: null, toolResultBytes: 16000,
  backgroundPreparation: true, preparationDebounceMs: 1500, workingContext: true,
  // GitHub stamps never affect a check; see src/github.js.
  github: { status: true, comment: false, answers: false },
  models: {
    small: { provider: 'openrouter', model: 'openrouter/free' },
    medium: { provider: 'openrouter', model: 'openrouter/free' },
    large: { provider: 'openrouter', model: 'openrouter/free' },
  },
  routing: {
    smallMaxLines: 80, smallMaxFiles: 3, largeMinLines: 400, largeMinFiles: 12,
    riskPatterns: ['auth', 'permission', 'migration', 'billing', 'payment', 'crypto', 'security', 'terraform'],
  },
};

/** Understanding distance: how close to the code questions get. One wording everywhere. */
export const DISTANCES = Object.freeze({
  high: { label: 'High level', description: 'High-level design: what the change does, how it fits into the system, and what it affects.' },
  mixed: { label: 'Mixed', description: 'A bit of both: some high-level design questions, some low-level implementation details.' },
  low: { label: 'Low level', description: 'Low-level implementation details: the specific logic, conditions, and edge cases.' },
});

export function getPaths(env = process.env) {
  const userHome = path.resolve(env.SPHINX_USER_HOME || homedir());
  const home = path.resolve(env.SPHINX_HOME || path.join(userHome, '.config', 'sphinx'));
  return {
    home, userHome, config: path.join(home, 'config.json'), sessions: path.join(home, 'sessions'),
    install: path.join(home, 'install.json'), credentials: path.join(home, 'credentials.json'),
    codexHome: path.resolve((!env.SPHINX_USER_HOME && env.CODEX_HOME) || path.join(userHome, '.codex')),
    claudeHome: path.resolve((!env.SPHINX_USER_HOME && env.CLAUDE_CONFIG_DIR) || path.join(userHome, '.claude')),
  };
}

export async function readJson(file, fallback) {
  let handle;
  try {
    handle=await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info=await handle.stat();
    if(!info.isFile() || info.size>4*1024*1024)throw new Error('not a regular JSON file or exceeds 4 MiB');
    const raw=await handle.readFile('utf8');
    try { return JSON.parse(raw); } catch { throw new Error('invalid JSON'); }
  }
  catch (e) {
    if (e.code === 'ENOENT' && arguments.length > 1) return fallback;
    throw new Error(`Cannot read ${file}: ${e.code || e.message}`);
  } finally { await handle?.close(); }
}

export async function writeJson(file, value, { signal } = {}) {
  signal?.throwIfAborted();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', signal });
    signal?.throwIfAborted();
    await rename(tmp, file);
    await chmod(file, 0o600);
  } finally {
    await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function validateConfig(config) {
  const fail = (message) => { throw new Error(`Invalid Sphinx configuration: ${message}`); };
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('expected an object');
  const allowed = new Set(Object.keys(DEFAULT_CONFIG));
  for (const key of Object.keys(config)) if (!allowed.has(key)) fail(`unknown setting ${key}`);
  if (config.version !== 1) fail('version must be 1');
  for (const key of ['enabled', 'allowPaid', 'backgroundPreparation', 'workingContext']) if (typeof config[key] !== 'boolean') fail(`${key} must be boolean`);
  for (const [key, values] of Object.entries({ provider: PROVIDERS, level: ['relaxed','standard','thorough'], distance: ['high','mixed','low'], audit: ['large','all'], interface: ['auto','browser','terminal'], mode: ['block'], cliBilling: ['plan','api'] })) {
    if (key === 'mode' && config.mode === 'advisory') fail('mode "advisory" was removed. Remove mode from your configuration; use sphinx yolo to bypass checks when urgent');
    if (!values.includes(config[key])) fail(`${key} must be ${values.join(', ')}`);
  }
  if (config.model !== null && (typeof config.model !== 'string' || !config.model.trim())) fail('model must be a nonempty string or null');
  for (const key of ['events','branches','remotes','exclude']) {
    if (!Array.isArray(config[key]) || config[key].some(x => typeof x !== 'string' || !x.length)) fail(`${key} must be an array of nonempty strings`);
  }
  if (config.events.some(x => !['pre-push','pre-commit'].includes(x))) fail('events must use pre-push or pre-commit');
  if (config.maxModelCalls !== null && (!Number.isInteger(config.maxModelCalls) || config.maxModelCalls < 1 || config.maxModelCalls > 100)) fail('maxModelCalls must be null (unlimited) or an integer between 1 and 100');
  if (config.agentMaxTurns !== null && (!Number.isInteger(config.agentMaxTurns) || config.agentMaxTurns < 2 || config.agentMaxTurns > 50)) fail('agentMaxTurns must be null (unlimited) or an integer between 2 and 50');
  for (const [key, min, max] of [['maxContextBytes',1000,1000000],['timeoutSeconds',1,600],['receiptHours',1,720],['maxOutputTokens',512,16384],['toolResultBytes',1000,64000],['preparationDebounceMs',0,60000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) fail(`${key} must be an integer between ${min} and ${max}`);
  }
  if (!config.models || typeof config.models !== 'object') fail('models must define small, medium, and large routes');
  for (const tier of ['small','medium','large']) {
    const route = config.models[tier];
    if (!route || !PROVIDERS.includes(route.provider)) fail(`models.${tier}.provider is invalid`);
    if (route.provider === 'openai' && !route.model) fail(`models.${tier} needs a model ID from your endpoint, for example openai:gpt-5-mini`);
    if (route.model !== null && (typeof route.model !== 'string' || !route.model.trim())) fail(`models.${tier}.model must be a string or null`);
    if (Object.keys(route).some(k => !['provider','model'].includes(k))) fail(`unexpected field in models.${tier}`);
  }
  if (Object.keys(config.models).some(k => !['small','medium','large'].includes(k))) fail('unknown model tier');
  if (!config.github || typeof config.github !== 'object' || Array.isArray(config.github)) fail('github must be an object');
  for (const key of Object.keys(config.github)) if (!Object.hasOwn(DEFAULT_CONFIG.github, key) || typeof config.github[key] !== 'boolean') fail(`github.${key} must be one of status, comment, answers set to true or false`);
  if (!config.routing || typeof config.routing !== 'object') fail('routing is required');
  for (const key of Object.keys(config.routing)) if (!Object.hasOwn(DEFAULT_CONFIG.routing,key)) fail(`unknown routing setting ${key}`);
  for (const k of ['smallMaxLines','smallMaxFiles','largeMinLines','largeMinFiles']) {
    if (!Number.isInteger(config.routing[k]) || config.routing[k] < 1) fail(`routing.${k} must be a positive integer`);
  }
  if (config.routing.largeMinLines <= config.routing.smallMaxLines || config.routing.largeMinFiles <= config.routing.smallMaxFiles) fail('large routing thresholds must exceed small thresholds');
  if (!Array.isArray(config.routing.riskPatterns) || config.routing.riskPatterns.some(s => typeof s !== 'string' || !s)) fail('routing.riskPatterns must be strings');
  return config;
}

function merged(base, overrides) {
  return { ...base, ...overrides, models: { ...base.models, ...overrides?.models }, routing: { ...base.routing, ...overrides?.routing }, github: { ...base.github, ...overrides?.github } };
}

export const REPOSITORY_CONFIG_KEYS = Object.freeze(['version','enabled','level','distance','mode','events','branches','remotes','exclude','backgroundPreparation','github']);

export function validateRepositoryConfig(local, { env = process.env, source = '.sphinxconfig' } = {}) {
  if (!local || typeof local !== 'object' || Array.isArray(local)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(local))) {
    throw new Error(`Repository ${source} must be a JSON object.`);
  }
  for (const key of Object.keys(local)) {
    if (!REPOSITORY_CONFIG_KEYS.includes(key)) {
      throw new Error(`Repository ${source} cannot set ${key}; configure model routes and budgets in ${getPaths(env).config}.`);
    }
  }
  validateConfig(merged(structuredClone(DEFAULT_CONFIG), local));
  return local;
}

async function fileInfo(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** The canonical policy wins completely; shadowed legacy data is never read or merged. */
export async function repositoryConfigInfo(repoRoot) {
  const canonical = path.resolve(repoRoot, '.sphinxconfig');
  const legacy = path.resolve(repoRoot, '.sphinx.json');
  const [canonicalInfo, legacyInfo] = await Promise.all([fileInfo(canonical), fileInfo(legacy)]);
  const selected = canonicalInfo ? canonical : legacyInfo ? legacy : canonical;
  const info = canonicalInfo || legacyInfo;
  if (info && !info.isFile()) throw new Error(`Repository configuration must be a regular file, not a symlink or directory: ${selected}`);
  return {
    path: selected, exists: Boolean(info), legacy: !canonicalInfo && Boolean(legacyInfo),
    ...(canonicalInfo && legacyInfo ? { shadowed: legacy } : {}),
  };
}

export async function loadConfig(repoRoot, env = process.env) {
  const global = await readJson(getPaths(env).config, {});
  if (!global || typeof global !== 'object' || Array.isArray(global)) throw new Error('Global Sphinx configuration must be a JSON object.');
  for (const key of ['models','routing']) {
    if (Object.hasOwn(global,key) && (!global[key] || typeof global[key]!=='object' || Array.isArray(global[key]))) throw new Error(`Global ${key} must be a JSON object.`);
  }
  let config = merged(structuredClone(DEFAULT_CONFIG), global);
  // A legacy/single-provider configuration applies to all tiers unless routes are explicit.
  if ((Object.hasOwn(global,'provider') || Object.hasOwn(global,'model')) && !global.models) {
    config.models = Object.fromEntries(['small','medium','large'].map(t => [t,{provider:config.provider,model:config.model}]));
  }
  validateConfig(config);
  if (repoRoot) {
    const source = await repositoryConfigInfo(repoRoot);
    const local = source.exists ? await readJson(source.path) : {};
    validateRepositoryConfig(local, { env, source: path.basename(source.path) });
    config = merged(config, {...local,exclude:[...new Set([...config.exclude,...(local.exclude||[])])],backgroundPreparation:config.backgroundPreparation && local.backgroundPreparation !== false});
  }
  return validateConfig(config);
}

export async function saveConfig(config, env = process.env) {
  validateConfig(config);
  await writeJson(getPaths(env).config, config);
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
// What a check asks and which Git operations it covers: events, destinations,
// exclusions, depth, distance, and the size tiers that set question ceilings.
// Reviewer routes and run settings (limits, timeouts, spending, billing,
// preparation, receipt lifetime, the question audit, where questions appear,
// GitHub stamps) are left out, so changing them keeps prepared checks and passes.
// Version the contract when assessment semantics change: older questions and
// receipts must not stand in for an assessment under the new requirements.
export function policyHash({ version, enabled, mode, events, branches, remotes, exclude, level, distance, routing }) {
  return createHash('sha256').update(stableStringify({ version, enabled, mode, events, branches, remotes, exclude, level, distance, routing, assessmentContract: 3 })).digest('hex');
}

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Saving one credential keeps the others.
async function updateCredentials(env, update) {
  const file = getPaths(env).credentials;
  let current = {};
  try { const value = await readJson(file, {}); if (isRecord(value)) current = value; } catch {}
  await writeJson(file, update({ ...current }));
}

export async function saveOpenRouterKey(key, env = process.env) {
  if (typeof key !== 'string' || !key.trim() || /\s/.test(key.trim())) throw new Error('Enter a valid OpenRouter API key.');
  await updateCredentials(env, credentials => ({ ...credentials, openrouter: key.trim() }));
}
export async function openRouterKey(env = process.env) {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  try {
    const credentials = await readJson(getPaths(env).credentials, {});
    const key = credentials?.openrouter;
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || /\s/.test(key))) throw new Error('Invalid key');
    return key || null;
  } catch { throw new Error('Could not read Sphinx credentials. Run sphinx auth to save your key again.'); }
}

// OpenAI-compatible endpoints. The URL and key are stored together, so a saved
// key is only ever sent to the URL it was saved with. OPENAI_API_KEY is never read.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export function normalizeBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  let url;
  try { url = new URL(text); } catch { throw new Error('Enter a base URL such as https://api.openai.com/v1.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new Error('The base URL must use https://. Plain http:// is allowed only for localhost.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Enter the base URL without credentials, a query string, or a fragment.');
  // Accept a pasted full endpoint; requests always go to <base URL>/chat/completions.
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '').replace(/\/chat\/completions$/u, '')}`;
}
const validKey = key => typeof key === 'string' && /^[\x21-\x7e]{1,4096}$/u.test(key);

/** A key is optional only for a localhost server such as Ollama or LM Studio. */
export async function saveOpenAIEndpoint({ baseUrl, apiKey }, env = process.env) {
  const url = normalizeBaseUrl(baseUrl), key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;
  if (key && !validKey(key)) throw new Error('Enter the API key as a single token without spaces.');
  if (!key && !LOOPBACK.has(new URL(url).hostname)) throw new Error('This endpoint needs an API key. Only localhost endpoints may omit it.');
  await updateCredentials(env, credentials => ({ ...credentials, openai: { baseUrl: url, ...(key ? { apiKey: key } : {}) } }));
  return url;
}

/** SPHINX_OPENAI_BASE_URL and SPHINX_OPENAI_API_KEY replace the saved endpoint as a pair. */
export async function openAIEndpoint(env = process.env) {
  if (env.SPHINX_OPENAI_BASE_URL || env.SPHINX_OPENAI_API_KEY) {
    if (!env.SPHINX_OPENAI_BASE_URL) throw new Error('Set SPHINX_OPENAI_BASE_URL together with SPHINX_OPENAI_API_KEY.');
    const key = env.SPHINX_OPENAI_API_KEY?.trim() || null;
    if (key && !validKey(key)) throw new Error('SPHINX_OPENAI_API_KEY must be a single token without spaces.');
    return { baseUrl: normalizeBaseUrl(env.SPHINX_OPENAI_BASE_URL), apiKey: key };
  }
  try {
    const value = (await readJson(getPaths(env).credentials, {}))?.openai;
    if (value === undefined) return null;
    if (!isRecord(value) || (value.apiKey !== undefined && !validKey(value.apiKey))) throw new Error('invalid');
    return { baseUrl: normalizeBaseUrl(value.baseUrl), apiKey: value.apiKey ?? null };
  } catch { throw new Error('Could not read the saved OpenAI-compatible endpoint. Run sphinx auth --provider openai to save it again.'); }
}
