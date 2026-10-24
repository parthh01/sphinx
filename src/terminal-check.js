import path from 'node:path';
import { readStats, scoreSummary } from './stats.js';
import { prepareInteractiveCheck } from './check-recovery.js';
import { savedDraft } from './sessions.js';
import { VERSION } from './version.js';
import { wrapText, stripAnsi } from './terminal.js';

// The terminal questionnaire: the same check as the browser page, laid out for
// a terminal. Used by `sphinx check` and when Git asks inline in a headless
// session. Model text is printed as plain text; it never sets terminal state.
const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const LEARN = 'I do not know. Explain this concept and give me a different scenario to apply it to.';
// Strip control characters from model text so it cannot move the cursor or recolor the terminal.
const plain = text => String(text ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const PROVIDERS = { openrouter: 'OpenRouter', openai: 'Endpoint', claude: 'Claude Code', codex: 'Codex' };
const routeText = route => route?.provider ? [PROVIDERS[route.provider] || route.provider, route.model].filter(Boolean).join(' ') : '';
const count = n => Number(n || 0).toLocaleString('en-US');

/** One status line that redraws in place on a TTY, and prints once otherwise. */
export function createSpinner(stream, style) {
  let timer = null, label = '', started = 0, index = 0;
  const width = () => Math.max(20, (stream.columns || 80) - 4);
  const draw = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    const tail = seconds >= 2 ? ` · ${seconds}s` : '';
    const room = width() - 2 - tail.length;
    const text = label.length > room ? `${label.slice(0, room - 1)}…` : label;
    stream.write(`\r\x1b[2K  ${style.amber(FRAMES[index++ % FRAMES.length])} ${text}${style.muted(tail)}`);
  };
  return {
    start(text) {
      this.stop(); label = plain(text); started = Date.now();
      if (stream.isTTY) { draw(); timer = setInterval(draw, 90); timer.unref?.(); }
      else stream.write(`  ${label}…\n`);
    },
    update(text) { label = plain(text); },
    stop() { if (timer) { clearInterval(timer); timer = null; stream.write('\r\x1b[2K'); } },
  };
}

function scoreLine(score, style) {
  if (!score) return '';
  const recent = score.recent || [];
  const slots = score.calibrating ? score.answered + score.needed : Math.max(recent.length, 1);
  const dots = Array.from({ length: slots }, (_, i) => i < recent.length ? (recent[i] ? style.green('●') : style.amber('●')) : style.muted('○')).join('');
  const value = score.calibrating ? style.muted(`warming up · ${score.needed} to go`) : style.strong(`${score.accuracy}%`);
  const extra = !score.calibrating && score.streak > 1 ? style.muted(` · ${score.streak} in a row`) : '';
  return `  ${style.muted('Your understanding')}  ${dots}  ${value}${extra}`;
}

/** A quoted block with a left rule, wrapped to the terminal. */
function block(terminal, text, rule) {
  const { style } = terminal;
  for (const line of wrapText(plain(text), terminal.width - 4, '').split('\n')) terminal.line(`  ${rule(style)} ${line}`);
}

export function printHeader(terminal, { session, score }) {
  const { style } = terminal, snapshot = session.snapshot || {};
  const repo = snapshot.repoRoot ? path.basename(snapshot.repoRoot) : '';
  const destination = snapshot.target?.ref ? `${snapshot.target.remote ? `${snapshot.target.remote}/` : ''}${snapshot.target.ref.replace(/^refs\/heads\//, '')}` : '';
  const stats = snapshot.stats ? `${count(snapshot.stats.files)} file${snapshot.stats.files === 1 ? '' : 's'}  ${style.green(`+${count(snapshot.stats.additions)}`)} ${style.amber(`−${count(snapshot.stats.deletions)}`)}` : '';
  const title = `  ${style.amber('◆')} ${style.strong('sphinx')} ${style.muted(`v${VERSION}`)}`;
  const right = style.muted('understanding check');
  const gap = Math.max(2, terminal.width - stripAnsi(title).length - stripAnsi(right).length);
  terminal.line('');
  terminal.line(`${title}${' '.repeat(gap)}${right}`);
  const facts = [[repo, destination].filter(Boolean).join(' → '), stats, routeText(session.route)].filter(Boolean);
  if (facts.length) terminal.line(`  ${facts.join(style.muted('  ·  '))}`);
  const line = scoreLine(score, style);
  if (line) terminal.line(line);
  terminal.line(style.muted(`  ${'─'.repeat(Math.max(10, terminal.width - 4))}`));
}

