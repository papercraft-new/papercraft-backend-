// services/smartExtract.ts
// Step 6: "smarter extraction". Instead of reading the page as plain text first, the page image or
// PDF goes straight to Claude, which returns the questions already structured: formulas as LaTeX
// ($\frac{14}{5}$), tables as grids, match-the-following as two columns, and diagrams as boxes on
// the page. ocrService.ts turns the JSON into questions (limits and clean-up happen there) and
// falls back to the standard OCR pipeline whenever anything here fails.
//
// Env (optional): SMART_EXTRACTION=0 switches this off. SMART_EXTRACTION_MODEL overrides the model.

import { logger } from '../utils/logger';
import { PDFDocument } from 'pdf-lib';

const MAX_IMAGE_BYTES = 4.8 * 1024 * 1024; // the API takes images up to 5 MB
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const TIMEOUT_MS = 170_000;

// Long papers (a 160-question paper is 17 pages) do not fit in one answer: Claude's reply is capped at
// 16000 tokens. PDFs of more than SINGLE_CALL_MAX_PAGES pages are cut into pieces of PAGES_PER_PIECE pages,
// read PIECES_AT_ONCE at a time, and the sections are joined afterwards.
const SINGLE_CALL_MAX_PAGES = 3;
const PAGES_PER_PIECE = 2;
const PIECES_AT_ONCE = 4;
const API_RETRIES = 2; // for 429 / 5xx / overloaded

export function smartExtractionEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY && process.env.SMART_EXTRACTION !== '0';
}

const PROMPT = `You are an expert Indian exam question paper reader. Read the attached exam paper (image or PDF) and return every question as structured JSON.

Return ONLY this JSON, with no markdown and no explanation:
{
  "sections": [
    {
      "title": "Section A",
      "description": "instruction line printed under the heading, if any",
      "marksPerQuestion": 1,
      "questions": [
        {
          "no": 41,
          "answer": "b",
          "type": "MCQ | SHORT_ANSWER | LONG_ANSWER | FILL_IN_BLANK | TRUE_FALSE | MATCH_FOLLOWING | DIAGRAM | NUMERICAL",
          "text": "question text only",
          "marks": 1,
          "options": [{"label": "a", "text": "option text"}],
          "tables": [{"headerRow": true, "rows": [["cell", "cell"], ["cell", "cell"]]}],
          "match": {"leftTitle": "Column A", "rightTitle": "Column B", "left": ["item", "item"], "right": ["item", "item", "item"]},
          "figures": [{"page": 1, "box": [0.1, 0.2, 0.4, 0.25], "caption": "short description"}]
        }
      ]
    }
  ],
  "answerKey": [{"section": "Physics", "no": 1, "answer": "b"}]
}
Leave out "options", "tables", "match", "figures", "no", "answer" and "answerKey" when there is nothing to put in them.

GENERAL RULES
- Read every question, in order, across all pages. Never skip, summarise or invent anything.
- Keep section headings, their instruction lines and the marks shown ([2], (3 marks) or "2 marks each").
- Question text must not contain the option text, the marks, or the text of a table or match columns.
- MCQ options go in "options", one object per option, labelled a, b, c, d.
- A question with a blank (____) is FILL_IN_BLANK; keep the blank as ____ in the text.
- Options may be numbered 1) 2) 3) 4), (1) (2) (3) (4) or A. B. C. D., on one line or on separate lines. Always label them a, b, c, d in order. A question number starts the line and is followed by a dot or bracket (for example "7."); the numbers 1) to 4) inside a question are options and never new questions.
- Ignore running headers and footers (the paper title repeated on every page, "Page 3", marks banners). Keep subject or part headings such as MATHEMATICS – A, PHYSICS or CHEMISTRY as section titles.
- ANSWER KEYS: an answer key (a list or table headed "Answer Key", "Answers", "Key" or similar, with entries like "1-b  2-c" or "1. (a)") is not a set of questions. Copy its entries into "answerKey". "no" is the question number, and "answer" is exactly what the key prints for it: a letter like b, several letters like a,c, a number like 12.5, or a range like 12 to 13. If the key is grouped under headings (Physics, Chemistry...), set "section" to that heading, otherwise leave "section" out. If an answer is printed right next to a question ("Ans: (b)"), put it in that question's "answer" instead of in "answerKey". Only copy what is printed. Never work out an answer yourself and never guess one. Worked solutions and explanations are not part of the key: ignore them.
- "no" is the question's printed number as a plain number (41 for "41."). Leave it out if the question has no printed number.

MATHS AND SCIENCE
- Write a fraction as LaTeX between dollar signs, stacked: $\\frac{14}{5}$. Do the same for exponents ($x^{2}$), roots ($\\sqrt{x}$), subscripts ($H_{2}O$), degrees ($30^\\circ$), Greek letters, integrals, sums and anything else that needs special layout.
- Keep ordinary arithmetic as plain text with the printed symbols, for example 3 × (5 + 3) − 3 or 57 ÷ 19. Do not put plain arithmetic in dollar signs.
- Put a whole expression in one pair of dollar signs, for example $\\frac{14}{5} - \\frac{4}{5}$. Use $...$ inside text, options and table cells.
- A real dollar sign (money) is written \\$.

TABLES
- A printed grid of rows and columns goes in "tables" (at most 3 per question, 20 rows and 8 columns each). Cells are plain text; LaTeX is allowed. Use "headerRow": true when the first row is a heading row.

MATCH THE FOLLOWING
- Two columns to match: type MATCH_FOLLOWING. "text" holds only the instruction. "left" and "right" hold the items WITHOUT their numbers or letters (no "1." and no "(a)"). Use the headings printed on the page ("Column A", "List I" ...) as leftTitle and rightTitle. The right column may have more items than the left.

FIGURES
- A diagram, graph, geometric figure, circuit or picture that belongs to a question goes in "figures" for that question (at most 5). "page" is the 1-based page number (1 for a single image). "box" is [x, y, width, height] as fractions of the page width and height, between 0 and 1, drawn tightly around the figure only (not the question text). Do not box plain text, tables or equations.

Respond with the JSON only.`;

