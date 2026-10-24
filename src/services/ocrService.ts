import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import type { Section, Question, QuestionTable, QuestionMatch, FigureBox } from '../types';
import { splitMath, TABLE_LIMITS, MATCH_LIMITS } from './paperRenderer';
import { smartExtractionEnabled, smartExtractJson } from './smartExtract';
import { readKeyEntries, type KeyEntry } from './answerKey';

// ─────────────────────────────────────────
// MAIN OCR PIPELINE
// ─────────────────────────────────────────

export async function processOcrJob(
  inputType: 'image' | 'pdf' | 'text',
  content: string,
  sourceIndex = 0 // which uploaded file this is, so figure boxes can be matched to it
): Promise<{
  rawText: string;
  cleanedText: string;
  sections: Section[];
  questionsFound: number;
  sectionsFound: number;
  processingMs: number;
  confidence: number;
  warnings: string[];
  keyEntries?: KeyEntry[]; // answer key entries read from the file; applied once all files are merged
}> {
  const startTime = Date.now();
  const warnings: string[] = [];

  logger.info(`OCR Job: Starting ${inputType} processing`);

  // Smart extraction (step 6): the page goes straight to Claude and comes back structured, with
  // formulas, tables, match columns and figure boxes. Any failure falls through to the standard pipeline.
  if ((inputType === 'image' || inputType === 'pdf') && !smartExtractionEnabled()) {
    logger.info('Smart extraction is off (no ANTHROPIC_API_KEY, or SMART_EXTRACTION=0): using the standard pipeline.');
  }
  if ((inputType === 'image' || inputType === 'pdf') && smartExtractionEnabled()) {
    try {
      const json = await smartExtractJson(inputType, content);
      const { sections } = parseAiResponse(json, '', true);
      const smartQuestions = sections.reduce((sum, sec) => sum + sec.questions.length, 0);
      // a key that came in the same file as questions belongs to those questions; a key-only file stays general
      const keyEntries = readKeyEntries(json).map(e => (smartQuestions > 0 ? { ...e, file: sourceIndex } : e));
      // A file that holds only an answer key has no questions, and that is a success, not a failure.
      if (smartQuestions === 0 && keyEntries.length === 0) throw new Error('Smart extraction found no questions');
      if (smartQuestions === 0) warnings.push(`This file holds an answer key (${keyEntries.length} answers) and no questions.`);
      sections.forEach(sec =>
        sec.questions.forEach(q => {
          if (q.figureBoxes) q.figureBoxes = q.figureBoxes.map(f => ({ ...f, sourceIndex }));
          q.sourceFile = sourceIndex; // removed again once an answer key has been matched
        })
      );
      const smartText = sections
        .flatMap(sec => [sec.title, ...sec.questions.map(q => `${q.number}. ${q.text}`)])
        .join('\n');
      const processingMs = Date.now() - startTime;
      logger.info(`Smart extraction completed in ${processingMs}ms: ${smartQuestions} questions in ${sections.length} sections.`);
      return {
        rawText: smartText,
        cleanedText: smartText,
        confidence: 0.95,
        sections,
        questionsFound: smartQuestions,
        sectionsFound: sections.length,
        processingMs,
        warnings,
        ...(keyEntries.length ? { keyEntries } : {}),
      };
    } catch (err) {
      logger.warn('Smart extraction failed, using the standard OCR pipeline:', err);
    }
  }

  let rawText = '';

  if (inputType === 'text') {
    rawText = content;
  } else if (inputType === 'image') {
    rawText = await extractTextFromImage(content);
  } else if (inputType === 'pdf') {
    rawText = await extractTextFromPdf(content);
  }

  if (!rawText || rawText.trim().length < 5) {
    warnings.push('Very little text extracted. Check image quality.');
    rawText = 'No text could be extracted from the image.';
  }

  logger.info(`Raw text extracted: ${rawText.length} characters`);

  const { cleanedText, sections } = await structureText(rawText);

  const totalQuestions = sections.reduce((sum, s) => sum + s.questions.length, 0);
  const processingMs = Date.now() - startTime;

  logger.info(`OCR completed in ${processingMs}ms. Found ${totalQuestions} questions in ${sections.length} sections.`);

  return {
    rawText,
    cleanedText,
    confidence: rawText.length > 50 ? 0.92 : 0.5,
    sections,
    questionsFound: totalQuestions,
    sectionsFound: sections.length,
    processingMs,
    warnings,
  };
}

// ─────────────────────────────────────────
// EXTRACT TEXT FROM PDF (Claude native PDF support)
// ─────────────────────────────────────────
/** Reads the text layer of a PDF on this server (free, and it never cuts a long paper short). */
async function localPdfText(buf: Buffer): Promise<{ text: string; pages: number } | null> {
  try {
    const mod: any = await import('pdf-parse');
    if (!mod?.PDFParse) return null; // pdf-parse 2.x exports a PDFParse class (there is no default function)
    const parser = new mod.PDFParse({ data: new Uint8Array(buf) });
    try {
      const r = await parser.getText();
      return { text: String(r?.text || ''), pages: Number(r?.total) || 0 };
    } finally {
      try { await parser.destroy?.(); } catch { /* ignore */ }
    }
  } catch (err) {
    logger.warn('Local PDF text extraction failed:', err);
    return null;
  }
}