function printQuestion(terminal, state, { note }) {
  const { style } = terminal;
  terminal.line('');
  const label = `Question ${state.progress.completed + 1} of ${state.progress.total}${note ? ` · ${note}` : ''}`;
  terminal.line(`  ${style.strong(label)}`);
  block(terminal, state.question.prompt, s => s.amber('┃'));
  if (state.question.choices?.length) state.question.choices.forEach((choice, index) => terminal.line(`    ${style.muted(`${index + 1}.`)} ${plain(choice)}`));
  terminal.line('');
}

function commandsLine(terminal, { waitingGit }) {
  const { style } = terminal;
  const items = ['/hint', '/learn', '/dispute <reason>', ...(waitingGit ? ['/skip'] : []), '/quit'];
  terminal.line(style.muted(`  Enter to send · ${items.join('  ')}`));
}

/**
 * Run the check in this terminal. Resolves 0 when passed, 1 when paused or
 * quit, and 3 when the human skipped a waiting Git operation.
 */
export async function runTerminalCheck({ store, session, config, ask, terminal: base, stream = process.stdout, signal, waitingGit = false, planProviders = [], validate, choose, skip, env = process.env }) {
  // Lines keep their own indentation; the shared helpers would rewrap it away.
  const terminal = { ...base, line: text => stream.write(`${text}\n`), note: text => stream.write(`${base.style.muted(`  ${text}`)}\n`), warning: text => stream.write(`  ${base.style.amber('!')} ${text}\n`) };
  const { style } = terminal;
  const spinner = createSpinner(stream, style);
  const repoRoot = session.snapshot.repoRoot;
  const score = async () => scoreSummary(await readStats(repoRoot, env));
  printHeader(terminal, { session, score: await score().catch(() => null) });
  terminal.line(style.muted(wrapText('Open-book: look at the code whenever it helps, then explain what it does in your own words.', terminal.width, '  ')));

  const withSpinner = async (label, operation) => {
    spinner.start(label);
    try { return await operation(); } finally { spinner.stop(); }
  };
  let state;
  try {
    state = await prepareInteractiveCheck({
      config, signal, waitingGit, planProviders, ui: terminal, choose,
      start: () => withSpinner(session.questions?.length ? 'Loading prepared questions' : `Reviewing the change with ${routeText(session.route)}`, () => store.start(session.id, config, {
        signal, onProgress: text => spinner.update(`Reviewing · ${text}`),
      })),
      inspect: async () => store.public(await store.read(session.id)),
      authorizeMore: () => store.retryReview(session.id, config, { signal }),
      validate, switchRoute: provider => store.switchRoute(session.id, config, provider, { signal }),
    });
  } finally { spinner.stop(); }
  signal?.throwIfAborted();
  if (!state) return 1;
  if (state.status === 'passed' && state.noQuestionReason) {
    terminal.line(''); terminal.line(`  ${style.green('✓')} No questions needed: ${plain(state.noQuestionReason)}`);
    return finish(terminal, { waitingGit });
  }

  let shownId = null, shownNumber = 0, shownDraft = null;
  while (state.status !== 'passed') {
    if (state.question && state.question.id !== shownId) {
      const number = state.progress.completed + 1;
      printQuestion(terminal, state, { note: number === shownNumber ? 'follow-up' : '' });
      commandsLine(terminal, { waitingGit });
      shownId = state.question.id; shownNumber = number;
    }
    // An answer that was never graded (a provider failure, or a check that
    // stopped) is saved; Enter sends it again instead of retyping it.
    const draft = savedDraft(await store.read(session.id));
    const draftLine = draft && (draft.kind === 'dispute' ? `/dispute ${draft.text}` : draft.text);
    if (draftLine && draftLine !== shownDraft) {
      terminal.note(`Your last ${draft.kind === 'dispute' ? 'dispute' : 'answer'} was not graded and is saved: ${plain(draft.text)}\nPress Enter to send it again, or type a new response.`);
      shownDraft = draftLine;
    }
    const answer = plain(await ask(`  ${style.amber('›')} `)).trim() || draftLine || '';
    signal?.throwIfAborted();
    if (!answer) continue;
    if (answer === '/quit') { terminal.line(''); terminal.note('Progress saved. Run sphinx check when you are ready to continue.'); return 1; }
    if (answer === '/hint') { await printHint(terminal, store, session.id, state.question.id); continue; }
    if (answer === '/skip') {
      if (!waitingGit || !skip) { terminal.warning('Skipping is only available while a Git operation is waiting.'); continue; }
      const reason = plain(await ask(`  ${style.muted('Skip this check? The push goes through and the skip is logged. Reason (optional), or n to go back:')} `)).trim();
      if (/^n(o)?$/i.test(reason)) continue;
      await skip(reason || undefined);
      terminal.line(''); terminal.line(`  ${style.amber('↷')} Skipped. Git is continuing.`);
      return 3;
    }
    const dispute = answer.startsWith('/dispute '), learn = answer === '/learn';
    if (answer === '/dispute') { terminal.warning('Add a reason: /dispute <what is ambiguous or unsupported>'); continue; }
    if (answer.startsWith('/') && !dispute && !learn) { terminal.warning('Use /hint, /learn, /dispute <reason>, /quit, or type your answer.'); continue; }
    const previous = state;
    try {
      state = await withSpinner(learn ? 'Preparing an explanation' : dispute ? 'Reviewing the question' : 'Checking your reasoning', () => store.answer(session.id, learn ? LEARN : dispute ? answer.slice(9) : answer, config, { dispute, learn, expectedQuestionId: previous.question.id, signal }));
    } catch (error) {
      // Like the browser: a failed grade leaves the same question open. Only cancelling ends the check.
      if (signal?.aborted || ['SPHINX_CANCELLED', 'EVALUATOR_CANCELLED'].includes(error?.code) || error?.name === 'AbortError') throw error;
      terminal.line('');
      terminal.warning(`That didn't go through: ${plain(error.message)}`);
      terminal.note('Your progress is kept. Try again, or /quit to stop here.');
      state = previous;
      continue;
    }
    signal?.throwIfAborted();
    printVerdict(terminal, state, { learn, dispute });
    // Without a usable new question the same one stays open; show it again below the explanation.
    if (state.status !== 'passed' && state.question?.id === previous.question.id) printQuestion(terminal, state, { note: 'still open' });
  }
  terminal.line('');
  terminal.line(`  ${style.green('✓')} ${style.strong('Understanding check complete.')}`);
  const final = await score().catch(() => null);
  const line = scoreLine(final, style);
  if (line) terminal.line(line);
  return finish(terminal, { waitingGit });
}

