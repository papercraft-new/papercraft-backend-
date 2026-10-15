// services/resultsService.ts
// CBT step 3: the teacher's results and analytics, worked out from the stored answers.
// Only submitted attempts are scored and ranked; running ones are listed separately.

import { prisma } from '../utils/prisma';
import { getExam, type TestMeta } from './examService';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface StudentRow {
  rank: number;
  name: string;
  rollNo: string;
  score: number;
  correct: number;
  wrong: number;
  skipped: number;
  timeTakenSec: number;
  submittedAt: number | null;
  sections: number[]; // score per section, same order as `sections`
  tabSwitches: number; // times the student left the exam screen
}

export interface QuestionStat {
  id: string;
  no: number;
  section: string;
  text: string;
  correct: string;
  marks: number;
  right: number;
  wrong: number;
  skipped: number;
  pctRight: number;
  avgTimeSec: number | null;
  options: Record<string, number>; // how many students picked each option
}

function plain(text: string, max = 160) {
  const s = (text || '').replace(/<[^>]*>/g, ' ').replace(/\$+/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export async function buildResults(test: TestMeta) {
  const idx = await getExam(test);
  const neg = test.negativeMarks;

  const attempts = await prisma.attempt.findMany({
    where: { testId: test.id },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true, name: true, rollNo: true, status: true, startedAt: true, deadlineAt: true, submittedAt: true, tabSwitches: true,
      answers: { select: { questionId: true, selected: true, timeSpentSec: true } },
    },
  });

  const sectionMeta = idx.sections.map((s, si) => ({
    title: s.title,
    questionCount: s.questions.filter(q => idx.byId.has(q.id)).length,
    totalMarks: round2(s.questions.reduce((m, q) => m + (idx.byId.has(q.id) ? q.marks : 0), 0)),
    _si: si,
  }));

  // per-question counters
  const qStats = new Map<string, { right: number; wrong: number; skipped: number; timeSum: number; timeN: number; options: Record<string, number> }>();
  idx.byId.forEach((e, id) => {
    const options: Record<string, number> = {};
    e.q.options.forEach(o => { options[o.label] = 0; });
    qStats.set(id, { right: 0, wrong: 0, skipped: 0, timeSum: 0, timeN: 0, options });
  });

  const rows: Omit<StudentRow, 'rank'>[] = [];
  const stillWriting: Array<{ name: string; rollNo: string; startedAt: number; deadlineAt: number; answered: number }> = [];

  for (const a of attempts) {
    if (a.status !== 'SUBMITTED') {
      stillWriting.push({
        name: a.name, rollNo: a.rollNo, startedAt: a.startedAt.getTime(), deadlineAt: a.deadlineAt.getTime(),
        answered: a.answers.filter(r => r.selected).length,
      });
      continue;
    }
    const chosen = new Map(a.answers.map(r => [r.questionId, r]));
    const sectionScores = idx.sections.map(() => 0);
    let correct = 0, wrong = 0, skipped = 0;

    idx.byId.forEach((e, qid) => {
      const r = chosen.get(qid);
      const st = qStats.get(qid)!;
      if (r && r.timeSpentSec > 0) { st.timeSum += r.timeSpentSec; st.timeN++; }
      if (!r || !r.selected) { skipped++; st.skipped++; return; }
      if (r.selected in st.options) st.options[r.selected]++;
      if (r.selected === e.correct) { correct++; st.right++; sectionScores[e.sectionIdx] += e.q.marks; }
      else { wrong++; st.wrong++; sectionScores[e.sectionIdx] -= neg; }
    });

    const submittedAt = a.submittedAt;
    rows.push({
      name: a.name,
      rollNo: a.rollNo,
      score: round2(sectionScores.reduce((x, y) => x + y, 0)),
      correct, wrong, skipped,
      timeTakenSec: submittedAt ? Math.max(0, Math.round((submittedAt.getTime() - a.startedAt.getTime()) / 1000)) : 0,
      submittedAt: submittedAt ? submittedAt.getTime() : null,
      sections: sectionScores.map(round2),
      tabSwitches: a.tabSwitches,
    });
  }

  // Rank: higher score first, then less time. Same score and same time share a rank (1, 1, 3).
  rows.sort((x, y) => y.score - x.score || x.timeTakenSec - y.timeTakenSec || x.name.localeCompare(y.name));
  const students: StudentRow[] = [];
  rows.forEach((r, i) => {
    const prev = students[i - 1];
    const tie = prev && prev.score === r.score && prev.timeTakenSec === r.timeTakenSec;
    students.push({ ...r, rank: tie ? prev.rank : i + 1 });
  });

  // summary
  const scores = students.map(s => s.score);
  const n = scores.length;
  const sorted = scores.slice().sort((x, y) => x - y);
  const median = n === 0 ? 0 : n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const summary = {
    submitted: n,
    stillWriting: stillWriting.length,
    totalMarks: test.totalMarks,
    average: n ? round2(scores.reduce((x, y) => x + y, 0) / n) : 0,
    highest: n ? sorted[n - 1] : 0,
    lowest: n ? sorted[0] : 0,
    median: round2(median),
    averageTimeSec: n ? Math.round(students.reduce((x, s) => x + s.timeTakenSec, 0) / n) : 0,
  };

  // distribution: share of total marks, 10% steps, plus a bin for negative scores
  const bins = [{ label: 'Below 0', from: -Infinity, to: 0, count: 0 }];
  for (let i = 0; i < 10; i++) bins.push({ label: `${i * 10}–${i * 10 + 10}%`, from: i * 10, to: i * 10 + 10, count: 0 });
  for (const s of students) {
    const pct = test.totalMarks > 0 ? (s.score / test.totalMarks) * 100 : 0;
    if (pct < 0) bins[0].count++;
    else bins[Math.min(10, 1 + Math.floor(pct / 10))].count++; // 100% falls in the last bin
  }

  // per-question table, in paper order
  const questions: QuestionStat[] = [];
  idx.sections.forEach(s => {
    for (const q of s.questions) {
      const e = idx.byId.get(q.id);
      const st = qStats.get(q.id);
      if (!e || !st) continue;
      const answered = st.right + st.wrong;
      questions.push({
        id: q.id,
        no: q.number,
        section: s.title,
        text: plain(e.view.text),
        correct: e.correct,
        marks: q.marks,
        right: st.right,
        wrong: st.wrong,
        skipped: st.skipped,
        pctRight: n ? Math.round((st.right / n) * 100) : 0,
        avgTimeSec: st.timeN ? Math.round(st.timeSum / st.timeN) : null,
        options: st.options,
      });
      void answered;
    }
  });

  return {
    test: {
      id: test.id, code: test.code, title: test.title, totalMarks: test.totalMarks,
      questionCount: test.questionCount, durationMin: test.durationMin, negativeMarks: test.negativeMarks,
      institution: idx.examDetails.institutionName || null, subject: idx.examDetails.subject || null,
    },
    summary,
    sections: sectionMeta.map(({ title, questionCount, totalMarks }, si) => ({
      title, questionCount, totalMarks,
      average: n ? round2(students.reduce((x, s) => x + s.sections[si], 0) / n) : 0,
    })),
    students,
    stillWriting,
    distribution: bins.map(({ label, count }) => ({ label, count })),
    questions,
  };
}

// ── CSV ───────────────────────────────────────────────────────────────

/** Quotes a cell, and stops spreadsheets from running a student-typed name like "=SUM(...)" as a formula. */
function cell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

export function resultsCsv(r: Awaited<ReturnType<typeof buildResults>>): string {
  const head = ['Rank', 'Name', 'Roll No', 'Score', 'Out of', 'Correct', 'Wrong', 'Skipped', 'Time taken (m:ss)', 'Submitted at (UTC)', 'Tab switches', ...r.sections.map(s => `${s.title} score`)];
  const lines = [head.map(cell).join(',')];
  for (const s of r.students) {
    lines.push([
      s.rank, s.name, s.rollNo, s.score, r.test.totalMarks, s.correct, s.wrong, s.skipped,
      mmss(s.timeTakenSec), s.submittedAt ? new Date(s.submittedAt).toISOString() : '', s.tabSwitches, ...s.sections,
    ].map(cell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}