async function extractTextFromPdf(pdfUrl: string): Promise<string> {
  logger.info('Starting PDF text extraction...');

  // Download the PDF
  const response = await fetch(pdfUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/pdf,*/*' },
  });
  if (!response.ok) throw new Error(`Failed to download PDF: ${response.status}`);

  const arrayBuffer = await response.arrayBuffer();
  const base64Pdf = Buffer.from(arrayBuffer).toString('base64');
  logger.info(`PDF downloaded: ${base64Pdf.length} base64 chars`);

  // A long typeset PDF: its own text layer is complete, while Claude's reply below is capped at 8000 tokens
  // (about half of a 160-question paper).
  const local = await localPdfText(Buffer.from(arrayBuffer));
  const hasTextLayer = !!local && local.pages > 0 && local.text.replace(/\s/g, '').length / local.pages >= 400;
  if (local && hasTextLayer && local.pages > 3) {
    logger.info(`PDF text layer used: ${local.pages} pages, ${local.text.length} chars`);
    return local.text;
  }

  // Strategy 1: Claude native PDF document support
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      logger.info('Trying Claude native PDF extraction...');
      const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'pdfs-2024-09-25,output-128k-2025-02-19',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8000,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: base64Pdf,
                  },
                },
                {
                  type: 'text',
                  text: `Extract ALL text from this exam question paper PDF exactly as written.

Rules:
- Extract every single question with its number
- Extract ALL option labels exactly: (a), (b), (c), (d) or (1),(2),(3),(4)
- Extract section headers: SECTION A, PART I, etc.
- Extract marks shown: [2] or (3 marks)
- Extract mathematical equations and symbols
- Keep the exact order and structure across all pages
- Do NOT summarize, skip or modify anything
- Do NOT add any explanation

Return ONLY the raw extracted text, nothing else.`,
                },
              ],
            },
          ],
        }),
      });

      if (claudeResponse.ok) {
        const data = await claudeResponse.json() as {
          content: Array<{ type: string; text: string }>;
          error?: { message: string };
        };
        const text = data.content?.[0]?.text || '';
        if (text && text.trim().length > 20) {
          logger.info(`Claude PDF extraction succeeded: ${text.length} chars`);
          return text;
        }
      } else {
        const err = await claudeResponse.text();
        logger.warn(`Claude PDF extraction failed: ${claudeResponse.status} ${err}`);
      }
    } catch (err) {
      logger.warn('Claude PDF extraction threw error:', err);
    }
  }

  // Strategy 2: Extract pages as images and run image OCR
  logger.info('Falling back to page-by-page image OCR...');
  try {
    const fallback = local ?? (await localPdfText(Buffer.from(arrayBuffer)));
    if (fallback && fallback.text.trim().length > 20) {
      logger.info(`pdf-parse extracted: ${fallback.text.length} chars`);
      return fallback.text;
    }
  } catch (err) {
    logger.warn('pdf-parse fallback failed:', err);
  }

  throw new Error('Could not extract text from PDF. Please convert to image first or paste text manually.');
}

// ─────────────────────────────────────────
// EXTRACT TEXT FROM IMAGE
// ─────────────────────────────────────────
async function extractTextFromImage(imageUrl: string): Promise<string> {
  logger.info('Starting parallel OCR extraction from multiple sources...');

  const ocrTasks: Promise<{ source: string; text: string; chars: number }>[] = [];

  // Add all available OCR sources as parallel tasks
  if (process.env.ANTHROPIC_API_KEY) {
    ocrTasks.push(
      extractWithClaude(imageUrl)
        .then(text => ({ source: 'Claude', text, chars: text.length }))
        .catch(err => { logger.warn('Claude OCR failed:', err); return { source: 'Claude', text: '', chars: 0 }; })
    );
  }

  if (process.env.OCR_SPACE_API_KEY) {
    ocrTasks.push(
      extractWithOcrSpace(imageUrl)
        .then(text => ({ source: 'OCR.space', text, chars: text.length }))
        .catch(err => { logger.warn('OCR.space failed:', err); return { source: 'OCR.space', text: '', chars: 0 }; })
    );
  }

  if (process.env.GOOGLE_VISION_API_KEY) {
    ocrTasks.push(
      extractWithGoogleVision(imageUrl)
        .then(text => ({ source: 'Google Vision', text, chars: text.length }))
        .catch(err => { logger.warn('Google Vision failed:', err); return { source: 'Google Vision', text: '', chars: 0 }; })
    );
  }

  if (process.env.GEMINI_API_KEY) {
    ocrTasks.push(
      extractWithGeminiVision(imageUrl)
        .then(text => ({ source: 'Gemini', text, chars: text.length }))
        .catch(err => { logger.warn('Gemini failed:', err); return { source: 'Gemini', text: '', chars: 0 }; })
    );
  }

  if (ocrTasks.length === 0) {
    // No API keys — use Tesseract
    try {
      logger.info('No API keys found. Using Tesseract...');
      const Tesseract = await import('tesseract.js');
      const result = await Tesseract.default.recognize(imageUrl, 'eng');
      return result.data.text;
    } catch (err) {
      throw new Error('All OCR methods failed. Please paste text manually.');
    }
  }

  // Run ALL sources in parallel
  logger.info(`Running ${ocrTasks.length} OCR sources in parallel...`);
  const results = await Promise.all(ocrTasks);

  // Log all results
  results.forEach(r => {
    logger.info(`${r.source}: ${r.chars} chars extracted`);
  });

  // Filter successful results
  const successful = results.filter(r => r.text && r.text.trim().length > 20);

  if (successful.length === 0) {
    // All failed — try Tesseract as last resort
    try {
      logger.info('All API OCR failed. Trying Tesseract...');
      const Tesseract = await import('tesseract.js');
      const result = await Tesseract.default.recognize(imageUrl, 'eng');
      const text = result.data.text;
      if (text && text.trim().length > 20) return text;
    } catch (err) {
      logger.warn('Tesseract also failed:', err);
    }
    throw new Error('All OCR methods failed. Please paste text manually.');
  }

  // If only one succeeded — use it
  if (successful.length === 1) {
    logger.info(`Using ${successful[0].source} result (only successful)`);
    return successful[0].text;
  }

  // Multiple succeeded — merge and pick best
  const merged = mergeOcrResults(successful);
  logger.info(`Merged ${successful.length} OCR results. Final: ${merged.length} chars`);
  return merged;
}

function mergeOcrResults(
  results: Array<{ source: string; text: string; chars: number }>
): string {
  // If Claude succeeded — always use Claude
  const claudeResult = results.find(r => r.source === 'Claude' && r.text.trim().length > 20);
  if (claudeResult) {
    logger.info(`Using Claude result as primary (best quality)`);
    return claudeResult.text;
  }

  // Claude failed — score remaining results
  const scored = results
    .filter(r => r.text.trim().length > 20)
    .map(r => {
      let score = r.chars;
      const questionMatches = (r.text.match(/^\d+[.)]/gm) || []).length;
      score += questionMatches * 50;
      const optionMatches = (r.text.match(/\([abcdABCD]\)/g) || []).length;
      score += optionMatches * 30;
      const sectionMatches = (r.text.match(/SECTION|PART/gi) || []).length;
      score += sectionMatches * 40;
      const marksMatches = (r.text.match(/\[\d+\]/g) || []).length;
      score += marksMatches * 20;
      if (r.chars < 100) score -= 200;
      logger.info(`OCR scoring — ${r.source}: score=${score}`);
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) throw new Error('All OCR methods failed.');

  logger.info(`Best fallback OCR: ${scored[0].source}`);
  return scored[0].text;
}

function enhanceWithOtherResults(bestText: string, otherTexts: string[]): string {
  // For now return best text
  // In future: cross-reference missing questions from other sources
  return bestText;
}
// ─────────────────────────────────────────
// OCR.SPACE
// ─────────────────────────────────────────

async function extractWithOcrSpace(imageUrl: string): Promise<string> {
  logger.info('Using OCR.space...');

  // OCR.space supports URL directly - no need to download image
  const formData = new URLSearchParams();
  formData.append('url', imageUrl);
  formData.append('apikey', process.env.OCR_SPACE_API_KEY!);
  formData.append('language', 'eng');
  formData.append('isOverlayRequired', 'false');
  formData.append('detectOrientation', 'true');
  formData.append('scale', 'true');
  formData.append('isTable', 'false');
  formData.append('OCREngine', '2'); // Engine 2 = better accuracy

  const response = await fetch('https://api.ocr.space/parse/imageurl', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    throw new Error(`OCR.space HTTP error: ${response.status}`);
  }

  const data = await response.json() as {
    ParsedResults?: Array<{
      ParsedText: string;
      ErrorMessage?: string;
      FileParseExitCode?: number;
    }>;
    IsErroredOnProcessing?: boolean;
    ErrorMessage?: string | string[];
    OCRExitCode?: number;
  };

  if (data.IsErroredOnProcessing) {
    const errMsg = Array.isArray(data.ErrorMessage)
      ? data.ErrorMessage.join(', ')
      : data.ErrorMessage || 'Unknown error';
    throw new Error(`OCR.space error: ${errMsg}`);
  }

  const parsedText = data.ParsedResults?.[0]?.ParsedText || '';
  if (!parsedText || parsedText.trim().length === 0) {
    throw new Error('OCR.space returned empty text');
  }

  logger.info(`OCR.space success: ${parsedText.length} chars`);
  return parsedText;
}

// ─────────────────────────────────────────
// OCR.SPACE WITH FILE UPLOAD (for Cloudinary URLs that need auth)
// ─────────────────────────────────────────

async function extractWithOcrSpaceFile(imageUrl: string): Promise<string> {
  logger.info('Using OCR.space with file download...');

  // Download file first
  const imageResponse = await fetch(imageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!imageResponse.ok) throw new Error(`Failed to download image: ${imageResponse.status}`);

  const arrayBuffer = await imageResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

  // Build multipart form
  const boundary = '----FormBoundary' + Date.now();
  const parts: Buffer[] = [];

  const addField = (name: string, value: string) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  };

  addField('apikey', process.env.OCR_SPACE_API_KEY!);
  addField('language', 'eng');
  addField('isOverlayRequired', 'false');
  addField('detectOrientation', 'true');
  addField('scale', 'true');
  addField('OCREngine', '2');

  // Add file
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.jpg"\r\nContent-Type: ${contentType}\r\n\r\n`
  ));
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const response = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length.toString(),
    },
    body,
  });

  if (!response.ok) throw new Error(`OCR.space file upload error: ${response.status}`);

  const data = await response.json() as {
    ParsedResults?: Array<{ ParsedText: string }>;
    IsErroredOnProcessing?: boolean;
    ErrorMessage?: string | string[];
  };

  if (data.IsErroredOnProcessing) {
    const errMsg = Array.isArray(data.ErrorMessage)
      ? data.ErrorMessage.join(', ')
      : data.ErrorMessage || 'Unknown error';
    throw new Error(`OCR.space error: ${errMsg}`);
  }

  return data.ParsedResults?.[0]?.ParsedText || '';
}

// ─────────────────────────────────────────
// GOOGLE CLOUD VISION
// ─────────────────────────────────────────

async function extractWithGoogleVision(imageUrl: string): Promise<string> {
  logger.info('Using Google Cloud Vision...');

  const response = await fetch(imageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*,*/*' },
  });
  if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length === 0) throw new Error('Empty image buffer');

  const base64Image = buffer.toString('base64');

  const visionResponse = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: base64Image },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            imageContext: { languageHints: ['en', 'hi', 'te', 'ta', 'kn', 'ml'] },
          },
        ],
      }),
    }
  );

  if (!visionResponse.ok) throw new Error(`Google Vision HTTP error: ${visionResponse.status}`);

  const data = await visionResponse.json() as {
    responses: Array<{
      fullTextAnnotation?: { text: string };
      textAnnotations?: Array<{ description: string }>;
      error?: { message: string };
    }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(`Vision API error: ${data.error.message}`);
  if (data.responses?.[0]?.error) throw new Error(`Vision error: ${data.responses[0].error!.message}`);

  const fullText = data.responses?.[0]?.fullTextAnnotation?.text || '';
  const basicText = data.responses?.[0]?.textAnnotations?.[0]?.description || '';
  const result = fullText || basicText;
  if (!result) throw new Error('Google Vision returned empty text');
  return result;
}

