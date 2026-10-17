// services/examService.ts
// CBT step 2: everything the public student routes need. The snapshot (with the correct options)
// stays in here: students only ever get the "view" shapes below, and `correct` appears only in
// resultPayload() after the attempt is submitted and only when the test has showAnswers on.

import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { normalizeOptions } from './paperRenderer';

// A save or submit that arrives this long after the deadline is still accepted (network delay).
export const SUBMIT_GRACE_SEC = Math.max(0, parseInt(process.env.EXAM_SUBMIT_GRACE_SEC || '15', 10) || 15);

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

interface SnapOption { label: string; text?: string; isCorrect?: boolean; image?: any }
type Kind = 'SCQ' | 'MSQ' | 'NAT'; // single-answer MCQ, multiple-correct MCQ, numerical
interface SnapQuestion {
  id: string; number: number; text?: string; marks: number;
  kind?: Kind;                       // missing = SCQ (every test published before multiple-correct and numerical existed)
  options?: SnapOption[]; images?: any[]; tables?: any[];
  answer?: number; tolerance?: number; // NAT only
}
interface SnapSection { id: string; title: string; description?: string; questions: SnapQuestion[] }
interface Snapshot { examDetails?: Record<string, any>; sections: SnapSection[] }

interface ViewOption { label: string; text: string; image?: any }
interface BaseView { text: string; options: ViewOption[]; images?: any[]; tables?: any[] }
export interface IndexEntry {
  q: SnapQuestion; sectionIdx: number; kind: Kind;
  correct: string;               // SCQ: the label. MSQ: labels like "a,c". NAT: the number as text.
  correctSet: Set<string>;       // SCQ/MSQ: the correct labels
  answer?: number; tolerance?: number; // NAT
  labels: Set<string>; view: BaseView;
}

export interface ExamIndex {
  examDetails: Record<string, any>;
  sections: SnapSection[];
  byId: Map<string, IndexEntry>;
}

export interface Order { sections: Array<{ id: string; qids: string[] }>; opts?: Record<string, string[]> }

export interface CleanAnswer { selected: string | null; marked: boolean; visited: boolean; t: number }

// Everything about a test except the snapshot.
const META = {
  id: true, code: true, title: true, instructions: true, durationMin: true, marksPerQuestion: true,
  negativeMarks: true, shuffleQuestions: true, shuffleOptions: true, opensAt: true, closesAt: true,
  showResult: true, showAnswers: true, onePerRoll: true, status: true, totalMarks: true,
  questionCount: true, partialMarking: true, updatedAt: true,
} as const;
export const TEST_META = META;
export type TestMeta = Prisma.TestGetPayload<{ select: typeof META }>;

// ─────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────

export const cleanName = (s: unknown) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
export const nameKey = (s: unknown) => cleanName(s).toLowerCase();
/** Roll numbers compare without case or spaces: "21 a 105" and "21A105" are the same roll. */
export const rollKey = (s: unknown) => String(s ?? '').normalize('NFC').replace(/\s+/g, '').toUpperCase();

export const newToken = () => crypto.randomBytes(24).toString('base64url');

const round2 = (n: number) => Math.round(n * 100) / 100;

function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export type TestState = 'open' | 'not_open' | 'closed' | 'ended';

export function testState(t: { status: string; opensAt: Date | null; closesAt: Date | null }, now = Date.now()): TestState {
  if (t.status === 'CLOSED') return 'closed';
  if (t.opensAt && t.opensAt.getTime() > now) return 'not_open';
  if (t.closesAt && t.closesAt.getTime() <= now) return 'ended';
  return 'open';
}

function pickImage(img: any) {
  if (!img || typeof img.url !== 'string') return undefined;
  const out: Record<string, unknown> = { url: img.url, id: String(img.id ?? img.url) };
  if (Number(img.width) > 0) out.width = Number(img.width);
  if (Number(img.height) > 0) out.height = Number(img.height);
  if (img.size) out.size = img.size;
  if (typeof img.alt === 'string') out.alt = img.alt;
  return out;
}

