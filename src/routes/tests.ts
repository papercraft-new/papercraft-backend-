// routes/tests.ts
// CBT step 1: the teacher publishes a saved paper as an online test and manages it.
// (Students take the test through separate public routes, added in step 2.)
//
// A test keeps a frozen copy of the paper's MCQ questions ("snapshot"), including which option is
// correct. Editing the paper later never changes a live test, and the snapshot is never sent to
// students as it is: step 2 strips the correct answers before anything leaves the server.

import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { rateLimit } from 'express-rate-limit';
import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/authenticate';
import { asyncHandler } from '../middleware/asyncHandler';
import { logger } from '../utils/logger';
import { TEST_META, resetAttempt, extendAttempt, extendAllRunning, expireIfDue, MAX_EXTEND_MIN } from '../services/examService';
import { buildResults, resultsCsv } from '../services/resultsService';

const router = Router();
router.use(authenticate);

const createLimiter = rateLimit({ windowMs: 60000, max: 20 });

const MAX_TESTS_PER_USER = 100;
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0 o 1 l i, easy to read out and type

function makeCode(): string {
  return Array.from(crypto.randomBytes(8), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// ─────────────────────────────────────────
// SNAPSHOT: which questions can be asked online, and a frozen copy of them
// ─────────────────────────────────────────

interface SkippedQuestion {
  question: string;
  section: string;
  reason: string;
}

interface RawOption { label?: string; text?: string; isCorrect?: boolean; image?: { url?: string } }
interface RawQuestion {
  id?: string; number?: number | string; type?: string; text?: string; marks?: number;
  options?: RawOption[]; images?: unknown[]; tables?: unknown[];
  multi?: boolean;                                        // MCQ with more than one correct option
  numeric?: { answer?: unknown; tolerance?: unknown };    // NUMERICAL: the answer and an optional +/- tolerance
}
interface RawSection { id?: string; title?: string; description?: string; questions?: RawQuestion[] }

export function buildSnapshot(
  paper: { examDetails: unknown; sections: unknown },
  marksPerQuestion: number
) {
  const sections: RawSection[] = Array.isArray(paper.sections) ? (paper.sections as RawSection[]) : [];
  const ed = (paper.examDetails && typeof paper.examDetails === 'object' ? paper.examDetails : {}) as Record<string, unknown>;

  const outSections: Array<Record<string, unknown>> = [];
  const skipped: SkippedQuestion[] = [];
  const usedIds = new Set<string>();
  let counter = 1;
  let totalMarks = 0;
  let totalQuestions = 0;
  const kinds = { scq: 0, msq: 0, nat: 0 };

  sections.forEach((s, si) => {
    const sectionTitle = (s.title || `Section ${si + 1}`).toString();
    const questions: Array<Record<string, unknown>> = [];

    for (const q of Array.isArray(s.questions) ? s.questions : []) {
      totalQuestions++;
      const label = `Q${q.number ?? totalQuestions}`;
      const isNumerical = q.type === 'NUMERICAL';
      if (q.type !== 'MCQ' && !isNumerical) {
        skipped.push({ question: label, section: sectionTitle, reason: 'Not a multiple-choice, multiple-correct or numerical question' });
        continue;
      }

      let kind: 'SCQ' | 'MSQ' | 'NAT' = 'SCQ';
      let options: RawOption[] = [];
      let nat: { answer: number; tolerance: number } | null = null;

      if (isNumerical) {
        const NUM = /^\s*-?(\d+\.?\d*|\.\d+)\s*$/;
        const raw = q.numeric?.answer;
        const answer = typeof raw === 'number' ? raw : typeof raw === 'string' && NUM.test(raw) ? Number(raw) : NaN;
        if (!Number.isFinite(answer)) {
          skipped.push({ question: label, section: sectionTitle, reason: 'No numerical answer set' });
          continue;
        }
        const rawTol = q.numeric?.tolerance;
        const tolerance =
          rawTol === undefined || rawTol === null || rawTol === '' ? 0
          : typeof rawTol === 'number' ? rawTol
          : NUM.test(String(rawTol)) ? Number(rawTol) : NaN;
        if (!Number.isFinite(tolerance) || tolerance < 0) {
          skipped.push({ question: label, section: sectionTitle, reason: 'Tolerance must be a number, 0 or more' });
          continue;
        }
        kind = 'NAT';
        nat = { answer, tolerance };
      } else {
        options = (Array.isArray(q.options) ? q.options : []).filter(
          o => (typeof o?.text === 'string' && o.text.trim()) || o?.image?.url
        );
        if (options.length < 2) {
          skipped.push({ question: label, section: sectionTitle, reason: 'Needs at least 2 options' });
          continue;
        }
        const correct = options.filter(o => o.isCorrect === true).length;
        if (q.multi === true) {
          if (correct < 1) {
            skipped.push({ question: label, section: sectionTitle, reason: 'No correct option marked' });
            continue;
          }
          kind = 'MSQ';
        } else if (correct !== 1) {
          skipped.push({
            question: label,
            section: sectionTitle,
            reason: correct === 0 ? 'No correct option marked' : 'More than one correct option marked (turn on Multiple correct)',
          });
          continue;
        }
      }
      if (kind === 'SCQ') kinds.scq++; else if (kind === 'MSQ') kinds.msq++; else kinds.nat++;

      let id = typeof q.id === 'string' && q.id ? q.id : `q_${counter}`;
      if (usedIds.has(id)) id = `q_${counter}_${usedIds.size}`;
      usedIds.add(id);

      const marks = Number(q.marks) > 0 ? Number(q.marks) : marksPerQuestion;
      totalMarks += marks;

      questions.push({
        id,
        number: counter++,
        text: typeof q.text === 'string' ? q.text : '',
        marks,
        // kind is left out for ordinary single-answer MCQs, so they look exactly as before
        ...(kind !== 'SCQ' ? { kind } : {}),
        ...(nat
          ? { answer: nat.answer, tolerance: nat.tolerance }
          : {
              // labels are re-lettered a, b, c... so the stored answer is always one of them
              options: options.map((o, i) => ({
                label: String.fromCharCode(97 + i),
                text: typeof o.text === 'string' ? o.text : '',
                isCorrect: o.isCorrect === true,
                ...(o.image?.url ? { image: o.image } : {}),
              })),
            }),
        ...(Array.isArray(q.images) && q.images.length ? { images: q.images } : {}),
        ...(Array.isArray(q.tables) && q.tables.length ? { tables: q.tables } : {}),
      });
    }

    if (questions.length > 0) {
      outSections.push({
        id: s.id || `s_${si + 1}`,
        title: sectionTitle,
        ...(s.description ? { description: s.description } : {}),
        questions,
      });
    }
  });

  const usable = counter - 1;
  return {
    snapshot: {
      examDetails: {
        institutionName: ed.institutionName,
        subject: ed.subject,
        class: ed.class,
        examType: ed.examType,
      },
      sections: outSections,
    },
    usable,
    totalQuestions,
    totalMarks,
    skipped,
    kinds,
  };
}

const TEST_LIST_FIELDS = {
  id: true, code: true, paperId: true, title: true, instructions: true, durationMin: true,
  marksPerQuestion: true, negativeMarks: true, shuffleQuestions: true, shuffleOptions: true,
  opensAt: true, closesAt: true, showResult: true, showAnswers: true, onePerRoll: true,
  status: true, totalMarks: true, questionCount: true, partialMarking: true, createdAt: true, updatedAt: true,
} as const;

function parseDate(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined; // not sent
  if (v === null || v === '') return null; // cleared
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
}

// ─────────────────────────────────────────
// LIST MY TESTS
// GET /api/tests
// ─────────────────────────────────────────

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;

    const [tests, submitted] = await Promise.all([
      prisma.test.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { ...TEST_LIST_FIELDS, _count: { select: { attempts: true } } },
      }),
      prisma.attempt.groupBy({
        by: ['testId'],
        where: { status: 'SUBMITTED', test: { userId } },
        _count: { _all: true },
      }),
    ]);

    const submittedBy = new Map<string, number>(
      submitted.map((r: { testId: string; _count: { _all: number } }) => [r.testId, r._count._all])
    );
    res.json({
      success: true,
      data: tests.map((t: { id: string; _count: { attempts: number } }) => ({
        ...t,
        attempts: t._count.attempts,
        submitted: submittedBy.get(t.id) ?? 0,
      })),
    });
  })
);