// ─────────────────────────────────────────
// GEMINI VISION
// ─────────────────────────────────────────

async function extractWithGeminiVision(imageUrl: string): Promise<string> {
  logger.info('Using Gemini Vision...');

  const models = [
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash',
    'gemini-1.5-pro-latest',
  ];

  const response = await fetch(imageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*,*/*' },
  });
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  let mimeType = contentType.split(';')[0].trim();
  const supportedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  if (!supportedTypes.includes(mimeType)) mimeType = 'image/jpeg';

  const arrayBuffer = await response.arrayBuffer();
  const base64Image = Buffer.from(arrayBuffer).toString('base64');

  for (const model of models) {
    try {
      logger.info(`Trying Gemini model: ${model}`);

      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { inline_data: { mime_type: mimeType, data: base64Image } },
                  {
                    text: `Extract ALL text from this exam question paper image exactly as written.
Rules:
- Keep question numbers (1., 2., Q1, Q2, etc.)
- Keep option labels: (a), (b), (c), (d) or a), b) etc.
- Keep section headers (SECTION A, PART I, etc.)
- Keep marks info like [2] or (3 marks)
- Keep ALL mathematical symbols
- Do NOT summarize or skip anything
Return ONLY the raw extracted text.`,
                  },
                ],
              },
            ],
            generationConfig: { maxOutputTokens: 8000, temperature: 0.0 },
          }),
        }
      );

      const data = await geminiResponse.json() as {
        candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
        error?: { message: string };
      };

      if (data.error) {
        logger.warn(`Model ${model} failed: ${data.error.message}`);
        continue;
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text && text.length > 10) {
        logger.info(`Model ${model} succeeded: ${text.length} chars`);
        return text;
      }
    } catch (err) {
      logger.warn(`Model ${model} threw error:`, err);
      continue;
    }
  }

  throw new Error('All Gemini models failed or quota exceeded.');
}

async function extractWithClaude(imageUrl: string): Promise<string> {
  logger.info('Using Claude Vision for OCR...');

  const response = await fetch(imageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*,*/*' },
  });
  if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  let mimeType = contentType.split(';')[0].trim();
  const supportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!supportedTypes.includes(mimeType)) mimeType = 'image/jpeg';

  const arrayBuffer = await response.arrayBuffer();
  const base64Image = Buffer.from(arrayBuffer).toString('base64');

  logger.info(`Image downloaded: ${base64Image.length} base64 chars, type: ${mimeType}`);

  const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'output-128k-2025-02-19',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `Extract ALL text from this exam question paper image exactly as written.

Rules:
- Extract every single question with its number
- Extract ALL option labels exactly: (a), (b), (c), (d)
- Extract section headers: SECTION A, PART I, etc.
- Extract marks shown: [2] or (3 marks)
- Extract mathematical equations and symbols
- Keep the exact order and structure
- Do NOT summarize, skip or modify anything
- Do NOT add any explanation

Return ONLY the raw extracted text, nothing else.`,
            },
          ],
        },
      ],
    }),
  });

  if (!claudeResponse.ok) {
    const errText = await claudeResponse.text();
    throw new Error(`Claude OCR error ${claudeResponse.status}: ${errText}`);
  }

  const data = await claudeResponse.json() as {
    content: Array<{ type: string; text: string }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(`Claude error: ${data.error.message}`);

  const text = data.content?.[0]?.text || '';
  if (!text) throw new Error('Claude returned empty OCR response');

  logger.info(`Claude OCR extracted: ${text.length} chars`);
  return text;
}
async function structureWithClaude(
  rawText: string
): Promise<{ cleanedText: string; sections: Section[] }> {
  logger.info('Using Claude for AI structuring...');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'output-128k-2025-02-19',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 8000,
      system: 'You are an expert Indian exam question paper parser. Always respond with valid JSON only. No markdown. No explanation.',
      messages: [
        {
          role: 'user',
          content: buildStructurePrompt(rawText),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(data.error.message);

  const text = data.content?.[0]?.text || '';
  if (!text) throw new Error('Claude returned empty response');

  logger.info(`Claude response: ${text.length} chars`);
  return parseAiResponse(text, rawText);
}

// ─────────────────────────────────────────
// STRUCTURE TEXT WITH AI
// ─────────────────────────────────────────
async function structureText(
  rawText: string
): Promise<{ cleanedText: string; sections: Section[] }> {
  // How many questions does the paper itself number? An AI answer that has far fewer was cut short.
  const expected = countQuestionMarkers(cleanPaperText(rawText));
  const AI_MAX_QUESTIONS = 45; // the AI answers below are capped at 8000 tokens: about this many questions
  const count = (r: { sections: Section[] }) => r.sections.reduce((n, sec) => n + sec.questions.length, 0);
  const complete = (r: { sections: Section[] }) => expected < 10 || count(r) >= Math.floor(expected * 0.9);
  const tooLong = expected > AI_MAX_QUESTIONS;

  if (tooLong) {
    logger.info(`Long paper (${expected} numbered questions): using the rule-based parser, the AI answer would be cut short.`);
  }

  // Try Claude first (best quality)
  if (!tooLong && process.env.ANTHROPIC_API_KEY) {
    try {
      const result = await structureWithClaude(rawText);
      if (result.sections.length > 0 && complete(result)) {
        logger.info(`Claude structured: ${result.sections.length} sections`);
        return result;
      }
      if (result.sections.length > 0) logger.warn(`Claude found ${count(result)} of ${expected} questions: not using it.`);
    } catch (err) {
      logger.warn('Claude failed:', err);
    }
  }

  // Try Mistral fallback
  if (!tooLong && process.env.MISTRAL_API_KEY) {
    try {
      const result = await structureWithMistral(rawText);
      if (result.sections.length > 0 && complete(result)) {
        logger.info(`Mistral structured: ${result.sections.length} sections`);
        return result;
      }
      if (result.sections.length > 0) logger.warn(`Mistral found ${count(result)} of ${expected} questions: not using it.`);
    } catch (err) {
      logger.warn('Mistral failed:', err);
    }
  }

  // Rule-based fallback
  logger.info('Using rule-based parser...');
  return ruleBasedParse(rawText);
}
// ─────────────────────────────────────────
// GROQ STRUCTURING
// ─────────────────────────────────────────

async function structureWithGroq(
  rawText: string
): Promise<{ cleanedText: string; sections: Section[] }> {
  logger.info('Using Groq for AI structuring...');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      messages: [
        {
          role: 'system',
          content: 'You are an expert exam question paper parser. Always respond with valid JSON only. No markdown. No explanation.',
        },
        {
          role: 'user',
          content: buildStructurePrompt(rawText),
        },
      ],
      max_tokens: 8000,
      temperature: 0.1,
    }),
  });

  if (!response.ok) throw new Error(`Groq error: ${response.status}`);

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(data.error.message);

  const text = data.choices?.[0]?.message?.content || '';
  return parseAiResponse(text, rawText);
}