// ─────────────────────────────────────────
// Snapshot index (cached per test version)
// ─────────────────────────────────────────

function indexSnapshot(snap: Snapshot): ExamIndex {
  const sections: SnapSection[] = Array.isArray(snap?.sections) ? snap.sections : [];
  const byId = new Map<string, IndexEntry>();

  sections.forEach((s, sectionIdx) => {
    for (const q of s.questions || []) {
      const kind: Kind = q.kind === 'MSQ' || q.kind === 'NAT' ? q.kind : 'SCQ';
      const opts = Array.isArray(q.options) ? q.options : [];
      const images = (Array.isArray(q.images) ? q.images : []).map(pickImage).filter(Boolean);
      const tables = (Array.isArray(q.tables) ? q.tables : [])
        .filter(t => t && Array.isArray(t.rows))
        .map(t => ({ rows: t.rows, ...(t.headerRow === false ? { headerRow: false } : {}) }));
      const extras = { ...(images.length ? { images } : {}), ...(tables.length ? { tables } : {}) };

      if (kind === 'NAT') {
        const answer = Number(q.answer);
        if (!Number.isFinite(answer)) continue; // cannot happen for a published test
        byId.set(q.id, {
          q, sectionIdx, kind, correct: String(answer), correctSet: new Set(), labels: new Set(),
          answer, tolerance: Math.max(0, Number(q.tolerance) || 0),
          view: { text: q.text || '', options: [], ...extras },
        });
        continue;
      }

      const correctLabels = opts.filter(o => o.isCorrect === true).map(o => o.label);
      if (correctLabels.length < 1) continue; // cannot happen for a published test

      // The same clean-up the PDF applies, so the question reads exactly as on paper.
      const { cleanedQuestionText, fixedOptions } = normalizeOptions(opts as any, q.text || '');
      const fixedByLabel = new Map(fixedOptions.map(o => [o.label, o]));
      const options: ViewOption[] = opts.map(o => {
        const f = fixedByLabel.get(o.label);
        const image = pickImage(o.image);
        return { label: o.label, text: f ? f.text : o.text || '', ...(image ? { image } : {}) };
      });

      byId.set(q.id, {
        q,
        sectionIdx,
        kind,
        correct: kind === 'MSQ' ? correctLabels.slice().sort().join(',') : correctLabels[0],
        correctSet: new Set(correctLabels),
        labels: new Set(opts.map(o => o.label)),
        view: { text: cleanedQuestionText || q.text || '', options, ...extras },
      });
    }
  });

  return { examDetails: snap?.examDetails || {}, sections, byId };
}

const examCache = new Map<string, ExamIndex>();

export async function getExam(test: { id: string; updatedAt: Date }): Promise<ExamIndex> {
  const key = `${test.id}:${test.updatedAt.getTime()}`;
  const hit = examCache.get(key);
  if (hit) {
    examCache.delete(key);
    examCache.set(key, hit); // most recently used goes last
    return hit;
  }
  const row = await prisma.test.findUnique({ where: { id: test.id }, select: { snapshot: true } });
  if (!row) throw new Error('Test not found');
  const idx = indexSnapshot(row.snapshot as unknown as Snapshot);
  examCache.set(key, idx);
  if (examCache.size > 40) examCache.delete(examCache.keys().next().value as string);
  return idx;
}

// ─────────────────────────────────────────
// Order (shuffle) and what a student sees
// ─────────────────────────────────────────

