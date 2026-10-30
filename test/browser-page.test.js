import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { browserPage } from '../src/browser-page.js';

function page(fetchImpl = () => assert.fail('No request expected'), { narrow = false } = {}) {
  const element = tag => ({ tag, textContent: '', hidden: false, value: '', disabled: false, children: [], style: {}, className: '', title: '', dataset: {}, attributes: {},
    scrollHeight: 0, scrollTop: 0, clientHeight: 0, placeholder: '', querySelectorAll() { return []; },
    setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
    classList: { values: new Set(), toggle(name, on) { if (on) this.values.add(name); else this.values.delete(name); }, contains(name) { return this.values.has(name); } },
    replaceChildren(...items) { this.children = [...items]; }, append(...items) { this.children.push(...items); }, focus() {},
    set innerHTML(_value) { assert.fail('Untrusted strings must not enter HTML'); },
  });
  const nodes = Object.fromEntries(['meta', 'usage', 'conversation', 'messages', 'composer', 'submit', 'status', 'message', 'feedback', 'error', 'question', 'prompt', 'choices', 'form', 'response', 'recovery', 'pause', 'waiting', 'skip', 'skipbar', 'skipreason', 'skipconfirm', 'skipcancel', 'label', 'dispute'].map(id => [id, element()]));
  const buttons = [nodes.pause, element(), { ...element(), dataset: { action: 'learn' } }, { ...element(), dataset: { action: 'dispute' } }];
  let events;
  const context = vm.createContext({ document: { visibilityState: 'visible', getElementById: id => nodes[id] ??= element('div'), createElement: element, querySelectorAll: selector => selector === '[data-action]' ? buttons.slice(2) : buttons }, fetch: fetchImpl,
    EventSource: class { constructor() { events = this; this.closed = false; } close() { this.closed = true; } }, matchMedia: () => ({ matches: narrow }),
  });
  const script = browserPage({ token: 'fixture-token', nonce: 'fixture-nonce' }).match(/<script[^>]*>([\s\S]*?)<\/script>/u)[1];
  vm.runInContext(script, context);
  const update = state => events.onmessage({ data: JSON.stringify(state) });
  return { nodes, buttons, context, update, get events() { return events; } };
}
const question = { id: 'a'.repeat(64), sequence: 1, revision: 'r1', phase: 'question', waitingGit: true, target: 'refs/heads/main', repoRoot: '/fixture', question: { id: 'q1', prompt: '<img src=x onerror=steal()>', choices: ['<script>attack()</script>'] }, progress: { completed: 0, total: 1 }, usage: { calls: 1, limit: 20 } };

test('browser renders source-controlled question text as literal text and does not auto-submit', () => {
  const p = page(); p.update(question);
  assert.equal(p.nodes.prompt.textContent, question.question.prompt);
  assert.equal(p.nodes.choices.children[0].textContent, question.question.choices[0]);
  assert.equal(p.nodes.status.textContent, 'Question 1 of 1');
  assert.equal(p.nodes.response.value, '');
});

test('late POST working response cannot overwrite a newer passed SSE update', async () => {
  let respond;
  const p = page(() => new Promise(resolve => { respond = resolve; }));
  p.update(question); p.nodes.response.value = 'My direct answer.';
  const submitted = p.context.send('answer');
  p.update({ ...question, sequence: 3, phase: 'passed', message: 'Complete.' });
  respond({ ok: true, json: async () => ({ ...question, sequence: 2, phase: 'working' }) });
  await submitted;
  assert.equal(p.nodes.status.textContent, 'Passed');
  assert.equal(p.nodes.question.hidden, true);
});

test('transient SSE disconnect disables actions without replay and reconnect restores the current question', () => {
  const p = page(); p.update(question); p.nodes.response.value = 'Unsent text';
  p.events.onerror();
  assert.equal(p.events.closed, false);
  assert.ok(p.buttons.every(button => button.disabled));
  assert.match(p.nodes.error.textContent, /Reconnecting/);
  p.update(question);
  assert.equal(p.nodes.response.value, 'Unsent text');
  assert.ok(p.buttons.every(button => !button.disabled));
  assert.equal(p.nodes.error.hidden, true);
});

