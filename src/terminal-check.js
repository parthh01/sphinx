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
// A waiting Git operation in the same words as the browser page.
const words = event => event === 'pre-commit' ? ['commit', 'Commit'] : ['push', 'Push'];

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

/** A line led by a symbol; wrapped lines keep clear of it. */
function mark(terminal, symbol, text) {
  const [first, ...rest] = wrapText(text, terminal.width - 4).split('\n');
  terminal.line(`  ${symbol} ${first}`);
  for (const line of rest) terminal.line(`    ${line}`);
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
  const items = ['/hint', '/learn', '/dispute <reason>', ...(waitingGit ? ['/skip', '/stop'] : ['/quit'])];
  terminal.line(style.muted(`  Enter to send · ${items.join('  ')}`));
}

/**
 * Run the check in this terminal. Resolves 0 when passed, 1 when paused,
 * quit, or stopped before a pass, 3 when the human skipped a waiting Git
 * operation, and 4 when they passed and then stopped that waiting operation.
 * With more checks to follow in the same push, a pass does not ask yet.
 */
export async function runTerminalCheck({ store, session, config, ask, terminal: base, stream = process.stdout, signal, waitingGit = false, more = false, planProviders = [], validate, choose, skip, env = process.env }) {
  // Lines keep their own indentation; the shared helpers would rewrap it away.
  const terminal = { ...base, line: text => stream.write(`${text}\n`), note: text => stream.write(`${base.style.muted(`  ${text}`)}\n`), warning: text => stream.write(`  ${base.style.amber('!')} ${text}\n`) };
  const { style } = terminal;
  const spinner = createSpinner(stream, style);
  const repoRoot = session.snapshot.repoRoot, event = session.snapshot.event, [op, Op] = words(event);
  // While Git waits, quitting stops it; /quit stays as an alias of /stop.
  const stop = waitingGit ? '/stop' : '/quit';
  const score = async () => scoreSummary(await readStats(repoRoot, env));
  printHeader(terminal, { session, score: await score().catch(() => null) });
  // A held pass has nothing left to answer.
  if (!session.held) terminal.line(style.muted(wrapText('Open-book: look at the code whenever it helps, then explain what it does in your own words.', terminal.width, '  ')));

  const withSpinner = async (label, operation) => {
    spinner.start(label);
    try { return await operation(); } finally { spinner.stop(); }
  };
  let state;
  try {
    state = await prepareInteractiveCheck({
      config, signal, waitingGit, planProviders, ui: terminal, choose,
      // A pass made while Git waits is saved held: only the Git gate releases it, after
      // continue, so a window that outlives the gate cannot let a retry through.
      start: () => withSpinner(session.held ? 'Loading your earlier pass' : session.questions?.length ? 'Loading prepared questions' : `Reviewing the change with ${routeText(session.route)}`, () => store.start(session.id, config, {
        signal, hold: waitingGit, onProgress: text => spinner.update(`Reviewing · ${text}`),
      })),
      inspect: async () => store.public(await store.read(session.id)),
      authorizeMore: () => store.retryReview(session.id, config, { signal }),
      validate, switchRoute: provider => store.switchRoute(session.id, config, provider, { signal }),
    });
  } finally { spinner.stop(); }
  signal?.throwIfAborted();
  if (!state) return 1;
  // Held when this check opened, the pass was made for a push or commit that did not go through:
  // only the choice to continue remains. (A pass made here is held too, until Git sees continue.)
  if (state.status === 'passed' && session.held) {
    terminal.line(''); mark(terminal, style.green('✓'), `${state.noQuestionReason ? 'This change needed no questions' : 'You passed this change'} earlier, but that ${op} did not go through.`);
    return finish(terminal, { waitingGit, more, ask, event });
  }
  if (state.status === 'passed' && state.noQuestionReason) {
    terminal.line(''); mark(terminal, style.green('✓'), `No questions needed: ${plain(state.noQuestionReason)}`);
    return finish(terminal, { waitingGit, more, ask, event });
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
    if (answer === '/quit' || answer === stop) {
      terminal.line('');
      if (!waitingGit) { terminal.note('Progress saved. Run sphinx check when you are ready to continue.'); return 1; }
      mark(terminal, style.amber('‖'), `${Op} stopped. It did not go through; your progress is saved.`);
      terminal.line(style.muted(wrapText(`Run git ${op} again to continue; Sphinx reopens at this question.`, terminal.width, '    ')));
      return 1;
    }
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
    if (answer.startsWith('/') && !dispute && !learn) { terminal.warning(`Use /hint, /learn, /dispute <reason>, ${stop}, or type your answer.`); continue; }
    const previous = state;
    try {
      state = await withSpinner(learn ? 'Preparing an explanation' : dispute ? 'Reviewing the question' : 'Checking your reasoning', () => store.answer(session.id, learn ? LEARN : dispute ? answer.slice(9) : answer, config, { dispute, learn, expectedQuestionId: previous.question.id, signal, hold: waitingGit }));
    } catch (error) {
      // Like the browser: a failed grade leaves the same question open. Only cancelling ends the check.
      if (signal?.aborted || ['SPHINX_CANCELLED', 'EVALUATOR_CANCELLED'].includes(error?.code) || error?.name === 'AbortError') throw error;
      terminal.line('');
      terminal.warning(`That didn't go through: ${plain(error.message)}`);
      terminal.note(`Your progress is kept. Try again, or ${stop} to stop here.`);
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
  return finish(terminal, { waitingGit, more, ask, event });
}

// After a pass, a waiting Git operation goes through only when the human says so.
async function finish(terminal, { waitingGit, more, ask, event }) {
  const { style } = terminal, [op, Op] = words(event);
  if (waitingGit && !more) {
    terminal.line('');
    terminal.line(`  ${style.strong(`Continue the ${op}?`)}`);
    terminal.line(style.muted(wrapText(`continue: the ${op} goes through. stop: it does not go through. Your pass is saved, so the next ${op} of this change asks only whether to continue.`, terminal.width, '  ')));
    for (;;) {
      const choice = plain(await ask(`  ${style.amber('›')} continue / stop: `)).trim().toLowerCase();
      if (['continue', 'c', 'y', 'yes', 'proceed'].includes(choice)) break;
      if (['stop', 's', 'n', 'no', '/stop', '/quit'].includes(choice)) {
        terminal.line('');
        mark(terminal, style.amber('‖'), `${Op} stopped. It did not go through; your pass is saved.`);
        terminal.line('');
        return 4;
      }
      terminal.warning('Type continue or stop.');
    }
  }
  terminal.line(style.muted(wrapText(!waitingGit ? 'Approval saved for this exact change and destination. A waiting push or commit goes through once you choose Continue in its questionnaire.' : more ? `Approval saved. This ${op} has another destination to check next.` : 'Approval saved. Git is continuing.', terminal.width, '  ')));
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

