// ─────────────────────────────────────────────────────────────────────────────
// SHARED PAPER RENDERER  —  single source of truth for how a paper looks as HTML
// ─────────────────────────────────────────────────────────────────────────────
// Used by: builder preview, builder PDF export, My Papers PDF export and the
// /dashboard/preview page (all HTML output), and by the backend's DOCX builder
// for its option / question-text normalisation.
//
// THIS FILE EXISTS IN TWO REPOS AND THE TWO COPIES MUST BE IDENTICAL:
//   frontend:  src/lib/paperRenderer.ts        (edit it here first)
//   backend:   src/services/paperRenderer.ts   (copy it over)
// Run `npm run check:renderer` in either repo to verify the copies match.
//
// Rules for this file: no imports, no DOM / Node APIs, only optional fields on
// the input types — so saved papers keep rendering exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

// ── Input types (structural; the app's own Section/Question/ExamDetails fit) ──

import katex from 'katex';

/** An image attached to a question or to one option. Every field except `url` is optional. */
export interface RenderImage {
  url: string;
  /** Unique within the paper (React key, and how the editor removes one image). */
  id: string;
  /** Natural pixel size, if known: used to cap very tall images without distorting them. */
  width?: number;
  height?: number;
  /** Print size: small / medium (default) / large / full width. */
  size?: 'small' | 'medium' | 'large' | 'full';
  alt?: string;
}

export type CleanOption = { label: string; text: string; isCorrect: boolean; image?: RenderImage };
/** Alias kept so existing code that says MCQOption keeps compiling. */
export type MCQOption = CleanOption;

/** A grid of plain-text cells shown under a question's text. Every field except `rows` is optional. */
export interface RenderTable {
  id?: string;
  rows: string[][];
  /** First row is a header (bold, shaded, repeated if the table runs onto a new page). Default true. */
  headerRow?: boolean;
}

/** Match the following: two columns, items numbered 1. 2. 3. on the left and lettered (a) (b) (c) on the right. */
export interface RenderMatch {
  /** Column headings. Absent = "Column A" / "Column B"; an empty string = no heading. */
  leftTitle?: string;
  rightTitle?: string;
  left: string[];
  right: string[];
  /** A "(      )" after each left item to write the matching letter in. Default true. */
  answerBox?: boolean;
}

export interface RenderQuestion {
  type: string;
  number: number | string;
  text: string;
  options?: Array<{ label: string; text: string; isCorrect?: boolean; image?: RenderImage }>;
  /** Images shown under the question text. */
  images?: RenderImage[];
  /** Tables shown under the question text (above the images). */
  tables?: RenderTable[];
  /** Columns of a match-the-following question (used when type is MATCH_FOLLOWING). */
  match?: RenderMatch;
}

export interface RenderSection {
  title: string;
  description?: string;
  marksPerQuestion?: number;
  totalMarks?: number;
  questions: RenderQuestion[];
}

export interface RenderExamDetails {
  institutionName?: string;
  institutionAddress?: string;
  subject?: string;
  class?: string;
  examType?: string;
  date?: string;
  duration?: string;
  totalMarks?: number;
  department?: string;
  facultyName?: string;
  instructions?: string[];
  /** 'none' = no blank answer lines after calculation-type questions. Absent (older papers) = 2 lines. */
  answerLines?: string;
}

export interface RenderPaper {
  /** Paper title (used by the Worksheet heading and the <title> tag). */
  title?: string;
  /** Computed total marks; falls back to examDetails.totalMarks. */
  totalMarks?: number;
  examDetails: RenderExamDetails;
  sections: RenderSection[];
}

export interface BuildHtmlOptions {
  /** Append the window.print() script (desktop print flow). Preview: leave off. */
  autoPrint?: boolean;
}

// ── MCQ option normalisation ──────────────────────────────────────────────────

export function splitOptions(text: string): { questionText: string; options: CleanOption[] } {
  const options: CleanOption[] = [];
  if (!text?.trim()) return { questionText: '', options: [] };
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  const p1 = /\(([abcdABCD])\)\s*(.*?)(?=\s*\([abcdABCD]\)\s*|\s*$)/gi;
  const p2 = /\b([abcdABCD])\)\s*(.*?)(?=\s+[abcdABCD]\)\s*|\s*$)/g;
  const p3 = /\b([ABCD])\.\s*(.*?)(?=\s+[ABCD]\.\s*|\s*$)/g;
  let matches: RegExpMatchArray[] = [];
  let usedPattern = 0;
  matches = [...normalizedText.matchAll(p1)];
  if (matches.length >= 2) usedPattern = 1;
  if (matches.length < 2) {
    matches = [...normalizedText.matchAll(p2)];
    if (matches.length >= 2) usedPattern = 2;
  }
  if (matches.length < 2) {
    matches = [...normalizedText.matchAll(p3)];
    if (matches.length >= 2) usedPattern = 3;
  }
  if (matches.length < 2) return { questionText: text.trim(), options: [] };
  for (const m of matches) {
    const label = m[1].toLowerCase();
    const optText = m[2]
      .trim()
      .replace(/\s*\([abcdABCD]\)\s*$/, '')
      .replace(/\s+[abcdABCD]\)\s*$/, '')
      .replace(/\s+[ABCD]\.\s*$/, '')
      .trim();
    if (!options.find(o => o.label === label) && optText) {
      options.push({ label, text: optText, isCorrect: false });
    }
  }
  let questionText = normalizedText;
  if (usedPattern === 1) {
    const idx = normalizedText.search(/\s*\([abcdABCD]\)/i);
    if (idx > 0) questionText = normalizedText.substring(0, idx).trim();
  } else if (usedPattern === 2) {
    const idx = normalizedText.search(/\s+[abcdABCD]\)/);
    if (idx > 0) questionText = normalizedText.substring(0, idx).trim();
  } else if (usedPattern === 3) {
    const idx = normalizedText.search(/\s+[ABCD]\./);
    if (idx > 0) questionText = normalizedText.substring(0, idx).trim();
  }
  questionText = questionText.replace(/[\[(]\d+\s*(?:marks?)?[\])]/gi, '').trim();
  return { questionText, options };
}