test('completing one checkpoint keeps the event connection available for the next checkpoint in the batch', () => {
  const p = page(); p.update(question);
  p.update({ ...question, sequence: 2, phase: 'passed' });
  assert.equal(p.events.closed, false);
  p.events.onerror();
  assert.equal(p.events.closed, false, 'An intermediate pass must reconnect after a transient stream failure');
  assert.ok(p.buttons.every(button => button.disabled));
  p.update({ ...question, id: 'b'.repeat(64), sequence: 3 });
  assert.equal(p.nodes.status.textContent, 'Question 1 of 1');
  assert.equal(p.nodes.question.hidden, false);
  assert.ok(p.buttons.every(button => !button.disabled));
});

test('the page stops reconnecting only after an explicit operation-close update', () => {
  const p = page(); p.update(question);
  p.update({ ...question, sequence: 2, phase: 'passed', operationClosed: true });
  assert.equal(p.events.closed, true);
  assert.ok(p.buttons.every(button => button.disabled));
  p.events.onerror();
  assert.equal(p.nodes.error.hidden, true);
  assert.equal(p.nodes.status.textContent, 'Passed');
});

test('Enter submits an answer while Shift+Enter and IME composition do not', async () => {
  const bodies = [];
  const p = page(async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ...question, sequence: 2, phase: 'working' }) }; });
  p.update(question); p.nodes.response.value = 'Only the shared button changes.';
  const key = extra => { let prevented = false; p.nodes.response.onkeydown({ key: 'Enter', shiftKey: false, isComposing: false, repeat: false, preventDefault() { prevented = true; }, ...extra }); return prevented; };
  assert.equal(key({ shiftKey: true }), false);
  assert.equal(key({ isComposing: true }), false);
  assert.equal(bodies.length, 0);
  assert.equal(key(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bodies.map(body => [body.action, body.response]), [['answer', 'Only the shared button changes.']]);
});

test('the transcript renders questions, answers, feedback, and live activity as text', () => {
  const p = page();
  const messages = [
    { id: 'm1', role: 'sphinx', kind: 'activity', text: 'Reading src/app.js' },
    { id: 'm2', role: 'sphinx', kind: 'question', questionId: 'q1', number: 1, text: question.question.prompt, choices: [] },
    { id: 'm3', role: 'human', kind: 'answer', text: '<b>mine</b>', status: 'graded' },
    { id: 'm4', role: 'sphinx', kind: 'feedback', text: 'Close, but…' },
    { id: 'm5', role: 'sphinx', kind: 'activity', text: 'Drafting questions' },
  ];
  p.update({ ...question, phase: 'working', messages });
  const rows = p.nodes.messages.children;
  assert.equal(rows.length, 5);
  assert.match(rows[0].className, /activity/); assert.doesNotMatch(rows[0].className, /live/);
  assert.match(rows[4].className, /activity live/);
  const summary = row => row.children[0].children[0];
  assert.equal(summary(rows[4]).children[0].textContent, 'Drafting questions');
  assert.equal(rows[2].children.at(-1).textContent, '<b>mine</b>');
  assert.match(p.nodes.status.className, /busy/);
  assert.equal(p.nodes.question.hidden, true, 'A question already in the transcript is not shown twice');
});

test('Skip this time sends the optional reason even while the review is still working', async () => {
  const bodies = [];
  const p = page(async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ...question, sequence: 3, phase: 'skipped' }) }; });
  p.update({ ...question, phase: 'working' });
  p.nodes.skip.onclick();
  assert.equal(p.nodes.skipbar.hidden, false);
  p.nodes.skipreason.value = ' prod is down ';
  await p.nodes.skipconfirm.onclick();
  assert.deepEqual(bodies.map(body => [body.action, body.response]), [['skip', 'prod is down']]);
  assert.equal(p.nodes.status.textContent, 'Skipped');
  assert.equal(p.nodes.skip.hidden, true);
});

test('consecutive review steps collapse to one closed group showing only the latest step', () => {
  const p = page();
  const messages = ['Read the diff for 3 changed files', 'Reading src/a.js', 'Searching for “x”'].map((text, i) => ({ id: 'm' + i, role: 'sphinx', kind: 'activity', text }));
  p.update({ ...question, phase: 'working', messages });
  const rows = p.nodes.messages.children;
  assert.equal(rows.length, 1);
  const details = rows[0].children[0], [summary, list] = details.children;
  assert.equal(details.open, false);
  assert.deepEqual(summary.children.map(node => node.textContent), ['Searching for “x”', '3 steps']);
  assert.equal(list.children.length, 3);
});

