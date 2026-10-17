// routes/publicTests.ts
// CBT step 2: the routes students use. No login. Mounted at /api/public/tests, before checkSubscription.
//
//   GET  /:code                  test info (never the questions)
//   POST /:code/check            would this name + roll number be allowed to start? (writes nothing)
//   POST /:code/start            start, or resume a running attempt (new token)
//   GET  /attempt                the exam: questions in this student's order + saved answers
//   PUT  /attempt/answers        autosave a few answers
//   POST /attempt/event          how many times the student left the exam screen
//   POST /attempt/submit         send the full answers map and finish
//   GET  /attempt/result         the finished screen
//
// The student's secret is the attempt token, sent as the X-Attempt-Token header. Every JSON reply
// carries serverNow (ms) so the client can correct its clock. The snapshot and isCorrect never leave
// here, except inside resultPayload() after submit and only when the test has showAnswers on.

import { Router, Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../utils/prisma';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  TEST_META, TestMeta, cleanName, rollKey, testState, getExam, startAttempt, checkEntry,
  finalizeAttempt, expireIfDue, attemptPayload, resultPayload, cleanAnswers, writeAnswers, recordTabSwitches,
} from '../services/examService';

const router = Router();

const num = (v: string | undefined, d: number) => {
  const n = parseInt(v || '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

// Their own limiters, far above the global one (100 per 15 min): a classroom shares one IP.
const entryLimiter = rateLimit({
  windowMs: 60_000,
  max: num(process.env.PUBLIC_ENTRY_PER_MIN, 1200), // per IP: info, check, start
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.', code: 'RATE_LIMITED' },
});
// Per test + roll number, on check and start: stops someone trying many names against one roll number.
// Keyed by roll number, not IP, so classmates on the same wifi never share this limit.
const rollLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: num(process.env.PUBLIC_ROLL_PER_5MIN, 20),
  keyGenerator: req => {
    const roll = rollKey(req.body?.rollNo);
    return roll ? `r:${String(req.params.code).toLowerCase()}:${roll}` : `ip:${req.ip}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many tries for this roll number. Wait a few minutes and try again, or ask your teacher.', code: 'RATE_LIMITED' },
});
const attemptTokenLimiter = rateLimit({
  windowMs: 60_000,
  max: num(process.env.PUBLIC_ATTEMPT_PER_MIN, 240), // per student
  keyGenerator: req => `t:${req.header('x-attempt-token') || req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.', code: 'RATE_LIMITED' },
});
const attemptIpLimiter = rateLimit({
  windowMs: 60_000,
  max: num(process.env.PUBLIC_IP_PER_MIN, 6000), // per IP, whole classroom
  keyGenerator: req => `ip:${req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.', code: 'RATE_LIMITED' },
});

function send(res: Response, body: Record<string, unknown>, status = 200) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json({ ...body, serverNow: Date.now() });
}
function fail(res: Response, status: number, code: string, error: string) {
  return send(res, { error, code }, status);
}

const MESSAGES: Record<string, [number, string, string]> = {
  not_open: [403, 'NOT_OPEN', 'This test has not opened yet.'],
  closed: [403, 'CLOSED', 'This test is closed.'],
  ended: [403, 'ENDED', 'This test has ended.'],
  roll_in_use: [409, 'ROLL_IN_USE', 'This roll number is already in use. Ask your teacher.'],
  already_taken: [409, 'ALREADY_TAKEN', 'You have already taken this test.'],
};

async function findTest(code: unknown): Promise<TestMeta | null> {
  const c = String(code ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]{4,16}$/.test(c)) return null;
  return prisma.test.findUnique({ where: { code: c }, select: TEST_META });
}

function readEntry(req: Request): { name: string; roll: string } | { error: string } {
  const name = cleanName(req.body?.name);
  const roll = rollKey(req.body?.rollNo);
  if (name.length < 2 || name.length > 80 || !/^[\p{L}\p{M}0-9 .'’\-]+$/u.test(name)) {
    return { error: 'Please enter your full name (letters only).' };
  }
  if (roll.length < 1 || roll.length > 30 || !/^[A-Z0-9\-_/.]+$/.test(roll)) {
    return { error: 'Please enter a valid roll number (letters, numbers, - / . _ only).' };
  }
  return { name, roll };
}

// ─────────────────────────────────────────
// Before the exam: info, check, start
// ─────────────────────────────────────────

router.post('/:code/check', entryLimiter, rollLimiter, asyncHandler(async (req, res) => {
  const test = await findTest(req.params.code);
  if (!test) return fail(res, 404, 'NOT_FOUND', 'This test link is not valid.');
  const e = readEntry(req);
  if ('error' in e) return fail(res, 400, 'BAD_INPUT', e.error);
  const r = await checkEntry(test, e.name, e.roll);
  if (r === 'ok' || r === 'resume') return send(res, { ok: true, resume: r === 'resume' });
  const [status, code, msg] = MESSAGES[r];
  return fail(res, status, code, msg);
}));

router.post('/:code/start', entryLimiter, rollLimiter, asyncHandler(async (req, res) => {
  const test = await findTest(req.params.code);
  if (!test) return fail(res, 404, 'NOT_FOUND', 'This test link is not valid.');
  const e = readEntry(req);
  if ('error' in e) return fail(res, 400, 'BAD_INPUT', e.error);
  const r = await startAttempt(test, e.name, e.roll);
  if (r.kind === 'created' || r.kind === 'resumed') {
    return send(res, { token: r.token, resumed: r.kind === 'resumed' });
  }
  const [status, code, msg] = MESSAGES[r.kind];
  return fail(res, status, code, msg);
}));

// ─────────────────────────────────────────
// During and after the exam (token required)
// ─────────────────────────────────────────

async function withAttempt(req: Request, res: Response, next: NextFunction) {
  try {
    const token = String(req.header('x-attempt-token') || '');
    if (token.length < 20 || token.length > 100) {
      return fail(res, 401, 'NO_SESSION', 'This session is no longer active. It may have been opened on another device.');
    }
    let attempt = await prisma.attempt.findUnique({ where: { token }, include: { test: { select: TEST_META } } });
    if (!attempt) {
      return fail(res, 401, 'NO_SESSION', 'This session is no longer active. It may have been opened on another device.');
    }
    // Lazy auto-submit: whoever loads, saves or submits after the deadline closes the attempt.
    const closed = await expireIfDue(attempt);
    if (closed) attempt = closed;
    res.locals.attempt = attempt;
    next();
  } catch (err) {
    next(err);
  }
}

const attemptChain = [attemptIpLimiter, attemptTokenLimiter, withAttempt];

router.get('/attempt', ...attemptChain, asyncHandler(async (_req, res) => {
  const a = res.locals.attempt;
  if (a.status === 'SUBMITTED') return send(res, { status: 'SUBMITTED' });
  return send(res, { status: 'IN_PROGRESS', ...(await attemptPayload(a, a.test)) });
}));

router.put('/attempt/answers', ...attemptChain, asyncHandler(async (req, res) => {
  const a = res.locals.attempt;
  if (a.status === 'SUBMITTED') return fail(res, 409, 'SUBMITTED', 'This test has already been submitted.');
  const idx = await getExam(a.test);
  const clean = cleanAnswers(idx, req.body?.answers, 60, a.test.durationMin * 60);
  if (!clean) return fail(res, 400, 'BAD_INPUT', 'Invalid answers.');
  await writeAnswers(a.id, clean);
  return send(res, { ok: true, saved: clean.size, deadlineAt: a.deadlineAt.getTime() });
}));

router.post('/attempt/event', ...attemptChain, asyncHandler(async (req, res) => {
  const a = res.locals.attempt;
  // Also the exam screen's heartbeat: it learns about time extensions and server-side submits from here.
  if (a.status === 'SUBMITTED') return send(res, { ok: true, submitted: true });
  await recordTabSwitches(a.id, req.body?.tabSwitches);
  return send(res, { ok: true, submitted: false, deadlineAt: a.deadlineAt.getTime() });
}));

router.post('/attempt/submit', ...attemptChain, asyncHandler(async (req, res) => {
  let a = res.locals.attempt;
  if (a.status !== 'SUBMITTED') {
    await recordTabSwitches(a.id, req.body?.tabSwitches);
    const done = await finalizeAttempt(a.id, { answers: req.body?.answers });
    if (!done) return fail(res, 404, 'NOT_FOUND', 'Attempt not found.');
    a = done;
  }
  return send(res, await resultPayload(a, a.test));
}));

router.get('/attempt/result', ...attemptChain, asyncHandler(async (_req, res) => {
  const a = res.locals.attempt;
  if (a.status !== 'SUBMITTED') return fail(res, 409, 'NOT_SUBMITTED', 'The test is still in progress.');
  return send(res, await resultPayload(a, a.test));
}));

// Registered last so that GET /attempt is never read as a test code.
router.get('/:code', entryLimiter, asyncHandler(async (req, res) => {
  const test = await findTest(req.params.code);
  if (!test) return fail(res, 404, 'NOT_FOUND', 'This test link is not valid.');
  const idx = await getExam(test);
  return send(res, {
    code: test.code,
    title: test.title,
    instructions: test.instructions,
    institution: idx.examDetails.institutionName || null,
    subject: idx.examDetails.subject || null,
    durationMin: test.durationMin,
    questionCount: test.questionCount,
    totalMarks: test.totalMarks,
    negativeMarks: test.negativeMarks,
    sections: idx.sections.map(s => ({ title: s.title, count: s.questions.length })),
    opensAt: test.opensAt ? test.opensAt.getTime() : null,
    closesAt: test.closesAt ? test.closesAt.getTime() : null,
    state: testState(test),
  });
}));

export default router;