// ─────────────────────────────────────────
// CHECK A PAPER: how many questions can be asked online?
// POST /api/tests/check   { paperId }
// ─────────────────────────────────────────

router.post(
  '/check',
  [body('paperId').isString().notEmpty()],
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const userId = (req as any).user.userId;
    const paper = await prisma.paper.findFirst({ where: { id: req.body.paperId, userId } });
    if (!paper) return res.status(404).json({ success: false, error: 'Paper not found' });

    const { usable, totalQuestions, skipped, kinds } = buildSnapshot(paper, 1);
    res.json({
      success: true,
      data: { title: paper.title, usable, totalQuestions, kinds, skipped: skipped.slice(0, 50), skippedCount: skipped.length },
    });
  })
);

// ─────────────────────────────────────────
// PUBLISH A TEST
// POST /api/tests
// ─────────────────────────────────────────

router.post(
  '/',
  createLimiter,
  [
    body('paperId').isString().notEmpty().withMessage('Choose a paper'),
    body('title').trim().isLength({ min: 2, max: 200 }).withMessage('Title required (2-200 chars)'),
    body('instructions').optional({ nullable: true }).isString().isLength({ max: 3000 }).withMessage('Instructions are too long'),
    body('durationMin').isInt({ min: 1, max: 600 }).withMessage('Duration must be 1 to 600 minutes'),
    body('marksPerQuestion').optional().isFloat({ min: 0.25, max: 100 }).withMessage('Marks per question must be 0.25 to 100'),
    body('negativeMarks').optional().isFloat({ min: 0, max: 10 }).withMessage('Negative marks must be 0 to 10'),
    body('opensAt').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Invalid start time'),
    body('closesAt').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Invalid end time'),
    body('shuffleQuestions').optional().isBoolean(),
    body('shuffleOptions').optional().isBoolean(),
    body('showResult').optional().isBoolean(),
    body('showAnswers').optional().isBoolean(),
    body('onePerRoll').optional().isBoolean(),
    body('partialMarking').optional().isBoolean(),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg, errors: errors.array() });
    }

    const userId = (req as any).user.userId;
    const b = req.body;

    const paper = await prisma.paper.findFirst({ where: { id: b.paperId, userId } });
    if (!paper) return res.status(404).json({ success: false, error: 'Paper not found' });

    const marksPerQuestion = b.marksPerQuestion !== undefined ? Number(b.marksPerQuestion) : 1;
    const { snapshot, usable, totalMarks, skipped } = buildSnapshot(paper, marksPerQuestion);
    if (usable === 0) {
      return res.status(400).json({
        success: false,
        error: 'This paper has no questions that can be asked online. Use multiple-choice questions with the correct option ticked, or numerical questions with an answer set.',
        skipped: skipped.slice(0, 50),
      });
    }

    const opensAt = parseDate(b.opensAt) ?? null;
    const closesAt = parseDate(b.closesAt) ?? null;
    if (closesAt && closesAt.getTime() <= Date.now()) {
      return res.status(400).json({ success: false, error: 'The end time is already past' });
    }
    if (opensAt && closesAt && closesAt.getTime() <= opensAt.getTime()) {
      return res.status(400).json({ success: false, error: 'The end time must be after the start time' });
    }

    if ((await prisma.test.count({ where: { userId } })) >= MAX_TESTS_PER_USER) {
      return res.status(400).json({ success: false, error: `You can have up to ${MAX_TESTS_PER_USER} tests. Delete old ones first.` });
    }

    let test = null;
    for (let attempt = 0; attempt < 5 && !test; attempt++) {
      try {
        test = await prisma.test.create({
          data: {
            code: makeCode(),
            userId,
            paperId: paper.id,
            title: b.title.trim(),
            instructions: b.instructions ? String(b.instructions).trim() || null : null,
            durationMin: Number(b.durationMin),
            marksPerQuestion,
            negativeMarks: b.negativeMarks !== undefined ? Number(b.negativeMarks) : 0,
            shuffleQuestions: b.shuffleQuestions === true,
            shuffleOptions: b.shuffleOptions === true,
            opensAt,
            closesAt,
            showResult: b.showResult !== false,
            showAnswers: b.showAnswers === true,
            onePerRoll: b.onePerRoll !== false,
            partialMarking: b.partialMarking === true,
            snapshot: JSON.parse(JSON.stringify(snapshot)), // plain JSON (drops undefined fields)
            totalMarks,
            questionCount: usable,
          },
          select: TEST_LIST_FIELDS,
        });
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err; // only a clashing code is retried
      }
    }
    if (!test) return res.status(500).json({ success: false, error: 'Could not create a test code. Try again.' });

    logger.info(`Test published: ${test.code} (${usable} questions) by user ${userId}`);
    res.status(201).json({ success: true, data: { ...test, attempts: 0, submitted: 0 }, skipped: skipped.slice(0, 50), skippedCount: skipped.length });
  })
);