test('a phase change scrolls the conversation so recovery choices are visible', () => {
  const p = page();
  p.update({ ...question, phase: 'working', messages: [{ id: 'm1', role: 'sphinx', kind: 'activity', text: 'Reading a.js' }] });
  Object.assign(p.nodes.conversation, { scrollHeight: 5000, scrollTop: 0, clientHeight: 600 });
  p.update({ ...question, sequence: 2, phase: 'recovery', choices: [{ value: 'retry', label: 'Continue the saved review', description: '' }] });
  assert.equal(p.nodes.conversation.scrollTop, 5000);
  assert.equal(p.nodes.recovery.hidden, false);
  assert.equal(p.nodes.recovery.children.length, 1);
});

test('state line names follow-ups and finished checks stop describing a waiting Git operation', () => {
  const p = page(); const asked = { role: 'sphinx', kind: 'question', questionId: 'q1', number: 1, text: 'First?' };
  p.update({ ...question, messages: [asked] });
  assert.equal(p.nodes.status.textContent, 'Question 1 of 1'); assert.match(p.nodes.status.className, /phase-question/);
  p.update({ ...question, sequence: 2, question: { id: 'q2', prompt: 'Again?' }, messages: [asked, { role: 'sphinx', kind: 'question', questionId: 'q2', number: 1, followUp: true, text: 'Again?' }] });
  assert.equal(p.nodes.status.textContent, 'Question 1 of 1 · Needs another answer'); assert.match(p.nodes.status.className, /retry/);
  assert.equal(p.nodes.waiting.textContent, 'After you pass, you choose whether the push goes through. Closing this tab leaves it waiting; Stop push stops it.');
  p.update({ ...question, sequence: 3, phase: 'passed' });
  assert.match(p.nodes.status.className, /phase-passed/);
  assert.equal(p.nodes.waiting.hidden, true);
});

test('Dispute is a reversible mode: Enter sends a dispute, and Back to answering restores normal answers', async () => {
  const bodies = [];
  const p = page(async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ...question, sequence: 9, phase: 'working' }) }; });
  p.update(question);
  const enter = () => p.nodes.response.onkeydown({ key: 'Enter', shiftKey: false, isComposing: false, repeat: false, preventDefault() {} });
  p.nodes.dispute.onclick();
  assert.equal(p.nodes.submit.textContent, 'Send dispute');
  assert.equal(p.nodes.dispute.textContent, 'Back to answering');
  assert.equal(p.nodes.form.classList.contains('disputing'), true);
  p.nodes.dispute.onclick();
  assert.equal(p.nodes.submit.textContent, 'Send');
  assert.equal(p.nodes.label.textContent, 'Your answer');
  p.nodes.response.value = 'My actual answer.';
  enter(); await new Promise(resolve => setImmediate(resolve));
  p.update({ ...question, sequence: 10 });
  p.nodes.dispute.onclick(); p.nodes.response.value = 'It assumes retries exist.';
  enter(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bodies.map(body => body.action), ['answer', 'dispute']);
});