/** Sections keep their place (they are the subject tabs); questions and options shuffle inside them. */
export function buildOrder(idx: ExamIndex, test: { shuffleQuestions: boolean; shuffleOptions: boolean }): Order {
  const sections = idx.sections.map(s => {
    const ids = s.questions.filter(q => idx.byId.has(q.id)).map(q => q.id);
    return { id: s.id, qids: test.shuffleQuestions ? shuffled(ids) : ids };
  });
  const order: Order = { sections };
  if (test.shuffleOptions) {
    order.opts = {};
    idx.byId.forEach((e, id) => { if (e.q.options?.length) order.opts![id] = shuffled(e.q.options.map(o => o.label)); });
  }
  return order;
}

function completeIds(s: SnapSection, idx: ExamIndex, os?: { qids: string[] }): string[] {
  const own = new Set(s.questions.map(q => q.id));
  const ids = (os?.qids || []).filter(id => own.has(id) && idx.byId.has(id));
  const seen = new Set(ids);
  for (const q of s.questions) if (idx.byId.has(q.id) && !seen.has(q.id)) ids.push(q.id);
  return ids;
}

/** The sections and questions in this student's order. `correct` only when withCorrect is true. */
export function viewSections(idx: ExamIndex, order: Order | null | undefined, withCorrect = false) {
  let no = 0;
  return idx.sections.map(s => {
    const os = order?.sections?.find(x => x.id === s.id);
    const questions = completeIds(s, idx, os).map(qid => {
      const e = idx.byId.get(qid)!;
      no++;
      const labels = order?.opts?.[qid];
      let options = e.view.options;
      if (labels && labels.length === options.length && labels.every(l => e.labels.has(l))) {
        const byLabel = new Map(options.map(o => [o.label, o]));
        options = labels.map(l => byLabel.get(l)!);
      }
      return {
        id: qid,
        no,
        kind: e.kind,
        text: e.view.text,
        marks: e.q.marks,
        options,
        ...(e.view.images ? { images: e.view.images } : {}),
        ...(e.view.tables ? { tables: e.view.tables } : {}),
        ...(withCorrect ? { correct: e.correct, ...(e.kind === 'NAT' ? { tolerance: e.tolerance } : {}) } : {}),
      };
    });
    return { id: s.id, title: s.title, ...(s.description ? { description: s.description } : {}), questions };
  });
}

export function answersMap(rows: Array<{ questionId: string; selected: string | null; marked: boolean; visited: boolean; timeSpentSec: number }>) {
  const out: Record<string, { selected: string | null; marked: boolean; visited: boolean; t: number }> = {};
  for (const r of rows) out[r.questionId] = { selected: r.selected, marked: r.marked, visited: r.visited, t: r.timeSpentSec };
  return out;
}

// ─────────────────────────────────────────
// Answers: validate, save, grade
// ─────────────────────────────────────────

const NUM_RE = /^-?(\d+\.?\d*|\.\d+)$/;

/** One answer, checked against its question's kind. Anything invalid becomes null (no answer). */
function cleanSelected(e: IndexEntry, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (e.kind === 'NAT') return v.length <= 20 && NUM_RE.test(v) ? v : null;
  if (e.kind === 'MSQ') {
    const parts = Array.from(new Set(v.split(',').map(x => x.trim()).filter(Boolean)));
    if (!parts.length || !parts.every(l => e.labels.has(l))) return null;
    return parts.sort().join(',');
  }
  return e.labels.has(v) ? v : null;
}

/** Only known questions and real option labels get through; anything else is dropped. null = not an object. */
export function cleanAnswers(idx: ExamIndex, raw: unknown, maxEntries: number, maxT: number): Map<string, CleanAnswer> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, any>);
  if (entries.length > maxEntries) return null;
  const out = new Map<string, CleanAnswer>();
  for (const [qid, a] of entries) {
    const e = idx.byId.get(qid);
    if (!e || !a || typeof a !== 'object') continue;
    const selected = typeof a.selected === 'string' ? cleanSelected(e, a.selected) : null;
    const t = Math.min(maxT, Math.max(0, Math.round(Number(a.t) || 0)));
    out.set(qid, { selected, marked: a.marked === true, visited: a.visited === true || selected !== null, t });
  }
  return out;
}