export function normalizeOptions(
  rawOptions: Array<{ label: string; text: string; isCorrect?: boolean; image?: RenderImage }> | undefined,
  questionText: string
): { cleanedQuestionText: string; fixedOptions: CleanOption[] } {
  let fixedOptions: CleanOption[] = rawOptions
    ? rawOptions.map(o => ({
        label: (o.label || '').toLowerCase(),
        text: o.text || '',
        isCorrect: o.isCorrect ?? false,
        ...(o.image ? { image: o.image } : {}),
      }))
    : [];
  let cleanedQuestionText = questionText || '';

  if (fixedOptions.length === 1 && fixedOptions[0].text.trim().length > 20 && !fixedOptions[0].image) {
    const s = splitOptions(fixedOptions[0].text);
    if (s.options.length >= 2) fixedOptions = s.options;
  }
  if (fixedOptions.length === 2 && !fixedOptions.some(o => o.image)) {
    const combined = fixedOptions.map(o => `(${o.label}) ${o.text}`).join(' ');
    const s = splitOptions(combined);
    if (s.options.length >= 3) fixedOptions = s.options;
  }
  if (fixedOptions.length === 0 && cleanedQuestionText) {
    const s = splitOptions(cleanedQuestionText);
    if (s.options.length >= 2) {
      cleanedQuestionText = s.questionText;
      fixedOptions = s.options;
    }
  }
  if (fixedOptions.length >= 2 && cleanedQuestionText) {
    const hasInline = /\([abcd]\)|\b[A-D]\./i.test(cleanedQuestionText);
    if (hasInline) {
      const s = splitOptions(cleanedQuestionText);
      if (s.options.length >= 2) {
        cleanedQuestionText = s.questionText;
        s.options.forEach(opt => {
          if (!fixedOptions.find(o => o.label === opt.label)) fixedOptions.push(opt);
        });
      }
    }
  }
  fixedOptions = fixedOptions
    .map(opt => ({
      ...opt,
      label: opt.label.toLowerCase(),
      text: opt.text
        .replace(/\s*\([abcdABCD]\)\s*.*$/i, '')
        .replace(/\s+[abcdABCD]\)\s*.*$/i, '')
        .replace(/\s+[ABCD]\.\s*.*$/i, '')
        .replace(/[\[(]\d+\s*(?:marks?)?[\])]/gi, '')
        .trim(),
    }))
    .filter(opt => opt.text.length > 0 || !!opt.image?.url); // an option may be image-only

  const seen = new Set<string>();
  fixedOptions = fixedOptions.filter(opt => {
    if (!opt.label || seen.has(opt.label)) return false;
    seen.add(opt.label);
    return true;
  });

  fixedOptions.sort((a, b) => a.label.localeCompare(b.label));
  return { cleanedQuestionText, fixedOptions };
}

// ── Layout helpers (earlier fixes live here) ──────────────────────────────────

/**
 * MCQ option width by the longest option (HTML stripped):
 * short (<=12 chars) -> 4 per row, medium (<=30) -> 2 per row, long -> 1 per row.
 */
export function mcqOptionWidth(options: Array<{ text: string; image?: unknown }>): '25%' | '50%' | '100%' {
  const maxLen = Math.max(...options.map(x => String(x.text || '').replace(/<[^>]*>/g, '').length));
  const w = maxLen <= 12 ? '25%' : maxLen <= 30 ? '50%' : '100%';
  // Options that carry an image need room: at most 2 per row.
  return w === '25%' && options.some(x => !!x.image) ? '50%' : w;
}

/** Fill-in-the-blank: put the blank inline unless the text already has one. */
export function withBlank(type: string, text: string): string {
  return type === 'FILL_IN_BLANK' && !/_{3,}/.test(text) ? `${text} ________________` : text;
}

// ── CSS per template (kept identical to the previous PDF-export CSS) ──────────

const defaultCss = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Times New Roman',serif;font-size:13px;color:#111;background:#fff;line-height:1.4}.paper-wrap{padding:18mm;width:210mm;margin:0 auto;min-height:297mm;position:relative}.header{text-align:center;margin-bottom:8px}.inst-name{font-size:22px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#1a2e5a}.inst-addr{font-size:12px;color:#555;margin-top:2px}.thick-div{border-top:2px solid #1a2e5a;margin:7px 0}.thin-div{border-top:1px solid #1a2e5a;margin:5px 0}.meta-table{width:100%;border-collapse:collapse;font-size:14.5px;margin:4px 0}.meta-table td{padding:2px 0}.paper-title{text-align:center;font-size:15px;font-weight:bold;text-transform:uppercase;letter-spacing:2px;color:#1a2e5a;margin:5px 0;text-decoration:underline}.instructions{font-size:14px;margin-bottom:6px}.inst-title{font-weight:bold;text-decoration:underline;margin-bottom:3px}.instructions ol{padding-left:18px;line-height:1.4}.section{margin-bottom:10px}.section-header{text-align:center;border:1px solid #1a2e5a;padding:4px 8px;font-weight:bold;font-size:15px;text-transform:uppercase;color:#1a2e5a;background:#f0f4ff;margin:10px 0 8px}.section-marks{font-size:13px;font-weight:normal}.section-desc{text-align:center;font-size:13px;color:#555;font-style:italic;margin-bottom:6px}.question{margin-bottom:8px;page-break-inside:avoid;break-inside:avoid}.q-row{overflow:hidden}.q-num{font-weight:bold;float:left;width:22px;padding-top:1px}.q-text{display:block;margin-left:28px;line-height:1.4;font-size:13px}.q-marks{font-weight:bold;font-size:13px;color:#1a2e5a;min-width:28px;text-align:right;flex-shrink:0;padding-top:1px}.mcq-options{margin-top:5px;margin-left:28px}.mcq-option{display:inline-block;width:47%;vertical-align:top;font-size:13px;margin-bottom:4px}.opt-label{font-weight:bold;display:inline-block;min-width:20px}.tf-options{margin-top:5px;margin-left:28px}.tf-options span{display:inline-block;margin-right:24px}.fill-line{border-bottom:1px solid #bbb;height:16px;width:60%;margin-left:28px;margin-top:4px}.answer-line{border-bottom:1px solid #ddd;height:16px;margin:4px 0 4px 28px}@media print{body{margin:0;font-size:11pt;line-height:1.4}.paper-wrap{padding:14mm;width:auto}.q-text{font-size:12pt!important}.mcq-option,.mcq-opt-inline,.mcq-options-inline,.tf-options{font-size:11pt!important}.q-num{font-size:12pt!important}.question{page-break-inside:avoid}}`;

