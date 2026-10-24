// The Sphinx GitHub Action. It reads the stamp a contributor's Sphinx left in a
// PR comment after they passed its understanding check, and shows it as a
// "Sphinx" check run on the PR's latest commit. It never checks out or runs PR
// code, so it is safe on pull_request_target and issue_comment, including forks.
// The stamp is self-reported by the contributor's machine: it shows the check
// happened, not that it could not have been faked.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const CHECK_NAME = 'Sphinx';
const MARKER = /<!-- sphinx-stamp:v1 ([A-Za-z0-9+/=]+) -->/;
// Comments from these users can stamp a PR: its author, or people with write access.
const MAINTAINERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Only what the contributor's Sphinx writes is accepted, so no field can break the check: text or null,
// whole-number change stats, and questions with a prompt and, when they were tracked, tries and firstTry.
const whole = value => Number.isInteger(value) && value >= 0;
const optionalText = value => value === undefined || value === null || typeof value === 'string';
const validStats = stats => stats === undefined || stats === null || (typeof stats === 'object' && !Array.isArray(stats) && ['files', 'additions', 'deletions'].every(key => stats[key] === undefined || whole(stats[key])));
const validQuestion = question => Boolean(question) && typeof question === 'object' && typeof question.prompt === 'string'
  && (question.tries === undefined ? question.firstTry === undefined : whole(question.tries) && typeof question.firstTry === 'boolean');

/** The stamp in one comment body, validated, or null. */
export function parseStamp(body) {
  const match = MARKER.exec(String(body || ''));
  if (!match) return null;
  let stamp;
  try { stamp = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')); } catch { return null; }
  if (!stamp || stamp.v !== 1 || typeof stamp.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(stamp.head) || !['passed', 'skipped'].includes(stamp.outcome)) return null;
  if (!['at', 'level', 'distance', 'model', 'noQuestionReason'].every(key => optionalText(stamp[key])) || !validStats(stamp.stats) || !Array.isArray(stamp.questions) || !stamp.questions.every(validQuestion)) return null;
  return stamp;
}

/** The newest trusted stamp for this exact commit. */
export function findStamp({ comments, head, author }) {
  for (const comment of [...comments].sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at))) {
    const trusted = comment.user?.login === author || MAINTAINERS.has(comment.author_association);
    const stamp = trusted && parseStamp(comment.body);
    if (stamp && stamp.head === head) return { stamp, comment };
  }
  return null;
}

// Model text is plain text here: no markup, no table breaks, one line.
const clean = (text, max = 300) => String(text ?? '').replace(/\s+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[|`*_[\]\\]/g, char => `\\${char}`).trim().slice(0, max);
const count = n => Number(n || 0).toLocaleString('en-US');

/** The check run's conclusion, title, and summary. */
export function checkFor(found, { require = false } = {}) {
  if (!found) {
    return {
      conclusion: require ? 'failure' : 'neutral',
      title: 'No Sphinx stamp for this commit',
      summary: [
        'Sphinx asks the person shipping a change a few questions about what it does before it is pushed. This commit has not been stamped.',
        '',
        'To stamp it: install [Sphinx](https://github.com/parthh01/sphinx), check pull request branches (`"branches": ["*"]` in `.sphinxconfig`), and push again with the GitHub CLI signed in. The stamp appears here a minute or so after the push.',
      ].join('\n'),
    };
  }
  const { stamp, comment } = found;
  if (stamp.outcome === 'skipped') return { conclusion: 'failure', title: 'Understanding check skipped', summary: `The contributor skipped Sphinx's understanding check for this commit. [Sphinx comment](${comment.html_url})` };
  const asked = stamp.questions.length;
  const first = stamp.questions.filter(question => question.firstTry === true).length;
  const known = stamp.questions.every(question => typeof question.firstTry === 'boolean');
  const title = asked ? `Sphinx stamped · ${asked} question${asked === 1 ? '' : 's'}${known ? `, ${first} first try` : ''}` : 'Sphinx stamped · no questions needed';
  const rows = [
    stamp.stats && ['Change', `${count(stamp.stats.files)} files, +${count(stamp.stats.additions)} −${count(stamp.stats.deletions)}`],
    stamp.level && ['Depth', clean(stamp.level, 40)],
    stamp.distance && ['Distance', clean(stamp.distance, 40)],
    stamp.model && ['Reviewer', clean(stamp.model, 80)],
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stamp.at || '') && ['Checked', `${stamp.at.slice(0, 16).replace('T', ' ')} UTC`],
  ].filter(Boolean);
  const lines = [`**${title}**`, ''];
  if (rows.length) lines.push('| | |', '|---|---|', ...rows.map(([key, value]) => `| ${key} | ${value} |`), '');
  if (stamp.noQuestionReason) lines.push(`No questions: ${clean(stamp.noQuestionReason)}`, '');
  if (asked) {
    lines.push('### Questions', '');
    stamp.questions.forEach((question, index) => {
      const mark = typeof question.firstTry !== 'boolean' ? '•' : question.firstTry ? '✅ first try' : `↻ ${question.tries} tries`;
      lines.push(`${index + 1}. ${mark}: ${clean(question.prompt, 600)}`);
    });
    lines.push('');
  }
  lines.push(`[Full summary on the pull request](${comment.html_url}). Self-reported by the contributor's Sphinx; it shows the check happened, not proof that it was done unaided.`);
  return { conclusion: 'success', title, summary: lines.join('\n') };
}

function githubApi({ token, base = 'https://api.github.com', fetchImpl = fetch }) {
  return async (method, route, body) => {
    const response = await fetchImpl(`${base}${route}`, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${route.split('?')[0]} failed: ${response.status} ${await response.text().catch(() => '')}`.trim());
    return response.status === 204 ? null : response.json();
  };
}

/** One run: find the PR, its newest trusted stamp for the head commit, and write the check. */
export async function run({ event, eventName, repository, api, require = false, log = console.log }) {
  const number = eventName === 'issue_comment' ? (event.issue?.pull_request ? event.issue.number : null) : event.pull_request?.number;
  if (!number) { log('Not a pull request; nothing to do.'); return null; }
  const pull = await api('GET', `/repos/${repository}/pulls/${number}`);
  const head = pull.head.sha, author = pull.user.login;
  const comments = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api('GET', `/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  const result = checkFor(findStamp({ comments, head, author }), { require });
  const existing = (await api('GET', `/repos/${repository}/commits/${head}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`)).check_runs?.[0];
  const body = { name: CHECK_NAME, status: 'completed', conclusion: result.conclusion, output: { title: result.title.slice(0, 255), summary: result.summary.slice(0, 60000) } };
  // An update takes no head_sha, which GitHub documents only for creating a check run.
  if (existing) await api('PATCH', `/repos/${repository}/check-runs/${existing.id}`, body);
  else await api('POST', `/repos/${repository}/check-runs`, { ...body, head_sha: head });
  log(`${CHECK_NAME}: ${result.title} (${result.conclusion}) on ${head.slice(0, 7)}`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    await run({
      event, eventName: process.env.GITHUB_EVENT_NAME, repository: process.env.GITHUB_REPOSITORY,
      api: githubApi({ token: process.env.INPUT_TOKEN, base: process.env.GITHUB_API_URL }),
      require: process.env.INPUT_REQUIRE === 'true',
    });
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