export async function writeAnswers(attemptId: string, clean: Map<string, CleanAnswer>) {
  if (clean.size === 0) return;
  const existing = await prisma.answer.findMany({ where: { attemptId, questionId: { in: Array.from(clean.keys()) } } });
  const have = new Map(existing.map(r => [r.questionId, r]));
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  clean.forEach((a, questionId) => {
    const r = have.get(questionId);
    const data = {
      selected: a.selected,
      marked: a.marked,
      visited: a.visited,
      timeSpentSec: Math.max(r?.timeSpentSec ?? 0, a.t),
    };
    if (r && r.selected === data.selected && r.marked === data.marked && r.visited === data.visited && r.timeSpentSec === data.timeSpentSec) return;
    ops.push(prisma.answer.upsert({
      where: { attemptId_questionId: { attemptId, questionId } },
      create: { attemptId, questionId, ...data },
      update: data,
    }));
  });
  if (ops.length) await prisma.$transaction(ops);
}

export type Verdict = 'right' | 'wrong' | 'partial' | 'skipped';

/**
 * Marks for one answer. The same function scores students, results and analytics.
 *  - Single answer: right = full marks, wrong = minus the negative marks.
 *  - Multiple correct: exactly the right set = full marks. A wrong option anywhere = minus the negative
 *    marks. A correct subset with nothing wrong = marks x picked / total correct when partial marking is
 *    on (a "partial"), otherwise it counts as wrong.
 *  - Numerical: within the tolerance = full marks; wrong costs nothing (no negative marking).
 */
export function evaluate(
  e: IndexEntry,
  selected: string | null | undefined,
  negativeMarks: number,
  partialMarking: boolean
): { verdict: Verdict; marks: number } {
  if (!selected) return { verdict: 'skipped', marks: 0 };
  const marks = e.q.marks;

  if (e.kind === 'NAT') {
    const v = Number(selected);
    const ok = Number.isFinite(v) && Math.abs(v - (e.answer as number)) <= (e.tolerance || 0) + 1e-9;
    return ok ? { verdict: 'right', marks } : { verdict: 'wrong', marks: 0 };
  }

  if (e.kind === 'MSQ') {
    const picked = new Set(selected.split(','));
    const anyWrong = Array.from(picked).some(l => !e.correctSet.has(l));
    if (anyWrong) return { verdict: 'wrong', marks: -negativeMarks };
    if (picked.size === e.correctSet.size) return { verdict: 'right', marks };
    if (partialMarking) return { verdict: 'partial', marks: round2((marks * picked.size) / e.correctSet.size) };
    return { verdict: 'wrong', marks: -negativeMarks };
  }

  return selected === e.correct ? { verdict: 'right', marks } : { verdict: 'wrong', marks: -negativeMarks };
}

export function gradeAnswers(
  idx: ExamIndex,
  negativeMarks: number,
  rows: Array<{ questionId: string; selected: string | null }>,
  partialMarking = false
) {
  const chosen = new Map(rows.map(r => [r.questionId, r.selected]));
  let score = 0, correct = 0, wrong = 0, partial = 0, skipped = 0;
  idx.byId.forEach((e, qid) => {
    const r = evaluate(e, chosen.get(qid), negativeMarks, partialMarking);
    score += r.marks;
    if (r.verdict === 'right') correct++;
    else if (r.verdict === 'wrong') wrong++;
    else if (r.verdict === 'partial') partial++;
    else skipped++;
  });
  return { score: round2(score), correct, wrong, partial, skipped };
}

// ─────────────────────────────────────────
// Finishing an attempt
// ─────────────────────────────────────────

const WITH_TEST = { include: { test: { select: META } } } as const;

/**
 * Grades and closes an attempt. Safe to call twice. While the attempt is within its deadline (plus the
 * short grace) the answers map the student sent is saved first; later than that only what was already
 * autosaved counts, and submittedAt is the deadline.
 */