// ─────────────────────────────────────────
// GEMINI TEXT STRUCTURING
// ─────────────────────────────────────────

async function structureWithGeminiText(
  rawText: string
): Promise<{ cleanedText: string; sections: Section[] }> {
  const models = ['gemini-1.5-flash-latest', 'gemini-1.5-flash'];

  for (const model of models) {
    try {
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: buildStructurePrompt(rawText) }] }],
            generationConfig: { maxOutputTokens: 8000, temperature: 0.1 },
          }),
        }
      );

      if (!geminiResponse.ok) continue;

      const data = await geminiResponse.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
        error?: { message: string };
      };

      if (data.error) continue;

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) return parseAiResponse(text, rawText);
    } catch {
      continue;
    }
  }

  throw new Error('All Gemini models failed');
}

// ─────────────────────────────────────────
// MISTRAL STRUCTURING
// ─────────────────────────────────────────

async function structureWithMistral(
  rawText: string
): Promise<{ cleanedText: string; sections: Section[] }> {
  logger.info('Using Mistral for structuring...');

  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'mistral-small-latest',
      messages: [
        {
          role: 'system',
          content: 'You are an expert exam question paper parser. Always respond with valid JSON only.',
        },
        {
          role: 'user',
          content: buildStructurePrompt(rawText),
        },
      ],
      max_tokens: 8000,
      temperature: 0.1,
    }),
  });

  if (!response.ok) throw new Error(`Mistral error: ${response.status}`);

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const text = data.choices?.[0]?.message?.content || '';
  return parseAiResponse(text, rawText);
}

// ─────────────────────────────────────────
// STRUCTURE PROMPT
// ─────────────────────────────────────────

