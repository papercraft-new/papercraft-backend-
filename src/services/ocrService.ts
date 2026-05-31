import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import type { Section, Question } from '../types';

// ─────────────────────────────────────────
// MAIN OCR PIPELINE
// ─────────────────────────────────────────

export async function processOcrJob(
  inputType: 'image' | 'pdf' | 'text',
  content: string
): Promise<{
  rawText: string;
  cleanedText: string;
  sections: Section[];
  questionsFound: number;
  sectionsFound: number;
  processingMs: number;
  confidence: number;
  warnings: string[];
}> {
  const startTime = Date.now();
  const warnings: string[] = [];

  logger.info(`OCR Job: Starting ${inputType} processing`);

  let rawText = '';

  if (inputType === 'text') {
    rawText = content;
  } else if (inputType === 'image') {
    rawText = await extractTextFromImage(content);
  } else if (inputType === 'pdf') {
    rawText = await extractTextFromImage(content);
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
      model: 'claude-opus-4-7',
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
      model: 'claude-opus-4-7',
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

  // Try Claude first (best quality)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const result = await structureWithClaude(rawText);
      if (result.sections.length > 0) {
        logger.info(`Claude structured: ${result.sections.length} sections`);
        return result;
      }
    } catch (err) {
      logger.warn('Claude failed:', err);
    }
  }

  // Try Mistral fallback
  if (process.env.MISTRAL_API_KEY) {
    try {
      const result = await structureWithMistral(rawText);
      if (result.sections.length > 0) {
        logger.info(`Mistral structured: ${result.sections.length} sections`);
        return result;
      }
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
      max_tokens: 4000,
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
      max_tokens: 4000,
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
${rawText.substring(0, 6000)}
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

  questionText = questionText.replace(/[\[(]\d+\s*(?:marks?)?[\])]/gi, '').trim();
  return { questionText, options };
}

// ─────────────────────────────────────────
// PARSE AI RESPONSE
// ─────────────────────────────────────────

function parseAiResponse(
  responseText: string,
  fallbackText: string
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
      normalizeQuestion(q, qi)
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
    logger.warn('Failed to parse AI JSON response, using rule-based parser:', err);
    return ruleBasedParse(fallbackText);
  }
}

// ─────────────────────────────────────────
// NORMALIZE QUESTION
// ─────────────────────────────────────────

function normalizeQuestion(q: Record<string, unknown>, index: number): Question {
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
      text: opt.text
        .replace(/\s*\([abcdABCD]\)\s*.*$/i, '')
        .replace(/\s+[abcdABCD]\)\s*.*$/i, '')
        .replace(/[\[(]\d+\s*(?:marks?)?[\])]/gi, '')
        .trim(),
    }))
    .filter((opt) => opt.text.length > 0);

  const type =
    options.length >= 2
      ? 'MCQ'
      : (q.type as string) || detectQuestionType(questionText);

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

function ruleBasedParse(text: string): { cleanedText: string; sections: Section[] } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const sections: Section[] = [];
  let currentSection: Section | null = null;
  let currentQuestion: Question | null = null;
  let questionCounter = 0;

  const sectionPatterns = [
    /^SECTION[- ][A-Z]/i,
    /^PART[- ][A-Z0-9]/i,
    /^Section [A-Z]/i,
    /^Part [A-Z0-9]/i,
  ];

  const questionPatterns = [
    /^(\d+)[.)]\s+(.+)/,
    /^Q\.?\s*(\d+)[.):]?\s*(.+)/i,
    /^\((\d+)\)\s*(.+)/,
  ];

  const optionPatterns = [
    /^\(([abcdABCD])\)\s*(.+)/,
    /^([abcdABCD])[.)]\s*(.+)/,
    /^([abcdABCD])\s*[-]\s*(.+)/,
  ];

  const marksPattern = /[\[(](\d+)\s*(?:marks?)?[\])]/i;

  for (const line of lines) {
    if (sectionPatterns.some((p) => p.test(line))) {
      if (currentQuestion && currentSection) {
        currentSection.questions.push(currentQuestion);
        currentSection.totalMarks += currentQuestion.marks;
        currentQuestion = null;
      }
      if (currentSection && currentSection.questions.length > 0) sections.push(currentSection);
      currentSection = { id: uuidv4(), title: line, totalMarks: 0, questions: [] };
      continue;
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
        if (currentQuestion && currentSection) {
          currentSection.questions.push(currentQuestion);
          currentSection.totalMarks += currentQuestion.marks;
        }

        const rawQText = (match[2] || match[1] || '').trim();
        const marksMatch = rawQText.match(marksPattern);
        const marks = marksMatch ? parseInt(marksMatch[1]) : 1;

        const split = splitInlineOptions(rawQText);
        const cleanText = split.options.length >= 2
          ? split.questionText
          : rawQText.replace(marksPattern, '').trim();

        if (!currentSection) {
          currentSection = { id: uuidv4(), title: 'Section A', totalMarks: 0, questions: [] };
        }

        questionCounter++;
        currentQuestion = {
          id: uuidv4(),
          number: questionCounter,
          type: (split.options.length >= 2
            ? 'MCQ'
            : detectQuestionType(cleanText)) as Question['type'],
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
      const split = splitInlineOptions(line);
      if (split.options.length >= 2) {
        if (!currentQuestion.options) currentQuestion.options = [];
        split.options.forEach((opt) => {
          if (!currentQuestion!.options!.find((o) => o.label === opt.label)) {
            currentQuestion!.options!.push(opt);
            currentQuestion!.type = 'MCQ';
          }
        });
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

function detectQuestionType(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('(a)') || lower.includes('choose') || lower.includes('which of the following') || lower.includes('select the correct')) return 'MCQ';
  if (lower.includes('fill in') || lower.includes('______') || lower.includes('blank')) return 'FILL_IN_BLANK';
  if (lower.includes('true or false') || lower.includes('true/false') || lower.includes('state whether')) return 'TRUE_FALSE';
  if (lower.includes('match') || lower.includes('column a') || lower.includes('column b')) return 'MATCH_FOLLOWING';
  if (lower.includes('draw') || lower.includes('diagram') || lower.includes('sketch') || lower.includes('label')) return 'DIAGRAM';
  if (lower.includes('calculate') || lower.includes('find the value') || lower.includes('compute') || lower.includes('solve')) return 'NUMERICAL';
  if (text.length > 150) return 'LONG_ANSWER';
  return 'SHORT_ANSWER';
}