test('a streaming reply renders with a live cursor and hides the generic working status', () => {
  const p = page();
  p.update({ ...question, phase: 'working', messages: [
    { id: 'm1', role: 'human', kind: 'answer', text: 'Yes.', status: 'checking' },
    { id: 'm2', role: 'sphinx', kind: 'feedback', streaming: true, text: 'Not quite. The constant' },
  ] });
  const row = p.nodes.messages.children[1];
  assert.match(row.className, /streaming/);
  assert.equal(row.children.at(-1).textContent, 'Not quite. The constant');
  assert.equal(p.nodes.status.hidden, true);
});

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const header = { checkpoint: 'a'.repeat(64), repository: 'fixture', event: 'pre-push', remote: 'origin', destination: 'refs/heads/main', base: 'b'.repeat(40), head: 'c'.repeat(40), staged: false, excludedFiles: 1 };
const changedFiles = [
  { path: '<img src=x onerror=steal()>.js', status: 'modified', binary: false, additions: 2, deletions: 1 },
  { path: 'assets/logo.bin', status: 'modified', binary: true, additions: null, deletions: null },
  { path: 'gone.txt', status: 'deleted', binary: false, additions: 0, deletions: 2 },
  { path: 'src/new.js', oldPath: 'src/old.js', status: 'renamed', binary: false, additions: 3, deletions: 0 },
];
const totals = { files: 4, additions: 5, deletions: 3, binaryFiles: 1, uncountedFiles: 0 };
const fileDiff = (path, context = '3') => path === 'assets/logo.bin'
  ? { path, status: 'modified', binary: true, additions: null, deletions: null, context, hunks: [], truncated: null, note: 'binary' }
  : { path, status: 'modified', binary: false, additions: 2, deletions: 1, context, truncated: path === 'gone.txt' ? { shownRows: 3000, totalRows: 4200 } : null, note: null,
    hunks: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 3, section: 'function <b>x</b>()', rows: [
      { type: 'context', old: 4, new: 4, text: '<script>keep()</script>' }, { type: 'deletion', old: 5, new: null, text: 'old' },
      { type: 'addition', old: null, new: 5, text: 'new' }, { type: 'addition', old: null, new: 6, text: 'more' }] }] };
function changePage() {
  const requests = [];
  const p = page(async url => {
    requests.push(url);
    const query = new URL(url, 'http://local').searchParams;
    if (url.includes('/change?')) return { ok: true, json: async () => ({ status: 'ready', id: question.id, header, totals, files: changedFiles, listed: changedFiles.length }) };
    if (url.includes('/diff?')) return { ok: true, json: async () => fileDiff(query.get('path'), query.get('context')) };
    assert.fail(`Unexpected request ${url}`);
  });
  return { p, requests };
}
const refs = [{ path: 'src/new.js', inChange: true, viewPath: 'src/new.js', ranges: [{ side: 'new', start: 5, end: 6 }] }, { path: 'lib/dependency.js', inChange: false, ranges: [{ side: 'new', start: 3, end: 8 }] }];
const withChange = { ...question, question: { id: 'q1', prompt: 'What changes?', choices: [] }, change: { status: 'ready', header, totals }, evidence: { questionId: 'q1', refs } };
const fileButtons = p => p.nodes['file-list'].children.map(li => li.children[0]).filter(Boolean);

test('the change header and file list show exact scope and render repository paths literally', async () => {
  const { p, requests } = changePage();
  p.update(withChange); await flush();
  p.nodes.hint.onclick(); await flush();
  assert.equal(requests.filter(url => url.includes('/change?')).length, 1);
  assert.equal(p.nodes['scope-op'].textContent, 'Push to origin / main');
  assert.equal(p.nodes['scope-range'].textContent, 'bbbbbbbbbb → cccccccccc');
  const stats = p.nodes['scope-stats'].children;
  assert.equal(stats.map(node => node.textContent).join(''), '4 files · +5 −3 lines · 1 binary file (no line counts)');
  assert.deepEqual(stats.filter(node => node.className).map(node => [node.className, node.textContent]), [['plus', '+5'], ['minus', '−3']], 'colored like git diff --stat');
  assert.equal(p.nodes['scope-progress'].textContent, 'Question 1 of 1');
  assert.match(p.nodes['scope-note'].textContent, /not necessarily an entire pull request.*1 more changed file excluded/);
  const buttons = fileButtons(p);
  assert.equal(buttons.length, 4);
  assert.equal(buttons[0].children[1].textContent, '<img src=x onerror=steal()>.js');
  assert.equal(buttons[1].children[0].textContent, 'Binary');
  assert.equal(buttons[1].children[2].textContent, 'binary', 'Binary files show no manufactured line counts');
  assert.equal(buttons[3].children[1].children[0].textContent, 'from src/old.js');
  assert.match(buttons[3].getAttribute('aria-label'), /Renamed src\/new\.js from src\/old\.js, 3 added, 0 removed lines, cited by this question/);
  assert.equal(p.nodes['count-all'].textContent, '4 files');
  assert.equal(p.nodes['count-relevant'].textContent, '1 file');
  assert.match(p.nodes['filter-total'].textContent, /^All changed files: 4 files · \+5 −3 lines/);
  assert.equal(p.nodes['scope-excluded'].textContent, '1 file not shown or counted');
});