export async function finalizeAttempt(attemptId: string, input?: { answers?: unknown }) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, ...WITH_TEST });
  if (!attempt) return null;
  if (attempt.status === 'SUBMITTED') return attempt;

  const idx = await getExam(attempt.test);
  const deadline = attempt.deadlineAt.getTime();
  const now = Date.now();
  const late = now > deadline + SUBMIT_GRACE_SEC * 1000;

  if (input?.answers !== undefined && !late) {
    const clean = cleanAnswers(idx, input.answers, Math.max(idx.byId.size, 1) + 5, attempt.test.durationMin * 60);
    if (clean) await writeAnswers(attempt.id, clean);
  }

  const rows = await prisma.answer.findMany({ where: { attemptId: attempt.id } });
  const g = gradeAnswers(idx, attempt.test.negativeMarks, rows, attempt.test.partialMarking);
  await prisma.attempt.updateMany({
    where: { id: attempt.id, status: 'IN_PROGRESS' },
    data: { status: 'SUBMITTED', submittedAt: new Date(Math.min(now, deadline)), score: g.score },
  });
  return prisma.attempt.findUnique({ where: { id: attemptId }, ...WITH_TEST });
}

/** Stores how many times the student left the exam screen. Only ever goes up, capped, safe to repeat. */
export async function recordTabSwitches(attemptId: string, count: unknown) {
  const n = Math.min(500, Math.max(0, Math.floor(Number(count) || 0)));
  if (n <= 0) return;
  await prisma.attempt.updateMany({ where: { id: attemptId, tabSwitches: { lt: n } }, data: { tabSwitches: n } });
}

// ─────────────────────────────────────────
// Teacher controls on exam day
// ─────────────────────────────────────────

export const MAX_EXTEND_MIN = 180;

/**
 * Start this student over: answers wiped, fresh timer (the full duration, even past closesAt), new
 * shuffle, new token (so any device still open stops saving). Works on running and submitted attempts.
 * The student reopens the link and enters the same name and roll number to continue.
 */