function buildStructurePrompt(rawText: string): string {
  return `You are an expert Indian exam question paper parser.

Parse the text below into structured JSON.

EXTRACTED TEXT:
---
${rawText.substring(0,30000)}
---

CRITICAL RULES FOR MCQ OPTIONS:
- Options may appear ALL ON ONE LINE: (a) Velocity (b) Speed (c) Force (d) Displacement
- Options may appear on SEPARATE LINES:
  a) Velocity
  b) Speed
- ALWAYS split into 4 SEPARATE option objects
- NEVER put all options into one option object
- Question TEXT must NOT include options text
- Remove options from question text field

EXAMPLE INPUT:
1. Which is NOT a vector? (a) Velocity (b) Speed (c) Force (d) Displacement [1]

CORRECT OUTPUT:
{
  "text": "Which is NOT a vector?",
  "options": [
    {"label":"a","text":"Velocity","isCorrect":false},
    {"label":"b","text":"Speed","isCorrect":false},
    {"label":"c","text":"Force","isCorrect":false},
    {"label":"d","text":"Displacement","isCorrect":false}
  ]
}

RESPOND WITH ONLY THIS JSON (no markdown):
{
  "cleanedText": "full text",
  "sections": [
    {
      "id": "sec_1",
      "title": "Section A",
      "description": "Choose the correct answer",
      "questionType": "MCQ",
      "marksPerQuestion": 1,
      "totalMarks": 10,
      "questions": [
        {
          "id": "q_1",
          "number": 1,
          "type": "MCQ",
          "text": "Question text only - NO options here",
          "marks": 1,
          "options": [
            {"label":"a","text":"First option only","isCorrect":false},
            {"label":"b","text":"Second option only","isCorrect":false},
            {"label":"c","text":"Third option only","isCorrect":false},
            {"label":"d","text":"Fourth option only","isCorrect":false}
          ],
          "difficulty": "EASY",
          "bloomLevel": "REMEMBER"
        }
      ]
    }
  ]
}`;
}

// ─────────────────────────────────────────
// SPLIT INLINE OPTIONS
// ─────────────────────────────────────────

function splitInlineOptions(text: string): {
  questionText: string;
  options: Array<{ label: string; text: string; isCorrect: boolean }>;
} {
  const options: Array<{ label: string; text: string; isCorrect: boolean }> = [];

  // Pattern 1: (a) text (b) text
  const pattern1 = /\(([abcdABCD])\)\s*(.*?)(?=\s*\([abcdABCD]\)\s|\s*$)/gi;
  // Pattern 2: a) text b) text
  const pattern2 = /\b([abcdABCD])\)\s*(.*?)(?=\s+[abcdABCD]\)\s|\s*$)/g;
  // Pattern 3: A. text B. text
  const pattern3 = /\b([ABCD])\.\s*(.*?)(?=\s+[ABCD]\.\s|\s*$)/g;

  let matches: RegExpMatchArray[] = [];
  let usedPattern = 0;

  matches = [...text.matchAll(pattern1)];
  if (matches.length >= 2) usedPattern = 1;

  if (matches.length < 2) {
    matches = [...text.matchAll(pattern2)];
    if (matches.length >= 2) usedPattern = 2;
  }

  if (matches.length < 2) {
    matches = [...text.matchAll(pattern3)];
    if (matches.length >= 2) usedPattern = 3;
  }

  if (matches.length < 2) return { questionText: text, options: [] };

  matches.forEach((m) => {
    const label = m[1].toLowerCase();
    const optText = m[2].trim()
      .replace(/\s*\([abcdABCD]\)\s*$/, '')
      .replace(/\s+[abcdABCD]\)\s*$/, '')
      .trim();
    if (!options.find((o) => o.label === label)) {
      options.push({ label, text: optText, isCorrect: false });
    }
  });

  let questionText = text;
  if (usedPattern === 1) {
    const idx = text.search(/\s*\([abcdABCD]\)/i);
    if (idx > 0) questionText = text.substring(0, idx).trim();
  } else if (usedPattern === 2) {
    const idx = text.search(/\s+[abcdABCD]\)/);
    if (idx > 0) questionText = text.substring(0, idx).trim();
  } else if (usedPattern === 3) {
    const idx = text.search(/\s+[ABCD]\./);
    if (idx > 0) questionText = text.substring(0, idx).trim();
  }

  questionText = outsideMath(questionText, t => t.replace(/[\[(]\d+\s*(?:marks?)?[\])]/gi, '')).trim();
  return { questionText, options };
}

// ─────────────────────────────────────────
// PARSE AI RESPONSE
// ─────────────────────────────────────────

function parseAiResponse(
  responseText: string,
  fallbackText: string,
  strict = false // strict: throw on bad JSON instead of using the rule-based parser
): { cleanedText: string; sections: Section[] } {
  try {
    let jsonStr = responseText
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/g, '')
      .trim();

    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    }

    const parsed = JSON.parse(jsonStr);
    if (!parsed.sections || !Array.isArray(parsed.sections)) {
      throw new Error('No sections in response');
    }

 let sections: Section[] = parsed.sections.map(
  (s: Record<string, unknown>, si: number) => ({
    id: (s.id as string) || `sec_${si + 1}`,
    title: (s.title as string) || `Section ${si + 1}`,
    description: s.description as string | undefined,
    questionType: s.questionType as string | undefined,
    marksPerQuestion: s.marksPerQuestion as number | undefined,
    totalMarks: (s.totalMarks as number) || 0,
    questions: ((s.questions as Record<string, unknown>[]) || []).map((q, qi) =>
      normalizeQuestion(q, qi, (s.title as string) || '')
    ),
  })
);

sections = renumberQuestionsPerSection(sections);

    sections.forEach((sec) => {
      sec.totalMarks = sec.questions.reduce((sum, q) => sum + q.marks, 0);
    });

    return {
      cleanedText: (parsed.cleanedText as string) || fallbackText,
      sections,
    };
  } catch (err) {
    if (strict) throw err;
    logger.warn('Failed to parse AI JSON response, using rule-based parser:', err);
    return ruleBasedParse(fallbackText);
  }
}

// ─────────────────────────────────────────
// NORMALIZE QUESTION
// ─────────────────────────────────────────

/** Runs a text clean-up only on the parts outside $...$ equations, so formulas such as $f(2)$ are left alone. */
function outsideMath(text: string, fn: (s: string) => string): string {
  if (text.indexOf('$') === -1) return fn(text);
  return splitMath(text)
    .map(p =>
      p.kind === 'text' ? fn(p.text).replace(/\$/g, '\\$') : p.display ? `$$${p.latex}$$` : `$${p.latex}$`
    )
    .join('');
}

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max);