test('browsing files, filters, context, and views preserves the draft answer and current question', async () => {
  const { p, requests } = changePage();
  p.update(withChange); await flush();
  p.nodes.hint.onclick(); await flush();
  p.nodes.response.value = 'My unfinished answer.';
  for (const button of fileButtons(p).slice(0, 3)) { button.onclick(); await flush(); }
  assert.equal(p.nodes['diff-title'].textContent, 'gone.txt');
  assert.match(p.nodes['diff-note'].textContent, /first 3,000 of 4,200 diff lines/);
  p.nodes['filter-relevant'].onclick();
  assert.deepEqual(fileButtons(p).map(button => button.dataset.path), ['src/new.js']);
  p.nodes['file-search'].value = 'nothing'; p.nodes['file-search'].oninput();
  p.nodes['filter-all'].onclick(); p.nodes['file-search'].value = ''; p.nodes['file-search'].oninput();
  assert.equal(fileButtons(p).length, 4);
  p.nodes['context-more'].onclick(); await flush();
  assert.match(requests.at(-1), /path=gone\.txt&context=25$/);
  p.nodes['tab-files'].onclick(); p.nodes['tab-diff'].onclick();
  assert.equal(p.nodes.workspace.className, 'workspace show-diff');
  p.nodes['back-question'].onclick();
  assert.equal(p.nodes.workspace.className, 'workspace show-question');
  p.update({ ...withChange, sequence: 2 }); await flush();
  assert.equal(p.nodes.response.value, 'My unfinished answer.');
  assert.equal(p.nodes.status.textContent, 'Question 1 of 1');
  assert.ok(requests.every(url => !url.endsWith('/action')), 'Browsing never submits or changes the question');
});

test('evidence links open the cited hunk with non-color markers and label unchanged dependencies', async () => {
  const { p, requests } = changePage();
  p.update(withChange); await flush();
  p.nodes.hint.onclick(); await flush();
  const [linked, dependency] = p.nodes['evidence-list'].children;
  assert.equal(dependency.className, 'static');
  assert.match(dependency.children[1].textContent, /Unchanged file, not part of this change\. lines 3–8/);
  assert.match(p.nodes['evidence-note'].textContent, /not a claim that every changed line was read/);
  linked.children[0].onclick(); await flush();
  assert.match(requests.at(-1), /path=src%2Fnew\.js&context=3$/);
  assert.equal(p.nodes.workspace.className, 'workspace show-diff');
  const rows = p.nodes['diff-body'].children[0].children[0].children;
  assert.equal(rows[0].children[0].textContent, '⋯ 3 unchanged lines not shown');
  assert.equal(rows[1].children[0].textContent, '@@ −4,2 +4,3 @@ function <b>x</b>()');
  const marked = rows.filter(row => row.className.includes('evidence'));
  assert.deepEqual(marked.map(row => row.children[0].textContent), ['▸', '▸']);
  assert.deepEqual(marked.map(row => row.children[3].textContent), ['+', '+']);
  assert.equal(rows[2].children[4].textContent, '<script>keep()</script>');
  assert.match(marked[0].getAttribute('aria-label'), /Added line 5, read by the reviewer/);
  assert.equal(p.nodes['diff-legend'].hidden, false);
});

test('unavailable change data or evidence keeps the question answerable with an honest fallback', async () => {
  const p = page();
  p.update({ ...question, change: { status: 'unavailable', reason: 'The checkpoint’s Git objects are unavailable.' }, evidence: { questionId: 'q1', refs: [] } });
  p.nodes.hint.onclick();
  assert.match(p.nodes['scope-stats'].textContent, /^Unavailable: The checkpoint/);
  assert.match(p.nodes['files-note'].textContent, /The question can still be answered/);
  assert.equal(p.nodes['evidence-note'].textContent, 'No specific code location is available for this question.');
  assert.ok(p.buttons.every(button => !button.disabled));
  p.update({ ...question, sequence: 2, phase: 'passed', change: { status: 'unavailable' } });
  assert.equal(p.nodes.evidence.hidden, true);
});

