import { createHash } from 'node:crypto';
import path from 'node:path';
import { getPaths, readJson, writeJson } from './config.js';

// Passed questions outlive the checkpoint files. Checks are garbage-collected
// after a day; the deck keeps the prompts and stored explanations so the same
// person can try them again later without another model call.
export const INTERVALS = Object.freeze([1, 3, 7, 14, 30]);
export const MAX_CARDS = 200;
const DAY = 24 * 3600 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
export const cardId = (repoRoot, prompt) => digest(`${repoRoot}\0${String(prompt || '').trim()}`).slice(0, 32);
export const deckFile = (repoRoot, env = process.env) => path.join(getPaths(env).home, 'decks', `${digest(repoRoot)}.json`);

const text = value => typeof value === 'string' && value.trim() ? value.trim() : '';
const iso = value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function emptyDeck(repoRoot) {
  return { version: 1, repoRoot, cards: {} };
}

function readCard(card, id) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  const prompt = text(card.prompt);
  if (!prompt) return null;
  return {
    id: text(card.id) || id,
    prompt,
    back: text(card.back),
    target: text(card.target) || undefined,
    firstTry: card.firstTry === true,
    capturedAt: iso(card.capturedAt) || new Date().toISOString(),
    dueAt: iso(card.dueAt) || new Date().toISOString(),
    intervalDays: INTERVALS.includes(card.intervalDays) ? card.intervalDays : count(card.intervalDays) || 1,
    reviews: count(card.reviews),
    lastReviewedAt: iso(card.lastReviewedAt),
  };
}

export async function readDeck(repoRoot, env = process.env) {
  const stored = await readJson(deckFile(repoRoot, env), null).catch(() => null);
  const cards = {};
  if (stored?.cards && typeof stored.cards === 'object' && !Array.isArray(stored.cards)) {
    for (const [id, value] of Object.entries(stored.cards)) {
      const card = readCard(value, id);
      if (card) cards[card.id] = card;
    }
  }
  return { version: 1, repoRoot, cards };
}

async function saveDeck(repoRoot, deck, env) {
  await writeJson(deckFile(repoRoot, env), { version: 1, repoRoot, cards: deck.cards });
}

/** JSON and CLI listings never include the stored explanation. */
export function publicCard(card) {
  return {
    id: card.id, prompt: card.prompt, target: card.target || null,
    dueAt: card.dueAt, intervalDays: card.intervalDays, reviews: card.reviews,
    capturedAt: card.capturedAt, lastReviewedAt: card.lastReviewedAt, firstTry: card.firstTry === true,
  };
}

export function dueCards(deck, now = new Date()) {
  const at = now.getTime();
  return Object.values(deck.cards).filter(card => Date.parse(card.dueAt) <= at).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
}

export function deckSummary(deck, now = new Date()) {
  const cards = Object.values(deck.cards);
  const due = dueCards(deck, now);
  const upcoming = cards.filter(card => Date.parse(card.dueAt) > now.getTime()).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return { total: cards.length, due: due.length, upcoming: upcoming.length, nextDue: due[0]?.dueAt ?? upcoming[0]?.dueAt ?? null };
}

export function nextInterval(intervalDays, rating) {
  if (rating === 'again') return 1;
  const current = INTERVALS.includes(intervalDays) ? intervalDays : 1;
  const index = INTERVALS.indexOf(current);
  return INTERVALS[Math.min(INTERVALS.length - 1, index + 1)];
}

function firstTryFor(session, index, question) {
  const attempts = (session.attempts || []).filter(item => item && (item.index === index || item.questionId === question.id) && item.kind === 'answer');
  return attempts[0]?.verdict === 'correct';
}

function storedBack(session, index, question) {
  const fromQuestion = text(question.rationale) || text(question.expectedAnswer);
  if (fromQuestion) return fromQuestion;
  const attempts = (session.attempts || []).filter(item => item && (item.index === index || item.questionId === question.id) && item.verdict === 'correct');
  return text(attempts.at(-1)?.feedback);
}

function prune(cards) {
  const entries = Object.values(cards);
  if (entries.length <= MAX_CARDS) return cards;
  const drop = [...entries].sort((a, b) => (a.lastReviewedAt || a.capturedAt).localeCompare(b.lastReviewedAt || b.capturedAt)).slice(0, entries.length - MAX_CARDS);
  const next = { ...cards };
  for (const card of drop) delete next[card.id];
  return next;
}

function applyGood(card, at) {
  const intervalDays = nextInterval(card.intervalDays, 'good');
  return { ...card, intervalDays, dueAt: new Date(at.getTime() + intervalDays * DAY).toISOString(), reviews: card.reviews + 1, lastReviewedAt: at.toISOString() };
}

/** Copy the questions from a passed check into the local deck. Best-effort. */
export async function capturePassedCheck({ session, env = process.env, now = new Date() } = {}) {
  if (!session || session.status !== 'passed' || session.noQuestionReason || !Array.isArray(session.questions) || !session.questions.length) return 0;
  const repoRoot = session.snapshot?.repoRoot;
  if (typeof repoRoot !== 'string' || !repoRoot) return 0;
  try {
    const deck = await readDeck(repoRoot, env);
    const at = now instanceof Date ? now : new Date(now);
    let added = 0;
    for (const [index, question] of session.questions.entries()) {
      const prompt = text(question?.prompt);
      if (!prompt) continue;
      const id = cardId(repoRoot, prompt);
      const existing = deck.cards[id];
      const card = {
        id, prompt, back: storedBack(session, index, question),
        target: text(session.snapshot?.target?.ref) || undefined,
        firstTry: firstTryFor(session, index, question),
        capturedAt: existing?.capturedAt || at.toISOString(),
        dueAt: existing?.dueAt || new Date(at.getTime() + DAY).toISOString(),
        intervalDays: existing?.intervalDays || 1,
        reviews: existing?.reviews || 0,
        lastReviewedAt: existing?.lastReviewedAt || null,
      };
      deck.cards[id] = existing ? applyGood({ ...existing, ...card, intervalDays: existing.intervalDays, reviews: existing.reviews }, at) : card;
      if (!existing) added += 1;
    }
    deck.cards = prune(deck.cards);
    await saveDeck(repoRoot, deck, env);
    return added;
  } catch {
    return 0;
  }
}

export async function reviewCard({ repoRoot, id, rating, env = process.env, now = new Date() } = {}) {
  if (!['again', 'good'].includes(rating)) throw new Error('Rate a card as again or good.');
  const deck = await readDeck(repoRoot, env);
  const card = deck.cards[id];
  if (!card) throw new Error('That card is not in this repository’s deck.');
  const at = now instanceof Date ? now : new Date(now);
  const intervalDays = nextInterval(card.intervalDays, rating);
  deck.cards[id] = {
    ...card, intervalDays,
    dueAt: new Date(at.getTime() + intervalDays * DAY).toISOString(),
    reviews: card.reviews + 1,
    lastReviewedAt: at.toISOString(),
  };
  await saveDeck(repoRoot, deck, env);
  return deck.cards[id];
}