/** Tables from the extraction, trimmed to the limits (3 per question, 20 rows, 8 columns, 300 characters). */
function sanitizeTables(v: unknown): QuestionTable[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: QuestionTable[] = [];
  for (const t of v.slice(0, TABLE_LIMITS.perQuestion)) {
    const rowsIn = Array.isArray((t as { rows?: unknown })?.rows) ? ((t as { rows: unknown[] }).rows) : [];
    const rows = rowsIn
      .filter(Array.isArray)
      .slice(0, TABLE_LIMITS.maxRows)
      .map(r => (r as unknown[]).slice(0, TABLE_LIMITS.maxCols).map(c => clip(c, TABLE_LIMITS.maxCellChars)));
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (!rows.length || !cols) continue;
    out.push({
      id: `t_${uuidv4().slice(0, 8)}`,
      rows: rows.map(r => (r.length < cols ? r.concat(Array(cols - r.length).fill('')) : r)),
      headerRow: (t as { headerRow?: unknown }).headerRow === false ? false : true,
    });
  }
  return out.length ? out : undefined;
}

/** Match-the-following columns from the extraction, without printed numbers or letters, within the limits. */
function sanitizeMatch(v: unknown): QuestionMatch | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  const items = (a: unknown, strip: RegExp) =>
    (Array.isArray(a) ? a : [])
      .slice(0, MATCH_LIMITS.maxItems)
      .map(x => clip(x, MATCH_LIMITS.maxChars).trim().replace(strip, ''));
  const left = items(m.left, /^\(?\d{1,2}[.)]\s*/);
  const right = items(m.right, /^\(?[a-jA-J][.)]\s*/);
  if (left.filter(Boolean).length < 2 || right.filter(Boolean).length < 2) return undefined;
  return {
    ...(typeof m.leftTitle === 'string' ? { leftTitle: m.leftTitle.slice(0, 60) } : {}),
    ...(typeof m.rightTitle === 'string' ? { rightTitle: m.rightTitle.slice(0, 60) } : {}),
    left,
    right,
  };
}

/** Figure boxes (fractions of the page), clamped to the page; at most 5 per question. */
function sanitizeFigures(v: unknown): FigureBox[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: FigureBox[] = [];
  for (const f of v.slice(0, 5)) {
    const o = (f || {}) as Record<string, unknown>;
    let b = Array.isArray(o.box) ? o.box.map(Number) : [Number(o.x), Number(o.y), Number(o.w), Number(o.h)];
    if (b.length < 4 || b.slice(0, 4).some(n => !isFinite(n))) continue;
    if (Math.max(...b.slice(0, 4)) > 1.5) b = b.map(n => n / 100); // given as percentages
    const x = Math.min(1, Math.max(0, b[0]));
    const y = Math.min(1, Math.max(0, b[1]));
    const w = Math.min(b[2], 1 - x);
    const h = Math.min(b[3], 1 - y);
    if (w < 0.03 || h < 0.03) continue;
    out.push({
      page: Math.max(1, Math.min(500, Math.round(Number(o.page)) || 1)),
      x, y, w, h,
      ...(typeof o.caption === 'string' && o.caption.trim() ? { caption: o.caption.trim().slice(0, 200) } : {}),
    });
  }
  return out.length ? out : undefined;
}

function normalizeQuestion(q: Record<string, unknown>, index: number, sectionTitle = ''): Question {
  let questionText = (q.text as string) || '';
  let options =
    (q.options as Array<{ label: string; text: string; isCorrect: boolean }>) || [];

  questionText = questionText.replace(/[\[(]\d+\s*(?:marks?)?[\])]/gi, '').trim();

  // Fix: all options crammed into first option
  if (options.length === 1 && options[0].text) {
    const split = splitInlineOptions(options[0].text);
    if (split.options.length >= 2) options = split.options;
  }

  // Fix: no options but inline options in question text
  if (options.length === 0 && questionText) {
    const split = splitInlineOptions(questionText);
    if (split.options.length >= 2) {
      questionText = split.questionText;
      options = split.options;
    }
  }

  // Clean each option text
  options = options
    .map((opt) => ({
      ...opt,
      text: outsideMath(opt.text, t =>
        t
          .replace(/\s*\([abcdABCD]\)\s*.*$/i, '')
          .replace(/\s+[abcdABCD]\)\s*.*$/i, '')
          .replace(/[\[(]\d+\s*(?:marks?)?[\])]/gi, '')
      ).trim(),
    }))
    .filter((opt) => opt.text.length > 0);

  // A question with a blank (____), or under a "Fill in the blanks" heading, is a fill-in-the-blank
  // question, whatever type was guessed for it (a sum like "657 + ___ = 563 + 657" is not a calculation).
  const guessed = (q.type as string) || detectQuestionType(questionText, sectionTitle);
  const keepsOwnType = ['TRUE_FALSE', 'MATCH_FOLLOWING', 'DIAGRAM'].includes(guessed);
  const isBlankQuestion = !keepsOwnType && (/_{3,}/.test(questionText) || BLANKS_HEADING.test(sectionTitle));
  const tables = sanitizeTables(q.tables);
  const match = sanitizeMatch(q.match);
  const figureBoxes = sanitizeFigures(q.figures ?? q.figureBoxes);
  const type = options.length >= 2 ? 'MCQ' : match ? 'MATCH_FOLLOWING' : isBlankQuestion ? 'FILL_IN_BLANK' : guessed;
  // printed number and printed answer: only used to match an answer key, and removed again afterwards
  const printedNo = Math.floor(Number(q.no));
  const sourceNo = Number.isFinite(printedNo) && printedNo > 0 && printedNo < 10000 ? printedNo : undefined;
  const printedAnswer = typeof q.answer === 'string' || typeof q.answer === 'number' ? String(q.answer).trim().slice(0, 40) : '';

  return {
    id: (q.id as string) || uuidv4(),
   number: index + 1,
    type: type as Question['type'],
    text: questionText,
    marks: (q.marks as number) || 1,
    options: options.length > 0 ? options : undefined,
    difficulty: (q.difficulty as Question['difficulty']) || 'MEDIUM',
    bloomLevel: (q.bloomLevel as Question['bloomLevel']) || 'REMEMBER',
    topic: q.topic as string | undefined,
    ...(tables ? { tables } : {}),
    ...(match ? { match } : {}),
    ...(figureBoxes ? { figureBoxes } : {}),
    ...(sourceNo ? { sourceNo } : {}),
    ...(printedAnswer ? { answer: printedAnswer } : {}),
  };
}
function renumberQuestionsPerSection(sections: Section[]): Section[] {
  return sections.map((section) => ({
    ...section,
    questions: section.questions.map((question, index) => ({
      ...question,
      number: index + 1,
    })),
  }));
}
// ─────────────────────────────────────────
// RULE-BASED FALLBACK PARSER
// ─────────────────────────────────────────

const QUESTION_START = /^(?:Q\.?\s*)?\d{1,3}[.)]\s+\S/i;
// "12. text", "12." alone on its line, or "12." glued to a vector arrow ("12.⃗ A and ...")
const DOT_QUESTION_START = /^\d{1,3}\.(?:\s+\S|[\u0300-\u036f\u20d0-\u20ff]|$)/;