test('before Show hint, nothing points at the code behind the question; the hint reveals it once per question', async () => {
  const { p, requests } = changePage();
  p.update(withChange); await flush();
  assert.equal(p.nodes.evidence.hidden, true, 'No code references before the hint');
  assert.equal(p.nodes['filter-relevant'].hidden, true, 'No relevant-files filter before the hint');
  assert.ok(fileButtons(p).every(button => !/cited by this question/.test(button.getAttribute('aria-label'))));
  assert.ok(requests.every(url => !url.includes('/diff?')), 'The cited file is not opened automatically');
  assert.equal(p.nodes.hint.textContent, 'Show hint');
  p.nodes.hint.onclick(); await flush();
  assert.equal(p.nodes.evidence.hidden, false);
  assert.equal(p.nodes.hint.disabled, true);
  assert.equal(p.nodes.hint.textContent, 'Hint shown');
  p.update({ ...withChange, sequence: 3, question: { ...withChange.question, id: 'q2' } }); await flush();
  assert.equal(p.nodes.evidence.hidden, true, 'A new question starts without the hint');
});

test('passing shows a clear end state that says the tab can be closed', () => {
  const p = page(); p.update(question);
  p.update({ ...question, sequence: 2, phase: 'passed', message: 'You passed. You can close this tab; Git is finishing the push on its own.' });
  assert.equal(p.nodes.message.className, 'message passed');
  assert.match(p.nodes.message.textContent, /close this tab/);
});

const consent = { ...question, sequence: 2, phase: 'consent', question: undefined, message: 'You passed. Continue the push?', choices: [
  { value: 'proceed', label: 'Continue push', description: 'Continue: the push goes through.' },
  { value: 'stop', label: 'Stop push', description: 'Stop: it does not go through. Your pass is saved, so the next push of this change asks only whether to continue.' },
] };

test('consent after a waiting pass is one row, Continue in amber and Stop plain, explained in one line', async () => {
  const bodies = [];
  const p = page(async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ...question, sequence: 4, phase: 'passed', message: 'You passed. You can close this tab; Git is finishing the push on its own.' }) }; });
  p.context.document.visibilityState = 'hidden';
  p.update(consent);
  assert.equal(p.nodes.message.textContent, 'You passed. Continue the push?'); assert.equal(p.nodes.message.className, 'message passed');
  assert.equal(p.nodes.status.hidden, true, 'no chip repeating what the scope line says');
  assert.equal(p.nodes['scope-progress'].textContent, 'Continue or stop');
  assert.equal(p.nodes.recovery.hidden, true); assert.equal(p.nodes.consent.hidden, false);
  const [row, note] = p.nodes.consent.children;
  assert.equal(row.className, 'actions');
  assert.deepEqual(row.children.map(button => [button.textContent, button.className]), [['Continue push', 'primary'], ['Stop push', '']], 'red stays reserved for skipping the check');
  assert.equal(note.className, 'hint');
  assert.equal(note.textContent, 'Continue: the push goes through. Stop: it does not go through. Your pass is saved, so the next push of this change asks only whether to continue.');
  assert.equal(p.nodes.skip.hidden, true); assert.equal(p.nodes.pause.hidden, true); assert.equal(p.nodes.composer.hidden, true);
  assert.equal(p.nodes.waiting.textContent, 'The push waits for your choice. Closing this tab leaves it waiting.');
  assert.equal(p.context.document.title, '● Sphinx: continue the push?');
  await row.children[0].onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bodies.map(body => body.action), ['proceed']);
  assert.equal(p.nodes.status.textContent, 'Passed'); assert.equal(p.nodes.consent.hidden, true);
});

const stopped = { ...question, sequence: 3, phase: 'stopped', question: undefined, resume: 'git push origin main', message: 'Push stopped. It did not go through. Your pass is saved, so the next push of this change asks only whether to continue. You can close this tab.' };

