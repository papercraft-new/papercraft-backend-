// services/smartExtract.ts
// Step 6: "smarter extraction". Instead of reading the page as plain text first, the page image or
// PDF goes straight to Claude, which returns the questions already structured: formulas as LaTeX
// ($\frac{14}{5}$), tables as grids, match-the-following as two columns, and diagrams as boxes on
// the page. ocrService.ts turns the JSON into questions (limits and clean-up happen there) and
// falls back to the standard OCR pipeline whenever anything here fails.
//
// Env (optional): SMART_EXTRACTION=0 switches this off. SMART_EXTRACTION_MODEL overrides the model.

import { logger } from '../utils/logger';

const MAX_IMAGE_BYTES = 4.8 * 1024 * 1024; // the API takes images up to 5 MB
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const TIMEOUT_MS = 170_000;

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
  ]
}
Leave out "options", "tables", "match" and "figures" when a question has none.

GENERAL RULES
- Read every question, in order, across all pages. Never skip, summarise or invent anything.
- Keep section headings, their instruction lines and the marks shown ([2], (3 marks) or "2 marks each").
- Question text must not contain the option text, the marks, or the text of a table or match columns.
- MCQ options go in "options", one object per option, labelled a, b, c, d.
- A question with a blank (____) is FILL_IN_BLANK; keep the blank as ____ in the text.

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

/** Sends the file to Claude and returns the JSON text it answered with. Throws on any problem. */
export async function smartExtractJson(inputType: 'image' | 'pdf', fileUrl: string): Promise<string> {
  const download = await fetch(fileUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' } });
  if (!download.ok) throw new Error(`Smart extraction could not download the file: ${download.status}`);
  const bytes = Buffer.from(await download.arrayBuffer());

  let fileBlock: Record<string, unknown>;
  if (inputType === 'pdf') {
    if (bytes.length > MAX_PDF_BYTES) throw new Error('PDF too large for smart extraction');
    fileBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } };
  } else {
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image too large for smart extraction');
    let mime = (download.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime)) mime = 'image/jpeg';
    fileBlock = { type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } };
  }

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
        ...(inputType === 'pdf' ? { 'anthropic-beta': 'pdfs-2024-09-25' } : {}),
      },
      body: JSON.stringify({
        model: process.env.SMART_EXTRACTION_MODEL || 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: PROMPT }] }],
      }),
    });
    if (!response.ok) throw new Error(`Smart extraction API error ${response.status}: ${(await response.text()).slice(0, 200)}`);

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