const classicCss = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Times New Roman',serif;font-size:13px;color:#111;background:#fff;line-height:1.4}.paper-wrap{padding:18mm;width:210mm;margin:0 auto;min-height:297mm}.inst-name{text-align:center;font-size:22px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#111;margin-bottom:4px}.classic-meta-row{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-size:13px;padding-bottom:6px;border-bottom:1px solid #888;margin-bottom:6px}.thin-div{border-top:1px solid #555;margin:5px 0}.paper-title{text-align:center;font-size:15px;font-weight:bold;text-transform:uppercase;letter-spacing:2px;color:#111;margin:5px 0}.instructions{font-size:14px;margin-bottom:6px}.inst-title{font-weight:bold;text-decoration:underline;margin-bottom:3px}.instructions ol{padding-left:18px;line-height:1.4}.section{margin-bottom:10px}.section-header{text-align:center;border:1px solid #333;padding:4px 8px;font-weight:bold;font-size:15px;text-transform:uppercase;color:#111;background:#f5f5f5;margin:10px 0 8px}.section-marks{font-size:13px;font-weight:normal}.section-desc{text-align:center;font-size:13px;color:#555;font-style:italic;margin-bottom:6px}.question{margin-bottom:8px;page-break-inside:avoid;break-inside:avoid}.q-row{overflow:hidden}.q-num{font-weight:bold;float:left;width:22px;padding-top:1px}.q-text{display:block;margin-left:28px;line-height:1.4;font-size:13px}.q-marks{font-weight:bold;font-size:13px;color:#111;min-width:28px;text-align:right;flex-shrink:0;padding-top:1px}.mcq-options-inline{margin-top:5px;margin-left:28px;font-size:13px}.mcq-opt-inline{display:inline-block;width:24%;vertical-align:top;white-space:nowrap}.opt-label{font-weight:bold;margin-right:4px}.tf-options{margin-top:5px;margin-left:28px}.tf-options span{display:inline-block;margin-right:24px}.fill-line{border-bottom:1px solid #bbb;height:16px;width:60%;margin-left:28px;margin-top:4px}.answer-line{border-bottom:1px solid #ddd;height:16px;margin:4px 0 4px 28px}@media print{body{margin:0;font-size:11pt;line-height:1.4}.paper-wrap{padding:14mm;width:auto}.q-text{font-size:12pt!important}.mcq-option,.mcq-opt-inline,.mcq-options-inline,.tf-options{font-size:11pt!important}.q-num{font-size:12pt!important}.question{page-break-inside:avoid}}`;

const worksheetCss = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Calibri',sans-serif;font-size:12px;color:#111;background:#fff;line-height:1.4}.paper-wrap{padding:14mm;width:210mm;margin:0 auto;min-height:297mm}.ws-title{text-align:center;font-size:16px;font-weight:bold;text-transform:uppercase;color:#1F2937;margin-bottom:6px;letter-spacing:1px}.ws-name-row{display:flex;justify-content:space-between;font-size:10px;padding:4px 0;border-top:1px solid #1F2937;border-bottom:1px solid #1F2937;margin-bottom:8px}.section{margin-bottom:4px}.section-header{text-align:center;border:1px solid #1F2937;padding:2px 6px;font-weight:bold;font-size:10px;text-transform:uppercase;color:#1F2937;background:#F3F4F6;margin:4px 0}.section-marks{font-size:9px;font-weight:normal}.question{margin-bottom:4px;page-break-inside:avoid;break-inside:avoid}.q-row{overflow:hidden}.q-num{font-weight:bold;float:left;width:18px}.q-text{display:block;margin-left:22px;line-height:1.4;font-size:13px}.mcq-options-inline{margin-top:4px;margin-left:22px;font-size:13px}.mcq-opt-inline{display:inline-block;width:24%;vertical-align:top;white-space:nowrap}.opt-label{font-weight:bold;margin-right:4px}.tf-options{margin-top:5px;margin-left:22px}.tf-options span{display:inline-block;margin-right:16px}.fill-line{border-bottom:1px solid #bbb;height:16px;width:55%;margin-left:22px;margin-top:4px}.answer-line{border-bottom:1px solid #ddd;height:14px;margin:2px 0 2px 22px}.ws-footer{text-align:right;font-size:9px;color:#666;border-top:1px solid #ddd;margin-top:8px;padding-top:4px}@media print{body{margin:0;font-size:10pt;line-height:1.4}.paper-wrap{padding:10mm;width:auto}.q-text{font-size:11pt!important}.mcq-opt-inline,.mcq-options-inline,.tf-options{font-size:10pt!important}.q-num{font-size:11pt!important}.question{page-break-inside:avoid}}`;

