# Integrations and troubleshooting

The Git hook is the checkpoint. It works on its own, including for pushes from a terminal or GUI client. Coding-agent integrations add two things: guidance telling the agent to wait for a blocked Git command, and fallback forms for checks that could not open in the browser. For the first-run path, see the [README](../README.md).

- [Supported clients](#supported-clients)
- [Choosing and opening clients](#choosing-and-opening-clients)
- [Per-client notes](#per-client-notes)
- [How a checkpoint reaches you](#how-a-checkpoint-reaches-you)
- [Remote machines, SSH, and CI](#remote-machines-ssh-and-ci)
- [Git hooks and existing hooks](#git-hooks-and-existing-hooks)
- [Manual JSON protocol](#manual-json-protocol)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

## Supported clients

| Client | Checkpoint | Fallback | Installed integration |
| --- | --- | --- | --- |
| Codex | Local browser questionnaire | Native MCP form | MCP server and lifecycle hooks |
| Claude Code | Local browser questionnaire | Native MCP form | MCP server and lifecycle hooks |
| Pi 1.2+ | Local browser questionnaire | Native dialogs | Local Pi extension |
| Cursor 1.7+ | Local browser questionnaire | Browser, after Git exits | Local user hooks |
| OpenCode 1.x | Local browser questionnaire | Browser, after Git exits | Local OpenCode plugin |

Client integrations are separate from the reviewer model. Pi, Cursor, and OpenCode do not supply reviewer authentication; choose a Codex/Claude CLI route, OpenRouter, or an OpenAI-compatible endpoint (see [configuration](configuration.md#reviewer-models)).

## Choosing and opening clients

`--agents auto` (the default) detects clients by executable, configuration directory, or an existing Sphinx installation. Guided setup shows checkboxes with **All supported agents** first and detected clients preselected: arrow keys move, Space toggles, Enter confirms. Clear every box to skip agent setup; previously connected integrations stay installed.

```sh
sphinx install --agents codex,claude,pi,cursor,opencode   # explicit subset
sphinx install --agents none                              # Git only
```

Run `sphinx install` again after installing a new supported client; Sphinx does not discover new clients on its own.

Interactive installation opens the selected clients afterwards: fresh Codex, Claude Code, Pi, and OpenCode CLI sessions, or a new Cursor window. Opening a client sends no prompt and makes no Sphinx model request. Existing client processes are not restarted.

```sh
sphinx install --no-launch                            # install without opening clients
sphinx install --yes --preset codex-economy --launch  # unattended install, then open
sphinx activate                                       # open configured clients later
sphinx activate --agents codex,claude
```

`activate` does not reinstall or change settings; `--json` returns launch results. If a client is missing or no terminal or editor can be opened, Sphinx prints the command to run yourself.

Opening a client does not verify MCP connectivity or hook trust. Sphinx never bypasses a client's trust review. Check what Sphinx can see with `sphinx doctor`.

## Per-client notes

**Codex.** Open `/hooks` and trust the Sphinx hooks; `sphinx doctor` cannot verify this. Codex approval policies can cancel native forms: in Codex 0.162.1, approval policy `never` cancels them unless the host enables full-access form input for the user thread. A cancelled form leaves the check pending; finish it with `sphinx check` in a terminal. Sphinx does not change your approval policy.

**Claude Code.** Start a new session to load the hooks. Confirm the `sphinx` server is connected in `/mcp`.

**Pi.** Start a new session, or run `/reload` in an existing one. Native fallback dialogs need an interactive session or a dialog-capable RPC client; noninteractive modes leave the check pending for `sphinx check`.

**Cursor.** Start a new Agent conversation in the opened window. Activation flags versions older than 1.7 for an update. The installed user hooks cover local sessions, not Cursor cloud agents.

**OpenCode.** Start a new session. The plugin is installed in OpenCode's configuration directory (honoring `OPENCODE_CONFIG_DIR` or `XDG_CONFIG_HOME`).

Each client controls how its own forms and dialogs look, and may keep its own interaction logs.

## How a checkpoint reaches you

1. **Browser (normal).** The blocked Git hook serves a questionnaire on `127.0.0.1` and prints its URL. On macOS it opens in a background browser tab without activating Terminal or moving your coding window; elsewhere, open the printed URL. One page handles every checkpoint in a Git operation. Git continues when you pass and choose Continue.
2. **Native fallback.** If the browser page cannot be presented, Git stops and the check is queued. Codex and Claude Code show an MCP form after the shell command exits; Pi shows extension dialogs; Cursor and OpenCode point you to the browser page. Because Git has already exited, passing a fallback check does not resume it; run the Git command again once.
3. **Terminal.** `sphinx check` runs the same check in your terminal at any time. It supports `/learn`, `/dispute <reason>`, and `/quit` (save and leave pending). When Git asks in its own terminal while it waits, `/stop` (or `/quit`) stops the operation, and after a pass you type `continue` or `stop`.

All three share one assessment per change. **Your answers go directly to Sphinx; the coding model never sees questions, answers, or feedback.** It receives only status, assessment IDs, progress, and usage counts. It does not start the interview or relay answers, and there is no extra coding-model turn per answer. A paused or dismissed check does not reopen on unrelated shell commands; retrying the blocked Git command queues it again. The integration follows checks across `cd` and `git -C`.

Agent guidance tells the coding agent not to start a duplicate Git command while one is waiting and not to answer for you. The host may still cancel a long-running shell command before you finish; in that case, complete the check and retry once.

## Remote machines, SSH, and CI

The installation covers your local machine. Remote machines, containers, and hosted coding agents need their own installation.

Sphinx opens the browser automatically only on macOS. On Linux, WSL, and over SSH it prints the loopback URL instead. From a remote session, forward the same port number (for example `ssh -L <port>:127.0.0.1:<port> host`) and open the printed URL unchanged in your local browser; the page rejects other hosts and ports. Or run `sphinx check` on the remote machine. A remote connection may time out sooner than Sphinx's 25-minute wait.

CI never starts a questionnaire. The check stays pending and Git stops.

## Git hooks and existing hooks

`sphinx install` sets a machine-wide Git `core.hooksPath`, which covers existing and new repositories that use that Git configuration. Existing repository hooks still run first, with their arguments and input, and their rejection is preserved. Hooks with streaming protocols are forwarded directly. Reinstallation is idempotent, and agent settings are merged rather than replaced.

A repository that sets its own `core.hooksPath` needs a compatibility step. `sphinx doctor` reports this:

```sh
cd your-repo
sphinx install --repo
```

Besides the checkpoint hooks, `post-commit`, `post-merge`, `post-rewrite`, and `post-checkout` schedule [background preparation](configuration.md#background-preparation).

## Manual JSON protocol

For integrations and debugging, the CLI returns questions and feedback as JSON. It never returns answer keys. Codex and Claude use `sphinx mcp` internally, and Pi calls the same controller from its extension; none of them asks the coding model to run these commands.

```sh
sphinx pending --json
sphinx check --json
sphinx answer <assessment-id> --text 'Your answer and reason' --json
sphinx explain <assessment-id> --json
sphinx dispute <assessment-id> --text 'Why the premise is wrong' --json
```

These are for a person or a test harness. A coding agent must not answer on your behalf.

`help`, `status`, `pending`, and `config` never call a model. `--json` output contains no banners or ANSI styling; color is off when output is redirected, and `NO_COLOR=1` disables it.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Git is waiting and no page opened | Open the `Sphinx questionnaire:` URL that Git printed. |
| You closed the tab | Git keeps waiting. Reopen the same URL until the 25-minute deadline. |
| You chose Stop push (or Pause check), the deadline passed, or the host cancelled the shell | Progress is saved. Run the Git command once more, or `sphinx check` first. |
| You passed and chose Stop push, or Git stopped waiting before you chose | The push or commit did not go through. Your pass is saved, so running the same Git command again asks only whether to continue, with no new questions. |
| A native form was cancelled or never appeared | Run `sphinx check` in a terminal. In Codex, see the approval policy note above. |
| The review failed before questions appeared | The page offers to continue from saved work. From a terminal: `sphinx check --id <id>`, or `--retry-review` for a failed, questionless review. See [limits](configuration.md#model-calls-tokens-and-limits). |
| The check keeps coming back after you passed | If it asks only Continue or Stop, the earlier push or commit stopped before you chose Continue; choose Continue to let it through. If it asks questions again, something changed: code, destination base, policy, ignore rules, or context. Completion also expires after 24 hours. |
| Hooks do not run in one repository | `sphinx doctor`, then `sphinx install --repo` if it reports a hooks override. |
| Missing remote history | `git fetch`, then push again. |

Never start a second copy of a Git command that is still waiting.

## Uninstall

```sh
sphinx uninstall --repo   # remove an explicit repository integration, if present
sphinx uninstall          # remove machine-wide Git and agent integrations
npm uninstall -g sphinx-understand
```

Uninstall restores the previous hook configuration when Sphinx still owns it and removes only its own unchanged agent handlers and MCP registration. Later edits are preserved and reported. Machine-wide uninstall leaves explicit repository installations in place, with a warning; remove those first. Configuration, credentials, and assessment state stay in `~/.config/sphinx` for you to keep or delete.