function finish(terminal, { waitingGit }) {
  terminal.line(terminal.style.muted(waitingGit ? '  Approval saved. Git is continuing.' : '  Approval saved for this exact change and destination. A waiting Git operation can now continue.'));
  terminal.line('');
  return 0;
}

function printVerdict(terminal, state, { learn, dispute }) {
  const { style } = terminal;
  terminal.line('');
  if (state.verdict === 'correct') { terminal.line(`  ${style.green('✓')} Got it.`); if (state.feedback) block(terminal, state.feedback, s => s.muted('│')); return; }
  const heading = learn ? `${style.amber('◇')} Here's how it works` : dispute ? `${style.amber('◇')} About that question` : state.verdict === 'ambiguous' ? `${style.amber('?')} Needs a little more` : `${style.amber('✗')} Not quite`;
  terminal.line(`  ${heading}`);
  if (state.feedback) block(terminal, state.feedback, s => s.muted('│'));
}

async function printHint(terminal, store, id, questionId) {
  const { style } = terminal;
  // Only the cited file paths: evidence reasons can give the answer away.
  const session = await store.read(id).catch(() => null);
  const question = session?.questions?.find(item => item.id === questionId);
  const paths = [...new Set((question?.evidence || []).map(item => item.path).filter(Boolean))];
  terminal.line('');
  if (!paths.length) { terminal.note('No specific files are cited for this question. Start from the diff.'); return; }
  terminal.line(`  ${style.muted('Look at')}`);
  for (const file of paths) terminal.line(`    ${style.amber(plain(file))}`);
  terminal.line('');
}

