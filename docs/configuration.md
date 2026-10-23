# Configuration, models, and cost

This page is the reference for reviewer models, usage limits, repository policy, and file exclusions. For the first-run path, see the [README](../README.md).

- [Settings locations](#settings-locations)
- [Reviewer models](#reviewer-models)
- [Routing and question counts](#routing-and-question-counts)
- [Model calls, tokens, and limits](#model-calls-tokens-and-limits)
- [Repository policy](#repository-policy)
- [Project context](#project-context)
- [Files Sphinx never reads](#files-sphinx-never-reads)
- [Background preparation](#background-preparation)
- [GitHub commit status and pull requests](#github-commit-status-and-pull-requests)
- [Browser or terminal](#browser-or-terminal)

## Settings locations

| What | Where |
| --- | --- |
| Machine-wide settings | `~/.config/sphinx/config.json` |
| OpenRouter key and OpenAI-compatible endpoint | `~/.config/sphinx/credentials.json` (mode `0600`) |
| Machine-wide ignore patterns | `~/.config/sphinx/ignore` |
| Skip and yolo log | `~/.config/sphinx/overrides.jsonl` |
| Retention deck | `~/.config/sphinx/decks/` (passed questions for `sphinx drill`) |
| Repository policy | `.sphinxconfig` (legacy `.sphinx.json` is read when `.sphinxconfig` is absent) |
| Repository exclusions | `.sphinxignore` |
| Project context and question preferences | `.sphinxcontext.md` (kept out of Git by default) |
| Your question preferences for every repository | `~/.config/sphinx/context.md` |

`SPHINX_HOME` relocates all machine-wide settings, credentials, and assessment state. `sphinx config` shows effective settings and paths. A complete global example using the paid Haiku preset is in [examples/config.json](../examples/config.json).

Model routes, credentials, and usage limits are machine-wide only. A repository cannot redirect review to another provider, supply credentials, or raise your limits.

## Reviewer models

Sphinx picks one of three saved routes (small, medium, large) for each change. Presets fill all three; you can change them at any time without reinstalling:

```sh
sphinx config --preset claude-economy
sphinx config --preset openrouter-value --allow-paid
sphinx config --small claude:haiku --medium claude:haiku --large claude:sonnet
```

| Preset | Small and medium | Large | Usage source |
| --- | --- | --- | --- |
| `codex-economy` | `codex:gpt-6-luna` | `codex:gpt-6-luna` | Your Codex CLI account |
| `claude-economy` | `claude:haiku` | `claude:haiku` | Your Claude CLI account |
| `openrouter-value` (experimental) | `openrouter:anthropic/claude-haiku-5.5` | `openrouter:anthropic/claude-haiku-5.5` | Paid OpenRouter credits |
| `openrouter-deepseek` (experimental) | `openrouter:deepseek/deepseek-v3.2` | `openrouter:deepseek/deepseek-v3.2` | Paid OpenRouter credits |
| `openrouter-free` | `openrouter:openrouter/free` | `openrouter:openrouter/free` | OpenRouter free availability and limits |

Unattended installation needs an explicit preset or route; Sphinx does not silently choose a free model:

```sh
sphinx install --yes --preset codex-economy
sphinx install --yes --preset claude-economy
sphinx install --yes --preset openrouter-value --allow-paid
```

Reinstalling keeps saved routes unless you choose a replacement. Updating Sphinx does not migrate saved routes. Changing a route invalidates prepared questions and completion records made under the previous route.

### Codex and Claude routes

These use your signed-in Codex or Claude CLI and consume that account's allowance. You need a recent CLI with access to the selected model; see [Codex models](https://learn.chatgpt.com/docs/models) and [Claude model configuration](https://code.claude.com/docs/en/model-config). The economy presets keep the same economical model for all tiers; investigation effort and question count still scale with change size. The Claude `haiku` alias follows the available Haiku model. Neither preset upgrades to a more expensive model.

**These routes bill your signed-in plan by default.** Sphinx removes `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, and similar variables from the reviewer CLI's environment, so a key in your shell cannot silently switch reviews to API credits. If the CLI is not signed in with a Claude or ChatGPT plan, the check stops with instructions. To let the CLIs use API keys instead, run `sphinx config --cli-billing api`.

Each call is a fresh, isolated CLI invocation used as a model transport underneath the embedded [Pi SDK](https://pi.dev/docs/latest/sdk) reviewer. It does not reuse your coding conversation. See [architecture](architecture.md#independent-investigation-and-compaction).

Pi, Cursor, and OpenCode integrations present checkpoints but do not supply a reviewer model. Their users pick a Codex/Claude CLI route, OpenRouter, or an OpenAI-compatible endpoint.

### OpenRouter routes

**Every OpenRouter route requires an API key, including free models.** The installer accepts an existing `OPENROUTER_API_KEY` or prompts for one with hidden input; `sphinx auth` replaces it later. Create a key in [OpenRouter's key settings](https://openrouter.ai/settings/keys). The key is stored in a user-only local file, not an OS keychain, and never in project configuration.

Filtered evidence goes to OpenRouter and its selected upstream provider, billed separately from your coding-agent plan. Paid routes need OpenRouter credits.

- **Paid consent.** Guided setup labels paid choices. Noninteractive commands need `--allow-paid` or an existing `allowPaid: true` setting. Free routes send zero-price provider limits even when another route permits paid models. There are no automatic paid fallbacks.
- **Free router.** `openrouter-free` is best-effort. Its model selection, rate limits, and tool support can interrupt a check; see [OpenRouter limits](https://openrouter.ai/docs/api_reference/limits). Sphinx does not switch providers or upgrade models after a failure. The preset sets `maxOutputTokens` to 16,384 because free models often spend most of the output budget on hidden reasoning. Installs that chose this preset before that default keep their saved 4,096; run `sphinx config --max-output-tokens 16384` if a check stops with `finish_reason: length`.
- **Endpoint compatibility.** Requests need endpoint support for tools and output parameters. Capability metadata is a compatibility check, not a guarantee; unusable output leaves the check pending. See OpenRouter [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) and [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).

### OpenAI-compatible endpoints

Any OpenAI chat-completions-compatible endpoint (OpenAI, Groq, Together, vLLM, Ollama, LM Studio, and others) can run reviews. It must support tool calls and JSON-schema structured output.

```sh
sphinx auth --provider openai --base-url https://api.openai.com/v1   # prompts for the key (hidden)
sphinx config --provider openai --model gpt-5-mini                    # or per size: --large openai:<model>
```

The key is stored next to its URL and only ever sent there. Plain `http://` is allowed only for localhost, where a key is optional. For scripts, set `SPHINX_OPENAI_BASE_URL`, plus `SPHINX_OPENAI_API_KEY` unless the endpoint is localhost. Sphinx never reads `OPENAI_API_KEY`.

### Reference pricing and quality

The paid value preset uses Haiku 5.5 with an 8,192-token output ceiling, including reasoning. Reference prices checked **October 15, 2026** start at $0.10 input / $0.50 output per million tokens below 100,000 input tokens; the higher context tier is $0.50 / $2.50. Rates vary by endpoint and over time; see [Haiku endpoints](https://openrouter.ai/api/v1/models/anthropic/claude-haiku-5.5/endpoints). At the lower rates, 30,000 input plus 2,000 output tokens costs about $0.004. A whole check makes several requests with repeated context.

The [evaluation results](../eval/RESULTS.md) record measured question quality, grading failures, and corrections across Haiku, Qwen, DeepSeek, and GLM on synthetic changes. They are a limited development benchmark, not a reliability guarantee. The Haiku preset is experimental because it rejected a sufficient qualitative answer in a focused test; DeepSeek is an experimental open-weight preset. Price and tool support alone do not establish question quality.

## Routing and question counts

Routing is deterministic and makes no model request. It counts **added plus deleted lines**, changed files, and consequential path terms. Ignored files do not count.

| Tier | Default rule |
| --- | --- |
| Small | At most 80 changed lines and 3 files |
| Medium | Between the small and large thresholds |
| Large | At least 400 changed lines, 12 files, or a consequential path |

Consequential paths contain `auth`, `permission`, `migration`, `billing`, `payment`, `crypto`, `security`, or `terraform`. A matching path makes even a tiny patch large. These are configurable heuristics, not a semantic risk classification.

The tier and your chosen depth set the maximum number of initial questions:

| Change tier | Relaxed | Standard | Thorough |
| --- | --- | --- | --- |
| Small | 1 | 1 | 1 |
| Medium | Up to 2 | Up to 2 | Up to 3 |
| Large | Up to 2 | Up to 3 | Up to 5 |

- `relaxed`: observable behavior and the most consequential edge case.
- `standard`: behavior, failure modes, and relevant system interactions.
- `thorough`: also supported rollout, rollback, and compatibility assumptions.

These are ceilings, not quotas: the reviewer asks fewer questions when the evidence supports fewer distinct behaviors, and never pads. A wrong answer adds a replacement question for the same concept, so a check can ask more than the initial count. Changing the model does not change the question count.

## Question audit

After the reviewer writes questions, an independent model call can audit them against the code before you see them: it fixes answer keys that don't match the code, and rewrites questions that ask for trivia or reveal their own answers. By default (`"audit": "large"` in `config.json`) only large changes get that call; small and medium ones check their own questions in the same request, which saves one long model call (often 10–20 seconds) per check. Set `"audit": "all"` to audit every change. A decision to ask no questions is always audited, at any size.

## Model calls, tokens, and limits

**Model calls have no default cap** (`maxModelCalls: null`, `agentMaxTurns: null`). Every request is counted: background investigation, compaction, the question audit, grading, replacement audits, and failed requests. The questionnaire shows calls and tokens as the check runs, plus cost when the provider reports it.

| Step | Typical requests |
| --- | --- |
| Investigation for a small / medium / large change | Aims for 5 / 7 / 8, including the question audit. These are planning targets, not stops. |
| Each answer, learning request, or dispute | 1 |
| A proposed replacement question | 1 more, for an independent source audit |
| Status, help, config, pending, or pushing an already approved change | 0 |

Set or clear an optional cap. This changes no routes and makes no model request:

```sh
sphinx config --max-model-calls 30          # 1–100
sphinx config --max-model-calls unlimited   # `none` is an alias
```

- Existing numeric caps stay in effect until changed. A check adopts an edited cap when resumed, preserving questions, progress, and counted calls. Lowering a cap below current usage blocks further calls.
- An explicit cap reserves calls for grading and the final audit; a lone remaining request cannot start a question synthesis that would lack its audit.
- `agentMaxTurns` (advanced) caps investigation, compaction, question generation, and auditing for one review attempt.

Other limits always apply:

| Setting | Default | Bounds |
| --- | --- | --- |
| `timeoutSeconds` | 180 | The whole investigation. Unlimited calls do not mean unlimited time. |
| `maxContextBytes` | 100,000 | Serialized review context (prompts, tools, schemas), not the whole diff. Pi compacts before this; context that still does not fit is rejected before a model call. |
| `toolResultBytes` | 16,000 | Each tool page. Pages shrink to leave room for batched reads. |
| `maxOutputTokens` | 4,096 (8,192 in `openrouter-value`, 16,384 in `openrouter-free`) | Every request, 512–16,384. Set with `sphinx config --max-output-tokens 8192`. |

OpenRouter counts hidden reasoning within `maxOutputTokens`; a higher ceiling can prevent truncation and permits more billed output. Codex and Claude CLIs get concise-output instructions and local timeout and output-byte limits, but their interfaces have no equivalent hard token cap. Small and medium changes request low reasoning effort; large changes request medium effort where the CLI supports it.

**Retries.** Transient provider HTTP errors are retried up to three times, after 5, 15, and 40 seconds, or after the provider's `Retry-After` if one is given. These are 408, 429, 500, 502, 503, 504, and OpenRouter's 404 "no compatible provider". Every attempt counts toward any call cap. Sphinx does not retry when the provider asks for a wait longer than 60 seconds, and it never switches models on its own. On `openrouter/free`, each retry is a fresh route selection. Authentication, credit, invalid-request, and output-limit failures are not retried. If grading still fails, your answer or dispute reason is saved and offered again when you resume the question. Cache warming is disabled. Without a call cap, the reviewer stops after three consecutive invalid responses. Correctable tool or question-validation errors are returned to Pi as feedback within any explicit cap. If a review fails, the questionnaire offers to continue from saved work; Pause is the default. From a terminal, `sphinx check --id <id>` resumes saved work, and `--retry-review` gives a failed, questionless review one further attempt (with an explicit cap, up to `maxModelCalls` additional requests). Setup, credential, stale-code, and evidence-loading failures must be fixed first.

Call caps bound requests and byte limits bound evidence. Neither is a dollar or subscription ceiling. **Set provider-side spending limits for paid accounts.**

## Repository policy

`sphinx init` creates `.sphinxconfig`, `.sphinxignore`, and `.sphinxcontext.md` when they are absent and never overwrites them. Edit the files directly afterwards. Commit them to share policy with collaborators. Start from `sphinx init` or [.sphinxconfig.example](../.sphinxconfig.example):

```json
{
  "version": 1,
  "events": ["pre-push"],
  "branches": ["main", "release/*"],
  "level": "standard",
  "distance": "mixed",
  "exclude": ["vendor/**"]
}
```

| Key | Meaning |
| --- | --- |
| `enabled` | `false` disables Sphinx for this repository |
| `events` | `pre-push`, `pre-commit`, or both |
| `branches` | Push policies match the **destination** branch; commit policies match the current local branch |
| `remotes` | Remote name patterns for pushes; default `*` |
| `level` | `relaxed`, `standard`, or `thorough` |
| `distance` | `high`: high-level design (what the change does, how it fits into the system, what it affects); `low`: low-level implementation details (its specific logic, conditions, and edge cases); `mixed` (default): a bit of both. The questionnaire's distance chip saves a change here when the current check ends |
| `exclude` | Extra ignore patterns, added to machine-wide ones |
| `backgroundPreparation` | `false` opts this repository out |
| `github` | GitHub stamps; see [below](#github-commit-status-and-pull-requests) |

Branch defaults come from machine-wide settings (initially `main` and `master`), not from the branch you happen to have checked out. Without prompts:

```sh
sphinx init --yes --branches main --events pre-push --level standard
```

If both `.sphinxconfig` and legacy `.sphinx.json` exist, `.sphinxconfig` wins and they are not merged; `init` copies a legacy policy into `.sphinxconfig` and leaves the original.

**Commit checkpoints.** Enable `pre-commit`. To run one by hand, `sphinx check --staged` assesses the index, including partial staging.

**Manual push checks.** `sphinx check --remote origin --branch main` selects the destination; otherwise Sphinx uses the upstream. Multiple destination refs are assessed separately. Tag-only pushes and deletions do not trigger checks in v0.1.

**Pull request branches.** Set `"branches": ["*"]` to check pushes to every branch. The first push of a new branch is checked from where it left the remote's default branch (the same range the pull request shows), using local remote-tracking refs; later pushes check only the new commits.

## Project context

`.sphinxcontext.md` has two sections. **About this project** covers what the project does, who uses it, important workflows, and architecture boundaries. **What to ask about** holds question preferences, such as "don't ask about styling" or "focus on billing". Your preferences for every repository go in `~/.config/sphinx/context.md`, which `sphinx install` creates; the repository's file wins where they disagree. Both are included in every reviewer, audit, compaction, and grading request.

- **Preferences choose topics, not facts.** The reviewer avoids areas you skip and leans toward the ones you name. When an entire change falls in a skipped area and alters no behavior, data, security, or failure handling outside it, the check can pass with no questions at any size. The independent audit verifies that decision and can add a question instead. Without any context or preferences, only small changes can pass with no questions.
- **Comments are for you.** HTML comments (`<!-- -->`) are stripped before anything reaches a model, so the template's guidance costs nothing. A file that is still only the template counts as empty.
- **Personal by default.** `sphinx init` adds a new `.sphinxcontext.md` to `.git/info/exclude`, which changes nothing outside your machine. To share it, run `git add -f .sphinxcontext.md` and commit it. Files that are already committed are unaffected.

```sh
sphinx init --yes --context 'A booking service for shared equipment. Reservations must never overlap.'   # fills About this project
```

- Keep it under 16,000 bytes and free of secrets. It respects `.sphinxignore`.
- The reviewer checks its claims against code. It cannot override Sphinx policy or authorize reading ignored files.
- Without context, the reviewer establishes purpose from documentation and source rather than inventing requirements.
- Changing either file invalidates prepared questions and completion records.

## Files Sphinx never reads

Built-in exclusions apply recursively and cannot be undone by project negations:

- `.env` and `.env.*`, including `.env.example`.
- Private key and keystore names: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa`, `id_ed25519`, and related SSH names.
- Credential files: `.netrc`, `.npmrc`, `.pypirc`, `*credentials*.json`, `service-account*.json`, `secrets.json`, `secrets.yaml`, `secrets.yml`.

Add project exclusions to `.sphinxignore`:

```gitignore
# Project-specific private or generated files
internal/customer-exports/
/config/production.json
*.generated.ts
dist/
```

Supported syntax is `*`, `**`, `?`, root `/`, directory suffix `/`, `#` comments, and local `!` negations; escape a leading `#` or `!` with `\`. This is a small gitignore-like parser, not the full Git pattern language. Project rules cannot undo machine-wide (`~/.config/sphinx/ignore`) or built-in exclusions. Ignore-policy symlinks are rejected. `.gitignore` is not applied to tracked files.

**Filtering happens before patch, line-count, and content retrieval, including searches of unchanged files.** Ignored files' contents are not read, saved as evidence, or sent to a model. Git may list their names and object IDs locally to identify changes. A change that touches only ignored files needs no assessment.

Ignore rules match paths. They do not detect a secret inside an included source file. Add sensitive paths before your first assessment.

Evidence comes from Git objects, not your working files: pre-commit reads the staged index, pre-push reads commits. `.sphinxcontext.md` is read from the working directory and its hash is bound to the assessment. Snapshot identity covers the full commit or index, so editing an ignored file alongside an assessed change can still invalidate the earlier completion.

## Background preparation

After commits, merges, rewrites, and checkouts, Sphinx schedules a detached reviewer for the expected destination so questions are ready before you push. It uses local remote-tracking refs and never fetches. It never opens a questionnaire or approves a push.

- `sphinx status` shows preparation progress; `sphinx prepare` schedules it explicitly; `sphinx prepare --retry` retries a failed job (failures never retry on their own).
- Preparation and the push check share one assessment, lock, question set, and usage count. A change to source, destination, policy, ignore rules, or context discards prepared work.
- Set `backgroundPreparation: false` in `config.json` or `.sphinxconfig` to opt out. A repository cannot re-enable preparation disabled machine-wide.
- While yolo is on, preparation is paused: no new model request starts, although one already in progress may finish.
- A first push, a branch without local tracking history, or a push to an unexpected destination needs a cold review at push time. Pre-commit checks always review on demand. Run `git fetch` if remote history is missing.

## GitHub commit status and pull requests

When you push to GitHub and a check passes, Sphinx marks the pushed commit with a `sphinx/understanding` commit status, for example "Sphinx stamped · 3 questions, 2 first try". It shows next to the commit and in the pull request's checks. A skipped check is marked as a failure ("Understanding check skipped"). Yolo pushes and commit checkpoints are not marked.

```json
{ "github": { "status": true, "comment": false, "answers": false } }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `status` | `true` | Post the commit status |
| `comment` | `false` | Keep one comment on the branch's open pull request listing every check on that branch: questions, first-try results, and the model. It is edited in place on later pushes |
| `answers` | `false` | Also include your answers in that comment |

Set these in `config.json` for yourself or in `.sphinxconfig` for a repository. Private answer keys are never posted.

It uses the [GitHub CLI](https://cli.github.com) and its existing login, in a detached process after Git continues, so it never slows or blocks a push. If `gh` is missing or not signed in, the remote isn't GitHub, or any request fails, nothing is posted and nothing else changes. The worker waits a few minutes for the push to land and up to 15 minutes for a pull request to be opened; the result of the last run is in `github/last.json` in Sphinx's data directory.

### The Sphinx check (GitHub Action)

Commit statuses are one line. For a proper **Sphinx** check with a summary in the pull request's Checks tab, add the Sphinx Action to the repository:

```sh
sphinx init --github-check     # writes .github/workflows/sphinx.yml; commit and push it
```

How it fits together:

- **On the contributor's machine:** after a pass, Sphinx comments on the branch's pull request with a summary and an encoded stamp for that exact commit. For a pull request from a fork, the comment goes on the upstream pull request. The questionnaire shows "Post the Sphinx stamp to the pull request" for pushes that look like a pull request (a GitHub remote, not its default branch). It is on by default when the repository has the Sphinx workflow, and otherwise follows `github.comment`.
- **In the repository:** the Action runs when a pull request is opened or updated and when a comment is posted or edited. It reads the newest stamp for the pull request's latest commit, from the author or someone with write access, and writes the **Sphinx** check: stamped, with the number of questions, first-try results, depth, distance, and reviewer; failed if the check was skipped; or neutral ("No Sphinx stamp for this commit") until the author passes. With `require: true` in the workflow, a missing stamp fails the check instead.
- **Safety:** the workflow uses `pull_request_target` and `issue_comment` so it can write checks for fork pull requests, and it never checks out or runs pull request code. It reads comments through the API only. It needs `checks: write` and read access to pull requests and issues.
- When a repository runs the Action, Sphinx skips the separate commit status, since the check replaces it.

The workflow pins the Action to a Sphinx release tag (`parthh01/sphinx/action@v0.1.12`, for example). Any repository can use it; the path only says where the Action's code lives.

**Requiring it for a team.** With the Action, set `require: true` and add the **Sphinx** check to branch protection. Without it, add `sphinx/understanding` as a required status check. Pull requests whose head commit was not pushed through a passing check then cannot merge. The status is self-reported by the pusher's machine: it shows the check happened, but it is not a cryptographic proof, and anyone with write access can set a commit status.

## Browser or terminal

`interface` in `config.json` chooses where a push's questions appear. Set it with `sphinx config --interface <auto|browser|terminal>`.

| Value | Behavior |
| --- | --- |
| `auto` (default) | The browser on a local Mac, where Sphinx can open it in the background. Elsewhere (SSH, Linux, WSL), inline in the terminal you ran Git from |
| `terminal` | Always the terminal |
| `browser` | Always the browser (on Linux and over SSH, open the printed local URL) |

Inline questions need a terminal a person is looking at. When Git runs from a coding agent's shell there isn't one, so Sphinx opens a terminal window on a desktop instead, and falls back to the browser when it can't do either. `interface` is a personal setting; it can't be set in `.sphinxconfig` and doesn't change what a check asks.