// ─────────────────────────────────────────
// EDIT / CLOSE / REOPEN
// PATCH /api/tests/:id
// ─────────────────────────────────────────

router.patch(
  '/:id',
  [
    body('title').optional().trim().isLength({ min: 2, max: 200 }).withMessage('Title required (2-200 chars)'),
    body('instructions').optional({ nullable: true }).isString().isLength({ max: 3000 }).withMessage('Instructions are too long'),
    body('status').optional().isIn(['PUBLISHED', 'CLOSED']).withMessage('Invalid status'),
    body('opensAt').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Invalid start time'),
    body('closesAt').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Invalid end time'),
    body('showResult').optional().isBoolean(),
    body('showAnswers').optional().isBoolean(),
  ],
  asyncHandler(async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: errors.array()[0].msg, errors: errors.array() });
    }

    const userId = (req as any).user.userId;
    const existing = await prisma.test.findFirst({ where: { id: req.params.id, userId }, select: { id: true, opensAt: true, closesAt: true } });
    if (!existing) return res.status(404).json({ success: false, error: 'Test not found' });

    const b = req.body;
    const data: Record<string, unknown> = {};
    if (b.title !== undefined) data.title = String(b.title).trim();
    if (b.instructions !== undefined) data.instructions = b.instructions ? String(b.instructions).trim() || null : null;
    if (b.status !== undefined) data.status = b.status;
    if (b.showResult !== undefined) data.showResult = b.showResult === true || b.showResult === 'true';
    if (b.showAnswers !== undefined) data.showAnswers = b.showAnswers === true || b.showAnswers === 'true';
    const opensAt = parseDate(b.opensAt);
    const closesAt = parseDate(b.closesAt);
    if (opensAt !== undefined) data.opensAt = opensAt;
    if (closesAt !== undefined) data.closesAt = closesAt;

    const nextOpen = (opensAt !== undefined ? opensAt : existing.opensAt) as Date | null;
    const nextClose = (closesAt !== undefined ? closesAt : existing.closesAt) as Date | null;
    if (nextOpen && nextClose && new Date(nextClose).getTime() <= new Date(nextOpen).getTime()) {
      return res.status(400).json({ success: false, error: 'The end time must be after the start time' });
    }

    const test = await prisma.test.update({
      where: { id: existing.id },
      data,
      select: { ...TEST_LIST_FIELDS, _count: { select: { attempts: true } } },
    });
    res.json({ success: true, data: { ...test, attempts: test._count.attempts } });
  })
);