export interface PdfPiece { startPage: number; endPage: number; data: Buffer } // pages are 1-based, inclusive

/** Cuts a long PDF into pieces of a few pages. Returns null when it is short enough to read in one go. */
export async function splitPdf(
  bytes: Buffer,
  pagesPerPiece = PAGES_PER_PIECE,
  singleCallMaxPages = SINGLE_CALL_MAX_PAGES
): Promise<PdfPiece[] | null> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  if (total <= singleCallMaxPages) return null;
  const pieces: PdfPiece[] = [];
  for (let start = 0; start < total; start += pagesPerPiece) {
    const end = Math.min(total, start + pagesPerPiece);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, Array.from({ length: end - start }, (_, i) => start + i));
    copied.forEach(p => out.addPage(p));
    pieces.push({ startPage: start + 1, endPage: end, data: Buffer.from(await out.save()) });
  }
  return pieces;
}

type RawSection = { title?: string; questions?: Array<Record<string, any>>; [k: string]: any };

function parseSectionsJson(text: string): { sections: RawSection[]; answerKey?: unknown[] } {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Smart extraction answer was not JSON');
  const j = JSON.parse(t.slice(a, b + 1));
  if (!j || !Array.isArray(j.sections)) throw new Error('Smart extraction answer had no sections');
  return j;
}

/**
 * Joins the sections read from consecutive pieces. A section called CONTINUED carries on from the previous
 * piece; a heading that was alone at the bottom of a piece is kept for the questions that follow it; a
 * section with the same title as the one before is merged into it.
 */
