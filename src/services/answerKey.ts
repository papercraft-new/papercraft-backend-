// services/answerKey.ts
// When an uploaded paper comes with an answer key, tick the right options (and fill numerical answers)
// so the teacher does not have to. The extraction returns the key as plain entries; this file matches
// them to the questions by printed number and applies them. It never guesses: an answer that cannot be
// matched with certainty is left alone and reported.

import type { Section, Question } from '../types';

export interface KeyEntry {
  section?: string; // the heading the key groups it under (Physics, Chemistry...), when it has one
  no: number;       // the question number printed in the key
  answer: string;   // exactly what the key prints: "b", "a,c", "12.5", "12 to 13"
  file?: number;    // which uploaded file it was read from, when that file also holds questions
}

export interface KeySummary {
  found: boolean;       // an answer key or printed answers were seen
  entries: number;      // answers read from the key
  ticked: number;       // questions that were ticked or given a numerical answer
  total: number;        // questions that can be ticked (options or numerical)
  notTicked: Array<{ section: string; no: number | null; reason: string }>; // first 60 only
  notTickedCount: number;
  note?: string;
}

const MAX_ENTRIES = 1000;

// ─────────────────────────────────────────
// Reading the key out of the extraction
// ─────────────────────────────────────────

export function cleanKeyEntries(raw: unknown): KeyEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: KeyEntry[] = [];
  for (const e of raw.slice(0, MAX_ENTRIES)) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const no = Math.floor(Number(r.no ?? r.number ?? r.q));
    const answer = String(r.answer ?? r.ans ?? '').trim().slice(0, 40);
    if (!Number.isFinite(no) || no < 1 || no > 5000 || !answer) continue;
    const section = typeof r.section === 'string' && r.section.trim() ? r.section.trim().slice(0, 80) : undefined;
    const file = typeof r.file === 'number' && Number.isFinite(r.file) ? r.file : undefined;
    out.push({ no, answer, ...(section ? { section } : {}), ...(file !== undefined ? { file } : {}) });
  }
  return out;
}

/** The "answerKey" list of an extraction answer (JSON text), cleaned. Empty when there is none. */
export function readKeyEntries(jsonText: string): KeyEntry[] {
  try {
    const a = jsonText.indexOf('{');
    const b = jsonText.lastIndexOf('}');
    if (a < 0 || b <= a) return [];
    return cleanKeyEntries(JSON.parse(jsonText.slice(a, b + 1)).answerKey);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────
// Understanding one answer
// ─────────────────────────────────────────

export type ParsedAnswer =
  | { kind: 'letters'; idx: number[] }                    // option positions, 0 = first option
  | { kind: 'number'; value: number; tolerance?: number }
  | { kind: 'skip'; reason: string }                       // the key has no usable answer here
  | { kind: 'bad'; reason: string };

const round6 = (n: number) => Number(n.toFixed(6));
const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)';

/** optionCount is the number of options on the question, or 0 for a numerical question. */
export function parseAnswer(raw: string, optionCount: number): ParsedAnswer {
  const s = raw.trim().replace(/\u2212/g, '-');
  if (!s || /^(?:bonus|dropped|deleted|cancel+ed|none|n\/?a|nil|[-–—_.?]+)$/i.test(s)) {
    return { kind: 'skip', reason: s ? `the key says "${s}"` : 'the key has no answer for it' };
  }

  if (optionCount >= 2) {
    const letterOf = (i: number) => String.fromCharCode(97 + i);
    // "b", "(b)", "B)", "a,c", "ACD", "(a) and (c)"
    const t = s.toLowerCase().replace(/\b(?:and|&)\b/g, ',').replace(/[()[\].:;\s/,&-]+/g, '');
    let idx: number[] | null = null;
    if (/^[a-h]{1,8}$/.test(t)) idx = Array.from(new Set(t.split('').map(c => c.charCodeAt(0) - 97)));
    else if (/^[1-8]{1,8}$/.test(t)) idx = Array.from(new Set(t.split('').map(c => Number(c) - 1))); // 1-4 for a-d
    else {
      // "b) Speed", "(c) Force", "d - Velocity": a letter, then the option's own text
      const m = s.match(/^\(?([a-hA-H])\s*(?:[).:]|\s[-–—])\s+\S/);
      if (m) idx = [m[1].toLowerCase().charCodeAt(0) - 97];
    }
    if (!idx) return { kind: 'bad', reason: `"${s}" is not an option letter` };
    idx.sort((a, b) => a - b);
    const missing = idx.find(i => i < 0 || i >= optionCount);
    if (missing !== undefined) return { kind: 'bad', reason: `the key says option ${letterOf(missing)}, but the question has only ${optionCount} options` };
    return { kind: 'letters', idx };
  }

  // a numerical question: "12.5", "-3", "12 m/s", or a range "12 to 13"
  const single = s.match(new RegExp(`^(${NUM})\\s*[A-Za-z°%/²³·\\s]*$`));
  if (single) {
    const v = Number(single[1]);
    if (Number.isFinite(v)) return { kind: 'number', value: round6(v) };
  }
  const range = s.match(new RegExp(`^(${NUM})\\s*(?:to|-|–|—|~)\\s*(${NUM})$`, 'i'));
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const a = Math.min(lo, hi);
      const b = Math.max(lo, hi);
      return b === a ? { kind: 'number', value: round6(a) } : { kind: 'number', value: round6((a + b) / 2), tolerance: round6((b - a) / 2) };
    }
  }
  return { kind: 'bad', reason: `"${s}" is not a number` };
}