export async function resetAttempt(attemptId: string, test: TestMeta) {
  const idx = await getExam(test);
  const now = Date.now();
  await prisma.$transaction([
    prisma.answer.deleteMany({ where: { attemptId } }),
    prisma.attempt.update({
      where: { id: attemptId },
      data: {
        status: 'IN_PROGRESS',
        token: newToken(),
        startedAt: new Date(now),
        deadlineAt: new Date(now + test.durationMin * 60000),
        submittedAt: null,
        score: null,
        tabSwitches: 0,
        order: buildOrder(idx, test) as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);
}

/** Adds minutes to a running attempt's remaining time. Returns false if it is not running any more. */
export async function extendAttempt(attemptId: string, minutes: number): Promise<boolean> {
  const a = await prisma.attempt.findUnique({ where: { id: attemptId }, select: { id: true, status: true, deadlineAt: true } });
  if (!a || a.status !== 'IN_PROGRESS') return false;
  const base = Math.max(a.deadlineAt.getTime(), Date.now());
  const r = await prisma.attempt.updateMany({
    where: { id: a.id, status: 'IN_PROGRESS' },
    data: { deadlineAt: new Date(base + minutes * 60000) },
  });
  return r.count === 1;
}

/** Adds minutes to everyone still writing (their time has not run out yet). Returns how many. */
export async function extendAllRunning(testId: string, minutes: number): Promise<number> {
  const now = Date.now();
  const running = await prisma.attempt.findMany({
    where: { testId, status: 'IN_PROGRESS', deadlineAt: { gte: new Date(now - SUBMIT_GRACE_SEC * 1000) } },
    select: { id: true, deadlineAt: true },
  });
  if (!running.length) return 0;
  const results = await prisma.$transaction(
    running.map(a =>
      prisma.attempt.updateMany({
        where: { id: a.id, status: 'IN_PROGRESS' },
        data: { deadlineAt: new Date(Math.max(a.deadlineAt.getTime(), now) + minutes * 60000) },
      })
    )
  );
  return results.reduce((n, r) => n + r.count, 0);
}

/** If this attempt ran out of time, submit it now (lazy auto-submit). Returns the fresh row when it did. */
export async function expireIfDue<T extends { id: string; status: string; deadlineAt: Date }>(attempt: T) {
  if (attempt.status === 'IN_PROGRESS' && Date.now() > attempt.deadlineAt.getTime() + SUBMIT_GRACE_SEC * 1000) {
    return finalizeAttempt(attempt.id);
  }
  return null;
}

let sweeping = false;
/** Cron: submit attempts whose time ran out and whose student never came back. */
export async function sweepExpiredAttempts() {
  if (sweeping) return;
  sweeping = true;
  try {
    const cutoff = new Date(Date.now() - SUBMIT_GRACE_SEC * 1000);
    for (let round = 0; round < 20; round++) {
      const due = await prisma.attempt.findMany({
        where: { status: 'IN_PROGRESS', deadlineAt: { lt: cutoff } },
        select: { id: true },
        take: 100,
      });
      if (!due.length) break;
      for (const a of due) {
        try { await finalizeAttempt(a.id); } catch (err) { logger.error('Auto-submit failed:', err); }
      }
    }
  } catch (err) {
    logger.error('Attempt sweep failed:', err);
  } finally {
    sweeping = false;
  }
}

// ─────────────────────────────────────────
// Entering a test
// ─────────────────────────────────────────

export type EntryResult =
  | { kind: 'created'; token: string }
  | { kind: 'resumed'; token: string }
  | { kind: 'roll_in_use' }
  | { kind: 'already_taken' }
  | { kind: 'not_open' | 'closed' | 'ended' };

function deadlineFor(test: TestMeta, startMs: number) {
  const byDuration = startMs + test.durationMin * 60000;
  return test.closesAt ? Math.min(byDuration, test.closesAt.getTime()) : byDuration;
}

/** What would happen if this student started now. Writes nothing. */
export async function checkEntry(test: TestMeta, name: string, roll: string): Promise<'ok' | 'resume' | 'roll_in_use' | 'already_taken' | 'not_open' | 'closed' | 'ended'> {
  const key = rollKey(roll);
  const stale = await prisma.attempt.findMany({
    where: { testId: test.id, rollNo: key, status: 'IN_PROGRESS', deadlineAt: { lt: new Date(Date.now() - SUBMIT_GRACE_SEC * 1000) } },
    select: { id: true },
  });
  for (const s of stale) await finalizeAttempt(s.id);

  const attempts = await prisma.attempt.findMany({ where: { testId: test.id, rollNo: key }, select: { name: true, status: true } });
  const running = attempts.find(a => a.status === 'IN_PROGRESS');
  if (running) return nameKey(running.name) === nameKey(name) ? 'resume' : 'roll_in_use';
  if (attempts.length && test.onePerRoll) {
    return attempts.some(a => nameKey(a.name) === nameKey(name)) ? 'already_taken' : 'roll_in_use';
  }
  const state = testState(test);
  return state === 'open' ? 'ok' : state;
}

/** Start a new attempt, or resume the running one (new token, so the old device stops saving). */
export async function startAttempt(test: TestMeta, name: string, roll: string): Promise<EntryResult> {
  const idx = await getExam(test);
  const key = rollKey(roll);
  const nm = cleanName(name);

  const stale = await prisma.attempt.findMany({
    where: { testId: test.id, rollNo: key, status: 'IN_PROGRESS', deadlineAt: { lt: new Date(Date.now() - SUBMIT_GRACE_SEC * 1000) } },
    select: { id: true },
  });
  for (const s of stale) await finalizeAttempt(s.id);

  return prisma.$transaction(
    async (tx): Promise<EntryResult> => {
      // One start at a time per roll number, so a double tap cannot make two attempts.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${test.id + ':' + key}))`;

      const attempts = await tx.attempt.findMany({ where: { testId: test.id, rollNo: key }, orderBy: { startedAt: 'desc' } });
      const running = attempts.find(a => a.status === 'IN_PROGRESS');
      if (running) {
        if (nameKey(running.name) !== nameKey(nm)) return { kind: 'roll_in_use' };
        const token = newToken();
        await tx.attempt.update({ where: { id: running.id }, data: { token } });
        return { kind: 'resumed', token };
      }
      if (attempts.length && test.onePerRoll) {
        return attempts.some(a => nameKey(a.name) === nameKey(nm)) ? { kind: 'already_taken' } : { kind: 'roll_in_use' };
      }

      const state = testState(test);
      if (state !== 'open') return { kind: state };

      const now = Date.now();
      const token = newToken();
      await tx.attempt.create({
        data: {
          testId: test.id,
          token,
          name: nm,
          rollNo: key,
          startedAt: new Date(now),
          deadlineAt: new Date(deadlineFor(test, now)),
          order: buildOrder(idx, test) as unknown as Prisma.InputJsonValue,
        },
      });
      return { kind: 'created', token };
    },
    { timeout: 10000, maxWait: 10000 }
  );
}

// ─────────────────────────────────────────
// Payloads
// ─────────────────────────────────────────

/** Everything the exam screen needs. No correct answers anywhere in it. */
export async function attemptPayload(attempt: { id: string; name: string; rollNo: string; startedAt: Date; deadlineAt: Date; order: unknown; tabSwitches: number }, test: TestMeta) {
  const idx = await getExam(test);
  const rows = await prisma.answer.findMany({ where: { attemptId: attempt.id } });
  return {
    test: {
      title: test.title,
      institution: idx.examDetails.institutionName || null,
      subject: idx.examDetails.subject || null,
      durationMin: test.durationMin,
      totalMarks: test.totalMarks,
      questionCount: test.questionCount,
      negativeMarks: test.negativeMarks,
    },
    attempt: {
      name: attempt.name,
      rollNo: attempt.rollNo,
      startedAt: attempt.startedAt.getTime(),
      deadlineAt: attempt.deadlineAt.getTime(),
      tabSwitches: attempt.tabSwitches,
    },
    sections: viewSections(idx, attempt.order as Order | null, false),
    answers: answersMap(rows),
  };
}

/** The finished screen. The score only if showResult is on; the correct answers only if showAnswers is on. */
export async function resultPayload(
  attempt: { id: string; name: string; rollNo: string; startedAt: Date; submittedAt: Date | null; score: number | null; order: unknown },
  test: TestMeta
) {
  const idx = await getExam(test);
  const rows = await prisma.answer.findMany({ where: { attemptId: attempt.id } });
  const g = gradeAnswers(idx, test.negativeMarks, rows, test.partialMarking);
  const out: Record<string, unknown> = {
    submitted: true,
    title: test.title,
    name: attempt.name,
    rollNo: attempt.rollNo,
    showResult: test.showResult,
    showAnswers: test.showAnswers,
  };
  if (test.showResult) {
    Object.assign(out, {
      score: attempt.score ?? g.score,
      totalMarks: test.totalMarks,
      correct: g.correct,
      wrong: g.wrong,
      partial: g.partial,
      skipped: g.skipped,
      negativeMarks: test.negativeMarks,
      timeTakenSec: attempt.submittedAt ? Math.max(0, Math.round((attempt.submittedAt.getTime() - attempt.startedAt.getTime()) / 1000)) : null,
    });
  }
  if (test.showAnswers) {
    out.review = { sections: viewSections(idx, attempt.order as Order | null, true), answers: answersMap(rows) };
  }
  return out;
}