export function mergeSections(parts: Array<{ sections: RawSection[] }>): RawSection[] {
  const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const out: RawSection[] = [];
  let pending: RawSection | null = null;
  for (const part of parts) {
    for (const sec of part.sections) {
      const qs = Array.isArray(sec.questions) ? sec.questions : [];
      const continued = norm(sec.title) === 'continued';
      if (qs.length === 0) {
        if (!continued && norm(sec.title)) pending = sec; // a heading whose questions start on the next piece
        continue;
      }
      if (continued) {
        if (pending) { out.push({ ...pending, questions: qs.slice() }); pending = null; }
        else if (out.length) out[out.length - 1].questions!.push(...qs);
        else out.push({ ...sec, title: 'Section A', questions: qs.slice() });
        continue;
      }
      pending = null;
      const last = out[out.length - 1];
      if (last && norm(last.title) === norm(sec.title)) last.questions!.push(...qs);
      else out.push({ ...sec, questions: qs.slice() });
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** One request to Claude with the file and a prompt. Returns the JSON text. Retries busy-server answers. */
async function askClaude(fileBlock: Record<string, unknown>, prompt: string, isPdf: boolean): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          // no output-128k beta: 16000 tokens does not need it, and a beta the model does not accept fails the call
          ...(isPdf ? { 'anthropic-beta': 'pdfs-2024-09-25' } : {}),
        },
        body: JSON.stringify({
          model: process.env.SMART_EXTRACTION_MODEL || 'claude-sonnet-4-6',
          max_tokens: 16000,
          messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: prompt }] }],
        }),
      });
      if (!response.ok) {
        const busy = [429, 500, 502, 503, 529].includes(response.status);
        if (busy && attempt < API_RETRIES) { await sleep(3000 * (attempt + 1)); continue; }
        throw new Error(`Smart extraction API error ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
        stop_reason?: string;
      };
      if (data.stop_reason === 'max_tokens') throw new Error('Smart extraction answer was cut off');
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('');
      if (!text.trim()) throw new Error('Smart extraction returned nothing');
      logger.info(`Smart extraction answered: ${text.length} chars`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Reads a long PDF piece by piece, a few at a time, and returns one JSON text with the joined sections. */
async function extractInPieces(pieces: PdfPiece[]): Promise<string> {
  const total = pieces[pieces.length - 1].endPage;
  logger.info(`Smart extraction: ${total}-page PDF read in ${pieces.length} pieces.`);
  const results: Array<{ sections: RawSection[]; answerKey?: unknown[] }> = new Array(pieces.length);

  const readPiece = async (piece: PdfPiece) => {
    const prompt =
      `${PROMPT}\n\nTHESE PAGES: this file holds pages ${piece.startPage} to ${piece.endPage} of a ${total}-page paper. ` +
      `Read only the questions on these pages. If the first questions here continue a section whose heading was printed on an earlier page, ` +
      `set that section's "title" to exactly CONTINUED. If a heading is printed here with no question under it yet, still return that section with an empty "questions" list. ` +
      `If these pages hold no questions (for example an answer key page), return {"sections": [], "answerKey": [...]} with the key's entries, or just {"sections": []} if there is no key. "page" in "figures" counts from 1 within this file. Respond with the JSON only.`;
    const block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: piece.data.toString('base64') } };
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) { // one retry per piece
      try {
        const parsed = parseSectionsJson(await askClaude(block, prompt, true));
        const offset = piece.startPage - 1; // figure pages must point into the ORIGINAL PDF
        for (const sec of parsed.sections) {
          for (const q of sec.questions || []) {
            if (Array.isArray(q.figures)) q.figures = q.figures.map((f: any) => (f && typeof f.page === 'number' ? { ...f, page: f.page + offset } : f));
          }
        }
        return parsed;
      } catch (err) {
        lastErr = err;
        logger.warn(`Smart extraction: pages ${piece.startPage}-${piece.endPage} failed (attempt ${attempt + 1}):`, err);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Smart extraction piece failed');
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PIECES_AT_ONCE, pieces.length) }, async () => {
      while (next < pieces.length) {
        const i = next++;
        results[i] = await readPiece(pieces[i]);
      }
    })
  );
  // an answer key usually sits on the last pages, far from its questions: keep every piece's entries
  const answerKey = results.flatMap(r => (Array.isArray(r.answerKey) ? r.answerKey : []));
  return JSON.stringify({ sections: mergeSections(results), ...(answerKey.length ? { answerKey } : {}) });
}

/** Sends the file to Claude and returns the JSON text it answered with. Throws on any problem. */
export async function smartExtractJson(inputType: 'image' | 'pdf', fileUrl: string): Promise<string> {
  const download = await fetch(fileUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' } });
  if (!download.ok) throw new Error(`Smart extraction could not download the file: ${download.status}`);
  const bytes = Buffer.from(await download.arrayBuffer());

  let fileBlock: Record<string, unknown>;
  if (inputType === 'pdf') {
    if (bytes.length > MAX_PDF_BYTES) throw new Error('PDF too large for smart extraction');
    // A long paper does not fit in one answer, so it is read in pieces. A PDF that cannot be cut is read whole.
    const pieces = await splitPdf(bytes).catch(err => {
      logger.warn('Smart extraction: could not split the PDF, reading it whole:', err);
      return null;
    });
    if (pieces && pieces.length > 1) return extractInPieces(pieces);
    fileBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } };
  } else {
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image too large for smart extraction');
    let mime = (download.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime)) mime = 'image/jpeg';
    fileBlock = { type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } };
  }
  return askClaude(fileBlock, PROMPT, inputType === 'pdf');
}