/**
 * Removes what is not part of any question: page numbers ("Page 3", also glued to the next page's header),
 * a header that repeats on many pages, and the answer key at the end of the paper.
 */
function cleanPaperText(text: string): string {
  let lines = text
    .replace(/\r/g, '')
    .split('\n')
    .map(l =>
      l
        .replace(/\t+/g, ' ')
        .replace(/\s*([\u20d0-\u20ff])\s*([A-Za-z])/g, ' $2$1') // PDF readers put a vector arrow before its letter: "⃗ V" -> "V⃗"
        .trim()
    )
    .filter(l => l && !/^[\u0300-\u036f\u20d0-\u20ff\s]+$/.test(l)); // a lone arrow from a figure label

  lines = lines
    .filter(l => !/^--\s*\d+\s+of\s+\d+\s*--$/.test(l)) // "-- 4 of 17 --" page markers some PDF readers insert
    .map(l => l.replace(/^Page\s*\d+\s*/i, '').replace(/\s*Page\s*\d+$/i, '').trim())
    .filter(Boolean);

  // a header or footer line repeated on at least 3 pages (long enough not to be a maths fragment)
  const freq = new Map<string, number>();
  for (const l of lines) freq.set(l.toLowerCase(), (freq.get(l.toLowerCase()) || 0) + 1);
  lines = lines.filter(l => !(l.length >= 12 && (freq.get(l.toLowerCase()) || 0) >= 3 && !QUESTION_START.test(l)));

  // the answer key after the last question
  const firstQ = lines.findIndex(l => QUESTION_START.test(l));
  if (firstQ >= 0) {
    const keyAt = lines.findIndex((l, i) => i > firstQ && /^(?:KEY\s*SHEET|ANSWER\s*KEY|ANSWERS?|KEY)\s*:?$/i.test(l));
    if (keyAt > 0) lines = lines.slice(0, keyAt);
  }
  return lines.join('\n');
}

/** How many questions the paper numbers (1., 2., ... or Q1 ...). Used to notice an AI answer that stopped early. */
function countQuestionMarkers(cleaned: string): number {
  const dot = new Set<number>();
  const paren = new Set<number>();
  const q = new Set<number>();
  for (const l of cleaned.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^(\d{1,3})\.(?:\s+\S|[\u0300-\u036f\u20d0-\u20ff]|$)/))) dot.add(+m[1]);
    else if ((m = l.match(/^(\d{1,3})\)\s+\S/))) paren.add(+m[1]);
    if ((m = l.match(/^Q\.?\s*(\d{1,3})\b/i))) q.add(+m[1]);
  }
  // "1) 2) 3) 4)" in a paper that numbers questions "1." are options: only count them when there are many
  return Math.max(dot.size, paren.size > 20 ? paren.size : 0, q.size);
}

/**
 * Splits "1) symmetric 2) reflexive 3) transitive 4) an equivalence" into its options. A marker counts only
 * when it is the next number in order, stands alone after a space, and is outside any brackets, so
 * "{(1, 4)} 2) {(2, 4)}" is read as two options, not five.
 */
function splitNumberedOptions(text: string, firstExpected = 1): Array<{ n: number; text: string; start: number }> {
  const marks: Array<{ n: number; start: number; end: number }> = [];
  let expected = firstExpected;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const m = text.slice(i).match(/^\(?(\d)\)(?=\s|$|[\u0300-\u036f\u20d0-\u20ff])/);
    if (m && (i === 0 || /\s/.test(text[i - 1])) && depth === 0 && Number(m[1]) === expected) {
      marks.push({ n: expected, start: i, end: i + m[0].length });
      expected++;
      i += m[0].length - 1;
      continue;
    }
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
  }
  return marks.map((mk, idx) => ({
    n: mk.n,
    start: mk.start,
    text: text.slice(mk.end, idx + 1 < marks.length ? marks[idx + 1].start : text.length).trim(),
  }));
}

type InlineSplit = ReturnType<typeof splitInlineOptions>;