test('on a phone, consent comes into view on the Question tab with its buttons last, and the outcome after a choice stays in view', () => {
  const p = page(undefined, { narrow: true }), scrolled = [];
  p.update({ ...question, messages: [{ id: 'm1', role: 'sphinx', kind: 'question', questionId: 'q1', number: 1, text: 'First?' }] });
  p.context.setTab('diff');
  for (const id of ['message', 'consent', 'status']) p.nodes[id].scrollIntoView = options => scrolled.push([id, options.block]);
  p.update(consent);
  assert.equal(p.nodes.workspace.className, 'workspace show-question', 'consent is never left behind the Diff tab');
  assert.deepEqual(scrolled, [['message', 'nearest'], ['consent', 'nearest']], 'only as far as needed, and the buttons win over a long message');
  scrolled.length = 0; p.update(stopped);
  assert.deepEqual(scrolled, [['status', 'nearest'], ['message', 'nearest']], 'the result stays where it is instead of jumping back to the question');
  const wide = page(); wide.update(question); wide.nodes.consent.scrollIntoView = () => assert.fail('wide screens scroll the conversation instead');
  wide.update(consent);
});

test('the consent row is built once per step and takes focus as a group, so updates never drop focus and Enter confirms nothing', () => {
  const html = browserPage({ token: 'fixture-token', nonce: 'fixture-nonce' });
  assert.match(html, /<div id="consent" class="consent" role="group" aria-labelledby="message" aria-describedby="consent-hint" tabindex="-1" hidden><\/div>/);
  const p = page(); let focused = 0; p.update(question);
  p.nodes.consent.focus = () => { focused++; };
  p.update(consent);
  const [row, note] = p.nodes.consent.children;
  assert.equal(focused, 1); assert.equal(note.id, 'consent-hint');
  p.update({ ...consent, sequence: 3, distance: { current: 'mixed', next: 'low', scope: 'machine' } });
  assert.equal(p.nodes.consent.children[0], row, 'a display-only update keeps the same buttons');
  assert.equal(focused, 1, 'focus is taken once, on entering the step');
  p.nodes.consent.querySelectorAll = () => row.children;
  p.events.onerror();
  assert.ok(row.children.every(button => button.disabled), 'no choice can be sent while disconnected');
  p.update({ ...consent, sequence: 4 });
  assert.ok(row.children.every(button => !button.disabled));
});

test('during consent, a refused choice or a lost connection is shown, and the footer stops saying the push waits', async () => {
  const p = page(async () => ({ ok: false, json: async () => ({ error: 'This checkpoint changed. Use the current question.' }) }));
  p.update(question); p.update(consent);
  assert.equal(p.nodes.composer.hidden, true);
  await p.nodes.consent.children[0].children[0].onclick();
  assert.equal(p.nodes.error.textContent, 'This checkpoint changed. Use the current question.');
  assert.equal(p.nodes.error.hidden, false); assert.equal(p.nodes.composer.hidden, false); assert.equal(p.nodes.form.hidden, true, 'only the error line shows');
  p.events.onerror();
  assert.match(p.nodes.error.textContent, /^Connection interrupted\. Reconnecting/);
  assert.equal(p.nodes.waiting.hidden, true);
  p.update({ ...consent, sequence: 3 });
  assert.equal(p.nodes.error.hidden, true); assert.equal(p.nodes.composer.hidden, true);
  assert.equal(p.nodes.waiting.textContent, 'The push waits for your choice. Closing this tab leaves it waiting.'); assert.equal(p.nodes.waiting.hidden, false);
});

test('stopping after a pass is a finished check that no longer describes a waiting Git operation', () => {
  const p = page(); p.update(question);
  p.update(stopped);
  assert.match(p.nodes.message.textContent, /^Push stopped\. It did not go through\./);
  assert.equal(p.nodes.status.textContent, 'Stopped'); assert.equal(p.nodes.status.className, 'status phase-stopped', 'the same ‖ Stopped mark as any other stop');
  assert.equal(p.nodes.resume.hidden, false); assert.equal(p.nodes['resume-command'].textContent, 'git push origin main');
  assert.equal(p.nodes['scope-progress'].textContent, 'Stopped');
  assert.equal(p.nodes.waiting.hidden, true);
  assert.equal(p.nodes.skip.hidden, true);
  assert.equal(p.nodes.pause.hidden, true);
  assert.ok(p.buttons.every(button => button.disabled));
});