// ─────────────────────────────────────────
// Matching and applying
// ─────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const sectionMatches = (title: string, label: string) => {
  const a = norm(title);
  const b = norm(label);
  return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));
};

/** Removes the extraction-only fields (printed number, printed answer) from every question. */
export function stripKeyFields(sections: Section[]): Section[] {
  return sections.map(s => ({
    ...s,
    questions: s.questions.map(q => {
      const { sourceNo, answer, sourceFile, ...rest } = q;
      void sourceNo; void answer; void sourceFile;
      return rest as Question;
    }),
  }));
}

export function applyAnswerKey(sections: Section[], entriesIn: KeyEntry[] | undefined): { sections: Section[]; summary: KeySummary } {
  const entries = cleanKeyEntries(entriesIn);
  const found = entries.length > 0 || sections.some(s => s.questions.some(q => !!q.answer));

  // printed numbers that appear in more than one section (1-40 in Physics and again in Chemistry)
  const sectionsOfNo = new Map<number, Set<number>>();
  sections.forEach((s, si) =>
    s.questions.forEach(q => {
      if (q.sourceNo) sectionsOfNo.set(q.sourceNo, (sectionsOfNo.get(q.sourceNo) || new Set()).add(si));
    })
  );
  const repeats = (n: number) => (sectionsOfNo.get(n)?.size ?? 0) > 1;

  const notTicked: KeySummary['notTicked'] = [];
  let ticked = 0;
  let total = 0;
  let ambiguousSkipped = 0;

  const out = sections.map(s => ({
    ...s,
    questions: s.questions.map((orig, qi) => {
      const { sourceNo, answer: printed, sourceFile, ...rest } = orig;
      let q = rest as Question;
      const optionCount = q.options?.length ?? 0;
      const hasOptions = optionCount >= 2;
      const isNumerical = q.type === 'NUMERICAL' && !hasOptions;
      if (!hasOptions && !isNumerical) return q; // nothing to tick on this kind of question
      total++;
      if (!found) return q;

      const skip = (reason: string) => { notTicked.push({ section: s.title, no: sourceNo ?? qi + 1, reason }); return q; };

      // 1. which answer belongs to this question?
      let raw = printed;
      if (!raw) {
        if (!sourceNo) return skip('its printed number could not be read');
        const sameNo = entries.filter(e => e.no === sourceNo);
        // strongest first: a key entry that names this section, then the key that came in the same file
        const labelled = sameNo.filter(e => e.section && sectionMatches(s.title, e.section));
        const local = sourceFile === undefined ? [] : sameNo.filter(e => !e.section && e.file === sourceFile);
        const answersOf = (list: KeyEntry[]) => Array.from(new Set(list.map(e => e.answer.trim().toLowerCase())));
        if (labelled.length && local.length && answersOf([...labelled, ...local]).length > 1) return skip('two answer keys give different answers for it');
        let pool: KeyEntry[];
        if (labelled.length) pool = labelled;
        else if (local.length) pool = local;
        else if (repeats(sourceNo)) { ambiguousSkipped++; return skip('question numbers repeat in several sections and the key does not say which section this is'); }
        else pool = sameNo;
        const distinct = answersOf(pool);
        if (distinct.length === 0) return skip('it is not in the answer key');
        if (distinct.length > 1) return skip('the key gives different answers for it');
        raw = pool[0].answer;
      }

      // 2. what does that answer mean for this question?
      const p = parseAnswer(raw, hasOptions ? optionCount : 0);
      if (p.kind === 'skip' || p.kind === 'bad') return skip(p.reason);

      if (p.kind === 'letters') {
        q = {
          ...q,
          options: q.options!.map((o, i) => ({ ...o, isCorrect: p.idx.includes(i) })),
          ...(p.idx.length > 1 ? { multi: true } : {}),
        };
        ticked++;
        return q;
      }
      // a number
      if (!isNumerical) return skip('the key gives a number, but this question has options');
      q = { ...q, numeric: { answer: String(p.value), ...(p.tolerance ? { tolerance: String(p.tolerance) } : {}) } };
      ticked++;
      return q;
    }),
  }));

  let note: string | undefined;
  if (found && total > 0 && ticked === 0) note = 'An answer key was found, but none of its answers could be matched to the questions.';
  else if (ambiguousSkipped > 0) note = 'Question numbers repeat in several sections and the key does not name the sections, so those answers were not matched.';

  return {
    sections: out,
    summary: {
      found,
      entries: entries.length,
      ticked,
      total,
      notTicked: notTicked.slice(0, 60),
      notTickedCount: notTicked.length,
      ...(note ? { note } : {}),
    },
  };
}