const professionalCss = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Arial',sans-serif;font-size:13px;color:#111;background:#fff;line-height:1.4}.paper-wrap{padding:18mm;width:210mm;margin:0 auto;min-height:297mm}.pro-header{display:flex;align-items:stretch;gap:14px;margin-bottom:10px}.pro-logo{width:80px;height:80px;border-radius:50%;border:2px solid #1F2937;display:flex;align-items:center;justify-content:center;flex-shrink:0}.pro-logo-inner{font-size:10px;color:#aaa;text-align:center;line-height:1.3}.pro-info{flex:1;border:2px solid #1F2937;border-radius:4px;overflow:hidden}.pro-info-name{font-weight:bold;font-size:16px;color:#fff;text-transform:uppercase;letter-spacing:0.5px;background:#1F2937;padding:7px 12px}.pro-info-divider{height:1px;background:#e5e7eb}.pro-info-line{font-size:10.5px;color:#333;padding:3px 12px;line-height:1.6}.pro-meta-row{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;font-size:11px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;padding:6px 10px;margin-bottom:8px}.thin-div{border-top:1px solid #1F2937;margin:6px 0}.paper-title{text-align:center;font-size:15px;font-weight:bold;text-transform:uppercase;color:#1F2937;margin:8px 0 6px;text-decoration:underline;letter-spacing:2px}.section{margin-bottom:10px}.section-header{text-align:center;border:1px solid #1F2937;padding:4px 8px;font-weight:bold;font-size:12px;text-transform:uppercase;color:#1F2937;background:#f0f4ff;margin:10px 0 8px}.section-marks{font-size:10px;font-weight:normal}.question{margin-bottom:8px;page-break-inside:avoid;break-inside:avoid}.q-row{overflow:hidden}.q-num{font-weight:bold;float:left;width:22px}.q-text{display:block;margin-left:28px;line-height:1.4;font-size:13px}.mcq-options{margin-top:5px;margin-left:28px}.mcq-option{display:inline-block;width:47%;vertical-align:top;font-size:13px;margin-bottom:4px}.mcq-opt-inline{display:inline-block;width:24%;vertical-align:top;white-space:nowrap}.opt-label{font-weight:bold;margin-right:4px}.tf-options{margin-top:5px;margin-left:28px}.tf-options span{display:inline-block;margin-right:24px}.fill-line{border-bottom:1px solid #bbb;height:16px;width:60%;margin-left:28px;margin-top:4px}.answer-line{border-bottom:1px solid #ddd;height:16px;margin:4px 0 4px 28px}.sig-block{margin-top:30px;display:flex;justify-content:space-between}.sig-line{text-align:center;width:30%}.sig-line div{border-top:1px solid #999;padding-top:5px;font-size:10px;color:#555}@media print{body{margin:0;font-size:11pt;line-height:1.4}.paper-wrap{padding:14mm;width:auto}.q-text{font-size:12pt!important}.mcq-option,.mcq-opt-inline,.mcq-options-inline,.tf-options{font-size:11pt!important}.q-num{font-size:12pt!important}.question{page-break-inside:avoid}}`;

// ── Images ────────────────────────────────────────────────────────────────────
// Images use inline styles only (no extra CSS), so a paper without images produces
// exactly the same HTML as before.

/** Limits enforced by the editor and by the API (same numbers on both sides). */
export const IMAGE_LIMITS = { perQuestion: 5, perPaper: 100 } as const;

/** Question images + option images across the whole paper. */
export function countPaperImages(sections: RenderSection[] | undefined): number {
  let n = 0;
  for (const s of Array.isArray(sections) ? sections : []) {
    for (const q of Array.isArray(s?.questions) ? s.questions : []) {
      if (Array.isArray(q?.images)) n += q.images.length;
      if (Array.isArray(q?.options)) for (const o of q.options) if (o?.image) n++;
    }
  }
  return n;
}

/** null when the paper is within the limits, otherwise a message fit to show the teacher. */
export function getImageLimitProblem(sections: RenderSection[] | undefined): string | null {
  for (const s of Array.isArray(sections) ? sections : []) {
    for (const q of Array.isArray(s?.questions) ? s.questions : []) {
      if (Array.isArray(q?.images) && q.images.length > IMAGE_LIMITS.perQuestion) {
        return `Question ${q.number} has more than ${IMAGE_LIMITS.perQuestion} images.`;
      }
    }
  }
  const total = countPaperImages(sections);
  if (total > IMAGE_LIMITS.perPaper) {
    return `A paper can have at most ${IMAGE_LIMITS.perPaper} images (this one has ${total}).`;
  }
  return null;
}

// ── Tables ────────────────────────────────────────────────────────────────────
// Like images, tables use inline styles only, so a paper without tables produces exactly the
// same HTML as before.

export const TABLE_LIMITS = { perQuestion: 3, maxRows: 20, maxCols: 8, maxCellChars: 300 } as const;

/** The table as clean text: cells forced to strings, every row padded to the widest row. */
export function tableGrid(t: RenderTable | undefined): string[][] {
  const rows = Array.isArray(t?.rows) ? (t as RenderTable).rows : [];
  const clean = rows
    .filter(r => Array.isArray(r))
    .map(r => r.map(c => (typeof c === 'string' ? c : c == null ? '' : String(c))));
  const cols = clean.reduce((m, r) => Math.max(m, r.length), 0);
  return clean.map(r => (r.length < cols ? r.concat(Array(cols - r.length).fill('')) : r));
}

/** Whether the first row is a header (default yes). */
export function tableHasHeader(t: RenderTable | undefined): boolean {
  return t?.headerRow !== false;
}