function ruleBasedParse(rawText: string): { cleanedText: string; sections: Section[] } {
  const text = cleanPaperText(rawText);
  const lines = text.split('\n');
  const sections: Section[] = [];
  let currentSection: Section | null = null;
  let currentQuestion: Question | null = null;
  let questionCounter = 0;
  let lastNumber = 0;

  // Questions numbered "1." AND options numbered "1) 2) 3) 4)" (EAMCET and most entrance papers): the "1)" lines
  // are OPTIONS, not questions. Other papers keep the original behaviour.
  const dotStyle =
    lines.filter(l => DOT_QUESTION_START.test(l)).length >= 3 &&
    lines.filter(l => /^\(?[1-4]\)\s+\S/.test(l)).length >= 3;

  const sectionPatterns = [
    /^SECTION[- ][A-Z]/i,
    /^PART[- ][A-Z0-9]/i,
    /^Section [A-Z]/i,
    /^Part [A-Z0-9]/i,
  ];

  // A short ALL-CAPS line right before a question is a heading ("PHYSICS", "MATHEMATICS – A")
  const isHeading = (i: number) =>
    /^[A-Z][A-Z .&,'’\-–]{2,60}$/.test(lines[i]) &&
    (lines[i].match(/[A-Z]/g) || []).length >= 4 &&
    QUESTION_START.test(lines[i + 1] || '');

  const questionPatterns = dotStyle
    ? [/^(\d+)\.(?:\s+|(?=[\u0300-\u036f\u20d0-\u20ff])|$)(.*)$/, /^Q\.?\s*(\d+)[.):]?\s*(.+)/i]
    : [
        /^(\d+)[.)]\s+(.+)/,
        /^Q\.?\s*(\d+)[.):]?\s*(.+)/i,
        /^\((\d+)\)\s*(.+)/,
      ];

  const allOptionPatterns = [
    /^\(([abcdABCD])\)\s*(.+)/,
    /^([abcdABCD])[.)]\s*(.+)/,
    /^([abcdABCD])\s*[-]\s*(.+)/,
  ];
  const optionPatterns = dotStyle ? allOptionPatterns.slice(0, 2) : allOptionPatterns;

  const marksPattern = /[\[(](\d+)\s*(?:marks?)?[\])]/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (sectionPatterns.some((p) => p.test(line)) || isHeading(i)) {
      if (currentQuestion && currentSection) {
        currentSection.questions.push(currentQuestion);
        currentSection.totalMarks += currentQuestion.marks;
        currentQuestion = null;
      }
      if (currentSection && currentSection.questions.length > 0) sections.push(currentSection);
      currentSection = { id: uuidv4(), title: line, totalMarks: 0, questions: [] };
      continue;
    }

    // "1) ... 2) ... 3) ... 4) ..." after a "1." question: options, on one line or one per line. The next
    // option can also start in the middle of a line (a wrapped formula: ", n ∈ Z 2) 2nπ − ...").
    if (dotStyle && currentQuestion && !DOT_QUESTION_START.test(line)) {
      const expected = (currentQuestion.options?.length ?? 0) + 1;
      const opts = splitNumberedOptions(line, expected);
      if (opts.length > 0) {
        if (!currentQuestion.options) currentQuestion.options = [];
        const before = line.slice(0, opts[0].start).trim();
        if (before) {
          const own = currentQuestion.options;
          if (own.length) own[own.length - 1].text = `${own[own.length - 1].text} ${before}`.trim();
          else currentQuestion.text = `${currentQuestion.text} ${before}`.trim();
        }
        opts.forEach((o) => {
          currentQuestion!.options!.push({ label: String.fromCharCode(96 + o.n), text: o.text, isCorrect: false });
        });
        currentQuestion.type = 'MCQ';
        continue;
      }
    }

    let isOption = false;
    for (const pattern of optionPatterns) {
      const match = line.match(pattern);
      if (match && currentQuestion) {
        const label = match[1].toLowerCase();
        const optText = match[2].trim();
        if (!currentQuestion.options) currentQuestion.options = [];
        if (!currentQuestion.options.find((o) => o.label === label)) {
          currentQuestion.options.push({ label, text: optText, isCorrect: false });
          currentQuestion.type = 'MCQ';
        }
        isOption = true;
        break;
      }
    }
    if (isOption) continue;

    let isQuestion = false;
    for (const pattern of questionPatterns) {
      const match = line.match(pattern);
      if (match) {
        const num = parseInt(match[1], 10);
        // numbered "1." papers: only the next number starts a question, anything else is part of the text
        if (dotStyle && !(num === 1 || (num > lastNumber && num <= lastNumber + 3))) continue;

        if (currentQuestion && currentSection) {
          currentSection.questions.push(currentQuestion);
          currentSection.totalMarks += currentQuestion.marks;
        }

        const rawQText = (dotStyle ? match[2] ?? '' : match[2] || match[1] || '').trim();
        const marksMatch = dotStyle ? null : rawQText.match(marksPattern);
        const marks = marksMatch ? parseInt(marksMatch[1]) : 1;

        // (a)(b)(c)(d) on one line is only looked for in other papers: in formulas like "(a, b)R(c, d)" it misfires
        let split: InlineSplit = dotStyle ? { questionText: rawQText, options: [] } : splitInlineOptions(rawQText);
        if (dotStyle && split.options.length < 2) {
          const nums = splitNumberedOptions(rawQText, 1);
          if (nums.length >= 2 && nums[0].start > 0) {
            split = {
              questionText: rawQText.slice(0, nums[0].start).trim(),
              options: nums.map((o) => ({ label: String.fromCharCode(96 + o.n), text: o.text, isCorrect: false })),
            };
          }
        }
        const cleanText = split.options.length >= 2
          ? split.questionText
          : dotStyle
            ? rawQText // a paper with no printed marks: a "(1)" in a formula is not a mark
            : rawQText.replace(marksPattern, '').trim();

        if (!currentSection) {
          currentSection = { id: uuidv4(), title: 'Section A', totalMarks: 0, questions: [] };
        }

        questionCounter++;
        lastNumber = num;
        currentQuestion = {
          id: uuidv4(),
          number: questionCounter,
          type: (split.options.length >= 2
            ? 'MCQ'
            : detectQuestionType(cleanText, currentSection?.title || '')) as Question['type'],
          text: cleanText,
          marks,
          options: split.options.length >= 2 ? split.options : [],
        };
        isQuestion = true;
        break;
      }
    }
    if (isQuestion) continue;

    if (currentQuestion) {
      // (a) (b) (c) (d) written on one line
      const split: InlineSplit = dotStyle ? { questionText: line, options: [] } : splitInlineOptions(line);
      if (split.options.length >= 2) {
        if (!currentQuestion.options) currentQuestion.options = [];
        split.options.forEach((opt) => {
          if (!currentQuestion!.options!.find((o) => o.label === opt.label)) {
            currentQuestion!.options!.push(opt);
            currentQuestion!.type = 'MCQ';
          }
        });
      } else if (dotStyle) {
        // the next line of the same question or option (long questions and formulas wrap)
        const opts = currentQuestion.options || [];
        if (opts.length) opts[opts.length - 1].text = `${opts[opts.length - 1].text} ${line}`.trim();
        else currentQuestion.text = `${currentQuestion.text} ${line}`.trim();
      }
    }
  }

  if (currentQuestion && currentSection) {
    currentSection.questions.push(currentQuestion);
    currentSection.totalMarks += currentQuestion.marks;
  }
  if (currentSection && currentSection.questions.length > 0) sections.push(currentSection);

  sections.forEach((sec) => {
    sec.questions.forEach((q) => {
      if (q.options && q.options.length === 0) delete q.options;
    });
  });

  if (sections.length === 0) {
    sections.push({
      id: uuidv4(),
      title: 'Section A',
      totalMarks: 1,
      questions: [{
        id: uuidv4(),
        number: 1,
        type: 'SHORT_ANSWER',
        text: text.substring(0, 300) || 'Could not extract questions. Please check image quality.',
        marks: 1,
      }],
    });
  }
  const renumberedSections = renumberQuestionsPerSection(sections);
  return { cleanedText: text, sections: renumberedSections };
}

// ─────────────────────────────────────────
// DETECT QUESTION TYPE
// ─────────────────────────────────────────

const BLANKS_HEADING = /fill\s+(in\s+)?the\s+blanks?/i;

function detectQuestionType(text: string, sectionTitle = ''): string {
  const lower = text.toLowerCase();
  if (lower.includes('(a)') || lower.includes('choose') || lower.includes('which of the following') || lower.includes('select the correct')) return 'MCQ';
  if (lower.includes('fill in') || /_{3,}/.test(text) || lower.includes('blank') || BLANKS_HEADING.test(sectionTitle)) return 'FILL_IN_BLANK';
  if (lower.includes('true or false') || lower.includes('true/false') || lower.includes('state whether')) return 'TRUE_FALSE';
  if (lower.includes('match') || lower.includes('column a') || lower.includes('column b')) return 'MATCH_FOLLOWING';
  if (lower.includes('draw') || lower.includes('diagram') || lower.includes('sketch') || lower.includes('label')) return 'DIAGRAM';
  if (lower.includes('calculate') || lower.includes('find the value') || lower.includes('compute') || lower.includes('solve')) return 'NUMERICAL';
  if (text.length > 150) return 'LONG_ANSWER';
  return 'SHORT_ANSWER';
}