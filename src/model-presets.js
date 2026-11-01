// Reviewed against the linked provider documentation on 2026-10-15.
// These are explicit starting models, not automatic fallbacks. Existing saved
// routes are not migrated when this list changes, apart from the one-time move
// of claude:haiku to claude:sonnet in config.js. Prices are reference rates
// per million tokens; provider routing and future prices may differ.
export const REVIEWER_PRESETS = Object.freeze([
  {
    id: 'codex-economy', label: 'Codex · low usage',
    description: 'GPT-6 Luna for every change size. Uses your Codex sign-in and allowance; account access is required. Review size and reasoning effort still scale with the change.',
    models: {
      small: { provider: 'codex', model: 'gpt-6-luna' },
      medium: { provider: 'codex', model: 'gpt-6-luna' },
      large: { provider: 'codex', model: 'gpt-6-luna' },
    },
    allowPaid: false,
    sources: ['https://learn.chatgpt.com/docs/models'],
  },
  // Sonnet, not Haiku: Claude Code 2.1.292 ran Haiku 4.5 with extended thinking whatever --effort asked, so an
  // investigating review took 144 s or hit the 180 s deadline. The id stays: install scripts and plan recovery use it.
  {
    id: 'claude-economy', label: 'Claude Code · Sonnet',
    description: 'Sonnet for every change size. Uses your Claude CLI sign-in and allowance. Review size and reasoning effort still scale with the change. The sonnet alias follows your provider’s available Sonnet model; no automatic Opus upgrade.',
    models: {
      small: { provider: 'claude', model: 'sonnet' },
      medium: { provider: 'claude', model: 'sonnet' },
      large: { provider: 'claude', model: 'sonnet' },
    },
    allowPaid: false,
    sources: ['https://code.claude.com/docs/en/model-config'],
  },
  {
    id: 'openrouter-value', label: 'OpenRouter · Haiku 5.5 (experimental, paid)',
    description: 'Lower-cost option: Haiku 5.5 for every change size, with an 8,192-token output ceiling including reasoning. Tests found false rejections of sufficient answers; see eval/RESULTS.md. Reference input/output prices per 1M tokens start at $0.10/$0.50 below 100k input tokens; higher context tiers cost more. Uses OpenRouter API credits, not your coding-agent allowance.',
    models: {
      small: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' },
      medium: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' },
      large: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' },
    },
    maxOutputTokens: 8192,
    allowPaid: true,
    sources: ['https://openrouter.ai/anthropic/claude-haiku-5.5', 'https://openrouter.ai/api/v1/models/anthropic/claude-haiku-5.5/endpoints'],
  },
  {
    id: 'openrouter-deepseek', label: 'OpenRouter · DeepSeek V3.2 (experimental, paid)',
    description: 'An open-weight alternative for every change size. Synthetic tests found question-quality and grading failures; see eval/RESULTS.md. Requires an OpenRouter key and credits; billed separately from your coding agent.',
    models: {
      small: { provider: 'openrouter', model: 'deepseek/deepseek-v3.2' },
      medium: { provider: 'openrouter', model: 'deepseek/deepseek-v3.2' },
      large: { provider: 'openrouter', model: 'deepseek/deepseek-v3.2' },
    },
    allowPaid: true,
    sources: ['https://openrouter.ai/deepseek/deepseek-v3.2'],
  },
  {
    id: 'openrouter-free', label: 'OpenRouter · free router (slow, best effort)',
    description: 'Explicit opt-in to openrouter/free. Requires a key. Model selection varies by request, and tool-call failures or rate limits can interrupt checks. Uses the 16,384-token output ceiling because free models can spend most of it on reasoning. Sphinx does not switch to a paid route automatically.',
    models: {
      small: { provider: 'openrouter', model: 'openrouter/free' },
      medium: { provider: 'openrouter', model: 'openrouter/free' },
      large: { provider: 'openrouter', model: 'openrouter/free' },
    },
    // Free router models count hidden reasoning against this budget; at 4,096
    // they can exhaust it before writing any questions (CRI-58).
    maxOutputTokens: 16384,
    allowPaid: false,
    sources: ['https://openrouter.ai/docs/guides/routing/routers/free-router'],
  },
].map(preset => Object.freeze({
  ...preset,
  models: Object.freeze(Object.fromEntries(Object.entries(preset.models).map(([tier, route]) => [tier, Object.freeze(route)]))),
  sources: Object.freeze(preset.sources),
})));

// A paid preset describes its billing requirement. Interactive setup treats a
// deliberate paid selection as consent; noninteractive callers must separately
// require --allow-paid or an already-saved paid setting before applying it.
export function presetOptions(id) {
  const preset = REVIEWER_PRESETS.find(item => item.id === id);
  if (!preset) throw new Error(`Unknown reviewer preset ${id}. Choose ${REVIEWER_PRESETS.map(item => item.id).join(', ')}.`);
  return {
    ...Object.fromEntries(Object.entries(preset.models).map(([tier, route]) => [tier, `${route.provider}:${route.model}`])),
    ...(preset.maxOutputTokens ? { 'max-output-tokens': preset.maxOutputTokens } : {}),
    ...(preset.allowPaid ? { 'allow-paid': true } : {}),
  };
}