/** Column widths in percent (they add up to 100): wider for longer text, never below 8%. */
export function tableColumnPercents(grid: string[][]): number[] {
  const cols = grid[0]?.length || 0;
  if (!cols) return [];
  const weights = Array.from({ length: cols }, (_, c) => {
    let longest = 0;
    for (const r of grid) for (const line of (r[c] || '').split('\n')) longest = Math.max(longest, line.length);
    return Math.min(40, Math.max(6, longest));
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map(w => (w / total) * 100);
  const min = Math.min(8, 100 / cols);
  const small = raw.map(p => p < min);
  const fixed = small.filter(Boolean).length * min;
  const rest = raw.reduce((sum, p, i) => (small[i] ? sum : sum + p), 0);
  return raw.map((p, i) => Math.round((small[i] ? min : (p / rest) * (100 - fixed)) * 10) / 10);
}

/** null when every table is within the limits, otherwise a message fit to show the teacher. */
export function getTableLimitProblem(sections: RenderSection[] | undefined): string | null {
  for (const s of Array.isArray(sections) ? sections : []) {
    for (const q of Array.isArray(s?.questions) ? s.questions : []) {
      if (!Array.isArray(q?.tables)) continue;
      if (q.tables.length > TABLE_LIMITS.perQuestion) {
        return `Question ${q.number} has more than ${TABLE_LIMITS.perQuestion} tables.`;
      }
      for (const t of q.tables) {
        const grid = tableGrid(t);
        if (grid.length > TABLE_LIMITS.maxRows) {
          return `A table in question ${q.number} has more than ${TABLE_LIMITS.maxRows} rows.`;
        }
        if ((grid[0]?.length || 0) > TABLE_LIMITS.maxCols) {
          return `A table in question ${q.number} has more than ${TABLE_LIMITS.maxCols} columns.`;
        }
        if (grid.some(r => r.some(c => c.length > TABLE_LIMITS.maxCellChars))) {
          return `A table cell in question ${q.number} is longer than ${TABLE_LIMITS.maxCellChars} characters.`;
        }
      }
    }
  }
  return null;
}

const CONTENT_MM = 180; // printable width of the paper, a little under the real value on purpose
export const QUESTION_IMAGE_PCT = { small: 30, medium: 48, large: 75, full: 100 } as const; // % of the question block
export const OPTION_IMAGE_PCT = { small: 45, medium: 70, large: 100, full: 100 } as const; // % of the option box

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An escaped src for an <img>, or '' when the URL is not a normal web or image data URL. */
function safeImageSrc(url: unknown): string {
  if (typeof url !== 'string') return '';
  const u = url.trim();
  const ok = /^https?:\/\//i.test(u) || /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(u);
  return ok ? escAttr(u) : '';
}

/**
 * Width (% of its container) for an image: the chosen size, but never so large that the
 * image would be taller than maxHeightMm. Width and height shrink together, so the image is
 * never distorted. Without known pixel dimensions only the chosen size applies.
 */
export function imageWidthPct(img: RenderImage, basePct: number, containerMm: number, maxHeightMm: number): number {
  let pct = basePct;
  if (img.width && img.height && img.width > 0 && img.height > 0) {
    const capPct = (maxHeightMm / (containerMm * (img.height / img.width))) * 100;
    if (capPct < pct) pct = capPct;
  }
  return Math.max(8, Math.round(pct * 10) / 10);
}

/** The images under a question's text, flowing side by side and wrapping. */
function renderQuestionImages(images: RenderImage[] | undefined, indentPx: number): string {
  if (!Array.isArray(images)) return '';
  const blockMm = CONTENT_MM - indentPx * 0.2646;
  const items = images
    .map(img => {
      const src = safeImageSrc(img?.url);
      if (!src) return '';
      const pct = imageWidthPct(img, QUESTION_IMAGE_PCT[img.size || 'medium'] ?? QUESTION_IMAGE_PCT.medium, blockMm, 110);
      return `<img src="${src}" alt="${escAttr(img.alt || '')}" style="display:block;width:${pct}%;height:auto;max-width:100%;flex:0 0 auto;page-break-inside:avoid">`;
    })
    .join('');
  return items
    ? `<div class="q-images" style="display:flex;flex-wrap:wrap;gap:8px 12px;align-items:flex-start;margin:6px 0 2px ${indentPx}px">${items}</div>`
    : '';
}

/** The tables under a question's text: full block width, thin borders, bold shaded header row. */
function renderQuestionTables(tables: RenderTable[] | undefined, indentPx: number): string {
  if (!Array.isArray(tables)) return '';
  return tables
    .map(t => {
      const grid = tableGrid(t);
      if (!grid.length || !grid[0].length) return '';
      const pcts = tableColumnPercents(grid);
      const cellBase =
        'border:1px solid #333;padding:3px 6px;vertical-align:top;text-align:left;overflow-wrap:anywhere;word-break:break-word';
      const headBase = `${cellBase};font-weight:bold;background:#eeeeee`;
      const row = (cells: string[], head: boolean) =>
        `<tr style="page-break-inside:avoid;break-inside:avoid">${cells
          .map(c => `<${head ? 'th' : 'td'} style="${head ? headBase : cellBase}">${mathToHtml(c, escAttr).replace(/\n/g, '<br>')}</${head ? 'th' : 'td'}>`)
          .join('')}</tr>`;
      const hasHead = tableHasHeader(t);
      const thead = hasHead ? `<thead style="display:table-header-group">${row(grid[0], true)}</thead>` : '';
      const body = grid
        .slice(hasHead ? 1 : 0)
        .map(r => row(r, false))
        .join('');
      return `<table class="q-table" style="border-collapse:collapse;table-layout:fixed;width:calc(100% - ${indentPx}px);margin:6px 0 4px ${indentPx}px;font-size:inherit"><colgroup>${pcts
        .map(p => `<col style="width:${p}%">`)
        .join('')}</colgroup>${thead}<tbody>${body}</tbody></table>`;
    })
    .join('');
}

// ── Match the following ───────────────────────────────────────────────────────

export const MATCH_LIMITS = { maxItems: 10, maxChars: 200 } as const;

export interface MatchColumns {
  left: string[];
  right: string[];
  rows: number;
  leftTitle: string;
  rightTitle: string;
  answerBox: boolean;
}

/** The match columns as clean text with the defaults filled in; null when there is nothing to show. */
export function matchColumns(m: RenderMatch | undefined): MatchColumns | null {
  if (!m || typeof m !== 'object') return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const clean = (a: unknown) => {
    const items = (Array.isArray(a) ? a : []).map(text);
    while (items.length && !items[items.length - 1].trim()) items.pop(); // empty items at the end are not shown
    return items;
  };
  const left = clean(m.left);
  const right = clean(m.right);
  const rows = Math.max(left.length, right.length);
  if (!rows) return null;
  return {
    left,
    right,
    rows,
    leftTitle: m.leftTitle === undefined ? 'Column A' : text(m.leftTitle),
    rightTitle: m.rightTitle === undefined ? 'Column B' : text(m.rightTitle),
    answerBox: m.answerBox !== false,
  };
}

/** a, b, c ... for the right-hand column. */
export const matchLetter = (i: number): string => String.fromCharCode(97 + (i % 26));

/** null when every match question is within the limits, otherwise a message fit to show the teacher. */
export function getMatchLimitProblem(sections: RenderSection[] | undefined): string | null {
  for (const s of Array.isArray(sections) ? sections : []) {
    for (const q of Array.isArray(s?.questions) ? s.questions : []) {
      const m = q?.match;
      if (!m || typeof m !== 'object') continue;
      for (const col of [m.left, m.right]) {
        const items = Array.isArray(col) ? col : [];
        if (items.length > MATCH_LIMITS.maxItems) {
          return `A column in question ${q.number} has more than ${MATCH_LIMITS.maxItems} items.`;
        }
        if (items.some(v => typeof v === 'string' && v.length > MATCH_LIMITS.maxChars)) {
          return `An item in question ${q.number} is longer than ${MATCH_LIMITS.maxChars} characters.`;
        }
      }
    }
  }
  return null;
}

// ── Equations ─────────────────────────────────────────────────────────────────
// LaTeX lives inside the normal text fields: $x^2$ is inline, $$x^2$$ is a display equation,
// \$ is a literal dollar sign. Nothing is stored beyond the text, so saved papers keep working,
// and text without a "$" produces exactly the same HTML as before.

export const MATH_LIMITS = { maxChars: 500, perPaper: 300 } as const;
export const KATEX_VERSION = '0.16.11';
export const KATEX_CSS_URL = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css`;

export type MathPart =
  | { kind: 'text'; text: string }
  | { kind: 'math'; latex: string; display: boolean };

/**
 * Splits text into plain text and equations. "$5 and $10" stays plain text: an opening $ must
 * be followed by a non-space, a closing $ must not follow a space and must not be followed by a digit.
 */
export function splitMath(text: string): MathPart[] {
  const out: MathPart[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '$') {
      buf += '$';
      i += 2;
      continue;
    }
    if (ch === '$') {
      if (text[i + 1] === '$') {
        const end = text.indexOf('$$', i + 2);
        const body = end > i + 2 ? text.slice(i + 2, end).trim() : '';
        if (end !== -1 && body && body.length <= MATH_LIMITS.maxChars) {
          flush();
          out.push({ kind: 'math', latex: body, display: true });
          i = end + 2;
          continue;
        }
      } else if (i + 1 < n && !/\s/.test(text[i + 1])) {
        let found = -1;
        for (let j = i + 1; j < n && j - i <= MATH_LIMITS.maxChars + 1; j++) {
          const c = text[j];
          if (c === '\\') { j++; continue; }
          if (c === '\n') break;
          if (c === '$' && j > i + 1 && !/\s/.test(text[j - 1]) && !/\d/.test(text[j + 1] || '')) { found = j; break; }
        }
        if (found !== -1) {
          flush();
          out.push({ kind: 'math', latex: text.slice(i + 1, found), display: false });
          i = found + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** One equation as KaTeX HTML (needs the KaTeX stylesheet). A formula KaTeX cannot read is shown as typed. */
export function katexHtml(latex: string, display: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode: display,
      throwOnError: true,
      output: 'html',
      trust: false,
      strict: 'ignore',
      maxExpand: 1000,
    });
  } catch {
    return escAttr(display ? `$$${latex}$$` : `$${latex}$`);
  }
}

/** Text with its equations turned into HTML. Text parts go through `escapeText` when given. */
export function mathToHtml(text: string, escapeText?: (s: string) => string): string {
  if (!text || text.indexOf('$') === -1) return escapeText ? escapeText(text || '') : text;
  return splitMath(text)
    .map(p => (p.kind === 'text' ? (escapeText ? escapeText(p.text) : p.text) : katexHtml(p.latex, p.display)))
    .join('');
}

/** Number of equations in a paper (every text field counts, image addresses do not). */
export function countPaperMath(sections: RenderSection[] | undefined): number {
  let n = 0;
  const walk = (v: unknown, key?: string) => {
    if (typeof v === 'string') {
      if (key !== 'url' && v.indexOf('$') !== -1) n += splitMath(v).filter(p => p.kind === 'math').length;
    } else if (Array.isArray(v)) v.forEach(x => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(sections);
  return n;
}

/** null when the paper is within the equation limit, otherwise a message fit to show the teacher. */
export function getMathLimitProblem(sections: RenderSection[] | undefined): string | null {
  return countPaperMath(sections) > MATH_LIMITS.perPaper
    ? `A paper can have at most ${MATH_LIMITS.perPaper} equations.`
    : null;
}

/** Match the following: a borderless two-column grid with headings and an optional answer bracket. */
function renderQuestionMatch(m: RenderMatch | undefined, indentPx: number): string {
  const c = matchColumns(m);
  if (!c) return '';
  const widths = c.answerBox ? [34, 16, 50] : [50, 50]; // bracket sits halfway between the two columns
  const itemStyle = 'padding:2px 8px 2px 1.9em;text-indent:-1.9em;vertical-align:top;overflow-wrap:anywhere;word-break:break-word';
  const item = (label: string, text: string | undefined) =>
    text && text.trim() ? `<b>${label}</b>&nbsp;${mathToHtml(text, escAttr).replace(/\n/g, '<br>')}` : '&nbsp;';
  const headStyle = 'padding:2px 8px 3px 0;text-align:left;font-weight:bold;border-bottom:1px solid #333';
  const head =
    c.leftTitle || c.rightTitle
      ? `<tr><th style="${headStyle}">${escAttr(c.leftTitle)}</th>${c.answerBox ? `<th style="${headStyle}"></th>` : ''}<th style="${headStyle}">${escAttr(c.rightTitle)}</th></tr>`
      : '';
  const rows = Array.from({ length: c.rows }, (_, i) => {
    const hasLeft = !!(c.left[i] && c.left[i].trim());
    return `<tr style="page-break-inside:avoid;break-inside:avoid"><td style="${itemStyle}">${item(`${i + 1}.`, c.left[i])}</td>${
      c.answerBox
        ? `<td style="padding:2px 0;text-align:center;vertical-align:top;white-space:nowrap">${hasLeft ? '(&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;)' : '&nbsp;'}</td>`
        : ''
    }<td style="${itemStyle}">${item(`(${matchLetter(i)})`, c.right[i])}</td></tr>`;
  }).join('');
  return `<table class="q-match" style="border-collapse:collapse;table-layout:fixed;width:calc(100% - ${indentPx}px);margin:6px 0 4px ${indentPx}px;font-size:inherit"><colgroup>${widths
    .map(w => `<col style="width:${w}%">`)
    .join('')}</colgroup><tbody>${head}${rows}</tbody></table>`;
}

/** An option's image: under its text, or beside its label when the option has no text. */
function renderOptionImage(img: RenderImage | undefined, hasText: boolean, rowWidth: '25%' | '50%' | '100%'): string {
  const src = safeImageSrc(img?.url);
  if (!img || !src) return '';
  const boxMm = Math.max(20, ((CONTENT_MM - 7) * parseInt(rowWidth, 10)) / 100 - 9);
  const pct = imageWidthPct(img, OPTION_IMAGE_PCT[img.size || 'medium'] ?? OPTION_IMAGE_PCT.medium, boxMm, 45);
  const layout = hasText ? 'display:block;margin-top:4px' : 'display:inline-block;vertical-align:top';
  return `<img src="${src}" alt="${escAttr(img.alt || '')}" style="${layout};width:${pct}%;height:auto;max-width:100%;text-indent:0">`;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderOptions(
  opts: Array<{ label: string; text: string; isCorrect?: boolean; image?: RenderImage }> | undefined,
  questionText: string
): string {
  const { fixedOptions } = normalizeOptions(opts, questionText);
  const o: Array<{ label: string; text: string; image?: RenderImage }> =
    fixedOptions.length > 0
      ? fixedOptions
      : [
          { label: 'a', text: '___' },
          { label: 'b', text: '___' },
          { label: 'c', text: '___' },
          { label: 'd', text: '___' },
        ];
  const w = mcqOptionWidth(o);
  return `<div style="margin-top:5px;margin-left:28px">${o
    .map(
      x =>
        `<div class="mcq-option" style="display:inline-block;width:${w};vertical-align:top;box-sizing:border-box;padding-left:24px;padding-right:10px;text-indent:-24px;margin-bottom:4px"><span class="opt-label" style="display:inline-block;min-width:24px;margin-right:0;text-indent:0">(${x.label})</span>${mathToHtml(x.text)}${renderOptionImage(x.image, !!x.text, w)}</div>`
    )
    .join('')}</div>`;
}

/** The inner <div class="paper-wrap">…</div> for a template. */
export function buildPaperBody(paper: RenderPaper, templateKey: string): string {
  const ed = paper.examDetails || {};
  const sections = paper.sections || [];
  const tmplId = templateKey || 'tpl_classic';
  const isClassic = tmplId === 'tpl_classic';
  const isWorksheet = tmplId === 'tpl_worksheet';
  const isProfessional = tmplId === 'tpl_professional';
  const totalMarks = paper.totalMarks;
  const title = paper.title;

  const dateStr = ed.date
    ? new Date(ed.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : '—';

  const questionIndentPx = isWorksheet ? 22 : 28; // matches .q-text margin-left in each template
  const lines = (n: number) =>
    Array.from({ length: isWorksheet ? Math.min(n, 1) : n })
      .map(() => '<div class="answer-line"></div>')
      .join('');

  const sectionsHTML = sections
    .map(section => {
      const marksInfo = section.marksPerQuestion
        ? `(${section.marksPerQuestion} Mark${section.marksPerQuestion > 1 ? 's' : ''} Each)`
        : section.totalMarks
        ? `[Total: ${section.totalMarks} Marks]`
        : '';
      const questionsHTML = section.questions
        .map(q => {
          const { cleanedQuestionText } = normalizeOptions(q.options, q.text);
          let a = '';
          if (q.type === 'MCQ') a = renderOptions(q.options, q.text);
          else if (q.type === 'TRUE_FALSE')
            a = '<div class="tf-options"><span><strong>(a)</strong> True</span><span><strong>(b)</strong> False</span></div>';
          else if (q.type === 'FILL_IN_BLANK') a = '';
          else if (q.type === 'SHORT_ANSWER') a = '';
          else if (q.type === 'LONG_ANSWER') a = '';
          else if (q.type === 'MATCH_FOLLOWING' && matchColumns(q.match)) a = ''; // the columns replace the answer lines
          else if (q.type === 'DIAGRAM') a = lines(8);
          else a = ed.answerLines === 'none' ? '' : lines(2);
          return `<div class="question"><div class="q-row"><span class="q-num">${q.number}.</span><span class="q-text">${mathToHtml(withBlank(q.type, cleanedQuestionText || q.text))}</span></div>${renderQuestionTables(q.tables, questionIndentPx)}${renderQuestionImages(q.images, questionIndentPx)}${q.type === 'MATCH_FOLLOWING' ? renderQuestionMatch(q.match, questionIndentPx) : ''}${a}</div>`;
        })
        .join('');
      return `<div class="section"><div class="section-header">${section.title}${
        marksInfo ? ` <span class="section-marks">${marksInfo}</span>` : ''
      }</div>${section.description ? `<div class="section-desc">${section.description}</div>` : ''}${questionsHTML}</div>`;
    })
    .join('');

  const instructionsHTML = ed.instructions && ed.instructions.length
    ? `<div class="instructions"><div class="inst-title">General Instructions:</div><ol>${ed.instructions
        .map(i => `<li>${i}</li>`)
        .join('')}</ol></div><div class="thin-div"></div>`
    : '';

  if (isClassic) {
    return `<div class="paper-wrap"><div class="inst-name">${ed.institutionName || 'Institution Name'}</div><div class="thin-div"></div><div class="classic-meta-row"><span><strong>Name:</strong> ___________________</span><span><strong>Class:</strong> ${ed.class || '—'}</span><span><strong>Date:</strong> ${dateStr}</span><span><strong>Max. Marks:</strong> ${totalMarks || ed.totalMarks || '—'}</span></div><div class="paper-title">${ed.examType || 'Question Paper'}</div><div class="thin-div"></div>${instructionsHTML}${sectionsHTML}</div>`;
  }
  if (isWorksheet) {
    return `<div class="paper-wrap"><div class="ws-title">${title || ed.examType || 'Worksheet'}</div><div class="ws-name-row"><span><strong>Name:</strong> _____________________________</span><span><strong>Date:</strong> ${dateStr}</span></div>${sectionsHTML}<div class="ws-footer">${ed.institutionName || ''}</div></div>`;
  }
  if (isProfessional) {
    const infoLines = [
      ed.institutionAddress ? `<div class="pro-info-line">📍 ${ed.institutionAddress}</div>` : '',
      ed.department ? `<div class="pro-info-line">🏫 Dept. of ${ed.department}</div>` : '',
      ed.facultyName ? `<div class="pro-info-line">👤 Faculty: ${ed.facultyName}</div>` : '',
    ]
      .filter(Boolean)
      .join('');
    return `<div class="paper-wrap"><div class="pro-header"><div class="pro-logo"><div class="pro-logo-inner">LOGO</div></div><div class="pro-info"><div class="pro-info-name">${(ed.institutionName || 'INSTITUTION NAME').toUpperCase()}</div><div class="pro-info-divider"></div>${infoLines}</div></div><div class="pro-meta-row"><span><strong>Subject:</strong> ${ed.subject || '—'}</span><span><strong>Class:</strong> ${ed.class || '—'}</span><span><strong>Date:</strong> ${dateStr}</span><span><strong>Duration:</strong> ${ed.duration || '3 Hrs'}</span><span><strong>Max. Marks:</strong> ${totalMarks || ed.totalMarks || '—'}</span></div><div class="thin-div"></div><div class="paper-title">${ed.examType || 'Question Paper'}</div><div class="thin-div"></div>${sectionsHTML}<div class="thin-div"></div><div class="sig-block"><div class="sig-line"><div>Subject Teacher</div></div><div class="sig-line"><div>HOD / Principal</div></div><div class="sig-line"><div>Exam Controller</div></div></div></div>`;
  }
  // Default template
  return `<div class="paper-wrap"><div class="header"><div class="inst-name">${ed.institutionName || 'Institution Name'}</div>${ed.institutionAddress ? `<div class="inst-addr">${ed.institutionAddress}</div>` : ''}</div><div class="thick-div"></div><table class="meta-table"><tr><td><strong>Subject:</strong> ${ed.subject || '—'}</td><td style="text-align:right"><strong>Date:</strong> ${dateStr}</td></tr><tr><td><strong>Class:</strong> ${ed.class || '—'}</td><td style="text-align:right"><strong>Duration:</strong> ${ed.duration || '3 Hours'}</td></tr><tr><td><strong>Max. Marks:</strong> ${totalMarks || ed.totalMarks || '—'}</td><td style="text-align:right"></td></tr></table><div class="thin-div"></div><div class="paper-title">${ed.examType || 'Question Paper'}</div>${instructionsHTML}${sectionsHTML}<div class="thick-div"></div></div>`;
}

/** CSS for a template key. */
export function getPaperCss(templateKey: string): string {
  const t = templateKey || 'tpl_classic';
  return t === 'tpl_classic'
    ? classicCss
    : t === 'tpl_worksheet'
    ? worksheetCss
    : t === 'tpl_professional'
    ? professionalCss
    : defaultCss;
}

/** A complete standalone HTML document for a paper. */
export function buildPaperHtml(paper: RenderPaper, templateKey: string, opts: BuildHtmlOptions = {}): string {
  const css = getPaperCss(templateKey);
  const body = buildPaperBody(paper, templateKey);
  const mathLink = body.includes('class="katex') ? `\n  <link rel="stylesheet" href="${KATEX_CSS_URL}">` : '';
  const printScript = opts.autoPrint
    ? `\n  <script>\n    window.onload = function() {\n      window.print();\n    };\n  </script>`
    : '';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${paper.title || 'Question Paper'}</title>
  <style>${css}</style>${mathLink}
</head>
<body>
  ${body}${printScript}
</body>
</html>`;
}