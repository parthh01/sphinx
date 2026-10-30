import { constants } from 'node:fs';
import { browserHandoff } from './lifecycle-integrations.js';
import { open } from 'node:fs/promises';
import { setupNudge } from './repo-setup.js';

/** Session setup only. Git and native lifecycle hooks control the actual checkpoint. */
export async function agentHook({ agent, event, input = '', env = process.env }) {
  if (env.SPHINX_EVALUATOR === '1') return { output: null, exitCode: 0 };
  if (!['codex', 'claude'].includes(agent)) throw new Error(`Unsupported agent: ${agent}`);
  let payload;
  try {
    payload = typeof input === 'object' && !Buffer.isBuffer(input) ? input : JSON.parse(String(input || '{}'));
  } catch {
    throw new Error('Agent hook input must be valid JSON.');
  }
  const name = payload?.hook_event_name || event;
  if (['PostToolUse', 'PostToolUseFailure'].includes(name)) {
    // Fallback only: Git normally waits in its own hook. Open the browser for a
    // checkpoint queued by Git, and stay silent when nothing is queued.
    let notice;
    try {
      notice = await browserHandoff({ cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined, host: agent, hostSession: /^[A-Za-z0-9_-]{1,200}$/.test(payload?.session_id || '') ? payload.session_id : undefined, env });
    } catch { notice = 'Sphinx could not inspect its checkpoint queue. The human can run sphinx doctor and sphinx check in their own terminal. Do not answer for them.'; }
    return notice ? { exitCode: 0, output: { hookSpecificOutput: { hookEventName: name, additionalContext: notice } } } : { output: null, exitCode: 0 };
  }
  if (name !== 'SessionStart') return { output: null, exitCode: 0 };
  if (agent === 'claude' && env.CLAUDE_ENV_FILE && /^[A-Za-z0-9_-]{1,200}$/.test(payload?.session_id || '')) {
    // Claude's documented SessionStart environment channel tags later Bash calls,
    // including `git -C` and `cd`, without reading the command or its output.
    const file = await open(env.CLAUDE_ENV_FILE, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
    try { await file.writeFile(`\nexport SPHINX_CLAUDE_SESSION='${payload.session_id}'\n`); }
    finally { await file.close(); }
  }
  const nudge = await setupNudge(payload?.cwd);
  return {
    exitCode: 0,
    output: {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: [
          'Sphinx is installed to help the human retain understanding of agent-assisted changes.',
          'Repository branch and event policy lives in .sphinxconfig (with .sphinx.json as a legacy fallback). Use `sphinx status --json` to inspect effective policy and pending assessments; do not change policy to avoid a checkpoint.',
          'Git deterministically requires a checkpoint when repository policy matches a push or commit. For blocking checkpoints it serves a local browser questionnaire and keeps the original Git operation waiting. On macOS the page opens in the background without activating or minimizing the coding window; other environments print the local URL. After the human passes, they confirm whether that same operation should continue. Git then verifies the exact change and policy before going through. Do not start a duplicate Git operation while it waits.',
          'Allow enough shell execution time for the human questionnaire. Sphinx waits up to 25 minutes, but the host may cancel the shell sooner. Keep the original process running using the host\'s supported yielding or background execution; do not terminate or duplicate it while the human answers.',
          'If Git could not keep a questionnaire open, the installed PostToolUse hook opens the same local browser questionnaire after the shell command exits. This fallback does not resume an exited Git process; you do not initiate or conduct the interview.',
          'Sphinx collects the human\'s answers directly in its local browser page, explicit terminal check, or fallback native forms and grades them using an independent evaluator. Only the outcome is returned to you. Do not relay questions through chat, call sphinx answer/explain/dispute for the human, or open its local URL or automate the questionnaire UI.',
          'Never answer on the human\'s behalf, fabricate a response, read private Sphinx session files or answer keys, or bypass the Git hook to finish the task.',
          'Respect .sphinxignore and configured exclusions: do not read excluded files to supplement an assessment or send them to the evaluator.',
          'The form offers learning, dispute, and pause actions (pause reads Stop push or Stop commit while Git waits), and after a pass while Git waits it asks whether the push or commit should go through. The human chooses them directly. A paused or cancelled check remains incomplete; do not repeatedly retry the Git operation to force another prompt. If the human passes and then stops the push or commit, or Git stops waiting before they choose, do not retry it unless they ask. Stopping is their decision; a retry reopens the questionnaire and interrupts them with the same choice.',
          'After a fallback questionnaire passes, verify that the original Git operation has exited with a Sphinx blocking failure before retrying it. Never duplicate a waiting operation or repeat a successful operation. A changed commit or destination may require another assessment. Reopen a paused blocking checkpoint only when the human asks and the previous Git process has exited.',
          'If neither the local page nor native forms are available, report the integration issue and use sphinx doctor to diagnose it. The human can run sphinx check in their own terminal. Do not substitute a chat-based questionnaire or submit answers yourself.',
          'The assessment is open-book. Helping the human inspect code is encouraged. The coding agent must not grade the response itself.',
          ...(nudge ? [nudge] : []),
        ].join('\n'),
      },
    },
  };
}