test('the header button reads Stop push or Stop commit while Git waits, and Pause check when nothing waits', async () => {
  const bodies = [];
  const p = page(async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ ...question, sequence: 3, phase: 'paused', message: 'Push stopped. It did not go through, and your progress is saved.', resume: 'git push origin main' }) }; });
  p.update(question);
  assert.equal(p.nodes.pause.textContent, 'Stop push');
  await p.nodes.pause.onclick();
  assert.deepEqual(bodies.map(body => body.action), ['pause'], 'the same pause, named for what it does');
  assert.equal(p.nodes.status.textContent, 'Stopped'); assert.equal(p.nodes['scope-progress'].textContent, 'Stopped');
  assert.equal(p.nodes['resume-command'].textContent, 'git push origin main');
  const commit = page(); commit.update({ ...question, event: 'pre-commit' });
  assert.equal(commit.nodes.pause.textContent, 'Stop commit');
  assert.equal(commit.nodes.waiting.textContent, 'After you pass, you choose whether the commit goes through. Closing this tab leaves it waiting; Stop commit stops it.');
  const manual = page(); manual.update({ ...question, waitingGit: false });
  assert.equal(manual.nodes.pause.textContent, 'Pause check');
  assert.equal(manual.nodes.waiting.textContent, 'Closing this tab leaves the check waiting. Use Pause check to stop.');
  manual.update({ ...question, waitingGit: false, sequence: 2, phase: 'paused', message: 'Paused. Your progress is saved.' });
  assert.equal(manual.nodes.status.textContent, 'Paused');
});

test('the context line names the model reviewing this check', () => {
  const p = page();
  p.update({ ...question, route: { provider: 'openrouter', model: 'qwen/qwen3-coder', tier: 'small' }, tokens: { input: 5200, output: 900, cost: 0.0014 } });
  assert.equal(p.nodes.usage.textContent, 'OpenRouter qwen/qwen3-coder · 6.1k tokens · $0.0014 · 1/20 calls');
  p.update({ ...question, sequence: 2, route: { provider: 'claude', model: 'haiku', tier: 'small' } });
  assert.equal(p.nodes.usage.textContent, 'Claude Code haiku');
});

test('the score shows one dot per recent answer, empty slots while warming up, and the percentage once scored', () => {
  const p = page();
  p.update({ ...question, score: { calibrating: true, answered: 2, needed: 3, accuracy: null, streak: 2, skipRate: null, recent: [true, false] } });
  assert.equal(p.nodes.score.hidden, false);
  assert.deepEqual(p.nodes['score-dots'].children.map(dot => dot.className), ['hit', 'miss', '', '', '']);
  assert.equal(p.nodes['score-value'].textContent, 'warming up');
  p.update({ ...question, sequence: 2, score: { calibrating: false, answered: 34, needed: 0, accuracy: 82, streak: 3, skipRate: 6, recent: [true, true, false, true] } });
  assert.equal(p.nodes['score-value'].textContent, '82%');
  assert.equal(p.nodes['score-dots'].children.length, 4);
  assert.match(p.nodes['score-dots'].children.at(-1).className, /hit fresh/, 'A newly graded answer pops in');
  assert.equal(p.nodes['score-meta'].textContent, '3 in a row · skipped 6%');
});

test('a saved ungraded answer or dispute is restored when its question opens, keeping the error visible', () => {
  const p = page();
  p.update({ ...question, draft: { kind: 'answer', text: 'Saved <b>answer</b>.' } });
  assert.equal(p.nodes.response.value, 'Saved <b>answer</b>.');
  assert.equal(p.nodes.form.classList.contains('disputing'), false);
  const d = page();
  d.update({ ...question, error: 'OpenRouter HTTP 429.', draft: { kind: 'dispute', text: 'It assumes a unique index.' } });
  assert.equal(d.nodes.response.value, 'It assumes a unique index.');
  assert.equal(d.nodes.submit.textContent, 'Send dispute');
  assert.equal(d.nodes.error.textContent, 'OpenRouter HTTP 429.');
  // Later updates for the same question never overwrite what the human is typing.
  d.nodes.response.value = 'Edited.';
  d.update({ ...question, sequence: 2, draft: { kind: 'dispute', text: 'It assumes a unique index.' } });
  assert.equal(d.nodes.response.value, 'Edited.');
});