// ─────────────────────────────────────────
// DELETE (also removes its attempts and answers)
// DELETE /api/tests/:id
// ─────────────────────────────────────────

router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user.userId;
    const existing = await prisma.test.findFirst({ where: { id: req.params.id, userId }, select: { id: true } });
    if (!existing) return res.status(404).json({ success: false, error: 'Test not found' });

    await prisma.test.delete({ where: { id: existing.id } });
    res.json({ success: true, message: 'Test deleted' });
  })
);

// ─────────────────────────────────────────
// RESULTS AND ANALYTICS (teacher only, own tests only)
// GET /api/tests/:id/results
// GET /api/tests/:id/results.csv
// ─────────────────────────────────────────

async function ownTestMeta(req: Request, res: Response) {
  const userId = (req as any).user.userId;
  const test = await prisma.test.findFirst({ where: { id: req.params.id, userId }, select: TEST_META });
  if (!test) res.status(404).json({ success: false, error: 'Test not found' });
  return test;
}

router.get(
  '/:id/results',
  asyncHandler(async (req: Request, res: Response) => {
    const test = await ownTestMeta(req, res);
    if (!test) return;
    res.json({ success: true, data: await buildResults(test) });
  })
);

router.get(
  '/:id/results.csv',
  asyncHandler(async (req: Request, res: Response) => {
    const test = await ownTestMeta(req, res);
    if (!test) return;
    const csv = resultsCsv(await buildResults(test));
    const slug = test.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'test';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-results.csv"`);
    res.send(csv);
  })
);

// ─────────────────────────────────────────
// EXAM-DAY CONTROLS (teacher only, own tests only)
// POST   /api/tests/:id/attempts/:attemptId/reset    start this student over
// DELETE /api/tests/:id/attempts/:attemptId          remove this attempt completely
// POST   /api/tests/:id/attempts/:attemptId/extend   { minutes } add time to a running attempt
// POST   /api/tests/:id/extend-all                   { minutes } add time to everyone still writing
// ─────────────────────────────────────────

function readMinutes(req: Request, res: Response): number | null {
  const m = Math.floor(Number(req.body?.minutes));
  if (!Number.isFinite(m) || m < 1 || m > MAX_EXTEND_MIN) {
    res.status(400).json({ success: false, error: `Minutes must be between 1 and ${MAX_EXTEND_MIN}.` });
    return null;
  }
  return m;
}

async function ownAttempt(req: Request, res: Response) {
  const test = await ownTestMeta(req, res);
  if (!test) return null;
  const attempt = await prisma.attempt.findFirst({
    where: { id: req.params.attemptId, testId: test.id },
    select: { id: true, status: true, deadlineAt: true },
  });
  if (!attempt) { res.status(404).json({ success: false, error: 'Attempt not found' }); return null; }
  return { test, attempt };
}

router.post(
  '/:id/attempts/:attemptId/reset',
  asyncHandler(async (req: Request, res: Response) => {
    const own = await ownAttempt(req, res);
    if (!own) return;
    await resetAttempt(own.attempt.id, own.test);
    res.json({ success: true });
  })
);

router.delete(
  '/:id/attempts/:attemptId',
  asyncHandler(async (req: Request, res: Response) => {
    const own = await ownAttempt(req, res);
    if (!own) return;
    await prisma.attempt.deleteMany({ where: { id: own.attempt.id, testId: own.test.id } });
    res.json({ success: true });
  })
);

router.post(
  '/:id/attempts/:attemptId/extend',
  asyncHandler(async (req: Request, res: Response) => {
    const minutes = readMinutes(req, res);
    if (minutes === null) return;
    const own = await ownAttempt(req, res);
    if (!own) return;
    // An attempt whose time already ran out counts as submitted, even if the cron has not caught up.
    const closed = await expireIfDue(own.attempt);
    const ok = !closed && (await extendAttempt(own.attempt.id, minutes));
    if (!ok) {
      res.status(409).json({ success: false, error: 'This student has already submitted. Use Reset to let them start over.' });
      return;
    }
    res.json({ success: true });
  })
);

router.post(
  '/:id/extend-all',
  asyncHandler(async (req: Request, res: Response) => {
    const minutes = readMinutes(req, res);
    if (minutes === null) return;
    const test = await ownTestMeta(req, res);
    if (!test) return;
    res.json({ success: true, data: { extended: await extendAllRunning(test.id, minutes) } });
  })
);

export default router;